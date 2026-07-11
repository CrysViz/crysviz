// Bottom-layer indirection between "this material renders transparent content"
// (declared by model/render modules) and HOW transparency is rendered (decided
// by the active rendering pipeline, render/pipeline/).
//
// Modules never set transparency-related material flags (transparent,
// depthWrite, renderOrder, polygonOffset, blending) themselves — they describe
// their *intent* via a spec and call applyTransparency(); the pipeline manager
// injects the active pipeline's policy as the delegate. This module sits in
// utils/ so that model/ classes (Isosurface, Plane) can use it without an
// upward import into render/.
//
// The spec is stamped on material.userData.transparencySpec (minus the
// non-serializable `mesh` reference), which makes the scene graph itself the
// registry: switching pipelines re-applies policy by traversing the scene and
// re-running the stamped specs (render/pipeline/index.js).
//
// Spec fields (see ForwardPipeline.applyTransparency for the kinds):
//   kind:               'atoms' | 'bonds' | 'compAtoms' | 'compBonds' |
//                       'polyhedraFace' | 'polyhedraEdge' | 'isosurface' |
//                       'plane' | 'planeBorder' | 'measureGhost'
//   opacity:            the uniform material opacity the module set (0..1)
//   needsTransparency:  atoms/bonds — true when the base opacity or any
//                       per-instance opacity is below 1
//   perInstanceOpacity: true for meshes whose shader reads an instanceOpacity
//                       attribute (main atoms/bonds)
//   mesh:               the mesh owning the material, when available — lets a
//                       policy set mesh-level state like renderOrder

/** @type {((material: any, spec: any) => void) | null} */
let delegate = null;

/** Called by the pipeline manager whenever the active pipeline changes. */
export function setTransparencyPolicyDelegate(fn) {
  delegate = fn;
}

/**
 * Declare a material's transparency intent and let the active pipeline apply
 * its flags. Safe to call repeatedly (opacity edits re-declare).
 * @param {any} material
 * @param {{kind: string, opacity?: number, needsTransparency?: boolean,
 *          perInstanceOpacity?: boolean, mesh?: any}} spec
 */
export function applyTransparency(material, spec) {
  if (!material) return;
  const { mesh: _mesh, ...stored } = spec ?? {};
  (material.userData ??= {}).transparencySpec = stored;
  if (delegate) {
    delegate(material, spec);
    return;
  }
  // Pre-bootstrap fallback (setActivePipeline runs in setupScene before any
  // structure/mesh exists, so this should never be hit in practice).
  console.warn('TransparencyPolicy: no pipeline delegate installed yet; using fallback flags');
  material.transparent = (spec?.opacity ?? 1) < 1;
  material.needsUpdate = true;
}
