// "Ray tracing (experimental)" pipeline: Whitted-style ray tracing of the
// crystal scene (atom spheres, bond/cell-edge cylinders, convex polyhedra)
// with true reflections, refractive transparency, hard shadows and
// progressive accumulation — built on the vendored
// docs/external/three-raytracing/ GLSL chunk library (CC0, Erich Loftis).
// The raster scene is NOT drawn: each frame renders a fullscreen triangle
// whose fragment shader traces the scene from data textures
// (render/pipeline/raytrace/SceneEncoder.js), accumulates into a ping-pong
// float target, and a screen pass averages + tone-maps (Reinhard — this
// pipeline intentionally has its own look).
//
// v1 scope/limits (documented in the plan + vendor README): renders atoms,
// bonds, polyhedra (<= 20 faces) and unit-cell edges only — isosurfaces,
// lattice planes, measurement overlays and comparison structures are not
// traced, and the cel outline pass is skipped. Naive per-pixel primitive loop:
// fine for typical unit cells, degrades beyond ~1-2k primitives (a BVH is the
// future upgrade). The "RT resolution" slider renders internally at a
// fraction of the canvas; "Reflectivity" adds mirror-like reflection.
//
// Driver bookkeeping (counters, camera-motion damping) is a compact
// reimplementation of the upstream demo scaffolding (InitCommon.js, not
// vendored). Notable contract details: the ray-trace triangle is rendered
// with the APP camera so three's built-in cameraPosition uniform feeds the
// vendored raytracing_main chunk; ortho frustum half-extents map to
// uULen/uVLen divided by 100 (the chunk's convention).

import * as THREE from '../../external/three/three.module.js';
import { app, general } from '../../state/store.js';
import '../../external/three-raytracing/RayTracingCommon.js'; // registers THREE.ShaderChunk['raytracing_*']
import { CommonRayTracing_Vertex } from '../../external/three-raytracing/CommonRayTracing_Vertex.js';
import { ScreenCopy_Fragment } from '../../external/three-raytracing/ScreenCopy_Fragment.js';
import { ScreenOutput_Fragment } from '../../external/three-raytracing/ScreenOutput_Fragment.js';
import { FullScreenQuad } from '../../external/three/Pass.js';
import { requestRender } from '../AnimateModule.js';
import { updateTracerProgress, hideTracerProgress } from '../TracerProgressModule.js';
import { ForwardPipeline } from './ForwardPipeline.js';
import { sceneFragment } from './raytrace/sceneFragment.js';
import { SceneEncoder } from './raytrace/SceneEncoder.js';

const RESIZE_BOOST_SAMPLES = 16; // inner samples after a size change (PNG export)

// ---- background display-transform inverse ----------------------------------
// three does NOT tone-map a plain-color scene.background (it is cleared
// display-referred: sRGB-encoded only), while the tracers tone-map everything
// they render. To make the traced backdrop match the user's picked color
// EXACTLY, primary rays that miss the scene return a pre-compensated radiance
// L such that sqrt(ACESFilmic(exposure * L)) == the raster-displayed color.
// three's ACES fit (tonemapping_pars_fragment) is closed-form invertible:
// two 3x3 matrices around a per-channel rational curve.
const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.07600, 0.90834, 0.01566],
  [0.02840, 0.13383, 0.83777],
];
const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

function invert3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
const ACES_IN_INV = invert3x3(ACES_IN);
const ACES_OUT_INV = invert3x3(ACES_OUT);
const mul3 = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/** Inverse of three's RRTAndODTFit rational curve (per channel). */
function rrtFitInverse(y) {
  const yc = Math.min(Math.max(y, 0), 0.995); // fit asymptote ~1.0165
  const a = 0.983729 * yc - 1;
  const b = 0.4329510 * yc - 0.0245786;
  const c = 0.238081 * yc + 0.000090537;
  const disc = Math.max(0, b * b - 4 * a * c);
  return (-b - Math.sqrt(disc)) / (2 * a);
}

