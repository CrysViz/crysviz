import * as THREE from '../backend/three/three.module.js';
import { app, groups, structureData, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';

import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {periodicWrapped,cartToFrac,fracToCart} from './LatticeModule.js'
import {loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor,getElementColor } from './ColorModule.js';

export function updateAtoms(opacity=1.0) {
  disposeGroup(groups.atomsGroup);
  groups.atomsGroup = new THREE.Group();
  let wrapped;
  let wrappedCart;
  if (general.showPeriodic) {
    wrapped = periodicWrapped(structureData.positions, structureData.elements);
    wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
    }
  else {
    wrapped = {
        elements: structureData.elements,
        frac: structureData.positions,
        srcIndex: structureData.positions.map((_, index) => index)
    };
    wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
  }

  for (let i = 0; i < wrappedCart.length; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const atomMesh = createAtomMesh(wrapped.elements[i], wrappedCart[i], originalIndex,opacity);
    atomMesh.userData.sourceIndex = originalIndex;
    atomMesh.name = originalIndex;
    groups.atomsGroup.add(atomMesh);
  }
  app.scene.add(groups.atomsGroup);
}


export function createAtomMesh(element, position, atomIndex = null,opacity=1.0) {

  const radius = (atomicRadii[element] || 1.0) * general.atomSize;
  const color = atomIndex !== null ? getIndividualAtomColor(element, atomIndex) : getElementColor(element);
  const geometry = new THREE.SphereGeometry(radius, 32, 24);
  const material = new THREE.MeshPhysicalMaterial(getAtomVisSettings(color, opacity));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.userData.element = element;
  mesh.userData.atomIndex = atomIndex;
  return mesh;
}
