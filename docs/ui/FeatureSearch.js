// Feature search: a command palette over everything the app can do.
//
// Ctrl/Cmd+F (or the search field at the top of the sidebar) opens it; a
// second Ctrl/Cmd+F while it is open falls through to the browser's own
// find-in-page (see the note in KeyboardShortcuts.js's header). Results:
//
//   Window   every registered window — in the sidebar or still in the
//            out of it (badged "Not in sidebar": Enter adds it)
//   Action   the keyboard-shortcut commands (KeyboardShortcuts.js), with
//            their binding, plus a few app-level ones (theme, store, About)
//   Control  every labelled button / toggle / slider / select inside the
//            windows: the generated full list (search/controlIndex.js) merged
//            with a live harvest of the windows built right now, which also
//            catches controls that only exist for the loaded data
//   Structure  the selected structure's elements, atoms, bond pairs,
//            polyhedra categories and Wyckoff sites, as the Structure window
//            lists them (search/structureEntries.js)
//
// Choosing a control goes to it: its window is added to the sidebar if it was
// in the store, opened, the right in-window tab selected, any disclosure it
// sits behind unfolded, then the control is scrolled into view and flashed.
// Matching is fuzzy (search/fuzzy.js): word prefixes, word forms, initials,
// in-order letters and small typos all count; and every result also answers
// to the phrases the search vocabulary (search/concepts.js) gives it, so
// "lattice vibrations" finds Phonons.

import {
  listPanels, getPanel, openPanel, listStoreFeatures,
} from './panels/PanelManager.js';
import { listShortcutCommands, flashElement, flashPanel } from './KeyboardShortcuts.js';
import {
  openFeatureStore, isFeatureStoreOpen, closeFeatureStore, searchShortcutLabel, resetSidebarToEssentials,
} from './FeatureStoreModal.js';
import { showMobilePanel } from './MobileMenu.js';
import { CONTROL_INDEX } from './search/controlIndex.js';
import { structureEntries } from './search/structureEntries.js';
import { CONCEPTS, BEST_BETS, RESULT_LABELS } from './search/concepts.js';
import { setStructurePanelOpen } from './StructureInfoPanel/General.js';
import { scoreEntry, normalize, stem } from './search/fuzzy.js';
import {
  harvestWindow, findTabButton, revealAncestors, isShown, isActiveTab,
} from './search/controlHarvest.js';

const MAX_RESULTS = 60;
// Ranking nudges between result types at equal match quality: a window is
// usually what a bare feature name means, an action does what it says.
const TYPE_WEIGHT = { window: 1.15, structure: 1.1, action: 1.08, control: 1 };
// The hand-picked app actions (appActions) outrank a bare one-word control of
// the same name: "reset" should offer Reset to Essentials before the dozen
// buttons labelled just "Reset".
const CURATED_WEIGHT = 1.25;
const KIND_LABEL = {
  window: 'Panel', action: 'Action', button: 'Button', toggle: 'Toggle',
  slider: 'Slider', select: 'Choice', input: 'Field', tab: 'Tab', link: 'Link',
  section: 'Section', element: 'Element', atom: 'Atom', bond: 'Bond pair',
  polyhedron: 'Polyhedra', site: 'Site',
};

let overlay = null;
let inputEl = null;
let listEl = null;
let entries = [];
let results = [];
let activeIndex = 0;
let previousFocus = null;

// ---- entries ---------------------------------------------------------------

