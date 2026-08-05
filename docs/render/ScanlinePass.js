// Hidden "8-bit" easter egg: a full-screen post-process that re-draws the
// already-rendered frame as chunky, color-quantized pixel blocks with faint
// scanlines, like an old console's video output. Same full-screen-quad
// technique as CelOutlinePass.js (there: depth-edge detection composited
// over the frame; here: the frame's own color, read back and requantized).
//
// Toggled by a deliberately undocumented keyboard shortcut (Alt+8, wired in
// AnimateModule.js) — no menu entry, no persisted setting, on purpose.

import * as THREE from '../external/three/three.module.js';
import { setScanlineBannerVisible } from '../ui/ScanlineWarningBanner.js';

let active = false;

let sourceTexture = null;
let quadScene = null;
let quadCamera = null;
let quadMaterial = null;
const bufferSize = new THREE.Vector2();

const QUAD_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Block-quantize the UV to a coarse grid (nearest-neighbor pixelation), then
// posterize each color channel to a handful of levels. Scanlines are keyed
// off the un-pixelated screen Y so they read as a display artifact on top of
// the blocks rather than aliasing with them.
const SCANLINE_FRAGMENT = /* glsl */`
  uniform sampler2D tScene;
  uniform vec2 uResolution;  // drawing-buffer size, device px
  uniform float uPixelSize;  // block size, device px
  uniform float uLevels;     // color quantization levels per channel
  varying vec2 vUv;

  void main() {
    vec2 px = vUv * uResolution;
    vec2 block = (floor(px / uPixelSize) + 0.5) * uPixelSize;
    vec3 color = texture2D(tScene, block / uResolution).rgb;
    color = floor(color * uLevels + 0.5) / uLevels;
    float scan = 0.92 + 0.08 * cos(px.y * 3.14159265 / uPixelSize);
    color *= scan;
    gl_FragColor = vec4(color, 1.0);
  }
`;

function ensureResources(renderer) {
  renderer.getDrawingBufferSize(bufferSize);
  const w = Math.max(1, Math.floor(bufferSize.x));
  const h = Math.max(1, Math.floor(bufferSize.y));
  if (!sourceTexture || sourceTexture.image.width !== w || sourceTexture.image.height !== h) {
    sourceTexture?.dispose();
    sourceTexture = new THREE.FramebufferTexture(w, h);
  }
  if (!quadScene) {
    quadMaterial = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: SCANLINE_FRAGMENT,
      uniforms: {
        tScene: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uPixelSize: { value: 7 },
        uLevels: { value: 5 },
      },
      depthTest: false,
      depthWrite: false,
    });
    quadMaterial.toneMapped = false;
    quadScene = new THREE.Scene();
    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMaterial));
    quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
}

export function isScanlineModeActive() {
  return active;
}

export function toggleScanlineMode() {
  active = !active;
  setScanlineBannerVisible(active);
  return active;
}

/**
 * Re-draw the just-rendered default framebuffer as a blocky, color-quantized
 * "8-bit" image. Call right after the main pipeline has drawn its frame (and
 * before the gizmo/label overlays, which should stay crisp) — a no-op unless
 * the mode is active.
 */
export function renderScanlinePass(renderer) {
  if (!active) return;
  ensureResources(renderer);
  renderer.copyFramebufferToTexture(sourceTexture);
  quadMaterial.uniforms.tScene.value = sourceTexture;
  quadMaterial.uniforms.uResolution.value.copy(bufferSize);
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(quadScene, quadCamera);
  renderer.autoClear = prevAutoClear;
}
