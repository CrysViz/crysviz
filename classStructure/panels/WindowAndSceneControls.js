import * as THREE from 'three';
import { ConvexGeometry } from 'https://unpkg.com/three@0.160.0/examples/jsm/geometries/ConvexGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'https://unpkg.com/three@0.160.0/examples/jsm/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { TrackballControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/TrackballControls.js';
import { app } from '../store.js';

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
  app.renderer = new THREE.WebGLRenderer({ antialias: true });
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
  app.controls.noPan= false;
  app.controls.noRotate= false;
  app.controls.panSpeed = 0.8;

  app.controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN
    };

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
}


export function initAxesGizmo(){
  // Axes gizmo (bottom-left)
  const gizmoDiv = document.getElementById('axesGizmo');
  app.gizmoRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  app.gizmoRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  gizmoDiv.appendChild(app.gizmoRenderer.domElement);

  // No label renderer needed for gizmo - labels are in separate legend

  app.gizmoScene = new THREE.Scene();
  app.gizmoCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  app.gizmoCamera.position.set(0, 0, 3);
  app.gizmoCamera.lookAt(0, 0, 0);

  const arrowLen = 1., headLen = 0.35, headWidth = 0.22;
  const makeArrow = (color) => new THREE.ArrowHelper(
  new THREE.Vector3(1,0,0), new THREE.Vector3(0,0,0), arrowLen, color, headLen, headWidth
  );
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

