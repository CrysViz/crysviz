// AddVacuumModule.js
import { openPeriodicTable } from '../PeriodicTableSelectPanel.js';
import { Atom, Structure, StructureContainer } from '../../model/index.js';
import { fileBrowser, structureShip } from '../../state/store.js';
import { createRow, selectLastAddedRow } from '../FileBrowswerPanel.js';
import { fracToCart, cartToFrac } from '../../render/index.js';
import { updateVisualization } from '../../core/crystal-viewer.js';

// Parse a "#rrggbb" string to a numeric color, or undefined (=> element default).
function parseColorHexToInt(hex) {
  if (typeof hex !== 'string') return undefined;
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return undefined;
  return parseInt(h, 16);
}

// Build a brand-new boxed structure from atoms entered in the Add-atoms panel.
// The panel's x/y/z are Cartesian Å; we wrap them in an orthorhombic cell sized
// to the bounding box plus vacuum padding, convert to fractional coordinates,
// then register the structure as a new file-browser row and select it.
function makeNewStructureFromAtoms(atomsToAdd) {
  if (!atomsToAdd.length) {
    console.warn('Make New Structure: no atoms entered.');
    return;
  }

  const PAD = 5.0; // Å of vacuum padding around the bounding box

  const xs = atomsToAdd.map(a => a.x);
  const ys = atomsToAdd.map(a => a.y);
  const zs = atomsToAdd.map(a => a.z);
  const min = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
  const max = [Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  // Each cell length is the extent + padding on both sides (≥ 2·PAD), so a
  // single atom or a flat axis still gets a real box.
  const L = [0, 1, 2].map(i => (max[i] - min[i]) + 2 * PAD);
  const lattice = [[L[0], 0, 0], [0, L[1], 0], [0, 0, L[2]]];

  const elements = atomsToAdd.map(a => a.element);
  const atoms = atomsToAdd.map(a => new Atom({
    // Shift so the min corner sits at PAD, then normalise to fractional.
    position: [
      (a.x - min[0] + PAD) / L[0],
      (a.y - min[1] + PAD) / L[1],
      (a.z - min[2] + PAD) / L[2],
    ],
    element: a.element,
    color: parseColorHexToInt(a.color),
  }));

  const structure = new Structure({
    elements,
    uniqueElements: [...new Set(elements)],
    lattice,
    atoms,
  });

  const container = new StructureContainer({ fileName: 'new_structure', structures: [structure] });
  structureShip.container.push(container);

  const row = createRow({ name: 'new_structure', traj: 1, step: 1 });
  document.querySelector('#objectTable tbody').appendChild(row);
  fileBrowser.fileData.push({ name: 'new_structure', traj: 1, step: 1 });
  selectLastAddedRow(); // selects the row and triggers a render
}

// Grow the current structure's cell by the requested vacuum (Å) along each
// lattice vector, keeping the atoms' Cartesian positions fixed and recentering
// the content in the enlarged cell.
function applyVacuumToStructure(vacX, vacY, vacZ) {
  const s = fileBrowser.selectedStructure;
  if (!s) {
    console.warn('Add vacuum: no structure selected.');
    return;
  }
  if (!vacX && !vacY && !vacZ) return;

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

  // Recenter by half of each added lattice vector.
  const shift = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      shift[j] += 0.5 * (newLattice[i][j] - lattice[i][j]);
    }
  }

  s.atoms.forEach((atom, idx) => {
    const c = carts[idx];
    atom.position = cartToFrac([c[0] + shift[0], c[1] + shift[1], c[2] + shift[2]], newLattice);
  });

  s.lattice = newLattice;
  s.periodic = { wrapped: null, hash: null }; // force periodic-wrap recompute

  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
}

export function addVacuumPanel(container) {
  container.innerHTML = `
    <div style="display: flex; align-items: center; margin-bottom: 10px; flex-wrap: nowrap;">
      <div style="display: flex; align-items: center; margin-right: 15px;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">X (Å):</label>
        <input type="number" id="vacX" value="0" step="0.1" style="width: 80px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <div style="display: flex; align-items: center; margin-right: 15px;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">Y (Å):</label>
        <input type="number" id="vacY" value="0" step="0.1" style="width: 80px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <div style="display: flex; align-items: center; margin-right: 15px;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">Z (Å):</label>
        <input type="number" id="vacZ" value="0" step="0.1" style="width: 80px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <button id="applyVacuum" class="btn-mini highlight" style="padding: 5px 10px; background: var(--bg-color); color: white; cursor: pointer;">Apply Vacuum</button>
    </div>
  `;

  // Vacuum tab logic
  container.querySelector('#applyVacuum').addEventListener('click', () => {
    const vacX = parseFloat(container.querySelector('#vacX').value) || 0;
    const vacY = parseFloat(container.querySelector('#vacY').value) || 0;
    const vacZ = parseFloat(container.querySelector('#vacZ').value) || 0;
    applyVacuumToStructure(vacX, vacY, vacZ);
  });
}




