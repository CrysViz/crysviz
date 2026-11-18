import {general} from '../state/store.js';
import {getElementRadius} from '../defaults/radii_defaults.js'
import {defaultColorMap} from '../defaults/color_texture_defaults.js'

import * as THREE from '../external/three/three.module.js';

// A bond's numbers — endpoints, direction, the two half-cylinder centres,
// length, clipping and end-atom radii, radius, cutoff — live in shared
// Float64Array chunks (STRIDE slots per bond, CHUNK bonds per array) behind the
// getters and setters below, not as object fields. V8 boxes every double-valued field in its own
// heap object, so the 24 numbers of a bond were 24 allocations; at 10^5 bonds
// a rebuild spent most of its time collecting them. A chunk lives as long as
// any of its bonds.
const STRIDE = 24;
const CHUNK = 4096;
const EX1 = 0, EY1 = 1, EZ1 = 2, EX2 = 3, EY2 = 4, EZ2 = 5;
const DX = 6, DY = 7, DZ = 8;
const C1X = 9, C1Y = 10, C1Z = 11, C2X = 12, C2Y = 13, C2Z = 14;
const DIST = 15, R1 = 16, R2 = 17, RADIUS = 18, VLEN = 19, HLEN = 20, CUTSQ = 21;
const AR1 = 22, AR2 = 23; // rendered radii of the two end atoms
/** Slot offsets of a bond's record (render/bondMatrix.js reads it in place:
 *  numbers passed as arguments are boxed when the callee is not inlined). */
export const BOND_RECORD = Object.freeze({ STRIDE, DX, DY, DZ, C1X, C1Y, C1Z, C2X, C2Y, C2Z, RADIUS, HLEN });
let chunk = new Float64Array(0);
let chunkUsed = CHUNK;

// null is stored as NaN (dist/r1/r2/atomR1/atomR2/radius/visibleLen/halfLen
// are null when the bond has no endpoints or elements).
const nullable = (v) => (v === v ? v : null);
const orNaN = (v) => (v == null ? NaN : v);

/**
 * Default colours of a bond between two elements (custom colour map, then the
 * element defaults).
 * @param {string} [e1] @param {string} [e2]
 * @returns {any[]}
 */
export function bondDefaultColor(e1, e2) {
  const dcolor1 = e1 !== undefined ? (general.customColorMap?.[e1] ?? defaultColorMap[e1] ?? 0x6523b0) : 0x6523b0;
  const dcolor2 = e2 !== undefined ? (general.customColorMap?.[e2] ?? defaultColorMap[e2] ?? 0x808080) : 0x808080;
  return [dcolor1, dcolor2];
}

