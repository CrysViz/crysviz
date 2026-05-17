import { measurements, app, fileBrowser, general } from '../store.js';
import { Plane, CutModes, getCutPlaneSideLabel, getPlaneCutModeLabel, getPlaneDefinitionNormalAndD, normalizePlaneCutMode, CartesianParamsToMillerInds, PLANE_VIS_NONE, PLANE_VIS_FIELD } from '../classes/Plane.js';
import { fieldBrowser } from './FieldPanel.js';
import { updateAtomCutPlaneState } from '../modules/AtomsFracUpdateModule.js';
import { updateVisualization } from '../crystal-viewer.js';

export const planesData = {
  activeInputMode: 'hkl', // 'hkl' or 'uvwd'
  showPlanes: true,
  calculateFromAtomsEnabled: false,
};

const structurePlaneMeshes = new WeakMap();
let activeRenderedStructure = null;
let selectedPlaneIndex = null;

function getSelectedStructure() {
  return fileBrowser.selectedStructure || null;
}

function ensureStructurePlaneState(structure) {
  if (!structure) return;
  if (!Array.isArray(structure.planes)) structure.planes = [];
}

function getSelectedStructurePlanes() {
  const structure = getSelectedStructure();
  if (!structure || !Array.isArray(structure.planes)) return [];
  return structure.planes;
}

function getStructureMeshMap(structure) {
  let meshMap = structurePlaneMeshes.get(structure);
  if (!meshMap) {
    meshMap = new Map();
    structurePlaneMeshes.set(structure, meshMap);
  }
  return meshMap;
}

function removePlaneMesh(structure, planeDef) {
  if (!structure) return;
  const meshMap = getStructureMeshMap(structure);
  const mesh = meshMap.get(planeDef);
  if (!mesh) return;
  app.scene?.remove(mesh);
  if (typeof mesh.dispose === 'function') {
    mesh.dispose();
  }
  meshMap.delete(planeDef);
}

function replacePlaneMesh(structure, planeDef) {
  if (!structure || !planeDef || !app.scene) return;
  removePlaneMesh(structure, planeDef);

  const lattice = structure.lattice;
  if (!Array.isArray(lattice) || lattice.length !== 3) return;

  const { normal, d } = getPlaneDefinitionNormalAndD(planeDef, lattice);
  if (!Array.isArray(normal) || normal.length !== 3) {
    return;
  }
  if (Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]) < 1e-12) {
    return;
  }

  const planeMesh = new Plane({
    normal,
    d,
    cell: lattice,
    mode: planeDef.visualization || 'None',
    field: planeDef.field || null,
    colormap: planeDef.colormap || 'cooltowarm',
  });

  planeMesh.visible = Boolean(planesData.showPlanes && planeDef.enabled);
  app.scene.add(planeMesh);
  getStructureMeshMap(structure).set(planeDef, planeMesh);
}

function clearRenderedPlanesForStructure(structure) {
  if (!structure || !app.scene) return;
  const meshMap = getStructureMeshMap(structure);
  meshMap.forEach(mesh => {
    app.scene.remove(mesh);
    if (typeof mesh.dispose === 'function') {
      mesh.dispose();
    }
  });
  meshMap.clear();
}

function bindPanelStateToSelectedStructure() {
  const structure = getSelectedStructure();
  if (!structure) return;

  ensureStructurePlaneState(structure);
}

function refreshCurrentStructurePlanesInScene() {
  const structure = getSelectedStructure();
  if (!structure) return;

  clearRenderedPlanesForStructure(structure);
  structure.planes.forEach(planeDef => replacePlaneMesh(structure, planeDef));
}

function syncAtomCutPlanesFromSelectedStructure() {
  const structure = getSelectedStructure();
  const retainedPlanes = (general.atomCutPlanes || []).filter(
    plane => plane?.source !== 'structure-plane'
  );

  if (structure?.planes?.length && Array.isArray(structure.lattice)) {
    structure.planes.forEach((planeDef, planeIndex) => {
      const cutMode = normalizePlaneCutMode(planeDef?.cutMode);
      if (cutMode === CutModes.NONE) return;

      const { normal, d } = getPlaneDefinitionNormalAndD(planeDef, structure.lattice);
      if (!Array.isArray(normal) || normal.length !== 3) return;

      retainedPlanes.push({
        enabled: true,
        x: normal[0],
        y: normal[1],
        z: normal[2],
        r: d,
        side: cutMode === CutModes.OPPOSITEN ? CutModes.OPPOSITEN : CutModes.ALONGN,
        source: 'structure-plane',
        planeIndex,
      });
    });
  }

  general.atomCutPlanes = retainedPlanes;
  updateAtomCutPlaneState();
  updateVisualization({
    atomsUpdate: false,
    bondsUpdate: true,
    reRenderAtoms: false,
    reRenderBonds: false,
    reRenderLattice: false,
    reRenderOther: false,
    reRenderComposition: false,
  });
}

