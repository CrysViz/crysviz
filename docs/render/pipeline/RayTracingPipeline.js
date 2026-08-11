// "Ray tracing (slow)" pipeline: Whitted-style ray tracing of the
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
// bonds, polyhedra (any face count — streaming convex intersector,
// raytrace/convexChunk.js), unit-cell edges, volumetric field
// isosurfaces, crystallographic lattice planes AND measurements (shell markers
// as ghost spheres + dashed distance/angle lines as thin cylinders, encoded by
// SceneEncoder; the CSS2D labels stay DOM) — comparison structures are not
// traced, and the cel outline pass is skipped. Atom/bond/polyhedron HIGHLIGHT is
// drawn as a post-present orange ghost overlay (see _renderHighlightOverlay)
// instead of the raster recolor, so selecting under a tracer never restarts the
// accumulation.
// Field isosurfaces are traced as a RAY-MARCHED implicit surface (no
// marching-cubes mesh) and honor the per-structure tracer material
// (structure.fieldMaterial) — all material types EXCEPT glass (refraction
// through the ray-marched medium is unsupported); alpha < 1 gives the usual
// stochastic see-through. Lattice planes are traced analytically and cell-clipped, either
// flat translucent grey ('None' mode, with their purple border as thin
// cylinders) or coloured from a CPU-baked field colormap atlas ('Field' mode).
// Atom cut planes ARE honored: the SceneEncoder drops whole atoms by their
// world center at encode time, matching the raster shader's per-instance
// discard (bonds/polyhedra are already CPU-filtered upstream, so they disappear
// for free). Acceleration: a whole-scene AABB early-out, per-cylinder bounding-
// sphere pre-reject, any-hit shadow traversal, and a uniform grid (exact 3D-DDA
// over atoms + cylinders, built above ~256 primitives with a brute-force
// fallback below); polyhedra/planes/field stay analytic. The "RT resolution"
// slider renders internally at a fraction of the canvas; "Reflectivity" adds
// mirror-like reflection.
//
// Driver bookkeeping (counters, camera-motion damping) is a compact
// reimplementation of the upstream demo scaffolding (InitCommon.js, not
// vendored). Notable contract details: the ray-trace triangle is rendered
// with the APP camera so three's built-in cameraPosition uniform feeds the
// vendored raytracing_main chunk; ortho frustum half-extents map to
// uULen/uVLen divided by 100 (the chunk's convention).
//
// Tiled progressive rendering (general.rtTiledRender, default on): to keep the
// shared GPU responsive on heavy scenes, each accumulation SAMPLE can be split
// into scissored screen tiles rendered one-per-animation-frame ("round-based
// tiling"). A ROUND = one sample index traced tile-by-tile across consecutive
// render() calls: bookkeeping (frame counter, seed) is frozen at round start
// and uSampleCounter advances only at round completion, so the vendored shader
// is untouched and PathTracingPipeline inherits it verbatim. The per-pixel
// accumulation blend is texel-local, so a scissored tile is bit-identical to
// the untiled sample over the same rect. The tile grid is chosen ADAPTIVELY
// from the measured frame interval (split when single tiles overrun ~2 vsyncs,
// merge back on sustained headroom). An axis is only split while the resulting
// tile dimension stays >= _minTileSizePx (64 px) at the internal resolution,
// which naturally bounds the grid (max per axis = floor(dim/64)). While the camera moves, tiling
// gives way to untiled MOTION LOW-RES (half internal resolution, upsampled by
// the target's linear filter). PRESENT-ON-ROUND-COMPLETION: the partially-tiled
// accumulation is never shown. At round completion (and after each untiled
// burst) the whole accumulation is snapshotted full-frame into a third DISPLAY
// target, and the output pass presents THAT — so the canvas only updates once
// per completed round (once per sample), with no mid-round tile seam and, for
// path tracing, a denoiser that always reads a uniform-sample-count image. Only
// the progress strip advances mid-round (fractional round count). Bypasses
// (boost / motion / toggle-off / 1x1 grid / sample 1) render full-frame; with
// the toggle OFF the present is byte-identical to the legacy accum-target path.
//
// Async shader-compile phase: the assembled scene-trace ShaderMaterial is
// thousands of GLSL lines, and its gl.linkProgram (triggered lazily by the first
// renderer.render of the trace scene) is a multi-second synchronous freeze that
// the desktop flags as a hung tab. So the first render() after activation does
// NOT trace: it PAINTS feedback (a "Compiling…" strip via TracerProgressModule +,
// when the raster preview instance exists, one fully-interactive depth-peeled
// preview frame) and then kicks renderer.compileAsync(); accumulation begins only
// once the program is ready (_shaderState pending -> compiling -> ready). ASYMMETRY:
// on Chromium/ANGLE the KHR_parallel_shader_compile extension makes compileAsync
// genuinely non-blocking (it polls COMPLETION_STATUS_KHR). On Firefox (no
// extension — also the browsertest env) the link still happens synchronously
// inside compileAsync's compile() call; the win there is that the compile is
// deferred to a macrotask AFTER the compiling frame has painted, so the user sees
// "Compiling…" (and can still orbit via the preview) rather than a frozen tab.
//
// Interactive raster preview (general.rtRasterPreview, default on): tracing
// every interactive frame is expensive, so while the user drives the view the
// pipeline renders cheap DEPTH-PEELED preview frames instead — it holds a
// private, persistent DepthPeelPipeline instance (never re-created per gesture)
// and routes its own transparency policy through it so preview frames blend
// correctly. Triggers are CAMERA MOTION, CORE scene edits (geometry/colors/
// planes/field), and RASTER-VISIBLE look edits (background color, ground-disc
// settings — continuous picker drags the raster preview CAN mirror; without
// this a background drag restarts the trace at 1 sample per tick). Tracer-only
// material/look edits (lights, reflectivity, DoF, saturation …) stay
// live-traced since the raster preview can't show them. After the scene has
// been at rest for
// general.rtPreviewRestDelay seconds (a rearming timer wakes the loop with no
// user input) the tracer resumes and accumulates. Preview frames are gated on
// ctx.interactive (set ONLY by the animate loop) so PNG export and any manual
// render() always trace. Auto-rotate keeps the preview active indefinitely
// while enabled (intended). The preview<->traced visual "pop" is the contract.

import * as THREE from '../../external/three/three.module.js';
import { app, general, mode, groups, highlightHover } from '../../state/store.js';
import '../../external/three-raytracing/RayTracingCommon.js'; // registers THREE.ShaderChunk['raytracing_*']
import { CommonRayTracing_Vertex } from '../../external/three-raytracing/CommonRayTracing_Vertex.js';
import { ScreenCopy_Fragment } from '../../external/three-raytracing/ScreenCopy_Fragment.js';
import { ScreenOutput_Fragment } from '../../external/three-raytracing/ScreenOutput_Fragment.js';
import { FullScreenQuad } from '../../external/three/Pass.js';
import { requestRender } from '../AnimateModule.js';
import { updateTracerProgress, hideTracerProgress, showTracerCompiling } from '../TracerProgressModule.js';
import { ForwardPipeline } from './ForwardPipeline.js';
import { DepthPeelPipeline } from './DepthPeelPipeline.js';
import { makeSceneFragment } from './raytrace/sceneFragment.js';
import { SceneEncoder } from './raytrace/SceneEncoder.js';
import { occupancyChunk } from './raytrace/occupancyChunk.js';

const RESIZE_BOOST_SAMPLES = 16; // inner samples after a size change (PNG export)

function sceneFragmentForOccupancy(hasOccupancy) {
  return hasOccupancy ? makeSceneFragment(occupancyChunk) : makeSceneFragment();
}

