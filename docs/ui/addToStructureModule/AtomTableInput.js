// AtomTableInput.js
//
// The atom-entry table + bulk-paste textarea shared by the two structure
// editors (see StructureEditorPanel.js): "Modify Structure" prefills it with
// every atom of the loaded structure, "Add Structure" starts it empty. Purely
// a UI component: it knows nothing about what happens to the atoms once
// submitted - callers read them out via getAtoms()/getDeleted() and decide
// what to do (collision-check + commit, see AtomCollisionCheck.js /
// CommitAtoms.js).
//
// Rows prefilled from an existing structure carry that atom's uuid in
// `dataset.uuid`; rows the user added have none. That one distinction is what
// lets a caller tell an edit of an existing atom from a brand-new one, and
// what the "New"/"Removed" summary lists key off - uuid, never row index,
// because deleting a row above shifts every index below it.

import { openPeriodicTable } from '../PeriodicTableSelectPanel.js';
import { createColorSwatch } from '../SwatchColorPicker.js';
import { generateID } from '../../utils/index.js';
import { getElementDefaultColor } from '../../defaults/color_texture_defaults.js';
import { colorToHex } from './CommitAtoms.js';
import { SITE_TOLERANCE } from '../../io/cif/site_grouping.js';

const CELL_STYLE = 'border: 1px solid #444; padding: 3px;';
const NUM_INPUT_STYLE = 'width: 100%; background: #333; border: 1px solid #555; color: white; padding: 2px 3px; box-sizing: border-box;';

const ROW_BG_ACTIVE = 'rgba(255, 191, 0, 0.18)';
const ROW_BG_ACTIVE_BTN = 'rgba(255, 191, 0, 0.35)';

// Rows with an element string set, in DOM order - the same order/filter
// getAtoms() uses, so a candidate index from getAtoms() always maps to
// nonEmptyRows(container)[index] here.
function nonEmptyRows(container) {
  const tbody = container.querySelector('#atomsTable tbody');
  // `?.value`: a caller (StructureEditorPanel) may splice in a label-only
  // separator row that has no element input - it is never an atom.
  return [...tbody.querySelectorAll('tr')].filter(row => row.querySelector('.atom-element')?.value);
}

/**
 * createAtomTableEditor(container, options)
 *
 * atoms returned by getAtoms() are fractional (relative to the cell):
 * { uuid, element, x, y, z, color }; uuid is null for rows the user added.
 *
 * @param {HTMLElement} container
 * @param {{
 *   initialAtoms?: Array<{uuid?: string, element: string, x: number, y: number, z: number, color?: string}>,
 *   deletable?: boolean,
 *   onRowActivate?: (uuid: string|null) => void,
 *   onChange?: () => void,
 *   onDelete?: (snapshot: {uuid: string, element: string, x: number, y: number, z: number, color: string}) => void,
 * }} [options]
 */
