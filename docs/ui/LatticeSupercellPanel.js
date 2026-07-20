import { applyLatticeTransformation } from './LatticeTransformModule.js';

import { makeSectionHeadline } from './panels/sectionHeadline.js';
import { general, fileBrowser } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { createSupercell } from './SuperCellModule.js';
import { resetView } from './WindowAndSceneControls.js';
import { fracToCart, cartToFrac } from '../render/index.js';
import {
  vectorLength3,
  dot3,
  acosDeg,
  latticeVolume,
} from '../math/index.js';

// Grow the current structure's cell by the requested vacuum (Å) along each
// lattice vector, keeping the atoms' Cartesian positions fixed - a standard
// slab-with-vacuum construction (vacuum is added on one side only; atoms do
// not recenter, so their fractional coordinates compress toward the origin
// side of whichever vector(s) grew).
//
// _vacuumApplied is an in-memory (not saved/exported) bookkeeping field on
// the structure - the running total added per axis, plus the lattice as it
// was before any vacuum was ever applied to this structure - so the panel
// can show a running counter and Reset can undo the whole thing in one step
// (restoring baseLattice; atoms' Cartesian positions never changed, so their
// fractional coordinates just get recomputed against it).
function applyVacuumToStructure(vacX, vacY, vacZ) {
  const s = fileBrowser.selectedStructure;
  if (!s) {
    console.warn('Add vacuum: no structure selected.');
    return;
  }
  if (!vacX && !vacY && !vacZ) return;

  if (!s._vacuumApplied) {
    s._vacuumApplied = { x: 0, y: 0, z: 0, baseLattice: s.lattice.map(row => row.slice()) };
  }
  s._vacuumApplied.x += vacX;
  s._vacuumApplied.y += vacY;
  s._vacuumApplied.z += vacZ;

  const lattice = s.lattice;
  const vac = [vacX, vacY, vacZ];

  // Cartesian positions to preserve.
  const carts = fracToCart(s.atoms.map(a => a.position), lattice);

  // Scale each lattice vector's length by its added vacuum.
  const newLattice = lattice.map((row, i) => {
    const len = Math.hypot(row[0], row[1], row[2]);
    const k = (len > 0 && vac[i]) ? (len + vac[i]) / len : 1;
    return [row[0] * k, row[1] * k, row[2] * k];
  });

  s.atoms.forEach((atom, idx) => {
    atom.position = cartToFrac(carts[idx], newLattice);
  });

  s.lattice = newLattice;
  s.periodic = { wrapped: null, hash: null }; // force periodic-wrap recompute

  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
}

// Undoes every vacuum addition made so far on this structure in one step.
function resetVacuumForStructure(s) {
  if (!s || !s._vacuumApplied) return;
  const carts = fracToCart(s.atoms.map(a => a.position), s.lattice);
  s.lattice = s._vacuumApplied.baseLattice.map(row => row.slice());
  s.atoms.forEach((atom, idx) => {
    atom.position = cartToFrac(carts[idx], s.lattice);
  });
  s.periodic = { wrapped: null, hash: null };
  delete s._vacuumApplied;

  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
}

/** "Add Vacuum" section content — grows the cell along X/Y/Z (Å), independent
 *  of the Supercell/Transformation sections above/below it. Lives here (Cell &
 *  Supercell) rather than the add-atoms popup: it modifies the cell, not the
 *  atom list, so it fits this panel's job much better. */
