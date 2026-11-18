// Which side of the structure the ground plane lies on (Visual ▸ Ground
// position, general.rtGroundDirection) — shared by the tracers' analytic disc
// (render/pipeline/RayTracingPipeline.js) and the raster disc
// (render/GroundPlaneModule.js), so both always agree.
//
//   'down'         below along the world's −y (the original, default)
//   'view-below'   below the picture: perpendicular to the camera's up vector,
//                  so the floor stays under the structure whatever the view
//                  (the key light is camera-relative too: shadows fall the
//                  same way)
//   'view-behind'  behind the structure, facing the camera: a backdrop, e.g.
//                  for a view straight down an axis
//   '±x' '±y' '±z' a fixed world side ('+y' = above, '-y' = 'down')
//   '±a' '±b' '±c' a fixed crystal side: parallel to the lattice planes
//                  spanned by the other two vectors (−c: under the ab layers)
//
// The plane always lies `rtGroundOffset` beyond the structure's lowest point
// along the normal (an atom's centre minus its radius), as it always did
// along −y.

import * as THREE from '../external/three/three.module.js';

/** [value, label] for the Visual window's select, in display order. */
export const GROUND_DIRECTIONS = Object.freeze([
  ['down', 'Below (−y)'],
  ['view-below', 'Below the view'],
  ['view-behind', 'Behind the view'],
  ['+y', 'Above (+y)'],
  ['-x', 'Side −x'],
  ['+x', 'Side +x'],
  ['-z', 'Side −z'],
  ['+z', 'Side +z'],
  ['-a', 'Under a (bc plane)'],
  ['+a', 'Over a (bc plane)'],
  ['-b', 'Under b (ca plane)'],
  ['+b', 'Over b (ca plane)'],
  ['-c', 'Under c (ab plane)'],
  ['+c', 'Over c (ab plane)'],
]);

const VALUES = new Set(GROUND_DIRECTIONS.map(([v]) => v));

/** A known direction, else the default 'down' (old sessions, bad links). */
export function cleanGroundDirection(value) {
  return VALUES.has(value) ? value : 'down';
}

/** Does this direction move with the camera (re-place on every view change)? */
export function groundFollowsView(direction) {
  return direction === 'view-below' || direction === 'view-behind';
}

const WORLD = {
  '+y': [0, -1, 0], '-x': [1, 0, 0], '+x': [-1, 0, 0], '-z': [0, 0, 1], '+z': [0, 0, -1],
};
// side -> [the two lattice vectors spanning the plane, the one it lies under]
const LATTICE = { a: [1, 2, 0], b: [2, 0, 1], c: [0, 1, 2] };

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/**
 * The ground's unit normal, pointing from the ground towards the structure
 * ("up" for that ground).
 * @param {string} direction general.rtGroundDirection
 * @param {THREE.Camera | null | undefined} camera for the view-relative ones
 * @param {number[][] | null | undefined} lattice the structure's a, b, c rows
 * @param {THREE.Vector3} [out]
 * @returns {THREE.Vector3}
 */
export function groundNormal(direction, camera, lattice, out = new THREE.Vector3()) {
  const dir = cleanGroundDirection(direction);
  if (groundFollowsView(dir) && camera?.matrixWorld) {
    // camera's up (column 1) or its backward axis, towards the viewer (column 2)
    out.setFromMatrixColumn(camera.matrixWorld, dir === 'view-below' ? 1 : 2);
    if (out.lengthSq() > 1e-12) return out.normalize();
  }
  if (WORLD[dir]) return out.fromArray(WORLD[dir]);
  const axis = dir.slice(1);
  if (LATTICE[axis] && Array.isArray(lattice) && lattice.length === 3) {
    const [i, j, k] = LATTICE[axis];
    _u.fromArray(lattice[i]);
    _v.fromArray(lattice[j]);
    _w.fromArray(lattice[k]);
    out.crossVectors(_u, _v); // normal of the plane the other two span
    const len = out.length();
    if (len > 1e-9 && Number.isFinite(len)) {
      out.divideScalar(len);
      // point it along +axis, so the ground lies on the −axis side ('-c'),
      // flipped for '+c'
      if (out.dot(_w) < 0) out.negate();
      if (dir[0] === '+') out.negate();
      return out;
    }
  }
  return out.set(0, 1, 0);
}
