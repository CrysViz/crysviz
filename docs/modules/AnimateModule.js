
import * as THREE from '../external/three/three.module.js';

import {updateAngleDisplays} from './cameraAngleControl.js';
import { fileBrowser,app, general,mode, groups} from '../store.js';
import {updateLattice,recomputeLatticeDirs,latticeDirsNorm} from './LatticeModule.js'

import {updateRandomColors} from './DiscoModule.js'
import {structureShip} from '../store.js'

let isRendering = true;


export function pauseRendering() {
  if (!general.powerMode) {
    let now = getCurrentTime()
    //alert("Power saving mode is active. Click OK to resume rendering.");
    isRendering = false;
    console.warn(`Pause rendering ${now}`)
  }
  else{
    return;
  }
}

export function resumeRendering() {
  if (!isRendering) {
    let now = getCurrentTime()
    isRendering = true;
    console.warn(`Resume rendering ${now}`)
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
let lastTimeStorage = lastTime
let frames = 0;
let fps = 0;
let keyState={};
let isKeyComboActive = false;


let _counter = 1;


window.addEventListener('keydown', (event) => {
  keyState[event.code] = true;
  //console.log('Key pressed:', event.code, keyState);
});

window.addEventListener('keyup', (event) => {
  keyState[event.code] = false;
  //console.log('Key released:', event.code, keyState);
});

export function animation_update(time = 0) {
  if (_counter == 1){
     app.clock = new THREE.Clock();
  }
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

  const deltaStorage = time - lastTimeStorage;
  if (deltaStorage >= 5000) { 
   console.log(`Current Size of StructureShip: ~${(JSON.stringify(structureShip).length * 2 / 1024 / 1024).toFixed(2)} MB`);
   console.log(`Current Size of app: ~${(JSON.stringify(app).length * 2 / 1024 / 1024).toFixed(2)} MB`);
   console.log(`Current Size of general: ~${(JSON.stringify(general).length * 2 / 1024 / 1024).toFixed(2)} MB`);
   console.log(`Current Size of fileBrowser: ~${(JSON.stringify(fileBrowser).length * 2 / 1024 / 1024).toFixed(2)} MB`);
   console.log(`Current Size of groups: ~${(JSON.stringify(groups).length * 2 / 1024 / 1024).toFixed(2)} MB`);
   lastTimeStorage = time;
  }


  app.controls.update();
  //if (_counter%60 === 0 || _counter=== 1) {
  //  console.log('[animate] rendered camera UUID:', camera.uuid, 'controls.object UUID:', controls.object?.uuid);
  //}

  _counter = _counter+1;
  updateAngleDisplays();

  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
   if (isDarkMode && general.currentLatticeColor === 0x090A09){
    app.scene.background = new THREE.Color(0x090A09)
    general.defaultBackgroundColor = 0x090A09
    general.currentLatticeColor = 0xE7E7E7
    updateLattice()
   }
   else if (!isDarkMode && general.currentLatticeColor === 0xE7E7E7)
   {
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.defaultBackgroundColor = 0xE7E7E7
    general.currentLatticeColor = 0x090A09
    updateLattice()
   }
  
  // Update camera-relative lighting position
  const cameraPosition = app.camera.position.clone();

  // Single key light from upper front-right relative to camera
  app.keyLight.position.copy(cameraPosition).add(
    new THREE.Vector3(3, 4, 3).applyQuaternion(app.camera.quaternion)
  );

  app.renderer.render(app.scene, app.camera);
  if (app.gizmoRenderer && app.gizmoScene && app.gizmoCamera) {
    const invCamQ = app.camera.quaternion.clone().invert();
    const { a, b, c } = latticeDirsNorm();
    app.gizmoScene.userData.aArrow.setDirection(a.clone().applyQuaternion(invCamQ));
    app.gizmoScene.userData.bArrow.setDirection(b.clone().applyQuaternion(invCamQ));
    app.gizmoScene.userData.cArrow.setDirection(c.clone().applyQuaternion(invCamQ));
    app.gizmoRenderer.render(app.gizmoScene, app.gizmoCamera);
  }
  app.labelRenderer.render(app.scene, app.camera);
  if( app.angularVelocity != null ){
    if (general.autoRandomEnabled && app.angularVelocity.lengthSq() > 0) {
      const delta = app.clock.getDelta(); // seconds since last frame
      const axis = app.angularVelocity.clone().normalize();
      const angle = app.angularVelocity.length() * delta;

      const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);

      // Rotate camera position around the target
      app.camera.position.sub(app.controls.target);
      app.camera.position.applyQuaternion(q);
      app.camera.position.add(app.controls.target);

      // Rotate camera orientation
      app.camera.quaternion.premultiply(q);

      // Optionally add decay
      //app.angularVelocity.multiplyScalar(0.98); // damping if desired
      }
    }

  // Check if Ctrl+Z is pressed
  isKeyComboActive = keyState['ControlLeft'] && keyState['KeyD'];
  //console.log(keyState)
  if (isKeyComboActive) {
    // Update colors every 20th timestep
    if (_counter >= 20) {
      if (_counter%10 == 0){
        updateRandomColors();
      }
    }
  }


  }
