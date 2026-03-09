import { app, groups, general, fileBrowser, mode,getLatticeVisSettings,getAtomVisSettings} from '../store.js';
import {updateVisualization} from '../crystal-viewer.js'
import {createSupercell} from '../modules/SuperCellModule.js';
import {resetView} from './WindowAndSceneControls.js'

export function addLatticeAndSupercellPanel(target = "BondLatticeContainer") {
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
    border: 1px solid rgba(255,255,255,0.3)
    border-radius: 5px;
    padding: 10px;
  `;

  // --- Lattice Parameters Panel (collapsible) ---
  const latticePanel = document.createElement("div");
  latticePanel.id = "latticeParametersPanel";
  latticePanel.style.marginBottom = "10px";

  const latticeToggle = document.createElement("div");
  latticeToggle.id = "latticeToggle";
  latticeToggle.className = "bond-toggle";
  latticeToggle.setAttribute("role", "button");
  latticeToggle.setAttribute("tabindex", "0");
  latticeToggle.setAttribute("aria-expanded", "false");
  latticeToggle.setAttribute("aria-controls", "latticeContent");

  const latticeTitle = document.createElement("h4");
  latticeTitle.textContent = "Lattice Parameters";

  const latticeIcon = document.createElement("div");
  latticeIcon.id = "latticeToggleIcon";
  latticeIcon.className = "toggle-icon";
  latticeIcon.textContent = "+";

  latticeToggle.appendChild(latticeTitle);
  latticeToggle.appendChild(latticeIcon);

  const latticeContent = document.createElement("div");
  latticeContent.id = "latticeContent";
  latticeContent.className = "collapsible-content";
  latticeContent.setAttribute("aria-hidden", "true");

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

  latticePanel.appendChild(latticeToggle);
  latticePanel.appendChild(latticeContent);

  // --- Supercell Panel (collapsible) ---
  const supercellPanel = document.createElement("div");
  supercellPanel.id = "supercellPanel";

  const supercellToggle = document.createElement("div");
  supercellToggle.id = "supercellToggle";
  supercellToggle.className = "bond-toggle";
  supercellToggle.setAttribute("role", "button");
  supercellToggle.setAttribute("tabindex", "0");
  supercellToggle.setAttribute("aria-expanded", "false");
  supercellToggle.setAttribute("aria-controls", "supercellContent");

  const supercellTitle = document.createElement("h4");
  supercellTitle.textContent = "Supercell";

  const supercellIcon = document.createElement("div");
  supercellIcon.id = "supercellToggleIcon";
  supercellIcon.className = "toggle-icon";
  supercellIcon.textContent = "+";

  supercellToggle.appendChild(supercellTitle);
  supercellToggle.appendChild(supercellIcon);

  const supercellContent = document.createElement("div");
  supercellContent.id = "supercellContent";
  supercellContent.className = "collapsible-content";
  supercellContent.setAttribute("aria-hidden", "true");

  // --- Supercell Input Row ---
  let supercell = fileBrowser.selectedStructure

  if (!supercell) fileBrowser.selectedStructure = { nx: 1, ny: 1, nz: 1 };
  const { nx, ny, nz } = fileBrowser.selectedStructure;

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

  supercellPanel.appendChild(supercellToggle);
  supercellPanel.appendChild(supercellContent);

  // --- Toggle Logic for Lattice ---
  function setLatticeOpen(open) {
    if (open) {
      latticeContent.classList.add("open");
      latticeContent.setAttribute("aria-hidden", "false");
      latticeIcon.textContent = "−";
      latticeToggle.setAttribute("aria-expanded", "true");
    } else {
      latticeContent.classList.remove("open");
      latticeContent.setAttribute("aria-hidden", "true");
      latticeIcon.textContent = "+";
      latticeToggle.setAttribute("aria-expanded", "false");
    }
  }

  setLatticeOpen(false);

  latticeToggle.addEventListener("click", () =>
    setLatticeOpen(!latticeContent.classList.contains("open"))
  );

  latticeToggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setLatticeOpen(!latticeContent.classList.contains("open"));
    }
  });

  // --- Toggle Logic for Supercell ---
  function setSupercellOpen(open) {
    if (open) {
      supercellContent.classList.add("open");
      supercellContent.setAttribute("aria-hidden", "false");
      supercellIcon.textContent = "−";
      supercellToggle.setAttribute("aria-expanded", "true");
    } else {
      supercellContent.classList.remove("open");
      supercellContent.setAttribute("aria-hidden", "true");
      supercellIcon.textContent = "+";
      supercellToggle.setAttribute("aria-expanded", "false");
    }
  }

  setSupercellOpen(false);

  supercellToggle.addEventListener("click", () =>
    setSupercellOpen(!supercellContent.classList.contains("open"))
  );

  supercellToggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSupercellOpen(!supercellContent.classList.contains("open"));
    }
  });

  // --- Helper Math Functions ---
  const norm = (v) => Math.hypot(v[0], v[1], v[2]);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const acosDeg = (x) => (Math.acos(clamp(x, -1, 1)) * 180) / Math.PI;
  const deg2rad = (deg) => (deg * Math.PI) / 180;
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  function updateVolumeDisplay(L) {
    const V = Math.abs(dot(L[0], cross(L[1], L[2])));
    volumeDiv.textContent = `Volume: ${V.toFixed(3)} Å³`;
  }

  // --- Lattice Parameter View ---
  function renderLatticeParams() {
    latticeViewContainer.innerHTML = "";

    const L = fileBrowser.selectedStructure.lattice.map(r => [...r]);
    const a = norm(L[0]);
    const b = norm(L[1]);
    const c = norm(L[2]);
    const alpha = acosDeg(dot(L[1], L[2]) / (b * c || 1));
    const beta = acosDeg(dot(L[0], L[2]) / (a * c || 1));
    const gamma = acosDeg(dot(L[0], L[1]) / (a * b || 1));

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
    fileBrowser.selectedStructure.supercell = { nx: newA, ny: newB, nz: newC };

    fileBrowser.selectedStructure.atoms = structuredClone(fileBrowser.selectedStructure.original.atoms);
    fileBrowser.selectedStructure.lattice = structuredClone(fileBrowser.selectedStructure.original.lattice);
    fileBrowser.selectedStructure.elements = structuredClone(fileBrowser.selectedStructure.original.elements);

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

  // --- Build Structure ---
  group.appendChild(latticePanel);
  group.appendChild(supercellPanel);
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

