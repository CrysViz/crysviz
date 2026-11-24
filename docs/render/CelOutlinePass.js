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
// the transparent polyhedra faces don't write depth, so PolyhedraMesh.js adds
// one opaque depth-proxy mesh over all polyhedra that lives ONLY on the
// outline layer and is invisible in the main render). The depth pass renders those meshes with
// their real materials, so per-instance opacity discards and cut planes are
// respected. Arrows (forces, spins, phonon modes) always enable
// CEL_OCCLUDER_LAYER, so a line behind one is not painted over it, and join
// CEL_OUTLINE_LAYER unless "Outline arrows" is off (ArrowMaterial.js
// applyArrowCelOutline).
// Each frame has two steps, both called by the render pipelines
// (render/pipeline/) when general.renderStyle === 'cel':
// prepareCelOutlinePass() BEFORE the main render draws the depth targets
// (the hull shells of 3D-hull mode read the arrows' depth during the main
// render, MaterialStyles.js), renderCelOutlinePass() right after it paints
// the lines: in screen-space mode for everything, in 3D-hull mode for the
// arrows only (at the hull width; atoms and bonds have their hulls there,
// arrows get none — ArrowMaterial.js applyArrowCelOutline).
//
// The width (general.celOutlineWidth) is in WORLD units, converted once per
// frame to a uniform pixel width using the current zoom level (camera.zoom
// for orthographic; distance to the orbit target for perspective). Zooming
// so a sphere renders at double the radius doubles the outline thickness —
// deep zoom-in gives proportionally thick lines (up to MAX_RADIUS pixels).
//
// Four full-screen passes draw the lines: edge pixels at one-pixel scale
// (SEED_FRAGMENT), their edge points refined along runs of edge pixels
// (REFINE_FRAGMENT), then the exact distance from every pixel to the nearest
// edge point, along rows and then columns (ROW_/LINE_FRAGMENT): a pixel is
// line when that distance is within the width.

import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { resolveCelOutlineColor, setCelHullArrowDepth, syncCelHullPixelFloor } from './MaterialStyles.js';

export const CEL_OUTLINE_LAYER = 3;

// Occluders: opaque objects that must hide the lines behind them, outlined
// themselves or not (force, spin and phonon arrows, outlined unless "Outline
// arrows" is off). The overlay is painted over the finished frame, so without
// this an atom's silhouette behind an arrow was drawn across the arrow. They
// render into a second depth target, and an outline pixel is dropped where an
// occluder is the visible surface: nearer than the outlined objects at that
// pixel (or over the background).
export const CEL_OCCLUDER_LAYER = 4;

let target = null; // offscreen target whose depthTexture feeds the edge pass
let occluderTarget = null; // depth of the occluders (CEL_OCCLUDER_LAYER)
let seedTarget = null; // edge pixels: flag, sub-pixel offset
let refinedTarget = null; // the seeds with their edge points refined along runs
let rowTarget = null; // per pixel: the nearest edge point along its row
let quadScene = null;
let quadCamera = null;
let quadMesh = null;
let seedMaterial = null;
let refineMaterial = null;
let rowMaterial = null;
let lineMaterial = null;
let floatTargets = null; // null: not probed yet; false: no float render targets
const bufferSize = new THREE.Vector2();

// The depth targets of this frame: drawn by prepareCelOutlinePass(), used by
// renderCelOutlinePass(). 'none' before/after a frame, 'skip' when there are
// no lines to draw this frame, 'ready' when there are.
let prepared = 'none';

// Longest line half-width, in device pixels (a line wider than this on
// screen is drawn this wide).
const MAX_RADIUS = 255;

const QUAD_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const DEPTH_HELPERS = /* glsl */`
  #include <packing>
  uniform sampler2D tDepth;
  uniform sampler2D tOccluder; // depth of arrows etc. (CEL_OCCLUDER_LAYER)
  uniform vec2 uTexelSize;
  uniform float uNear;
  uniform float uFar;
  uniform float uOrtho;     // 1.0 for an orthographic camera
  varying vec2 vUv;

  float toViewDist(float d) {
    if (uOrtho > 0.5) return mix(uNear, uFar, d);
    return -perspectiveDepthToViewZ(d, uNear, uFar);
  }

  float viewDist(vec2 uv) {
    return toViewDist(texture2D(tDepth, uv).x);
  }

  // Whether an arrow (CEL_OCCLUDER_LAYER) is the visible surface at uv, given
  // the outline layer's distance d there (arrows are in it when outlined).
  bool arrowAt(vec2 uv, float d) {
    float a = toViewDist(texture2D(tOccluder, uv).x);
    return a < uFar * 0.999 && a <= d * (1.0 + 1e-4);
  }
`;

