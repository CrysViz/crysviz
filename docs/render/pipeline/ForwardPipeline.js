// The default rendering pipeline: classic single-pass forward rendering with
// alpha blending — a verbatim extraction of the app's original render path and
// per-module transparency flags. Kept pixel-identical on purpose (including
// the historical per-kind inconsistencies in depthWrite policy); alternative
// pipelines (WBOIT, depth peeling) implement the same interface with their own
// passes and material handling.
//
// Pipeline interface (duck-typed; see render/pipeline/index.js):
//   static id / static label       registry identity + dropdown text
//   render(ctx)                    draw one full frame into the default
//                                  framebuffer; ctx = {renderer, scene, camera}
//   setSize(w, h)                  resize any offscreen targets (device px)
//   dispose()                      free targets/materials on pipeline switch
//   applyTransparency(mat, spec)   apply this pipeline's flags for a declared
//                                  transparency intent (utils/TransparencyPolicy.js)
//   needsCpuTriangleSort           whether the isosurface CPU triangle sort is
//                                  needed for acceptable blending (OIT: false)

import { renderCelOutlinePass } from '../CelOutlinePass.js';

export class ForwardPipeline {
  static id = 'forward';
  static label = 'Standard (forward)';

  id = ForwardPipeline.id;
  label = ForwardPipeline.label;

  // Forward alpha blending is order-dependent; the isosurface compensates with
  // its CPU back-to-front triangle sort on camera-move end.
  needsCpuTriangleSort = true;

  /** One frame: main scene pass, then the screen-space cel outline composite
   *  (a no-op unless cel style + screen outline mode are active). Any pipeline
   *  that ends with final color in the default framebuffer can reuse the
   *  outline pass the same way. */
  render({ renderer, scene, camera }) {
    renderer.render(scene, camera);
    renderCelOutlinePass(renderer, scene, camera);
  }

  /** No offscreen targets in the forward path. */
  setSize(_width, _height) {}

  dispose() {}

  /**
   * The pre-refactor per-module transparency flags, keyed by spec.kind.
   * Behavior-preserving: each case matches what its module used to set
   * directly — do not "clean up" the inconsistencies here.
   * @param {any} material
   * @param {{kind?: string, opacity?: number, needsTransparency?: boolean, mesh?: any}} spec
   */
  applyTransparency(material, spec = {}) {
    const opacity = spec.opacity ?? material.opacity ?? 1;
    switch (spec.kind) {
      case 'atoms': {
        // Main atoms: stop writing depth as soon as anything blends.
        const needsTransparency = !!spec.needsTransparency;
        material.transparent = needsTransparency;
        material.depthWrite = !needsTransparency;
        break;
      }
      case 'bonds':
        // Main bonds: blend but always keep depth writes.
        material.transparent = !!spec.needsTransparency;
        material.depthWrite = true;
        break;
      case 'compAtoms': {
        // Comparison ghost atoms: uniform opacity only.
        const isTransparent = opacity !== 1;
        material.transparent = isTransparent;
        material.depthWrite = !isTransparent;
        break;
      }
      case 'compBonds':
        material.transparent = opacity !== 1;
        material.depthWrite = true;
        break;
      case 'polyhedraFace':
        material.transparent = true;
        material.depthWrite = false;
        material.polygonOffset = true;
        material.polygonOffsetFactor = 1;
        material.polygonOffsetUnits = 1;
        break;
      case 'polyhedraEdge':
      case 'planeBorder':
        material.transparent = true;
        break;
      case 'isosurface':
        material.transparent = opacity < 1;
        material.depthWrite = false;
        // Render after opaque structures to reduce blending artifacts.
        if (spec.mesh) spec.mesh.renderOrder = 1;
        break;
      case 'plane':
        material.transparent = true;
        material.depthWrite = false;
        material.depthTest = true;
        break;
      case 'measureGhost':
        material.transparent = true;
        material.depthWrite = false;
        break;
      default:
        console.warn('ForwardPipeline: unknown transparency kind', spec.kind);
        material.transparent = opacity < 1;
    }
    material.needsUpdate = true;
  }
}
