/**
 * Per-polyhedron properties — one number per coordination polyhedron, computed
 * from flat typed arrays so that a molecular-dynamics frame with 100 000+
 * polyhedra can be re-coloured every frame.
 *
 * WHY THIS SHAPE. The renderer keeps one face mesh for all polyhedra and a
 * flat per-polyhedron table beside it (triangle range, centre index, centre
 * position). Colouring by a property is then "fill one Float32Array per
 * frame, map it through a colour bar". Everything here is therefore O(N) over
 * polyhedra, takes plain arrays, and does not allocate inside the per-
 * polyhedron loop: all scratch lives in module-level Float64Arrays (JS is
 * single-threaded per realm; a worker that imports this module gets its own
 * copy). Imports nothing — no three.js — so node unit tests and workers can
 * run it, and render/PolyhedraAnalysisModule.js (the Polyhedron Inspector's
 * numbers) delegates its volume / distortion / angle maths here, which keeps
 * one source of truth for the inspector and the per-frame colouring.
 *
 * TABLE CONTRACT ({@link PolyhedraTable}). Polyhedron p:
 *   - vertices: vertXYZ[3*vertStart[p] .. 3*(vertStart[p]+vertCount[p])),
 *     Cartesian Å, x,y,z interleaved. vertStart counts VERTICES, not floats.
 *     These are the corner atoms in the periodic image that actually forms the
 *     polyhedron around its centre (the drawn positions, not wrapped into the
 *     cell), each corner once, in any order — every property here is
 *     invariant under permutation of the vertex list. The renderer's
 *     triangle ranges are not needed and not read.
 *   - coordination number = vertCount[p].
 *   - centre: centerXYZ[3p..3p+2], Cartesian Å, the centre atom's position in
 *     the same image as the vertices. A cage (no centre atom) has NaN in
 *     centerXYZ[3p]; `centerXYZ` may also be null/absent when every
 *     polyhedron is a cage. Centre-based properties are NaN for cages.
 *   - lattice: rows a, b, c (Cartesian Å). Only used for the tilt reference
 *     frame; `frame` overrides it.
 *   - frames / frameOf (optional): per-row reference frames — frames holds 9
 *     numbers (three orthonormal right-handed rows) per frame, frameOf[p] the
 *     frame of polyhedron p, or −1 for the default (frame / lattice). The
 *     renderer's automatic frame is one per polyhedron type (the mean
 *     orientation of that type, meanOrientationFrame), so one table — one
 *     batch pass — serves every type, instead of a sub-table per type.
 *   - centerIsCentroid (optional, one byte per row): 1 when centerXYZ holds a
 *     stand-in centre (a cage's vertex centroid) rather than a centre atom.
 *     The angle, elongation and orientation kernels accept it; the bond-
 *     length distortion (`needsTrueCenter`) is NaN there, since a centroid
 *     makes every Baur index about zero by construction.
 * Float32Array or Float64Array both satisfy the contract. Float32 absolute
 * coordinates (≈1e-5 Å resolution at 100 Å) limit the tilt angles to ~1e-4°
 * and the distortion indices to ~1e-5 relative — irrelevant for colouring.
 *
 * ADDING A PROPERTY = one new entry in POLYHEDRA_PROPERTIES with
 * `compute(table, p)` returning a number (NaN when undefined). The batch
 * driver computePolyhedraProperty() applies `applicableCN` / `needsCenter`
 * gating before calling it, so compute() may assume both.
 *
 * DEFINITIONS (formulas and references are next to each kernel below):
 *   volume               convex-hull volume of the vertices, Å³.
 *   bld                  Baur (1974) bond-length distortion index,
 *                        Δ = (1/n) Σ |l_i − l̄| / l̄, any CN with a centre.
 *   angleVariance        Robinson, Gibbs & Ribbe (1971) bond-angle variance,
 *                        σ² = Σ (θ_i − θ_0)² / (m − 1), °²: CN4 all 6 angles
 *                        vs 109.47°, CN6 the 12 cis angles vs 90°.
 *   quadraticElongation  Robinson et al. (1971) ⟨λ⟩ = (1/n) Σ (l_i / l_0)²,
 *                        l_0 the centre–vertex distance of the regular
 *                        polyhedron (tetrahedron / octahedron) of the same
 *                        volume. CN4 and CN6.
 *   tiltA/B/C, rotation  orientation of the polyhedron relative to the ideal
 *                        one aligned with the reference axes (the cell axes
 *                        unless the table passes frames), °. CN4 and CN6
 *                        that are tetrahedra / octahedra in shape (see SHAPE
 *                        CHECK); NaN for any other.
 *
 * TILT CONVENTION.
 *   Reference frame: â = a/|a|, b̂' = (b − (b·â)â)/|…|, ĉ' = â × b̂'
 *   (right-handed, orthonormal; equals the cell axes for orthogonal cells).
 *   An optional `table.frame` (three orthonormal rows) replaces it — for a
 *   √2×√2 perovskite cell the pseudo-cubic axes are at 45° to a and b, and the
 *   caller can pass them.
 *   Ideal octahedron: vertices along ±â, ±b̂', ±ĉ'. The measured octahedron's
 *   three axes are the vertex–vertex vectors of its trans pairs (found as the
 *   inspector finds them: greedy largest centre angle) — vertex differences,
 *   so an off-centre cation (a ferroelectric B-site shift) does not register
 *   as tilt. Each axis is assigned to the frame axis (one of the 6
 *   permutations, maximising Σ|cos|) and signed to point along +axis.
 *   Ideal tetrahedron: vertices along (1,1,1), (1,−1,−1), (−1,1,−1),
 *   (−1,−1,1) /√3 in the frame (the even-parity set); measured centre→vertex
 *   unit vectors are matched to them by the permutation (of 24) maximising
 *   Σ cos. A tetrahedron in the other (odd-parity) setting reads as a 90°
 *   rotation.
 *   Fit: the proper rotation R minimising Σ |R ideal_k − measured_k|²
 *   (Horn 1987 unit-quaternion method, 4×4 symmetric Jacobi eigen-solve) —
 *   always a proper rotation, also for distorted shapes.
 *   Output: measured ≈ R · ideal. `rotation` = total angle θ of R, in
 *   [0°, 180°]. tiltA/B/C = the components of the rotation vector θ·n̂ (n̂ the
 *   unit axis) along â, b̂', ĉ', in degrees, right-hand rule: a positive tiltC
 *   turns â towards b̂'. For a single-axis rotation that component is exact;
 *   for several small tilts they are the usual first-order (Glazer-style)
 *   tilt angles. Signed per polyhedron, so in-phase (+) vs anti-phase (−)
 *   tilting of neighbouring octahedra shows up directly in a diverging
 *   colour map. The ideal shape's symmetry makes R defined only up to the
 *   octahedral (tetrahedral) rotation group; the axis matching picks the
 *   representative closest to identity, so results are meaningful while the
 *   tilt is well below 45° (the matching flips at that point).
 *
 * SHAPE CHECK. The fit assumes the corners form an octahedron (tetrahedron);
 * a CN6 or CN4 by count need not — an A-site cation that happens to have six
 * anions within the cutoff is a flattened, irregular shape, and the fit then
 * returns a large meaningless angle that wrecks the colour range. So before
 * any orientation is fitted (orientationOf, and polyhedronAxes for the mean
 * frame) the shape is tested, a few flops per polyhedron:
 *   CN6: each of the three trans pairs (greedy, as above) spans a centre
 *        angle ≥ OCT_TRANS_MIN_DEG; the three trans-pair axes are within
 *        OCT_AXIS_TOL_DEG of mutually perpendicular; max/min centre–corner
 *        distance ≤ SHAPE_MAX_BOND_RATIO.
 *   CN4: all six centre angles within TET_ANGLE_TOL_DEG of 109.47°, and the
 *        same distance ratio (rejects square-planar and see-saw CN4).
 * A rejected row gets NaN for the four orientation columns (so it is greyed
 * and left out of the auto range, like a cage or a CN8) and is left out of
 * meanOrientationFrame; the scalar distortion properties are unaffected.
 */

