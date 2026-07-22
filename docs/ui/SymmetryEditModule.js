import init, { analyze_cell } from '../external/moyo-test/moyo_wasm.js';
import { fileBrowser, general, structureShip } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { PT_INVERTED } from './BackendPanel/MoyoWASM.js';
import { cartToFrac, fracToCart, invert3x3, transpose3x3 } from '../math/index.js';

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

export async function analyzeStructureSymmetry(structure = fileBrowser.selectedStructure, tolerance = defaultSymprec()) {
  if (!structure) throw new Error('No structure selected');
  await ensureMoyoReady();

  const numbers = structure.elements.map((element) => PT_INVERTED[element]);
  const positions = structure.atoms.map((atom) => [...atom.position]);
  const lattice = structure.lattice.map((row) => [...row]);
  const cell = { positions, lattice: { basis: lattice.flat() }, numbers };
  try {
    return analyze_cell(JSON.stringify(cell), tolerance, 'Standard');
  } catch (error) {
    throw new Error(describeMoyoFailure(error, tolerance));
  }
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
  return true;
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
