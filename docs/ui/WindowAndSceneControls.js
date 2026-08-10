import * as THREE from '../external/three/three.module.js';
import { CSS2DRenderer } from '../external/three/CSS2DRenderer.js';
import { TrackballControls } from '../external/three/TrackballControls.js';
import { app, groups, general, saveLockPrefs } from '../state/store.js';
import { setupAxisControls, setupAxisLongPress, latticeDirs, requestRender, renderFrameNow, setActivePipeline, clearChargeTextureCache, rebuildChargeBadges } from '../render/index.js';
import { getCellCenterAndDist} from '../render/index.js'
import { getIsosurfaceTriangleSortingEnabled, updateStoredIsosurfaceRenderOrder } from '../model/index.js';
import { createLockToggleButton } from './LockToggleButton.js';
import { installGestureArbiter } from './GestureArbiter.js';
import { loadCrysVizFonts } from '../utils/index.js';

const cameraPanRight = new THREE.Vector3();
const cameraPanUp = new THREE.Vector3();
let fontRefreshWired = false;

function wireFontRefresh() {
  if (fontRefreshWired || !document.fonts?.ready) return;
  fontRefreshWired = true;
  const boundedFontLoad = loadCrysVizFonts();
  document.fonts.ready.then(() => boundedFontLoad).then(() => {
    clearChargeTextureCache();
    app.gizmoScene?.userData?.rebuildLabels?.();
    rebuildChargeBadges();
    requestRender();
  });
}

// Wire the camera view buttons (x/y/z + a/b/c lattice axes + reset).
// Extracted from crystal-viewer.js initApp() (Stage 6).
export function setupCameraButtons() {
  // Alignment only re-aims the camera (setViewDirection's default,
  // refit:false) — it must never touch zoom/framing, so no controls.reset()
  // here. Only the explicit "reset view" button below re-fits.
  document.getElementById('viewX').onclick = () => setViewDirection(new THREE.Vector3( 1., 0., 0.));
  document.getElementById('viewY').onclick = () => setViewDirection(new THREE.Vector3( 0., 1., 0.));
  document.getElementById('viewZ').onclick = () => setViewDirection(new THREE.Vector3( 0., 0., 1.));


  document.getElementById('viewA').onclick = () => { const {a} = latticeDirs(); setViewDirection(a); };
  document.getElementById('viewB').onclick = () => { const {b} = latticeDirs(); setViewDirection(b); };
  document.getElementById('viewC').onclick = () => { const {c} = latticeDirs(); setViewDirection(c); };
  document.getElementById('resetView').onclick = () => resetView();

  // Lock button sits directly above Reset (its own column stack) rather than
  // just another item in the wrapping row, so it reads as "modifies what
  // Reset/switching do" rather than one more view shortcut.
  const resetBtn = document.getElementById('resetView');
  const stack = document.createElement('div');
  stack.className = 'camera-reset-stack';
  const lockBtn = createLockToggleButton({
    className: 'camera-tool-btn camera-lock-btn',
    titleLocked: 'Camera view is shared across all structures — click to move each structure independently',
    titleUnlocked: 'Camera view is independent per structure — click to share one view across all structures',
    locked: app.cameraLocked !== false,
    confirmOnLock: 'Locking the camera makes every structure share this exact view going forward — any independent views other structures had will stop being used (though not lost; unlocking again brings them back). Continue?',
    onChange: (locked) => { app.cameraLocked = locked; saveLockPrefs(); },
  });
  resetBtn.parentElement.insertBefore(stack, resetBtn);
  stack.appendChild(lockBtn);
  stack.appendChild(resetBtn);
}