/**
 * The flat per-polyhedron table. See the file header for the contract.
 * @typedef {Object} PolyhedraTable
 * @property {number} count number of polyhedra
 * @property {ArrayLike<number> | null} [centerXYZ] 3 per polyhedron, Cartesian
 *   Å; NaN at [3p] for a cage; null/absent if all are cages
 * @property {ArrayLike<number>} vertStart first vertex (vertex index, not float
 *   index) of each polyhedron in vertXYZ
 * @property {ArrayLike<number>} vertCount number of vertices (= CN)
 * @property {ArrayLike<number>} vertXYZ vertices concatenated, Cartesian Å
 * @property {number[][]} [lattice] rows a, b, c (Cartesian Å) — tilt frame
 * @property {number[][]} [frame] optional orthonormal right-handed reference
 *   frame rows, overriding the lattice-derived one
 * @property {Float64Array | Float32Array} [frames] per-row frames, 9 per frame
 * @property {Int32Array} [frameOf] frame index per polyhedron, −1 = default
 * @property {Uint8Array} [centerIsCentroid] 1 = stand-in centre (cage)
 */

/**
 * One property definition.
 * @typedef {Object} PolyhedraPropertyDef
 * @property {string} id
 * @property {string} label
 * @property {string} unit '' for dimensionless
 * @property {'scalar'} kind
 * @property {number[] | null} applicableCN null = any CN
 * @property {boolean} needsCenter NaN for cages when true
 * @property {boolean} [needsTrueCenter] also NaN for a stand-in centre
 *   (centerIsCentroid)
 * @property {string} description one line, for tooltips
 * @property {(table: PolyhedraTable, p: number) => number} compute value for
 *   polyhedron p (gating already applied); NaN when undefined
 */

export const TETRAHEDRAL_IDEAL_DEG = 109.4712206;
export const OCTAHEDRAL_IDEAL_DEG = 90;

const RAD2DEG = 180 / Math.PI;

// Shape-check thresholds (see SHAPE CHECK in the header). Chosen with wide
// margins on both sides: a rigidly tilted octahedron keeps 180° trans angles
// and perpendicular axes whatever the tilt; thermal (MD) noise and a
// ferroelectric off-centre cation bend a trans angle by ~10–15° at most; a
// Jahn–Teller octahedron (2.4 / 1.95 Å ≈ 1.23) or a vanadyl-like short bond
// (2.3 / 1.6 ≈ 1.44) stays under the bond ratio. A Ca with six O in a
// perovskite A-site (a piece of its cuboctahedron) has trans angles of
// ~120–130°, far below; a square-planar or see-saw CN4 has a 180° angle,
// 40° past the tetrahedral window.
/** Smallest centre angle (°) of each trans pair of an octahedron. */
export const OCT_TRANS_MIN_DEG = 150;
/** Largest deviation (°) of the octahedron's trans-pair axes from 90°. */
export const OCT_AXIS_TOL_DEG = 25;
/** Largest deviation (°) of a tetrahedron's centre angles from 109.47°. */
export const TET_ANGLE_TOL_DEG = 30;
/** Largest max/min ratio of the centre–corner distances (CN4 and CN6). */
export const SHAPE_MAX_BOND_RATIO = 1.5;
const OCT_TRANS_MAX_COS = Math.cos(OCT_TRANS_MIN_DEG / RAD2DEG);
const OCT_AXIS_MAX_COS = Math.sin(OCT_AXIS_TOL_DEG / RAD2DEG);
const TET_COS_LO = Math.cos((TETRAHEDRAL_IDEAL_DEG + TET_ANGLE_TOL_DEG) / RAD2DEG);
const TET_COS_HI = Math.cos((TETRAHEDRAL_IDEAL_DEG - TET_ANGLE_TOL_DEG) / RAD2DEG);

// ---------------------------------------------------------------------------
// Scalar kernels (shared with render/PolyhedraAnalysisModule.js)
// ---------------------------------------------------------------------------

/**
 * Angle p–centre–q in degrees; 0 when either arm is degenerate. Exactly the
 * formula render/PolyhedraAnalysisModule.angleAtCenterDeg has always used
 * (it now delegates here).
 * @param {number} cx @param {number} cy @param {number} cz centre
 * @param {number} px @param {number} py @param {number} pz first arm end
 * @param {number} qx @param {number} qy @param {number} qz second arm end
 * @returns {number}
 */
export function centerAngleDeg(cx, cy, cz, px, py, pz, qx, qy, qz) {
  const ax = px - cx, ay = py - cy, az = pz - cz;
  const bx = qx - cx, by = qy - cy, bz = qz - cz;
  const dot = ax * bx + ay * by + az * bz;
  const n1 = Math.hypot(ax, ay, az), n2 = Math.hypot(bx, by, bz);
  if (n1 < 1e-9 || n2 < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (n1 * n2)));
  return Math.acos(cos) * RAD2DEG;
}

/**
 * Baur (1974) bond-length distortion index Δ = (1/n) Σ |l_i − l̄| / l̄ over the
 * centre–vertex distances l_i. W. H. Baur, Acta Cryst. B30, 1195 (1974).
 * Operation order matches the inspector's original code bit for bit.
 * @param {number} cx @param {number} cy @param {number} cz centre
 * @param {ArrayLike<number>} xyz flat vertex coordinates
 * @param {number} start first vertex (vertex index)
 * @param {number} n vertex count
 * @returns {number} NaN when n = 0 or the mean distance is ~0
 */
export function bondLengthDistortion(cx, cy, cz, xyz, start, n) {
  if (n < 1) return NaN;
  let sum = 0;
  for (let k = 0, o = 3 * start; k < n; k++, o += 3) {
    sum += Math.hypot(xyz[o] - cx, xyz[o + 1] - cy, xyz[o + 2] - cz);
  }
  const avg = sum / n;
  if (!(avg > 1e-9)) return NaN;
  let dev = 0;
  for (let k = 0, o = 3 * start; k < n; k++, o += 3) {
    dev += Math.abs(Math.hypot(xyz[o] - cx, xyz[o + 1] - cy, xyz[o + 2] - cz) - avg);
  }
  return dev / n / avg;
}

// Incremental-hull scratch, grown (rarely) when a larger CN arrives; never
// allocated per polyhedron otherwise.
let hullCap = 0;
let HP = new Float64Array(0); // points relative to their centroid
let HF = new Int32Array(0); // faces: 3 vertex indices, outward winding
let HN = new Float64Array(0); // face planes: unit normal + offset
let HV = new Uint8Array(0); // visible flags
let HE = new Int32Array(0); // horizon edges
function ensureHullScratch(n) {
  if (n <= hullCap) return;
  hullCap = Math.max(16, n);
  const faces = 2 * hullCap + 8;
  HP = new Float64Array(3 * hullCap);
  HF = new Int32Array(3 * faces);
  HN = new Float64Array(4 * faces);
  HV = new Uint8Array(faces);
  HE = new Int32Array(6 * faces);
}