// Pass 1 — edge pixels, decided at ONE-PIXEL scale, between a pixel and
// each of its 8 neighbours:
// - a depth jump: the step towards that neighbour exceeds the step on the
//   opposite side by a threshold relative to the distance (so a surface's
//   slope cancels and a crease — a bond bending into an atom — is no edge);
// - with arrows outlined, an arrow next to anything else, so an arrow is
//   outlined where it runs alongside a bond or enters an atom, however small
//   the depth step there.
// The line used to be decided by depth differences at the full line radius,
// faded over 1x..2x the threshold: creases registered like small gaps, and
// slowly growing gaps faded in over many pixels (grey smudges, slivers).
// Each edge pixel also stores WHERE the edge lies: halfway towards the
// neighbour(s) across it (G, B: offset in pixels). Lines are measured from
// that point, so they follow the true contour rather than the pixel
// staircase and are exactly the set width.
// 3D-hull mode (uArrowsOnly) is kept for the arrows' whole silhouettes —
// read from the arrows' own depth (tOccluder), flagged visible or hidden
// (R: 1 or 0.5) so a line ends flat where the arrow disappears — but is not
// run at the moment: the arrows get no outline in that mode.
const SEED_FRAGMENT = /* glsl */`
  ${DEPTH_HELPERS}
  uniform float uJump;       // relative depth-jump threshold
  uniform float uArrowEdges; // 1.0: arrows are outlined ("Outline arrows")
  uniform float uArrowsOnly; // 1.0: 3D-hull mode, lines of arrows only

  vec2 offsetSum = vec2(0.0);
  float hits = 0.0;
  bool visible = false;

  float occDist(vec2 uv) {
    return toViewDist(texture2D(tOccluder, uv).x);
  }

  // Screen-space mode. e: one-pixel step to a neighbour (texels); its
  // opposite is -e.
  void pair(vec2 e, float d0, bool a0, float t) {
    vec2 step = e * uTexelSize;
    float dq = viewDist(vUv + step);
    float dr = viewDist(vUv - step);
    bool aq = uArrowEdges > 0.5 && arrowAt(vUv + step, dq);
    bool jump = abs(dq - d0) - abs(d0 - dr) > t;
    bool border = uArrowEdges > 0.5 && aq != a0;
    if (jump || border) {
      offsetSum += 0.5 * e;
      hits += 1.0;
      visible = true;
    }
  }

  // 3D-hull mode: the arrows' silhouettes in their own depth (an arrow
  // against nothing, or an arrow in front of another), visible where the
  // arrow side is the scene's visible surface.
  void arrowPair(vec2 e, float o0, bool a0, float s0, float t) {
    vec2 step = e * uTexelSize;
    float oq = occDist(vUv + step);
    float orr = occDist(vUv - step);
    bool aq = oq < uFar * 0.999;
    bool edge = (a0 != aq) || (a0 && aq && abs(oq - o0) - abs(o0 - orr) > t);
    if (!edge) return;
    offsetSum += 0.5 * e;
    hits += 1.0;
    bool qNearer = oq < o0;
    float oa = qNearer ? oq : o0;
    float sa = qNearer ? viewDist(vUv + step) : s0;
    if (oa <= sa * (1.0 + 1e-4)) visible = true;
  }

  void main() {
    if (uArrowsOnly > 0.5) {
      float o0 = occDist(vUv);
      bool a0 = o0 < uFar * 0.999;
      float s0 = viewDist(vUv);
      float t = uJump * min(o0, uFar * 0.5);
      arrowPair(vec2(1.0, 0.0), o0, a0, s0, t);
      arrowPair(vec2(-1.0, 0.0), o0, a0, s0, t);
      arrowPair(vec2(0.0, 1.0), o0, a0, s0, t);
      arrowPair(vec2(0.0, -1.0), o0, a0, s0, t);
      arrowPair(vec2(1.0, 1.0), o0, a0, s0, t);
      arrowPair(vec2(-1.0, -1.0), o0, a0, s0, t);
      arrowPair(vec2(1.0, -1.0), o0, a0, s0, t);
      arrowPair(vec2(-1.0, 1.0), o0, a0, s0, t);
    } else {
      float d0 = viewDist(vUv);
      bool a0 = uArrowEdges > 0.5 && arrowAt(vUv, d0);
      float t = uJump * min(d0, uFar * 0.5);
      pair(vec2(1.0, 0.0), d0, a0, t);
      pair(vec2(-1.0, 0.0), d0, a0, t);
      pair(vec2(0.0, 1.0), d0, a0, t);
      pair(vec2(0.0, -1.0), d0, a0, t);
      pair(vec2(1.0, 1.0), d0, a0, t);
      pair(vec2(-1.0, -1.0), d0, a0, t);
      pair(vec2(1.0, -1.0), d0, a0, t);
      pair(vec2(-1.0, 1.0), d0, a0, t);
    }
    if (hits < 0.5) { gl_FragColor = vec4(0.0); return; }
    vec2 off = clamp(offsetSum / hits, -0.5, 0.5);
    gl_FragColor = vec4(visible ? 1.0 : 0.5, off.x, off.y, 1.0);
  }
`;

