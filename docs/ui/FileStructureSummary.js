// "Parameters" section of the Files window: a collapsible block under the
// structure table showing the SELECTED structure's scalar properties (energy,
// pressure, max force — whichever it carries), its lattice (vectors,
// parameters, volume), its atomic positions (fractional or Cartesian) and
// its Wyckoff positions (the site symmetry only in the copied text — the
// sidebar is too narrow for a sixth column), all of it plain selectable text (drag-select and
// copy like anywhere else; the app otherwise disables selection in panels),
// with a copy button per block — plus the ✎ button that opens the same
// Modify Structure panel as the pen in the Structure window.
//
// Follows the selection (state/structures.js's active-structure change) and
// live edits (core/crystal-viewer.js's updateVisualization calls
// refreshFileStructureSummary, which only re-renders when the lattice or the
// positions actually changed). Wyckoff positions come from the structure's
// active Wyckoff lock when it has one, else from a moyo analysis at a tight
// fixed tolerance (WYCKOFF_TOLERANCE) — run debounced, and only while the section is
// open, so trajectory playback with the section folded costs nothing.

import { fileBrowser } from '../state/store.js';
import { onActiveStructureChange } from '../state/structures.js';
import { getPanelPref, setPanelPref } from './panels/PanelManager.js';
import { openModifyStructurePanel } from './addToStructureModule/AddStructureModule.js';
import { analyzeStructureSymmetry } from './SymmetryEditModule.js';
import { hallEntry, symdataHallUrl } from './BackendPanel/hallSymbols.js';
import {
  latticeText, latticeParamsText, positionsTable, wyckoffRows, wyckoffText, structureSummaryText,
  scalarProperties,
} from './structureSummaryText.js';

const ROOT_ID = 'fileStructureSummary';
const OPEN_PREF = 'fileStructureInfoOpen';
// Rows shown in the positions table before it is cut short (the copy still
// carries every atom) — a 5 000-atom MD frame must not stall the Files window.
const MAX_SHOWN_ROWS = 400;
const WYCKOFF_DEBOUNCE_MS = 250;
// A deliberately tight symprec for the Wyckoff analysis this section runs
// itself: the Parameters block reports the symmetry the structure actually
// has, not the looser grouping a bigger tolerance would merge sites into.
// (An active Wyckoff lock, when the structure has one, still wins over this.)
const WYCKOFF_TOLERANCE = 1e-5;

const state = {
  structure: null,
  /** Lattice + positions signature of what is rendered, for cheap "changed?" checks. */
  signature: '',
  cartesian: false,
  /** @type {{signature: string, tolerance: number, info: object | null, error: string | null} | null} */
  wyckoff: null,
  wyckoffTimer: 0,
  wyckoffToken: 0,
};

let subscribed = false;

function root() {
  return document.getElementById(ROOT_ID);
}

function q(sel) {
  return root()?.querySelector(sel) ?? null;
}

function isOpen() {
  return !!root()?.open;
}

function selectedName() {
  return fileBrowser.selectedRow?.querySelector('.name-inner')?.textContent?.trim() || '';
}

/** Cheap identity of the shown geometry: the lattice and every position at
 *  6 decimals — what the tables display, so a change below that is no
 *  change. Atom count and elements are folded in through the positions. */
function signatureOf(structure) {
  if (!structure) return '';
  const parts = [structure.lattice.flat().map((v) => v.toFixed(6)).join(',')];
  for (let i = 0; i < structure.atoms.length; i++) {
    parts.push(structure.elements[i], structure.atoms[i].position.map((v) => v.toFixed(6)).join(','));
  }
  return parts.join('|');
}

// ---- clipboard ----------------------------------------------------------------

function flash(el) {
  if (!el) return;
  el.classList.add('fss-copied');
  setTimeout(() => el.classList.remove('fss-copied'), 900);
}

function copyText(text, flashEl) {
  if (!text) return;
  if (!navigator.clipboard?.writeText) {
    setStatus('Clipboard is not available in this browser.');
    return;
  }
  navigator.clipboard.writeText(text).then(() => flash(flashEl)).catch((error) => {
    setStatus('Copy failed.');
    console.error('Copy failed:', error);
  });
}

