// Control harvesting for the feature search (ui/FeatureSearch.js).
//
// Reads the labelled controls (buttons, toggles, sliders, selects, inputs)
// out of a window's body: what each is called, which section headline it sits
// under, and which in-window tabs have to be selected to see it. The SAME
// code serves both sides of the search's control list:
//
//   - live:      at palette open, every built window is harvested, so the
//                search sees exactly what is on screen now (including
//                controls that only exist for the loaded data);
//   - generated: tools/search_index/ opens every window in a real browser,
//                walks its tabs and writes the result to controlIndex.js —
//                the full list, covering windows the user has never opened
//                (their content is built lazily) or keeps in the store. The
//                searchindex browser test fails when that file is stale.
//
// Labels come from what the user reads: aria-label, the visually-hidden text
// of an icon button, the toggle/slider row's own text (minus its live value),
// the button text, then title/placeholder. Window chrome, info "i" buttons,
// per-row table controls and label-less glyph buttons are skipped — they are
// either everywhere or nameless.

const CONTROL_SELECTOR = [
  'button', 'select', 'textarea', 'summary',
  'input:not([type="hidden"])',
  '[role="button"]', '[role="tab"]', '[role="switch"]',
  // A file picker dressed as a button (its <input type=file> is hidden),
  // and the click-to-pick drop zones.
  'label:has(input[type="file"])', '[class*="drop-zone"]',
].join(',');

// Rows of buttons that switch which content a window shows. Clicking one is
// how the search (and the generator) reaches the controls behind it.
export const TAB_ROW_SELECTOR = [
  '.segmented-backend-control', '.segmented-control', '[role="tablist"]',
].join(',');

const HEADLINE_SELECTOR = [
  '.panel-headline', 'h2', 'h3', 'h4', 'h5', 'legend',
  '.cv-force-subheading', '.measure-settings-subhead',
].join(',');

// Never indexed: window chrome, info buttons, the per-row controls of tables
// (one per atom/file/bond pair — structure data, not features), the
// per-element toggle grids (Forces/Spins species), the Structure window's
// formula header (its text IS the formula) and its element, bond-pair,
// polyhedra and atom rows (their colour dots and toggles; the rows themselves
// are found as structure results, search/structureEntries.js), and anything a
// module marks with data-search-skip. Headlines inside these don't name
// sections either.
const SKIP_SELECTOR = [
  '.cv-panel-titlebar', '.info-button', 'tbody', '[data-search-skip]',
  '.cv-species-toggle-grid', '#structureToggle',
  '.comp-container', '.bond-control', '.poly-control', '.individual-atom-row',
].join(',');

const MAX_LABEL = 70;

function clean(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    // Live value readouts that share the label's text node ("Peel layers: 10").
    .replace(/:\s*[-+]?\d[\d.,]*\s*\S{0,3}$/u, '')
    // Leading/trailing glyphs: "📁 Upload", "▸ Coupling times", "Download ▾", "…ⓘ".
    .replace(/^[^\p{L}\p{N}(]+/u, '')
    .replace(/[^\p{L}\p{N})%]+$/u, '')
    .trim();
}

/** textContent, but with a space wherever an element or <br> starts, so
 *  two-sided toggles ("Perspective | Parallel") and wrapped labels read as
 *  separate words. */
function spacedText(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.textContent;
    else if (child.nodeType === 1) {
      out += child.nodeName === 'BR' ? ' ' : ` ${spacedText(child)} `;
    }
  }
  return out;
}

/** At least two letters: "▶", "×", "i", "0.40" are not names. */
function meaningful(text) {
  return (String(text).match(/\p{L}/gu) || []).length >= 2;
}

/** Text of an element without its form controls and live value readouts. */
function ownText(el) {
  const copy = /** @type {HTMLElement} */ (el.cloneNode(true));
  for (const n of copy.querySelectorAll('input, select, textarea, button, .slider-value, .visually-hidden, [aria-hidden="true"]')) n.remove();
  return clean(spacedText(copy));
}

