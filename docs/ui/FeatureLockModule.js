// Per-structure lock for the Features window's toggles (ui/panels/defaultPanels.js's
// buildFeaturesBody) — the counterpart to the camera lock in
// WindowAndSceneControls.js. Locked (default): one shared set of toggle
// values across every loaded structure, exactly as before. Unlocked: each
// file-browser row remembers its own toggle values (not per trajectory step
// within a row) — save/restore is driven from FileBrowswerPanel.js's
// updateStructureFromRowAndStep, the single choke point for every row switch.

import { general, saveLockPrefs } from '../state/store.js';
import { createToggleRow } from './ToggleSwitch.js';
import { createLockIcon } from './LockToggleButton.js';
import { confirmDialog } from './ConfirmModal.js';

// Checkbox ids for every toggle the Features window exposes — the complete
// set snapshotted/restored per-structure while unlocked. Values here are the
// app's own declared defaults (store.js/PlanesPanel.js) — the fallback for a
// structure that's never been individually saved (see applyDefaultFeatureToggles).
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

/** Read the current checked state of every Features toggle. */
export function snapshotFeatureToggles() {
  const snap = {};
  for (const id of FEATURE_TOGGLE_IDS) {
    const cb = document.getElementById(id);
    if (cb) snap[id] = cb.checked;
  }
  return snap;
}

/** Restore a snapshot from snapshotFeatureToggles() — sets each checkbox and
 *  dispatches 'change' so the existing listeners (ControlsWiring.js for the
 *  detached static rows, buildFeaturesBody for the rest) do the actual scene
 *  update, exactly as if the user had clicked it. */
export function applyFeatureToggles(snapshot) {
  if (!snapshot) return;
  for (const id of FEATURE_TOGGLE_IDS) {
    const cb = document.getElementById(id);
    if (!cb || !(id in snapshot) || cb.checked === snapshot[id]) continue;
    cb.checked = snapshot[id];
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/** Fallback for a structure that's never been individually saved (see
 *  FileBrowswerPanel.js's updateStructureFromRowAndStep) — resets to the
 *  app's own declared defaults rather than leaving whatever the checkboxes
 *  currently read, which may belong to a DIFFERENT structure's own
 *  customization made after unlocking (e.g. duplicate a structure, unlock,
 *  change a toggle on the copy, then visit the original for the first time
 *  since unlocking — the original never had its own value recorded, so
 *  leaving it alone would just show the copy's). */
export function applyDefaultFeatureToggles() {
  applyFeatureToggles(FEATURE_TOGGLE_DEFAULTS);
}

const FEATURE_LOCK_CONFIRM = 'Locking feature toggles makes every structure share the current values going forward — any independent settings other structures had will stop being used (though not lost; unlocking again brings them back). Continue?';

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
      const ok = await confirmDialog(FEATURE_LOCK_CONFIRM, { title: 'Lock this setting?', okLabel: 'Lock' });
      if (!ok) {
        input.checked = false;
        return;
      }
    }
    general.featuresLocked = locked;
    saveLockPrefs();
  });
  return row;
}
