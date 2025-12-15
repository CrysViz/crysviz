import { createColorPicker } from '../old_style/color-picker.js';
import { app, groups, general, structureData, mode, atomicRadii,getLatticeVisSettings,getAtomVisSettings} from '../store.js';

import {updateForces} from '../modules/ForceModule.js';


export function removeForcePanel() {
  const panel = document.getElementById("forceControlsGroup");
  if (panel) {
    panel.remove();
  } else {
    console.warn("Force Controls panel does not exist.");
  }
}

export function addForcePanel(target = "SpinForceContainer") {
  const targetPanel = document.getElementById(target);
  if (document.getElementById("forceControlsGroup")) {
    console.warn("Force Controls already exist.");
    return;
  }

  // --- Outer wrapper ---
  const group = document.createElement("div");
  group.id = "forceControlsGroup";

  // --- Panel ---
  const panel = document.createElement("div");
  panel.id = "forcePanel";

  // --- Toggle ---
  const toggle = document.createElement("div");
  toggle.id = "spinToggle";
  toggle.className = "spin-toggle";
  toggle.setAttribute("role", "button");
  toggle.setAttribute("tabindex", "0");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "forceControlsContent");

  const title = document.createElement("h4");
  title.textContent = "Force Controls";

  const icon = document.createElement("div");
  icon.id = "spinToggleIcon";
  icon.className = "toggle-icon";
  icon.textContent = "+";

  toggle.appendChild(title);
  toggle.appendChild(icon);

  // --- Collapsible content ---
  const content = document.createElement("div");
  content.id = "spinControlsContent";
  content.className = "collapsible-content";
  content.setAttribute("aria-hidden", "true");

  // --- Reset wrapper ---
  const resetWrapper = document.createElement("div");
  resetWrapper.id = "resetForceLenghtsWrapper";
  resetWrapper.className = "bottonWrapper";
  resetWrapper.setAttribute("aria-hidden", "true");

  const deleteBtn = document.createElement("button");
  deleteBtn.id = "deleteForces";
  deleteBtn.className = "reset-btn";
  deleteBtn.textContent = "Delete Forces";
  resetWrapper.appendChild(deleteBtn);

  // --- Force Controls container ---
  const forceControls = document.createElement("div");
  forceControls.id = "spinControls";

  const sliderWrapper = document.createElement("div");
  sliderWrapper.style.marginBottom = "8px";

  const sliderLabel = document.createElement("label");
  sliderLabel.textContent = "Spin Length Factor: ";
  sliderWrapper.appendChild(sliderLabel);

  const sliderValue = document.createElement("span");
  sliderValue.textContent = "1.0";
  sliderValue.style.marginRight = "8px";
  sliderWrapper.appendChild(sliderValue);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = 0.1;
  slider.max = 10;
  slider.step = 0.1;
  slider.value = 1;
  sliderWrapper.appendChild(slider);
  content.appendChild(sliderWrapper);

  // Build hierarchy
  content.appendChild(resetWrapper);
  content.appendChild(forceControls);
  panel.appendChild(toggle);
  panel.appendChild(content);
  group.appendChild(panel);

  // Insert into DOM
  targetPanel.appendChild(group);

  // --- Apply YOUR script logic immediately ---

  function setOpen(open) {
    if (open) {
      content.classList.add('open');
      content.setAttribute('aria-hidden', 'false');
      icon.textContent = '−';
      toggle.setAttribute('aria-expanded', 'true');
    } else {
      content.classList.remove('open');
      content.setAttribute('aria-hidden', 'true');
      icon.textContent = '+';
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  // Default is closed
  setOpen(false);

  // Click
  toggle.addEventListener('click', () =>
    setOpen(!content.classList.contains('open'))
  );

  // Keyboard
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(!content.classList.contains('open'));
    }
  });

  slider.addEventListener("input", () => {
    let val = parseFloat(slider.value);
    // sticky zone near 1
    if (Math.abs(val - 1) < 0.05) val = 1;
    slider.value = val;
    sliderValue.textContent = val.toFixed(2);
    if (structureData.forces.length) {
      updateForces(val);
    }
  });
}


