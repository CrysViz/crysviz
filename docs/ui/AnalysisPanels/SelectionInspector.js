// Selection Inspector: the selected atoms in their own small 3D view, with
// the bonds among them (Bonds-tab lengths), each bond's length and every angle
// between two of those bonds that meet at an atom
// (render/SelectionAnalysisModule.js). Opened from the Structure window's
// selection bar (Inspect) or the search; follows the atom selection live —
// Shift-click adds an atom in the main view, Ctrl/⌘-click removes one.
//
// The neighbours tool (the add-neighbour button at the top) shows the atoms
// bonded to the selection faintly while it is on; clicking one adds it, and
// ending the tool (the button again, or Esc) clears the rest. Its explanation
// lives behind the ⓘ beside it (data/selectionNeighboursInfo.md). Labels are
// hidden one by one with their × and come back with "Show all labels"
// (inspectorLabels.js, shared with the Polyhedron Inspector).
//
// Compare: the inspector's own switch (independent of the Comparison panel).
// With one other structure ticked in the Files list it is available, and on,
// each length and angle also shows its value in that structure (at the step
// that row shows), in the compared colour, when the two are the same
// structure closely enough
// (render/StructureMatchModule.js). A status line says which structure and
// how close; the legend in the view's corner is a label of its own — the two
// names, editable, in the two value colours (the Colours row sets them).
//
// "Export image…" saves the view through the main image dialog
// (ui/ImageExportPanel.js openImageExportDialog): the same sizes, margin,
// transparency and PNG/SVG, with the legend drawn over it as on screen.
//
// The view frames itself only for a new set of atoms. Adding, removing or
// showing neighbours never moves it — the user's orbit/zoom is theirs;
// double-click re-centres on request.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { createPolyhedronMiniRenderer } from './PolyhedronMiniRenderer.js';
import { createLabelState, labelToolbarHtml, wireLabelToolbar } from './inspectorLabels.js';
import { createInfoButton } from '../InfoPanel.js';
import {
  computeSelectionDetail, findSelectionNeighbours, compareSelectionDetail,
} from '../../render/SelectionAnalysisModule.js';
import { matchStructures } from '../../render/StructureMatchModule.js';
import { tickedStructureRows, rowContainer } from '../FileBrowswerPanel.js';
import {
  subscribeToAtomSelection, getSelectedAtoms,
  addAtomsToSelectionByInstances, updateAtomSelectionFrom3DHit,
} from '../SelectAndHighlightModule.js';
import { fileBrowser, groups, app, general } from '../../state/store.js';
import { onAtomsRebuilt } from '../../render/atomsRebuildHook.js';
import { openImageExportDialog } from '../ImageExportPanel.js';
import { makeDraggableWithin } from '../ColorBarDrag.js';
import { currentBaseName } from '../SavePanel.js';
import { colorToCss, viewFraction, cropToOutputRect } from '../../render/ImageExportModule.js';
import { modelErrors, formatWithSu } from '../../model/cifErrors.js';

const PANEL_ID = 'selectionInspector';

let view = null; // { update(opts), state() } while the window is open
/** The note under the view while "Link periodic copies" is on, or null. */
let linkWarnEl = null;

/**
 * Show the note while periodic copies are linked and the structure has copies
 * on screen: a selected atom then stands for all its copies, so a copy of one
 * cannot be added next to it (bonded neighbours across a cell face, say).
 */
function syncLinkWarn() {
  if (!linkWarnEl) return;
  const images = fileBrowser.selectedStructure?.atomImages ?? {};
  const hasCopies = Object.values(images).some((list) => list.length > 1);
  linkWarnEl.hidden = !(general.linkPeriodicCopies !== false && hasCopies);
}
let onToolKey = null; // the Add neighbours tool's Esc listener while open

function dropToolKey() {
  if (onToolKey) document.removeEventListener('keydown', onToolKey);
  onToolKey = null;
}

// Survive selection changes and closing/reopening the window.
const labels = createLabelState();
// The Add neighbours tool: while on, the selection's bonded neighbours are
// drawn faintly and a click adds one. A tool, not a setting — it starts off
// each time the window opens.
let neighbourTool = false;

// The legend of a comparison: the names shown for the two structures (null =
// the structure's own name); they reset when the compared pair changes. Its
// colours are the label colours (labels.colors valueA / valueB). `pos` is
// where it was dragged to (ui/ColorBarDrag.js WidgetAnchor: an offset from the
// view's nearest edge on each axis), null = its corner; kept across pairs.
const legend = { pair: '', names: [null, null], pos: null };

