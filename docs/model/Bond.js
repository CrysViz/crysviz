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
    // per-endpoint atom radius multipliers (per-atom/per-copy Size edits) so
    // the clipped bond geometry meets the atoms at their RENDERED radii
    radiusScales = [1, 1],
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
      // 0.8: the bond tip sits 20% inside the rendered atom surface so the
      // cylinder end never peeks out. The per-endpoint radiusScales keep this
      // true when atoms are resized per species/atom/copy.
      this.r1 = getAtomRadius(elements[0]) * (radiusScales?.[0] ?? 1) * 0.8;
      this.r2 = getAtomRadius(elements[1]) * (radiusScales?.[1] ?? 1) * 0.8;

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
}

// Helper outside class
function getAtomRadius(element) {
  return (atomicRadii[element] || 1.0) * general.atomSize;
}

