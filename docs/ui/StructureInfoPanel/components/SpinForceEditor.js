import * as THREE from '../../../external/three/three.module.js';
import { fileBrowser, general } from '../../../state/store.js';
import { updateSpins, updateForces, computeSpinColor, computeForceColor, requestRender } from '../../../render/index.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { getLuminance } from '../../BackgroundPicker.js';
import { createMaterialEditor, MATERIAL_TYPES } from './MaterialEditor.js';

// Same lum>0.5 threshold BackgroundPicker.js's getContrastingBorder() uses,
// applied to text instead of a border — a swatch's background can land
// anywhere in the colormap (near-white to near-black), and a fixed text
// color goes unreadable at one end or the other.
function contrastTextColor(hex) {
  return getLuminance(hex) > 0.5 ? '#111111' : '#ffffff';
}

// Per-atom row editor for that atom's own spin/force vector — reads live off
// structure.spins[atomIndex]/structure.forces[atomIndex] (populated by the
// file reader or an ML potential run), the same arrays ForcePanel.js/
// SpinPanel.js already render as arrows. Spins are user-editable (Apply
// writes the edited vector back); forces are read-only display only — the
// three numbers are a calculation result, not something to hand-edit.
// "Color" pins THIS atom's own arrow (not the atom sphere) to a fixed color
// computed from its own vector through the live colormap — sticky, via
// Force/Spin.userColor, until Reset clears it (see ForceModule.js/
// SpinModule.js's recolor loops, which skip any object with userColor set).
/**
 * @param {number} atomIndex
 * @param {HTMLElement} element
 * @param {{ onModeChange?: (mode: string) => void }} [opts]
 */
