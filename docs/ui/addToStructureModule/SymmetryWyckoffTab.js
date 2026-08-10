// SymmetryWyckoffTab.js
//
// The Add-Structure panel's "Symmetry (Wyckoff)" tab: build a structure from a
// space group plus a list of Wyckoff sites, instead of typing out every atom.
// Each site (element + Wyckoff letter + representative position) is expanded
// into its full orbit of symmetry-equivalent atoms by WyckoffProjector.js, and
// the combined result is committed through exactly the same pipeline as the
// Atoms tab: checkAtomCollisions -> wireCollisionGuardedButton ->
// createNewStructureFromAtoms. That is what the tab gets the identical
// collision warning / "Create Anyway" behaviour from, with no changes to those
// shared modules.
//
// Choosing a space group is the defining action here, so it comes first and
// constrains everything below it:
//   - the lattice, via WyckoffLatticeConstraints.js (cubic locks a = b = c and
//     all angles to 90, and so on) - this is why the tab owns its own Lattice
//     section rather than sharing the Atoms tab's free-form one;
//   - each site's coordinates, since a Wyckoff position generally fixes or
//     ties together some of x/y/z (SG 194 letter k is "x,2x,z": y is not an
//     independent input, it is 2x). Frozen coordinates are disabled and shown
//     with the value the symmetry gives them.

import { createLatticeInputPanel } from './LatticeInputPanel.js';
import { checkAtomCollisions, conflictingCandidateIndices } from './AtomCollisionCheck.js';
import { createNewStructureFromAtoms } from './CommitAtoms.js';
import { wireCollisionGuardedButton } from './CollisionWarningUI.js';
import { createLatticeConstraintController, describeLatticeConstraints } from './WyckoffLatticeConstraints.js';
import {
  loadSymmetryData,
  getWyckoffLetters,
  getSpaceGroupInfo,
  getSiteFreedom,
  constrainRepresentative,
  projectWyckoffOrbit,
} from './WyckoffProjector.js';
import { createSpaceGroupSelect } from './SpaceGroupSelect.js';
import { makeSectionHeadline } from '../panels/sectionHeadline.js';
import { openPeriodicTable } from '../PeriodicTableSelectPanel.js';
import { fracToCartPoint } from '../../math/index.js';
import { invalidElementMessage } from './ElementValidation.js';

const COLLISION_THRESHOLD_ANGSTROM = 0.5;
const DEFAULT_SPACE_GROUP = 225;

const AXES = ['x', 'y', 'z'];

function clampSpaceGroup(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_SPACE_GROUP;
  return Math.min(230, Math.max(1, number));
}

// Rows with an element set, in DOM order - matches readSites()'s filter, so a
// site index from readSites() always maps back to nonEmptyRows()[index].
function nonEmptyRows(sitesHost) {
  return [...sitesHost.querySelectorAll('tbody tr')]
    .filter((row) => row.querySelector('.wyckoff-element').value.trim());
}

// createSymmetryWyckoffTab(container, onCreated)
//   onCreated: called after a structure is successfully created, so the host
//   panel can close itself (mirrors the Atoms tab's callback).
export function createSymmetryWyckoffTab(container, onCreated = () => {}) {
  const loading = document.createElement('div');
  loading.textContent = 'Loading symmetry data…';
  loading.className = 'wyckoff-tab-loading';
  container.appendChild(loading);

  // ~8.9 MB of space-group tables, fetched only now that the tab is open.
  loadSymmetryData()
    .then(() => {
      loading.remove();
      buildTab(container, onCreated);
    })
    .catch((error) => {
      loading.textContent = `Could not load symmetry data: ${error.message}`;
      loading.classList.add('wyckoff-tab-loading--error');
      console.error('Wyckoff tab: symmetry data failed to load', error);
    });
}