/** What the user would call this control, or '' if it has no usable name. */
export function controlLabel(el) {
  const candidates = [];
  const aria = el.getAttribute('aria-label');
  if (aria) candidates.push(aria);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    candidates.push(t);
  }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const id = el.id;
    const forLabel = id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    if (forLabel) candidates.push(ownText(forLabel));
    const wrap = el.closest('label');
    if (wrap && !wrap.classList.contains('panel-headline')) {
      const toggleText = wrap.querySelector('.toggle_text');
      candidates.push(toggleText ? clean(toggleText.textContent) : ownText(wrap));
    }
    // A bare input right after its caption ("Scale" <input>).
    const prev = el.previousElementSibling;
    if (prev && (prev.tagName === 'SPAN' || prev.tagName === 'LABEL') && !prev.querySelector(CONTROL_SELECTOR)) {
      candidates.push(ownText(prev));
    }
  } else {
    const hidden = el.querySelector('.visually-hidden');
    if (hidden) candidates.push(hidden.textContent);
    // An icon-ish face ("x", "≡ A") says less than the tooltip.
    const face = ownText(el);
    if (face.length > 3 || !el.getAttribute('title')) candidates.push(face);
  }
  candidates.push(el.getAttribute('title') || '');
  candidates.push(el.getAttribute('placeholder') || '');
  for (const c of candidates) {
    const t = clean(c);
    if (meaningful(t)) return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
  }
  return '';
}

function controlKind(el) {
  const tag = el.tagName;
  if (tag === 'SELECT') return 'select';
  if (tag === 'TEXTAREA') return 'input';
  if (tag === 'INPUT') {
    const type = /** @type {HTMLInputElement} */ (el).type;
    if (type === 'checkbox' || type === 'radio') return 'toggle';
    if (type === 'range') return 'slider';
    if (type === 'button' || type === 'submit') return 'button';
    return 'input';
  }
  if (el.getAttribute('role') === 'switch') return 'toggle';
  if (el.getAttribute('role') === 'tab' || el.parentElement?.matches(TAB_ROW_SELECTOR)) return 'tab';
  if (tag === 'A') return 'link';
  if (tag === 'SUMMARY') return 'section';
  return 'button';
}

