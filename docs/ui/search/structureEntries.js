// Search results for the selected structure's own content in the Structure
// window: its elements (Atoms tab), single atoms, bond pairs (Bonds tab),
// polyhedra categories (Poly tab) and Wyckoff sites. This is structure data,
// not app features, so it is never in the generated control index
// (controlIndex.js); it is read from the live Structure window each time the
// palette opens, keyed the way the window itself finds its rows
// (SelectAndHighlightModule.js: .comp-container[data-element],
// .bond-control[data-pair], .poly-control[data-cat-key]).
//
// Choosing a result opens the formula box on the right tab and lands on the
// row; an atom is also selected, exactly like picking it in the 3D view.

import { setStructurePanelOpen } from '../StructureInfoPanel/General.js';
import { highlightAtomInStructurePanel, selectAtomFromRow } from '../SelectAndHighlightModule.js';
import { elementData } from '../PeriodicTablePickerCore.js';
import { fileBrowser } from '../../state/store.js';
import { flashElement, DOT_FLASH } from '../KeyboardShortcuts.js';

// Past this many atoms the per-atom results would drown everything else
// (and the per-element rows remain searchable).
const MAX_ATOM_RESULTS = 400;

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Select a Structure-window tab (Atoms / Bonds / Poly / Wyckoff) the way a
 *  click does. */
function selectTab(mode) {
  const btn = /** @type {HTMLElement|null} */ (
    document.querySelector(`#atomBondControlSwitch button[data-mode="${mode}"]`));
  if (btn && !btn.classList.contains('active')) btn.click();
  return !!btn;
}

function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '?';
}

/**
 * @param {{ revealStructure: () => Promise<boolean>, land: (el: HTMLElement, style?: { className: string, ms: number }) => Promise<void> }} ui
 *   revealStructure brings the Structure window into view (FeatureSearch
 *   owns the window rules); land scrolls a row into view and flashes it.
 */
