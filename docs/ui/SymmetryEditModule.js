import init, { analyze_cell } from '../external/moyo-test/moyo_wasm.js';
import { fileBrowser, general, structureShip } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { PT_INVERTED } from './BackendPanel/MoyoWASM.js';
import { cartToFrac, fracToCart, invert3x3, transpose3x3, latticeFromCell, latticeParameters } from '../math/index.js';
import { clearSelectedAtoms } from './SelectAndHighlightModule.js';
import { Atom } from '../model/index.js';
import { generateID } from '../utils/index.js';

let moyoReady = null;

// moyo's symmetry tolerance (symprec), in Å. The live value is
// general.symmetryTolerance in state/store.js (the Symmetry panel's Tolerance
// box reads and writes it); this constant is only the fallback if that is ever
// missing or nonsense. Every entry point defaults to defaultSymprec(), so the
// panel and internal calls cannot silently disagree.
export const DEFAULT_SYMPREC = 0.01;

export function defaultSymprec() {
  const value = general.symmetryTolerance;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SYMPREC;
}

// Two symmetry-equivalent atoms closer than symprec are, to moyo, one atom on
// a higher-symmetry site — and its primitive-cell search then fails outright
// ("PrimitiveSymmetrySearchError"), leaving a structure whose symmetry can no
// longer be analysed at all. Orbit moves are refused just before that point
// (measured: at symprec 0.01 Å the search still succeeds at ~0.06 Å apart and
// fails at ~0.012 Å), with a floor so a tiny symprec cannot allow literal
// duplicates. This is a Cartesian distance, unrelated to symprec except that
// its whole job is keeping the cell analysable AT that symprec.
function minSiteSeparation(tolerance = defaultSymprec()) {
  return Math.max(4 * tolerance, 0.05);
}

function wrap01(x) {
  return ((x % 1) + 1) % 1;
}

function wrapFrac(pos) {
  return [wrap01(pos[0]), wrap01(pos[1]), wrap01(pos[2])];
}

function fracDelta(a, b) {
  return a.map((value, axis) => {
    let diff = value - b[axis];
    diff -= Math.round(diff);
    return diff;
  });
}

function fracDistance(a, b) {
  const d = fracDelta(a, b);
  return Math.hypot(d[0], d[1], d[2]);
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function scale(vector, value) {
  return vector.map((component) => component * value);
}

function add(a, b) {
  return a.map((value, axis) => value + b[axis]);
}

function normalize(vector, tolerance = 1e-10) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length <= tolerance) return null;
  return vector.map((value) => value / length);
}

/** Transpose a flat 3x3 (row-major <-> column-major). */
function transpose3(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function applyOperation(position, operation) {
  const r = operation.rotation;
  const t = operation.translation;
  const x = position[0];
  const y = position[1];
  const z = position[2];
  return wrapFrac([
    r[0] * x + r[1] * y + r[2] * z + t[0],
    r[3] * x + r[4] * y + r[5] * z + t[1],
    r[6] * x + r[7] * y + r[8] * z + t[2],
  ]);
}

function findMatchingOperation(repPosition, targetPosition, operations, tolerance = 1e-4) {
  for (let i = 0; i < operations.length; i += 1) {
    const mapped = applyOperation(repPosition, operations[i]);
    if (fracDistance(mapped, targetPosition) <= tolerance) return i;
  }
  return 0;
}

function matrixRank(rows, tolerance = 1e-8) {
  if (!rows.length) return 0;
  const m = rows.map((row) => [...row]);
  const rowCount = m.length;
  const colCount = m[0].length;
  let rank = 0;
  let pivotRow = 0;

  for (let col = 0; col < colCount && pivotRow < rowCount; col += 1) {
    let bestRow = pivotRow;
    for (let row = pivotRow + 1; row < rowCount; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[bestRow][col])) bestRow = row;
    }
    if (Math.abs(m[bestRow][col]) <= tolerance) continue;

    [m[pivotRow], m[bestRow]] = [m[bestRow], m[pivotRow]];
    const pivot = m[pivotRow][col];
    for (let j = col; j < colCount; j += 1) m[pivotRow][j] /= pivot;

    for (let row = 0; row < rowCount; row += 1) {
      if (row === pivotRow) continue;
      const factor = m[row][col];
      if (Math.abs(factor) <= tolerance) continue;
      for (let j = col; j < colCount; j += 1) m[row][j] -= factor * m[pivotRow][j];
    }

    rank += 1;
    pivotRow += 1;
  }

  return rank;
}

function rref(matrix, tolerance = 1e-8) {
  const m = matrix.map((row) => [...row]);
  const pivotColumns = [];
  let pivotRow = 0;

  for (let col = 0; col < 3 && pivotRow < m.length; col += 1) {
    let bestRow = pivotRow;
    for (let row = pivotRow + 1; row < m.length; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[bestRow][col])) bestRow = row;
    }
    if (Math.abs(m[bestRow][col]) <= tolerance) continue;

    [m[pivotRow], m[bestRow]] = [m[bestRow], m[pivotRow]];
    const pivot = m[pivotRow][col];
    for (let j = col; j < 3; j += 1) m[pivotRow][j] /= pivot;

    for (let row = 0; row < m.length; row += 1) {
      if (row === pivotRow) continue;
      const factor = m[row][col];
      if (Math.abs(factor) <= tolerance) continue;
      for (let j = col; j < 3; j += 1) m[row][j] -= factor * m[pivotRow][j];
    }

    pivotColumns.push(col);
    pivotRow += 1;
  }

  return { matrix: m, pivotColumns };
}