// Build the three.js scene: renderer/camera/controls/gizmo + lights + theme.
// Extracted from crystal-viewer.js initApp() (Stage 3).
export function setupScene() {
  wireFontRefresh();
  document.body.classList.add(`theme-standard`);
  app.scene = new THREE.Scene();

  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (isDarkMode) {
    app.scene.background = new THREE.Color(0x090A09)
    general.defaultBackgroundColor = 0x090A09
    general.currentLatticeColor = 0xE7E7E7
   } else {
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.defaultBackgroundColor = 0xE7E7E7
    general.currentLatticeColor = 0x090A09
   };

  //
  //


  //get all things related to the main view window from WindowAndSceneControls.js
  initCamera(app.useOrthographicCamera);

  initRenderer();

  // Activate the rendering pipeline before any structure/mesh exists so every
  // transparency intent is applied by a real pipeline (never the fallback).
  setActivePipeline(general.renderPipeline);

  initLabelRenderer();

  initControls();

  resizeRenderer(app.orthographicFrustumSize);


  // init Angle display windows

  ['x', 'y', 'z', 'a', 'b', 'c'].forEach(axis => { setupAxisControls(axis); setupAxisLongPress(axis); });


  initAxesGizmo();

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  app.scene.add(ambientLight);

  // Single main directional light - positioned relative to camera
  app.keyLight = new THREE.DirectionalLight(0xffffff, 5.0);
  app.keyLight.castShadow = false;
  app.scene.add(app.keyLight);
}

function disposeRendererInstance(renderer, host = null) {
  if (!renderer) return;
  const parent = host || renderer.domElement?.parentNode;
  if (parent && renderer.domElement && renderer.domElement.parentNode === parent) {
    parent.removeChild(renderer.domElement);
  } else if (renderer.domElement?.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
  try { renderer.dispose(); } catch (_) {}
  try { renderer.forceContextLoss?.(); } catch (_) {}
}

function createRendererWithFallback(primaryOptions, fallbackOptions = null) {
  try {
    return new THREE.WebGLRenderer(primaryOptions);
  } catch (primaryError) {
    if (!fallbackOptions) throw primaryError;
    try {
      return new THREE.WebGLRenderer(fallbackOptions);
    } catch (_) {
      throw primaryError;
    }
  }
}

export function disposeGroup(grp) {
  if (!grp) return;
  grp.traverse(obj => {
    if (obj.geometry) { try { obj.geometry.dispose(); } catch(_){} }
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => { try { m.dispose(); } catch(_){} });
    }
  });
  app.scene.remove(grp);
}

export function initCamera(useOrthographicCamera){
  // Initialize with orthographic camera by default
  //
  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;

  if (useOrthographicCamera) {
    const size = 20; // Initial size - will be adjusted when structure loads
    const aspect = w / h;
    // Vertical half-height fixed at `size`, horizontal scaled BY aspect (the
    // standard three.js convention) — a wide window reveals more world
    // horizontally at the same zoom, instead of shrinking the vertical
    // extent below what `size` intended (see resizeRenderer's note).
    app.camera = new THREE.OrthographicCamera(-size * aspect, size * aspect, size, -size, 0.1, 1000);
  } else {
    app.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  }

}

export function initRenderer(){
  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;
  disposeRendererInstance(app.renderer, view);
  app.renderer = null;
  try {
    // alpha:true gives the drawing buffer an alpha channel. On screen nothing
    // changes (an opaque scene.background Color still fills the frame); it lets
    // the PNG export (render/ImageExportModule.js) capture a transparent frame
    // by temporarily setting scene.background = null.
    app.renderer = createRendererWithFallback(
      { antialias: true, alpha: true, powerPreference: 'high-performance' },
      { antialias: false, alpha: true, powerPreference: 'default' }
    );
  } catch (_) {
    throw new Error('WebGL could not be initialized. Close GPU-heavy tabs or restart the browser, then reload.');
  }
  app.renderer.setSize(w, h);
  app.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // renderer.shadowMap.enabled = false;
  // renderer.outputColorSpace = THREE.SRGBColorSpace;
  // renderer.toneMapping = THREE.NoToneMapping;
  // renderer.toneMappingExposure = 1.0;

  app.renderer.shadowMap.enabled = true;
  app.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.renderer.outputColorSpace = THREE.SRGBColorSpace;
  app.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  app.renderer.toneMappingExposure = 1.2;
  app.renderer.localClippingEnabled = true;
  view.appendChild(app.renderer.domElement);
}