export function addAtomsPanel(container) {
  container.innerHTML = `
    <div style="margin-bottom: 10px;">
      <table id="atomsTable" style="width:100%; margin-top: 10px; border-collapse: collapse;">
        <thead>
          <tr>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">Element</th>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">X</th>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">Y</th>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">Z</th>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">Color</th>
          </tr>
        </thead>
        <tbody>
          <!-- Rows will be added dynamically -->
        </tbody>
      </table>

      <div style="text-align: center; margin-top: 10px;">
        <button id="addNewRow" class="btn-mini highlight" style="width: 90%;" >
          + Add New Atom
        </button>
      </div>
    </div>

    <div style="margin-top: 15px; display: flex; align-items: center;">
      <textarea id="bulkInput" placeholder="Element x y z [color]
Example:
H 0.5 0.5 0.5 #FF0000
C 1.0 1.0 1.0
O 1.5 1.5 1.5 #00FF00" style="flex: 1; height: 80px; background: #333; border: 1px solid #555; color: white; padding: 5px; resize: vertical; margin-right: 10px;"></textarea>
      <div style="display: flex; flex-direction: column;">
        <button id="selectElementForBulk" class="btn-mini highlight">Select Element</button>
        <button id="applyBulk" class="btn-mini highlight" style="padding: 5px 10px; margin-top: 10px">Apply Bulk</button>
      </div>
    </div>

    <div style="margin-top: 15px; text-align: right;">
      <button id="addToStructure" class="btn-mini highlight" style="margin-right: 10px">Add to Structure</button>
      <button id="makeNewStructure" class="btn-mini highlight" >Add to New Structure</button>
    </div>
  `;

  // Store atoms to be added
  const atomsToAdd = [];
  let currentBulkElementInput = null;

  // Function to add a new row to the table
  function addRowToTable(element = '', x = 0, y = 0, z = 0, color = '#000000') {
    const tbody = container.querySelector('#atomsTable tbody');

    // Clear empty rows before adding new ones
    const rows = tbody.querySelectorAll('tr');
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const elementInput = lastRow.querySelector('.atom-element');
      if (!elementInput || elementInput.value === '') {
        tbody.removeChild(lastRow);
      }
    }

    const newRow = document.createElement('tr');

    newRow.innerHTML = `
      <td style="border: 1px solid #444; padding: 5px;">
        <div style="display: flex; flex-direction: column;">
          <input type="text" class="atom-element" value="${element}" style="width: 100px; background: #333; border: 1px solid #555; color: white; padding: 3px; margin: 4px; margin-bottom: 3px; border-radius: 3px;">
          <button class="select-element-btn"  style="padding: 2px 5px; background: #595959; border: none; color: white; cursor: pointer; font-size: 10px; width: 100%; border-radius: 3px;">Select Element</button>
        </div>
      </td>
      <td style="border: 1px solid #444; padding: 5px;"><input type="number" class="atom-x" value="${x}" step="0.1" style="width: 100%; background: #333; border: 1px solid #555; color: white; padding: 3px;"></td>
      <td style="border: 1px solid #444; padding: 5px;"><input type="number" class="atom-y" value="${y}" step="0.1" style="width: 100%; background: #333; border: 1px solid #555; color: white; padding: 3px;"></td>
      <td style="border: 1px solid #444; padding: 5px;"><input type="number" class="atom-z" value="${z}" step="0.1" style="width: 100%; background: #333; border: 1px solid #555; color: white; padding: 3px;"></td>
      <td style="border: 1px solid #444; padding: 5px;"><input type="color" class="atom-color" value="${color}" style="width: 100%; height: 22px; padding: 0;"></td>
    `;

    tbody.appendChild(newRow);

    // Add event listener to the select button
    const selectBtn = newRow.querySelector('.select-element-btn');
    selectBtn.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      openPeriodicTable((element) => {
        if (row) {
          row.querySelector('.atom-element').value = element;
        }
      });
    });
  }

  // Add initial row
  addRowToTable();

  // Add new row button
  container.querySelector('#addNewRow').addEventListener('click', () => {
    addRowToTable();
  });

  // Bulk input logic - Select element button for bulk input
  container.querySelector('#selectElementForBulk').addEventListener('click', () => {
    currentBulkElementInput = container.querySelector('#bulkInput');
    openPeriodicTable((element) => {
      if (currentBulkElementInput) {
        const start = currentBulkElementInput.selectionStart;
        const end = currentBulkElementInput.selectionEnd;
        const currentValue = currentBulkElementInput.value;

        const newValue = currentValue.substring(0, start) +
                        element +
                        currentValue.substring(end, currentValue.length);

        currentBulkElementInput.value = newValue;
        currentBulkElementInput.focus();
        currentBulkElementInput.setSelectionRange(start + element.length, start + element.length);
      }
    });
  });

  // Apply bulk input - Adds rows to the table
  container.querySelector('#applyBulk').addEventListener('click', () => {
    const bulkInput = container.querySelector('#bulkInput').value;
    const lines = bulkInput.split('\n');

    // Clear all empty rows before adding bulk input
    const tbody = container.querySelector('#atomsTable tbody');
    const rows = tbody.querySelectorAll('tr');
    rows.forEach(row => {
      const elementInput = row.querySelector('.atom-element');
      if (!elementInput || elementInput.value === '') {
        tbody.removeChild(row);
      }
    });

    lines.forEach(line => {
      if (line.trim() === '') return;

      // Parse line in format: Element x y z [color]
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const element = parts[0];
        const x = parseFloat(parts[1]) || 0;
        const y = parseFloat(parts[2]) || 0;
        const z = parseFloat(parts[3]) || 0;
        const color = parts[4] || '#000000';

        addRowToTable(element, x, y, z, color);
      }
    });

    container.querySelector('#bulkInput').value = '';
  });

  // Add to structure button
  container.querySelector('#addToStructure').addEventListener('click', () => {
    const tbody = container.querySelector('#atomsTable tbody');
    const rows = tbody.querySelectorAll('tr');

    rows.forEach(row => {
      const element = row.querySelector('.atom-element').value;
      const x = parseFloat(row.querySelector('.atom-x').value) || 0;
      const y = parseFloat(row.querySelector('.atom-y').value) || 0;
      const z = parseFloat(row.querySelector('.atom-z').value) || 0;
      const color = row.querySelector('.atom-color').value;

      if (element) {
        atomsToAdd.push({ element, x, y, z, color });
      }
    });

    // TODO (deferred): inserting atoms into the *existing* structure also needs
    // the bond / atom-image mappings rebuilt (model on SuperCellModule). For now
    // only "Make New Structure" is implemented; this path no-ops with a warning.
    console.warn('Add to existing structure is not implemented yet', atomsToAdd);
    atomsToAdd.length = 0;
  });

  // Make new structure button
  container.querySelector('#makeNewStructure').addEventListener('click', () => {
    const tbody = container.querySelector('#atomsTable tbody');
    const rows = tbody.querySelectorAll('tr');

    rows.forEach(row => {
      const element = row.querySelector('.atom-element').value;
      const x = parseFloat(row.querySelector('.atom-x').value) || 0;
      const y = parseFloat(row.querySelector('.atom-y').value) || 0;
      const z = parseFloat(row.querySelector('.atom-z').value) || 0;
      const color = row.querySelector('.atom-color').value;

      if (element) {
        atomsToAdd.push({ element, x, y, z, color });
      }
    });

    makeNewStructureFromAtoms(atomsToAdd);
    atomsToAdd.length = 0;
  });
}


