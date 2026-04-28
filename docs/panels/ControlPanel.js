import { general,bondLengths,fileBrowser} from '../store.js';
import { addTrajectoryPlayer,removeTrajectoryPlayer} from './TrajectoryPanel.js';
import {removeLatticeComparisonPopup, createLatticeComparisonPopup, updateLatticeComparisonPanel} from './LatticeComparisonPanel.js';
import { removeSpins,updateSpins } from '../modules/SpinModule.js';
import { removeForces,updateForces } from '../modules/ForceModule.js';
import { removeHistogramPanel } from './AnalysisPanels/BondAnalysisPanel.js';
import {addSpinPanel,removeSpinPanel} from './SpinPanel.js';
import {addForcePanel,removeForcePanel} from './ForcePanel.js';
import {addBondPanel,removeBondPanel} from './BondPanel.js';
import {addLatticeAndSupercellPanel, removeLatticeAndSupercellPanel} from './LatticeSupercellPanel.js';
import {addFieldPanel, removeFieldPanel} from './FieldPanel.js';
import { updateAtomCutPlaneState } from '../modules/AtomsFracUpdateModule.js';
import {updateVisualization} from '../crystal-viewer.js';

/**
 * Adds the comparison panel to the TrajectoryComparisonContainer.
 */
export function addCompPanel() {
  const container = document.getElementById("TrajectoryComparisonContainer");

  // Clear existing content
  container.innerHTML = "";

  // Add toggle for bonds
  const bondToggleContainer = document.createElement("label");
  bondToggleContainer.style.display = "flex";
  bondToggleContainer.style.alignItems = "center";
  bondToggleContainer.style.margin = "10px 0";

  const bondToggleSwitch = document.createElement("span");
  bondToggleSwitch.style.position = "relative";
  bondToggleSwitch.style.display = "inline-block";
  bondToggleSwitch.style.width = "50px";
  bondToggleSwitch.style.height = "24px";

  const bondToggleInput = document.createElement("input");
  bondToggleInput.type = "checkbox";
  bondToggleInput.id = "showComparisonBonds";
  bondToggleInput.checked = true;
  bondToggleInput.style.opacity = "0";
  bondToggleInput.style.width = "0";
  bondToggleInput.style.height = "0";

  const bondToggleSlider = document.createElement("span");
  bondToggleSlider.className = "toggle_slider";
  bondToggleSlider.style.position = "absolute";
  bondToggleSlider.style.cursor = "pointer";
  bondToggleSlider.style.top = "0";
  bondToggleSlider.style.left = "0";
  bondToggleSlider.style.right = "0";
  bondToggleSlider.style.bottom = "0";
  bondToggleSlider.style.backgroundColor = "#ccc";
  bondToggleSlider.style.transition = ".4s";
  bondToggleSlider.style.borderRadius = "24px";

  const bondToggleSliderInner = document.createElement("span");
  bondToggleSliderInner.style.position = "absolute";
  bondToggleSliderInner.style.height = "16px";
  bondToggleSliderInner.style.width = "16px";
  bondToggleSliderInner.style.left = "4px";
  bondToggleSliderInner.style.bottom = "4px";
  bondToggleSliderInner.style.backgroundColor = "white";
  bondToggleSliderInner.style.transition = ".4s";
  bondToggleSliderInner.style.borderRadius = "50%";

  bondToggleSlider.appendChild(bondToggleSliderInner);
  bondToggleSwitch.appendChild(bondToggleInput);
  bondToggleSwitch.appendChild(bondToggleSlider);

  const bondToggleText = document.createElement("span");
  bondToggleText.textContent = "Show Comparison Bonds";
  bondToggleText.style.marginLeft = "10px";

  bondToggleContainer.appendChild(bondToggleSwitch);
  bondToggleContainer.appendChild(bondToggleText);
  container.appendChild(bondToggleContainer);

  // Add toggle for lattice comparison
  const latticeToggleContainer = document.createElement("label");
  latticeToggleContainer.style.display = "flex";
  latticeToggleContainer.style.alignItems = "center";
  latticeToggleContainer.style.margin = "10px 0";

  const latticeToggleSwitch = document.createElement("span");
  latticeToggleSwitch.style.position = "relative";
  latticeToggleSwitch.style.display = "inline-block";
  latticeToggleSwitch.style.width = "50px";
  latticeToggleSwitch.style.height = "24px";

  const latticeToggleInput = document.createElement("input");
  latticeToggleInput.type = "checkbox";
  latticeToggleInput.id = "showLatticeComparison";
  latticeToggleInput.style.opacity = "0";
  latticeToggleInput.style.width = "0";
  latticeToggleInput.style.height = "0";

  const latticeToggleSlider = document.createElement("span");
  latticeToggleSlider.className = "toggle_slider";
  latticeToggleSlider.style.position = "absolute";
  latticeToggleSlider.style.cursor = "pointer";
  latticeToggleSlider.style.top = "0";
  latticeToggleSlider.style.left = "0";
  latticeToggleSlider.style.right = "0";
  latticeToggleSlider.style.bottom = "0";
  latticeToggleSlider.style.backgroundColor = "#ccc";
  latticeToggleSlider.style.transition = ".4s";
  latticeToggleSlider.style.borderRadius = "24px";

  const latticeToggleSliderInner = document.createElement("span");
  latticeToggleSliderInner.style.position = "absolute";
  latticeToggleSliderInner.style.height = "16px";
  latticeToggleSliderInner.style.width = "16px";
  latticeToggleSliderInner.style.left = "4px";
  latticeToggleSliderInner.style.bottom = "4px";
  latticeToggleSliderInner.style.backgroundColor = "white";
  latticeToggleSliderInner.style.transition = ".4s";
  latticeToggleSliderInner.style.borderRadius = "50%";

  latticeToggleSlider.appendChild(latticeToggleSliderInner);
  latticeToggleSwitch.appendChild(latticeToggleInput);
  latticeToggleSwitch.appendChild(latticeToggleSlider);

  const latticeToggleText = document.createElement("span");
  latticeToggleText.textContent = "Show Lattice Comparison";
  latticeToggleText.style.marginLeft = "10px";

  latticeToggleContainer.appendChild(latticeToggleSwitch);
  latticeToggleContainer.appendChild(latticeToggleText);
  container.appendChild(latticeToggleContainer);

  // Add slider for opacity
  const opacitySliderContainer = document.createElement("div");
  opacitySliderContainer.style.display = "flex";
  opacitySliderContainer.style.flexDirection = "column";
  opacitySliderContainer.style.margin = "15px 0";
  opacitySliderContainer.style.width = "100%";

  // Create slider labels container
  const sliderLabels = document.createElement("div");
  sliderLabels.style.display = "flex";
  sliderLabels.style.justifyContent = "space-between";
  sliderLabels.style.marginBottom = "5px";
  sliderLabels.style.fontSize = "12px";
  sliderLabels.style.color = "#ccc";

  // Create left label
  const leftLabel = document.createElement("span");
  leftLabel.textContent = "Main";
  leftLabel.style.textAlign = "left";

  // Create right label
  const rightLabel = document.createElement("span");
  rightLabel.textContent = "Comp";
  rightLabel.style.textAlign = "right";

  // Add labels to container
  sliderLabels.appendChild(leftLabel);
  sliderLabels.appendChild(rightLabel);
  opacitySliderContainer.appendChild(sliderLabels);

  // Create slider
  const opacitySlider = document.createElement("input");
  opacitySlider.type = "range";
  opacitySlider.id = "opacitySlider";
  opacitySlider.min = "0";
  opacitySlider.max = "1";
  opacitySlider.step = "0.01";
  opacitySlider.value = "0.5";
  opacitySlider.style.width = "100%";
  opacitySlider.style.margin = "5px 0";
  opacitySliderContainer.appendChild(opacitySlider);

  container.appendChild(opacitySliderContainer);

  // Add dynamic style for checked state
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    #showComparisonBonds:checked + .toggle_slider {
      background-color: #4CAF50 !important;
    }
    #showComparisonBonds:checked + .toggle_slider > span {
      transform: translateX(26px) !important;
    }
    #showLatticeComparison:checked + .toggle_slider {
      background-color: #4CAF50 !important;
    }
    #showLatticeComparison:checked + .toggle_slider > span {
      transform: translateX(26px) !important;
    }
  `;
  document.head.appendChild(styleElement);

  // Add event listeners
  document.getElementById('showComparisonBonds').addEventListener('change', function() {
    const isChecked = this.checked;
    general.showSecondBond = this.checked;
    updateVisualization({
      SecondBondsUpdate: true,
      //SecondReRenderBonds: true,
    });
  });

  // Event listener for lattice comparison toggle
  document.getElementById('showLatticeComparison').addEventListener('change', function() {
    if (this.checked) {
      // Create or update the lattice comparison popup
      if (fileBrowser.comparisonStructure && fileBrowser.selectedStructure) {
        const L1 = fileBrowser.selectedStructure.lattice.map(row => [...row]);
        const L2 = fileBrowser.comparisonStructure.lattice.map(row => [...row]);
        updateLatticeComparisonPanel(L1, L2);
      }
    } else {
      // Remove the lattice comparison popup
      removeLatticeComparisonPopup();
    }
  });

  const opacitySliderElement = document.getElementById('opacitySlider');

  opacitySliderElement.addEventListener('input', function() {
    const value = parseFloat(this.value);
    if (value < 0.5){
      general.compOpacity = 2*value
      general.mainOpacity = 1.0
      }
    else if (value > 0.5){
      general.mainOpacity = 1-2 * (value - 0.5)
      general.compOpacity = 1.0
      }
    else {
      general.compOpacity =1.0
      general.mainOpacity = 1.0
    }

    updateVisualization({
      atomsUpdate: true,
      bondsUpdate: true,
      SecondBondsUpdate: true,
      SecondAtomsUpdate: true,
    });
  });
}




/**
 * Remove the comparison panel from the TrajectoryComparisonContainer.
 */
export function removeCompPanel() {
  const container = document.getElementById("TrajectoryComparisonContainer");
  container.innerHTML = "";
}


const ControlPanelModeSwitch = document.getElementById("ControlPanelModeSwitch");
export function addControlPanelModeSwitch() {
  ControlPanelModeSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;
    general.playerModeState = mode;

    // Update UI
    ControlPanelModeSwitch.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Handle different modes
    if (mode === "trajectory") {
      removeCutPlanePanel("TrajectoryComparisonContainer");
      removeCompPanel()
      removeLatticeComparisonPopup();
      console.log("Calling addTrajectoryPlayer()");
      const frames = Array.from({ length: 200 }, (_, i) => i * 0.05);
      addTrajectoryPlayer(frames);

    }
    else if (mode === "comparison") {
      removeCutPlanePanel("TrajectoryComparisonContainer");
      const trajPanel = document.getElementById("TrajControlPanel");
      updateVisualization({
        updateAtoms: true,
        updateBonds: false,
        SecondBondsUpdate: true,
        SecondAtomsUpdate: true,
      });

      if (trajPanel) {
        removeTrajectoryPlayer();
        updateVisualization({
          updateAtoms: true,
          updateBonds: true,
          SecondBondsUpdate: false,
          SecondAtomsUpdate: false,
          });
      }
      if (fileBrowser.comparisonStructure) {
        addCompPanel();
        updateVisualization({
          updateAtoms: true,
          updateBonds: true,
          SecondBondsUpdate: false,
          SecondAtomsUpdate: false,
          });
        console.log("Updating lattice comparison panel");
      }
    }
    else if (mode === "cutplanes") {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
      }
      removeCompPanel();
      removeLatticeComparisonPopup();
      addCutPlanePanel("TrajectoryComparisonContainer");
    }
    else {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
      }
      removeCutPlanePanel("TrajectoryComparisonContainer");
      removeCompPanel()
      removeLatticeComparisonPopup();
    }
    console.log("Current mode:", general.playerModeState);
  });
}


const ControlPanelSpinForceSwitch = document.getElementById("ControlPanelSpinForceSwitch");
export function addControlPanelSpinForceSwitch() {

  ControlPanelSpinForceSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;
    general.spinForceState = mode;

    // Update UI
    ControlPanelSpinForceSwitch.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Handle different modes
    if (general.spinForceState == "Forces") {
      removeSpins();
      removeSpinPanel()
      removeFieldPanel();
      addForcePanel()
      updateForces();
      }
    else if (general.spinForceState == "Spins") {
      addSpinPanel();
      updateSpins();
      removeForcePanel();
      removeFieldPanel();
      removeForces();
        }
    else if (general.spinForceState == "Field") {
      removeSpinPanel();
      removeForcePanel();
      removeForces();
      removeSpins();
      addFieldPanel();
        }
    else {
      //removeForces
      removeSpins();
      removeSpinPanel();
      removeForcePanel();
      removeFieldPanel();
      removeForces()
      //remove  vectorFieldPanel();
    }
  });
}

export function addControlPanelAnalysisSwitch() {
  ControlPanelAnalysisSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;
    general.analysisState = mode;

    // Update UI
    ControlPanelAnalysisSwitch.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Handle different modes
    if (general.analysisState == "Lattice") {
      console.warn("Lattice analysis not yet implemented!")
      removeHistogramPanel()
      removeBondPanel()
      removeCutPlanePanel()
      addLatticeAndSupercellPanel()
    }
    else if (general.analysisState == "Bonds") {
      addBondPanel()
      removeCutPlanePanel()
      removeLatticeAndSupercellPanel()
     }
    else if (general.analysisState == "Polyhedra") {
      removeBondPanel()
      console.warn("Polyhedera analysis not yet implemented!")
      removeHistogramPanel()
      removeLatticeAndSupercellPanel()
    }
    else {
      removeHistogramPanel()
      removeBondPanel()
      removeLatticeAndSupercellPanel()
    }
  });
}

export function addCutPlanePanel(target = "TrajectoryComparisonContainer") {
  const container = document.getElementById(target);
  if (!container) return;
  removeCutPlanePanel(target);
  general.atomCutPlanes ||= [];

  const maxAbsCoordinate = (() => {
    const wrappedCart = fileBrowser.selectedStructure?.periodic?.wrapped?.cart;
    const positions = wrappedCart?.length
      ? wrappedCart
      : fileBrowser.selectedStructure?.atoms?.map((atom) => atom.position) || [];
    let maxValue = 0;
    positions.forEach((position) => {
      position.forEach((value) => {
        maxValue = Math.max(maxValue, Math.abs(Number(value) || 0));
      });
    });
    return Math.max(5, Math.ceil(maxValue || 5));
  })();

  const panel = document.createElement('div');
  panel.id = 'cutPlanePanel';
  panel.style.cssText = `
    margin-top: 10px;
    padding: 10px;
    border-radius: 10px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    overflow: hidden;
  `;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;';

  const title = document.createElement('div');
  title.textContent = 'Cut Planes';
  title.style.cssText = 'font-size:13px; font-weight:600; color:#f3f3f3;';

  const addButton = document.createElement('button');
  addButton.textContent = 'Add Plane';
  addButton.className = 'btn-mini highlight';
  addButton.style.cssText = 'height: 28px; padding: 0 10px; font-size: 11px;';

  const hint = document.createElement('div');
  hint.textContent = 'Use normal (x, y, z), distance r, and left/right masking. "Keep" is controlled per atom in the info panel.';
  hint.style.cssText = 'font-size:10px; color: rgba(255,255,255,0.62); margin-bottom:8px; line-height:1.35;';

  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  const editor = document.createElement('div');
  editor.style.cssText = 'margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; gap:8px;';
  let selectedPlaneIndex = general.atomCutPlanes.length ? general.atomCutPlanes.length - 1 : -1;

  const syncCutPlanes = () => {
    updateAtomCutPlaneState();
    updateVisualization({
      atomsUpdate: false,
      bondsUpdate: false,
      reRenderAtoms: false,
      reRenderBonds: false,
      reRenderLattice: false,
      reRenderOther: false,
      reRenderComposition: false,
    });
  };

  function clampSliderValue(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(min, Math.min(max, numeric));
  }

  function formatPlaneSummary(plane) {
    return `n=(${Math.round(plane.x ?? 0)}, ${Math.round(plane.y ?? 0)}, ${Math.round(plane.z ?? 0)})  r=${(plane.r ?? 0).toFixed(2)}  ${plane.side || 'left'}`;
  }

  const renderEditor = () => {
    editor.innerHTML = '';
    const plane = general.atomCutPlanes[selectedPlaneIndex];
    if (!plane) {
      const empty = document.createElement('div');
      empty.textContent = 'Add a plane to edit its sliders.';
      empty.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.55);';
      editor.appendChild(empty);
      return;
    }

    const selectedLabel = document.createElement('div');
    selectedLabel.textContent = `Editing plane ${selectedPlaneIndex + 1}`;
    selectedLabel.style.cssText = 'font-size:11px; font-weight:600; color:#f3f3f3;';

    const controlRow = document.createElement('div');
    controlRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;';

    const enabledLabel = document.createElement('label');
    enabledLabel.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; color:#ddd;';
    const enabledToggle = document.createElement('input');
    enabledToggle.type = 'checkbox';
    enabledToggle.checked = !!plane.enabled;
    const enabledText = document.createElement('span');
    enabledText.textContent = 'Enabled';
    enabledLabel.appendChild(enabledToggle);
    enabledLabel.appendChild(enabledText);

    const side = document.createElement('select');
    ['left', 'right'].forEach((sideName) => {
      const option = document.createElement('option');
      option.value = sideName;
      option.textContent = sideName;
      if ((plane.side || 'left') === sideName) option.selected = true;
      side.appendChild(option);
    });
    side.style.cssText = 'height:28px; min-width:88px; background: rgba(0,0,0,0.28); color:#fff; border:1px solid rgba(255,255,255,0.12); border-radius:6px;';

    enabledToggle.onchange = () => {
      plane.enabled = enabledToggle.checked;
      syncCutPlanes();
      renderPlaneRows();
    };
    side.onchange = () => {
      plane.side = side.value;
      syncCutPlanes();
      renderPlaneRows();
    };

    controlRow.appendChild(enabledLabel);
    controlRow.appendChild(side);

    editor.appendChild(selectedLabel);
    editor.appendChild(controlRow);

    [
      { key: 'x', label: 'X', min: -3, max: 3, step: 1, format: (value) => String(Math.round(value)) },
      { key: 'y', label: 'Y', min: -3, max: 3, step: 1, format: (value) => String(Math.round(value)) },
      { key: 'z', label: 'Z', min: -3, max: 3, step: 1, format: (value) => String(Math.round(value)) },
      { key: 'r', label: 'R', min: -maxAbsCoordinate, max: maxAbsCoordinate, step: 0.05 },
    ].forEach((spec) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid; grid-template-columns: 18px 1fr 56px; gap:8px; align-items:center;';

      const label = document.createElement('span');
      label.textContent = spec.label;
      label.style.cssText = 'font-size:11px; color:#ddd; font-weight:600;';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String(spec.step);
      slider.value = String(clampSliderValue(plane[spec.key], spec.min, spec.max));
      slider.style.cssText = 'width:100%; min-width:0;';

      const value = document.createElement('input');
      value.type = 'text';
      value.inputMode = 'decimal';
      value.value = spec.format
        ? spec.format(Number(plane[spec.key] ?? 0))
        : Number(plane[spec.key] ?? 0).toFixed(2);
      value.style.cssText = 'height:28px; width:56px; padding: 4px 6px; background: rgba(0,0,0,0.28); color:#fff; border:1px solid rgba(255,255,255,0.12); border-radius:6px; box-sizing:border-box; text-align:center;';

      const commit = (rawValue, { refreshRows = false } = {}) => {
        let numeric = clampSliderValue(rawValue, spec.min, spec.max);
        if (spec.step === 1) {
          numeric = Math.round(numeric);
        }
        plane[spec.key] = numeric;
        slider.value = String(numeric);
        value.value = spec.format ? spec.format(numeric) : numeric.toFixed(2);
        syncCutPlanes();
        if (refreshRows) {
          renderPlaneRows();
        }
      };

      slider.oninput = () => commit(slider.value);
      slider.onchange = () => commit(slider.value, { refreshRows: true });
      value.onchange = () => commit(value.value, { refreshRows: true });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(value);
      editor.appendChild(row);
    });
  };

  const renderPlaneRows = () => {
    list.innerHTML = '';
    if (general.atomCutPlanes.length === 0) {
      selectedPlaneIndex = -1;
      const empty = document.createElement('div');
      empty.textContent = 'No cut planes';
      empty.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.55);';
      list.appendChild(empty);
      renderEditor();
      return;
    }

    if (selectedPlaneIndex < 0 || selectedPlaneIndex >= general.atomCutPlanes.length) {
      selectedPlaneIndex = general.atomCutPlanes.length - 1;
    }

    general.atomCutPlanes.forEach((plane, index) => {
      const row = document.createElement('div');
      const isSelected = index === selectedPlaneIndex;
      row.style.cssText = `
        display:grid;
        grid-template-columns: 18px minmax(0,1fr) auto;
        gap:8px;
        align-items:center;
        width:100%;
        padding:6px 8px;
        border-radius:8px;
        background:${isSelected ? 'rgba(17,128,57,0.16)' : 'rgba(255,255,255,0.02)'};
        border:1px solid ${isSelected ? 'rgba(17,128,57,0.45)' : 'rgba(255,255,255,0.06)'};
        box-sizing:border-box;
      `;

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = !!plane.enabled;
      enabled.style.margin = '0';

      const body = document.createElement('div');
      body.style.cssText = 'min-width:0; overflow:hidden;';
      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.textContent = `Plane ${index + 1}`;
      selectButton.style.cssText = `border:none; background:transparent; color:${isSelected ? '#e9fff1' : 'rgba(255,255,255,0.86)'}; text-align:left; min-width:0; padding:0; cursor:pointer;`;
      const summary = document.createElement('div');
      summary.textContent = formatPlaneSummary(plane);
      summary.style.cssText = 'font-size:10px; color: rgba(255,255,255,0.62); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px;';
      body.appendChild(selectButton);
      body.appendChild(summary);

      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.className = 'btn-mini';
      remove.style.cssText = 'height: 28px; padding: 0 8px; font-size: 11px; min-width:64px;';

      enabled.onchange = () => {
        plane.enabled = enabled.checked;
        syncCutPlanes();
        renderEditor();
        renderPlaneRows();
      };
      selectButton.onclick = () => {
        selectedPlaneIndex = index;
        renderPlaneRows();
        renderEditor();
      };
      remove.onclick = () => {
        general.atomCutPlanes.splice(index, 1);
        if (selectedPlaneIndex >= general.atomCutPlanes.length) {
          selectedPlaneIndex = general.atomCutPlanes.length - 1;
        }
        renderPlaneRows();
        syncCutPlanes();
      };

      row.appendChild(enabled);
      row.appendChild(body);
      row.appendChild(remove);
      list.appendChild(row);
    });
    renderEditor();
  };

  addButton.onclick = () => {
    general.atomCutPlanes.push({ enabled: true, x: 1, y: 0, z: 0, r: 0, side: 'left' });
    selectedPlaneIndex = general.atomCutPlanes.length - 1;
    renderPlaneRows();
    syncCutPlanes();
  };

  header.appendChild(title);
  header.appendChild(addButton);
  panel.appendChild(header);
  panel.appendChild(hint);
  panel.appendChild(list);
  panel.appendChild(editor);
  container.appendChild(panel);
  renderPlaneRows();
}

export function removeCutPlanePanel(target = "TrajectoryComparisonContainer") {
  document.getElementById(target)?.querySelector('#cutPlanePanel')?.remove();
}


export function resetSwitch(switchContainer, stateKey, defaultMode = "None") {
  // Update internal state
  general[stateKey] = defaultMode;

  // Remove active class from all buttons
  const buttons = switchContainer.querySelectorAll("button");
  buttons.forEach(btn => btn.classList.remove("active"));

  // Find button with matching data-mode (case-insensitive)
  const defaultBtn = Array.from(buttons).find(
    btn => btn.dataset.mode && btn.dataset.mode.trim().toLowerCase() === defaultMode.toLowerCase()
  );

  if (defaultBtn) {
    defaultBtn.classList.add("active");
  } else {
    console.warn(`No button with data-mode="${defaultMode}" found in`, switchContainer);
  }
}

// Convenience functions
export function resetSpinForceSwitch() {
  resetSwitch(ControlPanelSpinForceSwitch, "spinForceState", "None");
}

export function resetModeSwitch() {
  resetSwitch(ControlPanelModeSwitch, "modeState", "None");
  removeTrajectoryPlayer();
}