function buildTab(container, onCreated) {
  let spaceGroup = DEFAULT_SPACE_GROUP;
  let letters = getWyckoffLetters(spaceGroup);
  // Which site row each generated atom came from, recorded during the
  // collision check so onWarn can highlight rows rather than invisible atoms.
  let lastSiteIndexOfAtom = [];

  // ---- Space group ------------------------------------------------------
  container.appendChild(makeSectionHeadline('Space Group'));

  const sgRow = document.createElement('div');
  sgRow.className = 'wyckoff-sg-row';
  sgRow.innerHTML = `
    <label class="wyckoff-sg-label">Space group</label>
  `;
  const spaceGroupHost = document.createElement('div');
  spaceGroupHost.className = 'wyckoff-sg-host';
  sgRow.appendChild(spaceGroupHost);
  container.appendChild(sgRow);

  const spaceGroupName = document.createElement('div');
  spaceGroupName.className = 'wyckoff-sg-name';
  container.appendChild(spaceGroupName);

  const constraintHint = document.createElement('div');
  constraintHint.className = 'wyckoff-sg-hint';
  container.appendChild(constraintHint);

  // ---- Lattice ----------------------------------------------------------
  const latticeHost = document.createElement('div');
  container.appendChild(latticeHost);
  const latticePanel = createLatticeInputPanel(latticeHost);
  const latticeConstraints = createLatticeConstraintController(latticeHost);

  // ---- Sites ------------------------------------------------------------
  container.appendChild(makeSectionHeadline('Wyckoff Sites'));

  const sitesHost = document.createElement('div');
  sitesHost.innerHTML = `
    <div class="wyckoff-sg-sites-scroll">
      <table class="addstructure-table">
        <thead>
          <tr>
            <th class="addstructure-sticky-th">Element</th>
            <th class="addstructure-sticky-th" title="Wyckoff letter, restricted to the sites this space group defines">Site</th>
            <th class="addstructure-sticky-th" title="Fractional coordinate (0-1 spans the cell)">X (frac)</th>
            <th class="addstructure-sticky-th" title="Fractional coordinate (0-1 spans the cell)">Y (frac)</th>
            <th class="addstructure-sticky-th" title="Fractional coordinate (0-1 spans the cell)">Z (frac)</th>
            <th class="addstructure-sticky-th"></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="wyckoff-sg-add-row">
      <button id="wyckoffAddSite" class="btn-mini highlight addstructure-full-btn">+ Add Site</button>
    </div>
  `;
  container.appendChild(sitesHost);
  const tbody = sitesHost.querySelector('tbody');

  const summary = document.createElement('div');
  summary.className = 'wyckoff-sg-summary';
  container.appendChild(summary);

  const warningHost = document.createElement('div');
  container.appendChild(warningHost);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'addstructure-button-row';
  const createBtn = document.createElement('button');
  createBtn.className = 'btn-mini highlight';
  createBtn.textContent = 'Create Structure';
  buttonRow.appendChild(createBtn);
  container.appendChild(buttonRow);

  // ---- Row construction -------------------------------------------------

  function letterOptions(selected) {
    return letters
      .map((letter) => {
        const { multiplicity, siteSymmetry } = getSiteFreedom(spaceGroup, letter);
        const label = `${multiplicity}${letter}${siteSymmetry ? ` (${siteSymmetry})` : ''}`;
        return `<option value="${letter}" ${letter === selected ? 'selected' : ''}>${label}</option>`;
      })
      .join('');
  }

  // Disable the coordinates this site does not leave free, and fill every
  // coordinate with what the symmetry actually makes of the typed values, so
  // the boxes always show the position that will really be generated.
  function syncRowFreedom(row) {
    const letter = row.querySelector('.wyckoff-letter').value;
    if (!letter) return;
    const { hasFreedom, firstOrbit } = getSiteFreedom(spaceGroup, letter);
    const typed = AXES.map((axis) => parseFloat(row.querySelector(`.wyckoff-${axis}`).value) || 0);
    const actual = constrainRepresentative(spaceGroup, letter, typed);

    AXES.forEach((axis, index) => {
      const input = row.querySelector(`.wyckoff-${axis}`);
      const free = hasFreedom[index] !== false;
      input.disabled = !free;
      input.title = free ? '' : `Determined by site ${letter} (${firstOrbit})`;
      // Only overwrite what the user is not currently editing: a free axis
      // keeps exactly what was typed, a locked one shows its derived value.
      if (!free) input.value = String(Number(actual[index].toFixed(6)));
    });

    row.querySelector('.wyckoff-form').textContent = firstOrbit;
  }

  function addSiteRow(element = '', letter = letters[0]) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="addstructure-cell">
        <div class="addstructure-inline-row">
          <input type="text" class="wyckoff-element wyckoff-text-input" value="${element}">
          <button type="button" class="wyckoff-select-element addstructure-pick-btn" title="Select Element">⚛</button>
        </div>
      </td>
      <td class="addstructure-cell">
        <select class="wyckoff-letter wyckoff-coord-input">${letterOptions(letter)}</select>
        <div class="wyckoff-form wyckoff-site-form"></div>
      </td>
      <td class="addstructure-cell"><input type="number" class="wyckoff-x coord-input wyckoff-coord-input" value="0" step="0.05"></td>
      <td class="addstructure-cell"><input type="number" class="wyckoff-y coord-input wyckoff-coord-input" value="0" step="0.05"></td>
      <td class="addstructure-cell"><input type="number" class="wyckoff-z coord-input wyckoff-coord-input" value="0" step="0.05"></td>
      <td class="addstructure-cell addstructure-center">
        <button type="button" class="wyckoff-remove-site btn-mini addstructure-icon-btn" title="Remove this site">✕</button>
      </td>
    `;
    tbody.appendChild(row);

    row.querySelector('.wyckoff-select-element').addEventListener('click', () => {
      openPeriodicTable((picked) => {
        row.querySelector('.wyckoff-element').value = picked;
        refreshSummary();
      });
    });
    row.querySelector('.wyckoff-letter').addEventListener('change', () => {
      syncRowFreedom(row);
      refreshSummary();
    });
    row.querySelectorAll('.coord-input').forEach((input) => {
      input.addEventListener('change', () => {
        syncRowFreedom(row);
        refreshSummary();
      });
    });
    row.querySelector('.wyckoff-element').addEventListener('input', refreshSummary);
    row.querySelector('.wyckoff-remove-site').addEventListener('click', () => {
      row.remove();
      if (!tbody.querySelector('tr')) addSiteRow();
      refreshSummary();
    });

    syncRowFreedom(row);
    return row;
  }

  // ---- Reading + projecting ---------------------------------------------

  function readSites() {
    return nonEmptyRows(sitesHost).map((row) => ({
      element: row.querySelector('.wyckoff-element').value.trim(),
      wyckoff: row.querySelector('.wyckoff-letter').value,
      representativePosition: AXES.map((axis) => parseFloat(row.querySelector(`.wyckoff-${axis}`).value) || 0),
    }));
  }

  // Expand every site into atoms, keeping which site row each atom came from
  // so a collision involving a generated atom can be traced back to the row
  // the user has to fix (they never see the individual generated atoms).
  function projectSites() {
    const atoms = [];
    const siteIndexOfAtom = [];
    readSites().forEach((site, siteIndex) => {
      let orbit;
      try {
        orbit = projectWyckoffOrbit(spaceGroup, site.wyckoff, site.representativePosition);
      } catch (error) {
        console.warn('Wyckoff tab: could not project site', site, error);
        return;
      }
      orbit.positions.forEach((position) => {
        atoms.push({ element: site.element, x: position[0], y: position[1], z: position[2] });
        siteIndexOfAtom.push(siteIndex);
      });
    });
    return { atoms, siteIndexOfAtom };
  }

  function refreshSummary() {
    const sites = readSites();
    if (!sites.length) {
      summary.textContent = 'Add at least one site to generate a structure.';
      return;
    }
    const { atoms } = projectSites();
    const perSite = sites.map((site) => {
      const { multiplicity } = getSiteFreedom(spaceGroup, site.wyckoff);
      return `${site.element || '?'} ${multiplicity}${site.wyckoff}`;
    });
    summary.textContent = `${atoms.length} atom${atoms.length === 1 ? '' : 's'}: ${perSite.join(' + ')}`;
  }

  // ---- Space-group changes ----------------------------------------------

  function applySpaceGroup() {
    const info = getSpaceGroupInfo(spaceGroup);
    letters = getWyckoffLetters(spaceGroup);

    const setting = info.settingCode ? ` · setting ${info.settingCode}` : '';
    spaceGroupName.textContent = `${info.hmShort} · ${info.crystalSystem}${setting}`;
    constraintHint.textContent = `Lattice constrained by ${info.crystalSystem} symmetry: ${describeLatticeConstraints(info.crystalSystem)}.`;

    latticeConstraints.setCrystalSystem(info.crystalSystem);

    // Keep each row's letter if the new group still defines it, else fall back
    // to its first site, then re-derive that row's frozen coordinates.
    tbody.querySelectorAll('tr').forEach((row) => {
      const select = row.querySelector('.wyckoff-letter');
      const previous = select.value;
      select.innerHTML = letterOptions(letters.includes(previous) ? previous : letters[0]);
      syncRowFreedom(row);
    });
    refreshSummary();
  }

  createSpaceGroupSelect(spaceGroupHost, {
    value: spaceGroup,
    onChange: (number) => {
      spaceGroup = clampSpaceGroup(number);
      applySpaceGroup();
    },
  });

  sitesHost.querySelector('#wyckoffAddSite').addEventListener('click', () => {
    addSiteRow();
    refreshSummary();
  });

  // ---- Commit -----------------------------------------------------------

  wireCollisionGuardedButton({
    button: createBtn,
    warningContainer: warningHost,
    watchContainer: sitesHost,
    defaultLabel: 'Create Structure',
    anywayLabel: 'Create Anyway',
    validate: () => {
      const sites = readSites();
      if (!sites.length) return 'Add at least one Wyckoff site.';
      return invalidElementMessage(sites);
    },
    checkCollisions: () => {
      const { atoms, siteIndexOfAtom } = projectSites();
      if (!atoms.length) return { tooClose: [] };
      const lattice = latticePanel.getLattice();
      const candidateAtoms = atoms.map((a) => ({
        position: fracToCartPoint([a.x, a.y, a.z], lattice),
        element: a.element,
      }));
      const result = checkAtomCollisions({
        lattice,
        existingAtoms: [],
        candidateAtoms,
        thresholdAngstrom: COLLISION_THRESHOLD_ANGSTROM,
      });
      // Remap generated-atom indices onto site rows for highlighting.
      lastSiteIndexOfAtom = siteIndexOfAtom;
      return result;
    },
    onWarn: (tooClose) => {
      const rows = nonEmptyRows(sitesHost);
      rows.forEach((row) => row.classList.remove('atom-row-conflict'));
      for (const atomIndex of conflictingCandidateIndices(tooClose)) {
        rows[lastSiteIndexOfAtom[atomIndex]]?.classList.add('atom-row-conflict');
      }
    },
    onClear: () => {
      nonEmptyRows(sitesHost).forEach((row) => row.classList.remove('atom-row-conflict'));
    },
    commit: () => {
      const { atoms } = projectSites();
      if (!atoms.length) return;
      createNewStructureFromAtoms(atoms, {
        lattice: latticePanel.getLattice(),
        fileName: `SG${spaceGroup}_structure`,
      });
      onCreated();
    },
  });

  addSiteRow();
  applySpaceGroup();
}
