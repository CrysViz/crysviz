// Focus peaking for the tracers' depth of field (Visual window: DoF
// aperture, Focus distance, Focus depth). While one of those sliders is being
// dragged — and for a moment after — every atom and bond that the tracer will
// render sharp gets a bright rim, the way a camera's focus peaking marks the
// in-focus edges, so the user sees at once what the focal plane and the sharp
// slab hold. It is a screen-space pass (a depth render of the scene, then the
// depth edges inside the sharp band are coloured) that the raster pipelines
// draw after the frame (renderFocusPeaking, called from the pipelines'
// render), so atoms, bonds and polyhedra are treated alike and whatever hides
// something hides its peaking too; under a tracer the interactive raster
// preview holds for the drag (RayTracingPipeline keys the DoF knobs into its
// raster-look probe), which is where the peaking is seen. The tracers never
// trace it.
//
// "Sharp" mirrors the shader (raytrace/dofChunk.js): depth measured along the
// camera's forward axis from the camera, the focal plane at
// focusPlaneDistance(), the slab ± Focus depth around it, plus the band in
// which the lens blur stays under BLUR_LIMIT_PX on the canvas: the circle of
// confusion sqrt(aperture) · |d − f| / f (world units) times the pixels per
// world unit at that depth (so a close zoom narrows the band, and the
// foreground, which the picture magnifies, is judged more strictly than the
// background) — with the aperture closed everything is sharp.

import * as THREE from '../external/three/three.module.js';
import { app, groups, general } from '../state/store.js';
import { requestRender } from './AnimateModule.js';

const PEAK_COLOR = 0x00D4FF;   // cyan: distinct from the selection orange and most element colours
const HOLD_MS = 1500;          // shown this long after the last slider change
const BLUR_LIMIT_PX = 0.75;    // blur radius on the canvas (device px) still counted as sharp

let hideTimer = null;
let lastShownAt = 0;
let visible = false;
let lastStats = { peakedAtoms: 0, sharpHalfDepth: Infinity };

const _forward = new THREE.Vector3();

/** Focal-plane distance along the camera's forward axis (world units) — the
 *  orbit target's depth times the Focus distance factor (1 = the target). */
export function focusPlaneDistance(camera = app.camera) {
  const target = app.controls?.target;
  const distance = camera && target ? camera.position.distanceTo(target) : 100;
  return distance * (general.rtDofFocus ?? 1);
}

/** Canvas pixels per world unit at a depth along the view axis. */
function pixelsPerUnitAt(camera, depth) {
  const height = app.renderer?.domElement?.height ?? 900; // drawing buffer (device px)
  if (camera.isOrthographicCamera) {
    const worldHeight = (camera.top - camera.bottom) / (camera.zoom || 1);
    return worldHeight > 0 ? height / worldHeight : 0;
  }
  const fov = (camera.fov ?? 45) * Math.PI / 180;
  const worldHeight = 2 * Math.max(depth, 1e-3) * Math.tan(fov / 2);
  return height / worldHeight;
}

/** Half-depth of the band rendered sharp around the focal plane, judged at
 *  a given depth: the Focus depth slab plus the depth of field in which the
 *  lens blur stays under BLUR_LIMIT_PX on the canvas (infinite with the
 *  aperture closed). */
export function sharpHalfDepth(camera = app.camera, depth = focusPlaneDistance(camera)) {
  const radius = Math.sqrt(Math.max(0, general.rtDofAperture ?? 0));
  const slab = Math.max(0, general.rtDofDepth ?? 0);
  if (!(radius > 0) || !camera) return Infinity;
  const ppu = pixelsPerUnitAt(camera, depth);
  if (!(ppu > 0)) return Infinity;
  return slab + BLUR_LIMIT_PX * focusPlaneDistance(camera) / (radius * ppu);
}

// ---- the screen-space pass --------------------------------------------------
// One extra render of the scene with its real materials into a depth target
// (colour discarded; imposter atoms and instanced meshes keep their true
// depth, which an override material would not give), then a full-screen
// pass: a pixel is peaked when it sits on a depth edge (a step to one of its
// neighbours, or the background) and its own depth is inside the sharp band.
// See-through surfaces write no depth, so what is seen through them is what
// gets judged; an opaque polyhedron's faces and edges are.
let depthTarget = null;
let quadScene = null;
let quadCamera = null;
let quadMesh = null;
let peakMaterial = null;
const bufferSize = new THREE.Vector2();