export function initLabelRenderer() {
  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;
  app.labelRenderer = new CSS2DRenderer();
  app.labelRenderer.setSize(w, h);
  app.labelRenderer.domElement.style.position = 'absolute';
  app.labelRenderer.domElement.style.top = '0';
  app.labelRenderer.domElement.style.left = '0';
  app.labelRenderer.domElement.style.pointerEvents = 'none';
  view.appendChild(app.labelRenderer.domElement);
}


export function initControls(){

  app.controls = new TrackballControls(app.camera, app.renderer.domElement);
  app.controls.dynamicDampingFactor=0.2;
  app.controls.rotateSpeed=1.5;
  app.controls.enableKeys = false; // Disable keyboard controls to avoid conflicts
  app.controls.noPan = true; // mouse and touch pan directly; trackball keeps rotate + zoom
  app.controls.noRotate= false;
  app.controls.panSpeed = 0.8;

  app.controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
  };

  installGestureArbiter(app.renderer.domElement);

  // update() fires 'change' whenever the camera actually moved (user input,
  // damping coast-down, or programmatic moves) — the trigger for on-demand rendering.
  app.controls.addEventListener('change', requestRender);

  app.controls.addEventListener('end', () => {
    // The CPU triangle sort only helps order-dependent (forward) blending;
    // order-independent pipelines opt out via needsCpuTriangleSort = false.
    if (app.pipeline?.needsCpuTriangleSort === false) return;
    if (getIsosurfaceTriangleSortingEnabled() && groups.activeField?.isVisible !== false) {
      updateStoredIsosurfaceRenderOrder(app.camera, groups.isosurfaceGroup);
      requestRender();
    }
  });

}

export function resetCameraPan() {
  if (app.cameraPan.x !== 0 || app.cameraPan.y !== 0) requestRender();
  app.cameraPan.x = 0;
  app.cameraPan.y = 0;
}


// window resize
export function resizeRenderer(orthographicFrustumSize) {
  if (!app.renderer || !app.camera) return;
  let w = view.clientWidth || window.innerWidth;
  let h = view.clientHeight || window.innerHeight;
  let aspect = w / h;

  if (app.camera.isOrthographicCamera) {
    const base = orthographicFrustumSize || 10;
    // Vertical half-height fixed at `base`, horizontal scaled by aspect (see
    // initCamera's note) — the previous base/aspect split shrank the
    // vertical extent on wide screens instead of growing the horizontal one,
    // which read as "too zoomed in" the wider the window got.
    app.camera.left = -base * aspect;
    app.camera.right = base * aspect;
    app.camera.top = base;
    app.camera.bottom = -base;
  } else if (app.camera.isPerspectiveCamera) {
    app.camera.aspect = aspect;
  }
  app.camera.updateProjectionMatrix();
  app.renderer.setSize(w, h);
  app.pipeline?.setSize(w, h);

  // Fat-line materials (polyhedra edges) carry a screen-resolution uniform.
  if (groups.polyhedraGroup) {
    groups.polyhedraGroup.traverse((obj) => {
      if (obj.material?.isLineMaterial) obj.material.resolution.set(w, h);
    });
  }

  if (app.labelRenderer) {
    app.labelRenderer.setSize(w, h);
  }

  resizeGizmoRenderer();
  requestRender();

  // Resizing a canvas clears its WebGL drawing buffer immediately (spec
  // behavior), and this renderer is alpha:true, so between that clear and the
  // on-demand loop's next (throttled/queued) rAF tick, the browser could
  // composite a frame with a transparent canvas — revealing the page's
  // background color underneath instead of the scene. Painting synchronously
  // right here, in the same tick as the resize, closes that gap instead of
  // leaving it to requestRender()'s flag alone.
  renderFrameNow({ interactive: false });
}

/** Re-fits the gizmo's renderer/camera to #axesGizmo's current box size —
 *  called on every main-view resize (above) and by ui/GizmoDrag.js's resize
 *  handle while the user is actively resizing the gizmo itself. */