function setStatus(text) {
  const el = q('#fssStatus');
  if (el) el.textContent = text;
}

/** The text a block's copy button puts on the clipboard. */
function blockText(block) {
  const { structure } = state;
  if (!structure) return '';
  if (block === 'lattice') return `${latticeText(structure.lattice)}\n${latticeParamsText(structure.lattice)}`;
  if (block === 'positions') return positionsTable(structure, state.cartesian).text;
  if (block === 'wyckoff') return state.wyckoff?.info ? wyckoffText(state.wyckoff.info) : '';
  if (block === 'all') {
    return structureSummaryText(structure, { name: selectedName(), cartesian: state.cartesian, wyckoff: state.wyckoff?.info ?? null });
  }
  return '';
}

// ---- rendering -----------------------------------------------------------------

const fmt = (v, digits = 6) => (Number.isFinite(v) ? v.toFixed(digits) : '–');
const cell = (text) => `<td>${escapeHtml(text)}</td>`;

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function renderProperties(structure) {
  const el = q('#fssProperties');
  if (!el) return;
  const rows = scalarProperties(structure);
  el.hidden = false;
  if (!rows.length) {
    // A plain geometry file (a POSCAR, a CIF) carries no energy, force or
    // stress — say so rather than showing an empty gap.
    el.innerHTML = '<span class="fss-muted">No energy, force or stress data for this structure.</span>';
    return;
  }
  // Energy, pressure, max force — the scalars the frame carries — as chips
  // at the top, plain selectable text like everything else.
  el.innerHTML = rows.map((r) =>
    `<span class="fss-chip">${escapeHtml(r.label)} = ${fmt(r.value, r.digits)} ${escapeHtml(r.unit)}</span>`).join('');
}

function renderLattice(structure) {
  const pre = q('#fssLattice');
  const params = q('#fssParams');
  if (!pre || !params) return;
  pre.textContent = latticeText(structure.lattice);
  // One chip per parameter.
  params.innerHTML = latticeParamsText(structure.lattice).split('  ')
    .map((item) => `<span class="fss-chip">${escapeHtml(item)}</span>`).join('');
}

function renderPositions(structure) {
  const tbody = q('#fssPositionsBody');
  const note = q('#fssPositionsNote');
  const head = q('#fssPositionsHead');
  if (!tbody || !note || !head) return;
  const { rows } = positionsTable(structure, state.cartesian);
  head.textContent = state.cartesian ? 'Cartesian positions (Å)' : 'Fractional positions';
  const shown = rows.slice(0, MAX_SHOWN_ROWS);
  tbody.innerHTML = shown.map((r) => `<tr>
      <td class="fss-idx">${r.index}</td>${cell(r.label)}${r.xyz.map((v) => cell(fmt(v))).join('')}
    </tr>`).join('');
  note.textContent = rows.length > shown.length
    ? `Showing ${shown.length} of ${rows.length} atoms — the copy carries all of them.`
    : `${rows.length} atom${rows.length === 1 ? '' : 's'}`;
  q('#fssFracBtn')?.classList.toggle('active', !state.cartesian);
  q('#fssCartBtn')?.classList.toggle('active', state.cartesian);
}