// matchStructures is O(n) for file-ordered structures but O(n²) otherwise:
// keep the last result while neither structure changed.
let matchCache = { A: null, B: null, sig: '', result: null };

function positionsSig(structure) {
  const atoms = structure.atoms;
  const f = (a) => (a?.position ?? []).map((v) => v.toFixed(6)).join(',');
  return `${atoms.length}|${f(atoms[0])}|${f(atoms[atoms.length >> 1])}|${f(atoms[atoms.length - 1])}`;
}

// Compare: the inspector's own switch, independent of the Comparison panel.
// It compares with the one other structure ticked in the Files list, at the
// step that row shows. Kept while the window is closed.
let compareOn = false;
// The ticked row's structure, built once per row and step (a trajectory frame
// may arrive asynchronously, from disk).
let targetCache = { container: null, step: -1, structure: null };

/** What Compare would compare with: the one other ticked Files row, or why not. */
function compareCandidate() {
  const ticked = tickedStructureRows().filter((r) => r.row !== fileBrowser.selectedRow);
  if (ticked.length === 0) return { row: null, why: 'Tick another structure in the Files list to compare with it.' };
  if (ticked.length > 1) return { row: null, why: `${ticked.length} structures are ticked in the Files list: tick only the one to compare with.` };
  return { row: ticked[0], why: '' };
}

const stepName = (name, step, steps) => (steps > 1 ? `${name} (step ${step + 1})` : name);

/** The ticked row's structure, or null while it is being read. */
function candidateStructure(cand, onArrive) {
  const container = rowContainer(cand.rowIndex);
  if (!container) return null;
  if (targetCache.container !== container || targetCache.step !== cand.step) {
    targetCache = { container, step: cand.step, structure: null };
    const ref = container.frameAtDetached(cand.step);
    if (ref && typeof /** @type {any} */ (ref).then === 'function') {
      const want = targetCache;
      /** @type {Promise<any>} */ (ref).then((s) => {
        if (targetCache !== want || !s) return;
        want.structure = s;
        onArrive();
      });
    } else {
      targetCache.structure = ref ?? null;
    }
  }
  return targetCache.structure;
}

/** The active comparison, or null when Compare is off or has nothing to compare with. */
function comparison(onArrive) {
  if (!compareOn) return null;
  const cand = compareCandidate().row;
  if (!cand) return null;
  const A = fileBrowser.selectedStructure, B = candidateStructure(cand, onArrive);
  if (!A?.atoms?.length || !B?.atoms?.length || A === B) return null;
  const sig = `${positionsSig(A)}#${positionsSig(B)}`;
  if (matchCache.A !== A || matchCache.B !== B || matchCache.sig !== sig) {
    matchCache = { A, B, sig, result: matchStructures(A, B) };
  }
  const rowA = fileBrowser.selectedRow;
  const nameRowA = rowA?.querySelector('.name-inner')?.textContent || 'Structure';
  const stepsA = rowContainer(fileBrowser.selectedRowIndex ?? -1)?.structures.length ?? 1;
  const nameA = stepName(nameRowA, fileBrowser.stepInput ?? 0, stepsA);
  const nameB = stepName(cand.name, cand.step, cand.steps);
  const pair = `${nameA}\u0000${nameB}`;
  if (legend.pair !== pair) Object.assign(legend, { pair, names: [null, null] });
  return { A, B, match: matchCache.result, nameA, nameB };
}

/** The CIF errors of the selection's lengths and angles (model/cifErrors.js),
 *  or null: none read, "Show CIF Errors" off, or the atoms no longer the CIF's.
 *  `atoms` defaults to the selection's own; Compare passes the partners in the
 *  compared structure, for its values' errors. */
function selectionErrors(structure, detail, atoms = detail?.atoms) {
  if (!detail || general.showCifErrors === false || !structure?.cifErrors) return null;
  return modelErrors(structure, atoms, detail.bonds, detail.angles);
}

/** A selection detail as a mini-view model, with the offered neighbours (if
 *  shown) appended as faint atoms bonded to their selected partners, the
 *  compared structure's values (if any) beside each length and angle, and
 *  each one's CIF error (if any). */