export function syncPlanesForSelectedStructure() {
  const structure = getSelectedStructure();

  if (activeRenderedStructure && activeRenderedStructure !== structure) {
    clearRenderedPlanesForStructure(activeRenderedStructure);
  }

  activeRenderedStructure = structure;
  bindPanelStateToSelectedStructure();

  if (structure) {
    refreshCurrentStructurePlanesInScene();
  }

  syncAtomCutPlanesFromSelectedStructure();

  selectedPlaneIndex = null;
  renderPlanesTable();
}

/**
 * Toggle the enabled state for "Calculate from Selected Atoms" button.
 * @param {boolean} enabled - Whether to enable the button
 */
export function setCalculateFromAtomsEnabled(enabled) {
  planesData.calculateFromAtomsEnabled = enabled;
  const btn = document.getElementById('calcFromAtomsBtn');
  if (btn) {
    btn.disabled = !enabled;
  }
}

function setNumericInputValue(elementId, value, fractionDigits = null) {
  const input = document.getElementById(elementId);
  if (!input) return;

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    input.value = '0';
    return;
  }

  input.value = fractionDigits === null
    ? `${numericValue}`
    : numericValue.toFixed(fractionDigits);
}

function updateFieldControlsAvailability(enabled) {
  const fieldSection = document.getElementById('planesFieldSection');
  const fieldCard = fieldSection?.querySelector('.planes-field-colormap-container');
  const fieldControls = document.querySelectorAll(
    '#planesFieldSelect, #planesColormapSelect, #planesColormapRangeMin, #planesColormapRangeMax'
  );
  const hasFields = fieldBrowser.availableFields && fieldBrowser.availableFields.length > 0;
  const controlsEnabled = Boolean(enabled && hasFields);

  fieldControls.forEach(ctrl => {
    ctrl.disabled = !controlsEnabled;
  });

  if (fieldCard) {
    fieldCard.classList.toggle('planes-field-colormap-disabled', !controlsEnabled);
  }
}

function syncDerivedPlaneInputs(params, lattice) {
  if (!params) return;

  if (params.type === 'hkl') {
    const h = Number(params.h) || 0;
    const k = Number(params.k) || 0;
    const l = Number(params.l) || 0;

    setNumericInputValue('planeH', h);
    setNumericInputValue('planeK', k);
    setNumericInputValue('planeL', l);

    if (!Array.isArray(lattice) || lattice.length !== 3) {
      setNumericInputValue('planeU', 0, 4);
      setNumericInputValue('planeV', 0, 4);
      setNumericInputValue('planeW', 0, 4);
      setNumericInputValue('planeD', 0, 4);
      return;
    }

    const derived = getPlaneDefinitionNormalAndD({ params }, lattice);
    const normal = Array.isArray(derived?.normal) ? derived.normal : [0, 0, 0];
    setNumericInputValue('planeU', normal[0] ?? 0, 4);
    setNumericInputValue('planeV', normal[1] ?? 0, 4);
    setNumericInputValue('planeW', normal[2] ?? 0, 4);
    setNumericInputValue('planeD', derived?.d ?? 0, 4);
    return;
  }

  if (params.type === 'uvwd') {
    const u = Number(params.u) || 0;
    const v = Number(params.v) || 0;
    const w = Number(params.w) || 0;
    const d = Number(params.d) || 0;

    setNumericInputValue('planeU', u, 4);
    setNumericInputValue('planeV', v, 4);
    setNumericInputValue('planeW', w, 4);
    setNumericInputValue('planeD', d, 4);

    if (!Array.isArray(lattice) || lattice.length !== 3) {
      setNumericInputValue('planeH', 0);
      setNumericInputValue('planeK', 0);
      setNumericInputValue('planeL', 0);
      return;
    }

    const derived = CartesianParamsToMillerInds([u, v, w], d, lattice) || {};
    setNumericInputValue('planeH', derived.h ?? 0);
    setNumericInputValue('planeK', derived.k ?? 0);
    setNumericInputValue('planeL', derived.l ?? 0);
  }
}

