import { fileBrowser, structureShip } from '../../../state/store.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { updateSingleAtomCutPlaneImmunity } from '../../../render/AtomsFracUpdateModule.js';
import { applyWyckoffOrbitPosition } from '../../SymmetryEditModule.js';

export function clampOpacity(value) {
  const opacity = Number(value);
  if (!Number.isFinite(opacity)) return 1;
  return Math.max(0, Math.min(1, opacity));
}

/** Clamp a per-atom/per-species radius multiplier to the slider range. */
export function clampRadiusScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(0.2, Math.min(3, scale));
}

export function getElementAtomIndices(element) {
  const atomIndices = [];
  fileBrowser.selectedStructure.elements.forEach((currentElement, index) => {
    if (currentElement === element) {
      atomIndices.push(index);
    }
  });
  return atomIndices;
}

export function getElementOpacityValues(element) {
  return Array.from(new Set(
    getElementAtomIndices(element).map((atomIndex) => {
      const atom = fileBrowser.selectedStructure.atoms[atomIndex];
      return atom.getOpacity?.() ?? atom.opacity ?? 1;
    })
  ));
}

export function setSwatchOpacity(swatch, opacity) {
  swatch.style.opacity = `${clampOpacity(opacity)}`;
}

export function areAllAtomsCutPlaneImmune(atomIndices) {
  return atomIndices.length > 0 && atomIndices.every((atomIndex) => !!fileBrowser.selectedStructure.atoms[atomIndex].cutPlaneImmune);
}

export function setCutPlaneImmunityForAtoms(atomIndices, immune) {
  atomIndices.forEach((atomIndex) => {
    const atom = fileBrowser.selectedStructure.atoms[atomIndex];
    atom.setCutPlaneImmune(immune);
    fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach((imageIndex) => {
      updateSingleAtomCutPlaneImmunity(imageIndex, immune);
    });
  });
}

export function updateAtomCoordinates(atomIndex, newCoords) {
  if (!fileBrowser.selectedStructure) {
    console.error("updateAtomCoordinates: selected structure not found");
    return;
  }
  if (atomIndex >= fileBrowser.selectedStructure.atoms.length) {
    console.error('Invalid atom index or structure data');
    return;
  }

  const orbit = fileBrowser.selectedStructure.symmetry?.mode === 'wyckoff'
    ? fileBrowser.selectedStructure.symmetry.orbitGroups?.find((group) => group.atomIndices.includes(atomIndex))
    : null;
  if (orbit) {
    applyWyckoffOrbitPosition(orbit.representativeIndex, newCoords);
    return;
  }

  fileBrowser.selectedStructure.atoms[atomIndex].position = [...newCoords];
  structureShip.container[fileBrowser.selectedRowIndex].structures[fileBrowser.stepInput].atoms[atomIndex].position = [...newCoords];

  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: false,
    reRenderOther: true,
    reRenderComposition: "open",
  });
}