// ---- tiled progressive rendering ("gentle" mode) ---------------------------
// Bounds per-frame GPU work by rendering each accumulation SAMPLE as a series
// of scissored screen tiles, one tile per animation frame (see the round-based
// scheme in render()). Keeps the shared GPU responsive for the compositor and
// other apps while the tracer converges. Grid is chosen adaptively from the
// measured frame interval.
const TILE_PIXEL_BUDGET = 200_000; // seed grid target: pixels traced per frame
const MIN_TILE_SIZE_PX = 64;       // an axis may split only while its tile dimension stays >= this (=> max per-axis grid = floor(dim/64); ~28x16 tiles at 1080p, far finer than the old 8x8 cap, but never so fine that fixed per-tile overhead dominates)
const MOTION_RES_SCALE = 0.5;      // internal-resolution factor while the camera moves
const FRAME_OVER_MS = 40;          // tile-frame interval judged "too slow" (>=2 missed vsyncs)
const FRAME_UNDER_MS = 22;         // tile-frame interval judged to have headroom (~1 vsync)
const OVER_STREAK_SPLIT = 3;       // consecutive slow frames before splitting the grid
const UNDER_STREAK_MERGE = 120;    // consecutive fast frames (~2s) before merging back

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

/** Radiance whose displayed value (exposure -> tone map -> saturation -> sqrt)
 *  equals the raster-displayed background color, so the backdrop stays pinned
 *  to the user's pick regardless of the Saturation slider. bg is a
 *  linear-space THREE.Color. The luma mix is invertible for saturation >~0
 *  (clamped below; at extreme settings the inversion saturates gracefully).
 *  With `legacy` set the operator is three's Reinhard (see uToneMapLegacy):
 *  y = saturate(E*L / (1 + E*L)), invertible per channel as L = y / (E*(1-y)),
 *  clamped so a pure-white backdrop stays finite. */
function compensateBackground(bg, exposure, saturation, out, legacy = false) {
  const display = [sRGB_OETF(bg.r), sRGB_OETF(bg.g), sRGB_OETF(bg.b)];
  let X = display.map((v) => v * v); // undo the output sqrt
  // undo the saturation grade (mix(luma, c, s) preserves luma)
  const sat = Math.max(saturation, 0.05);
  const luma = 0.2126 * X[0] + 0.7152 * X[1] + 0.0722 * X[2];
  X = X.map((v) => Math.max(0, luma + (v - luma) / sat));
  if (legacy) {
    const E = Math.max(exposure, 1e-4);
    const L = X.map((v) => { const y = Math.min(v, 0.99); return Math.max(0, y / (E * (1 - y))); });
    out.setRGB(L[0], L[1], L[2]);
    return out;
  }
  const v1 = mul3(ACES_OUT_INV, X).map(rrtFitInverse);
  const L = mul3(ACES_IN_INV, v1).map((v) => Math.max(0, (v * 0.6) / Math.max(exposure, 1e-4)));
  out.setRGB(L[0], L[1], L[2]);
  return out;
}

export class RayTracingPipeline extends ForwardPipeline {
  static id = 'raytrace';
  static label = 'Ray tracing (slow)';

  id = RayTracingPipeline.id;
  label = RayTracingPipeline.label;

  needsCpuTriangleSort = false;

  _initialized = false;
  _sceneDirty = true;
  _shaderHasOccupancy = false;
  _boostSamples = 0;

  // ---- async shader-compile gate ------------------------------------------
  // The scene-trace ShaderMaterial is thousands of assembled GLSL lines
  // (ptSceneFragment is worst); its gl.linkProgram — triggered lazily on the
  // FIRST renderer.render(this._rtScene) one RAF after activation — is a
  // multi-second synchronous freeze. The gate defers that link off the
  // activation frame: on the first frame it PAINTS feedback (an interactive
  // preview frame + a "Compiling…" strip) and then kicks
  // renderer.compileAsync(); accumulation begins only once the program is
  // 'ready'. 'pending' -> 'compiling' (compile scheduled) -> 'ready'.
  _shaderState = 'pending';
  _compileWarned = false; // one-shot: log a compileAsync rejection at most once
  _disposed = false;      // set in dispose(): a late compile resolve must no-op
  // When true (set via beginPacedRender), render() traces at most ONE sample per
  // call regardless of any armed resize/boost — the PNG export drives the
  // accumulation one animation frame at a time (one tile/frame when tiling is
  // on, one full sample/frame when off) so the whole scene never freezes on a
  // synchronous 16-sample resize burst, and uSampleCounter advances monotonically.
  _pacedExternally = false;

  // ---- tiled progressive rendering state ----------------------------------
  _gridX = 1;             // live (adaptive) tile grid, applied at the next round start
  _gridY = 1;
  _roundGridX = 1;        // grid frozen for the in-flight round (bookkeeping is per-round)
  _roundGridY = 1;
  _tileCursor = 0;        // index of the next tile to render in the current round
  _roundActive = false;   // true while a multi-tile sample is partway rendered
  _tilePixelBudget = TILE_PIXEL_BUDGET; // instance field so tests can force a fine grid
  _minTileSizePx = MIN_TILE_SIZE_PX; // instance field (min tile dimension per axis, px) so tests can force a fine grid
  _prevTileTime = 0;      // performance.now() of the previous tiled frame (0 = none yet)
  _overStreak = 0;        // consecutive slow tile frames
  _underStreak = 0;       // consecutive fast tile frames
  _motionScaleActive = false; // whether the current target is at the motion (low-res) scale
  _lastBaseW = 0;         // last still-camera internal size (to classify motion vs real resizes)
  _lastBaseH = 0;

  // ---- interactive raster preview state -----------------------------------
  _previewPipeline = null;   // private persistent DepthPeelPipeline (preview frames), or null
  _previewActive = false;    // test-inspectable: this frame rendered a preview (not a trace)
  _lastInteractionAt = 0;    // performance.now() of the last camera/core-scene interaction
  _restTimer = null;         // rearming timer that wakes render() when the rest window elapses
  _lastRasterLook = undefined; // raster-visible look snapshot (background + ground) — a change holds the preview like camera motion

  // ---- post-present highlight overlay (lazily built in _ensureHighlightOverlay)
  _hlScene = null;
  _hlAtomsMesh = null;
  _hlBondsMesh = null;
  _hlPolyMat = null;
  _hlPolyGhosts = null;
  _hlMat = null;
  _hlScaleAtom = null;
  _hlScaleBond = null;

  constructor() {
    super();
    // Create the preview instance up front when enabled so activation's
    // reapplyTransparencyToScene() (called by setActivePipeline right after the
    // constructor) routes preview policy scene-wide from frame one. A toggle
    // flip mid-session is reconciled by _syncPreviewLifecycle() in render().
    if (general.rtRasterPreview !== false) this._previewPipeline = new DepthPeelPipeline();
  }