function addVacuumSection(container) {
  container.innerHTML = `
    <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
      <div style="display: flex; align-items: center;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">X (Å):</label>
        <input type="number" id="vacX" class="coord-input" value="0" step="0.1" style="width: 56px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <div style="display: flex; align-items: center;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">Y (Å):</label>
        <input type="number" id="vacY" class="coord-input" value="0" step="0.1" style="width: 56px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <div style="display: flex; align-items: center;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">Z (Å):</label>
        <input type="number" id="vacZ" class="coord-input" value="0" step="0.1" style="width: 56px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <button id="applyVacuum" class="btn-mini highlight" style="padding: 5px 10px; background: var(--bg-color); color: white; cursor: pointer;">Apply Vacuum</button>
    </div>
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11px; color: rgba(255,255,255,0.7); border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px;">
      <span id="vacuumAppliedText"></span>
      <button id="resetVacuum" class="btn-mini" style="padding: 3px 10px; font-size: 11px;">Reset Vacuum</button>
    </div>
  `;

  const statusText = container.querySelector('#vacuumAppliedText');
  const resetBtn = container.querySelector('#resetVacuum');

  function refreshVacuumStatus() {
    const state = fileBrowser.selectedStructure?._vacuumApplied;
    const applied = state && (state.x || state.y || state.z);
    if (applied) {
      statusText.textContent = `Vacuum applied: X=${state.x.toFixed(2)} Å, Y=${state.y.toFixed(2)} Å, Z=${state.z.toFixed(2)} Å`;
    } else {
      statusText.textContent = 'No vacuum applied yet.';
    }
    resetBtn.disabled = !applied;
    resetBtn.style.opacity = applied ? '1' : '0.4';
    resetBtn.style.cursor = applied ? 'pointer' : 'default';
  }
  refreshVacuumStatus();

  container.querySelector('#applyVacuum').addEventListener('click', () => {
    const vacX = parseFloat(container.querySelector('#vacX').value) || 0;
    const vacY = parseFloat(container.querySelector('#vacY').value) || 0;
    const vacZ = parseFloat(container.querySelector('#vacZ').value) || 0;
    applyVacuumToStructure(vacX, vacY, vacZ);
    refreshVacuumStatus();
  });

  resetBtn.addEventListener('click', () => {
    resetVacuumForStructure(fileBrowser.selectedStructure);
    refreshVacuumStatus();
  });
}

export function addLatticeAndSupercellPanel(target = "cvPanelBody-cell") {
  const targetPanel = document.getElementById(target);
  if (!targetPanel) {
    console.warn(`target container "${target}" not found.`);
    return;
  }

  // Remove old panel if it exists
  const oldPanel = document.getElementById("latticeAndSupercellGroup");
  if (oldPanel) oldPanel.remove();

  // --- Outer wrapper (dark grey background, static) ---
  const group = document.createElement("div");
  group.id = "latticeAndSupercellGroup";
  group.style.cssText = `
    border: 1px solid rgba(255,255,255,0.3);
    border-radius: 5px;
    padding: 10px;
  `;

  // --- Lattice Parameters section (flat headline + content; the whole
  // window is collapsible, so the sections are not) ---
  const latticePanel = document.createElement("div");
  latticePanel.id = "latticeParametersPanel";
  latticePanel.style.marginBottom = "10px";

  const latticeContent = document.createElement("div");
  latticeContent.id = "latticeContent";

  // --- Lattice Reset Button ---
  const latticeResetBtnWrapper = document.createElement("div");
  latticeResetBtnWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  const latticeResetBtn = document.createElement("button");
  latticeResetBtn.textContent = "Reset Lattice";
  latticeResetBtn.className = "reset-btn";
  latticeResetBtn.style.cssText = `
    height: 28px;
    padding: 4px 10px;
    font-size: 12px;
    margin-bottom: 10px;
    cursor: pointer;
    border: none;
    border-radius: 4px;
    color: white;
  `;

  latticeResetBtnWrapper.appendChild(latticeResetBtn);
  latticeContent.appendChild(latticeResetBtnWrapper);

  // --- Toggle for Lattice Input ---
  const toggleRow = document.createElement("div");
  toggleRow.style.cssText = `
    display: flex;
    justify-content: center;
    align-items: center;
    margin-bottom: 8px;
  `;

  const toggleLabel = document.createElement("span");
  toggleLabel.textContent = "Input Option: ";
  toggleLabel.style.cssText = `
    font-weight: 600;
    color: rgba(255, 255, 255, 0.8);
  `;

  const toggleBtn = document.createElement("button");
  toggleBtn.textContent = "Matrix";
  toggleBtn.className = "mini-btn";
  toggleBtn.style.cssText = `
    height: 24px;
    padding: 2px 8px;
    font-size: 12px;
    cursor: pointer;
    border: none;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    margin-left: 8px;
  `;

  toggleRow.appendChild(toggleLabel);
  toggleRow.appendChild(toggleBtn);
  latticeContent.appendChild(toggleRow);

  // --- Lattice Input Container ---
  const latticeViewContainer = document.createElement("div");
  latticeContent.appendChild(latticeViewContainer);

  // --- Volume Display ---
  const volumeDiv = document.createElement("div");
  volumeDiv.style.cssText = `
    margin-top: 8px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.8);
  `;
  latticeContent.appendChild(volumeDiv);

  latticePanel.appendChild(makeSectionHeadline("Lattice Parameters"));
  latticePanel.appendChild(latticeContent);

  // --- Supercell section ---
  const supercellPanel = document.createElement("div");
  supercellPanel.id = "supercellPanel";
  supercellPanel.style.marginBottom = "10px";

  const supercellContent = document.createElement("div");
  supercellContent.id = "supercellContent";

  // --- Supercell Input Row ---
  let supercell = fileBrowser.selectedStructure;

  if (!supercell) fileBrowser.selectedStructure = { nx: 1, ny: 1, nz: 1 };

  const supercellInputRow = document.createElement("div");
  supercellInputRow.style.cssText = `
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
    justify-content: center;
  `;

  const supercellInputs = {};
  ["nx", "ny", "nz"].forEach((axis) => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value = general.currentSupercell ? general.currentSupercell[axis] : 1;
    input.style.cssText = `
      width: 50px;
      text-align: center;
      border: none;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.1);
      color: white;
      font-family: monospace;
      padding: 3px;
    `;
    supercellInputs[axis] = input;
    supercellInputRow.appendChild(input);
  });
  supercellContent.appendChild(supercellInputRow);

  // --- Supercell Buttons Row ---
  const supercellBtnRow = document.createElement("div");
  supercellBtnRow.style.cssText = `
    display: flex;
    gap: 8px;
    justify-content: center;
  `;

  const supercellApplyBtn = document.createElement("button");
  supercellApplyBtn.textContent = "Apply";
  supercellApplyBtn.className = "btn-mini highlight";
  supercellApplyBtn.style.cssText = `
    height: 32px;
    padding: 0 10px;
    font-size: 11px;
    margin-right: 4px;
    min-width: 80px;
  `;

  const supercellResetBtn = document.createElement("button");
  supercellResetBtn.textContent = "Reset";
  supercellResetBtn.className = "reset-btn";
  supercellResetBtn.style.cssText = `
    height: 32px;
    padding: 0 10px;
    font-size: 11px;
    margin-right: 4px;
    min-width: 80px;
  `;

  supercellBtnRow.appendChild(supercellApplyBtn);
  supercellBtnRow.appendChild(supercellResetBtn);
  supercellContent.appendChild(supercellBtnRow);

  supercellPanel.appendChild(makeSectionHeadline("Supercell"));
  supercellPanel.appendChild(supercellContent);

  // --- Vacuum section ---
  const vacuumPanel = document.createElement("div");
  vacuumPanel.id = "vacuumPanel";
  vacuumPanel.style.marginBottom = "10px";

  const vacuumContent = document.createElement("div");
  vacuumContent.id = "vacuumContent";

  vacuumPanel.appendChild(makeSectionHeadline("Vacuum"));
  vacuumPanel.appendChild(vacuumContent);
  addVacuumSection(vacuumContent);

  // --- Transformation section ---
  const transformPanel = document.createElement("div");
  transformPanel.id = "transformPanel";

  const transformContent = document.createElement("div");
  transformContent.id = "transformContent";


  // --- Transformation Matrix Input ---
