import { updateSingleBondColor } from '../render/BondsFracUpdateModule.js'
import { updateSingleAtomColor } from '../render/AtomsFracUpdateModule.js'
import { app,groups, general,mode,fileBrowser} from '../state/store.js';


function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

export function updateRandomColors() {
  console.log("Disco!!!")
  fileBrowser.selectedStructure.atoms.forEach((atom, atomIndex) => {
    const element = fileBrowser.selectedStructure.elements[atomIndex]; // Assuming `atom` has an `element` property
    const hex = getRandomColor();
    // Update atom color
 //   let ok = setIndividualAtomColor(element, atomIndex, hex);

    // Update associated bonds
    fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach(imageIndex => {
      const hex = getRandomColor();
      updateSingleAtomColor(atomIndex, imageIndex, element, hex)
      fileBrowser.selectedStructure.bondMapping[imageIndex]?.forEach(bondHalvIndex => {
        updateSingleBondColor(bondHalvIndex, hex);
      });
    });
  });

  // Mark colors as needing update
  groups.atomsMesh.instanceColor.needsUpdate = true;
  groups.bondsMesh.instanceColor.needsUpdate = true;
}


