/**
 * Gaussian .cube parser: text in, plain geometry + grid data out.
 *
 * The format-level half of cube loading, split out of `io/ReadCubeModule.js`
 * so it imports nothing and can be unit-tested under node. It builds no model
 * classes — ReadCubeModule turns the result into a Structure and Fields.
 *
 * Layout:
 *   line 1-2   free-text comments (either may be blank)
 *   line 3     NATOMS  ox oy oz  [NVAL]
 *   line 4-6   Ni  step vector i            (one line per grid axis)
 *   |NATOMS|   Z  charge  x y z              (one line per atom)
 *   if NATOMS < 0:  M  id1 .. idM            (dataset ids, may wrap lines)
 *   data       x slowest, z fastest; NVAL (or M) values per grid point
 *
 * Units: a positive N1 means the step vectors, origin and atom coordinates are
 * in Bohr; a negative N1 means Angstrom, and the grid size is |N1|. The units
 * are one choice for the whole file, so N1 decides it and the signs of N2/N3
 * are only stripped. Everything returned is in Angstrom. The data values are
 * passed through untouched (a Gaussian density stays in e/Bohr^3).
 */

/** CODATA 2022 Bohr radius in Angstrom. */
export const BOHR_TO_ANGSTROM = 0.529177210544;

/**
 * @typedef {Object} CubeData
 * @property {string} label           the two comment lines, joined
 * @property {'bohr'|'angstrom'} units the units the file was written in
 * @property {number[]} origin        grid origin, Angstrom
 * @property {number[]} grid          [n1, n2, n3] grid points per axis (positive)
 * @property {number[][]} voxel       step vector per axis (rows), Angstrom
 * @property {number[][]} lattice     grid cell rows n_i * step_i, Angstrom
 * @property {{atomicNumber: number, charge: number, position: number[]}[]} atoms
 *                                    positions are absolute Cartesian, Angstrom
 * @property {number[]|null} datasetIds orbital/dataset ids (NATOMS < 0), else null
 * @property {Float32Array[]} values  one array per dataset, index x + n1*(y + n2*z)
 */

/**
 * @param {string} content
 * @returns {CubeData}
 */
export function parseCube(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length < 6) throw new Error('Cube file: header is incomplete');
  const label = lines.slice(0, 2).map((l) => l.trim()).join(' ').trim();

  // Past the comments, blank lines carry nothing, so skip them.
  let cursor = 2;
  const nextTokens = () => {
    while (cursor < lines.length && !lines[cursor].trim()) cursor++;
    if (cursor >= lines.length) throw new Error('Cube file: unexpected end of header');
    return lines[cursor++].trim().split(/\s+/);
  };

  const countLine = nextTokens();
  const natomsSigned = parseInt(countLine[0], 10);
  if (!Number.isFinite(natomsSigned)) throw new Error(`Cube file: bad atom count "${countLine[0]}"`);
  const natoms = Math.abs(natomsSigned);
  const rawOrigin = countLine.slice(1, 4).map(parseFloat);
  const nvalColumn = countLine.length > 4 ? parseInt(countLine[4], 10) : 1;

  const grid = [];
  const rawSteps = [];
  let unitScale = 1;
  let units = /** @type {'bohr'|'angstrom'} */ ('bohr');
  for (let axis = 0; axis < 3; axis++) {
    const t = nextTokens();
    const n = parseInt(t[0], 10);
    if (!Number.isFinite(n) || n === 0) throw new Error(`Cube file: bad grid size "${t[0]}" on axis ${axis + 1}`);
    if (axis === 0) {
      units = n > 0 ? 'bohr' : 'angstrom';
      unitScale = n > 0 ? BOHR_TO_ANGSTROM : 1;
    }
    grid.push(Math.abs(n));
    rawSteps.push(t.slice(1, 4).map(parseFloat));
  }
  const origin = rawOrigin.map((c) => c * unitScale);
  const voxel = rawSteps.map((step) => step.map((c) => c * unitScale));
  const lattice = voxel.map((step, axis) => step.map((c) => c * grid[axis]));

  const atoms = [];
  for (let j = 0; j < natoms; j++) {
    const t = nextTokens();
    atoms.push({
      atomicNumber: parseInt(t[0], 10),
      charge: parseFloat(t[1]),
      position: t.slice(2, 5).map((c) => parseFloat(c) * unitScale),
    });
  }

  // A negative atom count announces a dataset-id record: M, then M ids. It is
  // written ten ids to a line, so it can wrap.
  let datasetIds = null;
  let nval = Number.isFinite(nvalColumn) && nvalColumn > 0 ? nvalColumn : 1;
  if (natomsSigned < 0) {
    const tokens = nextTokens();
    const m = parseInt(tokens[0], 10);
    if (!Number.isFinite(m) || m < 1) throw new Error(`Cube file: bad dataset count "${tokens[0]}"`);
    while (tokens.length < m + 1) tokens.push(...nextTokens());
    datasetIds = tokens.slice(1, m + 1).map((s) => parseInt(s, 10));
    nval = m;
  }

  const [n1, n2, n3] = grid;
  const npoints = n1 * n2 * n3;
  const values = Array.from({ length: nval }, () => new Float32Array(npoints));
  const total = npoints * nval;
  let read = 0;
  for (let li = cursor; li < lines.length && read < total; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    for (const token of line.split(/\s+/)) {
      if (read >= total) break;
      // File order: x slowest, then y, then z, then the dataset fastest.
      const point = Math.floor(read / nval);
      const z = point % n3;
      const y = Math.floor(point / n3) % n2;
      const x = Math.floor(point / (n2 * n3));
      values[read % nval][x + n1 * (y + n2 * z)] = parseFloat(token);
      read++;
    }
  }
  if (read < total) throw new Error(`Cube file: expected ${total} data values, found ${read}`);

  return { label, units, origin, grid, voxel, lattice, atoms, datasetIds, values };
}
