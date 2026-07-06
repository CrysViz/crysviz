// Rendering-pipeline manager + registry.
//
// A "pipeline" owns how a frame is drawn (passes, offscreen targets,
// composite) and how transparency intents map to material state — see the
// interface notes in ForwardPipeline.js. The active instance lives at
// app.pipeline; frame drivers (render/AnimateModule.js main loop,
// render/ImageExportModule.js PNG export) call app.pipeline.render(ctx), and
// resize paths call app.pipeline.setSize(w, h).
//
// Switching pipelines does NOT rebuild meshes: every transparent-capable
// material carries its declared intent in material.userData.transparencySpec
// (stamped by utils/TransparencyPolicy.js), so the switch just traverses the
// scene and re-runs the new pipeline's policy over the stamped specs.
//
// New pipelines (WBOIT, depth peeling, ...) self-register here and appear in
// the ColorPanel "Rendering pipeline" dropdown via listPipelines().

import * as THREE from '../../external/three/three.module.js';
import { app, general } from '../../state/store.js';
import { setTransparencyPolicyDelegate } from '../../utils/TransparencyPolicy.js';
import { requestRender } from '../AnimateModule.js';
import { ForwardPipeline } from './ForwardPipeline.js';
import { SplitAtomsPipeline } from './SplitAtomsPipeline.js';
import { SortedAtomsPipeline } from './SortedAtomsPipeline.js';
import { WboitPipeline } from './WboitPipeline.js';
import { DepthPeelPipeline } from './DepthPeelPipeline.js';
import { RayTracingPipeline } from './RayTracingPipeline.js';

/** @type {Map<string, any>} pipeline id -> class */
const registry = new Map();

export function registerPipeline(PipelineClass) {
  registry.set(PipelineClass.id, PipelineClass);
}

/** For the GUI dropdown: [{id, label}] in registration order. */
export function listPipelines() {
  return [...registry.values()].map((P) => ({ id: P.id, label: P.label }));
}

/** The active pipeline instance (null only before setupScene bootstrap). */
export function getActivePipeline() {
  return app.pipeline ?? null;
}

/**
 * Activate a pipeline by id (unknown ids fall back to forward). Disposes the
 * previous pipeline, installs the new one as the transparency-policy delegate,
 * sizes its targets, and re-applies transparency policy across the live scene.
 */
export function setActivePipeline(id) {
  const PipelineClass = registry.get(id) ?? ForwardPipeline;
  app.pipeline?.dispose?.();
  const pipeline = new PipelineClass();
  app.pipeline = pipeline;
  general.renderPipeline = pipeline.id;
  setTransparencyPolicyDelegate((material, spec) => pipeline.applyTransparency(material, spec));
  if (app.renderer) {
    const size = app.renderer.getDrawingBufferSize(new THREE.Vector2());
    pipeline.setSize(size.x, size.y);
  }
  reapplyTransparencyToScene(pipeline);
  requestRender();
  return pipeline;
}

// The scene graph is the registry of transparency intents: re-run the new
// pipeline's policy for every material that has declared one.
function reapplyTransparencyToScene(pipeline) {
  app.scene?.traverse((obj) => {
    const materials = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const material of materials) {
      const spec = material.userData?.transparencySpec;
      if (spec) pipeline.applyTransparency(material, { ...spec, mesh: obj });
    }
  });
}

registerPipeline(ForwardPipeline);
registerPipeline(SplitAtomsPipeline);
registerPipeline(SortedAtomsPipeline);
registerPipeline(WboitPipeline);
registerPipeline(DepthPeelPipeline);
registerPipeline(RayTracingPipeline);