const sRGB_OETF = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

/** Radiance whose displayed value (exposure -> ACES -> saturation -> sqrt)
 *  equals the raster-displayed background color, so the backdrop stays pinned
 *  to the user's pick regardless of the Saturation slider. bg is a
 *  linear-space THREE.Color. The luma mix is invertible for saturation >~0
 *  (clamped below; at extreme settings the inversion saturates gracefully). */
function compensateBackground(bg, exposure, saturation, out) {
  const display = [sRGB_OETF(bg.r), sRGB_OETF(bg.g), sRGB_OETF(bg.b)];
  let X = display.map((v) => v * v); // undo the output sqrt
  // undo the saturation grade (mix(luma, c, s) preserves luma)
  const sat = Math.max(saturation, 0.05);
  const luma = 0.2126 * X[0] + 0.7152 * X[1] + 0.0722 * X[2];
  X = X.map((v) => Math.max(0, luma + (v - luma) / sat));
  const v1 = mul3(ACES_OUT_INV, X).map(rrtFitInverse);
  const L = mul3(ACES_IN_INV, v1).map((v) => Math.max(0, (v * 0.6) / Math.max(exposure, 1e-4)));
  out.setRGB(L[0], L[1], L[2]);
  return out;
}

export class RayTracingPipeline extends ForwardPipeline {
  static id = 'raytrace';
  static label = 'Ray tracing (experimental)';

  id = RayTracingPipeline.id;
  label = RayTracingPipeline.label;

  needsCpuTriangleSort = false;

  _initialized = false;
  _sceneDirty = true;
  _boostSamples = 0;

  // ---- subclass hooks (PathTracingPipeline overrides these) ---------------
  /** Shader sources + uniform-name conventions + tuning for this tracer. */
  _config() {
    return {
      vertexShader: CommonRayTracing_Vertex,
      sceneFragment,
      copyFragment: ScreenCopy_Fragment,
      outputFragment: ScreenOutput_Fragment,
      copyTexUniform: 'uRayTracedImageTexture',
      outputTexUniform: 'uRayTracedImageTexture',
      previousTexUniform: 'uPreviousTexture',
      blueNoiseTexUniform: 'uBlueNoiseTexture',
      blueNoiseUrl: 'external/three-raytracing/BlueNoise_R_128.png',
      targetSamples: 64, // samples to converge to before going idle
    };
  }

  /** Additional uniforms for the scene (tracing) pass. */
  _extraSceneUniforms() { return {}; }

  /** Additional uniforms for the screen-output pass. */
  _extraOutputUniforms() { return {}; }

  /** Per-frame update hook for subclass uniforms (scene pass). */
  _updateSceneUniforms(_u) {}

  /** Per-frame update hook for subclass uniforms (output pass). */
  _updateOutputUniforms(_out) {}

  _init(renderer) {
    this._cfg = this._config();
    this._encoder = new SceneEncoder();

    const makeTarget = () => {
      const target = new THREE.WebGLRenderTarget(4, 4, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
      });
      return target;
    };
    this._accumTarget = makeTarget();   // written by the ray-trace pass
    this._previousTarget = makeTarget(); // read as uPreviousTexture

    this._blueNoise = new THREE.TextureLoader().load(
      this._cfg.blueNoiseUrl, (tex) => {
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        this.resetAccumulation();
        requestRender();
      });

