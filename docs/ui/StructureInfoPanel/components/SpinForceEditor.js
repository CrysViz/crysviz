import { colorHexToCss } from '../../../utils/ColorModule.js';
import { getAtomColor } from '../../../utils/ColorModule.js';

export function createSpinForceEditor(atomIndex, element, dot) {
  const spinEditor = document.createElement('div');
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

  function makeSwitchButton(label, active = false) {
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
    if (active) {
      btn.style.background = "#0d8a36";
      btn.style.color = "#fff";
    } else {
      btn.style.color = "rgba(255,255,255,0.8)";
    }
    return btn;
  }

  const spinSelectBtn = makeSwitchButton("Spin", true);
  const forceSelectBtn = makeSwitchButton("Force", false);

  spinSelectBtn.onclick = () => {
    spinSelectBtn.style.background = "#0d8a36";
    spinSelectBtn.style.color = "#fff";
    forceSelectBtn.style.background = "transparent";
    forceSelectBtn.style.color = "rgba(255,255,255,0.8)";
  };

  forceSelectBtn.onclick = () => {
    forceSelectBtn.style.background = "#0d8a36";
    forceSelectBtn.style.color = "#fff";
    spinSelectBtn.style.background = "transparent";
    spinSelectBtn.style.color = "rgba(255,255,255,0.8)";
  };

  switchWrapper.appendChild(spinSelectBtn);
  switchWrapper.appendChild(forceSelectBtn);
  spinEditor.appendChild(switchWrapper);

  const spinApplyBtn = document.createElement('button');
  spinApplyBtn.textContent = 'Apply';
  spinApplyBtn.className = 'btn-mini highlight';
  spinApplyBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';

  const spinColorBtn = document.createElement('button');
  spinColorBtn.textContent = 'Color';
  spinColorBtn.className = 'btn-mini highlight';
  spinColorBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';
  const mom_spin_color = colorHexToCss(getAtomColor(atomIndex));
  spinColorBtn.style.background = mom_spin_color;

  const spinResetBtn = document.createElement('button');
  spinResetBtn.textContent = 'Reset';
  spinResetBtn.className = 'btn-mini';
  spinResetBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px; margin-right: 6px;';

  const xSpinInput = document.createElement('input');
  xSpinInput.type = 'number';
  xSpinInput.value = "0";
  xSpinInput.step = '0.001';
  xSpinInput.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  xSpinInput.style.webkitAppearance = "none";
  xSpinInput.style.MozAppearance = "textfield";
  xSpinInput.placeholder = 'x';

  const ySpinInput = document.createElement('input');
  ySpinInput.type = 'number';
  ySpinInput.value = "0";
  ySpinInput.step = '0.001';
  ySpinInput.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  ySpinInput.style.webkitAppearance = "none";
  ySpinInput.style.MozAppearance = "textfield";
  ySpinInput.placeholder = 'y';

  const zSpinInput = document.createElement('input');
  zSpinInput.type = 'number';
  zSpinInput.value = "0";
  zSpinInput.step = '0.001';
  zSpinInput.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px;';
  zSpinInput.style.webkitAppearance = "none";
  zSpinInput.style.MozAppearance = "textfield";
  zSpinInput.placeholder = 'z';

  const scaleSpinInput = document.createElement('input');
  scaleSpinInput.type = 'number';
  scaleSpinInput.value = "0";
  scaleSpinInput.step = '0.001';
  scaleSpinInput.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px;';
  scaleSpinInput.placeholder = 'scale';

  const spinInputsRow = document.createElement('div');
  spinInputsRow.style.cssText = 'display: flex; align-items: center; gap: 4px; margin-bottom: 6px; justify-content:center;';
  spinInputsRow.className = "SpinInputRow";
  spinInputsRow.appendChild(xSpinInput);
  spinInputsRow.appendChild(ySpinInput);
  spinInputsRow.appendChild(zSpinInput);
  spinInputsRow.appendChild(scaleSpinInput);

  const spinButtonsRow = document.createElement('div');
  spinButtonsRow.style.cssText = 'display: flex; align-items: center; gap: 4px; justify-content:center;';
  spinButtonsRow.appendChild(spinResetBtn);
  spinButtonsRow.appendChild(spinApplyBtn);
  spinButtonsRow.appendChild(spinColorBtn);

  spinEditor.appendChild(spinInputsRow);
  spinEditor.appendChild(spinButtonsRow);

  return spinEditor;
}
