 import { general,atomicRadii, defaultColorMap, jmolColorMap} from '../store.js';


export class Bond {
  constructor({
    elements = [],
    positions = [],
    defaultColors = [],
    colors = [],
    uuid = null,
    indices = null,
    elem1 = null,
    elem2 = null,
    dist = null,
    dir = null,
    p1 = null,
    p2 = null,
  } = {}) {
    // Safely set default colors for the bond
    const color1 = elements.length > 0 ? (colorScheme[elements[0]] || 0x808080) : 0x808080;
    const color2 = elements.length > 1 ? (colorScheme[elements[1]] || 0x808080) : 0x808080;
    this.defaultColor = [color1, color2];
    this.positions = positions;
    this.color = this.defaultColor;
    this.indices = indices;
    this.uuid = uuid;

    // Calculate midpoint, direction, and length if positions are provided
    if (positions.length >= 2) {
      this.p1 = new THREE.Vector3().fromArray(positions[0]);
      this.p2 = new THREE.Vector3().fromArray(positions[1]);
      this.midpoint = new THREE.Vector3().addVectors(this.p1, this.p2).multiplyScalar(0.5);
      this.direction = new THREE.Vector3().subVectors(this.p2, this.p1);
      this.length = this.direction.length();
    } else {
      this.midpoint = null;
      this.direction = null;
      this.length = null;
    }

    // Calculate bond visibility and geometry properties
    if (elem1 && elem2 && dist !== null && dir && p1 && p2) {
      function getAtomRadius(element) {
        return (atomicRadii[element] || 1.0) * general.atomSize;
      }

      this.r1 = getAtomRadius(elem1) - 0.2 * getAtomRadius(elem1);
      this.r2 = getAtomRadius(elem2) - 0.2 * getAtomRadius(elem2);
      this.visibleLen = Math.max(dist - (this.r1 + this.r2), 0);
      this.halfLen = this.visibleLen * 0.5;
      this.radius = general.bondRadius;

      if (this.visibleLen > 1e-3) {
        this.center1 = p1.clone().add(dir.clone().multiplyScalar(this.r1 + this.halfLen / 2));
        this.center2 = p2.clone().add(dir.clone().multiplyScalar(-this.r2 - this.halfLen / 2));
      } else {
        this.center1 = null;
        this.center2 = null;
      }
    } else {
      this.r1 = null;
      this.r2 = null;
      this.visibleLen = null;
      this.halfLen = null;
      this.radius = null;
      this.center1 = null;
      this.center2 = null;
    }
  }
}

