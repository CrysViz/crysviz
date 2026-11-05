// Feature store state: which optional windows sit in the sidebar.
//
// A window takes part when its registration carries a `store` block
// ({ category, blurb, essential?, suggest? } — see defaultPanels.js). Every
// other window (Files, Structure, View, Measure, Settings, the plots windows
// that follow their controls window, transient tool windows) is outside the
// store and behaves exactly as before.
//
// "In the sidebar" is decided here, not by the layout blob: PanelManager asks
// isStoreFeatureEnabled() at registration and keeps a removed window on its
// hidden shelf. The choice lives under its own localStorage key so Reset UI
// (which forgets the layout) keeps the user's feature selection, and only
// "Clear local data" returns a browser to the first-run defaults.
//
// Defaults: a store window is in the sidebar when it is `essential`, or when
// the browser predates the store (it already has a remembered panelLayout —
// nobody's working sidebar empties on update; see load()). A stored explicit
// choice always wins over either default.
//
// No DOM here: the popup (ui/FeatureStoreModal.js), the search palette and
// PanelManager all read and write through this module.

import { onClearLocalData } from '../../state/structurePrefs.js';

const LS_KEY = 'featureStore';
const STORE_VERSION = 1;
// The layout blob PanelManager persists (PanelManager.js LS_KEY). Only its
// presence is read, to recognise a browser that used CrysViz before the store.
const LAYOUT_KEY = 'panelLayout';

/** Explicit user choices, by panel id. Missing id -> the default applies.
 *  @type {Record<string, boolean>} */
let choices = {};
// Every store window defaults to "in the sidebar" (pre-store browsers, and
// the browser tests, which seed it — tools/browsertest/harness.js).
let allByDefault = false;
let loaded = false;
const listeners = new Set();

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === STORE_VERSION) {
        if (parsed.enabled && typeof parsed.enabled === 'object') {
          for (const [id, on] of Object.entries(parsed.enabled)) {
            if (typeof on === 'boolean') choices[id] = on;
          }
        }
        allByDefault = !!parsed.allByDefault;
        return;
      }
    }
    // First load with the store. A remembered layout means this browser ran
    // CrysViz before: keep its full sidebar. Either way the answer is
    // recorded now — a first-run browser saves its layout too, and without a
    // record its NEXT load would read that layout as a pre-store browser's.
    allByDefault = !!localStorage.getItem(LAYOUT_KEY);
    save();
  } catch { /* storage unavailable or corrupted -> first-run defaults */ }
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      version: STORE_VERSION,
      allByDefault,
      enabled: choices,
    }));
  } catch { /* storage unavailable */ }
}

/** Is this panel definition part of the feature store? */
export function isStoreFeature(def) {
  return !!(def && def.store);
}

/** Should a store window be in the sidebar? Non-store windows always are
 *  (the store does not manage them). */
export function isStoreFeatureEnabled(def) {
  if (!isStoreFeature(def)) return true;
  load();
  if (def.id in choices) return choices[def.id];
  return allByDefault || !!def.store.essential;
}

/** Record a choice. Returns true if it changed anything. */
export function setStoreFeatureEnabled(def, on) {
  if (!isStoreFeature(def)) return false;
  load();
  const was = isStoreFeatureEnabled(def);
  choices[def.id] = !!on;
  save();
  if (was !== !!on) {
    for (const fn of listeners) {
      try { fn(def.id, !!on); } catch (e) { console.warn('feature store listener failed', e); }
    }
  }
  return was !== !!on;
}

/** Write the current state now. PanelManager.saveLayout calls this before it
 *  stores the layout, so a panelLayout is never saved without a featureStore
 *  record beside it: load() can then read a layout with no record as a
 *  pre-store browser, and as nothing else — not a layout the page saved after
 *  Settings ▸ Clear local data, which would bring the full sidebar back. */
export function recordFeatureStore() {
  load();
  save();
}

// Settings ▸ Clear local data (state/structurePrefs.js clearLocalData): this
// page becomes a first-run browser. Nothing is written — the wipe leaves the
// storage empty; the next layout save records the state (recordFeatureStore),
// and an untouched next load starts as a first-run browser by itself.
onClearLocalData(() => {
  loaded = true;
  choices = {};
  allByDefault = false;
});

/** Subscribe to sidebar membership changes: fn(panelId, inSidebar). */
export function onFeatureStoreChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