/** The section headline nearest above `el` inside `root` ('' if none). */
export function controlSection(el, root) {
  let node = el;
  while (node && node !== root) {
    let sib = node.previousElementSibling;
    while (sib) {
      if (!sib.matches(SKIP_SELECTOR)) {
        if (sib.matches(HEADLINE_SELECTOR)) return clean(sib.textContent);
        const inner = [...sib.querySelectorAll(HEADLINE_SELECTOR)].filter((h) => !h.closest(SKIP_SELECTOR));
        if (inner.length) return clean(inner[inner.length - 1].textContent);
      }
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

/** Rendered and not hidden by an ancestor (display:none, [hidden]). */
export function isShown(el) {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  return !!(el.offsetParent || el.getClientRects().length);
}

function eligible(el, root) {
  if (el.closest(SKIP_SELECTOR)) return false;
  // A control nested in another (a button inside a role=button row) is
  // reached through its parent.
  const parentControl = el.parentElement?.closest(CONTROL_SELECTOR);
  if (parentControl && root.contains(parentControl) && parentControl !== el) return false;
  return true;
}

/**
 * The labelled controls under `root` that are currently shown (or all of
 * them, `includeHidden`: used to find a control behind a closed disclosure).
 * @param {HTMLElement} root a window body (or any container)
 * @param {{ tabs?: string[], includeHidden?: boolean }} [ctx] tab labels
 *   selected to reach this state
 * @returns {{ label: string, section: string, kind: string, id?: string, tabs?: string[], el: HTMLElement }[]}
 */
export function harvestControls(root, ctx = {}) {
  const out = [];
  const seen = new Set();
  for (const node of root.querySelectorAll(CONTROL_SELECTOR)) {
    const el = /** @type {HTMLElement} */ (node);
    if (!eligible(el, root) || (!ctx.includeHidden && !isShown(el))) continue;
    const label = controlLabel(el);
    if (!label) continue;
    const section = controlSection(el, root);
    const kind = controlKind(el);
    const key = `${label}\u0000${section}\u0000${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { label, section, kind, el };
    // Ids from a per-instance counter (e.g. "...-3") are not stable across
    // builds; only plain ids are recorded.
    if (el.id && !/\d{2,}$/.test(el.id) && !/-\d+$/.test(el.id)) entry.id = el.id;
    if (ctx.tabs?.length) entry.tabs = [...ctx.tabs];
    out.push(entry);
  }
  return out;
}

/**
 * Popup menus a window opens ([aria-haspopup][aria-controls] → the menu): the
 * Files window's Download menu is portaled to <body> on first open, so it is
 * harvested as its own root, its items sectioned under the opener's label.
 */
export function popupMenus(body) {
  const out = [];
  for (const opener of body.querySelectorAll('[aria-haspopup][aria-controls]')) {
    if (opener.closest(SKIP_SELECTOR)) continue;
    const menu = document.getElementById(opener.getAttribute('aria-controls') || '');
    if (menu && !menu.contains(opener)) out.push({ opener: /** @type {HTMLElement} */ (opener), menu });
  }
  return out;
}

/** harvestControls over a window body plus its popup menus. */
export function harvestWindow(body, ctx = {}) {
  const menus = popupMenus(body);
  const inMenu = (el) => menus.some(({ menu }) => menu.contains(el));
  const out = harvestControls(body, ctx).filter((e) => !inMenu(e.el));
  for (const { opener, menu } of menus) {
    const section = controlLabel(opener);
    for (const e of harvestControls(menu, ctx)) out.push({ ...e, section });
  }
  return out;
}

/** Is this tab button the selected one? `.active` / aria-selected /
 *  aria-pressed, or — the Atomistic Relax/MD switch's convention — a class
 *  named after its own data-mode. */
export function isActiveTab(btn) {
  if (btn.classList.contains('active')) return true;
  if (btn.getAttribute('aria-selected') === 'true' || btn.getAttribute('aria-pressed') === 'true') return true;
  const mode = btn.dataset?.mode;
  return !!mode && btn.classList.contains(mode);
}

/** The tab rows shown under `root`, each as its buttons and the active one. */
export function tabRows(root) {
  const rows = [];
  for (const row of root.querySelectorAll(TAB_ROW_SELECTOR)) {
    if (!isShown(row) || row.closest(SKIP_SELECTOR)) continue;
    const buttons = /** @type {HTMLElement[]} */ ([...row.children].filter(
      (b) => b.matches('button, [role="tab"]') && !(/** @type {HTMLButtonElement} */ (b).disabled)));
    if (buttons.length < 2) continue;
    rows.push({ row, buttons, active: buttons.find(isActiveTab) || null });
  }
  return rows;
}

/** A tab button's label as recorded in an entry's `tabs` path. */
export function tabLabel(btn) {
  return controlLabel(btn) || clean(btn.textContent);
}

/** Find the tab button named `label` under `root` — preferring a row that
 *  is shown, but also inside a closed disclosure (revealAncestors opens it). */
export function findTabButton(root, label) {
  let hidden = null;
  for (const row of root.querySelectorAll(TAB_ROW_SELECTOR)) {
    if (row.closest(SKIP_SELECTOR)) continue;
    for (const b of row.children) {
      if (!b.matches('button, [role="tab"]') || tabLabel(/** @type {HTMLElement} */ (b)) !== label) continue;
      if (isShown(/** @type {HTMLElement} */ (b))) return /** @type {HTMLElement} */ (b);
      hidden = hidden || /** @type {HTMLElement} */ (b);
    }
  }
  return hidden;
}

/**
 * Make `el` visible inside its window: open the collapsible it sits in (an
 * [aria-controls] disclosure such as the Structure window's formula box, a
 * [hidden] menu with an aria-controls opener, a closed <details>). Tabs are
 * NOT handled here — they are selected by label from an entry's `tabs`.
 */
export function revealAncestors(el, root) {
  let node = el.parentElement;
  while (node && node !== root && node !== document.body) {
    if (node.tagName === 'DETAILS' && !(/** @type {HTMLDetailsElement} */ (node)).open) {
      /** @type {HTMLDetailsElement} */ (node).open = true;
    }
    const closed = node.hidden || node.getAttribute('aria-hidden') === 'true';
    if (closed && node.id) {
      const opener = /** @type {HTMLElement|null} */ (
        document.querySelector(`[aria-controls="${CSS.escape(node.id)}"]`));
      if (opener) opener.click();
    }
    node = node.parentElement;
  }
}
