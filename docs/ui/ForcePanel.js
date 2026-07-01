import { general, fileBrowser } from '../state/store.js';
import { updateForces, removeForces } from '../render/index.js';


export function removeForcePanel() {
  const el = document.getElementById("forceControlsGroup");
  if (el) el.remove();
}

export function addForcePanel(target = "cvPanelBody-forces") {
  if (document.getElementById("forceControlsGroup")) return;
  const targetPanel = document.getElementById(target);
  if (!targetPanel) { console.warn("ForcePanel: target not found:", target); return; }

  // Outer wrapper. The hosting panel window (ui/panels/) provides the title
  // bar and collapse, so no header is built here.
  const group = document.createElement("div");
  group.id = "forceControlsGroup";

  // --- Panel ---
  const panel = document.createElement("div");
  panel.id = "forcePanel";

  const content = document.createElement("div");
  content.id = "forceControlsContent";

  // Master activation toggle: expanding the panel only shows the controls;
  // drawing the force arrows is this explicit switch.
  const showWrapper = document.createElement("label");
  showWrapper.className = "toggle_row toggle_container";

  const showSwitch = document.createElement("span");
  showSwitch.className = "toggle_switch";

  const showCheckbox = document.createElement("input");
  showCheckbox.type = "checkbox";
  showCheckbox.id = "showForcesToggle";
  showCheckbox.checked = !!general.forcesActive;

  const showSlider = document.createElement("span");
  showSlider.className = "toggle_slider";

  showSwitch.appendChild(showCheckbox);
  showSwitch.appendChild(showSlider);

  const showText = document.createElement("span");
  showText.className = "toggle_text";
  showText.textContent = "Show Forces";

  showWrapper.appendChild(showSwitch);
  showWrapper.appendChild(showText);
  content.appendChild(showWrapper);

  // Force Length Scale slider
  const sliderWrapper = document.createElement("div");
  sliderWrapper.style.marginBottom = "8px";
  const sliderLabel = document.createElement("label");
  sliderLabel.textContent = "Scaling Factor: ";
  const sliderValue = document.createElement("span");
  sliderValue.textContent = (general.forceScale ?? 1.0).toFixed(2);
  sliderValue.style.marginRight = "8px";
  const slider = /** @type {any} */ (document.createElement("input"));
  slider.type = "range";
  slider.min = 0.1; slider.max = 10; slider.step = 0.1;
  slider.value = general.forceScale ?? 1.0;
  sliderWrapper.appendChild(sliderLabel);
  sliderWrapper.appendChild(sliderValue);
  sliderWrapper.appendChild(slider);
  content.appendChild(sliderWrapper);

  // Arrow Width slider
  const widthWrapper = document.createElement("div");
  widthWrapper.style.marginBottom = "8px";
  const widthLabel = document.createElement("label");
  widthLabel.textContent = "Arrow Width: ";
  const widthValue = document.createElement("span");
  widthValue.textContent = (general.forceRadius ?? 0.1).toFixed(2);
  widthValue.style.marginRight = "8px";
  const widthSlider = /** @type {any} */ (document.createElement("input"));
  widthSlider.type = "range";
  widthSlider.min = 0.01; widthSlider.max = 0.15; widthSlider.step = 0.01;
  widthSlider.value = general.forceRadius ?? 0.1;
  widthWrapper.appendChild(widthLabel);
  widthWrapper.appendChild(widthValue);
  widthWrapper.appendChild(widthSlider);
  content.appendChild(widthWrapper);

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.id = "deleteForces";
  deleteBtn.className = "reset-btn";
  deleteBtn.textContent = "Delete Forces";
  deleteBtn.style.marginBottom = "10px";
  content.appendChild(deleteBtn);

  // Manual force text input
  const textLabel = document.createElement("div");
  textLabel.textContent = "Manual Force Vectors (x y z per atom):";
  textLabel.style.fontSize = "11px";
  textLabel.style.marginBottom = "4px";
  content.appendChild(textLabel);

  const textarea = document.createElement("textarea");
  textarea.id = "forceTextInput";
  textarea.placeholder = "x y z\nExample:\n0.1 0.2 -0.3\n0 0 1.5";
  textarea.style.width = "95%";
  textarea.style.height = "100px";
  textarea.style.background = "rgba(16,16,16,0.8)";
  textarea.style.color = "rgb(255,255,255)";
  textarea.style.border = "1px solid #555";
  textarea.style.fontFamily = "monospace";
  textarea.style.fontSize = "12px";
  content.appendChild(textarea);

  const drawBtn = document.createElement("button");
  drawBtn.textContent = "Draw Forces";
  drawBtn.className = "btn-mini highlight";
  drawBtn.style.marginTop = "6px";
  content.appendChild(drawBtn);

  // Build hierarchy
  panel.appendChild(content);
  group.appendChild(panel);
  targetPanel.appendChild(group);

  // --- Events ---
  showCheckbox.addEventListener("change", () => {
    general.forcesActive = showCheckbox.checked;
    if (showCheckbox.checked && fileBrowser.selectedStructure?.forces?.length) {
      updateForces(general.forceScale ?? 1.0);
    } else {
      removeForces();
    }
  });

  slider.addEventListener("input", () => {
    let val = parseFloat(slider.value);
    if (Math.abs(val - 1) < 0.05) val = 1;
    slider.value = val;
    sliderValue.textContent = val.toFixed(2);
    general.forceScale = val;
    if (fileBrowser.selectedStructure?.forces?.length) updateForces(val);
  });

  widthSlider.addEventListener("input", () => {
    const val = parseFloat(widthSlider.value);
    widthValue.textContent = val.toFixed(2);
    general.forceRadius = val;
    if (fileBrowser.selectedStructure?.forces?.length) updateForces(general.forceScale ?? 1.0);
  });

  deleteBtn.addEventListener("click", () => {
    const s = fileBrowser.selectedStructure;
    if (s) s.forces = [];
    removeForces();
  });

  drawBtn.addEventListener("click", () => {
    const s = fileBrowser.selectedStructure;
    if (!s) return;
    const forces = [];
    textarea.value.trim().split("\n").filter(Boolean).forEach(line => {
      const p = line.trim().split(/\s+/);
      if (p.length < 3) return;
      const x = parseFloat(p[0]), y = parseFloat(p[1]), z = parseFloat(p[2]);
      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) forces.push({ vector: [x, y, z] });
    });
    if (forces.length === 0) return;
    s.forces = forces;
    updateForces(general.forceScale ?? 1.0);
  });
}
