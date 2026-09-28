// The "Shared view for all structures" lock for the Features window's ten
// on/off switches (ui/panels/defaultPanels.js's buildFeaturesBody) — the
// counterpart to the camera lock in WindowAndSceneControls.js.
//
// Each switch resolves through a cascade (planning/2026-09-28-shared-view-lock.md D1):
//
//   locked   (general.featuresLocked, the default): shared[id] ?? default[id]
//   unlocked:                     override[id] ?? shared[id] ?? default[id]
//
// Two stores, both wiped by "Clear local data":
//
//   - the SHARED set, localStorage 'crysviz.sharedFeatureToggles.v1', a
//     { [toggleId]: boolean } written when the user flips a switch while
//     locked (and, on locking, from the current values);
//   - per-structure OVERRIDES, the 'featureToggles' field of
//     state/structurePrefs.js (matched by structure fingerprint), holding only
//     the switches the user changed on that structure while unlocked.
//
// In memory the source of truth is `container.featureOverrides` (seeded by the
// 'featureToggles' restorer at load, or from the link's values for a share /
// .crysviz load) plus a module-level cache of the shared set. Row switches and
// unlocks read memory only; user edits update memory first, then storage.
//
// Storage rules (state/structurePrefs.js header, 1-4): saves happen ONLY from
// the switches' own change handlers, as a per-switch patch of the id the user
// flipped. A programmatic apply (applyFeatureToggles below, a share restore)
// never writes: applyFeatureToggles raises an "applying" guard the save hook
// checks, and ShareModule's setToggle sets .checked without dispatching
// 'change'. `event.isTrusted` is deliberately not used — the browser tests
// flip checkboxes with synthetic events.
//
// The cascade is applied (a) in initializeUIOnLoad for a load that restores
// stored prefs, (b) at the end of buildFeaturesBody — four of the switches are
// created there, after the first load — for the selected container if it is
// marked `featureStorePrefs`, (c) on a row switch while unlocked
// (FileBrowswerPanel.js finishFrameSwitch) and (d) when the lock is turned off.
// A share / .crysviz load and a widget embed without `prefs=1` never apply
// either store (restoreStoredPrefs false), so their containers are not marked.
//
// Turning the lock ON (plan Phase 2, D2): when a shared set is already
// stored, a three-way choiceDialog asks to keep it (cascade re-applied so the
// stored values show), use the current view as the new shared set (nothing on
// screen changes), or cancel (switch stays off, nothing changes). When
// nothing is stored yet, the lock is applied with no prompt, using the
// current view as the shared set. The switch input is disabled while the
// dialog is pending so a second click cannot desync it from
// general.featuresLocked.

import { general, saveLockPrefs, structureShip, fileBrowser } from '../state/store.js';
import { registerStructurePrefField, saveStructurePref, readStructurePrefs, onClearLocalData } from '../state/structurePrefs.js';
import { planesData } from './PlanesPanel.js';
import { createToggleRow } from './ToggleSwitch.js';
import { createLockIcon } from './LockToggleButton.js';
import { choiceDialog } from './ConfirmModal.js';

// Checkbox ids for every switch the Features window exposes. Values here are
// the app's own declared defaults (store.js / PlanesPanel.js) — the bottom of
// the cascade.
const FEATURE_TOGGLE_DEFAULTS = {
  showAtoms: true,
  showBonds: true,
  showCharges: false,
  PBCBondToggle: false,
  showPolyhedra: false,
  completePolyhedraToggle: false,
  showForcesToggle: false,
  showSpinsToggle: false,
  showFieldToggle: true,
  showPlanesMasterToggle: true,
};
const FEATURE_TOGGLE_IDS = Object.keys(FEATURE_TOGGLE_DEFAULTS);

// The state each switch drives, read when its checkbox does not exist yet
// (the four panel-built switches before buildFeaturesBody has run) — the same
// values buildFeaturesBody initialises the checkboxes from.
const LIVE_VALUE = {
  showAtoms: () => general.showAtoms !== false,
  showBonds: () => general.showBonds !== false,
  showCharges: () => !!general.showCharges,
  PBCBondToggle: () => !!general.showPBCBonds,
  showPolyhedra: () => !!general.showPolyhedra,
  completePolyhedraToggle: () => !!general.completePolyhedra,
  showForcesToggle: () => !!general.forcesActive,
  showSpinsToggle: () => !!general.spinsActive,
  showFieldToggle: () => general.fieldActive !== false,
  showPlanesMasterToggle: () => planesData.showPlanes !== false,
};

export const SHARED_FEATURE_TOGGLES_KEY = 'crysviz.sharedFeatureToggles.v1';
export const FEATURE_TOGGLES_FIELD = 'featureToggles';