function nullspaceBasis(rows, tolerance = 1e-8) {
  if (!rows.length) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const { matrix, pivotColumns } = rref(rows, tolerance);
  const freeColumns = [0, 1, 2].filter((column) => !pivotColumns.includes(column));
  const basis = [];

  freeColumns.forEach((freeColumn) => {
    const vector = [0, 0, 0];
    vector[freeColumn] = 1;
    pivotColumns.forEach((pivotColumn, rowIndex) => {
      vector[pivotColumn] = -matrix[rowIndex][freeColumn];
    });
    basis.push(vector);
  });

  const orthonormalBasis = [];
  basis.forEach((candidate) => {
    let projected = [...candidate];
    orthonormalBasis.forEach((basisVector) => {
      const amount = dot(projected, basisVector);
      projected = add(projected, scale(basisVector, -amount));
    });
    const normalized = normalize(projected, tolerance);
    if (normalized) orthonormalBasis.push(normalized);
  });

  return orthonormalBasis;
}

function computeOrbitFreedom(representativePosition, operations, tolerance = 1e-4) {
  const stabilizer = operations.filter((operation) =>
    fracDistance(applyOperation(representativePosition, operation), representativePosition) <= tolerance
  );
  const equations = [];

  stabilizer.forEach((operation) => {
    const r = operation.rotation;
    equations.push([r[0] - 1, r[1], r[2]]);
    equations.push([r[3], r[4] - 1, r[5]]);
    equations.push([r[6], r[7], r[8] - 1]);
  });

  const rank = matrixRank(equations);
  const basis = nullspaceBasis(equations);
  const dofDimension = Math.max(0, 3 - rank);
  return {
    stabilizerCount: stabilizer.length,
    dofDimension,
    isFixed: dofDimension === 0,
    basis,
  };
}

function projectDeltaToBasis(delta, basis) {
  if (!basis?.length) return [0, 0, 0];
  return basis.reduce((acc, basisVector) => add(acc, scale(basisVector, dot(delta, basisVector))), [0, 0, 0]);
}

async function ensureMoyoReady() {
  if (!moyoReady) moyoReady = init();
  return moyoReady;
}

/**
 * Run moyo on a bare cell. `lattice` is 3 row vectors (Å), `positions` are
 * fractional, `numbers` are per-atom integer labels — moyo only ever compares
 * them for equality, so they need not be atomic numbers (the symmetric CIF
 * export passes composition labels so that two mixed sites are equivalent only
 * when their species AND occupancies agree). Resolves to the raw moyo dataset
 * in the 'Standard' setting; rejects with a user-readable message.
 * @param {{lattice: number[][], positions: number[][], numbers: number[]}} cell
 * @param {number} tolerance symprec in Å
 */
export async function analyzeCell({ lattice, positions, numbers }, tolerance = defaultSymprec()) {
  await ensureMoyoReady();
  const cell = { positions, lattice: { basis: lattice.flat() }, numbers };
  try {
    return analyze_cell(JSON.stringify(cell), tolerance, 'Standard');
  } catch (error) {
    throw new Error(describeMoyoFailure(error, tolerance));
  }
}

export async function analyzeStructureSymmetry(structure = fileBrowser.selectedStructure, tolerance = defaultSymprec()) {
  if (!structure) throw new Error('No structure selected');
  return analyzeCell({
    lattice: structure.lattice.map((row) => [...row]),
    positions: structure.atoms.map((atom) => [...atom.position]),
    numbers: structure.elements.map((element) => PT_INVERTED[element]),
  }, tolerance);
}

// moyo throws bare tagged strings ("PrimitiveSymmetrySearchError"). Turn them
// into something a user can act on — every one of them is really "this cell,
// at this tolerance".
export function describeMoyoFailure(error, tolerance) {
  const raw = String(error?.message ?? error);
  const at = `at tolerance ${tolerance} Å`;
  if (raw.includes('PrimitiveSymmetrySearchError') || raw.includes('PrimitiveCellError')) {
    return `Symmetry search failed ${at} — atoms may sit closer than the tolerance, or the cell is too distorted. Try a smaller tolerance.`;
  }
  if (raw.includes('TooSmallToleranceError')) return `Tolerance too small ${at} — raise it.`;
  if (raw.includes('TooLargeToleranceError')) return `Tolerance too large ${at} — lower it.`;
  return `Symmetry analysis failed ${at}: ${raw}`;
}