function updateDualSliderFill() {
  const rangeMin = document.getElementById('planesColormapRangeMin');
  const rangeMax = document.getElementById('planesColormapRangeMax');
  const fill = document.getElementById('planesDualSliderFill');
  if (!rangeMin || !rangeMax || !fill) return;

  const sliderMin = Number(rangeMin.min) || 0;
  const sliderMax = Number(rangeMin.max) || 100;
  const span = Math.max(sliderMax - sliderMin, 1);
  const minValue = Number(rangeMin.value);
  const maxValue = Number(rangeMax.value);
  const start = ((minValue - sliderMin) / span) * 100;
  const end = ((maxValue - sliderMin) / span) * 100;

  fill.style.left = `${Math.min(start, end)}%`;
  fill.style.width = `${Math.max(end - start, 0)}%`;
}

function updateRangeDisplayAndPlane(changedInput = null) {
  const rangeMin = document.getElementById('planesColormapRangeMin');
  const rangeMax = document.getElementById('planesColormapRangeMax');
  const rangeDisplay = document.getElementById('planesRangeDisplay');
  if (!rangeMin || !rangeMax || !rangeDisplay) return;

  let minValue = Number(rangeMin.value);
  let maxValue = Number(rangeMax.value);

  if (minValue > maxValue) {
    if (changedInput === rangeMin) {
      maxValue = minValue;
      rangeMax.value = `${maxValue}`;
    } else {
      minValue = maxValue;
      rangeMin.value = `${minValue}`;
    }
  }

  rangeDisplay.textContent = `${minValue} – ${maxValue}`;
  updateDualSliderFill();

  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
  const plane = structure.planes[selectedPlaneIndex];
  if (!plane) return;

  plane.colormapMin = minValue;
  plane.colormapMax = maxValue;
  replacePlaneMesh(structure, plane);
}

