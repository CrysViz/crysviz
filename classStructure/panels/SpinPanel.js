import { createColorPicker } from '../old_style/color-picker.js';
import {updateSpins,deleteSpins} from '../modules/SpinModule.js';
import { app, groups, general,spinsData, structureData, mode, atomicRadii,getLatticeVisSettings,getAtomVisSettings} from '../store.js';


export function removeSpinPanel() {
  const panel = document.getElementById("spinControlsGroup");
  if (panel) {
    panel.remove();
  } else {
    console.warn("Spin Controls panel does not exist.");
  }
}

export function addSpinPanel(target = "SpinForceContainer") {
  const targetPanel = document.getElementById(target);
  if (document.getElementById("spinControlsGroup")) {
    console.warn("Spin Controls already exist.");
    return;
  }

  // --- Outer wrapper ---
  const group = document.createElement("div");
  group.id = "spinControlsGroup";

  // --- Panel ---
  const panel = document.createElement("div");
  panel.id = "spinPanel";

  // --- Toggle ---
  const toggle = document.createElement("div");
  toggle.id = "spinToggle";
  toggle.className = "spin-toggle";
  toggle.setAttribute("role", "button");
  toggle.setAttribute("tabindex", "0");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "spinControlsContent");

  const title = document.createElement("h4");
  title.textContent = "Spin Controls";

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
  resetWrapper.id = "resetSpinLenghtsWrapper";
  resetWrapper.className = "bottonWrapper";
  resetWrapper.setAttribute("aria-hidden", "true");

  const deleteBtn = document.createElement("button");
  deleteBtn.id = "deleteSpins";
  deleteBtn.className = "reset-btn";
  deleteBtn.textContent = "Delete Spins";

  resetWrapper.appendChild(deleteBtn);

  // --- Spin Controls container ---
  const spinControls = document.createElement("div");
  spinControls.id = "spinControls";

  // Build hierarchy
  content.appendChild(resetWrapper);
  content.appendChild(spinControls);
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
}


