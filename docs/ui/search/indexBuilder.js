// Builds the feature search's full control list (controlIndex.js) inside a
// running app. Never imported by the app itself: tools/browsertest/
// gen_search_index.js calls it to write the file, and the searchindex browser
// test calls it to prove the committed file is current.
//
// Every window is opened (feature-store windows are added to the sidebar for
// the run), its disclosures unfolded and its tab rows walked, harvesting at
// each step with the same controlHarvest.js code the live search uses. A
// window that is unavailable for the loaded structure contributes nothing —
// the generator loads data that makes as many windows available as it can.

import { listPanels, getPanel, openPanel } from '../panels/PanelManager.js';
import { harvestWindow, tabRows, tabLabel, isShown } from './controlHarvest.js';

// Development / transient windows the search has no business indexing.
const SKIP_PANEL = (id) => id === 'splitDemo' || id.startsWith('debug');
const MAX_TAB_DEPTH = 2;

function nextFrames(n = 2) {
  return new Promise((resolve) => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

const keyOf = (e) => `${e.label}\u0000${e.section}\u0000${e.kind}`;

/** Unfold every disclosure under `root`: <details>, and [aria-controls]
 *  openers whose target is closed (the Structure window's formula box, the
 *  Files window's Download menu). */
async function openDisclosures(root) {
  for (const d of root.querySelectorAll('details')) /** @type {HTMLDetailsElement} */ (d).open = true;
  for (const btn of root.querySelectorAll('[aria-controls]')) {
    const target = document.getElementById(btn.getAttribute('aria-controls') || '');
    if (!target || !isShown(/** @type {HTMLElement} */ (btn))) continue;
    if (target.hidden || target.getAttribute('aria-hidden') === 'true') {
      /** @type {HTMLElement} */ (btn).click();
      await nextFrames();
    }
  }
}

/** Harvest `root`, then each tab of every tab row not already walked. */
async function explore(root, tabs, walkedRows, depth) {
  const found = harvestWindow(root, { tabs });
  if (depth >= MAX_TAB_DEPTH) return found;
  const seen = new Set(found.map(keyOf));
  const rows = tabRows(root).filter(({ row }) => !walkedRows.has(row));
  for (const { row } of rows) walkedRows.add(row);
  for (const { buttons, active } of rows) {
    for (const btn of buttons) {
      if (btn === active || !btn.isConnected || !isShown(btn)) continue;
      const label = tabLabel(btn);
      if (!label) continue;
      btn.click();
      await nextFrames(3);
      for (const e of await explore(root, [...tabs, label], walkedRows, depth + 1)) {
        if (!seen.has(keyOf(e))) {
          seen.add(keyOf(e));
          found.push(e);
        }
      }
    }
    if (active && active.isConnected) {
      active.click();
      await nextFrames(3);
    }
  }
  return found;
}

/**
 * @returns {Promise<{panel: string, label: string, section: string, kind: string, id?: string, tabs?: string[]}[]>}
 */
export async function buildControlIndex() {
  const index = [];
  for (const { id } of listPanels()) {
    if (SKIP_PANEL(id)) continue;
    const panel = getPanel(id);
    if (!panel) continue;
    openPanel(id);
    await nextFrames(4);
    if (!panel.available || !panel.built || panel.collapsed) continue;
    await openDisclosures(panel.body);
    const entries = await explore(panel.body, [], new Set(), 0);
    const seen = new Set();
    for (const { el: _el, ...entry } of entries) {
      const key = keyOf(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      index.push({ panel: id, ...entry });
    }
  }
  return index;
}

/** One entry per line, keys in a fixed order — the controlIndex.js body. */
export function serializeControlIndex(index) {
  const order = ['panel', 'label', 'section', 'kind', 'id', 'tabs'];
  return index.map((e) => {
    const o = {};
    for (const k of order) if (e[k] !== undefined && e[k] !== '') o[k] = e[k];
    return `  ${JSON.stringify(o)},`;
  }).join('\n');
}