function renderWyckoff() {
  const tbody = q('#fssWyckoffBody');
  const line = q('#fssSpaceGroup');
  const table = q('#fssWyckoffTable');
  if (!tbody || !line || !table) return;
  const w = state.wyckoff;
  if (!w || w.signature !== state.signature) {
    line.textContent = isOpen() ? 'Analysing symmetry…' : '';
    table.hidden = true;
    tbody.innerHTML = '';
    return;
  }
  if (w.error) {
    line.textContent = w.error;
    table.hidden = true;
    tbody.innerHTML = '';
    return;
  }
  const info = w.info;
  const fromLock = state.structure?.symmetry?.mode === 'wyckoff';
  // "Pnnm (58)" — linked to the symbol's symdata page, like the Symmetry
  // panel, when a Hall number is known (a fresh analysis always has one; an
  // active Wyckoff lock may not, and then it stays plain text).
  const sgLabel = escapeHtml(info.spaceGroup) + (info.number ? ` (${info.number})` : '');
  const hall = Number.isInteger(info.hallNumber) ? hallEntry(info.hallNumber) : null;
  const url = hall ? symdataHallUrl(hall.symbol) : null;
  const sg = url
    ? `<a class="sym-link" href="${url}" target="_blank" rel="noopener noreferrer">${sgLabel}</a>`
    : sgLabel;
  const tol = w.tolerance < 1e-3 ? w.tolerance.toExponential(0) : String(w.tolerance);
  const source = fromLock ? 'from the active Wyckoff lock' : `tolerance ${tol} Å`;
  line.innerHTML = `Space group ${sg}`
    + ` <span class="fss-muted">· ${info.rows.length} orbit${info.rows.length === 1 ? '' : 's'} (${source})</span>`;
  table.hidden = false;
  tbody.innerHTML = info.rows.map((r) => `<tr>
      ${cell(r.element)}${cell(r.wyckoff)}${r.xyz.map((v) => cell(fmt(v))).join('')}
    </tr>`).join('');
}

/** Run (or reuse) the symmetry analysis for the shown structure. The active
 *  Wyckoff lock is authoritative when there is one; otherwise moyo at the
 *  a tight fixed tolerance, debounced against playback. */
function scheduleWyckoff() {
  clearTimeout(state.wyckoffTimer);
  const { structure, signature } = state;
  if (!structure || !isOpen()) return;
  const tolerance = WYCKOFF_TOLERANCE;
  if (state.wyckoff && state.wyckoff.signature === signature && state.wyckoff.tolerance === tolerance) {
    renderWyckoff();
    return;
  }
  if (structure.symmetry?.mode === 'wyckoff') {
    state.wyckoff = { signature, tolerance, info: wyckoffRows(structure, { lock: structure.symmetry }), error: null };
    renderWyckoff();
    return;
  }
  renderWyckoff(); // "Analysing…"
  const token = ++state.wyckoffToken;
  state.wyckoffTimer = window.setTimeout(async () => {
    try {
      const dataset = await analyzeStructureSymmetry(structure, tolerance);
      if (token !== state.wyckoffToken) return;
      state.wyckoff = { signature, tolerance, info: wyckoffRows(structure, { dataset }), error: null };
    } catch (error) {
      if (token !== state.wyckoffToken) return;
      state.wyckoff = { signature, tolerance, info: null, error: error?.message || String(error) };
    }
    if (state.signature === signature) renderWyckoff();
  }, WYCKOFF_DEBOUNCE_MS);
}