// Pass 1b — the edge points refined along runs. The depth buffer knows an
// edge only to the pixel: between a pixel and its neighbour across the edge,
// so the seed pass puts the edge point halfway between them, and along a
// shallow edge those points follow the pixel staircase (a step every few
// pixels). Thin lines then look stair-stepped — at the zoom levels where a
// line is one or two pixels wide, every outline did. Like morphological
// antialiasing, this pass walks along each run of edge pixels that share
// the same side of the same (horizontal or vertical) edge, finds where the
// run ends and whether the edge continues on the row towards or away from
// the object there, and places the true edge on the straight line between
// those two ends: at a continuation towards the object the edge sits at the
// far pixel boundary, at one away from it at this pixel's centre, and at a
// free end (a corner, something in front) halfway. Diagonal seeds (hits in
// both directions) keep their halfway point, which is right for them.
const REFINE_FRAGMENT = /* glsl */`
  uniform sampler2D tSeed;
  uniform vec2 uTexelSize;
  varying vec2 vUv;

  const int RUN = 32; // longest run followed each way (pixels)

  vec4 seedAt(vec2 e) {
    return texture2D(tSeed, vUv + e * uTexelSize);
  }

  // The offset across the edge of a seed (toward the other side).
  float across(vec4 s, bool horizontal) {
    return horizontal ? s.b : s.g;
  }

  // A seed of the same run: an edge pixel with the same across-offset sign.
  bool member(vec4 s, bool horizontal, float sgn) {
    return s.r > 0.25 && across(s, horizontal) * sgn > 0.3;
  }

  // The edge's offset (0 .. 1 across, towards the object side) at a run's
  // end: 1.0 where the run continues on the row towards the object, 0.0
  // where it continues on the row away from it, 0.5 at a free end.
  float endOffset(vec2 endPos, vec2 toward, bool horizontal, float sgn) {
    if (member(seedAt(endPos + toward), horizontal, sgn)) return 1.0;
    if (member(seedAt(endPos - toward), horizontal, sgn)) return 0.0;
    return 0.5;
  }

  void main() {
    vec4 s0 = seedAt(vec2(0.0));
    if (s0.r < 0.25) { gl_FragColor = vec4(0.0); return; }
    vec2 off = s0.gb;
    bool horizontal = abs(off.y) > 0.3 && abs(off.x) < 0.15;
    bool vertical = abs(off.x) > 0.3 && abs(off.y) < 0.15;
    if (!horizontal && !vertical) { gl_FragColor = s0; return; }
    vec2 along = horizontal ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    float sgn = sign(across(s0, horizontal));
    vec2 toward = (horizontal ? vec2(0.0, 1.0) : vec2(1.0, 0.0)) * sgn;
    int kR = 0;
    for (int k = 1; k <= RUN; k++) {
      if (!member(seedAt(along * float(k)), horizontal, sgn)) break;
      kR = k;
    }
    int kL = 0;
    for (int k = 1; k <= RUN; k++) {
      if (!member(seedAt(-along * float(k)), horizontal, sgn)) break;
      kL = k;
    }
    float aR = kR >= RUN ? 0.5 : endOffset(along * float(kR + 1), toward, horizontal, sgn);
    float aL = kL >= RUN ? 0.5 : endOffset(-along * float(kL + 1), toward, horizontal, sgn);
    float t = (float(kL) + 0.5) / float(kL + kR + 1);
    float a = mix(aL, aR, t) * sgn;
    vec2 refined = horizontal ? vec2(off.x, a) : vec2(a, off.y);
    gl_FragColor = vec4(s0.r, refined, s0.a);
  }
`;

