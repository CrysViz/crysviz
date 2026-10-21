// Keeps the whole scene between the camera's near and far clipping planes.
//
// Two ways the scene used to be cut away, both changing with rotation and pan,
// so a field in one part of a large structure vanished at some views:
//
// - Orthographic camera (the default) inside the scene. Its distance from the
//   target does not change the picture (zoom is camera.zoom), so nothing keeps
//   it outside the structure: switching structures only re-centers it at the
//   previous structure's distance. Loading a large molecule after a small
//   cell leaves the camera inside the molecule, and everything behind the
//   camera plane (near = 0.1) is clipped.
// - Far plane too close. Both cameras are created with far = 1000; a large
//   cell, or a camera zoomed far out, puts the far side past it.
//
// updateCameraClipRange() runs before every frame against a bounding sphere of
// the scene: the cell widened to the periodic display boundary, the atoms, and
// the live isosurface (a block field can sit outside the cell). It backs an
// orthographic camera out along its view direction until the sphere is in
// front of it (invisible in an orthographic view), and pushes far past the
// sphere. 1000 stays the far floor, so small scenes keep today's depth range.

import * as THREE from '../external/three/three.module.js';
import { groups, fileBrowser, general } from '../state/store.js';
import { activePeriodicBounds } from './LatticeModule.js';
import { getElementRadius } from '../defaults/radii_defaults.js';

const DEFAULT_FAR = 1000;
// Slack for what the cell and atom centres leave out: bond and arrow ends,
// labels, outlines (Å).
const DRAWN_MARGIN = 5;
// Relative headroom so zooming does not reach the far plane between frames.
const FAR_HEADROOM = 1.1;

const _box = new THREE.Box3();
const _corner = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _meshSphere = new THREE.Sphere();
const _meshBox = new THREE.Box3();
const _viewDir = new THREE.Vector3();
const _toCenter = new THREE.Vector3();

// Atom extent (centres grown by the largest drawn radius), cached per wrapped
// atom list so large structures are scanned once, not every frame.
let _atomsKey = null;
let _atomsAtomSize = NaN;
const _atomsBox = new THREE.Box3();

/** Grow _box by the 8 corners of the fractional box `bounds` of `lattice`. */
function expandByCellBox(lattice, bounds) {
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
    const f = [bounds[0][i], bounds[1][j], bounds[2][k]];
    _corner.set(
      f[0] * lattice[0][0] + f[1] * lattice[1][0] + f[2] * lattice[2][0],
      f[0] * lattice[0][1] + f[1] * lattice[1][1] + f[2] * lattice[2][1],
      f[0] * lattice[0][2] + f[1] * lattice[1][2] + f[2] * lattice[2][2]);
    _box.expandByPoint(_corner);
  }
}

/** Grow _box by every drawn atom (periodic images included). */
function expandByAtoms(structure) {
  const wrapped = structure?.periodic?.visibleWrapped;
  if (!wrapped?.cart?.length) return;
  const atomSize = general.atomSize ?? 1;
  if (wrapped !== _atomsKey || atomSize !== _atomsAtomSize) {
    _atomsBox.makeEmpty();
    let maxRadius = 0;
    for (let i = 0; i < wrapped.cart.length; i++) {
      const p = wrapped.cart[i];
      _corner.set(p[0], p[1], p[2]);
      _atomsBox.expandByPoint(_corner);
      maxRadius = Math.max(maxRadius, getElementRadius(wrapped.elements[i]) * atomSize || 0);
    }
    _atomsBox.expandByScalar(maxRadius);
    _atomsKey = wrapped;
    _atomsAtomSize = atomSize;
  }
  _box.union(_atomsBox);
}

/** Grow _box by the world bounding sphere of every isosurface mesh (base
 *  lobes and periodic copies). Geometry spheres are cached by three.js, so
 *  this is cheap once a surface has been drawn. */
function expandByIsosurface() {
  const iso = groups.isosurfaceGroup;
  if (!iso?.parent || !iso.visible) return;
  iso.updateWorldMatrix(true, true);
  iso.traverseVisible((obj) => {
    const geometry = obj.isMesh ? obj.geometry : null;
    if (!geometry?.attributes?.position?.count) return;
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    _meshSphere.copy(geometry.boundingSphere).applyMatrix4(obj.matrixWorld);
    if (Number.isFinite(_meshSphere.radius)) _box.union(_meshSphere.getBoundingBox(_meshBox));
  });
}

/**
 * Keep the scene's bounding sphere between camera.near and camera.far: back an
 * orthographic camera out of it, and set far past it. Only touches the
 * projection when far changes.
 * @param {any} camera perspective or orthographic camera
 */
export function updateCameraClipRange(camera) {
  if (!camera) return;
  _box.makeEmpty();
  const structure = fileBrowser.selectedStructure;
  const lattice = structure?.lattice;
  if (Array.isArray(lattice) && lattice.length === 3 && lattice.every((row) => row?.length === 3)) {
    expandByCellBox(lattice, activePeriodicBounds());
  }
  expandByAtoms(structure);
  expandByIsosurface();

  let far = DEFAULT_FAR;
  if (!_box.isEmpty()) {
    _box.getBoundingSphere(_sphere);
    const radius = _sphere.radius + DRAWN_MARGIN;
    if (camera.isOrthographicCamera && Number.isFinite(radius)) {
      // Depth of the sphere centre along the view direction; the sphere's
      // front must be past the near plane.
      camera.getWorldDirection(_viewDir);
      const depth = _toCenter.subVectors(_sphere.center, camera.position).dot(_viewDir);
      const needed = radius + camera.near + 1;
      if (depth < needed) {
        camera.position.addScaledVector(_viewDir, depth - needed);
        camera.updateMatrixWorld();
      }
    }
    const reach = camera.position.distanceTo(_sphere.center) + radius;
    if (Number.isFinite(reach)) far = Math.max(DEFAULT_FAR, reach * FAR_HEADROOM);
  }
  if (camera.far !== far) {
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}