export function createSpinControls(containerId = "spinControls") {
  const container = document.getElementById(containerId);
  container.innerHTML = ""; // Clear previous controls

  // ----- 1 Input Mode Toggle -----
  const toggleWrapper = document.createElement("tablist");
  toggleWrapper.className = "spin-input-mode-toggle";
  toggleWrapper.style.marginBottom = "6px";

  const textModeBtn = document.createElement("button");
  textModeBtn.textContent = "Text Input";
  textModeBtn.className = "spin-input-mode-btn active";
  textModeBtn.disabled = true;

  const viewerModeBtn = document.createElement("button");
  viewerModeBtn.textContent = "Spin Viewer";
  viewerModeBtn.className = "spin-input-mode-btn";

  toggleWrapper.appendChild(textModeBtn);
  toggleWrapper.appendChild(viewerModeBtn);
  container.appendChild(toggleWrapper);

  // ----- 2 Slider for scaling arrows -----
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
  container.appendChild(sliderWrapper);

  // ----- 3 Text Input Panel -----
  const textPanel = document.createElement("div");
  const textarea = document.createElement("textarea");
  textarea.id="textArea";
  textarea.placeholder = "x y z scale color\nExample:\n0 0 1 0.5 #ff0000\n1 1 0 2.0 #0000ff";
  textarea.style.width = "95%";
  textarea.style.height = "200px";
  textarea.style.background= "rgba(16,16,16,0.8)";
  textarea.style.color= "rgb(255, 255, 255)";
  textPanel.appendChild(textarea);


  const drawBtn = document.createElement("button");
  drawBtn.textContent = "Draw Spins";
  drawBtn.style.marginTop = "6px";
  textPanel.appendChild(drawBtn);
  container.appendChild(textPanel);

  // ----- 4 Viewer Panel -----
  const viewerPanel = document.createElement("div");
  viewerPanel.style.display = "none";
  container.appendChild(viewerPanel);

  // ----- 5 Mode Switch -----
  textModeBtn.addEventListener("click", () => {
    textModeBtn.className = "spin-input-mode-btn active";
    viewerModeBtn.className = "spin-input-mode-btn";
    textPanel.style.display = "block";
    viewerPanel.style.display = "none";
    textModeBtn.disabled = true;
    viewerModeBtn.disabled = false;
  });

  viewerModeBtn.addEventListener("click", () => {
    textModeBtn.className = "spin-input-mode-btn";
    viewerModeBtn.className = "spin-input-mode-btn active";
    textPanel.style.display = "none";
    viewerPanel.style.display = "block";
    textModeBtn.disabled = false;
    viewerModeBtn.disabled = true;
    populateSpinViewer();
  });

  // ----- 6 Slider live updates -----
  slider.addEventListener("input", () => {
    let val = parseFloat(slider.value);
    // sticky zone near 1
    if (Math.abs(val - 1) < 0.05) val = 1;
    slider.value = val;
    sliderValue.textContent = val.toFixed(2);
    if (structureData.spins.length) {
      updateSpins(val);
    }
  });

  // ----- 7 Parse input & draw -----
  drawBtn.addEventListener("click", drawSpinsFromInput);
  drawBtn.className="btn-mini highlight"

  function drawSpinsFromInput() {
    const input = textarea.value.trim().split("\n").filter(Boolean);
    const spins = [];
    let scalingFactor = null;
    let color = null;

    input.forEach((line, i) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) return; // ignore invalid lines

      const x = parseFloat(parts[0]);
      const y = parseFloat(parts[1]);
      const z = parseFloat(parts[2]);

      if (/^-?\d+(\.\d+)?$/.test(parts[3])) {
        scalingFactor = parseFloat(parts[3]);
        color = parts[4] || "#000000";
       }
      else {
        scalingFactor = 1.0;
        color = parts[3] || "#000000";
      }

      spins.push({
        atomIndex: i,
        vector: [x, y, z],
        scalingFactor,
        color
      });
    });

    let deleteBtn = document.getElementById("deleteSpins")
    if (deleteBtn){
    console.log("Delete Spin Button Initialised")
    deleteBtn.addEventListener("click",(e) => {
               console.log("Delete Spin Clicked")
               e.stopPropagation();
               deleteSpins();
        });
    };



    if (spinsData?.length != null) {
      spinsData.length = 0;
    }

    spinsData.push(...spins);
    updateSpins(parseFloat(slider.value));
  }

