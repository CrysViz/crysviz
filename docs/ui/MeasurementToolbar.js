// Measurement-tool toolbar wiring: distance/angle/delete mode buttons, the
// clear-all button, their touch handlers, and the mobile measurement/camera
// panel expand toggles. Extracted from crystal-viewer.js initApp() (Stage 6).
//
// The mode toggle + clear logic is exposed as setMeasureMode / clearAllMeasureMode
// so the in-panel tools section (ui/PanelToolbars.js, used by the "minimal" theme)
// can reuse the exact same behavior as the floating toolbar.

import { mode, measurements } from '../state/store.js';
import { clearHighlightAtom } from './SelectAndHighlightModule.js';
import { clearMeasureGraphics, clearAllMeasurements, clearMeasure } from '../render/MeasurementModule.js';

function clearActiveMeasureButtons() {
  document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
}

// Toggle a measurement mode ('distance' | 'angle' | 'delete'). Clicking the
// active mode turns it off. `button`, if given, receives the `.active` class.
export function setMeasureMode(targetMode, button) {
  const wasActive = mode.measureMode === targetMode;
  clearActiveMeasureButtons();
  measurements.selectedAtoms.forEach(() => clearHighlightAtom());
  measurements.selectedAtoms = [];
  clearMeasureGraphics();
  if (wasActive) {
    mode.measureMode = 'none';
  } else {
    mode.measureMode = targetMode;
    if (button) button.classList.add('active');
  }
}

export function clearAllMeasureMode() {
  clearAllMeasurements();
  clearActiveMeasureButtons();
  mode.measureMode = 'none';
  clearMeasure();
}

export function setupMeasurementToolbar() {
  // Mobile measurement toggle
  document.getElementById('measurementToggle').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('measurementPanel').classList.toggle('expanded');
  });

  // Mobile camera toggle
  document.getElementById('cameraToggle').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('cameraPanel').classList.toggle('expanded');
  });

  const distanceBtn = document.getElementById('distanceModeBtn');
  const angleBtn = document.getElementById('angleModeBtn');
  const deleteBtn = document.getElementById('deleteModeBtn');
  const clearBtn = document.getElementById('clearAllMeasurements');

  distanceBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); setMeasureMode('distance', distanceBtn);
  });
  angleBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); setMeasureMode('angle', angleBtn);
  });
  deleteBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); setMeasureMode('delete', deleteBtn);
  });
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); clearAllMeasureMode();
  });

  // Touch handlers for better mobile support
  [distanceBtn, angleBtn, clearBtn].forEach(btn => {
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation(); btn.click();
    });
  });
}