export function addPlanesPanel(target = "PlanesContainer") {
  const container = document.getElementById(target);
  if (!container) {
    console.error(`${target} not found`);
    return;
  }

  container.style.display = "block";
  bindPanelStateToSelectedStructure();
  container.innerHTML = `
    <div class="control-group">
      <div class="planes-header">
        <h3>Crystal Planes</h3>
        <button id="addPlaneBtn" class="planes-action-btn planes-top-btn">Add Plane</button>
      </div>

      <!-- Planes table in container -->
      <div class="planes-table-wrapper">
        <p id="noPlanesMsg" class="planes-empty-msg">No planes added yet.</p>
        <table id="planesTable" class="planes-table" style="display:none;">
          <thead>
            <tr>
              <th class="planes-th planes-th-narrow"></th>
              <th class="planes-th">(hkl)</th>
              <th class="planes-th">(xyz | d)</th>
              <th class="planes-th">Field</th>
              <th class="planes-th">Filter</th>
              <th class="planes-th planes-th-narrow planes-th-del-sticky"></th>
            </tr>
          </thead>
          <tbody id="planesTableBody"></tbody>
        </table>
      </div>

      <!-- Calculate from atoms button (centered) -->
      <div class="planes-center-row">
        <button id="calcFromAtomsBtn" class="planes-action-btn planes-calc-btn" disabled>
          Calculate from Selected Atoms
        </button>
      </div>

      <!-- Plane parameter controls (hidden until plane selected) -->
      <div class="planes-params-section" id="planesParamsSection" style="display:none;">
        <h4 class="planes-section-title">Plane Parameters</h4>

        <div class="control-group">
          <label class="toggle_row toggle_container">
            <span class="toggle_switch">
              <input type="checkbox" id="showPlanesToggle" ${planesData.showPlanes ? 'checked' : ''}>
              <span class="toggle_slider"></span>
            </span>
            <span class="toggle_text">Show Plane</span>
          </label>
        </div>

        <div class="planes-input-section">

          <!-- Row 1: u v w + d -->
          <div class="planes-input-row" id="planeRowUVWD">
            <label class="planes-radio-label">
              <input type="radio" name="planeInputMode" id="radioUVWD" value="uvwd">
              <span>Cartesian parameters</span>
            </label>
            <div class="planes-row-inputs planes-uvwd-layout" id="uvwdInputs">
              <div class="planes-uvw-cluster">
                <div class="planes-labeled-input">
                  <span class="planes-input-label">x</span>
                  <input type="number" id="planeU" class="planes-num-input" value="0" step="0.1" disabled>
                </div>
                <div class="planes-labeled-input">
                  <span class="planes-input-label">y</span>
                  <input type="number" id="planeV" class="planes-num-input" value="0" step="0.1" disabled>
                </div>
                <div class="planes-labeled-input">
                  <span class="planes-input-label">z</span>
                  <input type="number" id="planeW" class="planes-num-input" value="1" step="0.1" disabled>
                </div>
              </div>
              <div class="planes-d-cluster">
                <div class="planes-labeled-input">
                  <span class="planes-input-label">d</span>
                  <input type="number" id="planeD" class="planes-num-input" value="0" step="0.1" disabled>
                </div>
              </div>
            </div>
          </div>

          <!-- Row 2: h k l -->
          <div class="planes-input-row" id="planeRowHKL">
            <label class="planes-radio-label">
              <input type="radio" name="planeInputMode" id="radioHKL" value="hkl" checked>
              <span>Miller indices</span>
            </label>
            <div class="planes-row-inputs" id="hklInputs">
              <div class="planes-labeled-input">
                <span class="planes-input-label">h</span>
                <input type="number" id="planeH" class="planes-num-input" value="1" step="1" disabled>
              </div>
              <div class="planes-labeled-input">
                <span class="planes-input-label">k</span>
                <input type="number" id="planeK" class="planes-num-input" value="0" step="1" disabled>
              </div>
              <div class="planes-labeled-input">
                <span class="planes-input-label">l</span>
                <input type="number" id="planeL" class="planes-num-input" value="0" step="1" disabled>
              </div>
            </div>
          </div>

        </div>

        <!-- Cut mode -->
        <div class="planes-cut-row">
          <label class="planes-cut-label">Filter/hide atoms:</label>
          <select id="planeCutMode" class="planes-select" disabled>
            <option value="${CutModes.NONE}">None</option>
            <option value="${CutModes.ALONGN}">Along Normal</option>
            <option value="${CutModes.OPPOSITEN}">Opposite Normal</option>
          </select>
        </div>

      </div>

      <!-- Field + colormap grouped -->
      <div class="planes-field-section" id="planesFieldSection" style="display:none;">
        <h4 class="planes-section-title">Field &amp; Colormap</h4>
        <div class="planes-field-colormap-container">

          <div class="planes-field-colormap-grid">
            <div class="planes-field-control">
            <label for="planesFieldSelect">Field:</label>
            <select id="planesFieldSelect" class="planes-select planes-full-width" disabled>
              <option value="">No fields available</option>
            </select>
            </div>

            <div class="planes-field-control">
            <label for="planesColormapSelect">Colormap:</label>
            <select id="planesColormapSelect" class="planes-select planes-full-width" disabled>
              <option value="jet">Jet</option>
              <option value="cooltowarm">Cool to Warm</option>
              <option value="viridis">Viridis</option>
              <option value="plasma">Plasma</option>
              <option value="inferno">Inferno</option>
              <option value="magma">Magma</option>
              <option value="cividis">Cividis</option>
              <option value="rainbow">Rainbow</option>
              <option value="blackbody">Blackbody</option>
              <option value="grayscale">Grayscale</option>
            </select>
          </div>
          </div>

          <div class="planes-field-control planes-field-range-control">
            <label>Range:</label>
            <div class="planes-range-container">
              <div class="planes-dual-slider">
                <div class="planes-dual-slider-track"></div>
                <div class="planes-dual-slider-fill" id="planesDualSliderFill"></div>
                <input type="range" id="planesColormapRangeMin" class="planes-slider planes-slider-min" value="0" min="0" max="100" step="1" disabled>
                <input type="range" id="planesColormapRangeMax" class="planes-slider planes-slider-max" value="100" min="0" max="100" step="1" disabled>
              </div>
              <span id="planesRangeDisplay">0 – 100</span>
            </div>
          </div>

        </div>
      </div>

    </div>
  `;

  setupPlanesEvents(container);
  syncPlanesForSelectedStructure();
  renderPlanesTable();
}