/** @type {Record<string, boolean> | null | undefined} undefined = not read yet. */
let sharedCache;
/** Raised while applyFeatureToggles dispatches 'change' so the save hook stays quiet. */
let applying = false;
/** Checkbox inputs that already carry the save hook (buildFeaturesBody may run again). */
const wiredInputs = new WeakSet();

// ---------------------------------------------------------------------------
// Validation barricade: everything that comes out of storage passes here.
// ---------------------------------------------------------------------------

/**
 * A { toggleId: boolean } map from untrusted JSON: only known ids with boolean
 * values survive. Null for anything that is not a plain object or has no
 * usable entry.
 * @param {any} raw
 * @returns {Record<string, boolean> | null}
 */
function sanitizeToggleMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const id of FEATURE_TOGGLE_IDS) {
    if (typeof raw[id] === 'boolean') out[id] = raw[id];
  }
  return Object.keys(out).length ? out : null;
}

function loadSharedFromStorage() {
  try {
    return sanitizeToggleMap(JSON.parse(localStorage.getItem(SHARED_FEATURE_TOGGLES_KEY) || 'null'));
  } catch { return null; /* corrupted or storage unavailable -> nothing stored */ }
}

function sharedSet() {
  if (sharedCache === undefined) sharedCache = loadSharedFromStorage();
  return sharedCache;
}

/** The container of the selected file-browser row. */
function selectedContainer() {
  return structureShip.container[fileBrowser.selectedRowIndex] ?? null;
}

// ---------------------------------------------------------------------------
// Public API (also used by the three-way lock prompt, plan Phase 2)
// ---------------------------------------------------------------------------

/**
 * The stored shared set, or null when nothing usable is stored.
 * @returns {Record<string, boolean> | null}
 */
export function readSharedFeatureToggles() {
  const shared = sharedSet();
  return shared ? { ...shared } : null;
}

/**
 * Persist `values` as the shared set and update the cache. Applies nothing to
 * the checkboxes. Only called from user-edit handlers (rule 1).
 * @param {Record<string, boolean>} values
 */
export function writeSharedFeatureToggles(values) {
  sharedCache = sanitizeToggleMap(values);
  try {
    if (sharedCache) localStorage.setItem(SHARED_FEATURE_TOGGLES_KEY, JSON.stringify(sharedCache));
    else localStorage.removeItem(SHARED_FEATURE_TOGGLES_KEY);
  } catch { /* storage unavailable or quota exceeded */ }
}

/** Read the current state of every Features switch: the checkbox where it
 *  exists, otherwise the state it drives (see LIVE_VALUE). Always all ten. */
export function snapshotFeatureToggles() {
  /** @type {Record<string, boolean>} */
  const snap = {};
  for (const id of FEATURE_TOGGLE_IDS) {
    const cb = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
    snap[id] = cb ? cb.checked : LIVE_VALUE[id]();
  }
  return snap;
}

/** Apply a { toggleId: boolean } map — sets each checkbox that differs and
 *  dispatches 'change' so the existing listeners (ControlsWiring.js for the
 *  static rows, buildFeaturesBody for the rest) do the scene update, exactly
 *  as if the user had clicked it. Idempotent, and never saves (the guard). */
