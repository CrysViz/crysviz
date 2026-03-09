import { updateSingleBondColor } from '../../modules/BondsFracUpdateModule.js'
import { updateSingleAtomColor } from '../../modules/AtomsFracUpdateModule.js'
import { app,groups, general,mode,fileBrowser} from '../store.js';

import {colorHexToCss,hexToRgba,getElementColor,loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor } from '../../modules/ColorModule.js';



function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

export function updateRandomColors() {
  fileBrowser.selectedStructure.atoms.forEach((atom, atomIndex) => {
    const element = fileBrowser.selectedStructure.elements[atomIndex]; // Assuming `atom` has an `element` property
    const hex = getRandomColor();
    // Update atom color
    let ok = setIndividualAtomColor(element, atomIndex, hex);
    // Update associated bonds
    fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach(imageIndex => {
      updateSingleAtomColor(atomIndex, imageIndex, element, 1.0)
      fileBrowser.selectedStructure.bondMapping[imageIndex]?.forEach(bondHalvIndex => {
        const bondHex = getRandomColor();
        updateSingleBondColor(bondHalvIndex, bondHex);
      });
    });
  });

  // Mark colors as needing update
  groups.atomsMesh.instanceColor.needsUpdate = true;
  groups.bondsMesh.instanceColor.needsUpdate = true;
}


