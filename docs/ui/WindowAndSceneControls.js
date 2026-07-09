import * as THREE from '../external/three/three.module.js';
import { CSS2DRenderer } from '../external/three/CSS2DRenderer.js';
import { TrackballControls } from '../external/three/TrackballControls.js';
import { app, groups, general } from '../state/store.js';
import { setupAxisControls, latticeDirs, requestRender, setActivePipeline } from '../render/index.js';
import { getCellCenterAndDist} from '../render/index.js'
import { getIsosurfaceTriangleSortingEnabled, updateStoredIsosurfaceRenderOrder } from '../model/index.js';

// Wire the camera view buttons (x/y/z + a/b/c lattice axes + reset).
// Extracted from crystal-viewer.js initApp() (Stage 6).
export function setupCameraButtons() {
  document.getElementById('viewX').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 1., 0., 0.))};
  document.getElementById('viewY').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 0., 1., 0.))};
  document.getElementById('viewZ').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 0., 0., 1.))};


  document.getElementById('viewA').onclick = () => {app.controls.reset(); const {a} = latticeDirs(); setViewDirection(a); };
  document.getElementById('viewB').onclick = () => {app.controls.reset(); const {b} = latticeDirs(); setViewDirection(b); };
  document.getElementById('viewC').onclick = () => {app.controls.reset(); const {c} = latticeDirs(); setViewDirection(c); };
  document.getElementById('resetView').onclick = () => resetView();
}

// Build the three.js scene: renderer/camera/controls/gizmo + lights + theme.
// Extracted from crystal-viewer.js initApp() (Stage 3).
export function setupScene() {
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

  ['x', 'y', 'z', 'a', 'b', 'c'].forEach(axis => setupAxisControls(axis));


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
    app.camera = new THREE.OrthographicCamera(-size, size, size / (w/h), -size / (w/h), 0.1, 1000);
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
  app.controls.noPan= true; // disable panning as it only causes problems and does not really have a use
  app.controls.noRotate= false;
  app.controls.panSpeed = 0.8;

  app.controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN
    };

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


// window resize
export function resizeRenderer(orthographicFrustumSize) {
  if (!app.renderer || !app.camera) return;
  let w = view.clientWidth || window.innerWidth;
  let h = view.clientHeight || window.innerHeight;
  let aspect = w / h;

  if (app.camera.isOrthographicCamera) {
    const base = orthographicFrustumSize || 10;
    app.camera.left = -base;
    app.camera.right = base;
    app.camera.top = base / aspect;
    app.camera.bottom = -base / aspect;
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

  if (app.gizmoRenderer && app.gizmoCamera) {
    const gizmoDiv = document.getElementById('axesGizmo');
    if (gizmoDiv) {
      const gw = gizmoDiv.clientWidth || 110;
      const gh = gizmoDiv.clientHeight || 110;
      app.gizmoRenderer.setSize(gw, gh);
      app.gizmoCamera.aspect = gw / gh;
      app.gizmoCamera.updateProjectionMatrix();
    }
  }
  requestRender();
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

  // No labels needed inside gizmo - they're in the external legend

  // keep handles for animate()
  app.gizmoScene.userData.aArrow = aArrow;
  app.gizmoScene.userData.bArrow = bArrow;
  app.gizmoScene.userData.cArrow = cArrow;

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



export function switchCameraType() {
  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;

  if (app.useOrthographicCamera) {
    // Switch to orthographic camera
    const { center: _center, dist } = getCellCenterAndDist();
    app.orthographicFrustumSize = dist * 0.5; // Adjust this multiplier as needed
    const aspect = w / h;
    app.camera = new THREE.OrthographicCamera(
      -app.orthographicFrustumSize,
      app.orthographicFrustumSize,
      app.orthographicFrustumSize / aspect,
      -app.orthographicFrustumSize / aspect,
      0.1,
      1000
    );
  } else {
    // Switch to perspective camera
    app.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    app.orthographicFrustumSize = null;
  }
  app.controls.object = app.camera;
  ['x', 'y', 'z', 'a', 'b', 'c'].forEach(axis => setupAxisControls(axis));

  const { center, dist } = getCellCenterAndDist();
  app.camera.position.copy(center.clone().add(new THREE.Vector3(1,1,1).normalize().multiplyScalar(dist)));
  app.controls.target.copy(center);
  app.controls.update();
  resizeRenderer(app.orthographicFrustumSize);
}

// makes the center of structure as the rotation center.
export function asetViewDirection(dir) {
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
export function setViewDirection(dir, up) {
  const { center, dist } = getCellCenterAndDist();
  const n = (dir.isVector3 ? dir : new THREE.Vector3(...dir)).clone().normalize();

  // Set camera position
  app.camera.position.copy(center.clone().add(n.multiplyScalar(dist)));
  app.controls.target = center;

  console.warn(n)
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


export function resetView() { app.controls.reset(); setViewDirection(new THREE.Vector3(1,1,1)); } //CAMERA RESET



// Function to collapse all individual atom (and bond/polyhedron) expansions
export function collapseAllAtomExpansions() {
  const atomsContainers = document.querySelectorAll('.individual-atoms, .individual-bonds, .individual-polyhedra');
  const expandIcons = document.querySelectorAll('.comp-left span:last-child, .bond-expand-icon, .poly-expand-icon');

  atomsContainers.forEach(container => {
    container.style.display = 'none';
  });

  expandIcons.forEach(icon => {
    icon.style.transform = 'rotate(0deg)';
  });
}