export function resizeGizmoRenderer() {
  if (!app.gizmoRenderer || !app.gizmoCamera) return;
  const gizmoDiv = document.getElementById('axesGizmo');
  if (!gizmoDiv) return;
  const gw = gizmoDiv.clientWidth || 110;
  const gh = gizmoDiv.clientHeight || 110;
  app.gizmoRenderer.setSize(gw, gh);
  app.gizmoCamera.aspect = gw / gh;
  app.gizmoCamera.updateProjectionMatrix();
}


export function initAxesGizmo(){
  // Axes gizmo (bottom-left)
  const gizmoDiv = document.getElementById('axesGizmo');
  if (!gizmoDiv) return;
  disposeRendererInstance(app.gizmoRenderer, gizmoDiv);
  app.gizmoRenderer = null;
  try {
    app.gizmoRenderer = createRendererWithFallback(
      { antialias: true, alpha: true, powerPreference: 'low-power' },
      { antialias: false, alpha: true, powerPreference: 'low-power' }
    );
  } catch (_) {
    app.gizmoScene = null;
    app.gizmoCamera = null;
    gizmoDiv.innerHTML = '';
    gizmoDiv.style.display = 'none';
    return;
  }
  app.gizmoRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  gizmoDiv.appendChild(app.gizmoRenderer.domElement);
  gizmoDiv.style.display = '';

  // No label renderer needed for gizmo - labels are in separate legend

  app.gizmoScene = new THREE.Scene();
  app.gizmoCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  app.gizmoCamera.position.set(0, 0, 3);
  app.gizmoCamera.lookAt(0, 0, 0);

  const arrowLen = 1., headLen = 0.35, headWidth = 0.22;
  // Cylinder-shaft arrows instead of THREE.ArrowHelper: the helper's shaft is
  // a 1px THREE.Line (linewidth is inert in WebGL), while a cylinder radius
  // gives the user-adjustable axes line width (general.axesLineWidth).
  const UP = new THREE.Vector3(0, 1, 0);
  const makeArrow = (color) => {
    const material = new THREE.MeshBasicMaterial({ color });
    const shaftLen = arrowLen - headLen;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8), material);
    shaft.scale.set(general.axesLineWidth, shaftLen, general.axesLineWidth);
    shaft.position.y = shaftLen / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(headWidth / 2, headLen, 12), material);
    head.position.y = arrowLen - headLen / 2;
    const arrow = new THREE.Group();
    arrow.add(shaft);
    arrow.add(head);
    arrow.userData.shaft = shaft;
    // Same call signature the animate loop uses on ArrowHelper.
    arrow.setDirection = (dir) => {
      arrow.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
    };
    return arrow;
  };
  const aArrow = makeArrow(0xff3333);
  const bArrow = makeArrow(0x33cc33);
  const cArrow = makeArrow(0x3366ff);
  app.gizmoScene.add(aArrow, bArrow, cArrow);

  // Optional a/b/c letters at each arrow tip, as an alternative to the
  // separate #axesLegend box (toggled via GizmoDrag.js's hamburger menu,
  // general.gizmoLabelsOnArrows). Canvas-texture sprites rather than
  // TextGeometry: no font loading, and THREE.Sprite always faces the camera
  // regardless of the arrow's own rotation, so the letter stays readable as
  // the gizmo spins with the view. Parented to the arrow so its position
  // (but not its billboarded orientation) follows the arrow direction.
  const makeLabel = (letter, color) => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.font = "bold 92px 'CrysViz Sans', sans-serif";
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, size / 2, size / 2 + 4);
    const texture = new THREE.CanvasTexture(canvas);
    // Mipmapping blurs a small, thin-stroked text texture down to near
    // nothing at the on-screen sizes this sprite renders at (the gizmo box
    // is only ~90px); a flat linear filter keeps the letter crisp instead.
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.34, 0.34, 1);
    // Just past the tip, not on top of the cone: a label centered on the
    // arrow's own axis this close to the head reads as overlapping it.
    // Offset stays modest — an arrow pointing near-straight "up" in camera
    // space already sits close to the gizmo camera's frustum edge at
    // y=arrowLen, so too large a gap here would clip off the top instead.
    sprite.position.y = arrowLen + 0.1;
    sprite.visible = general.gizmoLabelsOnArrows;
    return sprite;
  };
  const aLabel = makeLabel('a', 0xff3333);
  const bLabel = makeLabel('b', 0x33cc33);
  const cLabel = makeLabel('c', 0x3366ff);
  aArrow.add(aLabel);
  bArrow.add(bLabel);
  cArrow.add(cLabel);

  // keep handles for animate()
  app.gizmoScene.userData.aArrow = aArrow;
  app.gizmoScene.userData.bArrow = bArrow;
  app.gizmoScene.userData.cArrow = cArrow;
  app.gizmoScene.userData.aLabel = aLabel;
  app.gizmoScene.userData.bLabel = bLabel;
  app.gizmoScene.userData.cLabel = cLabel;
  const gizmoScene = app.gizmoScene;
  gizmoScene.userData.rebuildLabels = () => {
    const specs = [
      ['aLabel', aArrow, 'a', 0xff3333],
      ['bLabel', bArrow, 'b', 0x33cc33],
      ['cLabel', cArrow, 'c', 0x3366ff],
    ];
    for (const [key, arrow, letter, color] of specs) {
      const oldLabel = gizmoScene.userData[key];
      oldLabel?.parent?.remove(oldLabel);
      oldLabel?.material?.map?.dispose();
      oldLabel?.material?.dispose();
      const label = makeLabel(letter, color);
      arrow.add(label);
      gizmoScene.userData[key] = label;
    }
  };