export class Bond {
  constructor({
    elements = [],
    positions = [],
    // Alternative to `positions`: the two endpoints as one flat
    // [x1, y1, z1, x2, y2, z2] (read here, not kept).
    coords = null,
    defaultColors = [],
    // The pair's default colours, when the caller shares one array between
    // the bonds of an element pair (bondDefaultColor); computed otherwise.
    defaultColor = null,
    color = [],
    userColor=[],
    uuid = null,
    // Alternative to `uuid`: built on first read as uuidPrefix + uuidIndex in
    // base 36 (nothing reads a rebuilt bond's id on the hot path).
    uuidPrefix = null,
    uuidIndex = 0,
    indices = null,
    srcIndices=null,
    // Alternative to `indices` / `srcIndices`: the wrapped-instance and source
    // atom indices of the two ends as numbers; the arrays are built on first
    // read (see indexA..srcB for reading them without).
    indexA = -1,
    indexB = -1,
    srcA = -1,
    srcB = -1,
    // per-endpoint atom radius multipliers (per-atom/per-copy Size edits) so
    // the clipped bond geometry meets the atoms at their RENDERED radii
    // (read here, not kept)
    radiusScales = [1, 1],
  } = {}) {
    void defaultColors;
    if (chunkUsed === CHUNK) {
      chunk = new Float64Array(CHUNK * STRIDE);
      chunkUsed = 0;
    }
    /** @private */ this._g = chunk;
    /** @private */ this._o = chunkUsed * STRIDE;
    chunkUsed += 1;

    this.elements = elements;
    this.defaultColor = defaultColor ?? bondDefaultColor(elements[0], elements[1]);
    /** @private */ this._indices = indices ?? undefined;
    /** @private */ this._ia = indices ? indices[0] : indexA;
    /** @private */ this._ib = indices ? indices[1] : indexB;
    /** @private */ this._srcIndices = srcIndices ?? undefined;
    /** @private */ this._sa = srcIndices ? srcIndices[0] : srcA;
    /** @private */ this._sb = srcIndices ? srcIndices[1] : srcB;
    /** @private */ this._uuid = uuid;
    /** @private */ this._uuidPrefix = uuidPrefix;
    /** @private */ this._uuidIndex = uuidIndex;
    this.color=color;
    this.userColor = (Array.isArray(userColor) && userColor.length === 2) ? userColor : [null, null];
    // Instance slot of the first half in the bonds mesh (renderBonds); -1 = not drawn.
    this.renderIndex = -1;
    /** @private */ this._instanceIds = undefined;
    // Element-pair max bond cutoff squared (cutoffSq, below): assigned by
    // buildBondObjects so the fast frame path can hide a bond that stretches
    // past breaking. 0 = unknown.

    // The THREE.Vector3 / array views of the geometry — p1, p2, midpoint, dir,
    // center1, center2, positions — are built on first read and kept in step
    // by updateEndpoints; almost nothing reads them.
    /** @type {any} cached views (see the getters) */
    this._views = null;
    this._rawPositions = positions;
    this.hasEndpoints = false;
    this.hasCenters = false;

    if (coords && coords.length === 6) {
      this._setEndpoints(coords[0], coords[1], coords[2], coords[3], coords[4], coords[5]);
    } else if (positions.length === 2) {
      const [a, b] = positions;
      this._setEndpoints(a[0], a[1], a[2], b[0], b[1], b[2]);
      // The caller's arrays are this bond's `positions` (as before).
      this._ensureViews().positions = positions;
    } else {
      this._g[this._o + DIST] = NaN;
    }

    // Compute clipped bond geometry
    if (elements.length >= 2 && this.hasEndpoints) {
      // Rendered radii of the two end atoms. The per-endpoint radiusScales keep
      // the clip exact when atoms are resized per species/atom/copy.
      this._g[this._o + AR1] = getAtomRadius(elements[0]) * (radiusScales?.[0] ?? 1);
      this._g[this._o + AR2] = getAtomRadius(elements[1]) * (radiusScales?.[1] ?? 1);
      this._g[this._o + RADIUS] = orNaN(general.bondRadius);
      this._clip();
    } else {
      // fallback if not enough info
      const g = this._g, o = this._o;
      g[o + AR1] = g[o + AR2] = NaN;
      g[o + R1] = g[o + R2] = g[o + VLEN] = g[o + HLEN] = g[o + RADIUS] = NaN;
    }
  }

  // Change the cylinder radius. The clip depends on it (a wider bond meets the
  // sphere further from the atom centre line), so the clipped geometry is
  // recomputed; callers repaint the instance from halfLen/center1/center2.
  setRadius(radius) {
    this.radius = radius;
    if (this.atomR1 != null && this.atomR2 != null && this.hasEndpoints) {
      this._clip();
      this._refreshViews();
    }
    return this;
  }

