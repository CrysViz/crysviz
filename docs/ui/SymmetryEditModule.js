import init, { analyze_cell } from '../external/moyo-test/moyo_wasm.js';
import { fileBrowser, general, structureShip } from '../store.js';
import { updateVisualization } from '../crystal-viewer.js';
<<<<<<< Updated upstream:docs/modules/SymmetryEditModule.js
import { PT_INVERTED } from '../ui/BackendPanel/MoyoWASM.js';
=======
import { PT_INVERTED } from './BackendPanel/MoyoWASM.js';
>>>>>>> Stashed changes:docs/ui/SymmetryEditModule.js
import { cartToFrac, fracToCart, invert3x3, transpose3x3 } from '../math/index.js';

let moyoReady = null;

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

export async function analyzeStructureSymmetry(structure = fileBrowser.selectedStructure, tolerance = 1e-5) {
  if (!structure) throw new Error('No structure selected');
  await ensureMoyoReady();

  const numbers = structure.elements.map((element) => PT_INVERTED[element]);
  const positions = structure.atoms.map((atom) => [...atom.position]);
  const lattice = structure.lattice.map((row) => [...row]);
  const cell = { positions, lattice: { basis: lattice.flat() }, numbers };
  return analyze_cell(JSON.stringify(cell), tolerance, 'Standard');
}

function buildWyckoffSymmetryState(structure, dataset) {
  const positions = structure.atoms.map((atom) => [...atom.position]);
  const operations = (dataset.operations ?? []).map((op) => ({
    rotation: [...op.rotation],
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
    operations,
    orbitGroups,
    representativeAtomIndices: orbitGroups.map((group) => group.representativeIndex),
  };
}

export async function activateWyckoffMode(structure = fileBrowser.selectedStructure, tolerance = 1e-5) {
  if (!structure) throw new Error('No structure selected');
  const dataset = await analyzeStructureSymmetry(structure, tolerance);
  structure.symmetry = buildWyckoffSymmetryState(structure, dataset);
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

export function applyWyckoffOrbitPosition(representativeIndex, newCoords, structure = fileBrowser.selectedStructure) {
  if (!structure?.symmetry || structure.symmetry.mode !== 'wyckoff') return;

  const orbit = structure.symmetry.orbitGroups.find((group) => group.representativeIndex === representativeIndex);
  if (!orbit || orbit.isFixed) return;

  const wrappedRepresentative = projectRepresentativePosition(orbit, newCoords, structure);
  orbit.mappings.forEach(({ atomIndex, operationIndex }) => {
    const operation = structure.symmetry.operations[operationIndex];
    const mapped = applyOperation(wrappedRepresentative, operation);
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
    reRenderComposition: 'open',
  });
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

export function getSymmetryDegreesOfFreedom(structure = fileBrowser.selectedStructure) {
  if (!structure?.symmetry || structure.symmetry.mode !== 'wyckoff') return null;
  return structure.symmetry.orbitGroups.reduce((sum, orbit) => sum + orbit.dofDimension, 0);
}

export function isWyckoffModeActive(structure = fileBrowser.selectedStructure) {
  return structure?.symmetry?.mode === 'wyckoff';
}