/** Plane of face f from its vertices (unit normal; zero for a sliver). */
function setFacePlane(f) {
  const a = 3 * HF[3 * f], b = 3 * HF[3 * f + 1], c = 3 * HF[3 * f + 2];
  const ux = HP[b] - HP[a], uy = HP[b + 1] - HP[a + 1], uz = HP[b + 2] - HP[a + 2];
  const wx = HP[c] - HP[a], wy = HP[c + 1] - HP[a + 1], wz = HP[c + 2] - HP[a + 2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const l = Math.hypot(nx, ny, nz);
  if (l > 0) { nx /= l; ny /= l; nz /= l; }
  HN[4 * f] = nx; HN[4 * f + 1] = ny; HN[4 * f + 2] = nz;
  HN[4 * f + 3] = nx * HP[a] + ny * HP[a + 1] + nz * HP[a + 2];
}

/** Signed distance of point q (index) above face f. */
function faceDist(f, q) {
  return HN[4 * f] * HP[3 * q] + HN[4 * f + 1] * HP[3 * q + 1] + HN[4 * f + 2] * HP[3 * q + 2] - HN[4 * f + 3];
}

/**
 * Volume of the convex hull of n points (Å³), without allocating.
 *
 * Incremental hull (Clarkson–Shor / the textbook beneath-beyond method):
 * start from a non-degenerate tetrahedron, then add each remaining point
 * that lies more than `tol` above some face, replacing the faces it sees by a
 * cone from it to their horizon. The surface stays one closed, consistently
 * wound triangulation at every step, so the signed tetrahedra from each face
 * to the centroid sum to the volume — near-coplanar corners (a square face,
 * float noise) cannot be counted twice, which a per-triple "is this a hull
 * face" test with a tolerance does get wrong (the tolerance decides
 * differently for different triples of the same face). A point within `tol`
 * of the hull is skipped; the volume then differs by at most ≈ tol × area.
 * Cost O(n · F²) with F ≤ 2n − 4 faces: trivial for CN ≤ 12.
 *
 * @param {ArrayLike<number>} xyz flat coordinates
 * @param {number} start first vertex (vertex index)
 * @param {number} n vertex count
 * @param {number} [relTol=1e-9] distance tolerance relative to the largest
 *   centroid–vertex distance; the batch path uses a looser one for Float32
 *   input (see BATCH_REL_TOL). Must be > 0.
 * @returns {number} NaN for n < 4 or a flat / collinear set
 */
export function convexHullVolume(xyz, start, n, relTol = 1e-9) {
  const nf = buildHull(xyz, start, n, relTol);
  if (nf < 0) return NaN;
  let v6 = 0;
  for (let f = 0; f < nf; f++) {
    const a = 3 * HF[3 * f], b = 3 * HF[3 * f + 1], c = 3 * HF[3 * f + 2];
    v6 += HP[a] * (HP[b + 1] * HP[c + 2] - HP[b + 2] * HP[c + 1])
      - HP[a + 1] * (HP[b] * HP[c + 2] - HP[b + 2] * HP[c])
      + HP[a + 2] * (HP[b] * HP[c + 1] - HP[b + 1] * HP[c]);
  }
  return Math.abs(v6) / 6;
}

/**
 * Triangulated convex hull of n points, without allocating: the same
 * incremental hull as convexHullVolume, its faces copied out as local vertex
 * indices (0..n−1), wound counter-clockwise seen from outside (the normal
 * (b−a)×(c−a) points out). A point within `relTol` × radius of the hull is
 * left out of it, so near-coplanar corners give no sliver faces. The
 * renderer re-triangulates a polyhedron with this on an MD frame whose stored
 * triangulation stopped being convex (render/PolyhedraMesh.js).
 * @param {ArrayLike<number>} xyz flat coordinates
 * @param {number} start first vertex (vertex index)
 * @param {number} n vertex count
 * @param {number} relTol see convexHullVolume
 * @param {Uint16Array | Uint32Array | Int32Array} out receives 3 indices per face
 * @param {number} [outOffset=0] first index written (array index)
 * @returns {number} face count (≤ 2n − 4), or 0 for n < 4 or a flat set
 */
export function convexHullTriangles(xyz, start, n, relTol, out, outOffset = 0) {
  const nf = buildHull(xyz, start, n, relTol);
  if (nf < 0) return 0;
  for (let k = 0; k < 3 * nf; k++) out[outOffset + k] = HF[k];
  return nf;
}

/**
 * Build the hull of n points into the scratch arrays (HP relative to the
 * centroid, HF faces); see convexHullVolume for the method.
 * @returns {number} face count, −1 when degenerate (n < 4, flat, collinear)
 */
function buildHull(xyz, start, n, relTol) {
  if (n < 4) return -1;
  ensureHullScratch(n);
  const s = 3 * start;
  let gx = 0, gy = 0, gz = 0;
  for (let k = 0; k < n; k++) { gx += xyz[s + 3 * k]; gy += xyz[s + 3 * k + 1]; gz += xyz[s + 3 * k + 2]; }
  gx /= n; gy /= n; gz /= n;
  let R = 0;
  for (let k = 0; k < n; k++) {
    const x = xyz[s + 3 * k] - gx, y = xyz[s + 3 * k + 1] - gy, z = xyz[s + 3 * k + 2] - gz;
    HP[3 * k] = x; HP[3 * k + 1] = y; HP[3 * k + 2] = z;
    const d = Math.hypot(x, y, z);
    if (d > R) R = d;
  }
  if (!(R > 0)) return -1;
  const tol = relTol * R;

  // Initial tetrahedron: p0 farthest from the centroid, p1 farthest from p0,
  // p2 farthest from line p0p1, p3 farthest from plane p0p1p2.
  let p0 = 0;
  for (let k = 1; k < n; k++) if (HP[3 * k] ** 2 + HP[3 * k + 1] ** 2 + HP[3 * k + 2] ** 2 > HP[3 * p0] ** 2 + HP[3 * p0 + 1] ** 2 + HP[3 * p0 + 2] ** 2) p0 = k;
  let p1 = -1, best = -1;
  for (let k = 0; k < n; k++) {
    const d = (HP[3 * k] - HP[3 * p0]) ** 2 + (HP[3 * k + 1] - HP[3 * p0 + 1]) ** 2 + (HP[3 * k + 2] - HP[3 * p0 + 2]) ** 2;
    if (d > best) { best = d; p1 = k; }
  }
  if (!(Math.sqrt(best) > tol)) return -1;
  const ex = HP[3 * p1] - HP[3 * p0], ey = HP[3 * p1 + 1] - HP[3 * p0 + 1], ez = HP[3 * p1 + 2] - HP[3 * p0 + 2];
  const el = Math.hypot(ex, ey, ez);
  let p2 = -1; best = -1;
  for (let k = 0; k < n; k++) {
    const wx = HP[3 * k] - HP[3 * p0], wy = HP[3 * k + 1] - HP[3 * p0 + 1], wz = HP[3 * k + 2] - HP[3 * p0 + 2];
    const d = Math.hypot(ey * wz - ez * wy, ez * wx - ex * wz, ex * wy - ey * wx) / el;
    if (d > best) { best = d; p2 = k; }
  }
  if (!(best > tol)) return -1; // collinear
  HF[0] = p0; HF[1] = p1; HF[2] = p2;
  setFacePlane(0);
  let p3 = -1; best = -1;
  for (let k = 0; k < n; k++) {
    const d = Math.abs(faceDist(0, k));
    if (d > best) { best = d; p3 = k; }
  }
  if (!(best > tol)) return -1; // flat
  // Wind face 0 so p3 is below it, then the three side faces to match.
  if (faceDist(0, p3) > 0) { HF[1] = p2; HF[2] = p1; setFacePlane(0); }
  const a0 = HF[0], a1 = HF[1], a2 = HF[2];
  HF[3] = a1; HF[4] = a0; HF[5] = p3;
  HF[6] = a2; HF[7] = a1; HF[8] = p3;
  HF[9] = a0; HF[10] = a2; HF[11] = p3;
  let nf = 4;
  for (let f = 1; f < 4; f++) setFacePlane(f);

  for (let q = 0; q < n; q++) {
    if (q === p0 || q === p1 || q === p2 || q === p3) continue;
    let any = false;
    for (let f = 0; f < nf; f++) {
      const vis = faceDist(f, q) > tol;
      HV[f] = vis ? 1 : 0;
      if (vis) any = true;
    }
    if (!any) continue; // inside (or within tol of) the current hull
    // Horizon: edges (a,b) of visible faces whose neighbour across them —
    // the face holding the reversed edge (b,a) — is not visible.
    let ne = 0;
    for (let f = 0; f < nf; f++) {
      if (!HV[f]) continue;
      for (let e = 0; e < 3; e++) {
        const a = HF[3 * f + e], b = HF[3 * f + (e + 1) % 3];
        let nbVisible = true;
        for (let g = 0; g < nf; g++) {
          if (g === f) continue;
          const g0 = HF[3 * g], g1 = HF[3 * g + 1], g2 = HF[3 * g + 2];
          if ((g0 === b && g1 === a) || (g1 === b && g2 === a) || (g2 === b && g0 === a)) { nbVisible = HV[g] === 1; break; }
        }
        if (!nbVisible) { HE[2 * ne] = a; HE[2 * ne + 1] = b; ne++; }
      }
    }
    // Drop the visible faces (compact), then add the cone from q.
    let w = 0;
    for (let f = 0; f < nf; f++) {
      if (HV[f]) continue;
      if (w !== f) {
        HF[3 * w] = HF[3 * f]; HF[3 * w + 1] = HF[3 * f + 1]; HF[3 * w + 2] = HF[3 * f + 2];
        HN[4 * w] = HN[4 * f]; HN[4 * w + 1] = HN[4 * f + 1]; HN[4 * w + 2] = HN[4 * f + 2]; HN[4 * w + 3] = HN[4 * f + 3];
      }
      w++;
    }
    for (let e = 0; e < ne; e++) {
      HF[3 * w] = HE[2 * e]; HF[3 * w + 1] = HE[2 * e + 1]; HF[3 * w + 2] = q;
      setFacePlane(w);
      w++;
    }
    nf = w;
  }

  return nf;
}

/**
 * Centre–vertex distance l_0 of the regular polyhedron with volume V.
 * Regular octahedron of circumradius r: V = (4/3) r³ → r = (3V/4)^(1/3).
 * Regular tetrahedron of circumradius r: edge e = r √(8/3), V = e³/(6√2)
 * = (8√3/27) r³ → r = (27V / (8√3))^(1/3).
 * @param {number} cn 4 or 6
 * @param {number} volume Å³
 * @returns {number} NaN for other CN
 */
export function regularCircumradius(cn, volume) {
  if (cn === 6) return Math.cbrt(0.75 * volume);
  if (cn === 4) return Math.cbrt(27 * volume / (8 * Math.sqrt(3)));
  return NaN;
}

// ---------------------------------------------------------------------------
// Per-polyhedron helpers on the table (scratch-based, no allocation)
// ---------------------------------------------------------------------------

// Unit centre→vertex vectors and distances (up to 6 vertices), trans
// partner per vertex, an octahedron's three trans-pair axes (Cartesian rows).
const UNIT = new Float64Array(18);
const DIST = new Float64Array(6);
const TRANS = new Int8Array(6);
const OAX = new Float64Array(9);
// Orientation fit scratch: S (3×3), N (4×4), eigenvectors V (4×4), result.
const S3 = new Float64Array(9);
const N4 = new Float64Array(16);
const V4 = new Float64Array(16);
const ROT = new Float64Array(4); // rotation vector (rad, frame coords) + angle
const AXES = new Float64Array(9); // measured axes / directions in frame coords
const FRAME = new Float64Array(9);
let frameSource = /** @type {any} */ (null);
let frameOk = false;
const Q4 = new Float64Array(4); // unit quaternion of the last hornRotation (w, x, y, z)
// Mean-frame scratch: one polyhedron's three axes (Cartesian rows), the
// running sum of the matched axes, the seed and the alignment reference.
const PAXES = new Float64Array(9);
const SUMAX = new Float64Array(9);
const SEED = new Float64Array(9);
const REF = new Float64Array(9);

/** Permutations of 3 (octahedron axes) and 4 (tetrahedron corners). */
const PERM3 = new Uint8Array([0, 1, 2, 0, 2, 1, 1, 0, 2, 1, 2, 0, 2, 0, 1, 2, 1, 0]);
const PERM4 = (() => {
  const out = [];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) for (let d = 0; d < 4; d++) {
    if (a !== b && a !== c && a !== d && b !== c && b !== d && c !== d) out.push(a, b, c, d);
  }
  return new Uint8Array(out);
})();
const TET_IDEAL = (() => {
  const r = 1 / Math.sqrt(3);
  return new Float64Array([r, r, r, r, -r, -r, -r, r, -r, -r, -r, r]);
})();

