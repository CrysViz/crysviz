import {general} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
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
  } = {}) {
    this.elements = elements;
    const dcolor1 = elements.length > 0 ? (defaultColorMap[elements[0]] || 0x6523b0) : 0x6523b0;
    const dcolor2 = elements.length > 1 ? (defaultColorMap[elements[1]] || 0x808080) : 0x808080;
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
      this.r1 = getAtomRadius(elements[0]) * 0.8; // 0.8 scaling like before
      this.r2 = getAtomRadius(elements[1]) * 0.8;

      this.visibleLen = Math.max(this.dist - (this.r1 + this.r2), 0);
      this.halfLen = this.visibleLen * 0.5;
      this.radius = general.bondRadius;

      if (this.visibleLen > 1e-3) {
        // Scalar math instead of clone()/normalize() temporaries: this constructor runs
        // once per bond (100k+ on large structures) and each clone allocated a Vector3.
        const inv = this.dist > 1e-9 ? 1 / this.dist : 0;
        const ux = this.dir.x * inv, uy = this.dir.y * inv, uz = this.dir.z * inv;
        const a1 = this.r1 + this.halfLen / 2;
        const a2 = -this.r2 - this.halfLen / 2;
        this.center1 = new THREE.Vector3(this.p1.x + ux * a1, this.p1.y + uy * a1, this.p1.z + uz * a1);
        this.center2 = new THREE.Vector3(this.p2.x + ux * a2, this.p2.y + uy * a2, this.p2.z + uz * a2);
      } else {
        this.center1 = this.center2 = null;
      }
    } else {
      // fallback if not enough info
      this.r1 = this.r2 = this.visibleLen = this.halfLen = this.radius = null;
      this.center1 = this.center2 = null;
    }
  }

  // Fast in-place endpoint update for the render fast path (MD/relax frames).
  // Reuses the fixed per-element radii r1/r2 computed once in the constructor and
  // recomputes only the position-dependent geometry (dir, dist, visibleLen,
  // halfLen, center1/center2, positions/p1/p2/midpoint). Mirrors the constructor's
  // clipped-bond math exactly so a freshly constructed Bond at the same endpoints
  // is identical. p1/p2 are [x, y, z] cartesian arrays.
  updateEndpoints(p1, p2) {
    // radius may change between frames (bondRadius slider); r1/r2 stay fixed.
    this.radius = general.bondRadius;

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

    if (this.r1 == null || this.r2 == null) {
      this.visibleLen = this.halfLen = null;
      this.center1 = this.center2 = null;
      return this;
    }

    this.visibleLen = Math.max(this.dist - (this.r1 + this.r2), 0);
    this.halfLen = this.visibleLen * 0.5;

    if (this.visibleLen > 1e-3) {
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
    return this;
  }
}

// Helper outside class
function getAtomRadius(element) {
  return (atomicRadii[element] || 1.0) * general.atomSize;
}