export function createSpinForceEditor(atomIndex, element, { onModeChange = () => {} } = {}) {
  const spinEditor = document.createElement('div');
  spinEditor.className = 'atom-spin-editor';
  spinEditor.style.display = 'none'; // read back via .style.display elsewhere (see IndividualAtomRow.js)

  const switchWrapper = document.createElement('div');
  switchWrapper.className = 'spin-mode-switch';

  function makeSwitchButton(label) {
    const btn = document.createElement('div');
    btn.textContent = label;
    btn.className = 'spin-mode-switch-btn';
    return btn;
  }

  const spinSelectBtn = makeSwitchButton("Spin");
  const forceSelectBtn = makeSwitchButton("Force");
  switchWrapper.appendChild(spinSelectBtn);
  switchWrapper.appendChild(forceSelectBtn);
  spinEditor.appendChild(switchWrapper);

  const noDataMsg = document.createElement('div');
  noDataMsg.className = 'spin-no-data';
  // display is set unconditionally by refreshInputs() below on every call
  // (including the one at the end of this function), so no initial value
  // is needed here.
  spinEditor.appendChild(noDataMsg);

  function makeVectorInput(placeholder) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.0001';
    input.className = 'spin-vector-input';
    input.placeholder = placeholder;
    return input;
  }

  const xInput = makeVectorInput('x');
  const yInput = makeVectorInput('y');
  const zInput = makeVectorInput('z');

  const vectorInputsRow = document.createElement('div');
  vectorInputsRow.className = 'SpinInputRow spin-vector-row';
  vectorInputsRow.appendChild(xInput);
  vectorInputsRow.appendChild(yInput);
  vectorInputsRow.appendChild(zInput);
  spinEditor.appendChild(vectorInputsRow);

  const hideLabel = document.createElement('label');
  hideLabel.className = 'spin-hide-label';
  const hideCheckbox = document.createElement('input');
  hideCheckbox.type = 'checkbox';
  hideLabel.appendChild(hideCheckbox);
  hideLabel.appendChild(document.createTextNode('Hide arrow'));
  spinEditor.appendChild(hideLabel);

  const spinApplyBtn = document.createElement('button');
  spinApplyBtn.textContent = 'Apply';
  spinApplyBtn.className = 'btn-mini highlight si-action-btn-wide';

  const spinColorBtn = document.createElement('button');
  spinColorBtn.textContent = 'Color';
  spinColorBtn.className = 'btn-mini highlight si-action-btn-wide';

  const spinResetBtn = document.createElement('button');
  spinResetBtn.textContent = 'Reset';
  spinResetBtn.className = 'btn-mini si-action-btn-wide si-action-btn-wide--gap';

  const spinButtonsRow = document.createElement('div');
  spinButtonsRow.className = 'spin-buttons-row';
  spinButtonsRow.appendChild(spinResetBtn);
  spinButtonsRow.appendChild(spinApplyBtn);
  spinButtonsRow.appendChild(spinColorBtn);
  spinEditor.appendChild(spinButtonsRow);

  // Color picker section — hidden until "Color" is clicked, same picker
  // atoms/bonds use (ColorPickerModule.js), rather than "Color" silently
  // auto-applying the colormap's own color with no way to pick a different
  // one. Rebuilt fresh every time it's opened, seeded from the color
  // currently showing, since the picker itself has no "reinitialize" API.
  const colorPickerSection = document.createElement('div');
  colorPickerSection.className = 'spin-color-picker-section';
  colorPickerSection.style.display = 'none'; // read back via .style.display in spinColorBtn.onclick below
  spinEditor.appendChild(colorPickerSection);

  // --- Mode (Spin/Force tab) state ---
  let mode = 'spin';

  function structure() {
    return fileBrowser.selectedStructure;
  }

  function currentObj() {
    return mode === 'spin' ? structure()?.spins?.[atomIndex] : structure()?.forces?.[atomIndex];
  }

  function currentCategoryStyle() {
    const s = structure();
    const elementSymbol = s?.elements?.[atomIndex];
    const styles = mode === 'spin' ? s?.spinCategoryStyles : s?.forceCategoryStyles;
    return styles?.[elementSymbol];
  }

  // Per-arrow material follows the same editor contract as atom rows: a
  // cleared entry exposes the effective species category material as its
  // default, while an edited entry is stored on this Spin/Force object.
  const materialEditor = createMaterialEditor(
    () => currentObj()?.userMaterial,
    (material) => {
      const obj = currentObj();
      if (obj) obj.userMaterial = material;
    },
    {
      getDefault: () => currentCategoryStyle()?.material,
      types: MATERIAL_TYPES.filter((type) => type.value !== 'glass'),
    });
  spinEditor.appendChild(materialEditor);

  function refreshView() {
    if (mode === 'spin') updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
    else updateForces(general.forceScale ?? 1.0, general.forceColorMap ?? 'heatmap');
  }

  function computeCurrentColor(obj) {
    const speciesElement = structure()?.elements?.[atomIndex];
    const computed = mode === 'spin'
      ? computeSpinColor(obj.vector, obj.scaling, { element: speciesElement })
      : computeForceColor(obj.vector, obj.scaling, { element: speciesElement });
    return computed ?? obj.color;
  }

  function effectiveCurrentColor(obj) {
    const categoryColor = currentCategoryStyle()?.color;
    return obj.userColor ?? (categoryColor != null ? new THREE.Color(categoryColor) : computeCurrentColor(obj));
  }

  function setSwitchActive(activeBtn, inactiveBtn) {
    activeBtn.classList.add('active');
    inactiveBtn.classList.remove('active');
  }

  function refreshInputs() {
    closeColorPicker(); // avoid it lingering open against a now-stale obj closure
    const obj = currentObj();
    const hasData = Boolean(obj?.vector);

    noDataMsg.style.display = hasData ? 'none' : 'block';
    noDataMsg.textContent = `No ${mode} data for this atom`;
    vectorInputsRow.style.display = hasData ? 'flex' : 'none';
    hideLabel.style.display = hasData ? 'flex' : 'none';
    spinButtonsRow.style.display = hasData ? 'flex' : 'none';

    if (!hasData) return;

    xInput.value = obj.vector[0].toFixed(4);
    yInput.value = obj.vector[1].toFixed(4);
    zInput.value = obj.vector[2].toFixed(4);

    // Forces are a calculation result, not something to hand-edit — display only.
    const editable = mode === 'spin';
    xInput.disabled = !editable;
    yInput.disabled = !editable;
    zInput.disabled = !editable;
    spinApplyBtn.style.display = editable ? '' : 'none';

    hideCheckbox.checked = Boolean(obj.hidden);
    applySwatch(effectiveCurrentColor(obj));
    materialEditor.syncFromStore?.();
  }

  function applySwatch(color) {
    const hex = `#${color.getHexString()}`;
    spinColorBtn.style.background = hex;
    spinColorBtn.style.color = contrastTextColor(hex);
  }

  function closeColorPicker() {
    colorPickerSection.style.display = 'none';
    colorPickerSection.innerHTML = '';
  }

  spinSelectBtn.onclick = () => {
    if (mode === 'spin') return;
    mode = 'spin';
    closeColorPicker();
    setSwitchActive(spinSelectBtn, forceSelectBtn);
    refreshInputs();
    onModeChange(mode);
  };

  forceSelectBtn.onclick = () => {
    if (mode === 'force') return;
    mode = 'force';
    closeColorPicker();
    setSwitchActive(forceSelectBtn, spinSelectBtn);
    refreshInputs();
    onModeChange(mode);
  };

  setSwitchActive(spinSelectBtn, forceSelectBtn);

  hideCheckbox.onchange = () => {
    const obj = currentObj();
    if (!obj) return;
    obj.hidden = hideCheckbox.checked;
    refreshView();
  };

  spinApplyBtn.onclick = () => {
    const obj = currentObj();
    if (!obj) return;
    const x = parseFloat(xInput.value);
    const y = parseFloat(yInput.value);
    const z = parseFloat(zInput.value);
    if ([x, y, z].some((v) => Number.isNaN(v))) return;
    obj.vector = [x, y, z];
    refreshView();
    refreshInputs();
  };

  // Opens a real color picker (same one atoms/bonds use) seeded from the
  // color currently showing, rather than silently pinning the colormap's own
  // color with no way to choose a different one. Picks apply live as the
  // user drags, same as the atom color editor; a second click on "Color"
  // (or switching Spin/Force, or Reset) closes it again.
  spinColorBtn.onclick = () => {
    const obj = currentObj();
    if (!obj) return;
    if (colorPickerSection.style.display !== 'none') {
      closeColorPicker();
      return;
    }
    const initial = effectiveCurrentColor(obj);
    colorPickerSection.innerHTML = '';
    const picker = createColorPicker(`#${initial.getHexString()}`, (hex) => {
      obj.userColor = new THREE.Color(hex);
      applySwatch(obj.userColor);
      refreshView();
    });
    colorPickerSection.appendChild(picker.element);
    colorPickerSection.style.display = 'flex';
  };

  spinResetBtn.onclick = () => {
    const obj = currentObj();
    if (!obj) return;
    closeColorPicker();
    if (mode === 'spin' && typeof obj.reset === 'function') {
      obj.reset(); // restores vector/scaling/color and clears userColor (model/Spin.js)
    } else {
      obj.userColor = null;
    }
    obj.userMaterial = null;
    refreshView();
    requestRender();
    refreshInputs();
  };

  refreshInputs();

  // Exposed so IndividualAtomRow.js can re-sync the panel's values when the
  // user reopens it — the panel itself isn't reactive to changes made
  // elsewhere (a bulk reset from SpinPanel.js, say) while it's closed.
  /** @type {any} */ (spinEditor).refresh = refreshInputs;
  // Exposed so IndividualAtomRow.js knows which arrow (spin or force) to
  // 3D-highlight when this editor is the open one for its atom.
  /** @type {any} */ (spinEditor).getMode = () => mode;

  return spinEditor;
}