  // ---- subclass hooks (PathTracingPipeline overrides these) ---------------
  /** Shader sources + uniform-name conventions + tuning for this tracer. */
  _config() {
    return {
      vertexShader: CommonRayTracing_Vertex,
      sceneFragment: sceneFragmentForOccupancy,
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
    // Select the optional source before the first compile gate frame.
    this._encoder.encode();
    this._shaderHasOccupancy = this._encoder.hasOccupancy;

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
    this._displayTarget = makeTarget();  // full-frame snapshot presented while tiling

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
      uPieAxis: { value: new THREE.Vector3(0, 0, 1) },
      uPieRight: { value: new THREE.Vector3(1, 0, 0) },
      uPieUp: { value: new THREE.Vector3(0, 1, 0) },
      uAtomsDataTexture: { value: this._encoder.atomsTexture },
      uCylindersDataTexture: { value: this._encoder.cylindersTexture },
      uPolyDataTexture: { value: this._encoder.polyTexture },
      uOccupancyDataTexture: { value: this._encoder.occupancyTexture },
      uAtomCount: { value: 0 },
      uCylinderCount: { value: 0 },
      uPolyCount: { value: 0 },
      // whole-scene world AABB early-out (skips the interior primitive loops
      // when a ray misses the structure); invalid = empty scene
      uSceneMin: { value: new THREE.Vector3() },
      uSceneMax: { value: new THREE.Vector3() },
      uSceneBoundValid: { value: false },
      // uniform grid (3D-DDA accelerator over atoms + cylinders); disabled
      // below GRID_MIN_PRIMS, where the brute loops run instead
      uGridEnabled: { value: false },
      uGridMin: { value: new THREE.Vector3() },
      uGridInvCellSize: { value: new THREE.Vector3(1, 1, 1) },
      uGridDims: { value: new THREE.Vector3(1, 1, 1) }, // ivec3 in the shader
      uGridCellsTex: { value: this._encoder.gridCellsTexture },
      uGridIndexTex: { value: this._encoder.gridIndexTexture },
      // volumetric field isosurface (ray-marched implicit surface)
      uFieldEnabled: { value: false },
      uFieldTex: { value: this._encoder.fieldTexture },
      uFieldWorldToFrac: { value: new THREE.Matrix4() },
      uFieldDims: { value: new THREE.Vector3(1, 1, 1) }, // ivec3 in the shader
      uFieldIso: { value: 0 },
      uFieldAbsMode: { value: false },
      uFieldPosColor: { value: new THREE.Color(0x33aaff) },
      uFieldNegColor: { value: new THREE.Color(0xff3333) },
      uFieldAlpha: { value: 0.6 },
      uFieldMaterial: { value: new THREE.Vector4(0, 0.6, 0.6, -1) }, // = DEFAULT_MATERIAL_TEXEL
      // crystallographic lattice planes (analytic, cell-clipped)
      uPlaneCount: { value: 0 },
      uPlanesDataTexture: { value: this._encoder.planesTexture },
      uPlaneAtlasTex: { value: this._encoder.planeAtlasTexture },
      uCellWorldToFrac: { value: new THREE.Matrix4() },
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
      fragmentShader: this._cfg.sceneFragment(this._shaderHasOccupancy),
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
        // legacy Reinhard operator (the original tracer look) instead of
        // exposure x ACES; Advanced-section toggle, output-pass only
        uToneMapLegacy: { value: general.rtToneMapLegacy === true },
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
    // uPreviousSampleCount must always describe the SUM the previous target
    // holds (the shader's frame-1 blend divides by it). A second reset before
    // any new sample was taken (e.g. one out-of-render reset followed by an
    // in-render one, or two reset sites firing in the same render() call)
    // must NOT clobber it to 1 while the target still holds a multi-sample
    // sum — the old image would be replayed at ~N/2 x strength and linger as
    // a bright ghost that only decays as N/(2n).
    if (this._uniforms.uSampleCounter.value > 0) {
      this._uniforms.uPreviousSampleCount.value = this._uniforms.uSampleCounter.value;
    }
    this._uniforms.uSampleCounter.value = 0;
    this._uniforms.uFrameCounter.value = 0;
    // Abandon any in-flight tiled round: mixing a partly-updated sample into a
    // fresh accumulation would bake in a permanent 1/N brightness step. This is
    // the single funnel every reset site (and the GUI) routes through, so the
    // round state and the adaptive-timing seed always clear together.
    this._tileCursor = 0;
    this._roundActive = false;
    this._prevTileTime = 0; // idle gaps / boosts must not pollute the interval measure
    this._overStreak = 0;
    this._underStreak = 0;
  }

  /** Reset + CLEAR both accumulation targets. The plain reset intentionally
   *  blends 50% of the old image into the first new frame (anti-flicker for
   *  camera/look changes) — but when the scene CONTENT changed (re-encode:
   *  atoms edited, cut plane added, field cleared ...) the old scene must not
   *  ghost into the new image at all. uFrameCounter starts at 1 so the first
   *  new sample takes the plain-accumulation branch (the flushed target is
   *  black; the frame-1 "halve both" blend would only dim it). */
  hardResetAccumulation(renderer) {
    this.resetAccumulation();
    if (!this._uniforms) return;
    this._uniforms.uPreviousSampleCount.value = 1;
    this._uniforms.uFrameCounter.value = 1;
    const prevTarget = renderer.getRenderTarget();
    const oldColor = renderer.getClearColor(new THREE.Color());
    const oldAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    // A live tile scissor would confine renderer.clear() to the tile rect,
    // leaving the rest of the target holding a stale sum — defensively clear it.
    this._clearTileScissor();
    renderer.setRenderTarget(this._accumTarget);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(this._previousTarget);
    renderer.clear(true, false, false);
    // Also flush the display snapshot so a reset can never present a stale
    // (old-scene) frame before the first new sample is snapshotted.
    renderer.setRenderTarget(this._displayTarget);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(oldColor, oldAlpha);
  }

  /** Ask the next render() call to accumulate at least `samples` inner
   *  iterations before presenting (render() takes the max with its own
   *  resize boost). Kept for direct callers/tests; the PNG export no longer
   *  uses it (see beginPacedRender). */
  requestBoost(samples) {
    this._boostSamples = Math.max(this._boostSamples, Math.max(1, Math.round(samples)));
  }

  /** Enter externally-paced mode: render() clamps each call to a single sample
   *  (one tile when tiling is on) and ignores any armed resize/boost burst, so
   *  the PNG export can advance the accumulation one RAF at a time without a
   *  synchronous multi-sample freeze. The resize path may still SET _boostSamples;
   *  it just isn't consumed in bursts. PathTracingPipeline inherits this. */
  beginPacedRender() { this._pacedExternally = true; }

  /** Leave externally-paced mode (paired with beginPacedRender in the export's
   *  finally). Any leftover boost is cleared so a later interactive frame doesn't
   *  burst unexpectedly. */
  endPacedRender() { this._pacedExternally = false; this._boostSamples = 0; }

  /** True once the accumulation has reached this tracer's convergence target
   *  (the image no longer changes). The PNG export loops render() until this
   *  holds at the export size. */
  isConverged() {
    if (!this._uniforms) return false;
    return this._uniforms.uSampleCounter.value >= this._cfg.targetSamples;
  }

  // ---- tiled progressive rendering helpers --------------------------------
  /** Pick a near-square tile grid so each tile is under the pixel budget.
   *  Splits the axis with the larger tile dimension until every tile fits or
   *  splitting further would take a tile dimension below _minTileSizePx (so the
   *  per-axis grid is bounded by floor(dim/minTile)). Called on every (re)size. */
  _seedTileGrid(w, h) {
    let gx = 1, gy = 1;
    const budget = Math.max(1, this._tilePixelBudget);
    const minTile = Math.max(1, this._minTileSizePx);
    const maxGx = Math.max(1, Math.floor(w / minTile));
    const maxGy = Math.max(1, Math.floor(h / minTile));
    let guard = 0;
    while ((w / gx) * (h / gy) > budget
      && (gx < maxGx || gy < maxGy) && guard++ < 256) {
      if ((w / gx) >= (h / gy) && gx < maxGx) gx += 1;
      else if (gy < maxGy) gy += 1;
      else if (gx < maxGx) gx += 1;
      else break;
    }
    this._gridX = gx;
    this._gridY = gy;
    this._overStreak = 0;
    this._underStreak = 0;
  }

  /** Row-major tile rectangle with an EXACT integer cover (floor(i*w/g)) so
   *  the union of all tiles is the whole target with no gaps or overlaps. */
  _tileRect(i, gx, gy, w, h) {
    const col = i % gx;
    const row = Math.floor(i / gx);
    const x0 = Math.floor((col * w) / gx);
    const x1 = Math.floor(((col + 1) * w) / gx);
    const y0 = Math.floor((row * h) / gy);
    const y1 = Math.floor(((row + 1) * h) / gy);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /** Scissor BOTH accumulation targets to a tile rect (the trace pass writes
   *  _accumTarget, the ping-pong copy writes _previousTarget). Uses the render
   *  TARGET's own scissor (snapshotted by setRenderTarget) — renderer.setScissor
   *  only affects the default framebuffer. */
  _setTileScissor(rect) {
    this._accumTarget.scissor.set(rect.x, rect.y, rect.width, rect.height);
    this._accumTarget.scissorTest = true;
    this._previousTarget.scissor.set(rect.x, rect.y, rect.width, rect.height);
    this._previousTarget.scissorTest = true;
  }

  _clearTileScissor() {
    if (this._accumTarget) this._accumTarget.scissorTest = false;
    if (this._previousTarget) this._previousTarget.scissorTest = false;
  }

  /** Copy the full accumulation target `source` into the display snapshot (no
   *  scissor), so the presented canvas only ever shows a whole, integer-sample-
   *  count image (the source of the "update once per round" behavior). Must be
   *  called with no tile scissor active on the display target. The source is
   *  explicit because the untiled burst leaves the newest sum in
   *  _previousTarget (target swap), while the tiled round leaves it in
   *  _accumTarget. */
  _snapshotDisplay(renderer, source) {
    const prevTarget = renderer.getRenderTarget();
    this._copyQuad.material.uniforms[this._cfg.copyTexUniform].value = source.texture;
    renderer.setRenderTarget(this._displayTarget);
    this._copyQuad.render(renderer);
    renderer.setRenderTarget(prevTarget);
  }

  /** Adaptive controller: measure the interval between consecutive tiled frames
   *  and split the grid when single tiles routinely overrun a couple of vsyncs,
   *  merge it back when there is sustained headroom. Called only on tiled
   *  frames; _prevTileTime is zeroed by resetAccumulation so idle gaps and
   *  boosts never pollute the measurement. Grid changes apply at the next
   *  round start (the round freezes _roundGridX/Y). */
  _adaptTileGrid() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (this._prevTileTime > 0) {
      const dt = now - this._prevTileTime;
      if (dt > FRAME_OVER_MS) { this._overStreak += 1; this._underStreak = 0; }
      else if (dt < FRAME_UNDER_MS) { this._underStreak += 1; this._overStreak = 0; }
      else { this._overStreak = 0; this._underStreak = 0; }
      if (this._overStreak >= OVER_STREAK_SPLIT) {
        const w = this._accumTarget.width, h = this._accumTarget.height;
        const minTile = Math.max(1, this._minTileSizePx);
        const maxGx = Math.max(1, Math.floor(w / minTile));
        const maxGy = Math.max(1, Math.floor(h / minTile));
        if ((w / this._gridX) >= (h / this._gridY)) this._gridX = Math.min(maxGx, this._gridX + 1);
        else this._gridY = Math.min(maxGy, this._gridY + 1);
        this._overStreak = 0; this._underStreak = 0;
      } else if (this._underStreak >= UNDER_STREAK_MERGE) {
        if (this._gridX >= this._gridY) this._gridX = Math.max(1, this._gridX - 1);
        else this._gridY = Math.max(1, this._gridY - 1);
        this._overStreak = 0; this._underStreak = 0;
      }
    }
    this._prevTileTime = now;
  }

  /** Deterministic low-discrepancy feed for uRandomVec2 (replaces the old
   *  Math.random() pair). Returns the plastic-constant (R2) sequence pair keyed
   *  on the frame counter n: fract(0.5 + n*alpha_i) with the two R2 basis
   *  constants. uRandomVec2 is consumed ONLY by the vendored AA tent-filter
   *  jitter at samples >= 50 (both tracers), so this is statistically identical
   *  to the old white-noise pair but better stratified — and it makes renders
   *  natively deterministic (no Math.random anywhere in the trace loop). Call
   *  AFTER the frame-counter bump so consecutive samples get distinct pairs. */
  _nextRandomVec2(u) {
    const n = u.uFrameCounter.value;
    const frac = (x) => x - Math.floor(x);
    u.uRandomVec2.value.set(
      frac(0.5 + n * 0.7548776662466927),
      frac(0.5 + n * 0.5698402909980532));
  }

  // ---- interactive raster preview helpers ---------------------------------
  /** Reconcile the preview instance with the general.rtRasterPreview flag at
   *  the top of every frame: create it (and reapply policy so its staged
   *  split/overlays attach to existing materials) on enable, tear it down (and
   *  reapply the plain tracer policy) on disable. */
  _syncPreviewLifecycle() {
    const want = general.rtRasterPreview !== false;
    if (want && !this._previewPipeline) {
      this._previewPipeline = new DepthPeelPipeline();
      this.reapplyTransparencyToScene();
    } else if (!want && this._previewPipeline) {
      this._teardownPreview();
      this.reapplyTransparencyToScene();
    }
  }

  /** Dispose the preview instance (removes its scene-root overlays and resets
   *  the atoms/bonds alpha-pass split) and clear the rest timer. Inert peel
   *  patches left on other materials are harmless (the tracer never draws the
   *  raster scene). */
  _teardownPreview() {
    if (this._restTimer) { clearTimeout(this._restTimer); this._restTimer = null; }
    // _previewActive is deliberately NOT cleared here: render()'s
    // resume-from-preview check reads it to hard-flush the stale accumulation
    // (ghost prevention), including when the toggle turned off mid-gesture.
    if (this._previewPipeline) {
      this._previewPipeline.dispose();
      this._previewPipeline = null;
    }
  }

  /** Clear-and-rearm a one-shot timer that requests a render once the rest
   *  window elapses — the resume frame needs no user input (the scheduleBondRebuild
   *  idiom). A burst of interactive frames coalesces onto the latest deadline. */
  _armRestTimer(delayMs) {
    if (this._restTimer) clearTimeout(this._restTimer);
    this._restTimer = setTimeout(() => {
      this._restTimer = null;
      requestRender();
    }, Math.max(0, delayMs));
  }

  // ---- async shader-compile gate ------------------------------------------
  /** Paint one frame of compile-window feedback: the "Compiling…" strip, plus —
   *  if the interactive raster preview instance exists — a single depth-peeled
   *  preview frame (rendered regardless of ctx.interactive so the view stays
   *  fully interactive while the tracer program links). Without a preview
   *  instance the canvas is left untouched (the last composited frame persists;
   *  nothing draws over it). Never advances uSampleCounter. */
  _paintCompileFrame(ctx) {
    showTracerCompiling();
    if (this._previewPipeline) {
      const { renderer, scene, camera } = ctx;
      this._previewPipeline.render({ renderer, scene, camera });
      this._previewActive = true; // a preview frame was drawn (test-inspectable)
    }
  }

  /** Drive the compile gate for one frame (called from render() while
   *  _shaderState !== 'ready'). FIRST ('pending') frame: paint feedback NOW, then
   *  schedule renderer.compileAsync in a macrotask so its work runs AFTER this
   *  frame's paint reaches the compositor — CRITICAL on Firefox, whose WebGL has
   *  no KHR_parallel_shader_compile, so compileAsync's internal compile() still
   *  blocks synchronously; deferring it lets the "Compiling…" strip / preview
   *  paint first. With the extension (Chromium/ANGLE) the link is genuinely
   *  non-blocking and the ordering is moot. Subsequent ('compiling') frames just
   *  re-paint. Guards: a resolve after dispose() or after the state already left
   *  'compiling' (pipeline switched away, blue-noise reset raced, …) no-ops. */
  _renderCompileGate(ctx) {
    if (this._shaderState === 'pending') {
      this._shaderState = 'compiling';
      this._paintCompileFrame(ctx); // paint BEFORE the (possibly blocking) compile
      const { renderer, camera } = ctx;
      const markReady = () => {
        if (this._disposed || this._shaderState !== 'compiling') return;
        this._shaderState = 'ready';
        this.resetAccumulation();
        requestRender();
      };
      // Macrotask defer: the just-issued preview/strip GL must present before the
      // synchronous link inside compileAsync's compile() (Firefox fallback).
      setTimeout(() => {
        if (this._disposed || this._shaderState !== 'compiling') return;
        Promise.resolve(renderer.compileAsync(this._rtScene, camera))
          .then(markReady)
          .catch((e) => {
            if (!this._compileWarned) {
              this._compileWarned = true;
              console.warn('[RayTracingPipeline] compileAsync failed; '
                + 'falling back to lazy compile on the first traced frame', e);
            }
            markReady(); // still proceed: the first render() links lazily
          });
      }, 0);
      requestRender();
      return;
    }
    // 'compiling': keep the feedback alive until markReady flips to 'ready'.
    this._paintCompileFrame(ctx);
    requestRender();
  }

  render(ctx) {
    const { renderer, scene, camera } = ctx;
    if (!this._initialized) this._init(renderer);
    this._syncPreviewLifecycle();
    // Async shader-compile gate (see class header + _shaderState): keep the
    // multi-thousand-line scene-trace program's synchronous link off this
    // (activation) frame. While not 'ready' nothing is sized/encoded/accumulated
    // — uSampleCounter stays put — and the canvas shows an interactive preview
    // frame (or its last content) under a "Compiling…" strip.
    if (this._shaderState !== 'ready') { this._renderCompileGate(ctx); return; }
    const u = this._uniforms;

    // --- camera-motion detection (hoisted above sizing so motion low-res can
    //     react this same frame) --------------------------------------------
    // Tolerance-based: the damped trackball controls coast down exponentially
    // after release, drifting the matrix by sub-pixel amounts for seconds — an
    // exact comparison would keep resetting the accumulation the whole time
    // ("the bar never starts"). The snapshot only advances on a detected move,
    // so slow creep still accumulates against the last reset point and cannot
    // ghost unboundedly.
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

    // --- sticky scene-change probe (evaluate BEFORE any preview early-return)
    // fingerprintChanged() advances the stored strings, so it must run exactly
    // once per frame regardless of the preview gate — otherwise a preview frame
    // would swallow the one-shot signal and the resume frame would never
    // re-encode. The flag is STICKY: it survives preview frames (which return
    // before the encode block) and is consumed on the resume frame.
    const fpChanged = this._encoder.fingerprintChanged();
    if (fpChanged) this._sceneDirty = true;

    // --- interactive raster preview -----------------------------------------
    // While the user drives the view (camera motion OR a CORE scene edit) with
    // a tracer active, render cheap depth-peeled preview frames instead of
    // tracing; the tracer resumes once the scene has rested for the delay.
    // Tracer-only look/material edits never trigger it (they change only the
    // look part of the fingerprint). Gated on ctx.interactive so PNG export /
    // manual render() always trace.
    if (this._previewPipeline && ctx.interactive === true) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      // Look edits the raster preview CAN mirror (background color + ground
      // disc) are continuous picker drags: hold the preview like camera
      // motion instead of restarting the trace at 1 sample per drag tick.
      // Tracer-only look knobs (lights, reflectivity, DoF, saturation …)
      // deliberately stay out — they are live-traced (the lookKey reset below).
      const rasterLook = `${scene.background?.isColor ? scene.background.getHex() : -1}`
        + `|${general.rtGroundPlane === true}|${general.rtGroundPattern ?? ''}`
        + `|${general.rtGroundColor1 ?? ''}|${general.rtGroundColor2 ?? ''}`
        + `|${general.rtGroundScale ?? 1}|${general.rtGroundOffset ?? 0.75}`
        + `|${general.rtGroundSize ?? 2.5}`;
      const rasterLookChanged = this._lastRasterLook !== undefined
        && rasterLook !== this._lastRasterLook;
      this._lastRasterLook = rasterLook;
      const triggered = cameraIsMoving || rasterLookChanged
        || (fpChanged && this._encoder.lastChangeWasCoreScene);
      if (triggered) this._lastInteractionAt = now;
      // An active measurement tool is a continuous interaction: keep the raster
      // preview held (atom picking + hover glow happen on the raster scene, which
      // the tracer can't show live) for as long as a distance/angle/delete tool
      // is selected. Deselecting it lets the rest delay elapse and the tracer
      // resume — which re-encodes and shows the new measurement (Item 3).
      if (mode.measureMode !== 'none') this._lastInteractionAt = now;
      const restMs = Math.max(0, (general.rtPreviewRestDelay ?? 0.5) * 1000);
      const sinceInteraction = now - this._lastInteractionAt;
      if (this._lastInteractionAt > 0 && sinceInteraction < restMs) {
        this._previewActive = true;
        hideTracerProgress();
        this._armRestTimer(restMs - sinceInteraction + 30);
        this._previewPipeline.render({ renderer, scene, camera });
        return; // skip sizing/encode/accumulate/present — no motion-low-res coexists
      }
    }
    if (this._previewActive) {
      // Resuming from preview (rest elapsed OR toggle turned off mid-gesture):
      // the accumulation targets still hold the pre-gesture image from a
      // potentially very different camera pose, and the soft frame-1 blend
      // would replay it as a 50% ghost. Hard-flush so the tracer starts from
      // a clean slate instead.
      this.hardResetAccumulation(renderer);
      this._previewActive = false;
    }

    // --- sizing (drawing buffer x RT resolution scale) ----------------------
    // Motion low-res: while the camera moves AND tiling is enabled, render at a
    // reduced internal resolution — cheaper single samples that the output pass
    // upsamples through the target's linear filter (the same presentation path
    // the RT-resolution slider already uses). Tiling OFF => byte-identical
    // legacy sizing (userScale, no motion factor).
    const tilingEnabled = general.rtTiledRender !== false;
    const userScale = Math.min(1, Math.max(0.1, general.rtResolutionScale ?? 0.95));
    const motionActive = tilingEnabled && cameraIsMoving;
    const effScale = motionActive ? userScale * MOTION_RES_SCALE : userScale;
    const bufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    const baseW = Math.max(4, Math.round(bufferSize.x * userScale));
    const baseH = Math.max(4, Math.round(bufferSize.y * userScale));
    const w = Math.max(4, Math.round(bufferSize.x * effScale));
    const h = Math.max(4, Math.round(bufferSize.y * effScale));
    if (w !== this._accumTarget.width || h !== this._accumTarget.height || effScale !== this._lastScale) {
      // A size change whose STILL-camera size is unchanged is just the motion
      // factor toggling: the targets were reallocated (zeroed), so hard-reset (a
      // soft reset would half-brightness flash) and SKIP the resize boost — that
      // GPU hitch is exactly what motion low-res exists to avoid. A genuine
      // resize keeps today's boost + reset behavior.
      const motionToggle = this._lastBaseW !== 0
        && baseW === this._lastBaseW && baseH === this._lastBaseH;
      this._accumTarget.setSize(w, h);
      this._previousTarget.setSize(w, h);
      this._displayTarget.setSize(w, h);
      u.uResolution.value.set(w, h);
      this._outputQuad.material.uniforms.uOutputResolution.value.copy(bufferSize);
      this._lastScale = effScale;
      this._motionScaleActive = motionActive;
      this._seedTileGrid(w, h);
      if (motionToggle) {
        this.hardResetAccumulation(renderer);
      } else {
        // converge within this call after a resize (a requestBoost may ask for more)
        this._boostSamples = Math.max(this._boostSamples, RESIZE_BOOST_SAMPLES);
        this.resetAccumulation();
      }
    }
    this._lastBaseW = baseW;
    this._lastBaseH = baseH;
    this._outputQuad.material.uniforms.uOutputResolution.value.copy(bufferSize);

    // --- scene re-encode ----------------------------------------------------
    // The fingerprint was already evaluated (sticky probe above), so this just
    // consumes the _sceneDirty flag it set. _sceneDirty is sticky across
    // preview frames, so a core edit made during the preview window is picked
    // up here on the resume frame.
    let shaderSourceChanged = false;
    if (this._sceneDirty) {
      this._encoder.encode();
      u.uAtomsDataTexture.value = this._encoder.atomsTexture;
      u.uCylindersDataTexture.value = this._encoder.cylindersTexture;
      u.uPolyDataTexture.value = this._encoder.polyTexture;
      u.uOccupancyDataTexture.value = this._encoder.occupancyTexture;
      u.uAtomCount.value = this._encoder.atomCount;
      u.uCylinderCount.value = this._encoder.cylinderCount;
      u.uPolyCount.value = this._encoder.polyCount;
      u.uSceneMin.value.copy(this._encoder.sceneBoundsMin);
      u.uSceneMax.value.copy(this._encoder.sceneBoundsMax);
      u.uSceneBoundValid.value = this._encoder.sceneBoundsValid;
      u.uGridEnabled.value = this._encoder.gridEnabled;
      u.uGridMin.value.copy(this._encoder.gridMin);
      u.uGridInvCellSize.value.copy(this._encoder.gridInvCellSize);
      u.uGridDims.value.set(
        this._encoder.gridDims[0], this._encoder.gridDims[1], this._encoder.gridDims[2]);
      u.uGridCellsTex.value = this._encoder.gridCellsTexture;
      u.uGridIndexTex.value = this._encoder.gridIndexTexture;
      // volumetric field isosurface (iso/colour/opacity edits arrive via the
      // encoder fingerprint, which re-encodes and lands here)
      u.uFieldEnabled.value = this._encoder.fieldEnabled;
      u.uFieldTex.value = this._encoder.fieldTexture;
      u.uFieldWorldToFrac.value.copy(this._encoder.fieldWorldToFrac);
      u.uFieldDims.value.set(
        this._encoder.fieldDims[0], this._encoder.fieldDims[1], this._encoder.fieldDims[2]);
      u.uFieldIso.value = this._encoder.fieldIso;
      u.uFieldAbsMode.value = this._encoder.fieldAbsMode;
      u.uFieldPosColor.value.copy(this._encoder.fieldPosColor);
      u.uFieldNegColor.value.copy(this._encoder.fieldNegColor);
      u.uFieldAlpha.value = this._encoder.fieldAlpha;
      u.uFieldMaterial.value.fromArray(this._encoder.fieldMaterialTexel);
      // crystallographic lattice planes (plane edits arrive via the encoder
      // fingerprint, which re-encodes + re-bakes the atlas and lands here)
      u.uPlaneCount.value = this._encoder.planeCount;
      u.uPlanesDataTexture.value = this._encoder.planesTexture;
      u.uPlaneAtlasTex.value = this._encoder.planeAtlasTexture;
      u.uCellWorldToFrac.value.copy(this._encoder.cellWorldToFrac);
      if (this._shaderHasOccupancy !== this._encoder.hasOccupancy) {
        this._shaderHasOccupancy = this._encoder.hasOccupancy;
        this._rtMesh.material.fragmentShader = this._cfg.sceneFragment(this._shaderHasOccupancy);
        this._rtMesh.material.needsUpdate = true;
        this._shaderState = 'pending';
        shaderSourceChanged = true;
      }
      this._sceneDirty = false;
      // content changed: flush the accumulation so the old scene cannot ghost
      this.hardResetAccumulation(renderer);
    }

    // Keep occupancy source transitions behind the same async compile gate as
    // initial activation. Do not fall through to renderer.render() here: that
    // would synchronously link the replacement program and could accumulate a
    // sample in the transition frame. PathTracingPipeline inherits this path.
    if (shaderSourceChanged) {
      this._renderCompileGate(ctx);
      return;
    }

    // --- camera uniforms ----------------------------------------------------
    u.uCameraMatrix.value.copy(camera.matrixWorld);
    u.uCameraIsMoving.value = cameraIsMoving;
    const ce = camera.matrixWorld.elements;
    u.uPieAxis.value.set(-ce[8], -ce[9], -ce[10]).normalize();
    u.uPieRight.value.set(ce[0], ce[1], ce[2]).normalize();
    u.uPieUp.value.set(ce[4], ce[5], ce[6]).normalize();
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
    // rays keep the RAW color — a bright backdrop must not become a light source).
    // With "Match background color" off (Advanced toggle), primary misses get
    // the raw color instead, so the backdrop is tone-mapped along with the
    // scene — the pre-compensation look.
    if (general.rtBackgroundMatch !== false) {
      // legacy Reinhard skips uExposure in the shader (only the prelude's
      // toneMappingExposure applies inside ReinhardToneMapping)
      compensateBackground(u.uBackgroundColor.value,
        (renderer.toneMappingExposure ?? 1) * (general.rtToneMapLegacy === true ? 1
          : (this._outputQuad?.material.uniforms.uExposure.value ?? 1)),
        general.rtSaturation ?? 1,
        u.uBackgroundDisplay.value,
        general.rtToneMapLegacy === true);
    } else {
      u.uBackgroundDisplay.value.copy(u.uBackgroundColor.value);
    }
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
    // background stays visible as "sky" around it, world-fixed just below
    // the structure ("Ground distance" sets the gap).
    const groundOffset = general.rtGroundOffset ?? 0.75;
    u.uGroundNormal.value.set(0, 1, 0);
    u.uGroundD.value = this._encoder.minY - groundOffset;
    u.uGroundCenter.value.copy(this._encoder.structureCenter);
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
      + `|${general.rtSaturation ?? 1}|${general.rtBackgroundMatch !== false}`
      + `|${general.rtToneMapLegacy === true}`
      + `|${u.uGroundEnabled.value}|${u.uApertureSize.value}|${(general.rtDofFocus ?? 1)}`
      + `|${u.uGroundPattern.value}|${u.uGroundColor1.value.getHex()}`
      + `|${u.uGroundColor2.value.getHex()}|${u.uGroundScale.value}|${u.uGroundReflect.value}`
      + `|${general.rtGroundOffset ?? 0.75}|${general.rtGroundSize ?? 2.5}`;
    if (this._lastLookKey !== undefined && lookKey !== this._lastLookKey) this.resetAccumulation();
    this._lastLookKey = lookKey;

    // --- accumulate ---------------------------------------------------------
    // Either one scissored TILE of a round (tiled mode) or the full-frame
    // sample burst (legacy). A round = one sample index rendered tile-by-tile
    // across consecutive render() calls; the vendored per-pixel accumulation
    // blend is texel-local, so a partial (scissored) update of a sample is
    // bit-identical to the untiled sample over the same rect. All GLOBAL
    // bookkeeping (uSampleCounter advance, the frame-1 ghost blend, the output
    // divide) stays per-round, so isConverged()/PNG-export/progress semantics
    // are unchanged (counter == samples fully accumulated at EVERY pixel).
    // Externally-paced (PNG export): exactly one sample per call — the resize
    // boost is discarded, not bursted, so the export can pace the accumulation
    // one animation frame at a time (and, with tiling on, one tile per frame).
    const samplesThisCall = this._pacedExternally ? 1 : Math.max(1, this._boostSamples);
    this._boostSamples = 0;
    // Tiling gate. Sample 1 after any reset is always untiled full-frame: it
    // confines the frame-1 ghost blend and uCameraIsMoving to the untiled path
    // and avoids a near-white flash from a fractional divide against counter 0.
    const gridTiles = this._gridX * this._gridY;
    const useTiling = tilingEnabled && samplesThisCall === 1 && !cameraIsMoving
      && u.uSampleCounter.value >= 1 && gridTiles > 1;
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // Fraction of the in-flight round that is done, used ONLY to advance the
    // progress strip smoothly mid-round. The presented CANVAS does not use it:
    // it shows the display snapshot from the last COMPLETED round, so no
    // mid-round brightness seam ever reaches the screen.
    let completedFraction = 0;

    if (useTiling) {
      if (!this._roundActive) {
        // Start a round: freeze the grid and advance the per-sample bookkeeping
        // ONCE for the whole round (every tile shares this frame index / seed).
        this._roundGridX = this._gridX;
        this._roundGridY = this._gridY;
        this._tileCursor = 0;
        this._roundActive = true;
        u.uFrameCounter.value += 1;
        u.uTime.value += 1 / 60;
        this._nextRandomVec2(u); // deterministic R2 jitter feed (after the bump)
      }
      u[this._cfg.previousTexUniform].value = this._previousTarget.texture;
      u.uCameraIsMoving.value = false; // tiled path is still-camera only

      const roundTiles = this._roundGridX * this._roundGridY;
      const rect = this._tileRect(this._tileCursor, this._roundGridX, this._roundGridY,
        this._accumTarget.width, this._accumTarget.height);
      this._setTileScissor(rect);
      renderer.setRenderTarget(this._accumTarget);
      renderer.render(this._rtScene, camera);
      // ping-pong copy: accumulated image -> previous (same tile rect)
      this._copyQuad.material.uniforms[this._cfg.copyTexUniform].value = this._accumTarget.texture;
      renderer.setRenderTarget(this._previousTarget);
      this._copyQuad.render(renderer);
      this._clearTileScissor();

      this._tileCursor += 1;
      if (this._tileCursor >= roundTiles) {
        // Round complete: this sample index is now accumulated at every pixel.
        u.uSampleCounter.value += 1;
        this._roundActive = false;
        this._tileCursor = 0;
        completedFraction = 0;
        // Present-on-round-completion: snapshot the freshly-completed
        // accumulation (full-frame, scissors already cleared above) into the
        // display target. uSampleCounter was just advanced, so it equals this
        // snapshot's sample count at present time — the output pass divides by
        // it with no extra bookkeeping. Mid-round frames re-present this
        // unchanged snapshot, so the canvas never shows a partial-round seam.
        // (Tiled rounds keep the newest sum in _accumTarget — no swap here.)
        this._snapshotDisplay(renderer, this._accumTarget);
      } else {
        completedFraction = this._tileCursor / roundTiles;
      }
      this._adaptTileGrid();
    } else {
      // Full-frame burst (legacy). A bypass (boost/motion/toggle-off/1x1) while
      // a round is in flight would otherwise bake a mixed multi-sample sum into
      // the accumulation as a permanent 1/N brightness step — abandon it first.
      if (this._roundActive) this.resetAccumulation();
      for (let s = 0; s < samplesThisCall; s++) {
        u.uSampleCounter.value += 1;
        u.uFrameCounter.value += 1;
        u.uTime.value += 1 / 60;
        this._nextRandomVec2(u); // deterministic R2 jitter feed (after the bump)
        u[this._cfg.previousTexUniform].value = this._previousTarget.texture;

        renderer.setRenderTarget(this._accumTarget);
        renderer.render(this._rtScene, camera);

        // Target swap (replaces the per-sample full-frame RGBA32F ping-pong
        // blit): the sum just written to _accumTarget becomes _previousTarget
        // for the next sample and the post-burst consumers; _accumTarget takes
        // the old previous buffer to overwrite next iteration. Bit-identical to
        // the copy — the newest sum ends in _previousTarget, which is exactly
        // the precondition a following tiled round reads (each tile re-traces
        // against _previousTarget and fully overwrites _accumTarget).
        const swap = this._previousTarget;
        this._previousTarget = this._accumTarget;
        this._accumTarget = swap;

        u.uCameraIsMoving.value = false; // only the first sample of a burst blurs
      }
      // When tiling is enabled, the output pass presents the DISPLAY snapshot;
      // the untiled path (sample 1, boosts, motion frames) must refresh it so
      // it isn't stale/black. The newest sum is now in _previousTarget (swap).
      if (tilingEnabled) this._snapshotDisplay(renderer, this._previousTarget);
    }

    // --- averaged, tone-mapped output to the canvas -------------------------
    // With tiling ON the canvas is refreshed once per completed round from the
    // DISPLAY snapshot (an integer-sample-count image), so mid-round frames
    // re-present an unchanged, seam-free picture. uSampleCounter equals the
    // snapshot's sample count (advanced at the same moment it was taken), so the
    // divide is exact. With tiling OFF this is byte-identical to the legacy
    // present: read the newest sum (in _previousTarget since the burst swap),
    // divide by 1/max(1, uSampleCounter).
    const out = this._outputQuad.material.uniforms;
    if (tilingEnabled) {
      out[this._cfg.outputTexUniform].value = this._displayTarget.texture;
    } else {
      // untiled present: the burst swap leaves the newest sum in _previousTarget
      out[this._cfg.outputTexUniform].value = this._previousTarget.texture;
    }
    out.uOneOverSampleCounter.value = 1 / Math.max(1, u.uSampleCounter.value);
    out.uSaturation.value = general.rtSaturation ?? 1; // output-pass grade: no reset needed
    out.uToneMapLegacy.value = general.rtToneMapLegacy === true; // ditto (bg-match reset rides the lookKey)
    this._updateOutputUniforms(out);
    renderer.setRenderTarget(null);
    this._outputQuad.render(renderer);
    // Post-present highlight overlay: draw the current atom/bond/polyhedron
    // selection as occlusion-agnostic orange ghosts directly over the traced
    // image. Only on a TRACED present (this code path is skipped by the preview
    // early-return above, so preview frames show the raster glow instead).
    // autoClear is already false here, so it composites over the presented frame.
    this._renderHighlightOverlay(renderer, camera);
    renderer.autoClear = oldAutoClear;

    // --- progressive refinement under render-on-demand ----------------------
    // The canvas only refreshes per round, but the progress strip still advances
    // smoothly with the fractional round count (completedFraction is kept ONLY
    // for this). An in-flight round keeps the counter below target so render()
    // keeps self-perpetuating until convergence.
    updateTracerProgress(u.uSampleCounter.value + completedFraction, this._cfg.targetSamples);
    if (u.uSampleCounter.value < this._cfg.targetSamples) requestRender();
  }

