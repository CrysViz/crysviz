// AtomTableInput.js
//
// The atom-entry table + bulk-paste textarea shared by the add-atom panel
// (adding to an existing structure) and the add-structure modal (building a
// brand-new structure). Purely a UI component: it knows nothing about what
// happens to the atoms once submitted - callers read them out via getAtoms()
// and decide what to do (collision-check + commit, see AtomCollisionCheck.js
// / CommitAtoms.js).

import { openPeriodicTable } from '../PeriodicTableSelectPanel.js';
import { createColorSwatch } from '../SwatchColorPicker.js';

const CELL_STYLE = 'border: 1px solid #444; padding: 3px;';
const NUM_INPUT_STYLE = 'width: 100%; background: #333; border: 1px solid #555; color: white; padding: 2px 3px; box-sizing: border-box;';

// Rows with an element set, in DOM order - the same order/filter getAtoms()
// uses, so a candidate index from getAtoms() always maps to
// nonEmptyRows(container)[index] here.
function nonEmptyRows(container) {
  const tbody = container.querySelector('#atomsTable tbody');
  return [...tbody.querySelectorAll('tr')].filter(row => row.querySelector('.atom-element').value);
}

// createAtomTableEditor(container) -> { getAtoms(), clear(), highlightConflicts(indices), clearConflicts() }
// atoms returned by getAtoms() are Cartesian: { element, x, y, z, color }
export function createAtomTableEditor(container) {
  const STICKY_TH_STYLE = 'border: 1px solid #444; padding: 3px; font-size: 12px; text-align: center; position: sticky; top: 0; background: var(--popup-bg); z-index: 1;';

  container.innerHTML = `
    <div style="margin-bottom: 10px;">
      <div id="atomsTableScroll" class="atoms-table-scroll" style="max-height: 208px; overflow-y: auto; margin-top: 10px;">
        <table id="atomsTable" style="width:100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="${STICKY_TH_STYLE}">Element</th>
              <th style="${STICKY_TH_STYLE}">X</th>
              <th style="${STICKY_TH_STYLE}">Y</th>
              <th style="${STICKY_TH_STYLE}">Z</th>
              <th style="${STICKY_TH_STYLE}">Color</th>
            </tr>
          </thead>
          <tbody>
            <!-- Rows will be added dynamically -->
          </tbody>
        </table>
      </div>

      <div style="text-align: center; margin-top: 8px;">
        <button id="addNewRow" class="btn-mini highlight" style="width: 90%;" >
          + Add New Atom
        </button>
        <div id="addRowHint" style="display:none; color: rgba(240, 132, 18, 1); font-size: 11px; margin-top: 4px;">Select element first</div>
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
  `;

  let currentBulkElementInput = null;
  const addRowHint = container.querySelector('#addRowHint');

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
      <td style="${CELL_STYLE}">
        <div style="display: flex; align-items: center; gap: 3px;">
          <input type="text" class="atom-element" value="${element}" style="width: 54px; background: #333; border: 1px solid #555; color: white; padding: 2px 3px; border-radius: 3px; box-sizing: border-box;">
          <button type="button" class="select-element-btn" title="Select Element" style="flex: none; width: 22px; height: 22px; background: #595959; border: none; color: white; cursor: pointer; font-size: 13px; border-radius: 3px; line-height: 1; padding: 0;">⚛</button>
        </div>
      </td>
      <td style="${CELL_STYLE}"><input type="number" class="atom-x coord-input" value="${x}" step="0.1" style="${NUM_INPUT_STYLE}"></td>
      <td style="${CELL_STYLE}"><input type="number" class="atom-y coord-input" value="${y}" step="0.1" style="${NUM_INPUT_STYLE}"></td>
      <td style="${CELL_STYLE}"><input type="number" class="atom-z coord-input" value="${z}" step="0.1" style="${NUM_INPUT_STYLE}"></td>
      <td style="${CELL_STYLE} text-align:center;"></td>
    `;

    tbody.appendChild(newRow);

    const colorCell = newRow.querySelector('td:last-child');
    colorCell.appendChild(createColorSwatch(color, () => {}));

    const elementInput = newRow.querySelector('.atom-element');
    elementInput.addEventListener('input', () => {
      addRowHint.style.display = 'none';
    });

    const selectBtn = newRow.querySelector('.select-element-btn');
    selectBtn.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      openPeriodicTable((element) => {
        if (row) {
          row.querySelector('.atom-element').value = element;
          addRowHint.style.display = 'none';
        }
      });
    });
  }

  addRowToTable();

  container.querySelector('#addNewRow').addEventListener('click', () => {
    const tbody = container.querySelector('#atomsTable tbody');
    const lastRow = tbody.querySelector('tr:last-child');
    const lastElement = lastRow?.querySelector('.atom-element').value;
    if (lastRow && !lastElement) {
      addRowHint.style.display = 'block';
      return;
    }
    addRowHint.style.display = 'none';
    addRowToTable();
  });

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

  container.querySelector('#applyBulk').addEventListener('click', () => {
    const bulkInput = container.querySelector('#bulkInput').value;
    const lines = bulkInput.split('\n');

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

  function getAtoms() {
    return nonEmptyRows(container).map(row => ({
      element: row.querySelector('.atom-element').value,
      x: parseFloat(row.querySelector('.atom-x').value) || 0,
      y: parseFloat(row.querySelector('.atom-y').value) || 0,
      z: parseFloat(row.querySelector('.atom-z').value) || 0,
      color: row.querySelector('.color-swatch-btn').dataset.hex,
    }));
  }

  function clear() {
    const tbody = container.querySelector('#atomsTable tbody');
    tbody.innerHTML = '';
    addRowToTable();
    container.querySelector('#bulkInput').value = '';
    addRowHint.style.display = 'none';
  }

  // Visually flag the rows (by index into getAtoms()) involved in a
  // collision, so the user can see and fix them directly instead of just
  // reading the warning text - see AtomCollisionCheck.js's
  // conflictingCandidateIndices().
  function clearConflicts() {
    container.querySelectorAll('#atomsTable tbody tr').forEach(row => row.classList.remove('atom-row-conflict'));
  }

  function highlightConflicts(indices) {
    clearConflicts();
    const rows = nonEmptyRows(container);
    for (const idx of indices) rows[idx]?.classList.add('atom-row-conflict');
  }

  return { getAtoms, clear, highlightConflicts, clearConflicts };
}