function buildWyckoffSymmetryState(structure, dataset, tolerance = defaultSymprec()) {
  const positions = structure.atoms.map((atom) => [...atom.position]);
  // moyo serializes matrices COLUMN-major (nalgebra's memory order), while
  // applyOperation reads `rotation` row-major — so every operation has to be
  // transposed on the way in. Without this only groups whose rotations are
  // symmetric (all-diagonal ones: Pmmm and friends) behave; hexagonal,
  // trigonal and cubic operations come out as the wrong isometry, which
  // scrambles the orbit mappings, the site-freedom basis, and the symmetry
  // constraint MD/relax apply through symmetrizeCartesian*.
  const operations = (dataset.operations ?? []).map((op) => ({
    rotation: transpose3(op.rotation),
    translation: [...op.translation],
  }));
  const orbitIds = dataset.orbits ?? positions.map((_, index) => index);
  const wyckoffs = dataset.wyckoffs ?? positions.map(() => '?');
  const siteSymbols = dataset.site_symmetry_symbols ?? positions.map(() => '');

  const grouped = new Map();
  orbitIds.forEach((orbitId, atomIndex) => {
    if (!grouped.has(orbitId)) grouped.set(orbitId, []);
    grouped.get(orbitId).push(atomIndex);
  });

  const orbitGroups = Array.from(grouped.entries()).map(([orbitId, atomIndices]) => {
    const representativeIndex = atomIndices[0];
    const representativePosition = positions[representativeIndex];
    const freedom = computeOrbitFreedom(representativePosition, operations);
    const mappings = atomIndices.map((atomIndex) => ({
      atomIndex,
      operationIndex: findMatchingOperation(representativePosition, positions[atomIndex], operations),
    }));
    return {
      orbitId,
      representativeIndex,
      atomIndices,
      element: structure.elements[representativeIndex],
      wyckoff: wyckoffs[representativeIndex] ?? '?',
      siteSymmetry: siteSymbols[representativeIndex] ?? '',
      multiplicity: atomIndices.length,
      ...freedom,
      mappings,
    };
  });

  return {
    mode: 'wyckoff',
    spaceGroup: dataset.hm_symbol,
    number: dataset.number,
    // symprec this lock was built at — orbit moves stay far enough apart to
    // keep the cell analysable at exactly this tolerance.
    tolerance,
    // How many times larger the CONVENTIONAL cell is than the one analysed:
    // 4 for a primitive face-centred cell, 1 when the input already is the
    // conventional cell, 1/8 for a 2x2x2 supercell. Tabulated Wyckoff
    // multiplicities are quoted for the conventional cell, so this is what
    // relates them to the orbit sizes in `orbitGroups`. Captured here because it
    // is a property of the lock — dividing by a live structure.atoms.length
    // would drift the moment an orbit is added or removed.
    conventionalCellRatio: dataset.std_cell?.numbers?.length
      ? dataset.std_cell.numbers.length / positions.length
      : 1,
    operations,
    orbitGroups,
    representativeAtomIndices: orbitGroups.map((group) => group.representativeIndex),
  };
}

export async function activateWyckoffMode(structure = fileBrowser.selectedStructure, tolerance = defaultSymprec()) {
  if (!structure) throw new Error('No structure selected');
  const dataset = await analyzeStructureSymmetry(structure, tolerance);
  structure.symmetry = buildWyckoffSymmetryState(structure, dataset, tolerance);
  general.structurePanelMode = 'wyckoff';
  return structure.symmetry;
}

export function deactivateWyckoffMode(structure = fileBrowser.selectedStructure) {
  if (structure?.symmetry?.mode === 'wyckoff') {
    structure.symmetry = null;
  }
  general.structurePanelMode = 'atoms';
}

export function getWyckoffOrbitGroups(structure = fileBrowser.selectedStructure) {
  return structure?.symmetry?.mode === 'wyckoff' ? structure.symmetry.orbitGroups ?? [] : [];
}

function projectRepresentativePosition(orbit, targetRepresentative, structure = fileBrowser.selectedStructure) {
  const currentRepresentative = structure.atoms[orbit.representativeIndex].position;
  const delta = fracDelta(wrapFrac(targetRepresentative), currentRepresentative);
  const projectedDelta = projectDeltaToBasis(delta, orbit.basis);
  return wrapFrac(add(currentRepresentative, projectedDelta));
}