const PEAK_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const PEAK_FRAGMENT = /* glsl */`
  #include <packing>
  uniform sampler2D tDepth;
  uniform vec2 uTexelSize;
  uniform float uNear;
  uniform float uFar;
  uniform float uOrtho;        // 1.0 for an orthographic camera
  uniform float uFocus;        // focal-plane depth (view axis, world units)
  uniform float uRadius;       // lens radius sqrt(aperture), world units (0 = closed)
  uniform float uSlab;         // half-depth of the always-sharp slab
  uniform float uLimitPx;      // blur radius on the canvas still counted as sharp
  uniform float uHeightPx;     // canvas height in device px
  uniform float uTanHalfFov;   // perspective: tan(fov / 2)
  uniform float uPxPerUnitOrtho;
  uniform vec3 uColor;
  varying vec2 vUv;

  float toViewDist(float d) {
    if (uOrtho > 0.5) return mix(uNear, uFar, d);
    return -perspectiveDepthToViewZ(d, uNear, uFar);
  }
  float viewDist(vec2 uv) { return toViewDist(texture2D(tDepth, uv).x); }

  // canvas pixels per world unit at a depth
  float pxPerUnit(float d) {
    if (uOrtho > 0.5) return uPxPerUnitOrtho;
    return uHeightPx / (2.0 * max(d, 1e-3) * uTanHalfFov);
  }

  bool sharpAt(float d) {
    float off = abs(d - uFocus);
    if (off <= uSlab) return true;
    if (uRadius <= 0.0) return true;
    float blurPx = uRadius * (off - uSlab) / max(uFocus, 1e-3) * pxPerUnit(d);
    return blurPx <= uLimitPx;
  }

  void main() {
    float d = viewDist(vUv);
    if (d >= uFar * 0.999) discard; // background
    // an edge: a depth step to a neighbour beyond what the surface's own
    // slope explains (the step on the opposite side), or the background
    float edge = 0.0;
    vec2 dirs[4];
    dirs[0] = vec2(uTexelSize.x, 0.0);
    dirs[1] = vec2(0.0, uTexelSize.y);
    dirs[2] = vec2(uTexelSize.x, uTexelSize.y);
    dirs[3] = vec2(uTexelSize.x, -uTexelSize.y);
    for (int i = 0; i < 4; i++) {
      float a = viewDist(vUv + dirs[i]);
      float b = viewDist(vUv - dirs[i]);
      float stepA = a - d;
      float stepB = b - d;
      // a crease or slope: steps of opposite sign and similar size cancel
      float jump = max(abs(stepA + stepB) - 0.0, 0.0);
      if (a >= uFar * 0.999 || b >= uFar * 0.999) jump = 1e9;
      if (jump > max(0.03 * d, 0.08)) edge = 1.0;
    }
    if (edge < 0.5) discard;
    if (!sharpAt(d)) discard;
    gl_FragColor = vec4(uColor, 0.9);
  }
`;

function ensurePass(renderer) {
  renderer.getDrawingBufferSize(bufferSize);
  const w = Math.max(1, Math.floor(bufferSize.x));
  const h = Math.max(1, Math.floor(bufferSize.y));
  if (!depthTarget) {
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    depthTarget = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, depthTexture });
  } else if (depthTarget.width !== w || depthTarget.height !== h) {
    depthTarget.setSize(w, h);
  }
  if (!quadScene) {
    quadScene = new THREE.Scene();
    quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    peakMaterial = new THREE.ShaderMaterial({
      vertexShader: PEAK_VERTEX,
      fragmentShader: PEAK_FRAGMENT,
      uniforms: {
        tDepth: { value: null }, uTexelSize: { value: new THREE.Vector2() },
        uNear: { value: 0.1 }, uFar: { value: 1000 }, uOrtho: { value: 0 },
        uFocus: { value: 100 }, uRadius: { value: 0 }, uSlab: { value: 0 },
        uLimitPx: { value: BLUR_LIMIT_PX }, uHeightPx: { value: h }, uTanHalfFov: { value: 0.414 },
        uPxPerUnitOrtho: { value: 1 }, uColor: { value: new THREE.Color(PEAK_COLOR) },
      },
      transparent: true, depthTest: false, depthWrite: false,
    });
    quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), peakMaterial);
    quadMesh.frustumCulled = false;
    quadScene.add(quadMesh);
  }
}

/** The atoms inside the sharp band (for the inspection hook / tests; the
 *  drawing itself is the screen-space pass). */
function countInBand(camera) {
  const atoms = groups.atomsMesh;
  if (!atoms?.instanceMatrix) return 0;
  camera.getWorldDirection(_forward);
  const f = focusPlaneDistance(camera);
  const a = atoms.instanceMatrix.array;
  let n = 0;
  for (let i = 0; i < atoms.count; i++) {
    const o = i * 16;
    if (!(a[o] > 0)) continue;
    const d = (a[o + 12] - camera.position.x) * _forward.x + (a[o + 13] - camera.position.y) * _forward.y
      + (a[o + 14] - camera.position.z) * _forward.z;
    if (Math.abs(d - f) <= sharpHalfDepth(camera, d)) n++;
  }
  return n;
}