// Pass 2 — along each row, the nearest edge point within the line radius:
// R its horizontal distance (signed, pixels), G its vertical offset, A its
// flag (1 visible, 0.5 hidden; 0: none found).
const ROW_FRAGMENT = /* glsl */`
  uniform sampler2D tSeed;
  uniform vec2 uTexelSize;
  uniform float uRadius; // device pixels
  varying vec2 vUv;

  void main() {
    int r = int(ceil(uRadius)) + 1;
    float best = 1e9;
    float bestOy = 0.0;
    float bestFlag = 0.0;
    // Bounded by the uniform width (WebGL2 shaders allow it), so the cost
    // follows the line width, not MAX_RADIUS.
    for (int i = -r; i <= r; i++) {
      vec4 s = texture2D(tSeed, vUv + vec2(float(i) * uTexelSize.x, 0.0));
      if (s.r > 0.25) {
        float ex = float(i) + s.g;
        if (abs(ex) < abs(best)) { best = ex; bestOy = s.b; bestFlag = s.r; }
      }
    }
    if (abs(best) > 1e8) { gl_FragColor = vec4(0.0); return; }
    gl_FragColor = vec4(best, bestOy, 0.0, bestFlag);
  }
`;

// Pass 3 — down each column, the euclidean distance to the nearest edge
// point (from the row results): line where it is within the radius, with a
// one-pixel soft outer edge, so lines are round and smooth at any width.
// Where an arrow is the visible surface (nearer than the outlined objects
// there, or over the background) it hides the line; behind an atom it does
// not. 3D-hull mode: the line lies outside the arrows only, like a hull,
// and only where its nearest edge point is a visible one (see the seed
// pass): it ends flat where the arrow goes behind something.
const LINE_FRAGMENT = /* glsl */`
  ${DEPTH_HELPERS}
  uniform sampler2D tRow;
  uniform float uRadius; // device pixels
  uniform vec3 uColor;   // outline color (resolved from the color mode)
  uniform float uArrowsOnly;
  uniform float uArrowEdges;

  void main() {
    int r = int(ceil(uRadius)) + 1;
    float best = 1e9;
    float flag = 0.0;
    for (int j = -r; j <= r; j++) {
      vec4 row = texture2D(tRow, vUv + vec2(0.0, float(j) * uTexelSize.y));
      if (row.a > 0.25) {
        float dx = row.r;
        float dy = float(j) + row.g;
        float d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; flag = row.a; }
      }
    }
    if (best > 1e8) discard;
    float alpha = clamp(uRadius + 0.5 - sqrt(best), 0.0, 1.0);
    if (alpha <= 0.0) discard;
    float dc = viewDist(vUv);
    float occluder = toViewDist(texture2D(tOccluder, vUv).x);
    if (occluder < dc * (1.0 - 1e-4)) discard;
    if (uArrowsOnly > 0.5) {
      if (flag < 0.75) discard;
      if (arrowAt(vUv, dc)) discard;
    }
    gl_FragColor = vec4(uColor, alpha);
  }
`;