function sizeGizmo(){
  const w = gizmoDiv.clientWidth || 110;
  const h = gizmoDiv.clientHeight || 110;
  app.gizmoRenderer.setSize(w, h);
  app.gizmoCamera.aspect = w / h;
  app.gizmoCamera.updateProjectionMatrix();
}
  sizeGizmo();
}

/** Re-apply general.axesLineWidth to the gizmo arrows' shaft radii (the
 *  slider handler in ControlsWiring calls this on input). */
export function updateAxesGizmoWidth() {
  const scene = app.gizmoScene;
  if (!scene) return;
  for (const key of ['aArrow', 'bArrow', 'cArrow']) {
    const shaft = scene.userData[key]?.userData?.shaft;
    if (shaft) {
      shaft.scale.x = general.axesLineWidth;
      shaft.scale.z = general.axesLineWidth;
    }
  }
}

/** Toggle the a/b/c letters between the separate #axesLegend box (default)
 *  and billboarded sprites at each gizmo arrow's tip (ui/GizmoDrag.js's
 *  hamburger menu calls this). Both are never shown at once — enabling one
 *  hides the other, respecting the current general.showAxes visibility. */
export function setGizmoLabelsOnArrows(enabled) {
  general.gizmoLabelsOnArrows = enabled;
  const scene = app.gizmoScene;
  if (scene?.userData) {
    for (const key of ['aLabel', 'bLabel', 'cLabel']) {
      if (scene.userData[key]) scene.userData[key].visible = enabled;
    }
  }
  const legend = document.getElementById('axesLegend');
  if (legend) legend.style.display = (general.showAxes && !enabled) ? '' : 'none';
  requestRender();
}




export function switchCameraType() {
  resetCameraPan();
  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;

  if (app.useOrthographicCamera) {
    // Switch to orthographic camera
    const { center: _center, dist } = getCellCenterAndDist();
    app.orthographicFrustumSize = dist * 0.5; // Adjust this multiplier as needed
    const aspect = w / h;
    // See initCamera's note: vertical half-height fixed, horizontal scaled
    // by aspect.
    app.camera = new THREE.OrthographicCamera(
      -app.orthographicFrustumSize * aspect,
      app.orthographicFrustumSize * aspect,
      app.orthographicFrustumSize,
      -app.orthographicFrustumSize,
      0.1,
      1000
    );
  } else {
    // Switch to perspective camera
    app.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    app.orthographicFrustumSize = null;
  }
  app.controls.object = app.camera;
  ['x', 'y', 'z', 'a', 'b', 'c'].forEach(axis => { setupAxisControls(axis); setupAxisLongPress(axis); });

  const { center, dist } = getCellCenterAndDist();
  app.camera.position.copy(center.clone().add(new THREE.Vector3(1,1,1).normalize().multiplyScalar(dist)));
  app.controls.target.copy(center);
  app.controls.update();
  resizeRenderer(app.orthographicFrustumSize);
}

