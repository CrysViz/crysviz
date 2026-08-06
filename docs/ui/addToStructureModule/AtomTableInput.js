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
import { parseChargeInput } from '../../render/ChargeBadgeModule.js';

// Column-width classes (addStructure.css: .addstructure-col-*) exist because
// the auto-layout table hands any UNCONSTRAINED column 100% of the leftover
// width the instant the panel is undocked/floating and wider than its docked
// default - Element used to visibly eat the extra room, then Color and the
// icon columns after it, until every column got a fixed width.

// The active-row highlight (paintRows) is left as inline style, not a class:
// groupSiteRows() below reads `row.style.background` back to decide whether
// a clustered secondary row should keep it, and a class-only implementation
// would make that read-back see nothing. See groupSiteRows' own comment.
const ROW_BG_ACTIVE = 'rgba(255, 191, 0, 0.18)';

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
 * { uuid, element, x, y, z, occupancy, oxidationState, color }; uuid is null
 * for rows the user added. oxidationState is null for a blank Charge cell
 * ("unspecified"), distinct from an explicitly typed 0 ("neutral").
 *
 * @param {HTMLElement} container
 * @param {{
 *   initialAtoms?: Array<{uuid?: string, element: string, x: number, y: number, z: number, occupancy?: number, oxidationState?: number|null, color?: string}>,
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
  // A dedicated first column of "highlight this atom in 3D" buttons — a big,
  // obvious click target, since the row chrome between the input fields is a
  // sliver too thin to hit reliably. Only meaningful against a live structure,
  // so it rides on the same onRowActivate the modify panel passes.
  const highlightable = !!onRowActivate;

  container.innerHTML = `
    <div class="atom-table-wrap">
      <div id="atomsTableScroll" class="atoms-table-scroll">
        <table id="atomsTable" class="addstructure-table">
          <thead>
            <tr>
              ${highlightable ? `<th class="addstructure-sticky-th addstructure-col-icon" title="Highlight the atom in the 3D view">◎</th>` : ''}
              <th class="addstructure-sticky-th addstructure-col-element">Element</th>
              <th class="addstructure-sticky-th addstructure-col-coord" title="Fractional coordinate (0-1 spans the cell)">X</th>
              <th class="addstructure-sticky-th addstructure-col-coord" title="Fractional coordinate (0-1 spans the cell)">Y</th>
              <th class="addstructure-sticky-th addstructure-col-coord" title="Fractional coordinate (0-1 spans the cell)">Z</th>
              <th class="addstructure-sticky-th addstructure-col-narrow" title="Site occupancy (1 = fully occupied). Rows sharing a position form one disordered site.">Occ.</th>
              <th class="addstructure-sticky-th addstructure-col-narrow" title="Formal charge / oxidation state - 3, -2, 3+ or 2- all work. Blank = unspecified; 0 is a deliberate 'neutral' statement, not the same as blank.">Charge</th>
              <th class="addstructure-sticky-th addstructure-col-color">Color</th>
              ${deletable ? `<th class="addstructure-sticky-th addstructure-col-icon"></th>` : ''}
            </tr>
          </thead>
          <tbody>
            <!-- Rows will be added dynamically -->
          </tbody>
        </table>
      </div>

      <div class="atom-table-add-row">
        <button id="addNewRow" class="btn-mini highlight addstructure-full-btn">
          + Add New Atom
        </button>
        <div id="addRowHint" class="atom-table-add-hint">Select element first</div>
      </div>
    </div>

    <div class="atom-table-bulk-row">
      <textarea id="bulkInput" class="atom-table-bulk-textarea" placeholder="Element x y z [occ] [color]
Example:
H 0.5 0.5 0.5 #FF0000
C 1.0 1.0 1.0 0.6
O 1.5 1.5 1.5 0.4 #00FF00"></textarea>
      <div class="atom-table-bulk-btn-col">
        <button id="applyBulk" class="btn-mini highlight atom-table-bulk-apply-btn">Apply Bulk</button>
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
      // Blank (or anything parseChargeInput doesn't recognize) reads as null
      // ("unspecified"), distinct from an explicitly typed 0 ("neutral") -
      // ChargeBadgeModule.js/formatCharge() already draw that same
      // distinction (a badge shows "0", not nothing, for a declared-neutral
      // site). Accepts "3"/"-2" same as before, plus chemistry notation
      // ("3+", "2-") - see parseChargeInput's own doc for the accepted forms.
      oxidationState: parseChargeInput(row.querySelector('.atom-charge').value),
      color: row.querySelector('.color-swatch-btn').dataset.hex,
    };
  }

  function paintRows() {
    tbody.querySelectorAll('tr').forEach((row) => {
      const isActive = !!activeUuid && row.dataset.uuid === activeUuid;
      /** @type {HTMLElement} */ (row).style.background = isActive ? ROW_BG_ACTIVE : '';
      const btn = /** @type {HTMLElement} */ (row.querySelector('.atom-row-highlight'));
      btn?.classList.toggle('is-active', isActive);
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
          } else {
            input.disabled = false;
            input.title = '';
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
      }
    }
  }

  function buildRow(atom) {
    const { uuid = null, element = '', x = 0, y = 0, z = 0, color = null, occupancy = 1, oxidationState = null } = atom || {};
    // Blank input for "unspecified" - see readRow()'s matching parse.
    const chargeValue = Number.isFinite(oxidationState) ? oxidationState : '';
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
      ${highlightable ? `<td class="addstructure-cell addstructure-col-icon"><button type="button" class="atom-row-highlight addstructure-highlight-btn" title="Highlight this atom in the 3D view">◎</button></td>` : ''}
      <td class="addstructure-cell addstructure-col-element">
        <div class="addstructure-inline-row">
          <input type="text" class="atom-element addstructure-element-input" value="${element}">
          <button type="button" class="select-element-btn addstructure-pick-btn" title="Select Element">⚛</button>
        </div>
      </td>
      <td class="addstructure-cell addstructure-col-coord"><input type="number" class="atom-x coord-input addstructure-num-input" value="${x}" step="0.1"></td>
      <td class="addstructure-cell addstructure-col-coord"><input type="number" class="atom-y coord-input addstructure-num-input" value="${y}" step="0.1"></td>
      <td class="addstructure-cell addstructure-col-coord"><input type="number" class="atom-z coord-input addstructure-num-input" value="${z}" step="0.1"></td>
      <td class="addstructure-cell addstructure-col-narrow"><input type="number" class="atom-occ coord-input addstructure-num-input" value="${occupancy}" step="0.05" min="0" max="1"></td>
      <td class="addstructure-cell addstructure-col-narrow"><input type="text" inputmode="numeric" class="atom-charge coord-input addstructure-num-input" value="${chargeValue}" placeholder="—" title="Formal charge / oxidation state, e.g. 3, -2, 3+ or 2-. Blank = unspecified."></td>
      <td class="atom-color-cell addstructure-cell addstructure-col-color"></td>
      ${deletable ? `<td class="addstructure-cell addstructure-col-icon"><button type="button" class="atom-row-delete btn-mini addstructure-icon-btn" title="Remove this atom">✕</button></td>` : ''}
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
      addRowHint.classList.remove('visible');
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
        addRowHint.classList.remove('visible');
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
      newRow.classList.add('atom-row-activatable');
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
      addRowHint.classList.add('visible');
      return;
    }
    addRowHint.classList.remove('visible');
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

      // Parse line in format: Element x y z [occ] [color]. The two trailing
      // fields are order-tolerant and each optional: a '#RRGGBB' token is the
      // colour, a bare number is the occupancy (a partially occupied site).
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        let occupancy = 1;
        let color; // omitted -> the row tracks the element default
        for (const token of parts.slice(4)) {
          if (token.startsWith('#')) {
            color = token;
          } else {
            const occ = parseFloat(token);
            if (Number.isFinite(occ)) occupancy = Math.min(1, Math.max(0, occ));
          }
        }
        addRowToTable({
          element: parts[0],
          x: parseFloat(parts[1]) || 0,
          y: parseFloat(parts[2]) || 0,
          z: parseFloat(parts[3]) || 0,
          occupancy,
          color,
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
    addRowHint.classList.remove('visible');
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
