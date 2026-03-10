import * as THREE from '../external/three/three.module.js';
import { app, groups,fileBrowser, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';

import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {periodicWrapped,cartToFrac,fracToCart} from './LatticeModule.js'
import {loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor,getElementColor } from './ColorModule.js';


export function updateAtoms(opacity=1.0) {
  disposeGroup(groups.atomsGroup);
  groups.atomsGroup = new THREE.Group();
  let wrapped;
  let wrappedCart;

  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position)
  let elements = [...fileBrowser.selectedStructure.elements];
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  if (general.showPeriodic) {
    wrapped = periodicWrapped(positions, elements);
    wrappedCart = fracToCart(wrapped.frac,lattice);
    }
  else {
    wrapped = {
        elements: elements,
        frac: positions,
        srcIndex: positions.map((_, index) => index)
    };
    wrappedCart = fracToCart(positions, lattice);
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