function ensureResources(renderer) {
  renderer.getDrawingBufferSize(bufferSize);
  const w = Math.max(1, Math.floor(bufferSize.x));
  const h = Math.max(1, Math.floor(bufferSize.y));
  const depthTarget = () => {
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    return new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, depthTexture });
  };
  // Float targets: the edge offsets and distances are stored as plain
  // floats (WebGL2 renders to them with EXT_color_buffer_float, present
  // wherever the depth-peeling pipeline's own float targets work).
  const dataTarget = () => new THREE.WebGLRenderTarget(w, h, {
    depthBuffer: false, type: THREE.FloatType,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const sized = (t, make) => {
    if (!t) return make();
    if (t.width !== w || t.height !== h) t.setSize(w, h);
    return t;
  };
  target = sized(target, depthTarget);
  occluderTarget = sized(occluderTarget, depthTarget);
  if (floatTargets === null) {
    floatTargets = renderer.extensions?.has?.('EXT_color_buffer_float') !== false;
    if (!floatTargets) console.warn('CelOutlinePass: no float render targets (EXT_color_buffer_float); screen-space outlines are off.');
  }
  if (!floatTargets) return;
  seedTarget = sized(seedTarget, dataTarget);
  refinedTarget = sized(refinedTarget, dataTarget);
  rowTarget = sized(rowTarget, dataTarget);
  if (!quadScene) {
    const depthUniforms = () => ({
      tDepth: { value: null },
      tOccluder: { value: null },
      uTexelSize: { value: new THREE.Vector2() },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uOrtho: { value: 0 },
    });
    const pass = (fragmentShader, uniforms, blend) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: QUAD_VERTEX, fragmentShader, uniforms,
        transparent: blend, blending: blend ? THREE.NormalBlending : THREE.NoBlending,
        depthTest: false, depthWrite: false,
      });
      m.toneMapped = false;
      return m;
    };
    seedMaterial = pass(SEED_FRAGMENT, {
      ...depthUniforms(),
      uJump: { value: 0.005 },
      uArrowEdges: { value: 1 },
      uArrowsOnly: { value: 0 },
    }, false);
    refineMaterial = pass(REFINE_FRAGMENT, {
      tSeed: { value: null },
      uTexelSize: { value: new THREE.Vector2() },
    }, false);
    rowMaterial = pass(ROW_FRAGMENT, {
      tSeed: { value: null },
      uTexelSize: { value: new THREE.Vector2() },
      uRadius: { value: 2 },
    }, false);
    lineMaterial = pass(LINE_FRAGMENT, {
      ...depthUniforms(),
      tRow: { value: null },
      uRadius: { value: 2 },
      uColor: { value: new THREE.Color(0, 0, 0) },
      uArrowsOnly: { value: 0 },
      uArrowEdges: { value: 1 },
    }, true);
    quadScene = new THREE.Scene();
    quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lineMaterial);
    quadScene.add(quadMesh);
    quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
}

/** Draw the full-screen quad with `material` into `renderTarget` (null: canvas). */
function runPass(renderer, material, renderTarget) {
  quadMesh.material = material;
  renderer.setRenderTarget(renderTarget);
  renderer.render(quadScene, quadCamera);
}

/** The outline width of the current mode, in world units (0: no outlines). */
function currentWidth() {
  if (general.renderStyle !== 'cel') return 0;
  const width = general.celOutlineMode === 'hull' ? general.celHullWidth : general.celOutlineWidth;
  return width > 0 ? width : 0;
}

/**
 * World units -> device pixels at the current zoom level. For orthographic
 * cameras zoom is camera.zoom; for perspective it is the dolly distance to
 * the orbit target. Zooming in far gives proportionally thick outlines.
 */
function pixelsPerWorld(camera) {
  if (camera.isOrthographicCamera) {
    return (target.height * camera.zoom) / (camera.top - camera.bottom);
  }
  const dist = app.controls ? camera.position.distanceTo(app.controls.target) : 1;
  return target.height / (2 * Math.tan((camera.fov * Math.PI / 180) / 2) * Math.max(dist, 1e-3));
}

/**
 * Draw this frame's depth targets: the outlined objects (CEL_OUTLINE_LAYER)
 * and the arrows (CEL_OCCLUDER_LAYER). Call BEFORE the main render with the
 * same scene/camera: in 3D-hull mode the atoms' and bonds' hull shells read
 * the arrows' depth while the frame is drawn (MaterialStyles.js), so that a
 * ring is not drawn across an arrow emerging from its atom. No-op outside
 * cel style.
 */