export function structureEntries({ revealStructure, land }) {
  const composition = document.getElementById('composition');
  const structure = fileBrowser.selectedStructure;
  if (!composition || !structure) return [];
  const out = [];
  const go = (mode, find) => async () => {
    if (!(await revealStructure())) return;
    setStructurePanelOpen(true);
    selectTab(mode);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const el = find();
    if (el) await land(el);
  };

  // Elements: the Atoms tab, or — for a symmetry-generated structure, where
  // it replaces the Atoms tab — the Wyckoff tab.
  for (const [panelId, mode, tabName] of [['atomPanel', 'atoms', 'Atoms'], ['wyckoffPanel', 'wyckoff', 'Wyckoff']]) {
    for (const node of composition.querySelectorAll(`#${panelId} .comp-container[data-element]`)) {
      const container = /** @type {HTMLElement} */ (node);
      const el = container.dataset.element;
      const pct = text(container.querySelector('.comp-pct-label')).replace(/[()]/g, '');
      const name = elementData[el]?.name;
      out.push({
        type: 'structure', kind: 'element', label: el,
        path: [`Structure › ${tabName}`, name, pct].filter(Boolean).join(' · '),
        keywords: name ? [name] : [],
        pathSearchable: false,
        run: go(mode, () => /** @type {HTMLElement|null} */ (
          document.querySelector(`#${panelId} .comp-container[data-element="${CSS.escape(el)}"] .comp-row`))),
      });
    }
  }

  const selectAndShow = (el, atomIndex) => async () => {
    if (!(await revealStructure())) return;
    // Same selection as picking it in the 3D view (glows it there), then the
    // row: opened, highlighted, scrolled to. For a Wyckoff orbit the row is
    // its site (SelectAndHighlightModule.js maps the atom to its orbit).
    selectAtomFromRow(atomIndex);
    highlightAtomInStructurePanel(el, atomIndex);
  };

  // Single atoms, labelled as their rows are (IndividualAtomRow.js:
  // element + running number within the element). Ordered, non-Wyckoff
  // structures only — disordered sites and orbits have their own labels.
  const elements = Array.isArray(structure.elements) ? structure.elements : [];
  const wyckoff = structure.symmetry?.mode === 'wyckoff';
  const disordered = (structure.atoms || []).some((a) => a?.isDisordered?.());
  if (!wyckoff && !disordered && elements.length && elements.length <= MAX_ATOM_RESULTS) {
    const seen = new Map();
    elements.forEach((el, atomIndex) => {
      const n = (seen.get(el) || 0) + 1;
      seen.set(el, n);
      const p = structure.atoms?.[atomIndex]?.position;
      out.push({
        type: 'structure', kind: 'atom', label: `${el}${n}`,
        path: `Structure › Atoms › ${el}${Array.isArray(p) ? ` · (${p.map(fmt).join(', ')})` : ''}`,
        keywords: [],
        pathSearchable: false,
        run: selectAndShow(el, atomIndex),
      });
    });
  }

  // Bond pairs (Bonds tab).
  for (const node of composition.querySelectorAll('.bond-control[data-pair]')) {
    const control = /** @type {HTMLElement} */ (node);
    const pair = control.dataset.pair;
    const [a, b] = pair.split('-');
    const count = text(control.querySelector('.bond-count'));
    const range = text(control.querySelector('.slider-value'));
    out.push({
      type: 'structure', kind: 'bond', label: pair,
      path: ['Structure › Bonds', count && `${count} bonds`, range].filter(Boolean).join(' · '),
      keywords: b ? [`${b}-${a}`] : [],
      pathSearchable: false,
      run: go('bonds', () => /** @type {HTMLElement|null} */ (
        document.querySelector(`.bond-control[data-pair="${CSS.escape(pair)}"]`))),
    });
  }

  // Polyhedra categories (Poly tab, while polyhedra are on).
  for (const node of composition.querySelectorAll('.poly-control[data-cat-key]')) {
    const control = /** @type {HTMLElement} */ (node);
    const key = control.dataset.catKey;
    const label = text(control.querySelector('.phl-cat-label')) || key;
    out.push({
      type: 'structure', kind: 'polyhedron', label,
      path: ['Structure › Poly', text(control.querySelector('.poly-count'))].filter(Boolean).join(' · '),
      keywords: [],
      pathSearchable: false,
      run: go('polyhedra', () => /** @type {HTMLElement|null} */ (
        document.querySelector(`.poly-control[data-cat-key="${CSS.escape(key)}"]`))),
    });
  }

  // Wyckoff sites (Wyckoff tab, symmetry-generated structures): one row per
  // orbit, labelled like "N2  2d" (atom label + multiplicity and letter).
  for (const node of composition.querySelectorAll('#wyckoffPanel .individual-atom-row[data-atom-index]')) {
    const row = /** @type {HTMLElement} */ (node);
    const label = text(row.querySelector('.iar-name'));
    if (!label) continue;
    const atomIndex = Number(row.dataset.atomIndex);
    const el = row.dataset.element || elements[atomIndex];
    out.push({
      type: 'structure', kind: 'site', label,
      path: ['Structure › Wyckoff', elementData[el]?.name].filter(Boolean).join(' · '),
      keywords: [],
      pathSearchable: false,
      run: selectAndShow(el, atomIndex),
    });
  }

  // The colour dots of a tab — one per element, bond pair or polyhedra
  // category, each opening that row's colour editor — as one result: it opens
  // the tab and flashes every dot. "colour" leads with these (BEST_BETS).
  for (const [key, mode, label, tab, selector] of [
    ['element-colors', 'atoms', 'Element colors', 'Atoms', '#atomPanel .comp-container .dot'],
    ['element-colors', 'wyckoff', 'Element colors', 'Wyckoff', '#wyckoffPanel .comp-container .dot'],
    ['bond-colors', 'bonds', 'Bond pair colors', 'Bonds', '.bond-control[data-pair] .bond-cat-dot'],
    ['polyhedra-colors', 'polyhedra', 'Polyhedra colors', 'Poly', '.poly-control[data-cat-key] .phl-cat-dot'],
  ]) {
    if (out.some((e) => e.key === key) || !composition.querySelector(selector)) continue;
    out.push({
      type: 'structure', kind: 'colors', key, label,
      path: `Structure › ${tab} · click a dot to change its colour`,
      keywords: ['colour dots'],
      pathSearchable: false,
      run: async () => {
        if (!(await revealStructure())) return;
        setStructurePanelOpen(true);
        selectTab(mode);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const dots = /** @type {HTMLElement[]} */ ([...document.querySelectorAll(selector)]);
        if (!dots.length) return;
        await land(dots[0], DOT_FLASH);
        dots.slice(1).forEach((dot) => flashElement(dot, DOT_FLASH));
      },
    });
  }
  return out;
}