// makes the center of structure as the rotation center.
export function asetViewDirection(dir) {
  const panX = app.cameraPan.x;
  const panY = app.cameraPan.y;
  resetCameraPan();
  removeCameraPanOffset(panX, panY);
  //console.log('[setView] rendered camera UUID:', camera.uuid, 'controls.object UUID:', controls.object?.uuid);
  const { center, dist } = getCellCenterAndDist();
  const n = (dir.isVector3 ? dir : new THREE.Vector3(...dir)).clone().normalize();
  if (n.x === 0 && n.y === 1 && n.z === 0){
    //console.log("changing camer.up to 0.,0.,1.")
    app.camera.up = new THREE.Vector3(0.,0.,1.);}
  else {
    app.camera.up = new THREE.Vector3(0.,1.,0.);
    //console.log("changing camer.up to 0.,1.,0.")
  }

  app.camera.position.copy(center.clone().add(n.multiplyScalar(dist)));
  app.controls.target = center;
  app.controls.update();
}
// Aim the camera along `dir`. Default (refit:false) is a pure re-aim: it
// keeps the controls' current target and the camera's current distance from
// it (and, since zoom is never touched here, the orthographic camera's
// current zoom too) — so alignment buttons rotate the view without
// re-fitting to the structure or disturbing the user's zoom. Pass
// refit:true (resetView() only) to instead recompute center/distance from
// the structure's bounding box, i.e. fit the view like the old behavior.
export function setViewDirection(dir, { refit = false } = {}) {
  const panX = app.cameraPan.x;
  const panY = app.cameraPan.y;
  resetCameraPan();
  removeCameraPanOffset(panX, panY);
  const n = (dir.isVector3 ? dir : new THREE.Vector3(...dir)).clone().normalize();

  let dist;
  if (refit) {
    const fit = getCellCenterAndDist();
    app.controls.target = fit.center;
    dist = fit.dist;
  } else {
    dist = app.camera.position.distanceTo(app.controls.target);
  }

  // Set camera position
  app.camera.position.copy(app.controls.target.clone().add(n.multiplyScalar(dist)));

  // Set camera up vector based on the desired view
  if (n.y == 0 && n.z == 0) {
    // X towards me: up is Y, Z to the right
    app.camera.up = new THREE.Vector3(0, 0, 1);
    console.warn("setting z up")
  } else if (n.z == 0 && n.x == 0) {
    // Y towards me: up is Z, X to the right
    app.camera.up = new THREE.Vector3(1, 0, 0);
  } else if (n.x == 0 && n.y == 0) {
    // Z towards me: up is Y, X to the right
    app.camera.up = new THREE.Vector3(0, 1, 0);
  } else {
    // Default up
    app.camera.up = new THREE.Vector3(0, 1, 0);
  }

  app.controls.update();
}


/**
 * Clear TrackballControls' in-flight rotation momentum (and zoom/pan
 * convergence) so a just-set camera transform sticks exactly, rather than
 * drifting further on the next few frames. TrackballControls' dynamic
 * damping keeps a decaying angular "velocity" (_lastAngle/_lastAxis) alive
 * for a bit AFTER the mouse is released — its own reset() clears
 * position/target/zoom but never this momentum (external/three/TrackballControls.js's
 * _rotateCamera). Left alone, a drag released right before switching
 * structures (or restoring a saved view) keeps nudging the camera for a few
 * more frames on whatever position we just set it to — which is what read as
 * "my rotation doesn't stick, I have to switch away and back again" (the
 * extra round trip just gives the decay time to fully settle first).
 */