function setupPlanesEvents(container) {
  const showPlanesToggle = container.querySelector('#showPlanesToggle');
  showPlanesToggle.addEventListener('change', e => {
    const structure = getSelectedStructure();
    if (structure && selectedPlaneIndex !== null && selectedPlaneIndex >= 0) {
      const plane = structure.planes[selectedPlaneIndex];
      if (plane) {
        plane.enabled = e.target.checked;
        replacePlaneMesh(structure, plane);
        syncAtomCutPlanesFromSelectedStructure();
      }
    }
  });

  const radioUVWD = container.querySelector('#radioUVWD');
  const radioHKL  = container.querySelector('#radioHKL');

  const uvwdInputs = () => container.querySelectorAll('#planeU, #planeV, #planeW, #planeD');
  const hklInputs  = () => container.querySelectorAll('#planeH, #planeK, #planeL');

  function applyRadioState() {
    const isHKL = radioHKL.checked;
    hklInputs().forEach(inp  => { inp.disabled = !isHKL; });
    uvwdInputs().forEach(inp => { inp.disabled =  isHKL; });
    planesData.activeInputMode = isHKL ? 'hkl' : 'uvwd';
  }

  radioHKL.addEventListener('change',  applyRadioState);
  radioUVWD.addEventListener('change', applyRadioState);

  // Commit plane parameter edits on blur or Enter.
  [...hklInputs(), ...uvwdInputs()].forEach(input => {
    input.addEventListener('blur', updateSelectedPlaneFromInputs);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.target.blur();
      }
    });
  });

  container.querySelector('#addPlaneBtn').addEventListener('click', addPlaneFromCurrentInputs);
  container.querySelector('#calcFromAtomsBtn').addEventListener('click', calculatePlaneFromSelectedAtoms);

  // Field section event listeners
  const fieldSelect = container.querySelector('#planesFieldSelect');
  if (fieldSelect) {
    fieldSelect.addEventListener('change', e => {
      const structure = getSelectedStructure();
      if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
      const plane = structure.planes[selectedPlaneIndex];
      if (!plane) return;
      
      // Update field assignment
      const selectedFieldLabel = e.target.value;
      
      plane.fieldLabel = selectedFieldLabel;
      if (selectedFieldLabel) {
        plane.visualization = PLANE_VIS_FIELD;
        const selectedField = fieldBrowser.availableFields.find(f => f.label === selectedFieldLabel);
        plane.field = selectedField || null;
      }
      else {
        plane.visualization = PLANE_VIS_NONE;
        plane.field = null;
      }
      replacePlaneMesh(structure, plane);
      renderPlanesTable();
    });
  }

  const colormapSelect = container.querySelector('#planesColormapSelect');
  if (colormapSelect) {
    colormapSelect.addEventListener('change', e => {
      const structure = getSelectedStructure();
      if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
      const plane = structure.planes[selectedPlaneIndex];
      if (!plane) return;
      plane.colormap = e.target.value;
      replacePlaneMesh(structure, plane);
    });
  }

  const rangeMin = container.querySelector('#planesColormapRangeMin');
  const rangeMax = container.querySelector('#planesColormapRangeMax');

  if (rangeMin && rangeMax) {
    const bringThumbToFront = activeInput => {
      rangeMin.style.zIndex = activeInput === rangeMin ? '3' : '2';
      rangeMax.style.zIndex = activeInput === rangeMax ? '3' : '2';
    };

    rangeMin.addEventListener('input', () => updateRangeDisplayAndPlane(rangeMin));
    rangeMax.addEventListener('input', () => updateRangeDisplayAndPlane(rangeMax));
    rangeMin.addEventListener('focus', () => bringThumbToFront(rangeMin));
    rangeMax.addEventListener('focus', () => bringThumbToFront(rangeMax));
    rangeMin.addEventListener('pointerdown', () => bringThumbToFront(rangeMin));
    rangeMax.addEventListener('pointerdown', () => bringThumbToFront(rangeMax));

    updateRangeDisplayAndPlane();
  }

  const cutModeSelect = container.querySelector('#planeCutMode');
  if (cutModeSelect) {
    cutModeSelect.addEventListener('change', e => {
      const structure = getSelectedStructure();
      if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
      const plane = structure.planes[selectedPlaneIndex];
      if (!plane) return;
      plane.cutMode = normalizePlaneCutMode(e.target.value);
      syncAtomCutPlanesFromSelectedStructure();
      renderPlanesTable();
    });
  }
}

function addPlaneFromCurrentInputs() {
  const structure = getSelectedStructure();
  if (!structure) {
    alert('Load/select a structure before adding planes.');
    return;
  }

  ensureStructurePlaneState(structure);

  const newPlane = {
    enabled:       true,
    params:        { type: 'hkl', h: 1, k: 1, l: 1 },
    label:         '(1 1 1)',
    visualization: 'None',
    cutMode:       CutModes.NONE,
    colormap:      'jet',
    colormapMin:   0,
    colormapMax:   100,
    field:        null,
  };

  structure.planes.push(newPlane);
  replacePlaneMesh(structure, newPlane);

  selectedPlaneIndex = structure.planes.length - 1;
  renderPlanesTable();
  loadSelectedPlaneParameters();
}