function selectionModel(detail, neighbours, compared = null, errors = null, errors2 = null) {
  if (!detail) return null;
  const atoms = detail.atoms.map((a) => ({ ...a }));
  const bonds = detail.bonds.map((b, k) => ({
    ...b, length2: compared?.bonds[k] ?? null, lengthSu: errors?.bonds[k] ?? null, lengthSu2: errors2?.bonds[k] ?? null,
  }));
  for (const n of neighbours?.atoms ?? []) {
    const idx = atoms.length;
    atoms.push({ ...n, ghost: true });
    n.partners.forEach((p, k) => {
      const drawn = n.partnerBonds?.[k];
      bonds.push({
        a: p, b: idx, ghost: true,
        colorA: drawn?.hexA ?? null, colorB: drawn?.hexB ?? null, trimA: drawn?.trimA ?? null, trimB: drawn?.trimB ?? null,
      });
    });
  }
  const angles = detail.angles.map((g, k) => ({
    ...g, angleDeg2: compared?.angles[k] ?? null, angleSu: errors?.angles[k] ?? null, angleSu2: errors2?.angles[k] ?? null,
  }));
  return { atoms, bonds, angles, hull: null };
}

function compareStatus(cmp) {
  if (!cmp) return '';
  const m = cmp.match;
  if (!m.ok) return `Not compared with ${cmp.nameB}: ${m.reason}.`;
  const cell = m.cell.lengthPct >= 0.05 ? `, cell ${m.cell.lengthPct.toFixed(1)} %` : '';
  return `Compared with ${cmp.nameB}: same structure (atoms matched by ${m.method}; `
    + `RMS ${m.rms.toFixed(3)} Å, max ${m.max.toFixed(3)} Å, limit ${m.tol.toFixed(2)} Å${cell}).`;
}

/**
 * Draw the comparison legend into an export (ExportSource.overlays) where it
 * sits over the view, as on screen: one pill in the length labels' colours
 * with the two names in the two value colours.
 * @param {HTMLElement} legendEl
 * @param {any} painter render/exportPainters.js CanvasPainter or SvgPainter
 * @param {{width:number, height:number, crop:any, viewRect:DOMRect}} ex
 */
function drawLegendForExport(legendEl, painter, ex) {
  const pill = /** @type {HTMLElement|null} */ (legendEl.querySelector('.si-legend-pill'));
  if (legendEl.hidden || !pill) return;
  const place = (el) => cropToOutputRect(viewFraction(el.getBoundingClientRect(), ex.viewRect), ex.crop, ex.width, ex.height);
  const pillRect = pill.getBoundingClientRect();
  const pillOut = place(pill);
  if (!pillOut || !pillRect.width) return;
  const k = pillOut.width / pillRect.width;
  const pillCs = getComputedStyle(pill);
  const midY = pillOut.y + pillOut.height / 2;

  painter.beginGroup('Legend', 'layer-legend');
  painter.roundRect(pillOut.x, pillOut.y, pillOut.width, pillOut.height,
    (parseFloat(pillCs.borderTopLeftRadius) || 0) * k, { fill: pillCs.backgroundColor, label: 'Legend' });
  for (const name of /** @type {NodeListOf<HTMLInputElement>} */ (pill.querySelectorAll('.si-legend-name'))) {
    const text = name.value.trim();
    const out = text && place(name);
    if (!out) continue;
    const cs = getComputedStyle(name);
    painter.text(text, out.x + (parseFloat(cs.paddingLeft) || 0) * k, midY, {
      fontPx: (parseFloat(cs.fontSize) || 12) * k, weight: cs.fontWeight, family: cs.fontFamily,
      align: 'left', baseline: 'middle', fill: cs.color, label: text,
    });
  }
  painter.endGroup();
}

function renderSummary(container, detail, errors = null) {
  if (!detail) {
    container.innerHTML = '<div class="pi-summary-empty">Select atoms in the 3D view to inspect them: click an atom, Shift-click to add more, Ctrl/⌘-click to remove one, or drag to select a region.</div>';
    return;
  }
  const rows = [
    ['Atoms', `${detail.atoms.length} (${detail.formula})`],
    ['Bonds', detail.bonds.length ? String(detail.bonds.length) : 'none within the selection'],
    ['Mean bond length', detail.meanBond != null ? `${formatWithSu(detail.meanBond, errors?.meanBond, 3)} Å` : '—'],
    ['Angles', String(detail.angles.length)],
  ];
  // Say where the numbers in parentheses come from, once any are shown.
  if (errors?.any) rows.push(['Errors', 's.u. from the CIF']);
  container.innerHTML = `
    <div class="pi-summary-grid">
      ${rows.map(([k, v]) => `<span class="pi-summary-key">${k}</span><span class="pi-summary-val">${v}</span>`).join('')}
    </div>
  `;
}