// `reRenderComposition` is passed straight to updateVisualization: the default
// 'open' rebuilds the composition panel (and with it this orbit's row), which
// is right after a committed edit but would tear the row out from under a
// slider mid-drag — live drags pass false and refresh their own inputs.
export function applyWyckoffOrbitPosition(representativeIndex, newCoords, structure = fileBrowser.selectedStructure,
  /** @type {{ reRenderComposition?: string | false }} */ { reRenderComposition = 'open' } = {}) {
  if (!structure?.symmetry || structure.symmetry.mode !== 'wyckoff') return false;

  const orbit = structure.symmetry.orbitGroups.find((group) => group.representativeIndex === representativeIndex);
  if (!orbit || orbit.isFixed) return false;

  const wrappedRepresentative = projectRepresentativePosition(orbit, newCoords, structure);
  const proposed = orbit.mappings.map(({ atomIndex, operationIndex }) => ({
    atomIndex,
    position: applyOperation(wrappedRepresentative, structure.symmetry.operations[operationIndex]),
  }));
  if (collapsesSites(proposed, orbit, structure)) return false;

  proposed.forEach(({ atomIndex, position: mapped }) => {
    structure.atoms[atomIndex].position = mapped;
    const rowIndex = fileBrowser.selectedRowIndex;
    const stepIndex = fileBrowser.stepInput;
    structureShip.container?.[rowIndex]?.structures?.[stepIndex]?.atoms?.[atomIndex] &&
      (structureShip.container[rowIndex].structures[stepIndex].atoms[atomIndex].position = [...mapped]);
  });

  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: false,
    reRenderOther: true,
    reRenderComposition,
  });
  // Anything else showing these coordinates (the Modify Structure panel's atom
  // table) has no other way to learn the atoms moved — reRenderComposition
  // only rebuilds the Structure Info panel.
  document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
  return true;
}

// Delete a whole Wyckoff orbit: every atom of the orbit leaves the structure
// at once, which is the only removal that keeps the symmetry lock true —
// dropping a single atom of a multiplicity-N site would break the very
// operations the lock is built from.
//
// The remaining orbits store raw atom indices (atomIndices,
// representativeIndex, mappings), so they are renumbered here against the
// shortened atoms array rather than the lock being thrown away and
// re-analysed: re-running moyo could land on a different tolerance/setting and
// silently reshuffle orbits the user wasn't editing.
// Callers clear the selection first — see removeWyckoffOrbit.
function dropOrbitAtoms(structure, orbit) {
  const removed = new Set(orbit.atomIndices);
  const renumbered = [];
  let shift = 0;
  for (let i = 0; i < structure.atoms.length; i += 1) {
    renumbered[i] = removed.has(i) ? -1 : i - shift;
    if (removed.has(i)) shift += 1;
  }

  structure.atoms = structure.atoms.filter((_, i) => !removed.has(i));
  structure.elements = structure.elements.filter((_, i) => !removed.has(i));
  structure.uniqueElements = [...new Set(structure.elements)];

  structure.symmetry.orbitGroups = structure.symmetry.orbitGroups
    .filter((group) => group !== orbit)
    .map((group) => ({
      ...group,
      atomIndices: group.atomIndices.map((index) => renumbered[index]),
      representativeIndex: renumbered[group.representativeIndex],
      mappings: group.mappings.map((mapping) => ({ ...mapping, atomIndex: renumbered[mapping.atomIndex] })),
    }));
  structure.symmetry.representativeAtomIndices = structure.symmetry.orbitGroups.map((group) => group.representativeIndex);
}

// Appending is the only insertion that leaves every existing orbit's raw
// indices valid. `at` and `orbitId` let a moved orbit keep its row and its
// identity, so the panel's added/removed diff doesn't report it as a new site.
/**
 * @param {any} structure
 * @param {{element: string, color?: any, images: {positions: number[][], operationIndices: number[]},
 *   wyckoff?: string, siteSymmetry?: string, orbitId?: number, at?: number}} spec
 */
function appendOrbitAtoms(structure, { element, color, images, wyckoff, siteSymmetry, orbitId, at }) {
  const firstIndex = structure.atoms.length;
  images.positions.forEach((position) => {
    structure.atoms.push(new Atom({ position, element, color, uuid: generateID([element]) }));
    structure.elements.push(element);
  });
  structure.uniqueElements = [...new Set(structure.elements)];

  const atomIndices = images.positions.map((_, offset) => firstIndex + offset);
  const orbits = structure.symmetry.orbitGroups;
  const group = {
    orbitId: orbitId ?? orbits.reduce((max, other) => Math.max(max, other.orbitId), -1) + 1,
    representativeIndex: firstIndex,
    atomIndices,
    element,
    wyckoff: wyckoff || '—',
    siteSymmetry: siteSymmetry || '',
    multiplicity: atomIndices.length,
    ...computeOrbitFreedom(images.positions[0], structure.symmetry.operations),
    mappings: atomIndices.map((atomIndex, offset) => ({ atomIndex, operationIndex: images.operationIndices[offset] })),
  };
  if (at == null || at >= orbits.length) orbits.push(group);
  else orbits.splice(at, 0, group);
  structure.symmetry.representativeAtomIndices = orbits.map((other) => other.representativeIndex);
  return group;
}

export function removeWyckoffOrbit(orbitId, structure = fileBrowser.selectedStructure) {
  if (!structure?.symmetry || structure.symmetry.mode !== 'wyckoff') return false;
  const orbits = structure.symmetry.orbitGroups;
  const orbit = orbits.find((group) => group.orbitId === orbitId);
  // Removing the last orbit would leave an atom-less structure, which every
  // downstream panel (bonds, polyhedra, symmetry) reads as a load failure.
  if (!orbit || orbits.length <= 1) return false;

  // Before anything shrinks: the selection and the 3D highlight both hold atom
  // indices from the current arrays, and clearing the highlight re-runs
  // updateAtoms over them. Doing this after the splice made updateAtoms read
  // past the end of the shortened array ("atom is undefined"), which threw out
  // of here after the orbit was already gone - leaving the caller's return value
  // unreached and its rows never refreshed.
  clearSelectedAtoms();
  dropOrbitAtoms(structure, orbit);

  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: false,
    reRenderOther: true,
    reRenderComposition: 'open',
  });
  document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
  return true;
}

