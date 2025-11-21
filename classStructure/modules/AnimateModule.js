import * as THREE from 'three';
import { ConvexGeometry } from 'https://unpkg.com/three@0.160.0/examples/jsm/geometries/ConvexGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'https://unpkg.com/three@0.160.0/examples/jsm/renderers/CSS2DRenderer.js';


import {updateAngleDisplays} from './cameraAngleControl.js';
import { app, general,mode} from '../store.js';
import {updateLattice,recomputeLatticeDirs,latticeDirsNorm} from './LatticeModule.js'


let _counter = 1;
export function animation_update() {
  requestAnimationFrame(animation_update);
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