  get ex1() { return this._g[this._o + EX1]; }
  set ex1(v) { this._g[this._o + EX1] = v; }
  get ey1() { return this._g[this._o + EY1]; }
  set ey1(v) { this._g[this._o + EY1] = v; }
  get ez1() { return this._g[this._o + EZ1]; }
  set ez1(v) { this._g[this._o + EZ1] = v; }
  get ex2() { return this._g[this._o + EX2]; }
  set ex2(v) { this._g[this._o + EX2] = v; }
  get ey2() { return this._g[this._o + EY2]; }
  set ey2(v) { this._g[this._o + EY2] = v; }
  get ez2() { return this._g[this._o + EZ2]; }
  set ez2(v) { this._g[this._o + EZ2] = v; }
  /** p2 - p1 */
  get dx() { return this._g[this._o + DX]; }
  set dx(v) { this._g[this._o + DX] = v; }
  get dy() { return this._g[this._o + DY]; }
  set dy(v) { this._g[this._o + DY] = v; }
  get dz() { return this._g[this._o + DZ]; }
  set dz(v) { this._g[this._o + DZ] = v; }
  /** half-cylinder centres (valid when hasCenters) */
  get c1x() { return this._g[this._o + C1X]; }
  set c1x(v) { this._g[this._o + C1X] = v; }
  get c1y() { return this._g[this._o + C1Y]; }
  set c1y(v) { this._g[this._o + C1Y] = v; }
  get c1z() { return this._g[this._o + C1Z]; }
  set c1z(v) { this._g[this._o + C1Z] = v; }
  get c2x() { return this._g[this._o + C2X]; }
  set c2x(v) { this._g[this._o + C2X] = v; }
  get c2y() { return this._g[this._o + C2Y]; }
  set c2y(v) { this._g[this._o + C2Y] = v; }
  get c2z() { return this._g[this._o + C2Z]; }
  set c2z(v) { this._g[this._o + C2Z] = v; }
  /** @returns {number|null} */
  get dist() { return nullable(this._g[this._o + DIST]); }
  set dist(v) { this._g[this._o + DIST] = orNaN(v); }
  /** @returns {number|null} clipping radius at the first atom */
  get r1() { return nullable(this._g[this._o + R1]); }
  set r1(v) { this._g[this._o + R1] = orNaN(v); }
  /** @returns {number|null} clipping radius at the second atom */
  get r2() { return nullable(this._g[this._o + R2]); }
  set r2(v) { this._g[this._o + R2] = orNaN(v); }
  /** @returns {number|null} rendered radius of the first end atom */
  get atomR1() { return nullable(this._g[this._o + AR1]); }
  set atomR1(v) { this._g[this._o + AR1] = orNaN(v); }
  /** @returns {number|null} rendered radius of the second end atom */
  get atomR2() { return nullable(this._g[this._o + AR2]); }
  set atomR2(v) { this._g[this._o + AR2] = orNaN(v); }
  /** @returns {number|null} cylinder radius */
  get radius() { return nullable(this._g[this._o + RADIUS]); }
  set radius(v) { this._g[this._o + RADIUS] = orNaN(v); }
  /** @returns {number|null} drawn length between the clipped ends */
  get visibleLen() { return nullable(this._g[this._o + VLEN]); }
  set visibleLen(v) { this._g[this._o + VLEN] = orNaN(v); }
  /** @returns {number|null} */
  get halfLen() { return nullable(this._g[this._o + HLEN]); }
  set halfLen(v) { this._g[this._o + HLEN] = orNaN(v); }
  get cutoffSq() { return this._g[this._o + CUTSQ]; }
  set cutoffSq(v) { this._g[this._o + CUTSQ] = v; }

  /** @returns {number[]|null} wrapped-instance indices of the two ends */
  get indices() {
    if (this._indices === undefined) this._indices = this._ia >= 0 ? [this._ia, this._ib] : null;
    return this._indices;
  }
  set indices(v) {
    this._indices = v;
    this._ia = v ? v[0] : -1;
    this._ib = v ? v[1] : -1;
  }
  /** @returns {number[]|null} source atom indices of the two ends */
  get srcIndices() {
    if (this._srcIndices === undefined) this._srcIndices = this._sa >= 0 ? [this._sa, this._sb] : null;
    return this._srcIndices;
  }
  set srcIndices(v) {
    this._srcIndices = v;
    this._sa = v ? v[0] : -1;
    this._sb = v ? v[1] : -1;
  }
  /** indices[0] / indices[1] / srcIndices[0] / srcIndices[1] without building the arrays */
  get indexA() { return this._indices ? this._indices[0] : this._ia; }
  get indexB() { return this._indices ? this._indices[1] : this._ib; }
  get srcA() { return this._srcIndices ? this._srcIndices[0] : this._sa; }
  get srcB() { return this._srcIndices ? this._srcIndices[1] : this._sb; }

  /** @returns {string|null} */
  get uuid() {
    if (this._uuid == null && this._uuidPrefix != null) this._uuid = this._uuidPrefix + this._uuidIndex.toString(36);
    return this._uuid;
  }
  set uuid(v) { this._uuid = v; this._uuidPrefix = null; }