export function addAtomVacuumPanel(buttonId = 'addButton') {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.warn(`No element with id '${buttonId}' found.`);
    return;
  }

  button.addEventListener('click', () => {
    const existingPanel = document.getElementById('vacuumAndAtomsPanel');
    if (existingPanel) {
      existingPanel.remove();
    }

    const panel = document.createElement('div');
    panel.id = 'vacuumAndAtomsPanel';
    panel.style.cssText = `
      position: fixed;
      top: 150px;
      left: var(--popup-left);
      padding: 15px;
      background-color: rgba(42, 42, 42, 0.9);
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 8px;
      z-index: 999;
      width: 500px;
    `;

    panel.innerHTML = `
      <div class="segmented-backend-control" id="AddPanelModeSwitch" style="margin-bottom: 10px;">
        <button data-tab="atoms" class="active">Add Atoms</button>
        <button data-tab="vacuum">Add Vacuum</button>
      </div>

      <div id="atomsTab" class="tab-content active" style="display: block;"></div>
      <div id="vacuumTab" class="tab-content" style="display: none;"></div>

      <button id="closePanel" class="btn-mini highlight" style="margin-top: 10px; padding: 5px 10px; background: rgba(240, 132, 18,0.90); border: none; color: white; cursor: pointer;">Close</button>
    `;

    document.body.appendChild(panel);

    // Initialize tabs
    addAtomsPanel(panel.querySelector('#atomsTab'));
    addVacuumPanel(panel.querySelector('#vacuumTab'));

    // Tab switching logic
    const tabButtons = panel.querySelectorAll('#AddPanelModeSwitch button');
    const tabContents = panel.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.style.display = 'none');

        button.classList.add('active');
        document.getElementById(button.dataset.tab + 'Tab').style.display = 'block';
      });
    });

    // Close panel
    panel.querySelector('#closePanel').addEventListener('click', () => {
      if (panel.parentNode) {
        panel.parentNode.removeChild(panel);
      }
    });
  });
}