/**
 * Has polyhedron p a centre?
 * @param {PolyhedraTable} t @param {number} p
 */
function hasCenter(t, p) {
  const c = t.centerXYZ;
  return !!c && Number.isFinite(c[3 * p]) && Number.isFinite(c[3 * p + 1]) && Number.isFinite(c[3 * p + 2]);
}

/**
 * Fill UNIT with centre→vertex unit vectors of polyhedron p (n ≤ 6), DIST
 * with the distances.
 * @param {PolyhedraTable} t @param {number} p @param {number} n
 * @returns {boolean} false if a vertex sits on the centre
 */
function fillUnit(t, p, n) {
  const c = t.centerXYZ, xyz = t.vertXYZ;
  const cx = c[3 * p], cy = c[3 * p + 1], cz = c[3 * p + 2];
  for (let k = 0, o = 3 * t.vertStart[p]; k < n; k++, o += 3) {
    const x = xyz[o] - cx, y = xyz[o + 1] - cy, z = xyz[o + 2] - cz;
    const l = Math.hypot(x, y, z);
    if (l < 1e-9) return false;
    DIST[k] = l;
    UNIT[3 * k] = x / l; UNIT[3 * k + 1] = y / l; UNIT[3 * k + 2] = z / l;
  }
  return true;
}

/**
 * Trans pairs of an octahedron into TRANS (partner index per vertex), by the
 * same rule as the inspector's octahedralAngles: repeatedly take the largest
 * remaining centre angle between two unused vertices (smallest cosine; ties
 * resolved to the first pair in (i,j) order, as its stable sort does).
 * Requires UNIT filled.
 */
function findTransPairs() {
  let used = 0;
  for (let round = 0; round < 3; round++) {
    let best = Infinity, bi = -1, bj = -1;
    for (let i = 0; i < 6; i++) {
      if (used & (1 << i)) continue;
      for (let j = i + 1; j < 6; j++) {
        if (used & (1 << j)) continue;
        const c = Math.max(-1, Math.min(1, UNIT[3 * i] * UNIT[3 * j] + UNIT[3 * i + 1] * UNIT[3 * j + 1] + UNIT[3 * i + 2] * UNIT[3 * j + 2]));
        if (c < best) { best = c; bi = i; bj = j; }
      }
    }
    used |= (1 << bi) | (1 << bj);
    TRANS[bi] = bj; TRANS[bj] = bi;
  }
}

/** Are DIST[0..n) alike (max/min ≤ SHAPE_MAX_BOND_RATIO)? */
function bondsAlike(n) {
  let lo = DIST[0], hi = DIST[0];
  for (let k = 1; k < n; k++) { const d = DIST[k]; if (d < lo) lo = d; else if (d > hi) hi = d; }
  return hi <= SHAPE_MAX_BOND_RATIO * lo;
}

/**
 * Is polyhedron p (CN6, UNIT and DIST filled) an octahedron in shape (see
 * SHAPE CHECK)? Finds the trans pairs into TRANS and, when it is, their
 * vertex-difference axes into OAX (unit Cartesian rows) — the axes the tilt
 * fit and the mean frame use.
 * @param {PolyhedraTable} t @param {number} p
 */