export function prepareCelOutlinePass(renderer, scene, camera) {
  prepared = 'none';
  const width = currentWidth();
  if (!(width > 0)) { setCelHullArrowDepth(null); return; }
  ensureResources(renderer);
  const arrowsOnly = general.celOutlineMode === 'hull';
  // No lines in 3D-hull mode: the arrows get no outline there.
  const lines = floatTargets && !arrowsOnly;

  // Only the outline layer, real materials (color is irrelevant, only the
  // depth buffer is consumed). The background is dropped so empty pixels
  // keep the far-plane clear depth. (3D-hull mode needs it for the hull
  // shells even with no lines to draw: where an arrow is visible.)
  const prevTarget = renderer.getRenderTarget();
  const prevMask = camera.layers.mask;
  const prevBackground = scene.background;
  const prevAutoClear = renderer.autoClear;
  scene.background = null;
  renderer.autoClear = true;
  if (lines || arrowsOnly) {
    camera.layers.set(CEL_OUTLINE_LAYER);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
  }
  // Same for the occluders (arrows): their depth only hides lines.
  camera.layers.set(CEL_OCCLUDER_LAYER);
  renderer.setRenderTarget(occluderTarget);
  renderer.clear();
  renderer.render(scene, camera);
  camera.layers.mask = prevMask;
  scene.background = prevBackground;
  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget);

  if (arrowsOnly) {
    // Hull shells thinner than a pixel sparkle and step; keep them a pixel
    // wide on screen (one-sided, like the lines' 0.75 px radius below).
    syncCelHullPixelFloor(1.0 / pixelsPerWorld(camera));
    setCelHullArrowDepth({
      texture: occluderTarget.depthTexture,
      sceneTexture: target.depthTexture,
      texelSize: [1 / occluderTarget.width, 1 / occluderTarget.height],
      near: camera.near, far: camera.far, ortho: camera.isOrthographicCamera,
      slack: 0.5 * width,
    });
  } else {
    setCelHullArrowDepth(null);
  }
  prepared = lines ? 'ready' : 'skip';
}

/**
 * Paint the outline overlay onto the canvas. Call right after the main
 * renderer.render() with the same scene/camera (after prepareCelOutlinePass;
 * it runs that itself if the pipeline did not). No-op outside cel style.
 */
export function renderCelOutlinePass(renderer, scene, camera) {
  if (prepared === 'none') prepareCelOutlinePass(renderer, scene, camera);
  const state = prepared;
  prepared = 'none';
  if (state !== 'ready') return;
  const arrowsOnly = general.celOutlineMode === 'hull';
  const width = currentWidth();

  const radius = Math.min(MAX_RADIUS, Math.max(0.75, width * pixelsPerWorld(camera)));
  const texel = [1 / target.width, 1 / target.height];
  for (const m of [seedMaterial, lineMaterial]) {
    const u = m.uniforms;
    u.tDepth.value = target.depthTexture;
    u.tOccluder.value = occluderTarget.depthTexture;
    u.uTexelSize.value.set(...texel);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
    u.uArrowEdges.value = general.celOutlineArrows === false ? 0 : 1;
    u.uArrowsOnly.value = arrowsOnly ? 1 : 0;
  }
  refineMaterial.uniforms.tSeed.value = seedTarget.texture;
  refineMaterial.uniforms.uTexelSize.value.set(...texel);
  rowMaterial.uniforms.tSeed.value = refinedTarget.texture;
  rowMaterial.uniforms.uTexelSize.value.set(...texel);
  rowMaterial.uniforms.uRadius.value = radius;
  lineMaterial.uniforms.tRow.value = rowTarget.texture;
  lineMaterial.uniforms.uRadius.value = radius;
  // Resolve the outline color live each frame (so 'auto' tracks background
  // changes). The pass writes gl_FragColor directly into the sRGB canvas with
  // no colorspace conversion, so feed the sRGB components raw rather than the
  // color-managed (linearized) channels.
  const hex = resolveCelOutlineColor();
  lineMaterial.uniforms.uColor.value.setRGB(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  );

  const prevAutoClear = renderer.autoClear;
  runPass(renderer, seedMaterial, seedTarget);
  runPass(renderer, refineMaterial, refinedTarget);
  runPass(renderer, rowMaterial, rowTarget);
  renderer.autoClear = false;
  runPass(renderer, lineMaterial, null);
  renderer.autoClear = prevAutoClear;
}