function populateSpinViewer() {
  // Inject CSS to hide native spin buttons (only once)
  if (!document.getElementById("hide-native-spin-buttons-style")) {
    const style = document.createElement("style");
    style.id = "hide-native-spin-buttons-style";
    style.textContent = `
      /* Hide native spin buttons in WebKit browsers */
      input[type="number"]::-webkit-inner-spin-button,
      input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      /* Hide native spin buttons in Firefox */
      input[type="number"] {
        -moz-appearance: textfield;
      }
    `;
    document.head.appendChild(style);
  }

  viewerPanel.innerHTML = "";
  if (spinsData===null) {
    viewerPanel.textContent = "No spins defined yet.";
    return;
  }
  // Helper: create custom number input with vertically stacked buttons
  function createCustomNumberInput(value, step, onChange) {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "4px";

    const input = document.createElement("input");
    input.type = "number";
    input.value = value.toFixed(2);
    input.step = step;
    input.style.width = "40px";
    input.style.backgroundColor = "#333";
    input.style.color = "white";
    input.style.border = "1px solid #ccc";
    input.style.fontFamily = "monospace";
    input.style.padding = "2px 6px";
    input.style.textAlign = "right";
    input.style.fontSize = "12px";
    input.style.outline = "none";

    input.addEventListener("keydown", e => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
    });

    // Container for vertical buttons
    const btnContainer = document.createElement("div");
    btnContainer.style.display = "flex";
    btnContainer.style.flexDirection = "column";
    btnContainer.style.justifyContent = "center";
    btnContainer.style.border = "1px solid #444";
    btnContainer.style.borderRadius = "4px";
    btnContainer.style.overflow = "hidden";
    btnContainer.style.height = "32px"; // approx input height
    btnContainer.style.width = "16px";
    btnContainer.style.backgroundColor = "#222";
       const btnUp = document.createElement("button");
    btnUp.type = "button";
    btnUp.textContent = "▲";
    btnUp.style.cssText = `
      background: transparent;
      color: white;
      border: none;
      padding: 0;
      margin: 0;
      flex: 1;
      cursor: pointer;
      font-size: 10px;
      line-height: 1;
      user-select: none;
    `;

  btnUp.addEventListener("mouseenter", () => {
    btnUp.style.backgroundColor = "#555";
  });
  btnUp.addEventListener("mouseleave", () => {
    btnUp.style.backgroundColor = "transparent";
  });

  const btnDown = document.createElement("button");
  btnDown.type = "button";
  btnDown.textContent = "▼";
  btnDown.style.cssText = btnUp.style.cssText;
  btnDown.addEventListener("mouseenter", () => {
    btnDown.style.backgroundColor = "#555";
  });
  btnDown.addEventListener("mouseleave", () => {
    btnDown.style.backgroundColor = "transparent";
  });

   // Press-and-hold logic
  let intervalId;

  function changeValue(delta) {
    let newVal = parseFloat(input.value) + delta;
    if (isNaN(newVal)) newVal = value;
    input.value = newVal.toFixed(3);
    onChange(newVal);
  }

  btnUp.addEventListener("mousedown", () => {
    changeValue(parseFloat(step));
    intervalId = setInterval(() => changeValue(parseFloat(step)), 100);
  });
  btnUp.addEventListener("mouseup", () => clearInterval(intervalId));
  btnUp.addEventListener("mouseleave", () => clearInterval(intervalId));

  btnDown.addEventListener("mousedown", () => {
    changeValue(-parseFloat(step));
    intervalId = setInterval(() => changeValue(-parseFloat(step)), 100);
  });
  btnDown.addEventListener("mouseup", () => clearInterval(intervalId));
  btnDown.addEventListener("mouseleave", () => clearInterval(intervalId));


    btnContainer.appendChild(btnUp);
    btnContainer.appendChild(btnDown);
    wrapper.appendChild(input);
    wrapper.appendChild(btnContainer);

    return wrapper;
  }

  const table = document.createElement("table");
  table.style.width = "auto";
  table.style.maxWidth = "100%";
  table.style.borderCollapse = "collapse";
  table.style.backgroundColor = "transparent";

  const header = document.createElement("tr");
  ["Idx", "X", "Y", "Z", "Scale", "Color"].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    th.style.borderBottom = "1px solid #aaa";
    th.style.padding = "2px 2px";
    th.style.color = "white";
    th.style.fontSize = "12px";
    th.style.width = "fit-content";
    header.appendChild(th);
  });
  table.appendChild(header);

  spinsData.forEach((spin) => {
    const row = document.createElement("tr");

    // Index cell
    const tdIdx = document.createElement("td");
    tdIdx.textContent = spin.atomIndex;
    tdIdx.style.padding = "2px 2px";
    tdIdx.style.color = "white";
    tdIdx.style.fontSize = "14px";
    row.appendChild(tdIdx);

    // Vector components (custom inputs with vertical buttons)
    spin.vector.forEach((val, comp) => {
      const td = document.createElement("td");
      td.style.padding = "2px 2px";

      const customInput = createCustomNumberInput(val, 0.01, newVal => {
        spin.vector[comp] = newVal;
        updateSpins(parseFloat(slider.value));
      });

      td.appendChild(customInput);
      row.appendChild(td);
    });

    // Scale input with custom buttons
    const tdScale = document.createElement("td");
    tdScale.style.padding = "2px 2px";

    const customScaleInput = createCustomNumberInput(spin.scalingFactor, 0.01, newVal => {
      spin.scalingFactor = newVal;
      updateSpins(parseFloat(slider.value));
    });

    tdScale.appendChild(customScaleInput);
    row.appendChild(tdScale);

    // Color dot centered with white border
    const tdColor = document.createElement("td");
    tdColor.style.padding = "10px 6px";
    tdColor.style.display = "flex";
    tdColor.style.justifyContent = "center";
    tdColor.style.alignItems = "center";

    const dot = document.createElement("span");
    dot.style.display = "inline-block";
    dot.style.width = "16px";
    dot.style.height = "16px";
    dot.style.borderRadius = "50%";
    dot.style.backgroundColor = spin.color;
    dot.style.border = "2px solid white";
    dot.style.cursor = "pointer";

    dot.addEventListener("click", () => openColorPicker(spin, dot));

    tdColor.appendChild(dot);
    row.appendChild(tdColor);

    table.appendChild(row);
  });

  viewerPanel.appendChild(table);

}
function openColorPicker(spin, dot) {
  // Remove any existing picker first
  document.querySelectorAll(".spin-color-picker").forEach(p => p.remove());

  // --- Helper: ensure color is in valid hex format ---
  function toHexColor(color) {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = color;
    return ctx.fillStyle.startsWith("#") ? ctx.fillStyle : "#000000";
  }

  const currentHex = toHexColor(spin.color || "#000000");
  let selectedHex = currentHex;

  // --- Create main picker container ---
  const pickerPanel = document.createElement("div");
  pickerPanel.className = "spin-color-picker";
  Object.assign(pickerPanel.style, {
    position: "absolute",
    background: "rgba(26,26,26,0.8)",
    border: "1px solid #ccc",
    padding: "10px",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    zIndex: 9999,
  });

   // --- Create the color picker using external helper ---
  const { element: pickerElement } = createColorPicker(currentHex, (hex) => {
    selectedHex = hex;
    dot.style.background = hex; // live preview
  });

  // --- Apply / Reset Buttons ---
  const buttonRow = document.createElement("div");
  Object.assign(buttonRow.style, {
    display: "flex",
    justifyContent: "space-between",
    marginTop: "10px",
    gap: "8px"
  });

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset";
  resetBtn.className="reset-btn"

  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply";
  applyBtn.className="btn-mini highlight"

  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  pickerPanel.appendChild(pickerElement);
  pickerPanel.appendChild(buttonRow);
  document.body.appendChild(pickerPanel);

  // --- Position near the clicked dot ---
  const rect = dot.getBoundingClientRect();
  let topPosition = rect.top + window.scrollY - 200;
  let bottomSpace = window.innerHeight - (rect.top + window.scrollY + 24 + pickerPanel.offsetHeight);

  // Ensure at least 40px space at the bottom of the screen
  if (bottomSpace < 40) {
      topPosition = window.innerHeight - pickerPanel.offsetHeight - 40; // Move it up so it has 40px from the bottom
  }

  pickerPanel.style.left = `${rect.left + window.scrollX + 24}px`;
  pickerPanel.style.top = `${topPosition}px`;
 // --- Close picker helper ---
  const closePicker = () => {
    pickerPanel.remove();
    document.removeEventListener("mousedown", outsideClick);
  };

  // --- Handle outside clicks ---
  const outsideClick = (e) => {
    if (!pickerPanel.contains(e.target) && e.target !== dot) closePicker();
  };

  document.addEventListener("mousedown", outsideClick);
  pickerPanel.addEventListener("mousedown", (e) => e.stopPropagation());

  // --- Apply button behavior ---
  applyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    spin.color = selectedHex;
    dot.style.backgroundColor = selectedHex;
    updateSpins(parseFloat(slider.value));
    closePicker();
  });

  // --- Reset button behavior ---
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedHex = "#000000";
    spin.color = selectedHex;
    dot.style.backgroundColor = selectedHex;
    updateSpins(parseFloat(slider.value));
    closePicker();
  });
}
}
