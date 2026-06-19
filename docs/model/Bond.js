import {general,fileBrowser} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {defaultColorMap, jmolColorMap} from '../defaults/color_texture_defaults.js'

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
    this.userColor=[null, null];
    //if (fileBrowser.selectedStructure.atoms){
    //  let atoms = fileBrowser.selectedStructure.atoms
    //  this.color = [atoms[this.srcIndices[0]].color,atoms[this.srcIndices[1]].color];
    //}
    //else{
    //  this.color = this.defaultColor
    //}


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
        const dirNorm = this.dir.clone().normalize();
        this.center1 = this.p1.clone().add(dirNorm.clone().multiplyScalar(this.r1 + this.halfLen / 2));
        this.center2 = this.p2.clone().add(dirNorm.clone().multiplyScalar(-this.r2 - this.halfLen / 2));
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

