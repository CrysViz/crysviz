import { fileBrowser, groups, general, structureShip, mode } from '../../../state/store.js';
import { colorHexToCss, getAtomColor, setAtomColor } from '../../../utils/ColorModule.js';
import { clampOpacity, clampRadiusScale, applyToOtherTrajectoryFrames, wirePressHoldPopup } from './utils.js';
import { updateSingleAtomColor, updateSingleAtomOpacity, updateSingleAtomDiameter, clearAtomImageStylesForAtom } from '../../../render/AtomsFracUpdateModule.js';
import { updateMeasurementMarkers } from '../../../render/MeasurementModule.js';
import { updateSingleBondColor } from '../../../render/BondsFracUpdateModule.js';
import { updatePolyhedraColors, scheduleBondRebuild, requestRender } from '../../../render/index.js';
import { refreshGhostAtoms } from '../../../render/GhostAtomsModule.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { atomForceToColor, syncBondHalvesToImageColor } from '../../ColorPanel.js';
import { createMaterialEditor } from './MaterialEditor.js';

// Helper function to get the current color for an atom based on the active mode

// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

export function createElementColorEditor(el, updatePieDotCallback, atomIndices) {
  // Get the current colors of all atoms for this element
  const currentAtomColors = atomIndices.map(index => safeColor(getAtomColor(index)));
  const currentOpacity = fileBrowser.selectedStructure.atoms[atomIndices[0]]?.getOpacity?.() ?? 1;
  const currentRadiusScale = fileBrowser.selectedStructure.atoms[atomIndices[0]]?.getRadiusScale?.() ?? 1;

  const editor = document.createElement('div');
  editor.className = 'element-color-editor';
  editor.style.cssText = 'display:none; grid-column:2; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px;';

  const picker = createColorPicker(currentAtomColors[0], (hex) => {
    const structure = fileBrowser.selectedStructure;
    const parsedHex = parseInt(hex.replace('#', ''), 16);

    atomIndices.forEach(atomIndex => {
      const atom = structure.atoms[atomIndex];
      atom.elementColor = parsedHex;
      // Authoritative color state, set unconditionally: an atom with zero
      // periodic images right now (e.g. currently hidden) never runs the
      // per-image loop below, so without this its userColor/color — and
      // therefore getColor() — would silently keep the old value forever,
      // surviving even a later restore.
      atom.userColor = hex;
      setAtomColor(atom, hex);
      // Newest edit wins: an element recolor overrides earlier per-copy colors.
      clearAtomImageStylesForAtom(structure, atomIndex, 'color');
      structure.atomImages[atomIndex]?.forEach(imageIndex => {
        syncBondHalvesToImageColor(structure, imageIndex, parsedHex);
        updateSingleAtomColor(atomIndex, imageIndex, el, hex, hex);
      });
    });

    groups.atomsMesh.instanceColor.needsUpdate = true;
    if (groups.bondsMesh) {
      groups.bondsMesh.instanceColor.needsUpdate = true;
    }
    updatePieDotCallback(); // Update the pie dot
    // Polyhedra faces are coloured by element; recolour them in place to match (cheap,
    // no geometry recompute). The picker updates atom/bond meshes directly and otherwise
    // never triggers a polyhedra update.
    updatePolyhedraColors();
    // This callback updates the real-atom mesh directly rather than going
    // through updateVisualization, so it's the one color-edit path that
    // doesn't get updateVisualization's own ghost-refresh hook — any of
    // these atoms currently shown as a ghost needs the same recolor here.
    if (mode.measureMode === 'hide' || mode.measureMode === 'restore') refreshGhostAtoms();
  });

  // --- Editor UI ---
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  topRow.appendChild(picker.element);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 10px; font-size: 11px; margin-right: 4px; min-width: 50px;';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 50px; width: 50px;';

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  const alphaRow = document.createElement('div');
  alphaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:8px;';
  const alphaLabel = document.createElement('span');
  alphaLabel.textContent = 'Alpha';
  alphaLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const alphaSlider = document.createElement('input');
  alphaSlider.type = 'range';
  alphaSlider.min = '0.05';
  alphaSlider.max = '1';
  alphaSlider.step = '0.01';
  alphaSlider.value = String(currentOpacity);
  alphaSlider.style.cssText = 'flex:1;';
  const alphaValue = document.createElement('input');
  alphaValue.type = 'number';
  alphaValue.min = '0.05';
  alphaValue.max = '1';
  alphaValue.step = '0.01';
  alphaValue.value = currentOpacity.toFixed(2);
  alphaValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  alphaRow.appendChild(alphaLabel);
  alphaRow.appendChild(alphaSlider);
  alphaRow.appendChild(alphaValue);

  // Size (per-species radius multiplier), same row layout as Alpha.
  const sizeRow = document.createElement('div');
  sizeRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:8px;';
  const sizeLabel = document.createElement('span');
  sizeLabel.textContent = 'Size';
  sizeLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.min = '0.2';
  sizeSlider.max = '3';
  sizeSlider.step = '0.05';
  sizeSlider.value = String(currentRadiusScale);
  sizeSlider.style.cssText = 'flex:1;';
  const sizeValue = document.createElement('input');
  sizeValue.type = 'number';
  sizeValue.min = '0.2';
  sizeValue.max = '3';
  sizeValue.step = '0.05';
  sizeValue.value = currentRadiusScale.toFixed(2);
  sizeValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  sizeRow.appendChild(sizeLabel);
  sizeRow.appendChild(sizeSlider);
  sizeRow.appendChild(sizeValue);

  // Per-species ray/path-tracing material (structure.atomMaterials[el]); a
  // cleared entry falls back to the Element-Materials-Map preset, which the
  // editor shows and treats as its default.
  const materialEditor = createMaterialEditor(
    () => fileBrowser.selectedStructure?.atomMaterials?.[el],
    (material) => {
      const structure = fileBrowser.selectedStructure;
      if (!structure) return;
      structure.atomMaterials = structure.atomMaterials ?? {};
      if (material) structure.atomMaterials[el] = material;
      else delete structure.atomMaterials[el];
    },
    { getDefault: () => fileBrowser.selectedStructure?.getDefaultElementMaterial?.(el) });

  editor.appendChild(topRow);
  editor.appendChild(alphaRow);
  editor.appendChild(sizeRow);
  editor.appendChild(materialEditor);
  editor.appendChild(buttonRow);

  function textColorForBg(cssHex) {
    let hex = cssHex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? '#000' : '#fff';
  }

  const defaultColor = fileBrowser.selectedStructure.getDefaultElementColor(el);
  const defaultColorCss = safeColor(defaultColor);
  resetBtn.style.background = defaultColorCss;
  resetBtn.style.borderColor = 'rgba(0,0,0,0.15)';
  resetBtn.style.color = textColorForBg(defaultColorCss);

  function applyElementOpacity(rawValue) {
    const value = clampOpacity(rawValue);
    alphaSlider.value = String(value);
    alphaValue.value = value.toFixed(2);
    atomIndices.forEach((atomIndex) => {
      fileBrowser.selectedStructure.atoms[atomIndex].setElementOpacity(value);
      fileBrowser.selectedStructure.atoms[atomIndex].setOpacity(value);
      clearAtomImageStylesForAtom(fileBrowser.selectedStructure, atomIndex, 'alpha');
      fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach((imageIndex) => {
        updateSingleAtomOpacity(imageIndex, value);
      });
    });
  }

  alphaSlider.oninput = (e) => applyElementOpacity(/** @type {any} */ (e.target).value);
  alphaValue.oninput = (e) => applyElementOpacity(/** @type {any} */ (e.target).value);

  function applyElementRadiusScale(rawValue) {
    const value = clampRadiusScale(rawValue);
    sizeSlider.value = String(value);
    sizeValue.value = value.toFixed(2);
    const structure = fileBrowser.selectedStructure;
    atomIndices.forEach((atomIndex) => {
      structure.atoms[atomIndex].setRadiusScale(value);
      clearAtomImageStylesForAtom(structure, atomIndex, 'radiusScale');
      structure.atomImages[atomIndex]?.forEach((imageIndex) => {
        updateSingleAtomDiameter(imageIndex, el, value);
      });
    });
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
    updateMeasurementMarkers();
    // Bond visible lengths bake the atom radii in — refresh once settled.
    scheduleBondRebuild();
  }

  sizeSlider.oninput = (e) => applyElementRadiusScale(/** @type {any} */ (e.target).value);
  sizeValue.oninput = (e) => applyElementRadiusScale(/** @type {any} */ (e.target).value);


  // Pure data reset for one frame's copy of these atoms — no mesh/render
  // calls, so it's safe to re-run against off-screen trajectory frames too
  // (see the press-and-hold loop in resetBtn below). Recomputes the
  // force-mode color from THIS structure's own forces, so looping it per
  // frame (rather than copying the current frame's color) stays correct even
  // when frames have different force vectors.
  function resetElementColorData(structure, currentMode) {
    atomIndices.forEach((atomIndex) => {
      const atom = structure.atoms[atomIndex];
      const element = structure.elements[atomIndex];

      if (atom.userColor !== undefined) delete atom.userColor;
      if (atom.forceColor !== undefined) delete atom.forceColor;
      clearAtomImageStylesForAtom(structure, atomIndex);

      if (currentMode === "force") {
        const forceObj = structure.forces?.[atomIndex];
        if (forceObj?.vector?.length >= 3) {
          const magnitude = Math.sqrt(
            forceObj.vector[0] ** 2 +
            forceObj.vector[1] ** 2 +
            forceObj.vector[2] ** 2
          );
          atom.color = atomForceToColor(magnitude, general.ForceMin, general.ForceMax);
        } else {
          atom.color = structure.getDefaultElementColor(element);
        }
      } else {
        atom.color = structure.getDefaultElementColor(element);
      }

      atom.setElementOpacity(1);
      atom.setOpacity(1);
      atom.setRadiusScale(1);
    });
    if (structure.atomMaterials) delete structure.atomMaterials[el];
  }

  resetBtn.title = 'Click: this frame. Press and hold: whole trajectory.';
  function doResetThisFrame() {
    const structure = fileBrowser.selectedStructure;
    const currentMode = general.atomsColor; // current color mode

    resetElementColorData(structure, currentMode);

    atomIndices.forEach((atomIndex) => {
      const atom = structure.atoms[atomIndex];
      structure.atomImages[atomIndex]?.forEach((imageIndex) => {
        syncBondHalvesToImageColor(structure, imageIndex, safeColor(atom.getColor()));
        updateSingleAtomColor(atomIndex, imageIndex, el);
        updateSingleAtomOpacity(imageIndex, atom.getOpacity());
      });
    });
    if (structure.atomMaterials) materialEditor.syncFromStore?.();

    updatePieDotCallback();
    applyElementOpacity(1);
    applyElementRadiusScale(1);
    // Polyhedra faces are coloured by element — recolour them in place to match
    // (mirrors the live picker callback above, which does the same on every edit).
    updatePolyhedraColors();
    requestRender();
    updateVisualization({
      bondsUpdate: false,
      reRenderAtoms: false,
      reRenderBonds: false,
      reRenderLattice: false,
      reRenderOther: false,
      reRenderComposition: "open",
    });
    return { structure, currentMode };
  }
  wirePressHoldPopup(resetBtn, {
    holdLabel: 'Reset Trajectory',
    onPress: () => { doResetThisFrame(); },
    onConfirm: () => {
      const { structure, currentMode } = doResetThisFrame();
      // Re-run the same pure-data reset on every other frame of this
      // trajectory (a loop, not a copy of the current frame's result — see
      // resetElementColorData's docstring for why that distinction matters).
      applyToOtherTrajectoryFrames(structure, (frame) => resetElementColorData(frame, currentMode));
    },
  });

  applyBtn.title = 'Click: close. Press and hold: copy this color/alpha/size to every trajectory frame.';
  wirePressHoldPopup(applyBtn, {
    holdLabel: 'Apply to Trajectory',
    onPress: () => {
      updatePieDotCallback(); // Update the pie dot
      updateVisualization({
        bondsUpdate: false,
        reRenderAtoms: false,
        reRenderBonds: false,
        reRenderLattice: false,
        reRenderOther: false,
        reRenderComposition: "open",
      });
      editor.style.display = 'none';
    },
    onConfirm: () => {
      // A deliberate broadcast (unlike Reset, it's meant to overwrite every
      // other frame's look with this one's). Pushes both plain colors and
      // the style stores (atomImageStyles/materials/etc) so nothing Reset
      // can clear is left un-propagated.
      const trajContainer = structureShip.container[fileBrowser.selectedRowIndex];
      trajContainer.flushColorToAllStructures(fileBrowser.selectedStructure);
      trajContainer.flushStylesToAllStructures(fileBrowser.selectedStructure);
    },
  });

  return editor;
}