function octahedronShape(t, p) {
  if (!bondsAlike(6)) return false;
  findTransPairs();
  const xyz = t.vertXYZ, s = 3 * t.vertStart[p];
  let k = 0;
  for (let i = 0; i < 6; i++) {
    const j = TRANS[i];
    if (j < i) continue;
    if (UNIT[3 * i] * UNIT[3 * j] + UNIT[3 * i + 1] * UNIT[3 * j + 1] + UNIT[3 * i + 2] * UNIT[3 * j + 2] > OCT_TRANS_MAX_COS) return false;
    const dx = xyz[s + 3 * i] - xyz[s + 3 * j];
    const dy = xyz[s + 3 * i + 1] - xyz[s + 3 * j + 1];
    const dz = xyz[s + 3 * i + 2] - xyz[s + 3 * j + 2];
    const l = Math.hypot(dx, dy, dz);
    if (!(l > 1e-9)) return false;
    OAX[3 * k] = dx / l; OAX[3 * k + 1] = dy / l; OAX[3 * k + 2] = dz / l;
    k++;
  }
  return Math.abs(OAX[0] * OAX[3] + OAX[1] * OAX[4] + OAX[2] * OAX[5]) <= OCT_AXIS_MAX_COS
    && Math.abs(OAX[0] * OAX[6] + OAX[1] * OAX[7] + OAX[2] * OAX[8]) <= OCT_AXIS_MAX_COS
    && Math.abs(OAX[3] * OAX[6] + OAX[4] * OAX[7] + OAX[5] * OAX[8]) <= OCT_AXIS_MAX_COS;
}

/** Is the CN4 in UNIT / DIST a tetrahedron in shape (see SHAPE CHECK)? */
function tetrahedronShape() {
  if (!bondsAlike(4)) return false;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const c = UNIT[3 * i] * UNIT[3 * j] + UNIT[3 * i + 1] * UNIT[3 * j + 1] + UNIT[3 * i + 2] * UNIT[3 * j + 2];
      if (c < TET_COS_LO || c > TET_COS_HI) return false;
    }
  }
  return true;
}

/**
 * Common gate of the orientation maths: polyhedron p is CN4/CN6 with a
 * centre and is a tetrahedron / octahedron in shape. Leaves UNIT, DIST (and
 * for CN6 TRANS, OAX) filled.
 * @param {PolyhedraTable} t @param {number} p @param {number} n vertCount[p]
 */
function regularShapeOf(t, p, n) {
  if (!fillUnit(t, p, n)) return false;
  return n === 6 ? octahedronShape(t, p) : tetrahedronShape();
}

/**
 * Bond-angle variance (Robinson et al. 1971), °². K. Robinson, G. V. Gibbs,
 * P. H. Ribbe, Science 172, 567 (1971): σ² = Σ_{i=1..m} (θ_i − θ_0)² / (m − 1),
 * tetrahedron m = 6, θ_0 = 109.47°; octahedron m = 12 cis angles, θ_0 = 90°.
 * @param {PolyhedraTable} t @param {number} p
 */
function angleVarianceOf(t, p) {
  const n = t.vertCount[p];
  const c = t.centerXYZ, xyz = t.vertXYZ, s = 3 * t.vertStart[p];
  const cx = c[3 * p], cy = c[3 * p + 1], cz = c[3 * p + 2];
  if (n === 6) {
    if (!fillUnit(t, p, 6)) return NaN;
    findTransPairs();
  }
  const ideal = n === 4 ? TETRAHEDRAL_IDEAL_DEG : OCTAHEDRAL_IDEAL_DEG;
  let sq = 0, m = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (n === 6 && TRANS[i] === j) continue;
      const a = centerAngleDeg(cx, cy, cz,
        xyz[s + 3 * i], xyz[s + 3 * i + 1], xyz[s + 3 * i + 2],
        xyz[s + 3 * j], xyz[s + 3 * j + 1], xyz[s + 3 * j + 2]);
      sq += (a - ideal) * (a - ideal);
      m++;
    }
  }
  return sq / (m - 1);
}

/**
 * Quadratic elongation (Robinson et al. 1971): ⟨λ⟩ = (1/n) Σ (l_i / l_0)²,
 * l_i the centre–vertex distances, l_0 the circumradius of the regular
 * polyhedron with the same (convex-hull) volume — regularCircumradius().
 * 1 for a regular polyhedron, > 1 otherwise (to first order independent of
 * pure size). CN4 and CN6.
 * @param {PolyhedraTable} t @param {number} p @param {number} relTol
 */
function quadraticElongationOf(t, p, relTol) {
  const n = t.vertCount[p], start = t.vertStart[p];
  const vol = convexHullVolume(t.vertXYZ, start, n, relTol);
  const l0 = regularCircumradius(n, vol);
  if (!(l0 > 0)) return NaN;
  const c = t.centerXYZ, xyz = t.vertXYZ;
  const cx = c[3 * p], cy = c[3 * p + 1], cz = c[3 * p + 2];
  let sum = 0;
  for (let k = 0, o = 3 * start; k < n; k++, o += 3) {
    const dx = xyz[o] - cx, dy = xyz[o + 1] - cy, dz = xyz[o + 2] - cz;
    sum += (dx * dx + dy * dy + dz * dz) / (l0 * l0);
  }
  return sum / n;
}

/**
 * Build (and cache per table frame/lattice object) the orthonormal reference
 * frame rows into FRAME. See the header for the definition.
 * @param {PolyhedraTable} t
 * @returns {boolean} false if no usable frame
 */
function ensureFrameFor(t, p) {
  const fo = t.frameOf;
  if (fo && t.frames && fo[p] >= 0) {
    // Per-row frame (the automatic frame, one per polyhedron type). Copied
    // every time — nine numbers — rather than cached by identity: the
    // caller rewrites these arrays in place every MD frame.
    const o = 9 * fo[p], f = t.frames;
    for (let k = 0; k < 9; k++) FRAME[k] = f[o + k];
    frameSource = null;
    return Number.isFinite(FRAME[0]) && Number.isFinite(FRAME[8]);
  }
  return ensureFrame(t);
}

function ensureFrame(t) {
  const src = t.frame ?? t.lattice;
  if (src === frameSource) return frameOk;
  frameSource = src;
  frameOk = false;
  if (!src || !src[0] || !src[1]) return false;
  if (t.frame) {
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) FRAME[3 * r + k] = src[r][k];
    frameOk = true;
    return true;
  }
  const a = src[0], b = src[1];
  const al = Math.hypot(a[0], a[1], a[2]);
  if (!(al > 0)) return false;
  const ax = a[0] / al, ay = a[1] / al, az = a[2] / al;
  const ba = b[0] * ax + b[1] * ay + b[2] * az;
  let bx = b[0] - ba * ax, by = b[1] - ba * ay, bz = b[2] - ba * az;
  const bl = Math.hypot(bx, by, bz);
  if (!(bl > 1e-12 * al)) return false;
  bx /= bl; by /= bl; bz /= bl;
  FRAME[0] = ax; FRAME[1] = ay; FRAME[2] = az;
  FRAME[3] = bx; FRAME[4] = by; FRAME[5] = bz;
  FRAME[6] = ay * bz - az * by; FRAME[7] = az * bx - ax * bz; FRAME[8] = ax * by - ay * bx;
  frameOk = true;
  return true;
}

/**
 * Largest eigenvector of the symmetric 4×4 in N4 by cyclic Jacobi; returns
 * its column index in V4 (eigenvalues end up on N4's diagonal).
 */
