
import * as THREE from '../backend/three/three.module.js';

import {updateAngleDisplays} from './cameraAngleControl.js';
import { app, general,mode} from '../store.js';
import {updateLattice,recomputeLatticeDirs,latticeDirsNorm} from './LatticeModule.js'


let isRendering = true;

export function pauseRendering() {
  if (!general.powerMode) {
    let now = getCurrentTime()
    alert("Power saving mode is active. Click OK to resume rendering.");
    isRendering = false;
    //console.warn(`pause rendering1 ${now}`)
  }
  else{
    return;
  }
}

export function resumeRendering() {
  if (!isRendering) {
    let now = getCurrentTime()
    isRendering = true;
    console.warn(`pause rendering ${now}`)
    animation_update(); // restart loop
  }
}

function getCurrentTime() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
}

let targetFPS = 80;           // desired max FPS
let lastFrameTime = 0;
let lastTime = performance.now();
let frames = 0;
let fps = 0;

let _counter = 1;
export function animation_update(time = 0) {

  if (!isRendering) return;
  requestAnimationFrame(animation_update);
  const interval = 1000 / targetFPS;
  if (time - lastFrameTime < interval) return;
  lastFrameTime = time;



  frames++;
  const delta = time - lastTime;
  if (delta >= 1000) { // every 1 second
    fps = (frames / delta) * 1000;
    console.log('FPS:', Math.round(fps));
    frames = 0;
    lastTime = time;
  }

  app.controls.update();
  //if (_counter%60 === 0 || _counter=== 1) {
  //  console.log('[animate] rendered camera UUID:', camera.uuid, 'controls.object UUID:', controls.object?.uuid);
  //}

  _counter = _counter+1;
  updateAngleDisplays();

  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
   if (isDarkMode && general.currentLatticeColor === 0x021302){
    app.scene.background = new THREE.Color(0x021302)
    general.defaultBackgroundColor = 0x021302
    general.currentLatticeColor = 0xE7E7E7
    updateLattice()
   }
   else if (!isDarkMode && general.currentLatticeColor === 0xE7E7E7)
   {
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.defaultBackgroundColor = 0xE7E7E7
    general.currentLatticeColor = 0x021302
    updateLattice()
   }

  // Update camera-relative lighting position
  const cameraPosition = app.camera.position.clone();

  // Single key light from upper front-right relative to camera
  app.keyLight.position.copy(cameraPosition).add(
    new THREE.Vector3(3, 4, 3).applyQuaternion(app.camera.quaternion)
  );

   
  app.renderer.render(app.scene, app.camera);
  const invCamQ = app.camera.quaternion.clone().invert();

  const { a, b, c } = latticeDirsNorm();
  app.gizmoScene.userData.aArrow.setDirection(a.clone().applyQuaternion(invCamQ));
  app.gizmoScene.userData.bArrow.setDirection(b.clone().applyQuaternion(invCamQ));
  app.gizmoScene.userData.cArrow.setDirection(c.clone().applyQuaternion(invCamQ));

  app.gizmoRenderer.render(app.gizmoScene, app.gizmoCamera);
  app.labelRenderer.render(app.scene, app.camera);

  }