export function createAtomTableEditor(container, {
  initialAtoms = [],
  deletable = false,
  onRowActivate = null,
  onChange = null,
  onDelete = null,
} = {}) {
  const STICKY_TH_STYLE = 'border: 1px solid #444; padding: 3px; font-size: 12px; text-align: center; position: sticky; top: 0; background: var(--popup-bg); z-index: 1;';

  // A dedicated first column of "highlight this atom in 3D" buttons — a big,
  // obvious click target, since the row chrome between the input fields is a
  // sliver too thin to hit reliably. Only meaningful against a live structure,
  // so it rides on the same onRowActivate the modify panel passes.
  const highlightable = !!onRowActivate;

  container.innerHTML = `
    <div style="margin-bottom: 10px;">
      <div id="atomsTableScroll" class="atoms-table-scroll" style="max-height: 208px; overflow-y: auto; margin-top: 10px;">
        <table id="atomsTable" style="width:100%; border-collapse: collapse;">
          <thead>
            <tr>
              ${highlightable ? `<th style="${STICKY_TH_STYLE}" title="Highlight the atom in the 3D view">◎</th>` : ''}
              <th style="${STICKY_TH_STYLE}">Element</th>
              <th style="${STICKY_TH_STYLE}" title="Fractional coordinate (0-1 spans the cell)">X (frac)</th>
              <th style="${STICKY_TH_STYLE}" title="Fractional coordinate (0-1 spans the cell)">Y (frac)</th>
              <th style="${STICKY_TH_STYLE}" title="Fractional coordinate (0-1 spans the cell)">Z (frac)</th>
              <th style="${STICKY_TH_STYLE}" title="Site occupancy (1 = fully occupied). Rows sharing a position form one disordered site.">Occ.</th>
              <th style="${STICKY_TH_STYLE}">Color</th>
              ${deletable ? `<th style="${STICKY_TH_STYLE}"></th>` : ''}
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
        <button id="applyBulk" class="btn-mini highlight" style="padding: 5px 10px;">Apply Bulk</button>
      </div>
    </div>
  `;

  const addRowHint = container.querySelector('#addRowHint');
  const tbody = container.querySelector('#atomsTable tbody');

  // Rows removed from the table but still belonging to the loaded structure -
  // the caller turns these into deletions on commit. `position` is the DOM
  // index the row sat at, so a restore puts it back where it was instead of
  // at the bottom.
  /** @type {Array<{uuid: string, element: string, x: number, y: number, z: number, color: string, position: number}>} */
  const deleted = [];

  let activeUuid = null;

  function notifyChange() {
    // Re-evaluate site grouping on every change, not just on load: editing a
    // coordinate can move a row on or off another site's position, and the
    // synced/disabled state of a mixed site's follower rows has to track that
    // live rather than only being right immediately after (re)load.
    groupSiteRows();
    onChange?.();
  }

  function readRow(row) {
    return {
      uuid: row.dataset.uuid || null,
      element: row.querySelector('.atom-element').value,
      x: parseFloat(row.querySelector('.atom-x').value) || 0,
      y: parseFloat(row.querySelector('.atom-y').value) || 0,
      z: parseFloat(row.querySelector('.atom-z').value) || 0,
      // Blank/garbage reads as fully occupied, which is what someone adding an
      // ordinary atom means and keeps the column ignorable.
      occupancy: (() => {
        const v = parseFloat(row.querySelector('.atom-occ').value);
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
      })(),
      color: row.querySelector('.color-swatch-btn').dataset.hex,
    };
  }

  function paintRows() {
    tbody.querySelectorAll('tr').forEach((row) => {
      const isActive = !!activeUuid && row.dataset.uuid === activeUuid;
      /** @type {HTMLElement} */ (row).style.background = isActive ? ROW_BG_ACTIVE : '';
      const btn = /** @type {HTMLElement} */ (row.querySelector('.atom-row-highlight'));
      if (btn) {
        btn.style.background = isActive ? ROW_BG_ACTIVE_BTN : '#333';
        btn.style.borderColor = isActive ? '#ffbf00' : '#555';
      }
    });
    groupSiteRows();
  }

  // A disordered site is one row per species, so several rows sharing a
  // position are one atom, not several - without this the table just looks
  // like "too many atoms". Rows are clustered by position (same tolerance the
  // commit-side merge uses), the first row of a cluster stays fully editable,
  // and every row after it has its coordinate inputs synced to match and
  // disabled: editing them would silently do nothing anyway, since the commit
  // only reads the cluster's first row for position (see CommitAtoms.js) - so
  // this turns a trap into a visible, intentional state instead of removing
  // it.
  function groupSiteRows() {
    const rows = [...tbody.querySelectorAll('tr')];

    // A brand-new row still sitting at its untouched (0,0,0) placeholder (see
    // buildRow's positionDirty comment) sits out of clustering entirely —
    // it never joins a cluster and, just as important, is never even a
    // candidate for one to match against, so a real row typed in afterward
    // at the same coordinates can't accidentally lock itself onto this one's
    // still-undecided position instead of a genuine existing atom's.
    const clusterableRows = rows.filter((row) => row.dataset.positionDirty === '1');
    const untouchedRows = rows.filter((row) => row.dataset.positionDirty !== '1');

    /** @type {Array<{x:number,y:number,z:number,rows:HTMLElement[]}>} */
    const clusters = [];
    for (const row of clusterableRows) {
      const x = parseFloat(/** @type {HTMLInputElement} */(row.querySelector('.atom-x'))?.value) || 0;
      const y = parseFloat(/** @type {HTMLInputElement} */(row.querySelector('.atom-y'))?.value) || 0;
      const z = parseFloat(/** @type {HTMLInputElement} */(row.querySelector('.atom-z'))?.value) || 0;
      const host = clusters.find((c) =>
        Math.abs(c.x - x) <= SITE_TOLERANCE
        && Math.abs(c.y - y) <= SITE_TOLERANCE
        && Math.abs(c.z - z) <= SITE_TOLERANCE);
      if (host) host.rows.push(/** @type {HTMLElement} */ (row));
      else clusters.push({ x, y, z, rows: [/** @type {HTMLElement} */ (row)] });
    }

    for (const cluster of clusters) {
      const mixed = cluster.rows.length > 1;
      cluster.rows.forEach((row, i) => {
        const secondary = mixed && i > 0;
        row.style.borderTop = mixed && i === 0 ? '2px solid rgba(255,193,7,0.35)' : '';
        row.style.background = secondary
          ? 'rgba(255,193,7,0.06)'
          : (row.style.background || '');
        for (const cls of ['.atom-x', '.atom-y', '.atom-z']) {
          const input = /** @type {HTMLInputElement} */ (row.querySelector(cls));
          if (!input) continue;
          // Never touch the input the user is actively typing into: this runs
          // synchronously on every keystroke (see the 'input' listener below),
          // and typing a coordinate digit-by-digit routinely passes through an
          // intermediate value that transiently matches another row (typing
          // "0.6" is "0" for one keystroke) — disabling or overwriting it right
          // then would strand the field the user is still typing in. The
          // 'blur' listener below re-evaluates once they've actually moved on.
          if (input === document.activeElement) continue;
          if (secondary) {
            // Mirror the primary row's value, not this row's stored own value
            // — the two must never independently drift once merged.
            const primaryInput = /** @type {HTMLInputElement} */ (cluster.rows[0].querySelector(cls));
            input.value = primaryInput.value;
            input.disabled = true;
            input.title = 'Same site as the row above — edit its X/Y/Z instead';
            input.style.opacity = '0.45';
          } else {
            input.disabled = false;
            input.title = '';
            input.style.opacity = '';
          }
        }
      });
    }

    for (const row of untouchedRows) {
      row.style.borderTop = '';
      row.style.background = '';
      for (const cls of ['.atom-x', '.atom-y', '.atom-z']) {
        const input = /** @type {HTMLInputElement} */ (row.querySelector(cls));
        if (!input) continue;
        input.disabled = false;
        input.title = '';
        input.style.opacity = '';
      }
    }
  }

  function buildRow(atom) {
    const { uuid = null, element = '', x = 0, y = 0, z = 0, color = null, occupancy = 1 } = atom || {};
    // A row added without an explicit colour (a fresh "Add New Atom" row, a bulk
    // line with no colour) tracks the element's default colour instead of a flat
    // black swatch, matching how a new atom looks everywhere else. A loaded atom
    // arrives with its own colour, so it opts out; picking a colour by hand stops
    // the tracking too.
    let autoColor = color == null;
    const initialColor = autoColor ? colorToHex(getElementDefaultColor(element)) : color;
    const newRow = document.createElement('tr');
    // Every row carries a uuid, not just prefilled ones: the live Modify
    // editor rebuilds the structure from this table on each change, and a
    // stable per-row uuid is the identity that keeps a just-added atom the
    // same atom across edits (and marks it "new" against the baseline set).
    newRow.dataset.uuid = uuid || generateID([element || 'atom']);
    // groupSiteRows() clusters rows by position and disables/locks every row
    // after the first in a cluster. A brand-new "+ Add New Atom" row (buildRow
    // called with no atom at all) defaults to (0,0,0) — a very common real
    // atom position — so without this it gets auto-clustered with whatever
    // sits at the origin the instant it gets an element typed in, locking its
    // coordinates before the user ever touches them. A row built from real
    // data (loaded, restored, bulk-pasted) already carries a deliberate
    // position, 0,0,0 or not, so it starts eligible for clustering; only a
    // truly blank new row waits until its own X/Y/Z is actually typed into.
    newRow.dataset.positionDirty = atom == null ? '' : '1';

    newRow.innerHTML = `
      ${highlightable ? `<td style="${CELL_STYLE} text-align:center;"><button type="button" class="atom-row-highlight" title="Highlight this atom in the 3D view" style="width:22px; height:22px; padding:0; line-height:1; border:1px solid #555; border-radius:3px; background:#333; color:white; cursor:pointer;">◎</button></td>` : ''}
      <td style="${CELL_STYLE}">
        <div style="display: flex; align-items: center; gap: 3px;">
          <input type="text" class="atom-element" value="${element}" style="width: 54px; background: #333; border: 1px solid #555; color: white; padding: 2px 3px; border-radius: 3px; box-sizing: border-box;">
          <button type="button" class="select-element-btn" title="Select Element" style="flex: none; width: 22px; height: 22px; background: #595959; border: none; color: white; cursor: pointer; font-size: 13px; border-radius: 3px; line-height: 1; padding: 0;">⚛</button>
        </div>
      </td>
      <td style="${CELL_STYLE}"><input type="number" class="atom-x coord-input" value="${x}" step="0.1" style="${NUM_INPUT_STYLE}"></td>
      <td style="${CELL_STYLE}"><input type="number" class="atom-y coord-input" value="${y}" step="0.1" style="${NUM_INPUT_STYLE}"></td>
      <td style="${CELL_STYLE}"><input type="number" class="atom-z coord-input" value="${z}" step="0.1" style="${NUM_INPUT_STYLE}"></td>
      <td style="${CELL_STYLE}"><input type="number" class="atom-occ coord-input" value="${occupancy}" step="0.05" min="0" max="1" style="${NUM_INPUT_STYLE}"></td>
      <td class="atom-color-cell" style="${CELL_STYLE} text-align:center;"></td>
      ${deletable ? `<td style="${CELL_STYLE} text-align:center;"><button type="button" class="atom-row-delete btn-mini" title="Remove this atom" style="width:20px; height:20px; padding:0; line-height:0; display:flex; align-items:center; justify-content:center;">✕</button></td>` : ''}
    `;

    const colorCell = newRow.querySelector('.atom-color-cell');
    const swatch = createColorSwatch(initialColor, () => {
      autoColor = false; // a hand-picked colour must not be overwritten
      newRow.dataset.dirty = '1';
      notifyChange();
    });
    colorCell.appendChild(swatch);

    const elementInput = newRow.querySelector('.atom-element');
    // Follow the element's default colour while the row is still auto-coloured.
    function refreshAutoColor() {
      if (!autoColor) return;
      const hex = colorToHex(getElementDefaultColor(elementInput.value.trim()));
      swatch.dataset.hex = hex;
      swatch.style.background = hex;
    }
    elementInput.addEventListener('input', () => {
      addRowHint.style.display = 'none';
      refreshAutoColor();
      notifyChange();
    });

    // Any typed edit pins the row: an inbound sync (the Structure Info panel's
    // position slider moving the same atom) must not overwrite a value the
    // user is in the middle of entering here. It also drives the live apply -
    // a coordinate keystroke moves the atom in the scene immediately.
    newRow.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        newRow.dataset.dirty = '1';
        if (input.classList.contains('atom-x') || input.classList.contains('atom-y') || input.classList.contains('atom-z')) {
          newRow.dataset.positionDirty = '1';
        }
        notifyChange();
      });
    });

    // groupSiteRows() skips the focused input while typing (see its own
    // comment) so a mid-edit value never gets disabled out from under the
    // user - this re-evaluates once they've actually finished with a
    // coordinate field, so a genuine match still locks/syncs as intended.
    newRow.querySelectorAll('.atom-x, .atom-y, .atom-z').forEach((input) => {
      input.addEventListener('blur', () => groupSiteRows());
    });

    newRow.querySelector('.select-element-btn').addEventListener('click', () => {
      openPeriodicTable((picked) => {
        elementInput.value = picked;
        newRow.dataset.dirty = '1';
        addRowHint.style.display = 'none';
        refreshAutoColor();
        notifyChange();
      });
    });

    const deleteBtn = newRow.querySelector('.atom-row-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeRow(newRow);
      });
    }

    if (onRowActivate) {
      const activate = () => {
        setActiveUuid(newRow.dataset.uuid === activeUuid ? null : newRow.dataset.uuid || null);
        onRowActivate(activeUuid);
      };
      // The dedicated button is the reliable target; a click anywhere on the
      // row chrome (not into an input/other button) still works as a shortcut.
      newRow.querySelector('.atom-row-highlight')?.addEventListener('click', (e) => {
        e.stopPropagation();
        activate();
      });
      newRow.style.cursor = 'pointer';
      newRow.title = 'Click to highlight this atom in the 3D view';
      newRow.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target.closest('input, button')) return;
        activate();
      });
    }

    return newRow;
  }

  function addRowToTable(atom) {
    // Drop a trailing blank row before appending, so the seeded empty row
    // doesn't linger below real entries.
    const rows = tbody.querySelectorAll('tr');
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const elementInput = lastRow.querySelector('.atom-element');
      if (!elementInput || elementInput.value === '') tbody.removeChild(lastRow);
    }
    tbody.appendChild(buildRow(atom));
  }

  function removeRow(row) {
    const uuid = row.dataset.uuid;
    if (uuid) {
      const position = [...tbody.querySelectorAll('tr')].indexOf(row);
      const snapshot = { ...readRow(row), uuid, position };
      deleted.push(snapshot);
      if (activeUuid === uuid) activeUuid = null;
      onDelete?.(snapshot);
    }
    row.remove();
    notifyChange();
  }

  // Put a previously removed row back where it was. Returns false for a uuid
  // that isn't in the removed list.
  function restoreAtom(uuid) {
    const index = deleted.findIndex((entry) => entry.uuid === uuid);
    if (index === -1) return false;
    const entry = deleted.splice(index, 1)[0];
    const row = buildRow(entry);
    const siblings = [...tbody.querySelectorAll('tr')];
    const before = siblings[entry.position];
    if (before) tbody.insertBefore(row, before);
    else tbody.appendChild(row);
    notifyChange();
    return true;
  }

  // Refresh one existing row's coordinates/color from outside (the Structure
  // Info panel edited the same atom). Rows the user has typed into are left
  // alone - see the dirty flag above.
  function syncRow(uuid, { x, y, z, color }) {
    const row = tbody.querySelector(`tr[data-uuid="${uuid}"]`);
    if (!row || row.dataset.dirty) return;
    if (Number.isFinite(x)) row.querySelector('.atom-x').value = String(x);
    if (Number.isFinite(y)) row.querySelector('.atom-y').value = String(y);
    if (Number.isFinite(z)) row.querySelector('.atom-z').value = String(z);
    if (color) {
      const swatch = /** @type {HTMLElement} */ (row.querySelector('.color-swatch-btn'));
      swatch.dataset.hex = color;
      swatch.style.background = color;
    }
  }

  function setActiveUuid(uuid) {
    activeUuid = uuid;
    paintRows();
  }

  if (initialAtoms.length) initialAtoms.forEach((atom) => tbody.appendChild(buildRow(atom)));
  else addRowToTable();
  paintRows();

  container.querySelector('#addNewRow').addEventListener('click', () => {
    const lastRow = tbody.querySelector('tr:last-child');
    const lastElement = lastRow?.querySelector('.atom-element').value;
    if (lastRow && !lastElement) {
      addRowHint.style.display = 'block';
      return;
    }
    addRowHint.style.display = 'none';
    addRowToTable();
    notifyChange();
    container.querySelector('#atomsTableScroll').scrollTop = container.querySelector('#atomsTableScroll').scrollHeight;
  });

  container.querySelector('#applyBulk').addEventListener('click', () => {
    const bulkInput = container.querySelector('#bulkInput').value;
    const lines = bulkInput.split('\n');

    tbody.querySelectorAll('tr').forEach(row => {
      const elementInput = row.querySelector('.atom-element');
      if (!elementInput || elementInput.value === '') tbody.removeChild(row);
    });

    lines.forEach(line => {
      if (line.trim() === '') return;

      // Parse line in format: Element x y z [color]
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        addRowToTable({
          element: parts[0],
          x: parseFloat(parts[1]) || 0,
          y: parseFloat(parts[2]) || 0,
          z: parseFloat(parts[3]) || 0,
          color: parts[4], // omitted -> the row tracks the element default
        });
      }
    });

    container.querySelector('#bulkInput').value = '';
    notifyChange();
  });

  function getAtoms() {
    return nonEmptyRows(container).map(readRow);
  }

  function getDeleted() {
    return deleted.map((entry) => ({ ...entry }));
  }

  function clear() {
    tbody.innerHTML = '';
    deleted.length = 0;
    activeUuid = null;
    addRowToTable();
    container.querySelector('#bulkInput').value = '';
    addRowHint.style.display = 'none';
    notifyChange();
  }

  // Repopulate the table from a fresh atom list (Modify's "Revert Changes"
  // rebuilds the structure, so the open table has to be rebuilt to match).
  function reload(atoms) {
    tbody.innerHTML = '';
    deleted.length = 0;
    activeUuid = null;
    if (atoms.length) atoms.forEach((atom) => tbody.appendChild(buildRow(atom)));
    else addRowToTable();
    notifyChange();
  }

  // Add one atom row (restoring a removed atom keeps its original uuid so the
  // diff recognises it as one of the originals coming back, not a new one).
  // A numeric `atom.position` (the row index it was deleted from, saved in the
  // delete snapshot) reinserts it at that spot, so a restored original lands
  // back in the old stack where it came from rather than appended below the
  // newly-added atoms. Falls back to appending when there is no such slot.
  function addAtom(atom) {
    const before = Number.isInteger(atom.position)
      ? [...tbody.querySelectorAll('tr')][atom.position]
      : null;
    if (before) tbody.insertBefore(buildRow(atom), before);
    else addRowToTable(atom);
    notifyChange();
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

  return { getAtoms, getDeleted, restoreAtom, syncRow, setActiveUuid, clear, reload, addAtom, highlightConflicts, clearConflicts };
}