const transformMatrixContainer = document.createElement("div");
transformMatrixContainer.style.cssText = `
  margin-bottom: 8px;
`;

const transformTable = document.createElement("table");
transformTable.style.cssText = `
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
`;
const transformTbody = document.createElement("tbody");

// Create 3x4 matrix (3x3 for P, 1x3 for p)
for (let i = 0; i < 3; i++) {
  const tr = document.createElement("tr");
  for (let j = 0; j < 4; j++) {
    const td = document.createElement("td");
    td.style.cssText = `
      padding: 2px;
      ${j === 3 ? 'border-left: 1px solid rgba(255, 255, 255, 0.3);' : ''}
    `;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "TransformInput";
    input.step = "0.1";
    input.style.cssText = `
      width: 60px;
      text-align: center;
      font-family: monospace;
      padding: 2px;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: white;
    `;
    input.id = `transform_${i}_${j}`;

    // Set default values: identity matrix for P, zero for p
    if (j < 3) {
      input.value = i === j ? "1" : "0";
    } else {
      input.value = "0.0";
    }

    td.appendChild(input);
    tr.appendChild(td);
  }
  transformTbody.appendChild(tr);
}
transformTable.appendChild(transformTbody);
transformMatrixContainer.appendChild(transformTable);
transformContent.appendChild(transformMatrixContainer);



  // --- Transformation Buttons Row ---
  const transformBtnRow = document.createElement("div");
  transformBtnRow.style.cssText = `
    display: flex;
    gap: 8px;
    justify-content: center;
  `;

  const transformApplyBtn = document.createElement("button");
  transformApplyBtn.textContent = "Apply";
  transformApplyBtn.className = "btn-mini highlight";
  transformApplyBtn.style.cssText = `
    height: 32px;
    padding: 0 10px;
    font-size: 11px;
    margin-right: 4px;
    min-width: 80px;
  `;

  const transformResetBtn = document.createElement("button");
  transformResetBtn.textContent = "Reset";
  transformResetBtn.className = "reset-btn";
  transformResetBtn.style.cssText = `
    height: 32px;
    padding: 0 10px;
    font-size: 11px;
    margin-right: 4px;
    min-width: 80px;
  `;

  transformBtnRow.appendChild(transformApplyBtn);
  transformBtnRow.appendChild(transformResetBtn);
  transformContent.appendChild(transformBtnRow);

  transformPanel.appendChild(makeSectionHeadline("Lattice Transformation"));
  transformPanel.appendChild(transformContent);

  const deg2rad = (deg) => (deg * Math.PI) / 180;

  function updateVolumeDisplay(L) {
    const V = latticeVolume(L);
    volumeDiv.textContent = `Volume: ${V.toFixed(3)} Å³`;
  }

  // --- Lattice Parameter View ---
  function renderLatticeParams() {
    latticeViewContainer.innerHTML = "";

    const L = fileBrowser.selectedStructure.lattice.map(r => [...r]);
    const a = vectorLength3(L[0]);
    const b = vectorLength3(L[1]);
    const c = vectorLength3(L[2]);
    const alpha = acosDeg(dot3(L[1], L[2]) / (b * c || 1));
    const beta = acosDeg(dot3(L[0], L[2]) / (a * c || 1));
    const gamma = acosDeg(dot3(L[0], L[1]) / (a * b || 1));

    const params = { a, b, c, alpha, beta, gamma };
    const table = document.createElement("table");
    table.style.cssText = "width:100%; border-collapse:collapse; font-size:12px;";
    const tbody = document.createElement("tbody");

    for (const [key, val] of Object.entries(params)) {
      const tr = document.createElement("tr");
      const tdLabel = document.createElement("td");
      tdLabel.textContent = key;
      tdLabel.style.cssText = "padding:4px;";

      const tdInput = document.createElement("td");
      const input = document.createElement("input");
      input.type = "number";
      input.className = "LatticeInput"
      input.value = val.toFixed(4);
      input.step = key.length === 1 ? "0.01" : "0.1";
      input.style.cssText = "width:80px; text-align:right; font-family:monospace; padding:2px;";
      input.id = `${key}Input`;
      input.oninput = () => {
        const vals = {
          a: parseFloat(document.querySelector("#aInput").value),
          b: parseFloat(document.querySelector("#bInput").value),
          c: parseFloat(document.querySelector("#cInput").value),
          alpha: parseFloat(document.querySelector("#alphaInput").value),
          beta: parseFloat(document.querySelector("#betaInput").value),
          gamma: parseFloat(document.querySelector("#gammaInput").value),
        };
        if (Object.values(vals).some((v) => !isFinite(v))) return;

        const { a, b, c, alpha, beta, gamma } = vals;
        const cosA = Math.cos(deg2rad(alpha));
        const cosB = Math.cos(deg2rad(beta));
        const cosG = Math.cos(deg2rad(gamma));
        const sinG = Math.sin(deg2rad(gamma));
        const Lnew = [
          [a, 0, 0],
          [b * cosG, b * sinG, 0],
          [
            c * cosB,
            c * ((cosA - cosB * cosG) / sinG),
            c * Math.sqrt(1 - cosB ** 2 - ((cosA - cosB * cosG) / sinG) ** 2),
          ],
        ];
        general.modifiedLattice = Lnew;
        fileBrowser.selectedStructure.lattice =  Lnew;
        updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: true,
          reRenderOther: false,
        });
        updateVolumeDisplay(Lnew);
      };
      tdInput.appendChild(input);
      tr.appendChild(tdLabel);
      tr.appendChild(tdInput);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    latticeViewContainer.appendChild(table);
    updateVolumeDisplay(L);
  }

  // --- Matrix View ---
  function renderMatrixView() {
    latticeViewContainer.innerHTML = "";
    const L = fileBrowser.selectedStructure.lattice.map(r => [...r]);

    const table = document.createElement("table");
    table.style.cssText = "width:100%; border-collapse:collapse; font-size:12px;";
    const tbody = document.createElement("tbody");

    for (let i = 0; i < 3; i++) {
      const tr = document.createElement("tr");
      for (let j = 0; j < 3; j++) {
        const td = document.createElement("td");
        const input = document.createElement("input");
        input.type = "number";
        input.className = "LatticeInput"
        input.value = L[i][j].toFixed(4);
        input.step = "0.01";
        input.style.cssText = "width:80px; text-align:right; font-family:monospace; padding:2px;";
        input.oninput = () => {
          const val = parseFloat(input.value);
          if (isFinite(val)) {
            fileBrowser.selectedStructure.lattice[i][j] = val;
            updateVisualization({
              reRenderAtoms: true,
              reRenderBonds: true,
              reRenderLattice: true,
              reRenderOther: false,
            });
            updateVolumeDisplay(fileBrowser.selectedStructure.lattice);
          }
        };
        general.modifiedLattice = fileBrowser.selectedStructure.lattice
        td.appendChild(input);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    latticeViewContainer.appendChild(table);
    updateVolumeDisplay(L);
  }

  // --- Event Handlers ---
  let showMatrix = false;
  toggleBtn.onclick = () => {
    showMatrix = !showMatrix;
    toggleBtn.textContent = showMatrix ? "Parameters" : "Matrix";
    showMatrix ? renderMatrixView() : renderLatticeParams();
  };

  latticeResetBtn.onclick = () => {
    general.modifiedLattice = null;
    fileBrowser.selectedStructure.atoms = fileBrowser.selectedStructure.original.atoms;
    fileBrowser.selectedStructure.lattice = fileBrowser.selectedStructure.original.lattice;
    if (general.currentSupercell != null) {
      createSupercell(
        general.currentSupercell.nx,
        general.currentSupercell.ny,
        general.currentSupercell.nz
      );
    }
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: true,
      reRenderOther: true,
    });
    resetView();
    showMatrix ? renderMatrixView() : renderLatticeParams();
  };

  supercellApplyBtn.onclick = () => {
    const newA = Math.max(1, parseInt(supercellInputs.nx.value));
    const newB = Math.max(1, parseInt(supercellInputs.ny.value));
    const newC = Math.max(1, parseInt(supercellInputs.nz.value));

    // Note: do NOT reset atoms/lattice/elements from `.original` here.
    // createSupercell() derives the base unit cell from the live (user-modified)
    // structure and re-tiles it to the requested factors, so modifications
    // (colour, opacity, moved atoms, …) are preserved across supercell changes.
    createSupercell(newA, newB, newC);
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: true,
    });
    resetView();
  };

  supercellResetBtn.onclick = () => {
    createSupercell(1, 1, 1);
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: true,
    });
    resetView();
  };