/** Draw the peaking over the frame (raster pipelines, after their own
 *  passes; the render target is the screen). No-op while not shown. */
export function renderFocusPeaking(renderer, scene, camera) {
  if (!visible || !camera || !scene) return;
  ensurePass(renderer);
  // the scene's depth, with its real materials (the colour is discarded)
  const prevTarget = renderer.getRenderTarget();
  const prevBackground = scene.background;
  const prevAutoClear = renderer.autoClear;
  scene.background = null;
  renderer.autoClear = true;
  renderer.setRenderTarget(depthTarget);
  renderer.clear();
  renderer.render(scene, camera);
  scene.background = prevBackground;
  renderer.setRenderTarget(prevTarget);

  const u = peakMaterial.uniforms;
  u.tDepth.value = depthTarget.depthTexture;
  u.uTexelSize.value.set(1 / depthTarget.width, 1 / depthTarget.height);
  u.uNear.value = camera.near;
  u.uFar.value = camera.far;
  u.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
  u.uFocus.value = focusPlaneDistance(camera);
  u.uRadius.value = Math.sqrt(Math.max(0, general.rtDofAperture ?? 0));
  u.uSlab.value = Math.max(0, general.rtDofDepth ?? 0);
  u.uHeightPx.value = depthTarget.height;
  u.uTanHalfFov.value = Math.tan(((camera.fov ?? 45) * Math.PI / 180) / 2);
  u.uPxPerUnitOrtho.value = camera.isOrthographicCamera
    ? depthTarget.height * (camera.zoom || 1) / (camera.top - camera.bottom) : 1;
  renderer.autoClear = false;
  renderer.render(quadScene, quadCamera);
  renderer.autoClear = prevAutoClear;
  lastStats = { peakedAtoms: countInBand(camera), sharpHalfDepth: sharpHalfDepth(camera) };
}

/** Show the peaking (a DoF slider is being dragged) and keep it for HOLD_MS
 *  after the last call; a render is requested when it goes away again. */
export function showFocusPlaneMarker() {
  lastShownAt = performance.now();
  visible = true;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    visible = false;
    requestRender();
  }, HOLD_MS);
  requestRender();
}

/** Hide the peaking at once (structure switch, export). */
export function hideFocusPlaneMarker() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  visible = false;
}

// ---- Pick focus: click an atom to put the focal plane through it ---------
// The Visual window's Pick button (next to Focus distance) arms the mode; the
// next click in the 3D view (ui/SceneInteraction.js) hands the picked point
// to focusOnPoint(), which sets the Focus distance factor so the focal plane
// passes through it, and the mode ends. Escape or the button again cancels.
export const FOCUS_PICK_CHANGED = 'crysviz:focus-pick-changed';
let focusPickActive = false;

function onFocusPickKey(e) {
  if (e.key === 'Escape') setFocusPick(false);
}

/** Arm / disarm the pick-focus mode (the 3D view's cursor says so). */
export function setFocusPick(on) {
  const next = !!on;
  if (next === focusPickActive) return;
  focusPickActive = next;
  const canvas = app.renderer?.domElement;
  canvas?.classList.toggle('cv-focus-pick', next); // crosshair cursor (styles.css)
  if (next) document.addEventListener('keydown', onFocusPickKey);
  else document.removeEventListener('keydown', onFocusPickKey);
  document.dispatchEvent(new CustomEvent(FOCUS_PICK_CHANGED, { detail: { active: next } }));
}

export function isFocusPickActive() {
  return focusPickActive;
}

/** Put the focal plane through a world point: the Focus distance factor
 *  becomes the point's depth over the orbit target's, within the slider's
 *  range; the slider follows (its input handler sets the store and shows
 *  the peaking). Returns the factor set, or null when the point is behind
 *  the camera. */
export function focusOnPoint(point, camera = app.camera) {
  const target = app.controls?.target;
  if (!camera || !target) return null;
  camera.getWorldDirection(_forward);
  const depth = (point.x - camera.position.x) * _forward.x + (point.y - camera.position.y) * _forward.y
    + (point.z - camera.position.z) * _forward.z;
  const targetDepth = camera.position.distanceTo(target);
  if (!(depth > 0) || !(targetDepth > 0)) return null;
  const factor = Math.min(3, Math.max(0.2, Math.round((depth / targetDepth) * 100) / 100));
  const slider = /** @type {HTMLInputElement|null} */ (document.getElementById('rtDofFocus'));
  if (slider) {
    slider.value = String(factor);
    slider.dispatchEvent(new Event('input'));
  } else {
    general.rtDofFocus = factor;
    showFocusPlaneMarker();
  }
  return factor;
}

/** Test/inspection hook: whether the peaking is shown, when it was last
 *  shown, and what the last drawn frame peaked. */
export function focusPlaneMarkerState() {
  return { visible, lastShownAt, ...lastStats };
}
