import * as THREE from '../../../external/three/three.module.js';
import { fileBrowser, general } from '../../../state/store.js';
import { updateSpins, updateForces, computeSpinColor, computeForceColor } from '../../../render/index.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { getLuminance } from '../../BackgroundPicker.js';

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
export function createSpinForceEditor(atomIndex, element, { onModeChange = () => {} } = {}) {
  const spinEditor = document.createElement('div');
  spinEditor.className = 'atom-spin-editor';
  spinEditor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const switchWrapper = document.createElement('div');
  switchWrapper.style.cssText = `
    display: inline-flex;
    background: #2d2d2d;
    border-radius: 10px;
    padding: 4px;
    gap: 4px;
    font-size: 11px;
    min-width:98%;
    margin-bottom: 10px;
  `;

  function makeSwitchButton(label) {
    const btn = document.createElement('div');
    btn.textContent = label;
    btn.style.cssText = `
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      transition: 0.15s ease;
      user-select: none;
      font-weight: 500;
      min-width:40%;
      justify-content: center;
      display: flex;
    `;
    return btn;
  }

  const spinSelectBtn = makeSwitchButton("Spin");
  const forceSelectBtn = makeSwitchButton("Force");
  switchWrapper.appendChild(spinSelectBtn);
  switchWrapper.appendChild(forceSelectBtn);
  spinEditor.appendChild(switchWrapper);

  const noDataMsg = document.createElement('div');
  noDataMsg.style.cssText = 'display: none; font-size: 11px; color: rgba(255,255,255,0.5); text-align: center; padding: 6px 0;';
  spinEditor.appendChild(noDataMsg);

  function makeVectorInput(placeholder) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.0001';
    input.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px; appearance: textfield;';
    input.style.webkitAppearance = 'none';
    input.style.setProperty('-moz-appearance', 'textfield');
    input.placeholder = placeholder;
    return input;
  }

  const xInput = makeVectorInput('x');
  const yInput = makeVectorInput('y');
  const zInput = makeVectorInput('z');
  zInput.style.marginRight = '0';

  const vectorInputsRow = document.createElement('div');
  vectorInputsRow.style.cssText = 'display: flex; align-items: center; gap: 4px; margin-bottom: 6px; justify-content:center;';
  vectorInputsRow.className = 'SpinInputRow';
  vectorInputsRow.appendChild(xInput);
  vectorInputsRow.appendChild(yInput);
  vectorInputsRow.appendChild(zInput);
  spinEditor.appendChild(vectorInputsRow);

  const hideLabel = document.createElement('label');
  hideLabel.style.cssText = 'display: flex; align-items: center; gap: 4px; font-size: 11px; color: rgba(255,255,255,0.8); cursor: pointer; justify-content: center; margin-bottom: 8px;';
  const hideCheckbox = document.createElement('input');
  hideCheckbox.type = 'checkbox';
  hideLabel.appendChild(hideCheckbox);
  hideLabel.appendChild(document.createTextNode('Hide arrow'));
  spinEditor.appendChild(hideLabel);

  const spinApplyBtn = document.createElement('button');
  spinApplyBtn.textContent = 'Apply';
  spinApplyBtn.className = 'btn-mini highlight';
  spinApplyBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';

  const spinColorBtn = document.createElement('button');
  spinColorBtn.textContent = 'Color';
  spinColorBtn.className = 'btn-mini highlight';
  spinColorBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';

  const spinResetBtn = document.createElement('button');
  spinResetBtn.textContent = 'Reset';
  spinResetBtn.className = 'btn-mini';
  spinResetBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px; margin-right: 6px;';

  const spinButtonsRow = document.createElement('div');
  spinButtonsRow.style.cssText = 'display: flex; align-items: center; gap: 4px; justify-content:center;';
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
  colorPickerSection.style.cssText = 'display: none; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); align-items: center; flex-direction: column; gap: 6px;';
  spinEditor.appendChild(colorPickerSection);

  // --- Mode (Spin/Force tab) state ---
  let mode = 'spin';

  function structure() {
    return fileBrowser.selectedStructure;
  }

  function currentObj() {
    return mode === 'spin' ? structure()?.spins?.[atomIndex] : structure()?.forces?.[atomIndex];
  }

  function refreshView() {
    if (mode === 'spin') updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
    else updateForces(general.forceScale ?? 1.0, general.forceColorMap ?? 'heatmap');
  }

  function computeCurrentColor(obj) {
    const computed = mode === 'spin'
      ? computeSpinColor(obj.vector, obj.scaling)
      : computeForceColor(obj.vector, obj.scaling);
    return computed ?? obj.color;
  }

  function setSwitchActive(activeBtn, inactiveBtn) {
    activeBtn.style.background = '#0d8a36';
    activeBtn.style.color = '#fff';
    inactiveBtn.style.background = 'transparent';
    inactiveBtn.style.color = 'rgba(255,255,255,0.8)';
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
    applySwatch(obj.userColor ?? computeCurrentColor(obj));
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
    const initial = obj.userColor ?? computeCurrentColor(obj);
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
    refreshView();
    refreshInputs();
  };

  refreshInputs();

  // Exposed so IndividualAtomRow.js can re-sync the panel's values when the
  // user reopens it — the panel itself isn't reactive to changes made
  // elsewhere (a bulk reset from SpinPanel.js, say) while it's closed.
  spinEditor.refresh = refreshInputs;
  // Exposed so IndividualAtomRow.js knows which arrow (spin or force) to
  // 3D-highlight when this editor is the open one for its atom.
  spinEditor.getMode = () => mode;

  return spinEditor;
}