function stopCameraMomentum() {
  const c = app.controls;
  if (!c) return;
  c._lastAngle = 0;
  c._movePrev.copy(c._moveCurr);
  c._zoomStart.copy(c._zoomEnd);
  c._panStart.copy(c._panEnd);
}

/** Recompute the orthographic camera's frustum size (its actual zoom level)
 *  from the currently selected structure. setViewDirection's refit only ever
 *  moves camera position/target — for the orthographic camera (the default)
 *  the visible scale is the frustum size, a separate number it never
 *  touches. Without this, Reset View (and anything else that "re-fits")
 *  silently kept whatever zoom was set when the camera was first fit,
 *  regardless of how much the structure has since changed (e.g. a supercell
 *  tiled much bigger). No-op for the perspective camera, whose zoom is just
 *  camera distance — already handled by refit. */
function refitOrthographicFrustum() {
  if (!app.useOrthographicCamera) return;
  const { dist } = getCellCenterAndDist();
  app.orthographicFrustumSize = dist * 0.5;
  resizeRenderer(app.orthographicFrustumSize);
}

function removeCameraPanOffset(x, y) {
  if (x === 0 && y === 0) return;
  app.camera.updateMatrixWorld(true);
  cameraPanRight.setFromMatrixColumn(app.camera.matrixWorld, 0);
  cameraPanUp.setFromMatrixColumn(app.camera.matrixWorld, 1);
  app.camera.position.addScaledVector(cameraPanRight, -x);
  app.camera.position.addScaledVector(cameraPanUp, -y);
}

export function resetView() {
  resetCameraPan();
  app.controls.reset();
  stopCameraMomentum();
  setViewDirection(new THREE.Vector3(1,1,1), { refit: true });
  refitOrthographicFrustum();
} //CAMERA RESET

/**
 * Fit distance/zoom to the currently selected structure. Default
 * (resetDirection:false) keeps whatever direction the camera is already
 * looking from — used for generating a supercell (SuperCellModule.js), where
 * the tiled structure is usually a very different size than whatever the
 * camera was fit to, but it's still the SAME structure you were just looking
 * at, so the viewing angle shouldn't jump.
 *
 * resetDirection:true instead snaps to the canonical (1,1,1) direction, like
 * resetView — used for the per-structure camera lock's first-ever view of a
 * given file-browser row (FileBrowswerPanel.js) specifically because
 * "keep the current direction" is the wrong default there: the current
 * direction may belong to a DIFFERENT structure's own customization (e.g.
 * you duplicated a structure, unlocked, rotated the copy, then visited the
 * original for the first time since unlocking) — inheriting it would read as
 * "the original moved too", when really it just never had a view of its own
 * yet and should start fresh instead of borrowing someone else's.
 */
export function fitCameraToCurrentStructure({ resetDirection = false } = {}) {
  const panX = app.cameraPan.x;
  const panY = app.cameraPan.y;
  resetCameraPan();
  removeCameraPanOffset(panX, panY);
  const { center, dist } = getCellCenterAndDist();
  const dir = resetDirection
    ? new THREE.Vector3(1, 1, 1).normalize()
    : app.camera.position.clone().sub(app.controls.target).normalize();
  if (resetDirection) app.camera.up.set(0, 1, 0);
  app.camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  app.controls.target.copy(center);
  refitOrthographicFrustum();
  stopCameraMomentum();
  app.controls.update();
}

/** Capture enough of the current camera/controls state to restore this exact
 *  view later — the per-structure camera lock (FileBrowswerPanel.js) saves
 *  this for whichever structure the camera is currently framing, right
 *  before switching to a different one.
 *
 *  Stops momentum first: a drag released right before switching away leaves
 *  rotation still decaying (see stopCameraMomentum), so position/target read
 *  here would otherwise be a moving target — a snapshot taken 50ms later
 *  wouldn't match one taken now, and it would keep drifting a little further
 *  even while dormant, only for as long as it takes to get decayed away. */
