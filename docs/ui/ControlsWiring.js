// Visibility toggles (atoms/bonds/lattice/polyhedra/periodic/PBC-bonds) +
// atom-size / bond-width sliders + initial control states.
// Extracted from crystal-viewer.js initApp() (Stage 3).
//
// NOTE: the bond-width NaN fallback uses `general.bondRadius`. The original code
// referenced a bare, undefined `bondRadius` here — a latent bug (only reachable
// if a slider value parses to NaN) fixed during this extraction.

import { general, groups, fileBrowser } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { updatePolyhedra, updateSingleAtomDiameter, updateSingleBondDiameter, updateLattice } from '../render/index.js';
import { updateMeasurementMarkers } from '../render/MeasurementModule.js';
import { updateAxesGizmoWidth } from './WindowAndSceneControls.js';

export function setupControlsWiring() {
  // Control handlers
  document.getElementById('showAtoms').onchange = (e) => {
    general.showAtoms = e.target.checked;
    if (groups.atomsMesh) groups.atomsMesh.visible = general.showAtoms;
  };

  // Control handlers
  document.getElementById('showBonds').onchange = (e) => {
    general.showBonds = e.target.checked;
    updateVisualization({
      reRenderAtoms: !!general.showPBCBonds,
      reRenderBonds: true,
      bondsUpdate: false
    });
  };

    // Control handlers
  document.getElementById('showPolyhedra').onchange = (e) => {
    general.showPolyhedra = e.target.checked;
    updatePolyhedra();
  };

  const completePolyToggle = document.getElementById('completePolyhedraToggle');
  if (completePolyToggle) {
    completePolyToggle.onchange = (e) => {
      general.completePolyhedra = e.target.checked;
      // The displayed atom set changes (completing atoms added/removed), so rebuild atoms +
      // bonds; updateVisualization also runs updatePolyhedra, which appends the atoms.
      updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    };
  }

  document.getElementById('showLattice').onchange = (e) => {
    general.showLattice = e.target.checked;
    updateVisualization();
  };

  // Show / hide the a,b,c cell-vector gizmo (#axesGizmo) and its legend
  // (#axesLegend) together. Uses inline display so it overrides any theme CSS.
  const applyAxesVisibility = (visible) => {
    const gizmo = document.getElementById('axesGizmo');
    const legend = document.getElementById('axesLegend');
    if (gizmo) gizmo.style.display = visible ? '' : 'none';
    if (legend) legend.style.display = visible ? '' : 'none';
  };
  const showAxesToggle = document.getElementById('showAxes');
  if (showAxesToggle) {
    showAxesToggle.onchange = (e) => {
      general.showAxes = e.target.checked;
      applyAxesVisibility(general.showAxes);
    };
    applyAxesVisibility(general.showAxes); // sync DOM with the default flag
  }


  const PBCBondToggle = document.getElementById('PBCBondToggle');
  if (PBCBondToggle) {
      PBCBondToggle.onchange = (e) => {
      general.showPBCBonds = e.target.checked;
      updateVisualization({reRenderAtoms:true, reRenderBonds:true});
    };
  }

  const showPeriodicToggle = document.getElementById('showPeriodic');
  if (showPeriodicToggle) {
    showPeriodicToggle.onchange = (e) => {
      general.showPeriodic = e.target.checked;
      updateVisualization({reRenderAtoms:true, reRenderBonds:true});
    };
  }

  document.getElementById('atomSize').oninput = (e) => {
    general.atomSize = parseFloat(e.target.value);
    document.getElementById('atomSizeValue').textContent = general.atomSize.toFixed(1);
    fileBrowser.selectedStructure.elements.forEach((element, index) => {
      const scale = fileBrowser.selectedStructure.atoms[index]?.getRadiusScale?.() ?? 1;
      fileBrowser.selectedStructure.atomImages[index].forEach(imageIndex => {
        updateSingleAtomDiameter(imageIndex, element, scale)
       });
    });
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
    updateMeasurementMarkers(); // Update ring markers when atom size changes

  };


  // Bond width control
  const bondWidthSlider = document.getElementById('bondWidth');
  const bondWidthValue = document.getElementById('bondWidthValue');
  if (bondWidthSlider && bondWidthValue) {
    bondWidthSlider.oninput = (e) => {
      const v = parseFloat(e.target.value);
      // clamp defensively
      general.bondRadius = Math.max(0.005, Math.min(1.0, isNaN(v) ? general.bondRadius : v));
      bondWidthValue.textContent = general.bondRadius.toFixed(2);
      for (let i = 0; i < groups.bondsMesh.count; i++) {
        updateSingleBondDiameter(i,  general.bondRadius)
        //updateSingleAtomColor(originalIndex=atomIndex, element=element, opacity = 1.0)
       }
      groups.bondsMesh.instanceColor.needsUpdate = true;

      //updateVisualization();
    };
  }
  // Unit-cell outline line width control (rebuilds the 12 outline cylinders)
  const latticeWidthSlider = document.getElementById('latticeWidth');
  const latticeWidthValue = document.getElementById('latticeWidthValue');
  if (latticeWidthSlider && latticeWidthValue) {
    latticeWidthSlider.oninput = (e) => {
      const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
      if (isFinite(v)) general.latticeLineWidth = v;
      latticeWidthValue.textContent = general.latticeLineWidth.toFixed(3);
      if (fileBrowser.selectedStructure) updateLattice();
    };
  }

  // Axes gizmo line width control
  const axesWidthSlider = document.getElementById('axesWidth');
  const axesWidthValue = document.getElementById('axesWidthValue');
  if (axesWidthSlider && axesWidthValue) {
    axesWidthSlider.oninput = (e) => {
      const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
      if (isFinite(v)) general.axesLineWidth = v;
      axesWidthValue.textContent = general.axesLineWidth.toFixed(3);
      updateAxesGizmoWidth();
    };
  }

    let checkbox_polyhedra = document.getElementById("showPolyhedra");
      checkbox_polyhedra.checked = general.showPolyhedra; // persist across structure loads

    let checkbox_completePolyhedra = document.getElementById("completePolyhedraToggle");
      if (checkbox_completePolyhedra) checkbox_completePolyhedra.checked = general.completePolyhedra;

 //     let checkbox_showComparisonInfo = document.getElementById("showComparisonInfo");
 //     checkbox_showComparisonInfo.checked = false; // explicitly untick

  let checkbox_neighbours = document.getElementById("PBCBondToggle");
      checkbox_neighbours.checked = false; // explicitly untick

  let checkbox_periodic = document.getElementById("showPeriodic");
      checkbox_periodic.checked = true; // explicitly tick
}