function calculatePlaneFromSelectedAtoms() {
  const structure = getSelectedStructure();
  const atoms = measurements.selectedAtoms;
  if (!atoms || atoms.length < 3) {
    alert('Select at least 3 atoms (in measurement mode) to define a plane.');
    return;
  }

  const p0 = atoms[0].position;
  const p1 = atoms[1].position;
  const p2 = atoms[2].position;

  const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
  const bx = p2.x - p0.x, by = p2.y - p0.y, bz = p2.z - p0.z;

  // Cross product a × b = plane normal
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

  if (len < 1e-10) {
    alert('Selected atoms are collinear — cannot define a plane.');
    return;
  }

  // d = signed distance from origin to the plane (plane eqn: n·x = d)
  const d = (nx * p0.x + ny * p0.y + nz * p0.z) / len;

  const derivedParams = {
    type: 'uvwd',
    u: nx / len,
    v: ny / len,
    w: nz / len,
    d,
  };

  syncDerivedPlaneInputs(derivedParams, structure?.lattice);

  // Switch to uvwd mode
  const radioUVWD = document.getElementById('radioUVWD');
  if (radioUVWD) {
    radioUVWD.checked = true;
    radioUVWD.dispatchEvent(new Event('change'));
  }
}

/**
 * Load parameters from the selected plane into the input fields.
 */
function loadSelectedPlaneParameters() {
  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) {
    return;
  }

  const plane = structure.planes[selectedPlaneIndex];
  if (!plane || !plane.params) return;

  const paramsSection = document.getElementById('planesParamsSection');
  const fieldSection = document.getElementById('planesFieldSection');
  if (paramsSection) paramsSection.style.display = 'block';
  if (fieldSection) fieldSection.style.display = 'block';

  // Enable/disable controls
  enablePlaneControls(true);
  updateFieldSelectionDropdown();

  // Load parameters based on type
  if (plane.params.type === 'hkl') {
    document.getElementById('radioHKL').checked = true;
    document.getElementById('radioHKL').dispatchEvent(new Event('change'));
  } else if (plane.params.type === 'uvwd') {
    document.getElementById('radioUVWD').checked = true;
    document.getElementById('radioUVWD').dispatchEvent(new Event('change'));
  }

  syncDerivedPlaneInputs(plane.params, structure.lattice);

  // Load show planes toggle
  if (plane.enabled !== undefined) {
    document.getElementById('showPlanesToggle').checked = plane.enabled;
  }

  // Load colormap settings
  if (document.getElementById('planesColormapSelect')) {
    document.getElementById('planesColormapSelect').value = plane.colormap || 'jet';
  }
  if (document.getElementById('planesColormapRangeMin')) {
    document.getElementById('planesColormapRangeMin').value = plane.colormapMin !== undefined ? plane.colormapMin : 0;
    document.getElementById('planesColormapRangeMax').value = plane.colormapMax !== undefined ? plane.colormapMax : 100;
    updateRangeDisplayAndPlane();
  }
  // Load cut mode
  const cutModeEl = document.getElementById('planeCutMode');
  if (cutModeEl) cutModeEl.value = normalizePlaneCutMode(plane.cutMode);
}

/**
 * Update the selected plane from the current input field values.
 */
function updateSelectedPlaneFromInputs() {
  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;

  const plane = structure.planes[selectedPlaneIndex];
  if (!plane) return;

  if (planesData.activeInputMode === 'hkl') {
    const h = parseFloat(document.getElementById('planeH').value) || 0;
    const k = parseFloat(document.getElementById('planeK').value) || 0;
    const l = parseFloat(document.getElementById('planeL').value) || 0;
    plane.params = { type: 'hkl', h, k, l };
    plane.label = `(${h} ${k} ${l})`;
  } else {
    const u = parseFloat(document.getElementById('planeU').value) || 0;
    const v = parseFloat(document.getElementById('planeV').value) || 0;
    const w = parseFloat(document.getElementById('planeW').value) || 0;
    const d = parseFloat(document.getElementById('planeD').value) || 0;
    plane.params = { type: 'uvwd', u, v, w, d };
    plane.label = `[${u.toFixed(2)} ${v.toFixed(2)} ${w.toFixed(2)}] d=${d.toFixed(2)}`;
  }

  syncDerivedPlaneInputs(plane.params, structure.lattice);
  replacePlaneMesh(structure, plane);
  syncAtomCutPlanesFromSelectedStructure();
  renderPlanesTable();
}

/**
 * Enable or disable plane control inputs.
 */
function enablePlaneControls(enabled) {
  const inputs = document.querySelectorAll(
    '#planeH, #planeK, #planeL, #planeU, #planeV, #planeW, #planeD, #radioHKL, #radioUVWD, #showPlanesToggle, #planeCutMode'
  );
  inputs.forEach(inp => {
    inp.disabled = !enabled;
  });

  updateFieldControlsAvailability(enabled);
}

/**
 * Disable all plane controls.
 */