// The re-render every orbit-level edit ends with. Kept in one place so adding,
// removing and re-elementing an orbit cannot drift apart in what they refresh.
function refreshAfterOrbitEdit({ reRenderLattice = false } = {}) {
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice,
    reRenderOther: true,
    reRenderComposition: 'open',
  });
  // Anything else showing these coordinates (the Modify Structure panel) has no
  // other way to learn the structure changed.
  document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
}

// Expand a representative into its full orbit using the LOCK's own operations,
// never WyckoffProjector.js's symmetry_basics.json tables. The two disagree on
// setting for monoclinic and every R group (see WyckoffLatticeConstraints.js's
// header), and the lock is in whatever setting moyo returned — projecting a new
// site through the tables would generate atoms in a cell they do not belong to.
//
// Images that land back on the same site (a special position) collapse to one
// entry, so positions.length IS the multiplicity: measured here rather than
// looked up, which is what lets a new site be added without re-running moyo.
function orbitImagesUnderLock(representative, structure, tolerance = 1e-4) {
  const operations = structure?.symmetry?.operations ?? [];
  if (!operations.length) return null;

  const wrapped = wrapFrac(representative);
  // Seeded with the typed position so the representative is the site the user
  // asked for, not whichever image operations[0] happens to produce.
  const positions = [wrapped];
  const operationIndices = [findMatchingOperation(wrapped, wrapped, operations)];

  operations.forEach((operation, operationIndex) => {
    const mapped = applyOperation(wrapped, operation);
    if (positions.some((seen) => fracDistance(seen, mapped) <= tolerance)) return;
    positions.push(mapped);
    operationIndices.push(operationIndex);
  });

  return { positions, operationIndices };
}

// What adding this site would do, without doing it: the multiplicity the lock
// gives it and whether it would collapse onto something. Drives the panel's
// "adds N atoms" readout, so the number shown is the number that lands.
export function previewWyckoffOrbit(representative, structure = fileBrowser.selectedStructure) {
  const images = orbitImagesUnderLock(representative, structure);
  if (!images) return null;
  return {
    multiplicity: images.positions.length,
    collapses: collapsesSites(images.positions.map((position) => ({ position })), { atomIndices: [] }, structure),
  };
}

// Add a whole Wyckoff orbit: the representative plus every symmetry image of
// it. One atom on its own cannot be added while the lock is on — it would break
// the operations the lock is built from — so this is the add-side counterpart
// of removeWyckoffOrbit.
/**
 * `wyckoff` and `siteSymmetry` are labels only - the positions always come from
 * the lock's operations, never from the tables - so a caller that knows the
 * letter can name the orbit without the label being able to move any atom.
 * @param {{element: string, representative: number[], color?: number, wyckoff?: string, siteSymmetry?: string}} site
 * @param {any} structure
 * @returns {{ok: boolean, reason?: string, multiplicity?: number}}
 */
export function addWyckoffOrbit({ element, representative, color, wyckoff, siteSymmetry }, structure = fileBrowser.selectedStructure) {
  if (structure?.symmetry?.mode !== 'wyckoff') return { ok: false, reason: 'The structure is not symmetry-locked.' };
  if (!element) return { ok: false, reason: 'Pick an element for the new site.' };

  const images = orbitImagesUnderLock(representative, structure);
  if (!images) return { ok: false, reason: 'This lock carries no symmetry operations.' };
  if (collapsesSites(images.positions.map((position) => ({ position })), { atomIndices: [] }, structure)) {
    return { ok: false, reason: 'Refused — the site would land on an existing atom or on its own symmetry image.' };
  }

  // The letter is never derived here — that would mean re-running moyo, which
  // can reshuffle orbits the user wasn't editing (see removeWyckoffOrbit).
  clearSelectedAtoms();
  const group = appendOrbitAtoms(structure, { element, color, images, wyckoff, siteSymmetry });

  refreshAfterOrbitEdit();
  return { ok: true, multiplicity: group.multiplicity };
}

// Move an orbit onto a different Wyckoff site, keeping its element, colour,
// identity and row. Its size changes with the site (8e -> 4c drops four atoms),
// hence the same drop-and-renumber that removing does.
/**
 * @param {number} orbitId
 * @param {number[]} representative
 * @param {{wyckoff?: string, siteSymmetry?: string}} labels
 * @param {any} structure
 * @returns {{ok: boolean, reason?: string, multiplicity?: number}}
 */