function jacobi4() {
  V4.fill(0);
  V4[0] = V4[5] = V4[10] = V4[15] = 1;
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0, diag = 0;
    for (let r = 0; r < 4; r++) {
      diag += N4[5 * r] * N4[5 * r];
      for (let c = r + 1; c < 4; c++) off += N4[4 * r + c] * N4[4 * r + c];
    }
    if (off <= 1e-32 * diag) break;
    for (let pp = 0; pp < 3; pp++) {
      for (let q = pp + 1; q < 4; q++) {
        const apq = N4[4 * pp + q];
        if (apq === 0) continue;
        const app = N4[5 * pp], aqq = N4[5 * q];
        const theta = (aqq - app) / (2 * apq);
        const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(tt * tt + 1), sn = tt * cs;
        for (let k = 0; k < 4; k++) { // columns pp, q
          const akp = N4[4 * k + pp], akq = N4[4 * k + q];
          N4[4 * k + pp] = cs * akp - sn * akq;
          N4[4 * k + q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < 4; k++) { // rows pp, q
          const apk = N4[4 * pp + k], aqk = N4[4 * q + k];
          N4[4 * pp + k] = cs * apk - sn * aqk;
          N4[4 * q + k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = V4[4 * k + pp], vkq = V4[4 * k + q];
          V4[4 * k + pp] = cs * vkp - sn * vkq;
          V4[4 * k + q] = sn * vkp + cs * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (N4[5 * k] > N4[5 * best]) best = k;
  return best;
}

/**
 * Horn (1987) closed-form absolute orientation: the proper rotation R that
 * maximises Σ_k b_k · R a_k is the unit quaternion of the largest eigenvalue of
 * N(S), S_xy = Σ_k a_k,x b_k,y. B. K. P. Horn, J. Opt. Soc. Am. A 4, 629
 * (1987). Reads S3, writes ROT = [ωx, ωy, ωz, θ] (rotation vector in rad).
 */
function hornRotation() {
  const sxx = S3[0], sxy = S3[1], sxz = S3[2];
  const syx = S3[3], syy = S3[4], syz = S3[5];
  const szx = S3[6], szy = S3[7], szz = S3[8];
  N4[0] = sxx + syy + szz; N4[1] = syz - szy; N4[2] = szx - sxz; N4[3] = sxy - syx;
  N4[5] = sxx - syy - szz; N4[6] = sxy + syx; N4[7] = szx + sxz;
  N4[10] = -sxx + syy - szz; N4[11] = syz + szy;
  N4[15] = -sxx - syy + szz;
  N4[4] = N4[1]; N4[8] = N4[2]; N4[12] = N4[3];
  N4[9] = N4[6]; N4[13] = N4[7]; N4[14] = N4[11];
  const c = jacobi4();
  let w = V4[c], x = V4[4 + c], y = V4[8 + c], z = V4[12 + c];
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  Q4[0] = w; Q4[1] = x; Q4[2] = y; Q4[3] = z;
  const vl = Math.hypot(x, y, z);
  // atan2 rather than acos: well-conditioned for small angles.
  const theta = 2 * Math.atan2(vl, w);
  const f = vl > 0 ? theta / vl : 2; // small-angle limit: ω ≈ 2·(x,y,z)
  ROT[0] = x * f; ROT[1] = y * f; ROT[2] = z * f; ROT[3] = theta;
}

/**
 * Orientation of polyhedron p (CN4/CN6 with centre) relative to the ideal one
 * in the reference frame, into ROT. See the header for the convention.
 * @param {PolyhedraTable} t @param {number} p
 * @returns {boolean} false when undefined (then ROT is NaN): another CN, no
 *   centre, a degenerate shape, or not a tetrahedron / octahedron in shape
 */
function orientationOf(t, p) {
  ROT.fill(NaN);
  const n = t.vertCount[p];
  if ((n !== 4 && n !== 6) || !hasCenter(t, p) || !ensureFrameFor(t, p)) return false;
  if (!regularShapeOf(t, p, n)) return false;
  const F = FRAME;
  if (n === 6) {
    // Axis k = normalised (v_i − v_j) of the k-th trans pair (OAX), in frame
    // coords.
    for (let k = 0; k < 3; k++) {
      const dx = OAX[3 * k], dy = OAX[3 * k + 1], dz = OAX[3 * k + 2];
      for (let r = 0; r < 3; r++) AXES[3 * k + r] = F[3 * r] * dx + F[3 * r + 1] * dy + F[3 * r + 2] * dz;
    }
    // Assign measured axes to frame axes: permutation maximising Σ|cos|.
    let best = -1, bp = 0;
    for (let q = 0; q < 6; q++) {
      const sc = Math.abs(AXES[3 * PERM3[3 * q]]) + Math.abs(AXES[3 * PERM3[3 * q + 1] + 1]) + Math.abs(AXES[3 * PERM3[3 * q + 2] + 2]);
      if (sc > best) { best = sc; bp = q; }
    }
    // S row a = measured axis assigned to frame axis a (ideal a = e_a),
    // signed to point along +e_a.
    for (let a = 0; a < 3; a++) {
      const m = PERM3[3 * bp + a];
      const sg = AXES[3 * m + a] < 0 ? -1 : 1;
      S3[3 * a] = sg * AXES[3 * m]; S3[3 * a + 1] = sg * AXES[3 * m + 1]; S3[3 * a + 2] = sg * AXES[3 * m + 2];
    }
  } else {
    // Unit vectors in frame coordinates.
    for (let k = 0; k < 4; k++) {
      const x = UNIT[3 * k], y = UNIT[3 * k + 1], z = UNIT[3 * k + 2];
      for (let r = 0; r < 3; r++) AXES[r] = F[3 * r] * x + F[3 * r + 1] * y + F[3 * r + 2] * z;
      UNIT[3 * k] = AXES[0]; UNIT[3 * k + 1] = AXES[1]; UNIT[3 * k + 2] = AXES[2];
    }
    // Ideal corner t ↔ measured corner PERM4[q][t], maximising Σ cos.
    let best = -Infinity, bp = 0;
    for (let q = 0; q < 24; q++) {
      let sc = 0;
      for (let ti = 0; ti < 4; ti++) {
        const m = PERM4[4 * q + ti];
        sc += TET_IDEAL[3 * ti] * UNIT[3 * m] + TET_IDEAL[3 * ti + 1] * UNIT[3 * m + 1] + TET_IDEAL[3 * ti + 2] * UNIT[3 * m + 2];
      }
      if (sc > best) { best = sc; bp = q; }
    }
    S3.fill(0);
    for (let ti = 0; ti < 4; ti++) {
      const m = PERM4[4 * bp + ti];
      for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) S3[3 * x + y] += TET_IDEAL[3 * ti + x] * UNIT[3 * m + y];
    }
  }
  hornRotation();
  return true;
}

/**
 * Rotation of polyhedron p as [tiltA, tiltB, tiltC, rotation] in degrees
 * (see the header), written into `res`. NaN where undefined. For single-
 * polyhedron callers (an inspector); the batch path uses the registry.
 * @param {PolyhedraTable} table @param {number} p
 * @param {Float64Array | Float32Array | number[]} res length ≥ 4
 */
export function polyhedronOrientation(table, p, res) {
  orientationOf(table, p);
  res[0] = ROT[0] * RAD2DEG; res[1] = ROT[1] * RAD2DEG; res[2] = ROT[2] * RAD2DEG; res[3] = ROT[3] * RAD2DEG;
  return res;
}

// The coplanarity tolerance the batch path uses: Float32 absolute coordinates
// carry ~1e-7 relative noise on |r| ~ 100 Å, i.e. a few 1e-6 of a 2 Å
// polyhedron radius. Treating points within that of a plane as coplanar
// changes the volume by at most tol·area — far below anything visible.
const BATCH_REL_TOL = 1e-5;

/**
 * @param {PolyhedraTable} t @param {number} p @param {number} comp 0..3
 */
function orientationComponent(t, p, comp) {
  return orientationOf(t, p) ? ROT[comp] * RAD2DEG : NaN;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** @type {PolyhedraPropertyDef[]} */
export const POLYHEDRA_PROPERTIES = [
  {
    id: 'volume', label: 'Volume', unit: 'Å³', kind: 'scalar', applicableCN: null, needsCenter: false,
    description: 'Convex-hull volume of the corner atoms.',
    compute: (t, p) => convexHullVolume(t.vertXYZ, t.vertStart[p], t.vertCount[p], BATCH_REL_TOL),
  },
  {
    id: 'bld', label: 'Bond-length distortion', unit: '', kind: 'scalar', applicableCN: null, needsCenter: true, needsTrueCenter: true,
    description: 'Baur distortion index: mean |l − l̄| / l̄ of the centre–corner distances.',
    compute: (t, p) => {
      const c = t.centerXYZ;
      return bondLengthDistortion(c[3 * p], c[3 * p + 1], c[3 * p + 2], t.vertXYZ, t.vertStart[p], t.vertCount[p]);
    },
  },
  {
    id: 'angleVariance', label: 'Bond-angle variance', unit: '°²', kind: 'scalar', applicableCN: [4, 6], needsCenter: true,
    description: 'Robinson angle variance: CN4 vs 109.47°, CN6 cis angles vs 90°.',
    compute: angleVarianceOf,
  },
  {
    id: 'quadraticElongation', label: 'Quadratic elongation', unit: '', kind: 'scalar', applicableCN: [4, 6], needsCenter: true,
    description: 'Robinson ⟨λ⟩: mean (l / l₀)², l₀ of the regular polyhedron of equal volume.',
    compute: (t, p) => quadraticElongationOf(t, p, BATCH_REL_TOL),
  },
  {
    id: 'tiltA', label: 'Tilt about a', unit: '°', kind: 'scalar', applicableCN: [4, 6], needsCenter: true,
    description: 'Rotation-vector component about the first reference axis, â (right-hand rule); the reference axes are those chosen under Tilt axes. Octahedra and tetrahedra in shape only.',
    compute: (t, p) => orientationComponent(t, p, 0),
  },
  {
    id: 'tiltB', label: 'Tilt about b', unit: '°', kind: 'scalar', applicableCN: [4, 6], needsCenter: true,
    description: "Rotation-vector component about the second reference axis, b̂' (made orthogonal to â); the reference axes are those chosen under Tilt axes. Octahedra and tetrahedra in shape only.",
    compute: (t, p) => orientationComponent(t, p, 1),
  },
  {
    id: 'tiltC', label: 'Tilt about c', unit: '°', kind: 'scalar', applicableCN: [4, 6], needsCenter: true,
    description: "Rotation-vector component about the third reference axis, ĉ' = â × b̂'; the reference axes are those chosen under Tilt axes. Octahedra and tetrahedra in shape only.",
    compute: (t, p) => orientationComponent(t, p, 2),
  },
  {
    id: 'rotation', label: 'Total rotation', unit: '°', kind: 'scalar', applicableCN: [4, 6], needsCenter: true,
    description: 'Angle of the best-fit rotation from the ideal polyhedron aligned with the reference axes chosen under Tilt axes. Octahedra and tetrahedra in shape only.',
    compute: (t, p) => orientationComponent(t, p, 3),
  },
];

/**
 * @param {string} id
 * @returns {PolyhedraPropertyDef | undefined}
 */
export function getPolyhedraProperty(id) {
  return POLYHEDRA_PROPERTIES.find((d) => d.id === id);
}

/**
 * Fill out[p] (p < table.count) with property `id`, NaN where it does not
 * apply (CN outside applicableCN, a cage for a centre-based property, or a
 * degenerate shape). The per-frame entry point: O(count), no allocation.
 * @param {string} id
 * @param {PolyhedraTable} table
 * @param {Float32Array | Float64Array} [out] reused when given (length ≥ count)
 * @returns {Float32Array | Float64Array} out
 */
export function computePolyhedraProperty(id, table, out) {
  const def = getPolyhedraProperty(id);
  if (!def) throw new Error(`Unknown polyhedron property '${id}'`);
  const count = table.count;
  const res = out ?? new Float32Array(count);
  const cns = def.applicableCN;
  const needsCenter = def.needsCenter;
  const vc = table.vertCount;
  const fn = def.compute;
  const standIn = def.needsTrueCenter ? table.centerIsCentroid : null;
  frameSource = null; // the caller may have rewritten lattice/frame in place
  for (let p = 0; p < count; p++) {
    const cn = vc[p];
    if (cns && cn !== cns[0] && cns.indexOf(cn) < 0) { res[p] = NaN; continue; }
    if (needsCenter && !hasCenter(table, p)) { res[p] = NaN; continue; }
    if (standIn && standIn[p]) { res[p] = NaN; continue; }
    res[p] = fn(table, p);
  }
  return res;
}

/**
 * The four orientation columns (tiltA, tiltB, tiltC, rotation; degrees) in
 * ONE pass: one rotation fit per polyhedron instead of four. NaN where the
 * orientation is undefined (CN other than 4/6, no centre, degenerate, or not
 * a tetrahedron / octahedron in shape). The
 * per-frame entry point for colouring by tilt — any of the four outputs may
 * be null when not wanted.
 * @param {PolyhedraTable} table
 * @param {Float32Array | Float64Array | null} outA
 * @param {Float32Array | Float64Array | null} outB
 * @param {Float32Array | Float64Array | null} outC
 * @param {Float32Array | Float64Array | null} outRot
 */
export function computePolyhedraOrientations(table, outA, outB, outC, outRot) {
  frameSource = null;
  for (let p = 0; p < table.count; p++) {
    const ok = orientationOf(table, p);
    if (outA) outA[p] = ok ? ROT[0] * RAD2DEG : NaN;
    if (outB) outB[p] = ok ? ROT[1] * RAD2DEG : NaN;
    if (outC) outC[p] = ok ? ROT[2] * RAD2DEG : NaN;
    if (outRot) outRot[p] = ok ? ROT[3] * RAD2DEG : NaN;
  }
}

/** Is `id` one of the signed orientation columns (a diverging colour map
 *  centred at 0 suits it)? @param {string} id */
export function isSignedPolyhedraProperty(id) {
  return id === 'tiltA' || id === 'tiltB' || id === 'tiltC';
}

/** Is `id` one of the four orientation columns? @param {string} id */
export function isOrientationProperty(id) {
  return id === 'tiltA' || id === 'tiltB' || id === 'tiltC' || id === 'rotation';
}

// ---------------------------------------------------------------------------
// Automatic reference frame
// ---------------------------------------------------------------------------
//
// Tilts measured against the cell axes are only meaningful when the cell is
// the pseudo-cubic one. In a √2×√2 (or any other) setting the untilted
// octahedron is not cell-aligned, but corner-sharing neighbours tilt in
// opposite senses, so the MEAN orientation of all polyhedra of one type is
// the untilted pseudo-cubic frame, in any cell setting and without the user
// knowing it. meanOrientationFrame() computes it; the renderer passes it per
// type through `frames`/`frameOf` (see the table contract).

/** Octahedral pairings of a tetrahedron's corners: axis k bisects the pair
 *  (P[k][0], P[k][1]) against the other two. */
const TET_PAIRS = new Uint8Array([0, 1, 2, 3, 0, 2, 1, 3, 0, 3, 1, 2]);

/**
 * The three (pseudo-cubic) axes of polyhedron p as unit Cartesian rows into
 * `out` (9 numbers), each with an arbitrary sign and in arbitrary order:
 * CN6 the trans-pair vertex differences (as the tilt fit uses), CN4 the
 * three two-fold axes, (u_a + u_b − u_c − u_d) for the three pairings of its
 * centre→corner unit vectors. Undefined (false) for other CN, a missing
 * centre, a degenerate shape, or a CN4/CN6 that is not a tetrahedron /
 * octahedron in shape (the SHAPE CHECK in the header).
 * @param {PolyhedraTable} t @param {number} p
 * @param {Float64Array} out length ≥ 9
 * @returns {boolean}
 */
export function polyhedronAxes(t, p, out) {
  const n = t.vertCount[p];
  if ((n !== 4 && n !== 6) || !hasCenter(t, p) || !regularShapeOf(t, p, n)) return false;
  if (n === 6) {
    for (let k = 0; k < 9; k++) out[k] = OAX[k];
    return true;
  }
  for (let k = 0; k < 3; k++) {
    const a = 3 * TET_PAIRS[4 * k], b = 3 * TET_PAIRS[4 * k + 1];
    const c = 3 * TET_PAIRS[4 * k + 2], d = 3 * TET_PAIRS[4 * k + 3];
    const x = UNIT[a] + UNIT[b] - UNIT[c] - UNIT[d];
    const y = UNIT[a + 1] + UNIT[b + 1] - UNIT[c + 1] - UNIT[d + 1];
    const z = UNIT[a + 2] + UNIT[b + 2] - UNIT[c + 2] - UNIT[d + 2];
    const l = Math.hypot(x, y, z);
    if (!(l > 1e-9)) return false;
    out[3 * k] = x / l; out[3 * k + 1] = y / l; out[3 * k + 2] = z / l;
  }
  return true;
}

/**
 * Permutation (into PERM3) and signs that best match three axes `a` (rows)
 * to the reference rows `r`: maximise Σ_k |a_perm(k) · r_k|, then sign each
 * matched axis along its reference. Writes the matched rows into `out`.
 * @returns {number} the score Σ|cos|
 */
function matchAxes(a, ao, r, ro, out, oo) {
  let best = -1, bp = 0;
  for (let q = 0; q < 6; q++) {
    let sc = 0;
    for (let k = 0; k < 3; k++) {
      const m = ao + 3 * PERM3[3 * q + k], rk = ro + 3 * k;
      sc += Math.abs(a[m] * r[rk] + a[m + 1] * r[rk + 1] + a[m + 2] * r[rk + 2]);
    }
    if (sc > best) { best = sc; bp = q; }
  }
  for (let k = 0; k < 3; k++) {
    const m = ao + 3 * PERM3[3 * bp + k], rk = ro + 3 * k;
    const sg = (a[m] * r[rk] + a[m + 1] * r[rk + 1] + a[m + 2] * r[rk + 2]) < 0 ? -1 : 1;
    out[oo + 3 * k] = sg * a[m]; out[oo + 3 * k + 1] = sg * a[m + 1]; out[oo + 3 * k + 2] = sg * a[m + 2];
  }
  return best;
}

/** Determinant of three rows at a[o..o+8]. */
function det3(a, o) {
  return a[o] * (a[o + 4] * a[o + 8] - a[o + 5] * a[o + 7])
    - a[o + 1] * (a[o + 3] * a[o + 8] - a[o + 5] * a[o + 6])
    + a[o + 2] * (a[o + 3] * a[o + 7] - a[o + 4] * a[o + 6]);
}

/**
 * Mean orientation of a set of CN4/CN6 polyhedra as an orthonormal,
 * right-handed frame (three rows into out[outOffset..+8]). Members that are
 * not tetrahedra / octahedra in shape (polyhedronAxes false) are left out.
 *
 * Seeded with `seed` (three rows, e.g. last frame's result, which keeps the
 * axis order stable from frame to frame) or else the first member's own
 * axes; every member's axes are assigned to the seed axes by nearest
 * direction (matchAxes) and summed; the sum is orthonormalised by polar
 * decomposition — the rotation nearest to it, Horn's quaternion fit with
 * the identity as the ideal (hornRotation) — so no axis is privileged, as
 * Gram–Schmidt would privilege the first.
 * @param {PolyhedraTable} t
 * @param {ArrayLike<number>} rows polyhedron indices
 * @param {number} start first entry of `rows` to use
 * @param {number} count entries to use
 * @param {ArrayLike<number> | null} seed three rows, or null
 * @param {Float64Array | Float32Array} out
 * @param {number} [outOffset=0]
 * @returns {number} members used (0: no frame written)
 */
export function meanOrientationFrame(t, rows, start, count, seed, out, outOffset = 0) {
  let have = false;
  if (seed && Number.isFinite(seed[0])) {
    for (let k = 0; k < 9; k++) SEED[k] = seed[k];
    have = true;
  }
  SUMAX.fill(0);
  let used = 0;
  for (let r = start; r < start + count; r++) {
    if (!polyhedronAxes(t, rows[r], PAXES)) continue;
    if (!have) {
      for (let k = 0; k < 9; k++) SEED[k] = PAXES[k];
      if (det3(SEED, 0) < 0) { SEED[6] = -SEED[6]; SEED[7] = -SEED[7]; SEED[8] = -SEED[8]; }
      have = true;
    }
    matchAxes(PAXES, 0, SEED, 0, AXES, 0);
    for (let k = 0; k < 9; k++) SUMAX[k] += AXES[k];
    used++;
  }
  if (!used) return 0;
  // Horn with a_k = e_k, b_k = SUMAX row k: S_xy = SUMAX[x][y]; R e_k (the
  // k-th column of R) is then the frame's axis k.
  for (let k = 0; k < 9; k++) S3[k] = SUMAX[k];
  hornRotation();
  const w = Q4[0], x = Q4[1], y = Q4[2], z = Q4[3];
  // Rotation matrix of the unit quaternion; row k of the frame = column k.
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
  const o = outOffset;
  out[o] = r00; out[o + 1] = r10; out[o + 2] = r20;
  out[o + 3] = r01; out[o + 4] = r11; out[o + 5] = r21;
  out[o + 6] = r02; out[o + 7] = r12; out[o + 8] = r22;
  return used;
}

/**
 * Reorder and re-sign a frame's three axes in place to best match a
 * reference frame (e.g. the previous MD frame's, so tiltA stays tiltA, or
 * the cell axes the first time, so the axis nearest a is called a), keeping
 * it right-handed: when the matched set comes out left-handed, the axis
 * least aligned with its reference is flipped.
 * @param {Float64Array | Float32Array} frame rows at frame[offset..+8]
 * @param {number} offset
 * @param {ArrayLike<number>} ref three reference rows
 */
export function alignFrameTo(frame, offset, ref) {
  for (let k = 0; k < 9; k++) REF[k] = ref[k];
  for (let k = 0; k < 9; k++) PAXES[k] = frame[offset + k];
  matchAxes(PAXES, 0, REF, 0, frame, offset);
  if (det3(frame, offset) < 0) {
    let worst = 0, wv = Infinity;
    for (let k = 0; k < 3; k++) {
      const o = offset + 3 * k;
      const c = Math.abs(frame[o] * REF[3 * k] + frame[o + 1] * REF[3 * k + 1] + frame[o + 2] * REF[3 * k + 2]);
      if (c < wv) { wv = c; worst = k; }
    }
    const o = offset + 3 * worst;
    frame[o] = -frame[o]; frame[o + 1] = -frame[o + 1]; frame[o + 2] = -frame[o + 2];
  }
}

/**
 * The default (cell-axes) reference frame of a lattice — â, b̂', ĉ' as in the
 * header — as three rows into `out`.
 * @param {number[][]} lattice
 * @param {Float64Array | Float32Array | number[]} out
 * @returns {boolean} false for a degenerate lattice
 */
export function cellReferenceFrame(lattice, out) {
  frameSource = null;
  if (!ensureFrame({ lattice, count: 0, vertStart: [], vertCount: [], vertXYZ: [] })) return false;
  for (let k = 0; k < 9; k++) out[k] = FRAME[k];
  frameSource = null;
  return true;
}
