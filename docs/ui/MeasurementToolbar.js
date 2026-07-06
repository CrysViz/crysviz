// Measurement-tool toolbar wiring: distance/angle/delete mode buttons, the
// clear-all button, and their touch handlers. The toolbar itself lives inside
// the unified "Measure" panel window (ui/panels/defaultPanels.js); mobile
// visibility is handled by that panel's collapse, not a dedicated toggle.
//
// The mode toggle + clear logic is exposed as setMeasureMode / clearAllMeasureMode
// so other UI (e.g. keyboard shortcuts) can reuse the exact same behavior.

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