/** The current inspection, for tests and the console. */
export function getSelectionInspectorState() {
  return view?.state() ?? null;
}

export function removeSelectionInspectorPanel() {
  view = null;
  dropToolKey();
  removePanel(PANEL_ID);
}

/** Open the window (the selection bar's Inspect button, the search) — side
 *  dock by default, or wherever the user last dragged it. */
export function openSelectionInspector() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  let mini = null;
  registerPanel({
    id: PANEL_ID,
    title: 'Selection Inspector',
    lifecycle: 'persistent',
    infoMd: './data/selectionInspectorInfo.md',
    closable: true,
    onClose() {
      mini?.dispose();
      mini = null;
      view = null;
      linkWarnEl = null;
      dropToolKey();
      resizeObserver?.disconnect();
    },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="selection-inspector-item">
            <h4>Selection Inspector</h4>
            <div class="pi-controls">
              <div class="pi-ctl-row" id="siNeighbourRow">
                <button type="button" class="btn-mini pi-btn pi-tool-btn pi-icon-btn" id="siNeighboursTool" aria-pressed="false"
                  title="Add bonded neighbours: shows them faintly; click one to add it">
                  <img src="./data/icons/add-neighbour-icon.svg" alt="">
                  <span class="visually-hidden">Bonded neighbours</span>
                </button>
                <button type="button" class="btn-mini pi-btn" id="siAddAllNeighbours" title="Add every bonded neighbour at once">Add all</button>
                <span class="pi-tool-count pi-ctl-note" id="siNeighbourCount"></span>
              </div>
              <div class="pi-ctl-row" id="siCompareRow">
                <button type="button" class="btn-mini pi-btn pi-tool-btn" id="siCompareBtn" aria-pressed="false">Compare</button>
                <span class="pi-tool-count pi-ctl-note" id="siCompareWith"></span>
              </div>
              ${labelToolbarHtml('si', labels)}
              <div class="pi-ctl-row" id="siImageRow">
                <button type="button" class="pi-color" data-color-key="background" title="Background of this view, and of its exported image">
                  <span class="color-swatch-btn pi-color-swatch" id="siColor-background"></span>
                  <span>Background</span>
                </button>
                <button type="button" class="btn-mini pi-btn" id="siExport"
                  title="Save this view as a PNG or SVG image, with the legend — the main view's image dialog">Export image…</button>
              </div>
            </div>
            <div class="pi-hint" id="siHint"></div>
            <div class="pi-hint si-compare" id="siCompare" hidden></div>
            <div id="siSummary"></div>
            <div id="siViewport" class="split-item-body pi-viewport">
              <div class="si-legend" id="siLegend" hidden>
                <div class="si-legend-pill" id="siLegendPill">
                  <input type="text" class="si-legend-name" id="siLegendNameA" spellcheck="false"
                    title="Name of the inspected structure (its values come first on each label)" aria-label="Legend name of the inspected structure">
                  <input type="text" class="si-legend-name" id="siLegendNameB" spellcheck="false"
                    title="Name of the compared structure (its values come second)" aria-label="Legend name of the compared structure">
                </div>
              </div>
            </div>
            <div class="pi-warn" id="siLinkWarn" role="note" hidden>
              ⚠ Periodic copies are linked: switch off “Link colors of periodic copies” (Structure window) for better results.
            </div>
          </div>
        </div>
      `;

      const viewport = /** @type {HTMLElement} */ (body.querySelector('#siViewport'));
      const summaryEl = body.querySelector('#siSummary');
      const hintEl = body.querySelector('#siHint');
      const compareEl = /** @type {HTMLElement} */ (body.querySelector('#siCompare'));
      const legendEl = /** @type {HTMLElement} */ (body.querySelector('#siLegend'));
      const nameAInput = /** @type {HTMLInputElement} */ (body.querySelector('#siLegendNameA'));
      const nameBInput = /** @type {HTMLInputElement} */ (body.querySelector('#siLegendNameB'));
      const legendPill = /** @type {HTMLElement} */ (body.querySelector('#siLegendPill'));
      // A name field is as wide as its text, so the legend hugs its content.
      const fitName = (input) => { input.size = Math.max(4, input.value.length + 1); };
      nameAInput.addEventListener('input', () => { legend.names[0] = nameAInput.value; fitName(nameAInput); });
      nameBInput.addEventListener('input', () => { legend.names[1] = nameBInput.value; fitName(nameBInput); });
      const countEl = body.querySelector('#siNeighbourCount');
      linkWarnEl = /** @type {HTMLElement} */ (body.querySelector('#siLinkWarn'));
      const exportBtn = /** @type {HTMLButtonElement} */ (body.querySelector('#siExport'));
      const toolBtn = /** @type {HTMLButtonElement} */ (body.querySelector('#siNeighboursTool'));
      const addAllBtn = /** @type {HTMLButtonElement} */ (body.querySelector('#siAddAllNeighbours'));
      // Each ⓘ sits right after the buttons it explains.
      body.querySelector('#siNeighbourRow').insertBefore(
        createInfoButton('./data/selectionNeighboursInfo.md', 'About the bonded-neighbours tool'), countEl);
      const compareBtn = /** @type {HTMLButtonElement} */ (body.querySelector('#siCompareBtn'));
      const compareWithEl = /** @type {HTMLElement} */ (body.querySelector('#siCompareWith'));
      body.querySelector('#siCompareRow').insertBefore(
        createInfoButton('./data/selectionCompareInfo.md', 'How comparing works'), compareWithEl);
      compareBtn.addEventListener('click', () => {
        compareOn = !compareOn;
        update({ keepCamera: true });
      });

      mini = createPolyhedronMiniRenderer(viewport);
      // The legend is a label: one pill in the length labels' colours, the two
      // names in the two value colours — read like every label, first value
      // then compared value. Its colours are set in the Colours row.
      const paintLegend = () => {
        const style = mini.getLabelStyle();
        legendPill.style.background = style.lengthBg;
        nameAInput.style.color = style.lengthText;
        nameBInput.style.color = style.compareText;
      };
      const labelBar = wireLabelToolbar(body, 'si', labels, mini, paintLegend, () => setHint());
      paintLegend();
      mini.resize();
      mini.start();

      // What the view currently shows — read by the click handlers and tests.
      let shown = { detail: null, neighbours: null, model: null, cmp: null, compared: null };

      neighbourTool = false;
      const setNeighbourTool = (on) => {
        if (on === neighbourTool) return;
        neighbourTool = on;
        update();
      };
      toolBtn.addEventListener('click', () => setNeighbourTool(!neighbourTool));
      // Esc ends the tool. Bubble phase on the document, so a dialog that
      // handles its own Esc (and stops it) is never second-guessed here.
      const toolKey = (e) => {
        if (e.key !== 'Escape' || !neighbourTool) return;
        const t = /** @type {HTMLElement} */ (e.target);
        if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        setNeighbourTool(false);
      };
      dropToolKey();
      onToolKey = toolKey;
      document.addEventListener('keydown', onToolKey);

      addAllBtn.addEventListener('click', () => {
        const ids = (shown.neighbours?.atoms ?? []).map((n) => n.instanceId);
        if (ids.length) addAtomsToSelectionByInstances(ids, { reason: 'inspector' });
      });

      mini.setHandlers({
        // A faint neighbour joins the selection (the tool stays on, offering
        // the new atom's neighbours too); Ctrl/⌘-click on a selected atom
        // leaves it, as in the main view.
        onAtomClick(index, e) {
          const atom = shown.model?.atoms[index];
          if (!atom || !Number.isInteger(atom.instanceId)) return;
          if (atom.ghost) {
            addAtomsToSelectionByInstances([atom.instanceId], { reason: 'inspector' });
          } else if (e.ctrlKey || e.metaKey) {
            updateAtomSelectionFrom3DHit({ instanceId: atom.instanceId, object: groups.atomsMesh }, {
              selectionMode: 'toggle', sourceEvent: e, scrollToSelection: false, revealPanel: false, reason: 'inspector',
            });
          }
        },
      });

      exportBtn.addEventListener('click', () => {
        if (!mini) return;
        openImageExportDialog({
          source: mini.getExportSource({
            // The view's own background when one is chosen, else the main view's.
            background: () => labels.colors.background ?? colorToCss(app.scene?.background),
            overlays: (painter, ex) => drawLegendForExport(legendEl, painter, ex),
            title: 'Selection Inspector',
          }),
          baseName: `${currentBaseName()}-selection`,
        });
      });

      // The legend moves the way the colour bars do (ui/ColorBarDrag.js): by
      // its ⦀ grip or its background, with mouse, touch or pen; the names and
      // keys keep their own clicks. It stays inside the view.
      const legendDrag = makeDraggableWithin(legendEl, viewport, {
        gripTitle: 'Drag to move the legend', anchor: legend.pos,
        onAnchor: (a) => { legend.pos = a; },
      });
      const applyLegendPos = () => legendDrag.reapply(legend.pos);
      // A double-click on the legend is not one on the view (re-centre).
      legendEl.addEventListener('dblclick', (e) => e.stopPropagation());

      // Double-click re-centres — on the faint atoms too while the tool is on.
      viewport.addEventListener('dblclick', () => mini.fit({ includeGhosts: neighbourTool }));

      function setHint() {
        hintEl.textContent = !shown.detail ? ''
          : labels.placing ? 'Drag a label to place it. Press Move labels again to rotate the view.'
            : neighbourTool ? 'Click a faint atom to add it; the button again or Esc finishes.'
              : 'Point at a label (tap, on touch) and press its × to hide it. Double-click to re-centre.';
      }

      function update(opts = {}) {
        const structure = fileBrowser.selectedStructure;
        const detail = computeSelectionDetail(structure, getSelectedAtoms());
        if (!detail) neighbourTool = false;
        const neighbours = detail ? findSelectionNeighbours(structure, detail) : null;
        const cmp = comparison(() => view?.update({ keepCamera: true }));
        // Compare: available with exactly one other structure ticked in Files.
        const cand = compareCandidate();
        compareBtn.disabled = !cand.row;
        compareBtn.classList.toggle('active', compareOn && !!cand.row);
        compareBtn.setAttribute('aria-pressed', compareOn && cand.row ? 'true' : 'false');
        compareBtn.title = cand.row
          ? (compareOn ? 'Stop comparing' : `Compare every length and angle with ${stepName(cand.row.name, cand.row.step, cand.row.steps)}`)
          : cand.why;
        compareWithEl.textContent = cand.row ? `with ${stepName(cand.row.name, cand.row.step, cand.row.steps)}` : cand.why;
        compareWithEl.title = compareWithEl.textContent;
        const compared = detail && cmp?.match.ok ? compareSelectionDetail(detail, cmp.match, cmp.A, cmp.B) : null;
        const errors = selectionErrors(structure, detail);
        // The compared structure's own CIF errors, on its values.
        const errors2 = compared ? selectionErrors(cmp.B, detail, compared.atoms) : null;
        const model = selectionModel(detail, neighbourTool ? neighbours : null, compared, errors, errors2);
        compareEl.hidden = !cmp;
        compareEl.textContent = compareStatus(cmp);
        legendEl.hidden = !compared;
        if (cmp) {
          if (document.activeElement !== nameAInput) nameAInput.value = legend.names[0] ?? cmp.nameA;
          if (document.activeElement !== nameBInput) nameBInput.value = legend.names[1] ?? cmp.nameB;
          fitName(nameAInput);
          fitName(nameBInput);
          applyLegendPos();
        }
        paintLegend();
        labelBar.showCompareColor(!!compared);
        renderSummary(summaryEl, detail, errors);
        // Only a new set of atoms is framed; any change to the same set keeps
        // the user's view exactly where it is.
        const before = new Set((shown.detail?.atoms ?? []).map((a) => a.key));
        const continued = !!detail?.atoms.some((a) => before.has(a.key));
        shown = { detail, neighbours, model, cmp, compared };
        setHint();
        mini.setModel(model, { keepCamera: !!opts.keepCamera || continued });

        const offered = neighbours?.atoms.length ?? 0;
        addAllBtn.disabled = offered === 0;
        exportBtn.disabled = !detail;
        toolBtn.disabled = !detail;
        toolBtn.classList.toggle('active', neighbourTool);
        toolBtn.setAttribute('aria-pressed', neighbourTool ? 'true' : 'false');
        const copies = neighbours?.linkedCopies ?? 0;
        countEl.textContent = !detail ? ''
          : `${offered} bonded neighbour${offered === 1 ? '' : 's'}${copies ? ` (+${copies} linked ${copies === 1 ? 'copy' : 'copies'})` : ''}`;
        countEl.title = copies ? 'Copies of selected atoms cannot be added while "Link periodic copies" is on (Atoms tab).' : '';
        labelBar.refresh();
        syncLinkWarn();
      }

      resizeObserver = new ResizeObserver(() => { mini?.resize(); applyLegendPos(); });
      resizeObserver.observe(viewport);

      view = {
        update,
        state: () => ({
          compareButton: {
            disabled: compareBtn.disabled, pressed: compareBtn.getAttribute('aria-pressed') === 'true', note: compareWithEl.textContent,
          },
          compare: shown.cmp ? {
            ok: shown.cmp.match.ok, reason: shown.cmp.match.reason, method: shown.cmp.match.method,
            max: shown.cmp.match.max, status: compareEl.textContent, legendShown: !legendEl.hidden,
            names: [nameAInput.value, nameBInput.value], colors: { ...labels.colors }, legendPos: legend.pos,
            lengths: (shown.model?.bonds ?? []).filter((b) => !b.ghost).map((b) => [b.length, b.length2]),
            lengthSus: (shown.model?.bonds ?? []).filter((b) => !b.ghost).map((b) => [b.lengthSu ?? null, b.lengthSu2 ?? null]),
            angles: (shown.model?.angles ?? []).map((g) => [g.angleDeg, g.angleDeg2]),
          } : null,
          atoms: shown.model?.atoms.filter((a) => !a.ghost).length ?? 0,
          neighbours: shown.model?.atoms.filter((a) => a.ghost).length ?? 0,
          offered: shown.neighbours?.atoms.length ?? 0,
          neighbourTool,
          bonds: shown.model?.bonds.filter((b) => !b.ghost).length ?? 0,
          bondEnds: (shown.model?.bonds ?? []).filter((b) => !b.ghost).map((b) => ({
            a: shown.model.atoms[b.a].pos, b: shown.model.atoms[b.b].pos, trimA: b.trimA, trimB: b.trimB,
          })),
          angles: shown.model?.angles.length ?? 0,
          // The CIF errors shown: each length's and angle's s.u. (null = none).
          errors: {
            lengths: (shown.model?.bonds ?? []).filter((b) => !b.ghost).map((b) => b.lengthSu ?? null),
            angles: (shown.model?.angles ?? []).map((g) => g.angleSu ?? null),
            summary: summaryEl.textContent,
          },
          hiddenLabels: [...labels.hidden],
          labels: mini?.getLabels() ?? [],
          ghostScreen: mini?.getAtomScreenPositions().filter((a) => a.ghost) ?? [],
          solidScreen: mini?.getAtomScreenPositions().filter((a) => !a.ghost) ?? [],
          camera: mini ? mini.getCamera().position.toArray() : null,
          viewport: (({ left, top, right, bottom }) => ({ left, top, right, bottom }))(viewport.getBoundingClientRect()),
        }),
      };
      update();
    },
    defaults: {
      dock: 'right', collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 30 },
    },
  });
  openPanel(PANEL_ID);
}

subscribeToAtomSelection(() => view?.update());
// Rebuilds and recolouring change what the atoms look like (or where a moved
// atom is), not which atoms are inspected: refresh in place.
document.addEventListener('crysviz:colors-changed', () => view?.update({ keepCamera: true }));
// "Show CIF Errors" switched, or a CIF's errors were read.
document.addEventListener('crysviz:cif-errors-changed', () => view?.update({ keepCamera: true }));
document.addEventListener('crysviz:polyhedra-rebuilt', () => view?.update({ keepCamera: true }));
// The note on linked copies: the setting changed, or the copies on screen did.
document.addEventListener('crysviz:link-copies-changed', () => syncLinkWarn());
onAtomsRebuilt(() => syncLinkWarn());
// The compared structure was ticked, unticked or stepped (ui/FileBrowswerPanel.js).
document.addEventListener('crysviz:comparison-changed', () => view?.update({ keepCamera: true }));
// A Files row's step changed — the compared frame, when that row is ticked
// (outside Comparison mode nothing else reports it).
document.addEventListener('input', (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t?.matches?.('#objectTable input[type="number"]')) view?.update({ keepCamera: true });
});