function disablePlaneControls() {
  const inputs = document.querySelectorAll(
    '#planeH, #planeK, #planeL, #planeU, #planeV, #planeW, #planeD, #radioHKL, #radioUVWD, #showPlanesToggle, #planeCutMode'
  );
  inputs.forEach(inp => {
    inp.disabled = true;
  });
  updateFieldControlsAvailability(false);

  const paramsSection = document.getElementById('planesParamsSection');
  const fieldSection = document.getElementById('planesFieldSection');
  if (paramsSection) paramsSection.style.display = 'none';
  if (fieldSection) fieldSection.style.display = 'none';
}

/**
 * Update the field selection dropdown with available fields.
 */
function updateFieldSelectionDropdown() {
  const select = document.getElementById('planesFieldSelect');
  if (!select) return;

  const structure = getSelectedStructure();
  const hasFields = fieldBrowser.availableFields && fieldBrowser.availableFields.length > 0;

  if (!hasFields) {
    select.innerHTML = '<option value="">No fields available</option>';
    updateFieldControlsAvailability(true);
    return;
  }

  select.innerHTML = '<option value="">No Field</option>';
  
  fieldBrowser.availableFields.forEach(field => {
    const option = document.createElement('option');
    option.value = field.label || '';
    option.textContent = field.label || 'Unnamed Field';
    select.appendChild(option);
  });

  // Select the field if one is assigned to the current plane
  if (structure && selectedPlaneIndex !== null && selectedPlaneIndex >= 0) {
    const plane = structure.planes[selectedPlaneIndex];
    if (plane && plane.field && plane.field.label) {
      select.value = plane.field.label;
    }
  }

  updateFieldControlsAvailability(true);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatPlaneTableValue(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return numericValue.toFixed(2).replace(/\.?0+$/, '');
}

function buildVectorMarkup(values, wrapperClass = '') {
  const classSuffix = wrapperClass ? ` ${wrapperClass}` : '';
  return `
    <div class="planes-vector${classSuffix}" aria-hidden="true">
      <span class="planes-vector-bracket">(</span>
      <span class="planes-vector-values">${values.map(value => `<span>${escapeHtml(formatPlaneTableValue(value))}</span>`).join('')}</span>
      <span class="planes-vector-bracket">)</span>
    </div>
  `;
}

function getPlaneTableDisplayData(plane, lattice) {
  const p = plane.params || {};

  if (p.type === 'hkl') {
    const hValues = [p.h ?? 0, p.k ?? 0, p.l ?? 0];
    let uvwdValues = ['0.00', '0.00', '0.00'];
    let dValue = '0.00';

    if (lattice) {
      const res = getPlaneDefinitionNormalAndD(plane, lattice);
      if (Array.isArray(res?.normal) && res.normal.length === 3) {
        uvwdValues = res.normal.map(value => Number(value ?? 0).toFixed(2));
        dValue = Number(res.d ?? 0).toFixed(2);
      }
    }

    return {
      hklValues: hValues,
      uvwdValues,
      dValue,
    };
  }

  if (p.type === 'uvwd') {
    const uvwdValues = [p.u ?? 0, p.v ?? 0, p.w ?? 0].map(value => Number(value).toFixed(2));
    const dValue = Number(p.d ?? 0).toFixed(2);
    let hklValues = ['0', '0', '0'];

    if (lattice) {
      const res = CartesianParamsToMillerInds([p.u ?? 0, p.v ?? 0, p.w ?? 0], p.d ?? 0, lattice);
      if (res) {
        hklValues = [res.h ?? 0, res.k ?? 0, res.l ?? 0].map(value => `${value}`);
      }
    }

    return {
      hklValues,
      uvwdValues,
      dValue,
    };
  }

  return {
    hklValues: ['0', '0', '0'],
    uvwdValues: ['0.00', '0.00', '0.00'],
    dValue: '0.00',
  };
}

/**
 * Build human-readable hkl and uvwd|d strings for a plane, cross-converting
 * the representation not stored in params using the structure lattice.
 */
function getPlaneTableDisplayParams(plane, lattice) {
  const p = plane.params || {};
  let hklStr = '—';
  let uvwdStr = '—';

  if (p.type === 'hkl') {
    const h = p.h ?? 0, k = p.k ?? 0, l = p.l ?? 0;
    hklStr = `(${h} ${k} ${l})`;
    if (lattice) {
      const res = getPlaneDefinitionNormalAndD(plane, lattice);
      if (res.normal) {
        const [u, v, w] = res.normal;
        uvwdStr = `(${u.toFixed(2)} ${v.toFixed(2)} ${w.toFixed(2)} | ${(res.d ?? 0).toFixed(2)})`;
      }
    }
  } else if (p.type === 'uvwd') {
    const u = p.u ?? 0, v = p.v ?? 0, w = p.w ?? 0, d = p.d ?? 0;
    uvwdStr = `(${u.toFixed(2)} ${v.toFixed(2)} ${w.toFixed(2)} | ${d.toFixed(2)})`;
    if (lattice) {
      const res = CartesianParamsToMillerInds([u, v, w], d, lattice);
      if (res && (res.h !== 0 || res.k !== 0 || res.l !== 0)) {
        hklStr = `(${res.h} ${res.k} ${res.l})`;
      }
    }
  }

  return { hklStr, uvwdStr };
}

function renderPlanesTable() {
  const tbody = document.getElementById('planesTableBody');
  const noMsg = document.getElementById('noPlanesMsg');
  const table = document.getElementById('planesTable');
  if (!tbody) return;

  tbody.innerHTML = '';

  const structure = getSelectedStructure();
  const planes = getSelectedStructurePlanes();
  const lattice = structure?.lattice;

  const empty = planes.length === 0;
  if (noMsg) noMsg.style.display = empty ? 'block' : 'none';
  if (table) table.style.display = empty ? 'none' : 'table';
  if (empty) {
    selectedPlaneIndex = null;
    disablePlaneControls();
    return;
  }

  planes.forEach((plane, idx) => {
    const tr = document.createElement('tr');
    tr.className = selectedPlaneIndex === idx ? 'planes-row-selected' : '';
    tr.dataset.planeIndex = idx;

    const { hklStr, uvwdStr } = getPlaneTableDisplayParams(plane, lattice);
    const { hklValues, uvwdValues, dValue } = getPlaneTableDisplayData(plane, lattice);
    const rawField = plane.field?.label || '—';
    const fieldDisplay = rawField !== '—' && rawField.length > 15
      ? rawField.slice(0, 14) + '…'
      : rawField;
    const cutMode = plane.source === 'structure-plane'
      ? getPlaneCutModeLabel(plane.cutMode)
      : getCutPlaneSideLabel(plane.side);

    tr.innerHTML = `
      <td class="planes-td planes-td-cb">
        <input type="checkbox" class="plane-enable-cb" data-idx="${idx}" ${plane.enabled ? 'checked' : ''}>
      </td>
      <td class="planes-td planes-td-mono planes-td-vector" title="${escapeHtml(hklStr)}">${buildVectorMarkup(hklValues, 'planes-vector-tight')}</td>
      <td class="planes-td planes-td-mono planes-td-vector" title="${escapeHtml(uvwdStr)}">
        <div class="planes-uvwd-cell">
          ${buildVectorMarkup(uvwdValues, 'planes-vector-tight')}
          <span class="planes-d-inline">d=${escapeHtml(dValue)}</span>
        </div>
      </td>
      <td class="planes-td planes-td-field" title="${escapeHtml(rawField)}">${escapeHtml(fieldDisplay)}</td>
      <td class="planes-td planes-td-cut">${cutMode}</td>
      <td class="planes-td planes-td-del planes-td-del-sticky">
        <button class="plane-delete-btn" data-idx="${idx}" title="Remove">&times;</button>
      </td>
    `;

    tr.addEventListener('click', e => {
      if (e.target.classList.contains('plane-enable-cb') ||
          e.target.classList.contains('plane-delete-btn')) return;
      selectedPlaneIndex = idx;
      renderPlanesTable();
      loadSelectedPlaneParameters();
    });

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.plane-enable-cb').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const idx = parseInt(e.target.dataset.idx, 10);
      const s = getSelectedStructure();
      const plane = s?.planes?.[idx];
      if (!plane) return;
      plane.enabled = e.target.checked;
      replacePlaneMesh(s, plane);
      syncAtomCutPlanesFromSelectedStructure();
    });
  });

  tbody.querySelectorAll('.plane-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(e.target.dataset.idx, 10);
      const s = getSelectedStructure();
      const plane = s?.planes?.[idx];
      if (!plane || !s) return;

      removePlaneMesh(s, plane);
      s.planes.splice(idx, 1);

      if (selectedPlaneIndex !== null && selectedPlaneIndex >= s.planes.length) {
        selectedPlaneIndex = s.planes.length > 0 ? s.planes.length - 1 : null;
      }

      renderPlanesTable();
      syncAtomCutPlanesFromSelectedStructure();
      if (selectedPlaneIndex !== null) {
        loadSelectedPlaneParameters();
      } else {
        disablePlaneControls();
      }
    });
  });
}

export function removePlanesPanel(target = "PlanesContainer") {
  const container = document.getElementById(target);
  if (container) {
    container.innerHTML = '';
    container.style.display = 'none';
  }

  //if (activeRenderedStructure) {
  //  clearRenderedPlanesForStructure(activeRenderedStructure);
  //}
}