export function applyFeatureToggles(snapshot) {
  if (!snapshot) return;
  applying = true;
  try {
    for (const id of FEATURE_TOGGLE_IDS) {
      const cb = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
      if (!cb || typeof snapshot[id] !== 'boolean' || cb.checked === snapshot[id]) continue;
      cb.checked = snapshot[id];
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } finally {
    applying = false;
  }
}

/**
 * Resolve the cascade for `container` (default: the selected row's) under the
 * current lock state, from memory only, and apply it.
 * @param {any} [container]
 */
export function applyEffectiveFeatureToggles(container = selectedContainer()) {
  const shared = sharedSet();
  const overrides = general.featuresLocked === false ? container?.featureOverrides : null;
  /** @type {Record<string, boolean>} */
  const resolved = {};
  for (const id of FEATURE_TOGGLE_IDS) {
    resolved[id] = overrides?.[id] ?? shared?.[id] ?? FEATURE_TOGGLE_DEFAULTS[id];
  }
  applyFeatureToggles(resolved);
}

/**
 * End-of-build hook for buildFeaturesBody: attaches the user-edit save hook
 * to all ten switches (idempotent) and applies the cascade for the selected
 * container when it was loaded with stored prefs (four switches only exist
 * from here on, so the load-time apply could not reach them).
 */
export function onFeaturesBodyBuilt() {
  for (const id of FEATURE_TOGGLE_IDS) {
    const cb = document.getElementById(id);
    if (!cb || wiredInputs.has(cb)) continue;
    wiredInputs.add(cb);
    cb.addEventListener('change', () => {
      if (!applying) saveUserToggle(id, /** @type {HTMLInputElement} */ (cb).checked);
    });
  }
  const container = selectedContainer();
  if (container?.featureStorePrefs) applyEffectiveFeatureToggles(container);
}

// ---------------------------------------------------------------------------
// Saving (user edits only)
// ---------------------------------------------------------------------------

/** One switch flipped by the user: patch the store the lock state selects. */
function saveUserToggle(id, value) {
  if (general.featuresLocked !== false) {
    writeSharedFeatureToggles({ ...(sharedSet() ?? {}), [id]: value });
    return;
  }
  const container = selectedContainer();
  if (!container) return;
  container.featureOverrides = { ...(container.featureOverrides ?? {}), [id]: value };
  // Storage gets a per-switch patch of what the user changed on this
  // structure — never the in-memory map, which for a share-loaded container
  // holds the link's ten values. An override back at the value the cascade
  // would give anyway is dropped so the field disappears once nothing is left.
  const stored = sanitizeToggleMap(readStructurePrefs(container)?.[FEATURE_TOGGLES_FIELD]) ?? {};
  const fallback = sharedSet()?.[id] ?? FEATURE_TOGGLE_DEFAULTS[id];
  if (value === fallback) delete stored[id];
  else stored[id] = value;
  saveStructurePref(container, FEATURE_TOGGLES_FIELD, Object.keys(stored).length ? stored : null);
}

// The restorer only seeds memory; it runs 'beforeSelect' so the overrides are
// in place before initializeUIOnLoad's selectLastAddedRow(), whose row switch
// already resolves the cascade for the new container while unlocked.
registerStructurePrefField(FEATURE_TOGGLES_FIELD, (container, value) => {
  container.featureOverrides = sanitizeToggleMap(value);
}, { phase: 'beforeSelect' });

// "Clear local data": drop the in-memory copies so nothing can be written
// back; the screen is left as it is (rule 4).
onClearLocalData(() => {
  sharedCache = null;
  for (const container of structureShip.container) {
    if (container) container.featureOverrides = null;
  }
});

// ---------------------------------------------------------------------------
// The lock switch
// ---------------------------------------------------------------------------

/**
 * Turning the lock on with a shared set already stored: ask which view wins.
 * Cancel (Escape / backdrop click both resolve 'cancel' too) leaves the
 * switch off and changes nothing.
 * @returns {Promise<'keep' | 'current' | 'cancel'>}
 */
function askLockChoice() {
  return choiceDialog(
    'A shared view is already saved. Locking makes every structure use one shared set of feature toggles.',
    {
      title: 'Lock this setting?',
      cancelValue: 'cancel',
      choices: [
        {
          value: 'keep', id: 'featureLockKeepShared', label: 'Keep saved shared view',
          description: 'Switch to the values saved the last time this was shared.',
        },
        {
          value: 'current', id: 'featureLockUseCurrent', label: 'Use current view as shared',
          description: 'Save what is on screen now as the shared set, replacing the saved one.',
        },
      ],
    },
  );
}

/** Build the Features panel's first row: a normal app switch whose ON state
 * means that all feature toggles are shared across structures. */
export function createFeatureLockSwitch() {
  const { row, input } = createToggleRow({
    id: 'featureSharedViewToggle',
    label: 'Shared view for all structures',
    checked: general.featuresLocked !== false,
  });
  row.classList.add('feature-lock-row');
  const text = row.querySelector('.toggle_text');
  if (text) {
    const icon = createLockIcon({ strike: false });
    icon.classList.add('feature-lock-icon');
    text.prepend(icon);
  }

  input.addEventListener('change', async () => {
    const locked = input.checked;
    if (locked) {
      if (readSharedFeatureToggles() !== null) {
        input.disabled = true;
        let choice;
        try {
          choice = await askLockChoice();
        } finally {
          input.disabled = false;
        }
        if (choice === 'cancel') {
          input.checked = false;
          return;
        }
        if (choice === 'current') {
          // The current values become the new shared set; nothing on screen
          // changes.
          writeSharedFeatureToggles(snapshotFeatureToggles());
          general.featuresLocked = true;
        } else {
          // 'keep': lock first so the cascade ignores this structure's
          // overrides, then show the stored shared values.
          general.featuresLocked = true;
          applyEffectiveFeatureToggles();
        }
      } else {
        // Nothing stored yet: lock without a prompt, using the current view.
        writeSharedFeatureToggles(snapshotFeatureToggles());
        general.featuresLocked = true;
      }
    } else {
      general.featuresLocked = false;
      // This structure's overrides, falling through to the shared values —
      // a structure without overrides keeps every switch as it is.
      applyEffectiveFeatureToggles();
    }
    saveLockPrefs();
  });
  return row;
}