  /** @returns {number[]|undefined} the two half-cylinder instance ids in the bonds mesh */
  get instanceIds() {
    if (this._instanceIds === undefined && this.renderIndex >= 0) {
      this._instanceIds = [this.renderIndex * 2, this.renderIndex * 2 + 1];
    }
    return this._instanceIds;
  }
  set instanceIds(v) { this._instanceIds = v; }

  /** The Float64Array holding this bond's numbers. @returns {Float64Array} */
  get recordArray() { return this._g; }
  /** Offset of this bond's record in recordArray (BOND_RECORD layout). */
  get recordOffset() { return this._o; }

  /** Place this bond at instance slots 2i, 2i+1 of the bonds mesh. @param {number} i */
  setRenderIndex(i) {
    this.renderIndex = i;
    this._instanceIds = undefined;
  }

  /** @private */
  _ensureViews() {
    if (!this._views) this._views = {};
    return this._views;
  }

  /** @private Endpoints, direction, distance. */
  _setEndpoints(x1, y1, z1, x2, y2, z2) {
    const g = this._g, o = this._o;
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    g[o + EX1] = x1; g[o + EY1] = y1; g[o + EZ1] = z1;
    g[o + EX2] = x2; g[o + EY2] = y2; g[o + EZ2] = z2;
    g[o + DX] = dx; g[o + DY] = dy; g[o + DZ] = dz;
    g[o + DIST] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.hasEndpoints = true;
  }

  /** @private The clipped geometry from the endpoints, the end-atom radii and
   *  the bond radius: r1/r2 (tip offsets from the atom centres), visibleLen,
   *  halfLen and the two half-cylinder centres. Shared by the constructor,
   *  updateEndpoints and setRadius so all three always agree. */
  _clip() {
    const g = this._g, o = this._o;
    const r1 = bondClipOffset(g[o + AR1], g[o + RADIUS]);
    const r2 = bondClipOffset(g[o + AR2], g[o + RADIUS]);
    g[o + R1] = r1;
    g[o + R2] = r2;
    const dist = g[o + DIST];
    const visibleLen = Math.max(dist - (r1 + r2), 0);
    const halfLen = visibleLen * 0.5;
    g[o + VLEN] = visibleLen;
    g[o + HLEN] = halfLen;
    if (visibleLen > 1e-3) {
      const inv = dist > 1e-9 ? 1 / dist : 0;
      const ux = g[o + DX] * inv, uy = g[o + DY] * inv, uz = g[o + DZ] * inv;
      const a1 = r1 + halfLen / 2;
      const a2 = -r2 - halfLen / 2;
      g[o + C1X] = g[o + EX1] + ux * a1; g[o + C1Y] = g[o + EY1] + uy * a1; g[o + C1Z] = g[o + EZ1] + uz * a1;
      g[o + C2X] = g[o + EX2] + ux * a2; g[o + C2Y] = g[o + EY2] + uy * a2; g[o + C2Z] = g[o + EZ2] + uz * a2;
      this.hasCenters = true;
    } else {
      this.hasCenters = false;
    }
  }

  /** @private Bring the views that exist up to date with the numbers. */
  _refreshViews() {
    const v = this._views;
    if (!v) return;
    if (v.p1) v.p1.set(this.ex1, this.ey1, this.ez1);
    if (v.p2) v.p2.set(this.ex2, this.ey2, this.ez2);
    if (v.midpoint) v.midpoint.set((this.ex1 + this.ex2) * 0.5, (this.ey1 + this.ey2) * 0.5, (this.ez1 + this.ez2) * 0.5);
    if (v.dir) v.dir.set(this.dx, this.dy, this.dz);
    if (v.center1) v.center1.set(this.c1x, this.c1y, this.c1z);
    if (v.center2) v.center2.set(this.c2x, this.c2y, this.c2z);
    if (v.positions && v.positions.length === 2) {
      const [a, b] = v.positions;
      a[0] = this.ex1; a[1] = this.ey1; a[2] = this.ez1;
      b[0] = this.ex2; b[1] = this.ey2; b[2] = this.ez2;
    }
  }

  /** @returns {THREE.Vector3 | null} */
  get p1() {
    if (!this.hasEndpoints) return null;
    const v = this._ensureViews();
    return v.p1 ??= new THREE.Vector3(this.ex1, this.ey1, this.ez1);
  }

