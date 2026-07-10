// "Path tracing (experimental)" pipeline: Monte-Carlo path tracing with
// global illumination, soft area-light shadows and an edge-aware denoiser —
// built on the vendored docs/external/three-pathtracing/ GLSL chunk library
// (CC0, Erich Loftis; sibling of three-raytracing, same architecture). The
// entire driver (data-texture scene encoding, ping-pong accumulation, camera
// bookkeeping, progressive refinement, resolution scaling) is inherited from
// RayTracingPipeline — this subclass only swaps the shader set, the t-prefixed
// texture uniform names, the light model (one spherical area light whose
// radius is the "Light softness" slider) and the denoising output pass
// (denoiser toggled by general.ptDenoise; edge flags travel in the
// accumulation buffer's alpha channel).
//
// Same v1 scope/limits as the raytrace pipeline (see its header). Path
// tracing is stochastic: the image starts noisy and refines over many more
// samples (targetSamples 512 vs 64) — the denoiser hides most of the tail.

import * as THREE from '../../external/three/three.module.js';
import { app, general } from '../../state/store.js';
import '../../external/three-pathtracing/PathTracingCommon.js'; // registers THREE.ShaderChunk['pathtracing_*']
import { common_PathTracing_Vertex } from '../../external/three-pathtracing/common_PathTracing_Vertex.js';
import { ScreenCopy_Fragment } from '../../external/three-pathtracing/ScreenCopy_Fragment.js';
import { ScreenOutput_Fragment } from '../../external/three-pathtracing/ScreenOutput_Fragment.js';
import { RayTracingPipeline } from './RayTracingPipeline.js';
import { ptSceneFragment } from './pathtrace/ptSceneFragment.js';

export class PathTracingPipeline extends RayTracingPipeline {
  static id = 'pathtrace';
  static label = 'Path tracing (experimental)';

  id = PathTracingPipeline.id;
  label = PathTracingPipeline.label;

  _config() {
    return {
      vertexShader: common_PathTracing_Vertex,
      sceneFragment: ptSceneFragment,
      copyFragment: ScreenCopy_Fragment,
      outputFragment: ScreenOutput_Fragment,
      copyTexUniform: 'tPathTracedImageTexture',
      outputTexUniform: 'tPathTracedImageTexture',
      previousTexUniform: 'tPreviousTexture',
      blueNoiseTexUniform: 'tBlueNoiseTexture',
      blueNoiseUrl: 'external/three-pathtracing/BlueNoise_R_128.png',
      targetSamples: 512, // stochastic GI needs far more samples than Whitted
    };
  }

  _extraSceneUniforms() {
    return {
      uLightPosition: { value: new THREE.Vector3(0, 100, 0) },
      uLightRadius: { value: 10 },
      // any-hit shadow early-out gate: disabled when the scene has emissive
      // objects (they are implicit LIGHTs a light-sample ray must still reach)
      uShadowAnyHit: { value: false },
    };
  }

  _extraOutputUniforms() {
    return {
      uAccumResolution: { value: new THREE.Vector2(4, 4) },
      uUseDenoiser: { value: true },
      uPixelEdgeSharpness: { value: 1 },
      uEdgeSharpenSpeed: { value: 0.05 },
      uSceneIsDynamic: { value: false },
      uSampleCounter: { value: 0 },
      uCameraIsMoving: { value: false },
    };
  }

  _updateSceneUniforms(u) {
    // One spherical area light along the key-light direction, well outside
    // the structure; its radius (the "Light softness" slider) sets the
    // soft-shadow spread.
    const target = app.controls?.target ?? this._rtScene.position;
    const distance = Math.max(40, this._encoder.boundingRadius * 4);
    u.uLightPosition.value.copy(u.uLightDirection.value)
      .multiplyScalar(distance).add(target);
    const softness = Math.min(1, Math.max(0, general.ptLightSoftness ?? 0.3));
    u.uLightRadius.value = Math.max(0.5, softness * distance * 0.35);
    // exact any-hit shadows only when no emissive object could be masked
    u.uShadowAnyHit.value = !this._encoder.hasEmissive;
  }

  _updateOutputUniforms(out) {
    const u = this._uniforms;
    out.uAccumResolution.value.set(this._accumTarget.width, this._accumTarget.height);
    out.uUseDenoiser.value = general.ptDenoise !== false;
    out.uSampleCounter.value = u.uSampleCounter.value;
    out.uCameraIsMoving.value = u.uCameraIsMoving.value;
  }
}