export function setWyckoffOrbitSite(orbitId, representative, labels = {},
  structure = fileBrowser.selectedStructure) {
  const { wyckoff, siteSymmetry } = labels;
  if (structure?.symmetry?.mode !== 'wyckoff') return { ok: false, reason: 'The structure is not symmetry-locked.' };
  const orbits = structure.symmetry.orbitGroups;
  const index = orbits.findIndex((group) => group.orbitId === orbitId);
  if (index === -1) return { ok: false, reason: 'That orbit is no longer there.' };
  const orbit = orbits[index];

  const images = orbitImagesUnderLock(representative, structure);
  if (!images) return { ok: false, reason: 'This lock carries no symmetry operations.' };
  // Own atoms excluded — they're about to be replaced.
  if (collapsesSites(images.positions.map((position) => ({ position })), orbit, structure)) {
    return { ok: false, reason: 'Refused — the site would land on another atom or on its own symmetry image.' };
  }

  const element = orbit.element;
  const representativeAtom = structure.atoms[orbit.representativeIndex];
  const color = representativeAtom?.userColor ?? representativeAtom?.getColor?.();

  clearSelectedAtoms();
  dropOrbitAtoms(structure, orbit);
  const group = appendOrbitAtoms(structure, {
    element, color, images, wyckoff, siteSymmetry, orbitId: orbit.orbitId, at: index,
  });

  refreshAfterOrbitEdit();
  return { ok: true, multiplicity: group.multiplicity };
}

// Re-element every atom of an orbit at once. The operation set stays valid (it
// is geometry, not composition), so the lock is kept as-is — moyo would simply
// report a different group the next time it is asked.
export function setWyckoffOrbitElement(orbitId, element, structure = fileBrowser.selectedStructure) {
  if (structure?.symmetry?.mode !== 'wyckoff' || !element) return false;
  const orbit = structure.symmetry.orbitGroups.find((group) => group.orbitId === orbitId);
  if (!orbit) return false;

  orbit.atomIndices.forEach((atomIndex) => {
    const previous = structure.atoms[atomIndex];
    // Colour and radius are derived from the element once, in the constructor,
    // so a re-elemented atom is re-made rather than patched. Any user colour is
    // dropped on purpose: the atom goes back to following its new element, which
    // is what the atom table does in unlocked mode.
    structure.atoms[atomIndex] = new Atom({ position: [...previous.position], element, uuid: previous.uuid });
    structure.elements[atomIndex] = element;
  });
  orbit.element = element;
  structure.uniqueElements = [...new Set(structure.elements)];

  refreshAfterOrbitEdit();
  return true;
}

export function setWyckoffOrbitColor(orbitId, hex, structure = fileBrowser.selectedStructure) {
  if (structure?.symmetry?.mode !== 'wyckoff' || !hex) return false;
  const orbit = structure.symmetry.orbitGroups.find((group) => group.orbitId === orbitId);
  if (!orbit) return false;

  orbit.atomIndices.forEach((atomIndex) => {
    structure.atoms[atomIndex].userColor = hex;
    structure.atoms[atomIndex].setColor(hex);
  });
  // Nothing moved, so bonds and the cell are left alone.
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: false,
    reRenderLattice: false,
    reRenderOther: true,
    reRenderComposition: 'open',
  });
  document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
  return true;
}

// Rotation-free deformation taking `current` to `requested`, as a cartesian
// strain. Cartesian x = Lᵀf, so a homogeneous x' = (I+E)x means L' = L(I+E)ᵀ
// and I+E = Lᵀ_requested·(Lᵀ_current)⁻¹. Only the symmetric part is kept: the
// antisymmetric part is a rigid rotation of the whole cell, which changes no
// distance or angle and would otherwise fight the symmetry projection.
function strainBetweenLattices(current, requested) {
  const deformation = multiply3x3(transpose3x3(requested), invert3x3(transpose3x3(current)));
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
    (deformation[i][j] + deformation[j][i]) / 2 - (i === j ? 1 : 0)));
}

// The nearest cell to `requested` that the lock still permits.
//
// Atom positions are stored fractionally and every operation is a fractional
// rotation + translation, so deforming the cell leaves all of them exactly
// valid — what a free-form cell would break is the metric (a cubic cell with
// a != b is no longer cubic). Passing the strain through
// symmetrizeCartesianStrain projects out precisely the forbidden part, using the
// lock's own operations. That makes this independent of setting and of the
// symmetry_basics.json tables, unlike the add panel's table-driven
// WyckoffLatticeConstraints.
export function projectLatticeToSymmetry(requested, structure = fileBrowser.selectedStructure) {
  const current = structure?.lattice;
  if (structure?.symmetry?.mode !== 'wyckoff' || !current) return requested.map((row) => [...row]);
  const projected = symmetrizeCartesianStrain(strainBetweenLattices(current, requested), current, structure);
  const deformation = projected.map((row, i) => row.map((value, j) => value + (i === j ? 1 : 0)));
  return multiply3x3(current, transpose3x3(deformation));
}

// Set the cell to the symmetry-allowed part of `requested` and re-render.
// Returns the cell that actually landed, so the caller can show it.
export function applyWyckoffLattice(requested, structure = fileBrowser.selectedStructure) {
  if (structure?.symmetry?.mode !== 'wyckoff') return null;
  structure.lattice = projectLatticeToSymmetry(requested, structure);
  refreshAfterOrbitEdit({ reRenderLattice: true });
  return structure.lattice;
}

