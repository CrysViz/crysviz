// Visibility toggles (atoms/bonds/lattice/polyhedra/periodic/PBC-bonds) +
// atom-size / bond-width sliders + initial control states.
// Extracted from crystal-viewer.js initApp() (Stage 3).
//
// NOTE: the bond-width NaN fallback uses `general.bondRadius`. The original code
// referenced a bare, undefined `bondRadius` here — a latent bug (only reachable
// if a slider value parses to NaN) fixed during this extraction.

import { general, groups, fileBrowser } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { updatePolyhedra, updateSingleAtomDiameter, updateSingleBondDiameter, updateLattice, getAtomImageStyle, rebuildBonds } from '../render/index.js';
import { updateMeasurementMarkers } from '../render/MeasurementModule.js';
import { updateAxesGizmoWidth } from './WindowAndSceneControls.js';

// ---- size-slider mapping ---------------------------------------------------
// The Atom Size / Bond Diameter sliders are continuous [0,1] positions with a
// QUADRATIC response into a wide value range: fine control at the small end,
// space-filling headroom at the top. All writers/readers of the slider
// elements (handlers here, markup init in core/crystal-viewer.js, restore in
// ui/ShareModule.js) must go through these mappings.
export const ATOM_SIZE_RANGE = { min: 0.05, max: 3.0 };
export const BOND_RADIUS_RANGE = { min: 0.005, max: 1.0 };

/** Slider position [0,1] -> value (quadratic). */
export function sizeSliderToValue(pos, range) {
  const p = Math.min(1, Math.max(0, pos));
  return range.min + (range.max - range.min) * p * p;
}

/** Value -> slider position [0,1] (inverse of sizeSliderToValue). */
export function sizeValueToSlider(value, range) {
  const v = Math.min(range.max, Math.max(range.min, value));
  return Math.sqrt((v - range.min) / (range.max - range.min));
}

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

  // Bond visible lengths are clipped by the atom radii (Bond.r1/r2 include
  // general.atomSize), so a size change must rebuild the bond geometry too.
  // Debounced: the per-instance diameter updates give live feedback while
  // dragging; the (heavier) bond rebuild runs once the slider settles.
  let bondRecalcTimer = null;
  const scheduleBondRecalc = () => {
    if (bondRecalcTimer) clearTimeout(bondRecalcTimer);
    bondRecalcTimer = setTimeout(() => {
      bondRecalcTimer = null;
      rebuildBonds(general.mainOpacity ?? 1);
    }, 200);
  };

  document.getElementById('atomSize').oninput = (e) => {
    general.atomSize = sizeSliderToValue(parseFloat(e.target.value), ATOM_SIZE_RANGE);
    document.getElementById('atomSizeValue').textContent = general.atomSize.toFixed(2);
    fileBrowser.selectedStructure.elements.forEach((element, index) => {
      const scale = fileBrowser.selectedStructure.atoms[index]?.getRadiusScale?.() ?? 1;
      fileBrowser.selectedStructure.atomImages[index].forEach(imageIndex => {
        // The global size is a multiplier — keep per-copy size overrides intact.
        const imageScale = getAtomImageStyle(fileBrowser.selectedStructure, imageIndex)?.radiusScale ?? scale;
        updateSingleAtomDiameter(imageIndex, element, imageScale)
       });
    });
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
    updateMeasurementMarkers(); // Update ring markers when atom size changes
    scheduleBondRecalc();
  };


  // Bond width control
  const bondWidthSlider = document.getElementById('bondWidth');
  const bondWidthValue = document.getElementById('bondWidthValue');
  if (bondWidthSlider && bondWidthValue) {
    bondWidthSlider.oninput = (e) => {
      const v = sizeSliderToValue(parseFloat(e.target.value), BOND_RADIUS_RANGE);
      // clamp defensively
      general.bondRadius = Math.max(0.005, Math.min(1.0, isNaN(v) ? general.bondRadius : v));
      bondWidthValue.textContent = general.bondRadius.toFixed(2);
      for (let i = 0; i < groups.bondsMesh.count; i++) {
        updateSingleBondDiameter(i,  general.bondRadius)
       }
      groups.bondsMesh.instanceColor.needsUpdate = true;
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
