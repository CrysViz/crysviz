import { measurements, app, fileBrowser } from '../store.js';
import { Plane, getPlaneDefinitionNormalAndD } from '../classes/Plane.js';

export const planesData = {
  activeInputMode: 'hkl', // 'hkl' or 'uvwd'
  showPlanes: true,
};

const structurePlaneMeshes = new WeakMap();
let activeRenderedStructure = null;

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

function upsertPlaneMesh(structure, planeDef) {
  if (!structure || !planeDef || !app.scene) return;
  removePlaneMesh(structure, planeDef);

  const lattice = structure.lattice;
  if (!Array.isArray(lattice) || lattice.length !== 3) return;

  const { normal, d } = getPlaneDefinitionNormalAndD(planeDef, lattice);
  if (Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]) < 1e-12) {
    return;
  }

  const planeMesh = new Plane({
    normal,
    d,
    cell: lattice,
    mode: planeDef.visualization || 'None',
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
  structure.planes.forEach(planeDef => upsertPlaneMesh(structure, planeDef));
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

  renderPlanesTable();
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
      <h3>Crystal Planes</h3>

      <div class="control-group">
        <label class="toggle_row toggle_container">
          <span class="toggle_switch">
            <input type="checkbox" id="showPlanesToggle" ${planesData.showPlanes ? 'checked' : ''}>
            <span class="toggle_slider"></span>
          </span>
          <span class="toggle_text">Show Planes</span>
        </label>
      </div>

      <div class="planes-input-section">

        <!-- Row 1: u v w  +  d -->
        <div class="planes-input-row" id="planeRowUVWD">
          <label class="planes-radio-label">
            <input type="radio" name="planeInputMode" id="radioUVWD" value="uvwd">
          </label>
          <div class="planes-row-inputs planes-uvwd-layout" id="uvwdInputs">
            <div class="planes-uvw-cluster">
              <div class="planes-labeled-input">
                <span class="planes-input-label">u</span>
                <input type="number" id="planeU" class="planes-num-input" value="0" step="1" disabled>
              </div>
              <div class="planes-labeled-input">
                <span class="planes-input-label">v</span>
                <input type="number" id="planeV" class="planes-num-input" value="0" step="1" disabled>
              </div>
              <div class="planes-labeled-input">
                <span class="planes-input-label">w</span>
                <input type="number" id="planeW" class="planes-num-input" value="1" step="1" disabled>
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
          </label>
          <div class="planes-row-inputs" id="hklInputs">
            <div class="planes-labeled-input">
              <span class="planes-input-label">h</span>
              <input type="number" id="planeH" class="planes-num-input" value="1" step="1">
            </div>
            <div class="planes-labeled-input">
              <span class="planes-input-label">k</span>
              <input type="number" id="planeK" class="planes-num-input" value="0" step="1">
            </div>
            <div class="planes-labeled-input">
              <span class="planes-input-label">l</span>
              <input type="number" id="planeL" class="planes-num-input" value="0" step="1">
            </div>
          </div>
        </div>

      </div>

      <!-- Visualization dropdown -->
      <div class="planes-viz-row">
        <label class="planes-viz-label" for="planesVisualization">Visualization:</label>
        <select id="planesVisualization" class="planes-select">
          <option value="None">None</option>
          <option value="Field">Field</option>
        </select>
      </div>

      <!-- Action buttons -->
      <div class="planes-buttons-row">
        <button id="addPlaneBtn" class="planes-action-btn">Add Plane</button>
        <button id="calcFromAtomsBtn" class="planes-action-btn">Calculate from Selected Atoms</button>
      </div>

      <!-- Planes table -->
      <div class="planes-table-wrapper">
        <p id="noPlanesMsg" class="planes-empty-msg">No planes added yet.</p>
        <table id="planesTable" class="planes-table" style="display:none;">
          <thead>
            <tr>
              <th class="planes-th">On</th>
              <th class="planes-th">Plane</th>
              <th class="planes-th">Visualization</th>
              <th class="planes-th"></th>
            </tr>
          </thead>
          <tbody id="planesTableBody"></tbody>
        </table>
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
    planesData.showPlanes = e.target.checked;
    refreshCurrentStructurePlanesInScene();
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

  container.querySelector('#addPlaneBtn').addEventListener('click', addPlaneFromCurrentInputs);
  container.querySelector('#calcFromAtomsBtn').addEventListener('click', calculatePlaneFromSelectedAtoms);
}

function addPlaneFromCurrentInputs() {
  const structure = getSelectedStructure();
  if (!structure) {
    alert('Load/select a structure before adding planes.');
    return;
  }

  ensureStructurePlaneState(structure);
  const viz = document.getElementById('planesVisualization')?.value ?? 'None';
  let label, params;

  if (planesData.activeInputMode === 'hkl') {
    const h = parseFloat(document.getElementById('planeH').value) || 0;
    const k = parseFloat(document.getElementById('planeK').value) || 0;
    const l = parseFloat(document.getElementById('planeL').value) || 0;
    params = { type: 'hkl', h, k, l };
    label  = `(${h} ${k} ${l})`;
  } else {
    const u = parseFloat(document.getElementById('planeU').value) || 0;
    const v = parseFloat(document.getElementById('planeV').value) || 0;
    const w = parseFloat(document.getElementById('planeW').value) || 0;
    const d = parseFloat(document.getElementById('planeD').value) || 0;
    params = { type: 'uvwd', u, v, w, d };
    label  = `[${u} ${v} ${w}] d=${d}`;
  }

  const newPlane = {
    enabled:       true,
    params,
    label,
    visualization: viz,
  };

  structure.planes.push(newPlane);

  upsertPlaneMesh(structure, newPlane);

  renderPlanesTable();
}

function calculatePlaneFromSelectedAtoms() {
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

  // Populate uvwd row
  document.getElementById('planeU').value = parseFloat((nx / len).toFixed(4));
  document.getElementById('planeV').value = parseFloat((ny / len).toFixed(4));
  document.getElementById('planeW').value = parseFloat((nz / len).toFixed(4));
  document.getElementById('planeD').value = parseFloat(d.toFixed(4));

  // Switch to uvwd mode
  const radioUVWD = document.getElementById('radioUVWD');
  if (radioUVWD) {
    radioUVWD.checked = true;
    radioUVWD.dispatchEvent(new Event('change'));
  }
}

function renderPlanesTable() {
  const tbody  = document.getElementById('planesTableBody');
  const noMsg  = document.getElementById('noPlanesMsg');
  const table  = document.getElementById('planesTable');
  if (!tbody) return;

  tbody.innerHTML = '';

  const planes = getSelectedStructurePlanes();
  const empty = planes.length === 0;
  if (noMsg)  noMsg.style.display  = empty ? 'block' : 'none';
  if (table)  table.style.display  = empty ? 'none'  : 'table';
  if (empty) return;

  planes.forEach((plane, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="planes-td">
        <input type="checkbox" class="plane-enable-cb" data-idx="${idx}" ${plane.enabled ? 'checked' : ''}>
      </td>
      <td class="planes-td planes-params-cell">${plane.label}</td>
      <td class="planes-td">
        <select class="plane-viz-select planes-select-sm" data-idx="${idx}">
          <option value="None"  ${plane.visualization === 'None'  ? 'selected' : ''}>None</option>
          <option value="Field" ${plane.visualization === 'Field' ? 'selected' : ''}>Field</option>
        </select>
      </td>
      <td class="planes-td">
        <button class="plane-delete-btn" data-idx="${idx}" title="Remove">&times;</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.plane-enable-cb').forEach(cb => {
    cb.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const structure = getSelectedStructure();
      const plane = structure?.planes?.[idx];
      if (!plane) return;
      plane.enabled = e.target.checked;
      if (structure) upsertPlaneMesh(structure, plane);
    });
  });

  tbody.querySelectorAll('.plane-viz-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const structure = getSelectedStructure();
      const plane = structure?.planes?.[idx];
      if (!plane) return;
      plane.visualization = e.target.value;
      if (structure) upsertPlaneMesh(structure, plane);
    });
  });

  tbody.querySelectorAll('.plane-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const structure = getSelectedStructure();
      const plane = structure?.planes?.[idx];
      if (!plane || !structure) return;

      removePlaneMesh(structure, plane);
      structure.planes.splice(idx, 1);
      renderPlanesTable();
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
