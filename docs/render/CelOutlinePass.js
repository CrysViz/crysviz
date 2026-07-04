// Screen-space outline pass for the cel render style.
//
// Instead of inverted-hull outline geometry (which is depth-tested against the
// whole scene and therefore pokes into any object closer than the outline
// width — atoms on polyhedron vertices, face-sharing polyhedra, ...), outlines
// are drawn as a post-process: the outlined meshes are rendered a second time
// into an offscreen depth buffer, and a full-screen pass draws black where
// that depth is discontinuous. Lines appear only at visible silhouettes, with
// a uniform pixel width, and overlapping objects share one clean contour.
//
// Participation is by layer: meshes that should contribute outlines enable
// CEL_OUTLINE_LAYER (atoms/bonds enable it in addition to the default layer;
// the transparent polyhedra faces don't write depth, so PolyhedraModule adds
// an opaque depth-proxy child that lives ONLY on the outline layer and is
// invisible in the main render). The depth pass renders those meshes with
// their real materials, so per-instance opacity discards and cut planes are
// respected. The pass runs from the animation loop, right after the main
// render, and only when general.renderStyle === 'cel' with a width > 0
// (general.celOutlineWidth, in CSS pixels).

import * as THREE from '../external/three/three.module.js';
import { general } from '../state/store.js';

export const CEL_OUTLINE_LAYER = 3;

let target = null; // offscreen target whose depthTexture feeds the edge pass
let quadScene = null;
let quadCamera = null;
let quadMaterial = null;
const bufferSize = new THREE.Vector2();

const EDGE_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Edge metric: second derivative (Laplacian) of view-space distance, so
// smoothly sloped surfaces don't trigger, plus a threshold relative to the
// centre distance so line sensitivity is stable across zoom levels.
//
// Samples are taken along FOUR axis pairs (horizontal, vertical, both
// diagonals), all at the same euclidean pixel radius, and combined with max.
// Axis-only sampling would make a thick outline the union of a horizontal and
// a vertical dilation of the silhouette — visibly "two overlaid ellipses"
// around a lone atom instead of a circular ring.
const EDGE_FRAGMENT = /* glsl */`
  #include <packing>
  uniform sampler2D tDepth;
  uniform vec2 uTexelSize;
  uniform float uWidth;     // device pixels
  uniform float uNear;
  uniform float uFar;
  uniform float uOrtho;     // 1.0 for an orthographic camera
  uniform float uThreshold; // relative depth-discontinuity threshold
  varying vec2 vUv;

  float viewDist(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    if (uOrtho > 0.5) return mix(uNear, uFar, d);
    return -perspectiveDepthToViewZ(d, uNear, uFar);
  }

  float axisLap(vec2 offset, float dc) {
    return abs(viewDist(vUv + offset) + viewDist(vUv - offset) - 2.0 * dc);
  }

  void main() {
    vec2 o = uTexelSize * uWidth;
    float dc = viewDist(vUv);
    vec2 diag = o * 0.70710678; // same euclidean radius as the axis taps
    float lap = axisLap(vec2(o.x, 0.0), dc);
    lap = max(lap, axisLap(vec2(0.0, o.y), dc));
    lap = max(lap, axisLap(diag, dc));
    lap = max(lap, axisLap(vec2(diag.x, -diag.y), dc));
    float t = uThreshold * min(dc, uFar * 0.5);
    float edge = smoothstep(t, 2.0 * t, lap);
    if (edge <= 0.0) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, edge);
  }
`;

function ensureResources(renderer) {
  renderer.getDrawingBufferSize(bufferSize);
  const w = Math.max(1, Math.floor(bufferSize.x));
  const h = Math.max(1, Math.floor(bufferSize.y));
  if (!target) {
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, depthTexture });
  } else if (target.width !== w || target.height !== h) {
    target.setSize(w, h);
  }
  if (!quadScene) {
    quadMaterial = new THREE.ShaderMaterial({
      vertexShader: EDGE_VERTEX,
      fragmentShader: EDGE_FRAGMENT,
      uniforms: {
        tDepth: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uWidth: { value: 2 },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uOrtho: { value: 0 },
        uThreshold: { value: 0.02 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    quadMaterial.toneMapped = false;
    quadScene = new THREE.Scene();
    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMaterial));
    quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
}

/**
 * Render the outline overlay onto the canvas. Call right after the main
 * renderer.render() with the same scene/camera. No-op outside cel style.
 */
export function renderCelOutlinePass(renderer, scene, camera) {
  if (general.renderStyle !== 'cel' || general.celOutlineMode !== 'screen'
    || !(general.celOutlineWidth > 0)) return;
  ensureResources(renderer);

  // Depth pass: only the outline layer, real materials (color is irrelevant,
  // only the depth buffer is consumed). The background is dropped so empty
  // pixels keep the far-plane clear depth.
  const prevMask = camera.layers.mask;
  const prevBackground = scene.background;
  const prevAutoClear = renderer.autoClear;
  scene.background = null;
  camera.layers.set(CEL_OUTLINE_LAYER);
  renderer.setRenderTarget(target);
  renderer.autoClear = true;
  renderer.clear();
  renderer.render(scene, camera);
  camera.layers.mask = prevMask;
  scene.background = prevBackground;

  // Composite the detected edges over the already-rendered frame.
  const u = quadMaterial.uniforms;
  u.tDepth.value = target.depthTexture;
  u.uTexelSize.value.set(1 / target.width, 1 / target.height);
  u.uWidth.value = general.celOutlineWidth * renderer.getPixelRatio();
  u.uNear.value = camera.near;
  u.uFar.value = camera.far;
  u.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
  renderer.setRenderTarget(null);
  renderer.autoClear = false;
  renderer.render(quadScene, quadCamera);
  renderer.autoClear = prevAutoClear;
}