  // ---- post-present highlight overlay -------------------------------------
  // Lazily-built tiny scene of orange ghosts (atoms as scaled-up spheres, bonds
  // as fattened cylinders, polyhedra as ghost copies) drawn AFTER the output
  // pass with depthTest off, so a highlight glows through the traced image. The
  // tracer encoder deliberately ignores the highlight recolor (Item 2a) so it
  // never restarts the accumulation; this overlay is how the selection is shown
  // in traced frames. Reads the highlight instance ids recorded on the
  // highlightHover store singleton (no ui-layer import).
  _ensureHighlightOverlay() {
    if (this._hlScene) return;
    this._hlScene = new THREE.Scene();
    const HL = 0xFF8C00;
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    const atomMat = new THREE.MeshBasicMaterial({
      color: HL, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false });
    this._hlAtomsMesh = new THREE.InstancedMesh(sphere, atomMat, 8);
    this._hlAtomsMesh.frustumCulled = false;
    this._hlAtomsMesh.count = 0;
    this._hlScene.add(this._hlAtomsMesh);
    // Unit cylinder matching the bonds mesh instance-matrix convention
    // (CylinderGeometry height 1, radius 1: local y in [-0.5, 0.5]).
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
    const bondMat = new THREE.MeshBasicMaterial({
      color: HL, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false });
    this._hlBondsMesh = new THREE.InstancedMesh(cyl, bondMat, 8);
    this._hlBondsMesh.frustumCulled = false;
    this._hlBondsMesh.count = 0;
    this._hlScene.add(this._hlBondsMesh);
    this._hlPolyMat = new THREE.MeshBasicMaterial({
      color: HL, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false });
    this._hlPolyGhosts = []; // reused Mesh pool (share the highlighted geometry)
    this._hlMat = new THREE.Matrix4();
    this._hlScaleAtom = new THREE.Matrix4().makeScale(1.12, 1.12, 1.12); // rim
    this._hlScaleBond = new THREE.Matrix4().makeScale(1.3, 1, 1.3);      // fatten radius only
  }

