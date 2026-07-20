// Global keyboard shortcuts, organized by how often each thing is used
// rather than by category — the more frequent an action, the fewer/easier
// its modifiers:
//
//   Shift+<key>              Camera alignment, measuring mode, Add Structure,
//                             help, next/prev structure & trajectory step.
//   Space+<key>               Structure panel (formula box + Atoms/Bonds/
//                             Polyhedra sub-tabs).
//   Shift+Space+<key>         Feature toggles (Show Atoms, Show Bonds, ...)
//                             + Add Atoms/Vacuum.
//   Shift+Alt+<key>           Everything else: opening a "window" panel
//                             (Files, Trajectory, Settings, ...) — the least
//                             frequent action, so it gets the clunkiest combo.
//
// Space is not a real modifier as far as the browser is concerned (no
// event.spaceKey the way there's event.shiftKey) — SPACE_HELD below is
// tracked by hand from its own keydown/keyup, with a blur/visibility-change
// safety net so a missed keyup (alt-tab while held, a dialog stealing focus)
// can't leave it stuck "on" forever. Four other places in the app used to
// treat Space as an activation key on custom (non-<button>) controls — the
// right-dock tab bar, the Structure panel's own formula-box toggle, the
// About-panel logo, and the volumetric-field color-box toggle — those now
// only respond to Enter; Space is reserved for this file globally. The theme
// menu's keyboard activation was dropped entirely (click-only) rather than
// kept on Enter, since a dropdown menu doesn't need it.
//
// Ctrl/Cmd are never used: on Windows/Linux, Ctrl+letter collides with
// well-established, largely non-overridable browser shortcuts (Ctrl+F/P/T/
// W/N, ...); on Mac, Cmd+letter is worse — several (Cmd+W/Q/T/N, ...) are
// intercepted by the OS/browser before a page's JS ever sees them. Alt is
// comparatively free of reserved letter combos on both platforms (Alt+Left/
// Right for history navigation is the one exception, and isn't used here).
//
// Shortcuts match on KeyboardEvent.code (the PHYSICAL key), not .key (the
// glyph the layout prints on it) — so a shortcut lands on the same finger
// position on a US, German (QWERTZ) or Swedish keyboard. TWO exceptions,
// both deliberate:
//   - Y and Z use .key (the character), not .code. Unlike every other
//     letter, Y/Z are the one pair whose PHYSICAL positions are swapped on a
//     German keyboard relative to US/Swedish — the German key labeled "Z"
//     reports code "KeyY" (it sits where US has Y), and vice versa. Camera
//     alignment needs the literal Y/Z axis letters to mean Y/Z on every
//     keyboard, which physical-position matching can't give here; character
//     matching can, since Shift+<letter> always produces the same uppercase
//     letter regardless of where it physically sits.
//   - "+" (Add Structure / Add Atoms) matches TWO physical codes, Equal
//     (US/UK: unshifted "=", shifted "+") and BracketRight (German and
//     Swedish/Nordic: "+" is its own dedicated, unshifted key there, in the
//     position US uses for "]"). Neither .code alone nor .key alone covers
//     both layouts correctly for a symbol key (Shift changes which
//     character a symbol key types, unlike letters), so this binds the two
//     known physical positions directly.
//
// Every binding is user-customizable (see the "editing" section below) —
// this file only defines the DEFAULTS; localStorage overrides win.
import { getPanel, openPanel } from './panels/PanelManager.js';
import { selectAdjacentStructure, selectAdjacentStep } from './FileBrowswerPanel.js';
import { setStructurePanelOpen } from './StructureInfoPanel/General.js';
import { setMeasureMode } from './MeasurementToolbar.js';

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// ---- Space held-state tracking -------------------------------------------

let spaceHeld = false;

/** Does this element respond to a native Space keypress on its own (a real
 *  <button>, a checkbox/radio, anything with role="button")? If so, don't
 *  preventDefault Space's own keydown — let it activate normally, even
 *  though we're also tracking it as a modifier for the NEXT key. */
function isSpaceActivatable(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'BUTTON') return true;
  if (tag === 'INPUT' && ['checkbox', 'radio', 'button', 'submit'].includes(el.type)) return true;
  return el.getAttribute?.('role') === 'button';
}

function initSpaceTracking() {
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || isEditableTarget(e.target)) return;
    spaceHeld = true;
    // Space's default action outside a text field is either "activate the
    // focused button" or "scroll the page" — only suppress the latter; a
    // focused button's own native Space-click still fires normally.
    if (!isSpaceActivatable(document.activeElement)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceHeld = false;
  });
  window.addEventListener('blur', () => { spaceHeld = false; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) spaceHeld = false;
  });
}

