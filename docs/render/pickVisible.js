// Picking what the user can SEE. A plain raycast returns every atom, bond and
// polyhedron under the cursor, visible or not: an atom at alpha 0, one cut
// away by a cut plane, or the centre atom hidden inside an opaque
// polyhedron was picked as readily as a visible one, and an atom anywhere
// along the ray used to beat a bond in front of it. pickScene() ranks the
// hits the way the picture does:
//   - instances at or below PICK_MIN_ALPHA, zero-scaled (hidden) instances and
//     atoms behind an active cut plane are not pickable at all;
//   - atoms and bonds compete by distance — the nearer visible one wins;
//   - a polyhedron face at PICK_OPAQUE_ALPHA or above occludes everything
//     behind it (it is picked itself); a see-through face never hides an atom
//     or bond behind it and is picked only when nothing else is hit, so the
//     corner atoms of a translucent polyhedron stay pickable through it.
// Used by the 3D view's double-click selection, the measure tools and Hide
// mode (ui/SceneInteraction.js).

import { groups } from '../state/store.js';
import { activeAtomCutPlanes } from './pipeline/raytrace/SceneEncoder.js';
import { CUT_PLANE_TOLERANCE } from './cutPlaneTolerance.js';

export const PICK_MIN_ALPHA = 0.01;     // at or below: invisible, never picked
export const PICK_OPAQUE_ALPHA = 0.999; // from here: a polyhedron face occludes

/** Effective alpha of an instanced atom/bond half (per-instance × material). */
export function instanceAlpha(mesh, i) {
  const attr = mesh?.geometry?.attributes?.instanceOpacity;
  return (attr ? attr.getX(i) : 1) * (mesh?.material?.opacity ?? 1);
}

/** Whether atom instance i is drawn: scaled, visible alpha, not cut away. */
export function isAtomInstanceVisible(mesh, i, cutPlanes = activeAtomCutPlanes()) {
  if (!mesh?.instanceMatrix) return false;
  const m = mesh.instanceMatrix.array;
  const o = i * 16;
  if (!(m[o] > 0)) return false; // zero-scaled = hidden instance
  if (instanceAlpha(mesh, i) <= PICK_MIN_ALPHA) return false;
  if (cutPlanes.length) {
    const immune = mesh.geometry.attributes.instanceCutPlaneImmune;
    if (!(immune && immune.getX(i) >= 0.5)) {
      const cx = m[o + 12], cy = m[o + 13], cz = m[o + 14];
      for (const p of cutPlanes) {
        if ((cx * p.nx + cy * p.ny + cz * p.nz - p.w) * p.sign > CUT_PLANE_TOLERANCE) return false;
      }
    }
  }
  return true;
}

/** Whether bond half instance i is drawn. */
export function isBondInstanceVisible(mesh, i) {
  if (!mesh?.instanceMatrix) return false;
  const m = mesh.instanceMatrix.array;
  const o = i * 16;
  if (m[o] === 0 && m[o + 5] === 0) return false; // culled half
  return instanceAlpha(mesh, i) > PICK_MIN_ALPHA;
}

/**
 * The visible object under a ray (see the file header).
 * @param {import('../external/three/three.module.js').Raycaster} raycaster already set from the camera
 * @param {{atoms?: boolean, bonds?: boolean, polyhedra?: boolean}} [kinds] which kinds may be picked
 * @returns {{kind: 'atom'|'bond'|'polyhedron', hit: any}|null} a polyhedron
 *   hit carries `polyIndex` (row of the polyhedra table)
 */
export function pickScene(raycaster, { atoms = true, bonds = true, polyhedra = true } = {}) {
  const cutPlanes = activeAtomCutPlanes();
  const atomsMesh = groups.atomsMesh;
  const bondsMesh = groups.bondsMesh;
  /** @type {{kind: 'atom'|'bond'|'polyhedron', hit: any}|null} */
  let first = null; // the nearest visible atom or bond
  if (atoms && atomsMesh) {
    for (const h of raycaster.intersectObject(atomsMesh)) {
      if (!isAtomInstanceVisible(atomsMesh, h.instanceId, cutPlanes)) continue;
      first = { kind: 'atom', hit: h };
      break;
    }
  }
  if (bonds && bondsMesh) {
    for (const h of raycaster.intersectObject(bondsMesh)) {
      if (!isBondInstanceVisible(bondsMesh, h.instanceId)) continue;
      if (!first || h.distance < first.hit.distance) first = { kind: 'bond', hit: h };
      break;
    }
  }
  // Polyhedron faces: all polyhedra are one mesh (render/PolyhedraMesh.js);
  // its raycast skips hidden polyhedra and returns one hit per polyhedron
  // with `polyIndex`, its row in the polyhedra table (displayed alpha there).
  // Non-recursive over the group's children: only the face mesh answers.
  const polyGroup = groups.polyhedraGroup;
  const table = polyGroup?.userData?.polyTable;
  if (polyGroup && table) {
    let nearestVisible = null;
    let nearestOpaque = null;
    for (const h of raycaster.intersectObjects(polyGroup.children, false)) {
      if (!Number.isInteger(h.polyIndex)) continue;
      const alpha = table.opacity[h.polyIndex];
      if (alpha <= PICK_MIN_ALPHA) continue;
      if (!nearestVisible) nearestVisible = h;
      if (alpha >= PICK_OPAQUE_ALPHA) { nearestOpaque = h; break; } // hits are sorted by distance
    }
    // An opaque face in front of the nearest atom/bond hides it: the
    // polyhedron (the nearest visible one along the ray) is what was clicked.
    if (nearestOpaque && (!first || nearestOpaque.distance < first.hit.distance)) {
      return polyhedra ? { kind: 'polyhedron', hit: nearestVisible } : null;
    }
    if (!first && nearestVisible) return polyhedra ? { kind: 'polyhedron', hit: nearestVisible } : null;
  }
  return first;
}