    this._uniforms = {
      [this._cfg.previousTexUniform]: { value: this._previousTarget.texture },
      [this._cfg.blueNoiseTexUniform]: { value: this._blueNoise },
      uCameraMatrix: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(4, 4) },
      uRandomVec2: { value: new THREE.Vector2() },
      uEPS_intersect: { value: 0.01 },
      uTime: { value: 0 },
      uSampleCounter: { value: 0 },
      uFrameCounter: { value: 1 },
      uULen: { value: 1 },
      uVLen: { value: 1 },
      uApertureSize: { value: 0 },
      uFocusDistance: { value: 100 },
      uPreviousSampleCount: { value: 1 },
      uSceneIsDynamic: { value: false },
      uCameraIsMoving: { value: false },
      uUseOrthographicCamera: { value: false },
      uAtomsDataTexture: { value: this._encoder.atomsTexture },
      uCylindersDataTexture: { value: this._encoder.cylindersTexture },
      uPolyDataTexture: { value: this._encoder.polyTexture },
      uAtomCount: { value: 0 },
      uCylinderCount: { value: 0 },
      uPolyCount: { value: 0 },
      uLightDirection: { value: new THREE.Vector3(0, 1, 0) },
      uLightColor: { value: new THREE.Color(1, 1, 1) },
      uBackgroundColor: { value: new THREE.Color(0.9, 0.9, 0.9) },
      uReflectivity: { value: general.rtReflectivity ?? 0.15 },
      uLightSoftness: { value: general.ptLightSoftness ?? 0.3 },
      uAmbientStrength: { value: general.rtAmbient ?? 0.3 },
      uBackgroundDisplay: { value: new THREE.Color(0.9, 0.9, 0.9) }, // pre-compensated (primary miss)
      uGroundEnabled: { value: false },
      uGroundNormal: { value: new THREE.Vector3(0, 1, 0) },
      uGroundD: { value: -5 }, // plane: dot(normal, p) = d
      uGroundCenter: { value: new THREE.Vector3() }, // disc center reference
      uGroundRadius: { value: 50 }, // finite disc so the background shows as sky
      uGroundColor1: { value: new THREE.Color(0.9, 0.9, 0.9) },
      uGroundColor2: { value: new THREE.Color(0.7, 0.7, 0.7) },
      uGroundPattern: { value: 0 }, // 0 solid, 1 checker, 2 grid
      uGroundScale: { value: 2 },
      uGroundReflect: { value: 0 },
      ...this._extraSceneUniforms(),
    };

    // The ray-trace pass is rendered with the APP camera (fullscreen triangle
    // in clip space, frustum culling off) so built-in uniforms follow it.
    const material = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: this._cfg.vertexShader,
      fragmentShader: this._cfg.sceneFragment,
      depthTest: false,
      depthWrite: false,
    });
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute('position',
      new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    this._rtMesh = new THREE.Mesh(triangle, material);
    this._rtMesh.frustumCulled = false;
    this._rtScene = new THREE.Scene();
    this._rtScene.add(this._rtMesh);

    this._copyQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { [this._cfg.copyTexUniform]: { value: this._accumTarget.texture } },
      vertexShader: this._cfg.vertexShader,
      fragmentShader: this._cfg.copyFragment,
      depthTest: false,
      depthWrite: false,
    }));
    this._outputQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: {
        [this._cfg.outputTexUniform]: { value: this._accumTarget.texture },
        uOutputResolution: { value: new THREE.Vector2(4, 4) },
        uOneOverSampleCounter: { value: 1 },
        uUseToneMapping: { value: true },
        // NOTE: three's ACESFilmicToneMapping already applies the renderer's
        // toneMappingExposure (1.2) via the prelude uniform — uExposure is an
        // EXTRA multiplier on top (1.0 = renderer parity; the old 1.2 here
        // double-exposed the tracers).
        uExposure: { value: 1.0 },
        uSaturation: { value: general.rtSaturation ?? 1 },
        ...this._extraOutputUniforms(),
      },
      vertexShader: this._cfg.vertexShader,
      fragmentShader: this._cfg.outputFragment,
      depthTest: false,
      depthWrite: false,
    }));

    this._lastCameraState = null; // Float64Array(16) snapshot at the last reset
    this._lastZoom = 1;
    this._lastScale = 0;
    this._initialized = true;
  }

  resetAccumulation() {
    if (!this._uniforms) return;
    this._uniforms.uPreviousSampleCount.value = Math.max(1, this._uniforms.uSampleCounter.value);
    this._uniforms.uSampleCounter.value = 0;
    this._uniforms.uFrameCounter.value = 0;
  }

  /** Ask the next render() call to accumulate at least `samples` inner
   *  iterations before presenting (render() takes the max with its own
   *  resize boost). Used by the PNG export's render-to-completion loop. */
  requestBoost(samples) {
    this._boostSamples = Math.max(this._boostSamples, Math.max(1, Math.round(samples)));
  }

  /** True once the accumulation has reached this tracer's convergence target
   *  (the image no longer changes). The PNG export loops render() until this
   *  holds at the export size. */
  isConverged() {
    if (!this._uniforms) return false;
    return this._uniforms.uSampleCounter.value >= this._cfg.targetSamples;
  }

  render({ renderer, scene, camera }) {
    if (!this._initialized) this._init(renderer);
    const u = this._uniforms;

    // --- sizing (drawing buffer x RT resolution scale) ----------------------
    const scale = Math.min(1, Math.max(0.1, general.rtResolutionScale ?? 0.75));
    const bufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(4, Math.round(bufferSize.x * scale));
    const h = Math.max(4, Math.round(bufferSize.y * scale));
    if (w !== this._accumTarget.width || h !== this._accumTarget.height || scale !== this._lastScale) {
      this._accumTarget.setSize(w, h);
      this._previousTarget.setSize(w, h);
      u.uResolution.value.set(w, h);
      this._outputQuad.material.uniforms.uOutputResolution.value.copy(bufferSize);
      this._lastScale = scale;
      // converge within this call after a resize (a requestBoost may ask for more)
      this._boostSamples = Math.max(this._boostSamples, RESIZE_BOOST_SAMPLES);
      this.resetAccumulation();
    }
    this._outputQuad.material.uniforms.uOutputResolution.value.copy(bufferSize);

    // --- scene + camera change detection ------------------------------------
    if (this._sceneDirty || this._encoder.fingerprintChanged()) {
      this._encoder.encode();
      u.uAtomsDataTexture.value = this._encoder.atomsTexture;
      u.uCylindersDataTexture.value = this._encoder.cylindersTexture;
      u.uPolyDataTexture.value = this._encoder.polyTexture;
      u.uAtomCount.value = this._encoder.atomCount;
      u.uCylinderCount.value = this._encoder.cylinderCount;
      u.uPolyCount.value = this._encoder.polyCount;
      this._sceneDirty = false;
      this.resetAccumulation();
    }

    // Camera-motion detection with a tolerance: the damped trackball controls
    // coast down exponentially after release, drifting the matrix by
    // sub-pixel amounts for seconds — an exact comparison would keep
    // resetting the accumulation the whole time ("the bar never starts").
    // The snapshot only advances on a detected move, so slow creep still
    // accumulates against the last reset point and cannot ghost unboundedly.
    camera.updateMatrixWorld();
    const elements = camera.matrixWorld.elements;
    const zoom = camera.zoom ?? 1;
    let cameraIsMoving = !this._lastCameraState || Math.abs(zoom - this._lastZoom) > 1e-5;
    if (!cameraIsMoving) {
      for (let i = 0; i < 16; i++) {
        if (Math.abs(elements[i] - this._lastCameraState[i]) > 1e-4) { cameraIsMoving = true; break; }
      }
    }
    if (cameraIsMoving) {
      if (!this._lastCameraState) this._lastCameraState = new Float64Array(16);
      this._lastCameraState.set(elements);
      this._lastZoom = zoom;
      this.resetAccumulation();
    }

    // --- camera uniforms ----------------------------------------------------
    u.uCameraMatrix.value.copy(camera.matrixWorld);
    u.uCameraIsMoving.value = cameraIsMoving;
    if (camera.isOrthographicCamera) {
      // chunk convention: ortho half-extents are uULen/uVLen * 100
      u.uUseOrthographicCamera.value = true;
      u.uULen.value = ((camera.right - camera.left) / 2) / (camera.zoom ?? 1) / 100;
      u.uVLen.value = ((camera.top - camera.bottom) / 2) / (camera.zoom ?? 1) / 100;
    } else {
      u.uUseOrthographicCamera.value = false;
      u.uVLen.value = Math.tan((camera.fov ?? 45) * 0.5 * (Math.PI / 180));
      u.uULen.value = u.uVLen.value * (camera.aspect ?? 1);
    }

    // --- lighting / background from app state -------------------------------
    // The key light is positioned camera-relative by the animate loop; treat
    // it as a directional light pointing from the orbit target towards it.
    if (app.keyLight) {
      const target = app.controls?.target ?? this._rtScene.position;
      u.uLightDirection.value.copy(app.keyLight.position).sub(target).normalize();
      // Include the key light's actual intensity (the raster scene runs it at
      // 5.0), normalized by PI to match three's physically-based diffuse —
      // without it the traced shading is ambient-dominated and washed out.
      u.uLightColor.value.copy(app.keyLight.color)
        .multiplyScalar(((app.keyLight.intensity ?? Math.PI) / Math.PI)
          * (general.rtLightIntensity ?? 1.2));
    }
    if (scene.background?.isColor) u.uBackgroundColor.value.copy(scene.background);
    // primary-miss rays return the display-transform-inverted background so
    // the traced backdrop matches the raster clear color exactly (secondary
    // rays keep the RAW color — a bright backdrop must not become a light source)
    compensateBackground(u.uBackgroundColor.value,
      (renderer.toneMappingExposure ?? 1) * (this._outputQuad?.material.uniforms.uExposure.value ?? 1),
      general.rtSaturation ?? 1,
      u.uBackgroundDisplay.value);
    u.uReflectivity.value = general.rtReflectivity ?? 0.15;
    u.uLightSoftness.value = general.ptLightSoftness ?? 0.3;
    u.uAmbientStrength.value = general.rtAmbient ?? 0.3;
    u.uGroundEnabled.value = !!general.rtGroundPlane;
    // Ground orientation: 'structure' = world-fixed below the cell;
    // 'horizon' = perpendicular to the camera's up vector and below the
    // structure's bounding sphere, so orbiting reads as rotating the
    // structure above a fixed floor. (Reorientation coincides with camera
    // moves, which already reset the accumulation.)
    // The ground is a large finite DISC (not an infinite plane) so the
    // background stays visible as "sky" around it — essential under the
    // parallel camera, where an infinite plane can never show a horizon.
    // "Ground distance" (rtGroundOffset) applies in both modes.
    const groundOffset = general.rtGroundOffset ?? 0.75;
    const center = this._encoder.structureCenter;
    if (general.rtGroundMode === 'horizon') {
      u.uGroundNormal.value.copy(camera.up).normalize();
      u.uGroundD.value = u.uGroundNormal.value.dot(center)
        - (this._encoder.structureRadius + groundOffset);
    } else {
      u.uGroundNormal.value.set(0, 1, 0);
      u.uGroundD.value = this._encoder.minY - groundOffset;
    }
    u.uGroundCenter.value.copy(center);
    u.uGroundRadius.value = Math.max(
      (general.rtGroundSize ?? 2.5) * this._encoder.structureRadius, 5);
    // Ground colors/pattern/material: colors default to the background (and a
    // darkened variant) until customized.
    if (general.rtGroundColor1) u.uGroundColor1.value.set(general.rtGroundColor1);
    else u.uGroundColor1.value.copy(u.uBackgroundColor.value);
    if (general.rtGroundColor2) u.uGroundColor2.value.set(general.rtGroundColor2);
    else u.uGroundColor2.value.copy(u.uGroundColor1.value).multiplyScalar(0.7);
    u.uGroundPattern.value = general.rtGroundPattern === 'checker' ? 1
      : general.rtGroundPattern === 'grid' ? 2 : 0;
    u.uGroundScale.value = Math.max(0.25, general.rtGroundScale ?? 2);
    u.uGroundReflect.value = general.rtGroundReflect ?? 0;
    // Depth of field: aperture in world units; focus follows the orbit target
    // scaled by the "Focus distance" factor (1 = focus exactly on the target).
    u.uApertureSize.value = general.rtDofAperture ?? 0;
    u.uFocusDistance.value = camera.position.distanceTo(
      app.controls?.target ?? this._rtScene.position) * (general.rtDofFocus ?? 1);
    this._updateSceneUniforms(u);

    // Any "look" change (background color, lighting knobs, DoF, ground …)
    // must restart the accumulation — otherwise a converged, idle image
    // keeps averaging in the OLD look (e.g. a background-color change was
    // invisible once converged).
    const lookKey = `${u.uBackgroundColor.value.getHex()}|${u.uLightColor.value.getHex()}`
      + `|${u.uReflectivity.value}|${u.uLightSoftness.value}|${u.uAmbientStrength.value}`
      + `|${general.rtSaturation ?? 1}`
      + `|${u.uGroundEnabled.value}|${u.uApertureSize.value}|${(general.rtDofFocus ?? 1)}`
      + `|${general.rtGroundMode}|${u.uGroundPattern.value}|${u.uGroundColor1.value.getHex()}`
      + `|${u.uGroundColor2.value.getHex()}|${u.uGroundScale.value}|${u.uGroundReflect.value}`
      + `|${general.rtGroundOffset ?? 0.75}|${general.rtGroundSize ?? 2.5}`;
    if (this._lastLookKey !== undefined && lookKey !== this._lastLookKey) this.resetAccumulation();
    this._lastLookKey = lookKey;

    // --- accumulate one (or, after a resize, several) samples ---------------
    const samplesThisCall = Math.max(1, this._boostSamples);
    this._boostSamples = 0;
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    for (let s = 0; s < samplesThisCall; s++) {
      u.uSampleCounter.value += 1;
      u.uFrameCounter.value += 1;
      u.uTime.value += 1 / 60;
      u.uRandomVec2.value.set(Math.random(), Math.random());
      u[this._cfg.previousTexUniform].value = this._previousTarget.texture;

      renderer.setRenderTarget(this._accumTarget);
      renderer.render(this._rtScene, camera);

      // ping-pong copy: accumulated image -> previous
      this._copyQuad.material.uniforms[this._cfg.copyTexUniform].value = this._accumTarget.texture;
      renderer.setRenderTarget(this._previousTarget);
      this._copyQuad.render(renderer);

      u.uCameraIsMoving.value = false; // only the first sample of a burst blurs
    }

    // --- averaged, tone-mapped output to the canvas -------------------------
    const out = this._outputQuad.material.uniforms;
    out[this._cfg.outputTexUniform].value = this._accumTarget.texture;
    out.uOneOverSampleCounter.value = 1 / Math.max(1, u.uSampleCounter.value);
    out.uSaturation.value = general.rtSaturation ?? 1; // output-pass grade: no reset needed
    this._updateOutputUniforms(out);
    renderer.setRenderTarget(null);
    this._outputQuad.render(renderer);
    renderer.autoClear = oldAutoClear;

    // --- progressive refinement under render-on-demand ----------------------
    updateTracerProgress(u.uSampleCounter.value, this._cfg.targetSamples);
    if (u.uSampleCounter.value < this._cfg.targetSamples) requestRender();
  }

  setSize(_width, _height) {
    // sizes are derived from the drawing buffer inside render()
  }

  applyTransparency(material, spec = {}) {
    super.applyTransparency(material, spec); // harmless: raster scene not drawn
    this._sceneDirty = true;
  }

  dispose() {
    hideTracerProgress();
    if (!this._initialized) return;
    this._accumTarget.dispose();
    this._previousTarget.dispose();
    this._encoder.dispose();
    this._blueNoise.dispose();
    this._rtMesh.geometry.dispose();
    this._rtMesh.material.dispose();
    this._copyQuad.material.dispose();
    this._copyQuad.dispose();
    this._outputQuad.material.dispose();
    this._outputQuad.dispose();
    this._initialized = false;
  }
}