export function captureCameraSnapshot() {
  stopCameraMomentum();
  return {
    position: app.camera.position.clone(),
    target: app.controls.target.clone(),
    up: app.camera.up.clone(),
    quaternion: app.camera.quaternion.clone(),
    pan: { x: app.cameraPan.x, y: app.cameraPan.y },
    zoom: app.camera.zoom,
    orthographicFrustumSize: app.useOrthographicCamera ? app.orthographicFrustumSize : null,
  };
}

/** Restore a snapshot captured by captureCameraSnapshot(). */
export function applyCameraSnapshot(snapshot) {
  if (!snapshot) return;
  const panX = Number.isFinite(snapshot.pan?.x) ? snapshot.pan.x : 0;
  const panY = Number.isFinite(snapshot.pan?.y) ? snapshot.pan.y : 0;
  app.camera.position.copy(snapshot.position);
  app.controls.target.copy(snapshot.target);
  app.camera.up.copy(snapshot.up);
  if (snapshot.quaternion) app.camera.quaternion.copy(snapshot.quaternion);
  app.cameraPan.x = panX;
  app.cameraPan.y = panY;
  if (snapshot.zoom != null) {
    app.camera.zoom = snapshot.zoom;
    app.camera.updateProjectionMatrix();
  }
  if (app.useOrthographicCamera && snapshot.orthographicFrustumSize != null) {
    app.orthographicFrustumSize = snapshot.orthographicFrustumSize;
    resizeRenderer(app.orthographicFrustumSize);
  }
  stopCameraMomentum();
  if (panX !== 0 || panY !== 0) {
    app.camera.updateMatrixWorld(true);
    cameraPanRight.setFromMatrixColumn(app.camera.matrixWorld, 0);
    cameraPanUp.setFromMatrixColumn(app.camera.matrixWorld, 1);
    app.camera.position.addScaledVector(cameraPanRight, -panX);
    app.camera.position.addScaledVector(cameraPanUp, -panY);
  }
  app.controls.update();
  if (panX !== 0 || panY !== 0) {
    app.camera.updateMatrixWorld(true);
    cameraPanRight.setFromMatrixColumn(app.camera.matrixWorld, 0);
    cameraPanUp.setFromMatrixColumn(app.camera.matrixWorld, 1);
    app.camera.position.addScaledVector(cameraPanRight, panX);
    app.camera.position.addScaledVector(cameraPanUp, panY);
  }
  app.camera.updateMatrixWorld(true);
}

/**
 * Re-center the camera's existing view on the (possibly moved) structure
 * center without touching rotation or zoom: only the target moves, and the
 * camera keeps the exact same offset (direction + distance) from it. Used
 * when the displayed structure changes (new upload, file-browser row/step
 * switch) so the user's chosen view survives across structures — the initial
 * fit-to-structure framing (switchCameraType) only runs once, for the very
 * first structure shown.
 */
export function recenterCamera() {
  const panX = app.cameraPan.x;
  const panY = app.cameraPan.y;
  resetCameraPan();
  removeCameraPanOffset(panX, panY);
  const { center } = getCellCenterAndDist();
  const offset = app.camera.position.clone().sub(app.controls.target);
  app.controls.target.copy(center);
  app.camera.position.copy(center.clone().add(offset));
  // A drag released just before switching structures would otherwise keep
  // decaying its rotation momentum onto whatever offset we just preserved
  // (see stopCameraMomentum's note) — most noticeable right after a quick
  // rotate-then-switch.
  stopCameraMomentum();
  app.controls.update();
}



// Function to collapse all individual atom (and bond/polyhedron) expansions
export function collapseAllAtomExpansions() {
  const atomsContainers = document.querySelectorAll('.individual-atoms, .individual-bonds, .individual-polyhedra');
  const expandIcons = document.querySelectorAll('.comp-expand-icon, .bond-expand-icon, .poly-expand-icon');

  atomsContainers.forEach(container => {
    container.style.display = 'none';
  });

  expandIcons.forEach(icon => {
    icon.style.transform = 'rotate(0deg)';
  });
}
