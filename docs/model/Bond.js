import {general} from '../state/store.js';
import {getElementRadius} from '../defaults/radii_defaults.js'
import {defaultColorMap} from '../defaults/color_texture_defaults.js'

import * as THREE from '../external/three/three.module.js';

export class Bond {
  constructor({
    elements = [],
    positions = [],
    defaultColors = [],
    color = [],
    userColor=[],
    uuid = null,
    indices = null,
    srcIndices=null,
    // per-endpoint atom radius multipliers (per-atom/per-copy Size edits) so
    // the clipped bond geometry meets the atoms at their RENDERED radii
    radiusScales = [1, 1],
  } = {}) {
    this.elements = elements;
    const dcolor1 = elements.length > 0 ? (general.customColorMap?.[elements[0]] ?? defaultColorMap[elements[0]] ?? 0x6523b0) : 0x6523b0;
    const dcolor2 = elements.length > 1 ? (general.customColorMap?.[elements[1]] ?? defaultColorMap[elements[1]] ?? 0x808080) : 0x808080;
    this.defaultColor = [dcolor1, dcolor2];
    this.positions = positions;
    this.indices = indices;
    this.srcIndices = srcIndices;
    this.uuid = uuid; 
    this.color=color;
    this.userColor = (Array.isArray(userColor) && userColor.length === 2) ? userColor : [null, null];
    // Element-pair max bond cutoff squared; assigned by buildBondObjects so the
    // fast frame path can hide a bond that stretches past breaking. 0 = unknown.
    this.cutoffSq = 0;

    // Compute positions, direction, distance
    if (positions.length === 2) {
      this.p1 = new THREE.Vector3().fromArray(positions[0]);
      this.p2 = new THREE.Vector3().fromArray(positions[1]);
      this.midpoint = new THREE.Vector3().addVectors(this.p1, this.p2).multiplyScalar(0.5);
      this.dir = new THREE.Vector3().subVectors(this.p2, this.p1);
      this.dist = this.dir.length();
    } else {
      this.p1 = this.p2 = this.midpoint = this.dir = null;
      this.dist = null;
    }

    // Compute clipped bond geometry
    if (elements.length >= 2 && this.dist !== null) {
      // Rendered radii of the two end atoms. The per-endpoint radiusScales keep
      // the clip exact when atoms are resized per species/atom/copy.
      this.atomR1 = getAtomRadius(elements[0]) * (radiusScales?.[0] ?? 1);
      this.atomR2 = getAtomRadius(elements[1]) * (radiusScales?.[1] ?? 1);
      this.radius = general.bondRadius;
      this._updateClip();
    } else {
      // fallback if not enough info
      this.atomR1 = this.atomR2 = null;
      this.r1 = this.r2 = this.visibleLen = this.halfLen = this.radius = null;
      this.center1 = this.center2 = null;
    }
  }

  // Change the cylinder radius. The clip depends on it (a wider bond meets the
  // sphere further from the atom centre line), so the clipped geometry is
  // recomputed; callers repaint the instance from halfLen/center1/center2.
  setRadius(radius) {
    this.radius = radius;
    if (this.atomR1 != null && this.atomR2 != null && this.dist != null) this._updateClip();
    return this;
  }

  // Clipped geometry from the current endpoints (p1/p2/dir/dist), end-atom
  // radii and bond radius: r1/r2 (tip offsets from the atom centres),
  // visibleLen, halfLen and the two half-cylinder centres. Shared by the
  // constructor, updateEndpoints and setRadius so all three always agree.
  _updateClip() {
    this.r1 = bondClipOffset(this.atomR1, this.radius);
    this.r2 = bondClipOffset(this.atomR2, this.radius);

    this.visibleLen = Math.max(this.dist - (this.r1 + this.r2), 0);
    this.halfLen = this.visibleLen * 0.5;

    if (this.visibleLen > 1e-3) {
      // Scalar math instead of clone()/normalize() temporaries: this runs once
      // per bond (100k+ on large structures) and each clone allocated a Vector3.
      const inv = this.dist > 1e-9 ? 1 / this.dist : 0;
      const ux = this.dir.x * inv, uy = this.dir.y * inv, uz = this.dir.z * inv;
      const a1 = this.r1 + this.halfLen / 2;
      const a2 = -this.r2 - this.halfLen / 2;
      if (!this.center1) this.center1 = new THREE.Vector3();
      if (!this.center2) this.center2 = new THREE.Vector3();
      this.center1.set(this.p1.x + ux * a1, this.p1.y + uy * a1, this.p1.z + uz * a1);
      this.center2.set(this.p2.x + ux * a2, this.p2.y + uy * a2, this.p2.z + uz * a2);
    } else {
      this.center1 = this.center2 = null;
    }
  }

  // Fast in-place endpoint update for the render fast path (MD/relax frames).
  // Reuses the fixed end-atom radii computed once in the constructor and the
  // bond's CURRENT radius (so per-pair/per-bond size scales survive playback),
  // and recomputes only the position-dependent geometry. Shares _updateClip
  // with the constructor so a freshly constructed Bond at the same endpoints
  // and radius is identical. p1/p2 are [x, y, z] cartesian arrays.
  updateEndpoints(p1, p2) {
    if (this.radius == null) this.radius = general.bondRadius;

    if (!this.p1) this.p1 = new THREE.Vector3();
    if (!this.p2) this.p2 = new THREE.Vector3();
    if (!this.midpoint) this.midpoint = new THREE.Vector3();
    if (!this.dir) this.dir = new THREE.Vector3();

    this.p1.set(p1[0], p1[1], p1[2]);
    this.p2.set(p2[0], p2[1], p2[2]);
    this.positions = [[p1[0], p1[1], p1[2]], [p2[0], p2[1], p2[2]]];
    this.midpoint.set((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5, (p1[2] + p2[2]) * 0.5);
    this.dir.set(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    this.dist = this.dir.length();

    if (this.atomR1 == null || this.atomR2 == null) {
      this.visibleLen = this.halfLen = null;
      this.center1 = this.center2 = null;
      return this;
    }

    this._updateClip();
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