const LENGTH_KEYS = ['a', 'b', 'c'];
const ANGLE_KEYS = ['alpha', 'beta', 'gamma'];

// Which cell parameters the lock determines, in the { fixed } / { mirror } form
// WyckoffLatticeConstraints.js's controller enforces: a locked parameter is
// disabled and driven from the free one it follows, so a cubic cell cannot be
// given three different lengths in the first place.
//
// Measured from the lock's own operations rather than looked up, so it reports
// the truth for the setting the lock is actually in — the table in
// WyckoffLatticeConstraints.js is keyed to the *generator's* setting and would
// freeze the wrong angle here (it resolves monoclinic a-unique; moyo's Standard
// setting is b-unique).
//
// Method: nudge one parameter, project the result, and read what came back.
// A length that moves when another is nudged is coupled to it (cubic: nudging a
// moves b and c by the same relative amount, so both mirror a). An angle that
// cannot move at all is fixed at its current value. Note this reads the CURRENT
// cell, so it assumes the cell still carries the metric the lock was built from
// - which holds as long as the constraints returned here are what edits it.
/** @returns {Record<string, {fixed?: number, mirror?: string}> | null} */
export function wyckoffLatticeConstraints(structure = fileBrowser.selectedStructure) {
  if (structure?.symmetry?.mode !== 'wyckoff') return null;
  const base = latticeParameters(structure.lattice);
  const canonical = latticeFromCell(base.a, base.b, base.c, base.alpha, base.beta, base.gamma);
  // latticeFromCell builds a canonical orientation (a along x); the current cell
  // may sit rotated from that, and a rotated probe would show up in the strain
  // as a rigid rotation instead of the parameter change being tested.
  const toCurrentFrame = multiply3x3(invert3x3(canonical), structure.lattice);

  const RELATIVE_STEP = 0.02;
  const ANGLE_STEP = 2;

  function probe(key) {
    const step = LENGTH_KEYS.includes(key) ? base[key] * RELATIVE_STEP : ANGLE_STEP;
    const next = { ...base, [key]: base[key] + step };
    const oriented = multiply3x3(
      latticeFromCell(next.a, next.b, next.c, next.alpha, next.beta, next.gamma), toCurrentFrame);
    return latticeParameters(projectLatticeToSymmetry(oriented, structure));
  }

  /** @type {Record<string, {fixed?: number, mirror?: string}>} */
  const constraints = {};

  // An angle the group pins cannot be nudged at all. Reported at its current
  // value rather than a table's, which is what makes this setting-agnostic.
  ANGLE_KEYS.forEach((key) => {
    if (Math.abs(probe(key)[key] - base[key]) <= ANGLE_STEP * 0.1) {
      constraints[key] = { fixed: Number(base[key].toFixed(2)) };
    }
  });

  // Lengths: walk in order so the first member of each coupled group stays the
  // free one and the rest mirror it (cubic -> b and c mirror a).
  LENGTH_KEYS.forEach((key, index) => {
    if (constraints[key]) return; // already mirroring an earlier length
    const landed = probe(key);
    const own = (landed[key] - base[key]) / base[key];
    if (Math.abs(own) < RELATIVE_STEP * 0.1) {
      // Cannot move even on its own - nothing here can drive it, so pin it.
      constraints[key] = { fixed: Number(base[key].toFixed(4)) };
      return;
    }
    LENGTH_KEYS.slice(index + 1).forEach((other) => {
      if (constraints[other]) return;
      const response = (landed[other] - base[other]) / base[other];
      if (Math.abs(response - own) < Math.abs(own) * 0.05) constraints[other] = { mirror: key };
    });
  });

  return constraints;
}

// Would this set of proposed orbit positions put two atoms on top of each
// other? Only the moving orbit's atoms can cause that (nothing else moves), so
// each proposed position is checked against the other proposed ones and
// against every atom outside the orbit, using the minimum-image distance in
// Ångström.
function collapsesSites(proposed, orbit, structure) {
  const lattice = structure.lattice;
  const cartDistance = (a, b) => {
    const d = fracDelta(a, b);
    const x = d[0] * lattice[0][0] + d[1] * lattice[1][0] + d[2] * lattice[2][0];
    const y = d[0] * lattice[0][1] + d[1] * lattice[1][1] + d[2] * lattice[2][1];
    const z = d[0] * lattice[0][2] + d[1] * lattice[1][2] + d[2] * lattice[2][2];
    return Math.hypot(x, y, z);
  };

  const minimum = minSiteSeparation(structure.symmetry?.tolerance ?? defaultSymprec());
  const inOrbit = new Set(orbit.atomIndices);
  for (let i = 0; i < proposed.length; i += 1) {
    for (let j = i + 1; j < proposed.length; j += 1) {
      if (cartDistance(proposed[i].position, proposed[j].position) < minimum) return true;
    }
    for (let k = 0; k < structure.atoms.length; k += 1) {
      if (inOrbit.has(k)) continue;
      if (cartDistance(proposed[i].position, structure.atoms[k].position) < minimum) return true;
    }
  }
  return false;
}

