// Full-app UI — everything the embed (widget mode) does NOT need: the panel
// system and every panel (the heavy analysis / phonon / EOS / backend / planes /
// focus panels are all pulled in through defaultPanels here), plus the
// backend / save / export / debug panels, phonopy loading, keyboard shortcuts
// and the projection overlay.
//
// crystal-viewer.js imports this module DYNAMICALLY, and only when NOT in widget
// mode, so a widget embed never downloads any of it. The full app still imports
// it during boot (initUIPanels awaits it), so the app remains complete once
// loaded and keeps working offline — nothing here is fetched on demand later.

import '../ui/AboutPanel.js'; // side-effect: wires the About trigger at load
import '../render/pipeline/tracers.js'; // side-effect: registers the ray/path tracing pipelines
import { initPanelSystem, finishPanelRegistration, refreshActivePanels } from '../ui/panels/PanelManager.js';
import { registerDefaultPanels } from '../ui/panels/defaultPanels.js';
import { isDebugMode } from '../debug/debugMode.js';
import { openDebugPanel } from '../ui/DebugPanel.js';
import { addBackendModeSwitch } from '../ui/BackendPanel/BackendSwitchPanel.js';
import { addSavePanel } from '../ui/SavePanel.js';
import { initImageExportPanel } from '../ui/ImageExportPanel.js';
import { initRaytraceWarningModal } from '../ui/RaytraceWarningModal.js';
import { initAddStructureButton, initModifyStructureButton } from '../ui/addToStructureModule/AddStructureModule.js';
import { initCombineTrajectoriesButton } from '../ui/FileBrowswerPanel.js';
import { initKeyboardShortcuts } from '../ui/KeyboardShortcuts.js';
import { initProjectionOverlay } from '../ui/notagameatall.js';
import { loadPhonopyFile } from '../phonon/phononSession.js';
import { offerCifSymmetryChoice } from '../ui/CifSymmetryLoad.js';

// Callbacks the shared core reaches back into once the full app is loaded — the
// phonopy loader and the CIF "keep symmetry?" prompt are only ever hit from a
// full-app file load, so the core calls them through here instead of importing
// their (full-app-only) modules directly, keeping them out of the widget embed.
export const hooks = { loadPhonopyFile, offerCifSymmetryChoice };

/** Build the full-app chrome. Runs once, during full-app boot (never in widget
 *  mode). Mirrors the panel-setup block that used to live in initUIPanels. */
export function initFullAppUI() {
  initPanelSystem();
  registerDefaultPanels();
  finishPanelRegistration();
  // ?debug: the Debug window opens in front of the side dock straight away.
  if (isDebugMode()) openDebugPanel();
  // Apply availability (grey-out) now that panels exist (see the note in
  // crystal-viewer's initUIPanels history).
  refreshActivePanels();
  addBackendModeSwitch();
  addSavePanel();
  initImageExportPanel();
  initRaytraceWarningModal();
  initModifyStructureButton();
  initAddStructureButton();
  initCombineTrajectoriesButton();
  // Full app only: keyboard shortcuts + the projection overlay chord. Widget
  // mode never loads this module, so no widget guard is needed here.
  initKeyboardShortcuts();
  initProjectionOverlay();
}