function render() {
  const el = root();
  if (!el) return;
  const structure = fileBrowser.selectedStructure;
  const empty = q('#fssEmpty');
  const body = q('#fssBody');
  if (!structure) {
    state.structure = null;
    state.signature = '';
    if (empty) empty.hidden = false;
    if (body) body.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;
  if (body) body.hidden = false;
  state.structure = structure;
  state.signature = signatureOf(structure);
  if (!el.open) return; // folded: nothing to draw until it opens
  renderProperties(structure);
  renderLattice(structure);
  renderPositions(structure);
  scheduleWyckoff();
}

/** Re-render if the selected structure's geometry changed (an edit in the
 *  Modify Structure panel, a relaxation step, a frame switch); a no-op
 *  otherwise. Called from updateVisualization. */
export function refreshFileStructureSummary() {
  if (!root()) return;
  const structure = fileBrowser.selectedStructure;
  if (structure === state.structure) {
    // Folded: nothing of this structure is shown, and the geometry is re-read
    // on the next unfold — skip the per-atom signature entirely.
    if (!isOpen() || signatureOf(structure) === state.signature) return;
  }
  render();
}

// ---- build --------------------------------------------------------------------

/** Append the section to the Files window's body. Idempotent per body. */
export function addFileStructureSummary(body) {
  if (!body || body.querySelector(`#${ROOT_ID}`)) return;
  const details = document.createElement('details');
  details.id = ROOT_ID;
  details.className = 'fss';
  details.open = !!getPanelPref(OPEN_PREF);
  details.innerHTML = `
    <summary class="fss-summary">
      <span class="eos-collapsible-arrow">▶</span>
      <span class="fss-title">Parameters</span>
      <span class="fss-summary-actions">
        <button type="button" id="fssEditBtn" class="btn-mini highlight structure-edit-button" title="Modify structure: lattice, atoms, add and remove">✎</button>
      </span>
    </summary>
    <div class="fss-empty" id="fssEmpty">No structure loaded.</div>
    <div class="fss-body" id="fssBody" hidden>
      <div class="fss-props" id="fssProperties"></div>
      <section class="fss-block">
        <div class="fss-block-head">
          <span>Lattice vectors (Å)</span>
          <button type="button" class="fss-copy-btn" data-copy-block="lattice" title="Copy the lattice and its parameters">⧉</button>
        </div>
        <pre class="fss-pre" id="fssLattice"></pre>
        <div class="fss-params" id="fssParams"></div>
      </section>
      <section class="fss-block">
        <div class="fss-block-head">
          <span id="fssPositionsHead">Fractional positions</span>
          <span class="fss-seg" role="group" aria-label="Coordinate system">
            <button type="button" id="fssFracBtn" class="active" title="Fractional coordinates">frac</button>
            <button type="button" id="fssCartBtn" title="Cartesian coordinates (Å)">cart</button>
          </span>
          <button type="button" class="fss-copy-btn" data-copy-block="positions" title="Copy every atom's position">⧉</button>
        </div>
        <div class="fss-table-wrap">
          <table class="fss-table">
            <thead><tr><th>#</th><th>El</th><th>x</th><th>y</th><th>z</th></tr></thead>
            <tbody id="fssPositionsBody"></tbody>
          </table>
        </div>
        <div class="fss-muted" id="fssPositionsNote"></div>
      </section>
      <section class="fss-block">
        <div class="fss-block-head">
          <span>Wyckoff positions</span>
          <button type="button" class="fss-copy-btn" data-copy-block="wyckoff" title="Copy the space group and Wyckoff positions">⧉</button>
        </div>
        <div class="fss-muted" id="fssSpaceGroup"></div>
        <div class="fss-table-wrap">
          <table class="fss-table" id="fssWyckoffTable" hidden>
            <thead><tr><th>El</th><th>Wyck.</th><th>x</th><th>y</th><th>z</th></tr></thead>
            <tbody id="fssWyckoffBody"></tbody>
          </table>
        </div>
      </section>
      <div class="fss-muted fss-status" id="fssStatus"></div>
    </div>
  `;
  body.appendChild(details);

  // Buttons inside <summary> must not toggle the fold.
  details.querySelector('.fss-summary-actions').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const target = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!target) return;
    if (target.id === 'fssEditBtn') openModifyStructurePanel();
    else if (target.dataset.copyBlock) copyText(blockText(target.dataset.copyBlock), target);
  });

  // Block buttons copy their block; the frac/cart pair switches coordinates.
  // Values themselves are ordinary selectable text (see .fss-body's
  // user-select), so a click on them does nothing special.
  details.querySelector('#fssBody').addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const blockBtn = target.closest('[data-copy-block]');
    if (blockBtn) {
      copyText(blockText(blockBtn.dataset.copyBlock), blockBtn);
      return;
    }
    if (target.id === 'fssFracBtn' || target.id === 'fssCartBtn') {
      state.cartesian = target.id === 'fssCartBtn';
      if (state.structure) renderPositions(state.structure);
    }
  });

  details.addEventListener('toggle', () => {
    setPanelPref(OPEN_PREF, details.open);
    if (details.open) render();
  });

  if (!subscribed) {
    subscribed = true;
    onActiveStructureChange(() => render());
  }
  render();
}