// Which fractional axes an orbit can move along: axis j is free when some
// basis vector of the site's freedom subspace has a component along j. Note
// free axes can still be coupled (a (x, x, z) site reports x and y free, but
// moving one drags the other — the projection in
// projectRepresentativePosition enforces that).
export function getOrbitAxisFreedom(orbit) {
  if (!orbit || orbit.isFixed) return [false, false, false];
  return [0, 1, 2].map((axis) => (orbit.basis ?? []).some((v) => Math.abs(v[axis]) > 1e-6));
}

export function symmetrizeFractionalPositions(fracPositions, structure = fileBrowser.selectedStructure) {
  if (!structure?.symmetry || structure.symmetry.mode !== 'wyckoff') {
    return fracPositions.map((position) => wrapFrac(position));
  }

  const out = fracPositions.map((position) => wrapFrac(position));
  structure.symmetry.orbitGroups.forEach((orbit) => {
    const representative = orbit.isFixed
      ? [...structure.atoms[orbit.representativeIndex].position]
      : projectRepresentativePosition(orbit, out[orbit.representativeIndex], structure);

    orbit.mappings.forEach(({ atomIndex, operationIndex }) => {
      out[atomIndex] = applyOperation(representative, structure.symmetry.operations[operationIndex]);
    });
  });
  return out;
}

export function symmetrizeCartesianPositions(cartPositions, lattice, structure = fileBrowser.selectedStructure) {
  if (!structure?.symmetry || structure.symmetry.mode !== 'wyckoff') {
    return cartPositions.map((position) => [...position]);
  }
  const frac = cartPositions.map((position) => cartToFrac(position, lattice));
  const symmetrizedFrac = symmetrizeFractionalPositions(frac, structure);
  return fracToCart(symmetrizedFrac, lattice);
}

export function symmetrizeCartesianVectors(cartVectors, lattice, structure = fileBrowser.selectedStructure) {
  if (!structure?.symmetry || structure.symmetry.mode !== 'wyckoff') {
    return cartVectors.map((vector) => [...vector]);
  }

  const inverseTransposeLattice = invert3x3(transpose3x3(lattice));
  const outFrac = cartVectors.map((vector) => cartToFrac(vector, lattice, inverseTransposeLattice));

  structure.symmetry.orbitGroups.forEach((orbit) => {
    const repVector = orbit.isFixed
      ? [0, 0, 0]
      : projectDeltaToBasis(outFrac[orbit.representativeIndex], orbit.basis);

    orbit.mappings.forEach(({ atomIndex, operationIndex }) => {
      const rotation = structure.symmetry.operations[operationIndex].rotation;
      outFrac[atomIndex] = [
        rotation[0] * repVector[0] + rotation[1] * repVector[1] + rotation[2] * repVector[2],
        rotation[3] * repVector[0] + rotation[4] * repVector[1] + rotation[5] * repVector[2],
        rotation[6] * repVector[0] + rotation[7] * repVector[1] + rotation[8] * repVector[2],
      ];
    });
  });

  return fracToCart(outFrac, lattice);
}

function multiply3x3(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

/**
 * Project a cartesian strain tensor onto the symmetry-invariant subspace — the
 * Reynolds average (1/N)·Σ Rᵀ E R over the point group. Straining a cell by an
 * arbitrary symmetric tensor drops it to P1 (a hexagonal cell stops being
 * hexagonal), so anything that deforms the cell while the Wyckoff lock is on
 * has to pass its strain through here first.
 *
 * The operations are stored as fractional rotations W; a cartesian point is
 * x = Lᵀf, so the same isometry in cartesian axes is R = Lᵀ W (Lᵀ)⁻¹.
 */
export function symmetrizeCartesianStrain(strain, lattice, structure = fileBrowser.selectedStructure) {
  const operations = structure?.symmetry?.mode === 'wyckoff' ? structure.symmetry.operations : null;
  if (!operations?.length) return strain.map((row) => [...row]);

  const latticeT = transpose3x3(lattice);
  const latticeTInverse = invert3x3(latticeT);
  const sum = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

  operations.forEach(({ rotation }) => {
    const W = [
      [rotation[0], rotation[1], rotation[2]],
      [rotation[3], rotation[4], rotation[5]],
      [rotation[6], rotation[7], rotation[8]],
    ];
    const R = multiply3x3(multiply3x3(latticeT, W), latticeTInverse);
    const projected = multiply3x3(multiply3x3(transpose3x3(R), strain), R);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) sum[i][j] += projected[i][j];
    }
  });

  return sum.map((row) => row.map((value) => value / operations.length));
}

export function getSymmetryDegreesOfFreedom(structure = fileBrowser.selectedStructure) {
  if (!structure?.symmetry || structure.symmetry.mode !== 'wyckoff') return null;
  return structure.symmetry.orbitGroups.reduce((sum, orbit) => sum + orbit.dofDimension, 0);
}

export function isWyckoffModeActive(structure = fileBrowser.selectedStructure) {
  return structure?.symmetry?.mode === 'wyckoff';
}