  /** InstancedMesh capacity grow (its capacity is fixed at construction). */
  _growInstanced(mesh, needed) {
    if (needed <= mesh.instanceMatrix.count) return mesh;
    const cap = Math.max(needed, mesh.instanceMatrix.count * 2);
    const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, cap);
    grown.frustumCulled = false;
    grown.count = 0;
    this._hlScene.remove(mesh);
    this._hlScene.add(grown);
    mesh.dispose();
    return grown;
  }

  /** Meshes of the currently-highlighted polyhedron (all periodic copies when
   *  linked). Matched by stable key or group key on the mesh userData — no
   *  ui-layer import needed. */
  _highlightedPolyMeshes() {
    const sel = highlightHover.currentlyHighlightedPolyhedron;
    const group = groups.polyhedraGroup;
    if (!sel || !group) return [];
    return group.children.filter((m) => m.userData?.type === 'polyhedron' && m.visible
      && (sel.groupKey ? m.userData.groupKey === sel.groupKey : m.userData.key === sel.key));
  }

  _renderHighlightOverlay(renderer, camera) {
    const atomIds = highlightHover.currentlyHighlightedAtomInstances ?? [];
    const bondIds = highlightHover.currentlyHighlightedBond?.instanceIds
      ?? highlightHover.currentlyHighlightedBondInstances ?? [];
    const polyMeshes = this._highlightedPolyMeshes();
    if (!atomIds.length && !bondIds.length && !polyMeshes.length) {
      if (this._hlScene) { // nothing selected: make sure any stale ghosts are hidden
        this._hlAtomsMesh.count = 0;
        this._hlBondsMesh.count = 0;
        for (const g of this._hlPolyGhosts) g.visible = false;
      }
      return;
    }
    this._ensureHighlightOverlay();

    // atoms: copy each highlighted instance matrix, scaled up slightly
    const atomsMesh = groups.atomsMesh;
    if (atomsMesh && atomIds.length) {
      this._hlAtomsMesh = this._growInstanced(this._hlAtomsMesh, atomIds.length);
      let n = 0;
      for (const id of atomIds) {
        if (id < 0 || id >= atomsMesh.count) continue;
        atomsMesh.getMatrixAt(id, this._hlMat);
        if (this._hlMat.elements[0] === 0) continue; // hidden (zero-scaled) instance
        this._hlMat.multiply(this._hlScaleAtom);
        this._hlAtomsMesh.setMatrixAt(n++, this._hlMat);
      }
      this._hlAtomsMesh.count = n;
      this._hlAtomsMesh.instanceMatrix.needsUpdate = true;
    } else {
      this._hlAtomsMesh.count = 0;
    }

    // bonds: copy each highlighted half's instance matrix, fatten the radius
    const bondsMesh = groups.bondsMesh;
    if (bondsMesh && bondIds.length) {
      this._hlBondsMesh = this._growInstanced(this._hlBondsMesh, bondIds.length);
      let n = 0;
      for (const id of bondIds) {
        if (id < 0 || id >= bondsMesh.count) continue;
        bondsMesh.getMatrixAt(id, this._hlMat);
        if (this._hlMat.elements[0] === 0 && this._hlMat.elements[5] === 0) continue; // culled
        this._hlMat.multiply(this._hlScaleBond);
        this._hlBondsMesh.setMatrixAt(n++, this._hlMat);
      }
      this._hlBondsMesh.count = n;
      this._hlBondsMesh.instanceMatrix.needsUpdate = true;
    } else {
      this._hlBondsMesh.count = 0;
    }

    // polyhedra: ghost copies sharing the highlighted meshes' geometry
    for (const g of this._hlPolyGhosts) g.visible = false;
    polyMeshes.forEach((pm, i) => {
      let ghost = this._hlPolyGhosts[i];
      if (!ghost) {
        ghost = new THREE.Mesh(pm.geometry, this._hlPolyMat);
        ghost.frustumCulled = false;
        ghost.matrixAutoUpdate = false;
        this._hlScene.add(ghost);
        this._hlPolyGhosts[i] = ghost;
      }
      ghost.geometry = pm.geometry;
      pm.updateWorldMatrix(true, false);
      ghost.matrix.copy(pm.matrixWorld);
      ghost.visible = true;
    });

    // Draw over the presented frame (render target already null, autoClear off).
    renderer.render(this._hlScene, camera);
  }

  setSize(_width, _height) {
    // sizes are derived from the drawing buffer inside render()
  }

  applyTransparency(material, spec = {}) {
    // Route through the preview instance (when it exists) so materials carry
    // the depth-peel staged-split/overlay/patch state and preview frames render
    // correctly — including materials created later by mesh rebuilds. Keying on
    // instance existence (not the raw flag) keeps routing and material state in
    // sync across toggle flips. Without a preview instance the tracer never
    // draws the raster scene, so the forward flags are harmless.
    if (this._previewPipeline) this._previewPipeline.applyTransparency(material, spec);
    else super.applyTransparency(material, spec);
    this._sceneDirty = true;
  }

  dispose() {
    // Mark disposed FIRST so an in-flight compileAsync resolve (compile gate)
    // that lands after a mid-compile pipeline switch no-ops instead of resetting
    // a foreign accumulation / requesting a render on a dead pipeline.
    this._disposed = true;
    // Teardown BEFORE the _initialized guard: the preview instance (and its
    // rest timer) can exist even if this tracer never rendered a traced frame.
    this._teardownPreview();
    hideTracerProgress();
    // Highlight overlay resources (may exist even before the first traced frame).
    if (this._hlScene) {
      this._hlAtomsMesh.geometry.dispose();
      this._hlAtomsMesh.material.dispose();
      this._hlAtomsMesh.dispose();
      this._hlBondsMesh.geometry.dispose();
      this._hlBondsMesh.material.dispose();
      this._hlBondsMesh.dispose();
      this._hlPolyMat.dispose();
      this._hlScene = null;
      this._hlPolyGhosts = null;
    }
    if (!this._initialized) return;
    this._accumTarget.dispose();
    this._previousTarget.dispose();
    this._displayTarget.dispose();
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
