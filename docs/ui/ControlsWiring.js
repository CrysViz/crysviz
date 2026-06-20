// Visibility toggles (atoms/bonds/lattice/polyhedra/periodic/PBC-bonds) +
// atom-size / bond-width sliders + initial control states.
// Extracted from crystal-viewer.js initApp() (Stage 3).
//
// NOTE: the bond-width NaN fallback uses `general.bondRadius`. The original code
// referenced a bare, undefined `bondRadius` here — a latent bug (only reachable
// if a slider value parses to NaN) fixed during this extraction.

import { general, groups, fileBrowser } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { updatePolyhedra, updateSingleAtomDiameter, updateSingleBondDiameter } from '../render/index.js';
import { updateMeasurementMarkers } from '../render/MeasurementModule.js';

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

  document.getElementById('showLattice').onchange = (e) => {
    general.showLattice = e.target.checked;
    updateVisualization();
  };


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
      fileBrowser.selectedStructure.atomImages[index].forEach(imageIndex => {
        updateSingleAtomDiameter(imageIndex, element)
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
    let checkbox_polyhedra = document.getElementById("showPolyhedra");
      checkbox_polyhedra.checked = false; // explicitly untick

 //     let checkbox_showComparisonInfo = document.getElementById("showComparisonInfo");
 //     checkbox_showComparisonInfo.checked = false; // explicitly untick

  let checkbox_neighbours = document.getElementById("PBCBondToggle");
      checkbox_neighbours.checked = false; // explicitly untick

  let checkbox_periodic = document.getElementById("showPeriodic");
      checkbox_periodic.checked = true; // explicitly tick
}
