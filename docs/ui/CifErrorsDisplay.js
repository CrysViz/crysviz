// Showing the CIF errors (standard uncertainties read from a CIF —
// model/cifErrors.js) or not: the Features window's "Show CIF Errors" switch
// (ui/panels/defaultPanels.js), and the one refresh every place that writes a
// value with its error needs when the switch flips or a CIF's errors are read.
// Measurement labels are refreshed directly; the Selection and Polyhedron
// Inspectors listen for 'crysviz:cif-errors-changed'.

import { general } from '../state/store.js';
import { updateAllMeasurements } from '../render/MeasurementModule.js';
import { requestRender } from '../render/AnimateModule.js';

/** Redraw every value that may carry an error. */
export function refreshCifErrors() {
  updateAllMeasurements();
  document.dispatchEvent(new CustomEvent('crysviz:cif-errors-changed'));
  requestRender();
}

/** The Features window's switch. */
export function setCifErrorsShown(on) {
  general.showCifErrors = !!on;
  const box = /** @type {HTMLInputElement|null} */ (document.getElementById('showCifErrorsToggle'));
  if (box && box.checked !== !!on) box.checked = !!on;
  refreshCifErrors();
}