  /** @returns {THREE.Vector3 | null} */
  get p2() {
    if (!this.hasEndpoints) return null;
    const v = this._ensureViews();
    return v.p2 ??= new THREE.Vector3(this.ex2, this.ey2, this.ez2);
  }

  /** @returns {THREE.Vector3 | null} */
  get midpoint() {
    if (!this.hasEndpoints) return null;
    const v = this._ensureViews();
    return v.midpoint ??= new THREE.Vector3((this.ex1 + this.ex2) * 0.5, (this.ey1 + this.ey2) * 0.5, (this.ez1 + this.ez2) * 0.5);
  }

  /** @returns {THREE.Vector3 | null} p2 - p1 (not normalized) */
  get dir() {
    if (!this.hasEndpoints) return null;
    const v = this._ensureViews();
    return v.dir ??= new THREE.Vector3(this.dx, this.dy, this.dz);
  }

  /** @returns {THREE.Vector3 | null} first half-cylinder centre; null when the bond is too short to draw */
  get center1() {
    if (!this.hasCenters) return null;
    const v = this._ensureViews();
    return v.center1 ??= new THREE.Vector3(this.c1x, this.c1y, this.c1z);
  }

  /** @returns {THREE.Vector3 | null} second half-cylinder centre */
  get center2() {
    if (!this.hasCenters) return null;
    const v = this._ensureViews();
    return v.center2 ??= new THREE.Vector3(this.c2x, this.c2y, this.c2z);
  }

  /** @returns {number[][]} the two endpoints as [x, y, z] arrays */
  get positions() {
    if (!this.hasEndpoints) return this._rawPositions;
    const v = this._ensureViews();
    return v.positions ??= [[this.ex1, this.ey1, this.ez1], [this.ex2, this.ey2, this.ez2]];
  }

  // Fast in-place endpoint update for the render fast path (MD/relax frames).
  // Reuses the fixed end-atom radii computed once in the constructor and the
  // bond's CURRENT radius (so per-pair/per-bond size scales survive playback),
  // and recomputes only the position-dependent geometry (dir, dist, visibleLen,
  // halfLen, centres, positions/p1/p2/midpoint). Shares _clip with the
  // constructor so a freshly constructed Bond at the same endpoints and radius
  // is identical. p1/p2 are [x, y, z] cartesian arrays.
  updateEndpoints(p1, p2) {
    if (this.radius == null) this.radius = general.bondRadius;
    this._setEndpoints(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    if (this.atomR1 == null || this.atomR2 == null) {
      this.visibleLen = this.halfLen = null;
      this.hasCenters = false;
    } else {
      this._clip();
    }
    this._refreshViews();
    return this;
  }
}

// Fraction of the atom radius the bond rim is pulled INSIDE the ideal sphere.
// Atoms are drawn as 32x24-segment meshes whose facet centres sit up to ~0.7%
// of the radius inside the ideal sphere; a rim placed exactly on the ideal
// surface would leave a hairline gap there showing the open cylinder end. 1%
// covers the faceting with a small margin and is invisible at any zoom.
export const BOND_SURFACE_INSET = 0.01;

// Distance from an atom centre to the bond tip such that the cylinder RIM (not
// its centre line) lands on the atom surface. With atom radius r and bond
// radius s the rim circle lies on the sphere at sqrt(r^2 - s^2) along the
// axis, i.e. the tip extends x = r - sqrt(r^2 - s^2) past the point where the
// centre line pierces the surface. A bond at least as wide as the atom
// (s >= r) clamps to 0: it starts at the atom centre.
export function bondClipOffset(atomRadius, bondRadius) {
  const r = atomRadius * (1 - BOND_SURFACE_INSET);
  const s = bondRadius || 0;
  return Math.sqrt(Math.max(r * r - s * s, 0));
}

// Helper outside class. Uses getElementRadius (not the raw atomicRadii table)
// so a user-defined radius override (general.customAtomicRadii, set in the
// Custom User Settings panel) feeds the clipped bond geometry too — otherwise
// the atom sphere resizes (AtomsFracUpdateModule sizes it via getElementRadius)
// but the bonds keep clipping to the built-in radius, leaving a gap or overlap
// at the atom surface.
function getAtomRadius(element) {
  return getElementRadius(element) * general.atomSize;
}
