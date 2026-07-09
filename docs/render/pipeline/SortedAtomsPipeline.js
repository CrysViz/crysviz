// "Sorted transparent atoms" pipeline: SplitAtomsPipeline plus back-to-front
// depth sorting of the transparent atom instances, which makes
// transparent-over-transparent atom overlap order-correct too.
//
// Instead of sharing the main mesh's buffers and discarding opaque fragments,
// the overlay here is a compact InstancedMesh with PRIVATE copies of only the
// transparent instances, rewritten back-to-front relative to the camera on
// every rendered frame (render() below, before the scene pass — the pipeline
// render call is the pre-render hook, so the buffers upload in the same frame
// and PNG export is covered automatically). The main mesh's buffers are never
// permuted: instance indices are stable atom ids for picking / per-atom edits
// / selection, so the sort only touches the overlay's private copies, and
// re-copying from the live main buffers each frame keeps every write path
// (trajectory positions, colors, emissive highlights) in sync for free.
//
// Cost: O(T log T) sort + a T-instance buffer upload per rendered frame, where
// T = number of transparent atom copies. Zero when nothing is transparent
// (the overlay is hidden and the sync is skipped).

import * as THREE from '../../external/three/three.module.js';
import { groups } from '../../state/store.js';
import { SplitAtomsPipeline } from './SplitAtomsPipeline.js';

// Per-instance attributes mirrored into the overlay: geometry-level ones here,
// plus instanceMatrix / instanceColor which live on the mesh.
/** @type {Array<[string, number]>} */
const OVERLAY_INSTANCED_ATTRS = [
  ['instanceOpacity', 1],
  ['instanceCutPlaneImmune', 1],
  ['instanceEmissive', 3],
  ['instanceEmissiveIntensity', 1],
  ['instanceUUID', 4],
  ['instanceElementIndex', 1],
];

export class SortedAtomsPipeline extends SplitAtomsPipeline {
  static id = 'sorted-atoms';
  static label = 'Sorted transparent atoms';

  id = SortedAtomsPipeline.id;
  label = SortedAtomsPipeline.label;

  /** Sort the transparent instances for the current camera, then render. */
  render(ctx) {
    const mesh = groups.atomsMesh;
    const overlay = mesh?.userData.transparentOverlay;
    if (overlay?.visible) {
      // Controls move the camera between frames; make matrixWorldInverse
      // current before computing view depths (the renderer would only update
      // it after our sort).
      ctx.camera.updateMatrixWorld();
      syncTransparentOverlayInstances(mesh, overlay, ctx.camera);
    }
    super.render(ctx);
  }

  /** Compact overlay: sphere vertex data shared by reference, instance data
   *  private (the sort permutes it, so it cannot alias the main buffers). */
  _createOverlayMesh(mesh, material) {
    const capacity = mesh.count;
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(mesh.geometry.getIndex());
    geometry.setAttribute('position', mesh.geometry.attributes.position);
    geometry.setAttribute('normal', mesh.geometry.attributes.normal);
    geometry.setAttribute('uv', mesh.geometry.attributes.uv);
    for (const [name, itemSize] of OVERLAY_INSTANCED_ATTRS) {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
    }

    const overlay = new THREE.InstancedMesh(geometry, material, capacity);
    overlay.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    overlay.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    overlay.instanceColor.setUsage(THREE.DynamicDrawUsage);
    overlay.frustumCulled = false; // contents are rewritten per frame; skip stale culling
    return overlay;
  }
}

/** Rewrite the overlay's instance buffers with the transparent instances of
 *  the main atoms mesh, sorted back-to-front in view space. */
function syncTransparentOverlayInstances(mesh, overlay, camera) {
  const srcAttrs = mesh.geometry.attributes;
  const srcOpacity = srcAttrs.instanceOpacity.array;
  const srcMatrix = mesh.instanceMatrix.array;
  // View-space depth from row 3 of the inverse world matrix — valid for both
  // the perspective and the default orthographic camera.
  const e = camera.matrixWorldInverse.elements;
  /** @type {Array<[number, number]>} */
  const order = [];
  for (let i = 0; i < mesh.count; i++) {
    if (srcOpacity[i] >= 0.999) continue;
    const o = i * 16;
    const z = e[2] * srcMatrix[o + 12] + e[6] * srcMatrix[o + 13] + e[10] * srcMatrix[o + 14] + e[14];
    order.push([z, i]);
  }
  order.sort((a, b) => a[0] - b[0]); // most negative z = farthest = drawn first

  const dstAttrs = overlay.geometry.attributes;
  const srcColor = mesh.instanceColor.array;
  const dstMatrix = overlay.instanceMatrix.array;
  const dstColor = overlay.instanceColor.array;
  for (let k = 0; k < order.length; k++) {
    const i = order[k][1];
    dstMatrix.set(srcMatrix.subarray(i * 16, i * 16 + 16), k * 16);
    dstColor.set(srcColor.subarray(i * 3, i * 3 + 3), k * 3);
    for (const [name, itemSize] of OVERLAY_INSTANCED_ATTRS) {
      dstAttrs[name].array.set(
        srcAttrs[name].array.subarray(i * itemSize, i * itemSize + itemSize), k * itemSize);
    }
  }
  overlay.count = order.length;
  overlay.instanceMatrix.needsUpdate = true;
  overlay.instanceColor.needsUpdate = true;
  for (const [name] of OVERLAY_INSTANCED_ATTRS) dstAttrs[name].needsUpdate = true;
}