transformApplyBtn.onclick = () => {
  const matrix = [];
  for (let i = 0; i < 3; i++) {
    const row = [];
    for (let j = 0; j < 4; j++) {
      const val = parseFloat(document.getElementById(`transform_${i}_${j}`).value);
      row.push(isFinite(val) ? val : 0);
    }
    matrix.push(row);
  }
  console.log("Applying transformation:", matrix);
  applyLatticeTransformation(matrix);
};

transformResetBtn.onclick = () => {
  // Reset matrix UI to identity
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      const input = document.getElementById(`transform_${i}_${j}`);
      if (j < 3) {
        input.value = i === j ? "1" : "0";
      } else {
        input.value = "0.00000";
      }
    }
  }
  // Restore lattice and atom positions to original
  if (fileBrowser.selectedStructure.original) {
    // Restore lattice
    fileBrowser.selectedStructure.lattice = fileBrowser.selectedStructure.original.lattice.map(row => [...row]);
    // Restore only positions
    const atoms = fileBrowser.selectedStructure.atoms;
    const originalAtoms = fileBrowser.selectedStructure.original.atoms;
    for (let i = 0; i < atoms.length; i++) {
      atoms[i].position = [...originalAtoms[i].position];
    }
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: true,
      reRenderOther: false,
    });
    resetView();
    console.log("Transformation reset to original.");
  }
};

  // --- Build Structure ---
  group.appendChild(latticePanel);
  group.appendChild(supercellPanel);
  group.appendChild(vacuumPanel);
  group.appendChild(transformPanel);
  targetPanel.appendChild(group);

  // --- Initial Render ---
  renderLatticeParams();
}

export function removeLatticeAndSupercellPanel() {
  const panel = document.getElementById('latticeAndSupercellGroup');
  if (panel) {
    panel.remove();
    console.log("Lattice & Supercell panel removed.");
  } else {
    console.warn("Lattice & Supercell panel does not exist.");
  }
}