function nextFrames(n = 2) {
  return new Promise((resolve) => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

async function waitUntil(fn, timeoutMs = 1500) {
  const end = performance.now() + timeoutMs;
  while (!fn() && performance.now() < end) await nextFrames(1);
  return fn();
}

/** Resolve once a smooth scroll has carried `el` to rest (its position
 *  unchanged for a few frames), or after `timeoutMs`. */
async function scrollSettled(el, timeoutMs = 1200) {
  const end = performance.now() + timeoutMs;
  let last = null;
  let still = 0;
  while (performance.now() < end && still < 3) {
    await nextFrames(1);
    const r = el.getBoundingClientRect();
    const pos = `${Math.round(r.top)},${Math.round(r.left)}`;
    still = pos === last ? still + 1 : 0;
    last = pos;
  }
}

/** App-level actions that are not keyboard-shortcut commands. */
function appActions() {
  const click = (sel) => () => /** @type {HTMLElement|null} */ (document.querySelector(sel))?.click();
  return [
    { label: 'Add panels', path: 'Choose which panels sit in the sidebar', keywords: ['add windows', 'feature store', 'store', 'sidebar', 'windows', 'panels', 'customise', 'customize'], run: openFeatureStore },
    { label: 'Reset to Essentials', path: 'Sidebar · keeps only Features, Visual, Cell & Supercell (asks first)', keywords: ['reset sidebar', 'essentials', 'default windows', 'declutter', 'clean up', 'remove all'], run: resetSidebarToEssentials },
    { label: 'Light mode', path: 'Theme', keywords: ['theme', 'bright', 'day'], run: click('[data-theme-option="light"]') },
    { label: 'Dark mode', path: 'Theme', keywords: ['theme', 'night'], run: click('[data-theme-option="dark"]') },
    { label: 'Follow system theme', path: 'Theme', keywords: ['auto', 'theme', 'system'], run: click('[data-theme-option="auto"]') },
    { label: 'Colour palette', path: 'Theme', keywords: ['color', 'palette', 'theme'], run: click('#themeMenuToggle') },
    { label: 'About CrysViz', path: 'Help', keywords: ['version', 'help', 'license', 'credits'], run: click('#aboutTrigger') },
  ].map((a) => ({ ...a, type: 'action', curated: true }));
}

const controlKey = (panelId, e) => `${panelId}\u0000${e.label}\u0000${e.section || ''}\u0000${e.kind}`;

/** Everything searchable right now. Rebuilt on every open, so the badges and
 *  the live controls reflect the current sidebar and structure. */
function collectEntries() {
  const panels = listPanels();
  const panelById = new Map(panels.map((p) => [p.id, p]));
  const suggested = new Set(listStoreFeatures().filter((f) => f.suggested).map((f) => f.id));
  const commands = listShortcutCommands();
  const shortcutOfPanel = new Map(commands.filter((c) => c.panel && c.shortcut).map((c) => [c.panel, c.shortcut]));
  const out = [];

  for (const p of panels) {
    out.push({
      type: 'window', kind: 'window', label: p.title, panelId: p.id,
      path: p.store ? `Panel · ${p.store}` : 'Panel',
      keywords: p.keywords, shortcut: shortcutOfPanel.get(p.id) || '',
      suggested: suggested.has(p.id),
      // A closed window outside the store (EOS Fit, Phonon Plots, ...) opens
      // by itself once its feature has something to show — rank it below
      // that feature's own window.
      secondary: !p.store && p.closed,
    });
  }
  // Controls: live first (exact elements), then the generated list for
  // everything not on screen.
  const controls = [];
  const have = new Set();
  const pushControl = (panelId, e, el) => {
    const p = panelById.get(panelId);
    if (!p) return;
    const key = controlKey(panelId, e);
    if (have.has(key)) return;
    have.add(key);
    const renamed = e.id && RESULT_LABELS[e.id];
    controls.push({
      type: 'control', kind: e.kind, label: renamed || e.label, panelId,
      section: e.section || '', tabs: e.tabs || [], id: e.id || null, el: el || null,
      path: [p.title, ...(e.tabs || []), e.section].filter(Boolean).join(' › '),
      // The path carries the panel; its keywords would flood every control.
      keywords: renamed ? [e.label] : [], shortcut: '',
    });
  };
  for (const p of panels) {
    const panel = getPanel(p.id);
    if (!panel || panel.closed || !panel.built || panel.collapsed || !panel.el.isConnected) continue;
    for (const e of harvestWindow(panel.body)) pushControl(p.id, e, e.el);
  }
  for (const e of CONTROL_INDEX) pushControl(e.panel, e, null);

  // A command that opens a window or presses a control is that result, with
  // its shortcut; the rest are actions of their own.
  const controlById = new Map(controls.filter((c) => c.id).map((c) => [c.id, c]));
  for (const c of commands) {
    if (c.panel) continue; // the window result carries it
    const target = c.control && controlById.get(c.control);
    if (target) {
      target.shortcut = c.shortcut;
      if (c.label !== target.label) target.keywords = [...target.keywords, c.label];
      continue;
    }
    out.push({ type: 'action', kind: 'action', label: c.label, path: c.group, shortcut: c.shortcut, run: c.run, keywords: [] });
  }
  for (const a of appActions()) out.push({ ...a, kind: 'action' });
  out.push(...structureEntries({ revealStructure, land }));
  out.push(...controls);
  applyConcepts(out);
  return out;
}

/** Resolve a concept's target among the entries (null if it is gone). */
function conceptTarget(to, byPanel, byControl, byAction, byLabel, byStructure) {
  if (to.structure) return byStructure.get(to.structure) || null;
  if (to.panel && to.label) return byLabel.get(`${to.panel}\n${to.label}`) || null;
  if (to.panel) return byPanel.get(to.panel) || null;
  if (to.control) return byControl.get(to.control) || null;
  if (to.action) return byAction.get(to.action) || null;
  return null;
}

/** Give each vocabulary phrase (search/concepts.js) to the entry it names. */
function applyConcepts(list) {
  const maps = targetMaps(list);
  for (const concept of CONCEPTS) {
    const target = conceptTarget(concept.to, ...maps);
    if (target) target.aliases = [...(target.aliases || []), ...concept.phrases];
  }
}

/** Index the entries the vocabulary can point at. */
function targetMaps(list) {
  return [
    new Map(list.filter((e) => e.type === 'window').map((e) => [e.panelId, e])),
    new Map(list.filter((e) => e.type === 'control' && e.id).map((e) => [e.id, e])),
    new Map(list.filter((e) => e.type === 'action').map((e) => [e.label, e])),
    // Controls without an id, by window and label (the first of a name).
    new Map(list.filter((e) => e.type === 'control').reverse().map((e) => [`${e.panelId}\n${e.label}`, e])),
    // Structure results by key (the colour-dot results of search/structureEntries.js).
    new Map(list.filter((e) => e.type === 'structure' && e.key).map((e) => [e.key, e])),
  ];
}

/** Vocabulary and best-bet targets that no longer exist (a renamed control,
 *  a removed panel) — the searchindex browser test keeps this empty. */
export function unresolvedConcepts() {
  const maps = targetMaps(collectEntries());
  // Structure targets come and go with the loaded structure (no polyhedra,
  // no Poly dots), so only the app's own targets must always exist.
  const targets = [...CONCEPTS.map((c) => c.to), ...BEST_BETS.flatMap((b) => b.targets)].filter((to) => !to.structure);
  return targets.filter((to) => !conceptTarget(to, ...maps));
}

/** Word forms folded: "colours" and "color" both read "color". */
function stems(text) {
  return normalize(text).trim().split(/\s+/).map(stem).join(' ');
}

/** The best bets (search/concepts.js) for a query, in order: the query is a
 *  bet's word in any form, or — after those — its start while typed (four
 *  letters on: "atom" is "atom" before it is the start of "atom colour"). */
function bestBets(query, pool) {
  const q = normalize(query).trim().replace(/\s+/g, ' ');
  if (q.length < 3) return [];
  const qs = stems(q);
  const exact = BEST_BETS.filter((b) => b.words.some((w) => stems(w) === qs));
  const typed = BEST_BETS.filter((b) => !exact.includes(b)
    && q.length >= 4 && b.words.some((w) => normalize(w).startsWith(q)));
  const hits = [...exact, ...typed];
  if (!hits.length) return [];
  const maps = targetMaps(pool);
  const out = [];
  for (const to of hits.flatMap((b) => b.targets)) {
    const entry = conceptTarget(to, ...maps);
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function panelState(panelId) {
  const p = listPanels().find((x) => x.id === panelId);
  return p ? { inSidebar: p.inSidebar, available: p.available, title: p.title } : null;
}

// ---- matching ---------------------------------------------------------------

/** The default list for an empty query: the store's data hints first, then
 *  the windows, then the app actions. */
function defaultResults() {
  const windows = entries.filter((e) => e.type === 'window');
  const hinted = windows.filter((e) => e.suggested && !panelState(e.panelId)?.inSidebar);
  const rest = windows.filter((e) => !hinted.includes(e));
  const actions = entries.filter((e) => e.type === 'action' && !e.shortcut);
  return [...hinted, ...rest, ...actions].slice(0, MAX_RESULTS).map((entry) => ({ entry, positions: [], score: 0 }));
}

/**
 * Rank the entries for a query. Exported for the browser tests.
 * @returns {{ entry: any, positions: number[], score: number }[]}
 */
export function searchEntries(query, pool = entries) {
  if (!normalize(query).trim()) return defaultResults();
  const scored = [];
  for (const entry of pool) {
    const m = scoreEntry(query, entry);
    if (!m) continue;
    let score = m.score * (entry.curated ? CURATED_WEIGHT : (TYPE_WEIGHT[entry.type] || 1));
    if (entry.secondary) score *= 0.85;
    if (entry.el) score += 2; // on screen right now
    scored.push({ entry, positions: m.positions, score, alias: m.alias || null });
  }
  // Ties: the shorter label is the closer match ("Phonons" over "Phonon Plots").
  scored.sort((a, b) => b.score - a.score
    || a.entry.label.length - b.entry.label.length
    || a.entry.label.localeCompare(b.entry.label));
  // A broad word's best bets lead, in their own order; the rest follow.
  const bets = bestBets(query, pool);
  const lead = bets.map((entry) => scored.find((s) => s.entry === entry)
    || { entry, positions: [], score: 0, alias: null });
  return [...lead, ...scored.filter((s) => !bets.includes(s.entry))].slice(0, MAX_RESULTS);
}

// ---- rendering --------------------------------------------------------------

function highlighted(label, positions) {
  const frag = document.createDocumentFragment();
  const set = new Set(positions);
  let run = '';
  let marked = false;
  const flush = () => {
    if (!run) return;
    if (marked) {
      const m = document.createElement('mark');
      m.textContent = run;
      frag.appendChild(m);
    } else frag.appendChild(document.createTextNode(run));
    run = '';
  };
  [...label].forEach((ch, i) => {
    const isMark = set.has(i);
    if (isMark !== marked) { flush(); marked = isMark; }
    run += ch;
  });
  flush();
  return frag;
}

function badgeFor(entry) {
  if (!entry.panelId) return null;
  const st = panelState(entry.panelId);
  if (!st) return null;
  if (!st.inSidebar) {
    return { cls: 'feature-search-badge-store', text: 'Not in sidebar · ↵ adds it', title: `${st.title} is not in the sidebar — choosing this adds it to the sidebar` };
  }
  if (!st.available) {
    return { cls: 'feature-search-badge-unavailable', text: 'No data here', title: `${st.title} needs data the selected structure does not have` };
  }
  return null;
}

function render() {
  listEl.replaceChildren();
  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'feature-search-empty';
    li.textContent = 'Nothing found. Try another word, or open Add panels.';
    listEl.appendChild(li);
    inputEl.removeAttribute('aria-activedescendant');
    return;
  }
  results.forEach(({ entry, positions, alias }, i) => {
    const li = document.createElement('li');
    li.className = 'feature-search-result' + (i === activeIndex ? ' active' : '');
    li.id = `featureSearchResult-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
    li.dataset.index = String(i);
    li.dataset.type = entry.type;

    const kind = document.createElement('span');
    kind.className = 'feature-search-kind';
    kind.textContent = KIND_LABEL[entry.kind] || entry.kind;
    li.appendChild(kind);

    const text = document.createElement('div');
    text.className = 'feature-search-text';
    const label = document.createElement('div');
    label.className = 'feature-search-label';
    label.appendChild(highlighted(entry.label, positions));
    text.appendChild(label);
    if (entry.path || alias) {
      const path = document.createElement('div');
      path.className = 'feature-search-path';
      path.textContent = entry.path || '';
      if (alias) {
        // Why a result with none of the typed words showed up.
        const why = document.createElement('span');
        why.className = 'feature-search-alias';
        why.textContent = `${entry.path ? ' · ' : ''}≈ ${alias}`;
        path.appendChild(why);
      }
      text.appendChild(path);
    }
    li.appendChild(text);

    const badge = badgeFor(entry);
    if (badge) {
      const b = document.createElement('span');
      b.className = `feature-search-badge ${badge.cls}`;
      b.textContent = badge.text;
      b.title = badge.title;
      li.appendChild(b);
    } else if (entry.suggested && entry.type === 'window') {
      const b = document.createElement('span');
      b.className = 'feature-search-badge feature-search-badge-store';
      b.textContent = 'Has data';
      li.appendChild(b);
    }
    if (entry.shortcut) {
      const k = document.createElement('kbd');
      k.className = 'feature-search-kbd';
      k.textContent = entry.shortcut;
      li.appendChild(k);
    }
    listEl.appendChild(li);
  });
  inputEl.setAttribute('aria-activedescendant', `featureSearchResult-${activeIndex}`);
}

function setActive(i) {
  if (!results.length) return;
  activeIndex = (i + results.length) % results.length;
  for (const li of listEl.querySelectorAll('.feature-search-result')) {
    const on = Number(/** @type {HTMLElement} */ (li).dataset.index) === activeIndex;
    li.classList.toggle('active', on);
    li.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) li.scrollIntoView({ block: 'nearest' });
  }
  inputEl.setAttribute('aria-activedescendant', `featureSearchResult-${activeIndex}`);
}

function update() {
  results = searchEntries(inputEl.value);
  activeIndex = 0;
  render();
}

// ---- going there ------------------------------------------------------------

/** A docked window lives in the sidebar, which may be folded away (☰, or
 *  the phone's closed sheet) — show it first. */
function showSidebarFor(panel) {
  if (panel.el.closest('#ui')) showMobilePanel();
}

function focusWindow(panel) {
  showSidebarFor(panel);
  panel.raise();
  requestAnimationFrame(() => panel.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  flashPanel(panel);
}

/** Structure, View and Measure are the scene's own windows (the ones with a
 *  compact icon or a phone home). Their title bar is the user's — folded to
 *  a strip by default — and, like a keyboard shortcut (KeyboardShortcuts.js
 *  revealPanel), the search never restores it: it only unfolds the body when
 *  the target sits inside it. Side-docked (the phone's bottom sheet), a
 *  window has no title bar to protect and opens normally. */
function isSceneWindow(panel) {
  return !!(panel.def.compactIcon || panel.def.compactHome);
}

function openForSearch(panel, { body = false } = {}) {
  if (isSceneWindow(panel) && panel.dock !== 'right') {
    if (body && panel.collapsed) panel.expand();
    return;
  }
  openPanel(panel.id); // adds a store window to the sidebar
}

/** Bring the Structure window into view for a structure result. */
async function revealStructure() {
  const panel = getPanel('info');
  if (!panel || !panel.available) return false;
  openForSearch(panel, { body: true });
  panel.raise();
  return waitUntil(() => panel.built && !panel.collapsed);
}

/** Scroll a row into view, then flash it once it has arrived. */
/** @param {HTMLElement} el @param {{ className: string, ms: number }} [style] flash variant */
async function land(el, style) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await scrollSettled(el);
  flashElement(el, style);
}

/** Find a control's element in its window, by id or by label. */
function locateControl(panel, entry) {
  if (entry.el?.isConnected && panel.body.contains(entry.el)) return entry.el;
  if (entry.id) {
    const byId = document.getElementById(entry.id);
    if (byId && panel.body.contains(byId)) return byId;
  }
  const all = harvestWindow(panel.body, { includeHidden: true });
  const exact = all.filter((c) => c.label === entry.label && c.kind === entry.kind);
  const hit = exact.find((c) => c.section === entry.section && isShown(c.el))
    || exact.find((c) => c.section === entry.section)
    || exact.find((c) => isShown(c.el))
    || exact[0]
    || all.find((c) => c.label === entry.label);
  return hit ? hit.el : null;
}

/** Open a control's window (adding it from the store), select its tabs,
 *  unfold its disclosure, then scroll to it and flash it. Exported for the
 *  browser tests. Resolves to the element reached (null: only the window). */
export async function goToControl(entry) {
  const panel = getPanel(entry.panelId);
  if (!panel) return null;
  openForSearch(panel, { body: true });
  if (!(await waitUntil(() => panel.built && !panel.collapsed))) {
    focusWindow(panel); // unavailable for this structure: show the window at least
    return null;
  }
  for (const label of entry.tabs || []) {
    const btn = findTabButton(panel.body, label);
    if (!btn) continue;
    revealAncestors(btn, panel.body);
    if (!isActiveTab(btn)) {
      btn.click();
      await nextFrames(2);
    }
  }
  const el = locateControl(panel, entry);
  if (!el) {
    focusWindow(panel);
    return null;
  }
  revealAncestors(el, panel.body);
  showSidebarFor(panel);
  await nextFrames(2);
  panel.raise();
  // A checkbox/slider is drawn by its row; flash what the eye sees.
  const visible = el.closest('label.toggle_row, .toggle_row') || (isShown(el) ? el : el.closest('label')) || el;
  visible.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  // Flash once the control has arrived: a long smooth scroll outlasts the
  // half-second flash, which would otherwise be over before it is on screen.
  await scrollSettled(/** @type {HTMLElement} */ (visible));
  flashElement(/** @type {HTMLElement} */ (visible));
  return /** @type {HTMLElement} */ (el);
}

async function activate(i) {
  const hit = results[i];
  if (!hit) return;
  const { entry } = hit;
  closeFeatureSearch({ restoreFocus: entry.type === 'action' });
  if (entry.type === 'action') {
    entry.run();
  } else if (entry.type === 'structure') {
    await entry.run();
  } else if (entry.type === 'window') {
    const panel = getPanel(entry.panelId);
    if (!panel) return;
    openForSearch(panel, { body: true });
    // The Structure window's content is its formula box.
    if (entry.panelId === 'info') setStructurePanelOpen(true);
    focusWindow(panel);
  } else {
    await goToControl(entry);
  }
}

// ---- palette ------------------------------------------------------------------

function build() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'featureSearchOverlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="feature-search-palette" role="dialog" aria-modal="true" aria-label="Search panels and controls">
      <div class="feature-search-input-row">
        <svg class="feature-search-trigger-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15.5 15.5 21 21" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
        <input id="featureSearchInput" type="text" role="combobox" aria-expanded="true"
          aria-controls="featureSearchResults" aria-autocomplete="list"
          placeholder="Search panels, buttons, settings…" autocomplete="off" spellcheck="false">
      </div>
      <ul class="feature-search-results" id="featureSearchResults" role="listbox" aria-label="Results"></ul>
      <div class="feature-search-footer">
        <span><kbd class="feature-search-kbd">↑</kbd> <kbd class="feature-search-kbd">↓</kbd> choose</span>
        <span><kbd class="feature-search-kbd">↵</kbd> go there</span>
        <span><kbd class="feature-search-kbd">Esc</kbd> close</span>
        <span><kbd class="feature-search-kbd" id="featureSearchAgainKey"></kbd> again: the browser's find</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  inputEl = /** @type {HTMLInputElement} */ (overlay.querySelector('#featureSearchInput'));
  listEl = /** @type {HTMLElement} */ (overlay.querySelector('#featureSearchResults'));
  const again = overlay.querySelector('#featureSearchAgainKey');
  if (again) again.textContent = searchShortcutLabel();

  inputEl.addEventListener('input', update);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(activeIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFeatureSearch(); }
  });
  listEl.addEventListener('pointermove', (e) => {
    const li = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.feature-search-result'));
    if (li && Number(li.dataset.index) !== activeIndex) setActive(Number(li.dataset.index));
  });
  listEl.addEventListener('click', (e) => {
    const li = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.feature-search-result'));
    if (li) activate(Number(li.dataset.index));
  });
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeFeatureSearch(); });
}

/** Open the palette, optionally pre-filled. */
export function openFeatureSearch(query = '') {
  build();
  if (isFeatureStoreOpen()) closeFeatureStore();
  entries = collectEntries();
  if (overlay.hidden) previousFocus = document.activeElement;
  overlay.hidden = false;
  inputEl.value = query;
  update();
  inputEl.focus();
  inputEl.select();
}

export function closeFeatureSearch({ restoreFocus = true } = {}) {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  const target = /** @type {HTMLElement|null} */ (previousFocus);
  previousFocus = null;
  if (restoreFocus && target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

export function isFeatureSearchOpen() {
  return !!overlay && !overlay.hidden;
}

/** Wire Ctrl/Cmd+F and the sidebar search field. Full app only. */
export function initFeatureSearch() {
  const trigger = document.getElementById('featureSearchButton');
  if (trigger) trigger.addEventListener('click', () => openFeatureSearch());
  const key = document.getElementById('featureSearchButtonKey');
  if (key) key.textContent = searchShortcutLabel();

  // Capture phase, so a focused control's own keydown handling never sees it.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' && e.key.toLowerCase() !== 'f') return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing) return;
    // Pressed again while open: let the browser's find-in-page have it.
    if (isFeatureSearchOpen()) {
      closeFeatureSearch();
      return;
    }
    e.preventDefault();
    openFeatureSearch();
  }, true);
}