function isModifierOnlyCode(code) {
  return code === 'Space' || /^(Shift|Alt|Control|Meta)(Left|Right)?$/.test(code);
}

// ---- shared action helpers -------------------------------------------------

// Briefly outlines a just-focused panel in orange (the app's one existing
// "draw attention" color, also used by the collision-warning banner) so a
// panel that was already visible still confirms the keypress landed.
const FLASH_CLASS = 'cv-shortcut-flash';
const FLASH_MS = 500;

/** Same orange flash, generalized to any element — used on panels (via
 *  flashPanel below) and on plain buttons that don't otherwise show any
 *  reaction to being "clicked" by a shortcut (camera alignment, Add
 *  Structure/Atoms). */
function flashElement(el) {
  if (!el) return;
  el.classList.remove(FLASH_CLASS);
  void el.offsetWidth; // restart the animation if pressed again quickly
  el.classList.add(FLASH_CLASS);
  setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS);
}

function flashPanel(panel) {
  if (panel) flashElement(panel.el);
}

// Structure ('info'), Measure ('measure') and View ('view') never have their
// own title bar collapsed/expanded, or their "—" bar-shrink undone, by a
// shortcut — only raised/scrolled-to/flashed. Camera-alignment and measuring
// actions reveal Measure/View this way as a side effect; there's no longer a
// standalone "just open Measure/View" shortcut (see Windows tier below —
// their content already has direct action shortcuts, so a generic opener
// would be redundant). The one exception: a panel dragged into the right
// dock has no individual title bar at all (front-tab selection replaces
// it), so that case still goes through openPanel().
function revealPanel(id) {
  const panel = getPanel(id);
  if (!panel || !panel.available) return false;
  if (panel.dock === 'right') openPanel(id);
  panel.raise();
  // A freshly-raised panel may need a layout pass before its final position
  // is known (e.g. the grow-upward-near-the-bottom-edge rule), so the scroll
  // can't run in the same frame.
  requestAnimationFrame(() => panel.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  flashPanel(panel);
  return true;
}

/** Open+focus a panel — building deferred content, un-collapsing its dock/
 *  bar if needed. Used by the Windows tier (everything except Structure/
 *  Measure/View, which use revealPanel() and never touch collapse state). */
function focusPanel(id) {
  const panel = getPanel(id);
  if (!panel || !panel.available) return false;
  openPanel(id);
  panel.raise();
  requestAnimationFrame(() => panel.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  flashPanel(panel);
  return true;
}

/** Is the Structure panel's +/- "formula box" open? That inner accordion
 *  (General.js's setStructurePanelOpen) is what actually shows the Atoms/
 *  Bonds/Polyhedra content — distinct from the panel WINDOW's own title-bar
 *  collapse state, which this file never touches (see revealPanel()). */
function isStructureBoxOpen() {
  return !!document.getElementById('composition')?.classList.contains('open');
}

/** Bring the Structure panel into view (revealPanel()) and open its formula
 *  box. */
function revealStructurePanel() {
  if (!revealPanel('info')) return false;
  setStructurePanelOpen(true);
  return true;
}

function toggleStructurePanel() {
  if (isStructureBoxOpen()) {
    setStructurePanelOpen(false);
    return true;
  }
  return revealStructurePanel();
}

/** Open the formula box on the given Atoms/Bonds/Polyhedra sub-tab
 *  (General.js's #atomBondControlSwitch) — or, if it's already open on that
 *  EXACT tab, close it (switching to a different tab never closes it, only
 *  re-pressing the same one does). No-op on the tab switch (box still
 *  opens) if that mode's button isn't present — e.g. the Atoms tab is
 *  replaced by Wyckoff for a symmetry-generated structure. */
function focusStructureTab(mode) {
  const btn = document.querySelector(`#atomBondControlSwitch button[data-mode="${mode}"]`);
  const alreadyThisTab = btn?.classList.contains('active');
  if (isStructureBoxOpen() && alreadyThisTab) {
    setStructurePanelOpen(false);
    return true;
  }
  if (!revealStructurePanel()) return false;
  btn?.click();
  requestAnimationFrame(() => btn?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  return true;
}

/** Flip a Features-panel checkbox and fire the same 'change' event a click
 *  would — reuses whatever listeners are already wired (scene update, panel
 *  grey/reveal), no direct dependency on any panel's internals. Works even
 *  while the Features panel itself is collapsed: its checkboxes are adopted
 *  into the DOM once at startup, independent of the panel's expand state. */
function toggleFeature(id) {
  const cb = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
  if (!cb || cb.disabled) return false;
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/** Pick a Measure mode and bring the Measure panel into view (revealPanel()
 *  — never touches its collapse state). */
function selectMeasureMode(mode, btnId) {
  setMeasureMode(mode, document.getElementById(btnId));
  revealPanel('measure');
}

/** Click a static button (camera alignment, Add Structure/Atoms) — flashes
 *  the button itself (so it visibly reacts to being "pressed" via keyboard,
 *  same as a real click would draw the eye) and, if given, whichever panel
 *  it lives in or opens. */
function clickButton(selector, panelId) {
  const btn = document.querySelector(selector);
  if (!btn) return false;
  btn.click();
  flashElement(btn);
  if (panelId) flashPanel(getPanel(panelId));
  return true;
}

// ---- command registry -------------------------------------------------------
//
// One flat list. Each command's `default` binding is {code|key|codes, shift,
// space, alt} (see the file header for why Y/Z use `key` and "+" uses
// `codes`). `tier` is a display-only label (which of the four modifier
// combos a command's DEFAULT belongs to); `group` further subdivides a
// tier's column in the help/editor UI (e.g. Shift's column has Camera,
// Measuring, Navigation, Other groups). The help UI renders commands in the
// order they're listed here — grouped by function, not alphabetized — so
// this array's order IS the display order; keep related commands adjacent.
// Customizing a binding can move it to any modifier combo, independent of
// its original tier/group.
const TIER = {
  SHIFT: { shift: true, space: false, alt: false, label: 'Shift' },
  SPACE: { shift: false, space: true, alt: false, label: 'Space' },
  SHIFT_SPACE: { shift: true, space: true, alt: false, label: 'Shift+Space' },
  SHIFT_ALT: { shift: true, space: false, alt: true, label: 'Shift+Alt' },
};

function bind(tier, extra) {
  return { shift: tier.shift, space: tier.space, alt: tier.alt, ...extra };
}

const COMMANDS = [
  // -- Shift: camera alignment, navigation, help ------------------------------
  { id: 'view-x', label: 'View X axis', tier: 'SHIFT', group: 'Camera', action: () => clickButton('#viewX'), default: bind(TIER.SHIFT, { code: 'KeyX' }) },
  { id: 'view-y', label: 'View Y axis', tier: 'SHIFT', group: 'Camera', action: () => clickButton('#viewY'), default: bind(TIER.SHIFT, { key: 'y' }) },
  { id: 'view-z', label: 'View Z axis', tier: 'SHIFT', group: 'Camera', action: () => clickButton('#viewZ'), default: bind(TIER.SHIFT, { key: 'z' }) },
  { id: 'view-a', label: 'View lattice a', tier: 'SHIFT', group: 'Camera', action: () => clickButton('#viewA'), default: bind(TIER.SHIFT, { code: 'KeyA' }) },
  { id: 'view-b', label: 'View lattice b', tier: 'SHIFT', group: 'Camera', action: () => clickButton('#viewB'), default: bind(TIER.SHIFT, { code: 'KeyB' }) },
  { id: 'view-c', label: 'View lattice c', tier: 'SHIFT', group: 'Camera', action: () => clickButton('#viewC'), default: bind(TIER.SHIFT, { code: 'KeyC' }) },
  { id: 'reset-view', label: 'Reset camera view', tier: 'SHIFT', group: 'Camera', action: () => clickButton('#resetView'), default: bind(TIER.SHIFT, { code: 'KeyR' }) },
  { id: 'next-structure', label: 'Next structure', tier: 'SHIFT', group: 'Navigation', action: () => selectAdjacentStructure(1), default: bind(TIER.SHIFT, { code: 'ArrowUp' }) },
  { id: 'prev-structure', label: 'Previous structure', tier: 'SHIFT', group: 'Navigation', action: () => selectAdjacentStructure(-1), default: bind(TIER.SHIFT, { code: 'ArrowDown' }) },
  { id: 'next-step', label: 'Next step', tier: 'SHIFT', group: 'Navigation', action: () => selectAdjacentStep(1), default: bind(TIER.SHIFT, { code: 'ArrowRight' }) },
  { id: 'prev-step', label: 'Previous step', tier: 'SHIFT', group: 'Navigation', action: () => selectAdjacentStep(-1), default: bind(TIER.SHIFT, { code: 'ArrowLeft' }) },
  { id: 'add-structure', label: 'Add Structure', tier: 'SHIFT', group: 'Other', action: () => clickButton('.add-structure-button', 'addStructure'), default: bind(TIER.SHIFT, { codes: ['Equal', 'BracketRight'] }) },
  { id: 'help', label: 'Show this help', tier: 'SHIFT', group: 'Other', action: () => openShortcutsHelp(), default: bind(TIER.SHIFT, { code: 'KeyH' }) },

  // -- Space: Structure panel + measuring --------------------------------------
  { id: 'structure-panel', label: 'Structure: toggle formula box', tier: 'SPACE', group: 'Structure', action: () => toggleStructurePanel(), default: bind(TIER.SPACE, { code: 'KeyS' }) },
  { id: 'structure-atoms', label: 'Structure: Atoms', tier: 'SPACE', group: 'Structure', action: () => focusStructureTab('atoms'), default: bind(TIER.SPACE, { code: 'KeyA' }) },
  { id: 'structure-bonds', label: 'Structure: Bonds', tier: 'SPACE', group: 'Structure', action: () => focusStructureTab('bonds'), default: bind(TIER.SPACE, { code: 'KeyB' }) },
  { id: 'structure-poly', label: 'Structure: Polyhedra', tier: 'SPACE', group: 'Structure', action: () => focusStructureTab('polyhedra'), default: bind(TIER.SPACE, { code: 'KeyP' }) },
  { id: 'distance-mode', label: 'Distance mode', tier: 'SPACE', group: 'Measuring', action: () => selectMeasureMode('distance', 'distanceModeBtn'), default: bind(TIER.SPACE, { code: 'KeyD' }) },
  { id: 'angle-mode', label: 'Angle mode', tier: 'SPACE', group: 'Measuring', action: () => selectMeasureMode('angle', 'angleModeBtn'), default: bind(TIER.SPACE, { code: 'KeyG' }) },

  // -- Shift+Space: Feature toggles --------------------------------------------
  { id: 'toggle-atoms', label: 'Show Atoms', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('showAtoms'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyA' }) },
  { id: 'toggle-bonds', label: 'Show Bonds', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('showBonds'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyB' }) },
  { id: 'toggle-neighbour', label: 'Neighbour Bonds', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('PBCBondToggle'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyN' }) },
  { id: 'toggle-forces', label: 'Show Forces', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('showForcesToggle'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyF' }) },
  { id: 'toggle-spins', label: 'Show Spins', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('showSpinsToggle'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyS' }) },
  { id: 'toggle-polyhedra', label: 'Show Polyhedra', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('showPolyhedra'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyP' }) },
  { id: 'toggle-complete-polyhedra', label: 'Complete Polyhedra', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('completePolyhedraToggle'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyC' }) },
  { id: 'toggle-field', label: 'Show Volumetric Field', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('showFieldToggle'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyD' }) },
  { id: 'toggle-planes', label: 'Show Planes', tier: 'SHIFT_SPACE', group: 'Toggles', action: () => toggleFeature('showPlanesMasterToggle'), default: bind(TIER.SHIFT_SPACE, { code: 'KeyL' }) },
  { id: 'add-atoms-vacuum', label: 'Add Atoms / Vacuum', tier: 'SHIFT_SPACE', group: 'Other', action: () => clickButton('#addButton', 'addAtomsVacuum'), default: bind(TIER.SHIFT_SPACE, { codes: ['Equal', 'BracketRight'] }) },

  // -- Shift+Alt: Windows -------------------------------------------------------
  { id: 'panel-files', label: 'Files', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('files'), default: bind(TIER.SHIFT_ALT, { code: 'KeyF' }) },
  { id: 'panel-features', label: 'Features', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('features'), default: bind(TIER.SHIFT_ALT, { code: 'KeyU' }) },
  { id: 'panel-trajectory', label: 'Trajectory', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('trajectory'), default: bind(TIER.SHIFT_ALT, { code: 'KeyT' }) },
  { id: 'panel-comparison', label: 'Comparison', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('comparison'), default: bind(TIER.SHIFT_ALT, { code: 'KeyC' }) },
  { id: 'panel-forces', label: 'Forces', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('forces'), default: bind(TIER.SHIFT_ALT, { code: 'KeyR' }) },
  { id: 'panel-spins', label: 'Spins', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('spins'), default: bind(TIER.SHIFT_ALT, { code: 'KeyN' }) },
  { id: 'panel-field', label: 'Volumetric Field', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('field'), default: bind(TIER.SHIFT_ALT, { code: 'KeyD' }) },
  { id: 'panel-planes', label: 'Crystal Planes', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('planes'), default: bind(TIER.SHIFT_ALT, { code: 'KeyL' }) },
  { id: 'panel-cell', label: 'Cell & Supercell', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('cell'), default: bind(TIER.SHIFT_ALT, { code: 'KeyX' }) },
  { id: 'panel-symmetry', label: 'Symmetry', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('symmetry'), default: bind(TIER.SHIFT_ALT, { code: 'KeyK' }) },
  { id: 'panel-visual', label: 'Visual', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('visual'), default: bind(TIER.SHIFT_ALT, { code: 'KeyI' }) },
  { id: 'panel-eos', label: 'EOS Fitting', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('eos'), default: bind(TIER.SHIFT_ALT, { code: 'KeyE' }) },
  { id: 'panel-landscape', label: 'Energy Landscape', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('landscape'), default: bind(TIER.SHIFT_ALT, { code: 'KeyQ' }) },
  { id: 'panel-custom-settings', label: 'Custom User Settings', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('customSettings'), default: bind(TIER.SHIFT_ALT, { code: 'KeyJ' }) },
  { id: 'panel-settings', label: 'Settings', tier: 'SHIFT_ALT', group: 'Windows', action: () => focusPanel('settings'), default: bind(TIER.SHIFT_ALT, { code: 'KeyG' }) },
];

// ---- user overrides (editable bindings) ------------------------------------

const OVERRIDES_KEY = 'keyboardShortcutOverrides';
const UNBOUND = 'NONE'; // override value meaning "user cleared this shortcut" (JSON-friendly, unlike null)
/** @type {Record<string, {code?:string, codes?:string[], key?:string, shift:boolean, space:boolean, alt:boolean}|'NONE'>} */
let overrides = {};

function loadOverrides() {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    overrides = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    overrides = {};
  }
}

function saveOverrides() {
  try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides)); } catch { /* storage unavailable */ }
}

/** The binding actually in effect for a command: its override (`null` if the
 *  user explicitly cleared it — stored as the string "NONE" so it round-trips
 *  through JSON export/import), else its default. */
function activeBinding(cmd) {
  if (!(cmd.id in overrides)) return cmd.default;
  const override = overrides[cmd.id];
  return override === UNBOUND ? null : override;
}

function bindingMatches(binding, event, currentSpaceHeld) {
  if (!binding) return false;
  if (!!event.shiftKey !== !!binding.shift) return false;
  if (!!event.altKey !== !!binding.alt) return false;
  if (!!currentSpaceHeld !== !!binding.space) return false;
  if (binding.key) return event.key.toLowerCase() === binding.key.toLowerCase();
  if (binding.codes) return binding.codes.includes(event.code);
  return event.code === binding.code;
}

function bindingsEqual(a, b) {
  if (!a || !b) return false;
  if (!!a.shift !== !!b.shift || !!a.alt !== !!b.alt || !!a.space !== !!b.space) return false;
  if (a.key || b.key) return (a.key || '').toLowerCase() === (b.key || '').toLowerCase();
  if (a.codes || b.codes) {
    const ac = a.codes || [a.code];
    const bc = b.codes || [b.code];
    return ac.some((c) => bc.includes(c));
  }
  return a.code === b.code;
}

// ---- label formatting -------------------------------------------------------

// macOS shows shortcuts as modifier glyphs (⇧⌥X) rather than words — the
// platform's own convention (menu bars, every native and most web app).
// Windows/Linux have no equivalent single-glyph-per-modifier convention, so
// they keep the spelled-out "Shift+Alt+X" form. Space has no standard glyph
// on either platform, so it's always spelled out.
const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const ARROW_SYMBOLS = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓' };

function keyPartOf(binding) {
  if (binding.key) return binding.key.toUpperCase();
  if (binding.codes) return '+';
  return ARROW_SYMBOLS[binding.code] || (binding.code?.startsWith('Key') ? binding.code.slice(3) : binding.code || '?');
}

/** The ordered list of tokens making up a binding's label, e.g.
 *  ['Shift', 'Space', 'X'] — modifiers first (in a fixed order), then
 *  whatever key it's bound to (which may itself be the literal "+", for
 *  Add Structure/Atoms — that's a token like any other, not a separator). */
function bindingTokens(binding) {
  const mods = IS_MAC
    ? [binding.shift && '⇧', binding.space && 'Space', binding.alt && '⌥']
    : [binding.shift && 'Shift', binding.space && 'Space', binding.alt && 'Alt'];
  return [...mods.filter(Boolean), keyPartOf(binding)];
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** The key button's inner markup: each token (modifier names, the actual
 *  key) in its own span, joined by explicitly-spaced "+" separators styled
 *  in a dimmer grey so they read as punctuation rather than part of the
 *  label — distinct from an actual "+" key token (e.g. Add Structure's
 *  Shift + +), which stays full-brightness like any other token. An unbound
 *  command (cleared via the row's × button) renders as a dim "None" instead. */
function bindingKeyHtml(binding) {
  if (!binding) return '<span class="shortcuts-help-key-empty">None</span>';
  const tokens = bindingTokens(binding);
  const inner = tokens
    .map((t) => `<span class="shortcuts-help-key-token">${escapeHtml(t)}</span>`)
    .join('<span class="shortcuts-help-key-sep">+</span>');
  return `<span class="shortcuts-help-key-tokens">${inner}</span>`;
}

// ---- dispatch ---------------------------------------------------------------

export function initKeyboardShortcuts() {
  loadOverrides();
  initSpaceTracking();
  addHelpTriggerButton();

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey) return;
    if (event.repeat || event.isComposing) return;
    if (isEditableTarget(event.target)) return;
    if (isModifierOnlyCode(event.code)) return;
    if (recordingCommand) return; // the help modal's rebind capture handles this keydown instead

    for (const cmd of COMMANDS) {
      const binding = activeBinding(cmd);
      if (binding && bindingMatches(binding, event, spaceHeld)) {
        event.preventDefault();
        cmd.action();
        return;
      }
    }
  });
}

// ---- help / editor modal ---------------------------------------------------

let helpModal = null;
let helpPreviousFocus = null;
let recordingCommand = null; // command currently capturing a new keypress, if any

/** Commands for one tier, split into { group, commands } chunks in COMMANDS'
 *  own definition order (function-grouped, not alphabetized — consecutive
 *  commands sharing a `group` become one sub-section). */
function tierSections(tierKey) {
  const sections = [];
  for (const cmd of COMMANDS) {
    if (cmd.tier !== tierKey) continue;
    const last = sections[sections.length - 1];
    if (last && last.group === cmd.group) last.commands.push(cmd);
    else sections.push({ group: cmd.group, commands: [cmd] });
  }
  return sections;
}

function rowHtml(cmd) {
  const binding = activeBinding(cmd);
  return `<tr class="shortcuts-help-row">
    <td class="shortcuts-help-clear-cell">
      <button type="button" class="shortcuts-help-clear" data-cmd-id="${cmd.id}" title="Clear this shortcut"${binding ? '' : ' disabled'}>×</button>
    </td>
    <td class="shortcuts-help-key-cell">
      <button type="button" class="shortcuts-help-key" data-cmd-id="${cmd.id}" title="Click to change this shortcut">${bindingKeyHtml(binding)}</button>
    </td>
    <td class="shortcuts-help-desc-cell">${escapeHtml(cmd.label)}</td>
  </tr>`;
}

function sectionHtml(section) {
  return `<tr class="shortcuts-help-group-row"><th colspan="3">${escapeHtml(section.group)}</th></tr>
    ${section.commands.map(rowHtml).join('')}`;
}

function columnsHtml() {
  return Object.entries(TIER).map(([key, tier]) => `
    <div class="shortcuts-help-column">
      <h4>${tier.label}</h4>
      <div class="shortcuts-help-list"><table class="shortcuts-help-table"><tbody>${tierSections(key).map(sectionHtml).join('')}</tbody></table></div>
    </div>
  `).join('');
}

function refreshHelpModal() {
  const columns = helpModal?.querySelector('.shortcuts-help-columns');
  if (columns) columns.innerHTML = columnsHtml();
  wireKeyButtons();
}

function wireKeyButtons() {
  helpModal?.querySelectorAll('.shortcuts-help-key').forEach((btn) => {
    btn.addEventListener('click', () => startRecording(btn.dataset.cmdId, btn));
  });
  helpModal?.querySelectorAll('.shortcuts-help-clear').forEach((btn) => {
    btn.addEventListener('click', () => clearBinding(btn.dataset.cmdId));
  });
}

/** Explicitly unbind a command (the row's × button) — stored as "NONE" so
 *  the dispatch loop's `if (binding && ...)` skips it and it round-trips
 *  through JSON as a plain string instead of null. A no-op while a rebind
 *  capture is in progress elsewhere, same guard as startRecording itself. */
function clearBinding(cmdId) {
  if (recordingCommand) return;
  overrides[cmdId] = UNBOUND;
  saveOverrides();
  refreshHelpModal();
}

const CONFLICT_MS = 1600;

/** Enter "press a key" capture mode for one command's binding. A single
 *  window-level keydown listener (capture phase, so it runs before — and
 *  suppresses — the normal dispatch listener above) grabs the next
 *  non-modifier-only key and builds a binding from it. If that combo is
 *  already used by another command, the rebind is REJECTED (not silently
 *  reassigned) — the button flashes red and shows what's already using it,
 *  then reverts; the user has to either pick a different combo or go clear
 *  the other command's binding first. Escape cancels without changing
 *  anything. */
/** Re-render a key button from the command's CURRENT active binding — used
 *  instead of caching/restoring a snapshot of the button's previous label,
 *  so cancel/conflict reverts always show the real state (styled tokens and
 *  all) rather than a stale plain-text copy. */
function renderKeyButton(btn, cmd) {
  btn.innerHTML = bindingKeyHtml(activeBinding(cmd));
  btn.title = 'Click to change this shortcut';
}

function startRecording(cmdId, btn) {
  const cmd = COMMANDS.find((c) => c.id === cmdId);
  if (!cmd || recordingCommand) return;
  recordingCommand = cmd;
  btn.textContent = 'Press a key…';
  btn.classList.add('shortcuts-help-key-recording');

  const finish = () => {
    recordingCommand = null;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
  };

  const cancel = () => {
    renderKeyButton(btn, cmd);
    btn.classList.remove('shortcuts-help-key-recording');
    finish();
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (isModifierOnlyCode(event.code)) return; // keep waiting for a real key
    event.preventDefault();
    event.stopPropagation();

    const newBinding = {
      shift: event.shiftKey,
      alt: event.altKey,
      space: spaceHeld,
      ...(event.code === 'KeyY' || event.code === 'KeyZ' ? { key: event.key } : { code: event.code }),
    };

    const conflict = COMMANDS.find((c) => c.id !== cmd.id && bindingsEqual(activeBinding(c), newBinding));
    if (conflict) {
      // Kept short so it never needs mid-word truncation — the full
      // "used by X" detail is a hover tooltip instead.
      btn.textContent = 'Already used';
      btn.title = `Already used by "${conflict.label}"`;
      btn.classList.remove('shortcuts-help-key-recording');
      btn.classList.add('shortcuts-help-key-conflict');
      finish();
      setTimeout(() => {
        btn.classList.remove('shortcuts-help-key-conflict');
        renderKeyButton(btn, cmd);
      }, CONFLICT_MS);
      return;
    }

    overrides[cmd.id] = newBinding;
    saveOverrides();
    finish();
    refreshHelpModal();
  };

  // A click elsewhere also cancels the capture, so it can't get stuck armed.
  const onPointerDown = (event) => {
    if (event.target === btn) return;
    cancel();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('pointerdown', onPointerDown, true);
}

/** Restore every shortcut to its built-in default. Called only after the
 *  user confirms via confirmResetAllShortcuts() below — never directly, since
 *  it's a one-click way to lose every customization at once. */
function resetAllShortcuts() {
  overrides = {};
  saveOverrides();
  refreshHelpModal();
}

// ---- reset confirmation modal ----------------------------------------------
//
// Built once (lazily), same "png-export-modal" / "paste-modal-actions"
// convention as the other confirm-style modals in the app (e.g.
// RaytraceWarningModal.js) so it matches their look without pulling in a
// generic dialog abstraction for what is currently a single use.

let resetConfirmModal = null;
let resetConfirmPreviousFocus = null;

function buildResetConfirmModal() {
  if (resetConfirmModal) return resetConfirmModal;
  resetConfirmModal = document.createElement('div');
  resetConfirmModal.id = 'shortcutsResetConfirmModal';
  resetConfirmModal.hidden = true;
  resetConfirmModal.innerHTML = `
    <div class="shortcuts-reset-confirm-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="shortcutsResetConfirmTitle">
      <h3 id="shortcutsResetConfirmTitle">Reset all keyboard shortcuts?</h3>
      <p>This restores every shortcut to its default key combo and discards all of your customizations. This can't be undone.</p>
      <div class="paste-modal-actions">
        <button type="button" id="shortcutsResetConfirmOk">Reset</button>
        <button type="button" id="shortcutsResetConfirmCancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(resetConfirmModal);

  const close = () => {
    if (!resetConfirmModal || resetConfirmModal.hidden) return;
    resetConfirmModal.hidden = true;
    const target = resetConfirmPreviousFocus;
    resetConfirmPreviousFocus = null;
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  };

  document.getElementById('shortcutsResetConfirmOk').addEventListener('click', () => {
    close();
    resetAllShortcuts();
  });
  document.getElementById('shortcutsResetConfirmCancel').addEventListener('click', close);
  resetConfirmModal.addEventListener('click', (e) => { if (e.target === resetConfirmModal) close(); });
  resetConfirmModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  return resetConfirmModal;
}

/** Ask for confirmation, then reset every shortcut to its default if
 *  confirmed. Exposed for the Custom User Settings panel. */
export function confirmResetAllShortcuts() {
  const modal = buildResetConfirmModal();
  resetConfirmPreviousFocus = document.activeElement;
  modal.hidden = false;
  const okBtn = document.getElementById('shortcutsResetConfirmOk');
  setTimeout(() => okBtn?.focus({ preventScroll: true }), 0);
}

/** A shallow copy of the current overrides — keyed by command id, values
 *  are either a binding object or the string "NONE" for an explicitly
 *  cleared shortcut. Embedded under the combined Custom User Settings JSON's
 *  own "shortcuts" key (see CustomUserSettingsPanel.js) rather than saved as
 *  a separate file. */
export function getShortcutOverrides() {
  return { ...overrides };
}

/** Replace the current overrides with a parsed "shortcuts" sub-object from
 *  the combined Custom User Settings JSON. A no-op if that key isn't an
 *  object, so a settings file from before this existed still loads fine. */
export function applyShortcutOverrides(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  overrides = parsed;
  saveOverrides();
  refreshHelpModal();
}

function buildHelpModal() {
  if (helpModal) return helpModal;

  helpModal = document.createElement('div');
  helpModal.id = 'shortcutsHelpModal';
  helpModal.hidden = true;
  helpModal.innerHTML = `
    <div class="shortcuts-help-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="shortcutsHelpTitle">
      <div class="shortcuts-help-title-row">
        <h3 id="shortcutsHelpTitle">Keyboard Shortcuts</h3>
        <button type="button" id="shortcutsHelpInfoToggle" class="shortcuts-help-info-btn" aria-expanded="false" aria-controls="shortcutsHelpNote" title="About these shortcuts">i</button>
      </div>
      <p class="shortcuts-help-note" id="shortcutsHelpNote" hidden>Click any shortcut to rebind it — press the new key combo, or Escape to cancel. A combo already used elsewhere is rejected, not reassigned; use × to clear a shortcut entirely. Space is held like a modifier (not a real one the browser reports, so it's tracked manually). Keys match the physical key position on US, German and Swedish keyboards, except Y/Z (character-matched — German swaps their physical position) and "+" (matches both the US Equal key and the German/Nordic dedicated + key). Your customized bindings are saved automatically and included in the Custom User Settings panel's combined settings JSON, which also has a Reset to Defaults button.</p>
      <div class="shortcuts-help-columns">${columnsHtml()}</div>
      <div class="paste-modal-actions shortcuts-help-actions">
        <button type="button" id="shortcutsHelpReset">Reset to Defaults</button>
        <button type="button" id="shortcutsHelpClose">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(helpModal);

  document.getElementById('shortcutsHelpReset').addEventListener('click', confirmResetAllShortcuts);
  document.getElementById('shortcutsHelpClose').addEventListener('click', closeShortcutsHelp);
  document.getElementById('shortcutsHelpInfoToggle').addEventListener('click', () => {
    const note = document.getElementById('shortcutsHelpNote');
    const btn = document.getElementById('shortcutsHelpInfoToggle');
    note.hidden = !note.hidden;
    btn.setAttribute('aria-expanded', String(!note.hidden));
  });
  helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeShortcutsHelp(); });
  helpModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !recordingCommand) closeShortcutsHelp();
  });

  wireKeyButtons();
  return helpModal;
}

export function openShortcutsHelp() {
  const modal = buildHelpModal();
  helpPreviousFocus = document.activeElement;
  modal.hidden = false;
  // Collapsed by default each time the modal opens, so it doesn't push the
  // shortcut table down before the user's asked for it.
  const note = document.getElementById('shortcutsHelpNote');
  const infoBtn = document.getElementById('shortcutsHelpInfoToggle');
  if (note) note.hidden = true;
  if (infoBtn) infoBtn.setAttribute('aria-expanded', 'false');
  const closeBtn = document.getElementById('shortcutsHelpClose');
  setTimeout(() => closeBtn?.focus({ preventScroll: true }), 0);
}

export function closeShortcutsHelp() {
  if (!helpModal || helpModal.hidden) return;
  helpModal.hidden = true;
  const target = helpPreviousFocus;
  helpPreviousFocus = null;
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

/** Small "⌨" trigger just left of the theme switch, for discovering the
 *  shortcut table without already knowing its shortcut. Positioned the same
 *  way .theme-switch itself is (controlPanel.css: absolute, tied to the
 *  logo width) — a sibling right before it in the DOM, so it sits
 *  immediately to its left. */
function addHelpTriggerButton() {
  const themeSwitch = document.getElementById('themeSwitch');
  if (!themeSwitch || !themeSwitch.parentElement) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'shortcutsHelpTrigger';
  btn.className = 'shortcuts-help-trigger';
  btn.title = 'Keyboard shortcuts';
  btn.setAttribute('aria-label', 'Keyboard shortcuts');
  btn.textContent = '⌨';
  btn.addEventListener('click', openShortcutsHelp);
  themeSwitch.insertAdjacentElement('beforebegin', btn);
}
