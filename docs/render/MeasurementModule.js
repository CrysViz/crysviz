import * as THREE from '../external/three/three.module.js';
import { measurements,app, general, fileBrowser, mode} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import { CSS2DObject } from '../external/three/CSS2DRenderer.js';
import { fracToCart } from '../math/index.js';

let measureLabel = null;

// Helper function for creating measurement markers.
// A single translucent sphere reads closer to a ghost atom and is cheaper than stacked rings.
export function createAtomRings(position, radius, innerColor, outerColor, element = null) {
  const shellGroup = new THREE.Group();
  const shellGeometry = new THREE.SphereGeometry(radius * 1.06, 18, 14);
  const shellMaterial = new THREE.MeshBasicMaterial({
    color: innerColor,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const shell = new THREE.Mesh(shellGeometry, shellMaterial);
  shellGroup.add(shell);

  shellGroup.position.copy(position);
  shellGroup.userData = {
    isAtomMarker: true,
    markerType: 'shell',
    element,
    accentColor: innerColor,
    outlineColor: outerColor,
  };

  return shellGroup;
}

export function updateMeasurementMarkers() {
  // Update all measurement shells to reflect current atom size.
  measurements.measureLines.forEach(item => {
    if (item.userData && item.userData.isAtomMarker && item.userData.markerType === 'shell') {
      const element = item.userData.element;
      if (element) {
        const newRadius = getAtomRadius(element);
        item.children.forEach((child) => {
          if (child.geometry && child.geometry.type === 'SphereGeometry') {
            child.geometry.dispose();
            child.geometry = new THREE.SphereGeometry(newRadius * 1.06, 18, 14);
          }
        });
      }
    }
  });
}

export function getAtomRadius(element) { // exists also in crystal-viewer. needs to be unified and moved to utilities for further usage
  return (atomicRadii[element] || 1.0) * general.atomSize;
}


export function clearMeasureGraphics(){
  if (measureLabel){ app.scene.remove(measureLabel); measureLabel = null; }
}


export function clearAllMeasurements(){
  // Clear all stored measurements
  measurements.measureLines.forEach(item => {
    app.scene.remove(item);
    if (item.geometry) item.geometry.dispose();
  });
  measurements.measureLabels.forEach(label => {
    app.scene.remove(label);
  });
  measurements.measureLines = [];
  measurements.measureLabels = [];
  measurements.selectedAtoms = [];
  clearMeasureGraphics();
}

export function calculateAngle(atom1, atom2, atom3) {
  // Calculate angle between three atoms: atom1-atom2-atom3 (atom2 is vertex)
  const p1 = atom1.position.clone();
  const p2 = atom2.position.clone();
  const p3 = atom3.position.clone();

  const v1 = p1.sub(p2).normalize();
  const v2 = p3.sub(p2).normalize();

  const dotProduct = v1.dot(v2);
  const angle = Math.acos(Math.max(-1, Math.min(1, dotProduct)));
  return angle * (180 / Math.PI); // Convert to degrees
}

function createMeasurementAtomRef(atom) {
  const structure = fileBrowser.selectedStructure;
  const atomIndex = atom?.userData?.atomIndex;
  if (!structure || atomIndex == null || !structure.atoms?.[atomIndex]) return null;

  const baseFrac = structure.atoms[atomIndex].position;
  const wrappedFrac = atom.userData?.wrappedFrac;
  const imageOffset = wrappedFrac
    ? wrappedFrac.map((value, axis) => Math.round(value - baseFrac[axis]))
    : [0, 0, 0];
  const resolvedFrac = baseFrac.map((value, axis) => value + imageOffset[axis]);

  return {
    atomIndex,
    element: atom.userData?.element ?? structure.elements?.[atomIndex] ?? '?',
    imageOffset,
    lastResolvedFrac: resolvedFrac,
  };
}

function cloneMeasurementRef(ref) {
  if (!ref) return null;
  return {
    atomIndex: ref.atomIndex,
    element: ref.element,
    imageOffset: Array.isArray(ref.imageOffset) ? [...ref.imageOffset] : [0, 0, 0],
    lastResolvedFrac: Array.isArray(ref.lastResolvedFrac) ? [...ref.lastResolvedFrac] : null,
  };
}

function buildLegacyMeasurementRef(atomIndex, savedPosition = null) {
  const wrapped = fileBrowser.selectedStructure?.periodic?.wrapped;
  if (!wrapped || atomIndex == null) return null;

  let bestIndex = -1;
  let bestDistance = Infinity;
  const target = savedPosition?.length ? new THREE.Vector3(...savedPosition) : null;

  for (let i = 0; i < wrapped.cart.length; i++) {
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    if (srcIdx !== atomIndex) continue;

    if (!target) {
      bestIndex = i;
      break;
    }

    const distance = target.distanceTo(new THREE.Vector3(...wrapped.cart[i]));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) return null;

  return createMeasurementAtomRef({
    position: new THREE.Vector3(...wrapped.cart[bestIndex]),
    userData: {
      atomIndex,
      element: wrapped.elements?.[bestIndex] ?? fileBrowser.selectedStructure?.elements?.[atomIndex] ?? '?',
      wrappedFrac: wrapped.frac?.[bestIndex] ? [...wrapped.frac[bestIndex]] : null,
    },
  });
}

function ensureMeasurementRef(refOrIndex, savedPosition = null) {
  if (refOrIndex && typeof refOrIndex === 'object' && refOrIndex.atomIndex != null) {
    if (!Array.isArray(refOrIndex.imageOffset)) refOrIndex.imageOffset = [0, 0, 0];
    if (!Array.isArray(refOrIndex.lastResolvedFrac)) {
      const base = fileBrowser.selectedStructure?.atoms?.[refOrIndex.atomIndex]?.position;
      refOrIndex.lastResolvedFrac = base
        ? base.map((value, axis) => value + refOrIndex.imageOffset[axis])
        : null;
    }
    if (!refOrIndex.element) {
      refOrIndex.element = fileBrowser.selectedStructure?.elements?.[refOrIndex.atomIndex] ?? '?';
    }
    return refOrIndex;
  }
  return buildLegacyMeasurementRef(refOrIndex, savedPosition);
}

function resolveMeasurementAtom(refOrIndex, savedPosition = null) {
  const structure = fileBrowser.selectedStructure;
  const ref = ensureMeasurementRef(refOrIndex, savedPosition);
  if (!structure || !ref || !structure.atoms?.[ref.atomIndex]) return null;

  const baseFrac = structure.atoms[ref.atomIndex].position;
  const imageOffset = baseFrac.map((value, axis) => {
    const previous = ref.lastResolvedFrac?.[axis] ?? value + (ref.imageOffset?.[axis] ?? 0);
    return Math.round(previous - value);
  });
  const resolvedFrac = baseFrac.map((value, axis) => value + imageOffset[axis]);
  const cart = fracToCart([resolvedFrac], structure.lattice)[0];

  ref.imageOffset = imageOffset;
  ref.lastResolvedFrac = resolvedFrac;
  ref.element = ref.element ?? structure.elements?.[ref.atomIndex] ?? '?';

  return {
    position: new THREE.Vector3(...cart),
    userData: {
      atomIndex: ref.atomIndex,
      element: ref.element,
      imageOffset: [...imageOffset],
      wrappedFrac: [...resolvedFrac],
      measurementRef: ref,
    },
  };
}

export function serializeMeasurementRef(ref) {
  const normalized = ensureMeasurementRef(ref);
  return normalized ? cloneMeasurementRef(normalized) : null;
}

export function addAngleMeasurement(atom1, atom2, atom3) {
  const atom1Ref = createMeasurementAtomRef(atom1);
  const atom2Ref = createMeasurementAtomRef(atom2);
  const atom3Ref = createMeasurementAtomRef(atom3);
  const angle = calculateAngle(atom1, atom2, atom3);

  // Create angle arc visualization
  const p1 = atom1.position.clone();
  const p2 = atom2.position.clone(); // vertex
  const p3 = atom3.position.clone();

  // Create thick dashed cylinders from vertex to other atoms (ORANGE for angles)
  function createDashedCylinder(startPos, endPos, color) {
    const distance = startPos.distanceTo(endPos);
    const direction = new THREE.Vector3().subVectors(endPos, startPos);

    const dashLength = 0.25;
    const gapLength = 0.15;
    const segmentLength = dashLength + gapLength;
    const numSegments = Math.floor(distance / segmentLength);

    const cylinderGroup = new THREE.Group();

    for (let i = 0; i < numSegments; i++) {
      const segmentStart = i * segmentLength;
      const segmentGeometry = new THREE.CylinderGeometry(0.06, 0.06, dashLength, 8); // Slightly thinner than distance
      const segmentMaterial = new THREE.MeshBasicMaterial({ color: color });
      const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);

      const segmentCenter = startPos.clone().add(direction.clone().normalize().multiplyScalar(segmentStart + dashLength/2));
      segment.position.copy(segmentCenter);
      segment.lookAt(endPos);
      segment.rotateX(Math.PI / 2);

      cylinderGroup.add(segment);
    }
    return cylinderGroup;
  }

  // Create orange dashed cylinders for angle measurement
  const angleColor = 0xff6600; // Orange for angle measurements
  const angleLine1 = createDashedCylinder(p2, p1, angleColor);
  const angleLine2 = createDashedCylinder(p2, p3, angleColor);

  // Store atom indices for dynamic updates
  angleLine1.userData = {
    type: 'angle',
    atom1Ref,
    atom2Ref,
    atom3Ref,
    lineIndex: 1 // first line (vertex to atom1)
  };

  angleLine2.userData = {
    type: 'angle',
    atom1Ref,
    atom2Ref,
    atom3Ref,
    lineIndex: 2 // second line (vertex to atom3)
  };

  app.scene.add(angleLine1);
  app.scene.add(angleLine2);
  measurements.measureLines.push(angleLine1);
  measurements.measureLines.push(angleLine2);

  // Add markers to all three atoms
  [atom1, atom2, atom3].forEach((atom, index) => {
    const atomRadius = getAtomRadius(atom.userData.element);
    const color = index === 1 ? 0x00ff00 : 0x00ff88; // Vertex gets different color

    const rings = createAtomRings(atom.position, atomRadius, color, 0x000000, atom.userData.element);
    rings.userData = {
      ...rings.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
      type: 'angleMarker',
      atomRef: index === 0 ? atom1Ref : (index === 1 ? atom2Ref : atom3Ref),
      atom1Ref,
      atom2Ref,
      atom3Ref
    };
    app.scene.add(rings);
    measurements.measureLines.push(rings);

  });

  // Create angle label at vertex
  const div = document.createElement('div');
  div.className = 'measure-label';
  div.style.background = 'rgba(0, 255, 0, 0.9)';
  div.style.border = '2px solid #00ff00';
  div.style.color = '#000000';
  div.style.fontWeight = '700';
  div.style.fontSize = '14px';
  div.style.padding = '2px 6px';
  div.style.borderRadius = '4px';
  const elements = [atom1.userData.element, atom2.userData.element, atom3.userData.element];
  div.textContent = `∠${elements[0]}-${elements[1]}-${elements[2]}: ${angle.toFixed(1)}°`;

  const label = new CSS2DObject(div);
  label.position.copy(p2);

  // Store atom indices for dynamic updates
  label.userData = {
    type: 'angle',
    atom1Ref,
    atom2Ref,
    atom3Ref
  };

  app.scene.add(label);
  measurements.measureLabels.push(label);
}


export function addDistanceMeasurement(atom1, atom2) {
  const atom1Ref = createMeasurementAtomRef(atom1);
  const atom2Ref = createMeasurementAtomRef(atom2);
  // Create thick dashed cylinder for distance measurement (BLUE for distance)
  const pa = atom1.position.clone(), pb = atom2.position.clone();
  const distance = pa.distanceTo(pb);
  const direction = new THREE.Vector3().subVectors(pb, pa);
  const midpoint = new THREE.Vector3().addVectors(pa, pb).multiplyScalar(0.5);

  // Create multiple cylinder segments for dashed effect
  const dashLength = 0.3;
  const gapLength = 0.2;
  const segmentLength = dashLength + gapLength;
  const numSegments = Math.floor(distance / segmentLength);

  const cylinderGroup = new THREE.Group();

  for (let i = 0; i < numSegments; i++) {
    const segmentStart = i * segmentLength;
    const segmentGeometry = new THREE.CylinderGeometry(0.08, 0.08, dashLength, 8); // Thick cylinder
    const segmentMaterial = new THREE.MeshBasicMaterial({ color: 0x0066ff }); // Blue for distance
    const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);

    // Position segment along the line
    const segmentCenter = pa.clone().add(direction.clone().normalize().multiplyScalar(segmentStart + dashLength/2));
    segment.position.copy(segmentCenter);
    segment.lookAt(pb);
    segment.rotateX(Math.PI / 2);

    cylinderGroup.add(segment);
  }

  // Store atom indices for dynamic updates
  cylinderGroup.userData = {
    type: 'distance',
    atom1Ref,
    atom2Ref
  };

  app.scene.add(cylinderGroup);
  measurements.measureLines.push(cylinderGroup);

  // Create atom-size-aware surface markers

  // Get atom radii for proper scaling
  const atomRadiusA = getAtomRadius(atom1.userData.element);
  const atomRadiusB = getAtomRadius(atom2.userData.element);
  // Add scaling rings to both atoms
  const ringsA = createAtomRings(pa, atomRadiusA, 0xffff00, 0x000000, atom1.userData.element); // Yellow inner, black outer
  ringsA.userData = {
    ...ringsA.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
    type: 'distanceMarker',
    atomRef: atom1Ref,
    measurementIndex: measurements.measureLines.length // Reference to the cylinder group
  };
  app.scene.add(ringsA);
  measurements.measureLines.push(ringsA);

  const ringsB = createAtomRings(pb, atomRadiusB, 0xffff00, 0x000000, atom2.userData.element); // Yellow inner, black outer
  ringsB.userData = {
    ...ringsB.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
    type: 'distanceMarker',
    atomRef: atom2Ref,
    measurementIndex: measurements.measureLines.length - 1 // Reference to the cylinder group
  };
  app.scene.add(ringsB);
  measurements.measureLines.push(ringsB);

  // Create a compact black and white floating label
  const mid = pa.clone().add(pb).multiplyScalar(0.5);
  const div = document.createElement('div');
  div.className = 'measure-label';
  div.style.background = 'rgba(255, 255, 255, 0.95)';
  div.style.border = '2px solid #000000';
  div.style.color = '#000000';
  div.style.fontWeight = '700';
  div.style.fontSize = '14px';
  div.style.padding = '2px 6px';
  div.style.textShadow = '1px 1px 2px rgba(255,255,255,0.8)';
  div.style.boxShadow = '0 3px 8px rgba(0,0,0,0.4)';
  div.style.borderRadius = '4px';
  const a = atom1.userData.element, b = atom2.userData.element;
  const d = pa.distanceTo(pb);
  //div.textContent = `${a}—${b}: ${formatÅ(d)} Å`;
  div.textContent = `${formatÅ(d)} Å`;
  const label = new CSS2DObject(div);
  label.position.copy(mid);

  // Store atom indices for dynamic updates
  label.userData = {
    type: 'distance',
    atom1Ref,
    atom2Ref
  };

  app.scene.add(label);
  measurements.measureLabels.push(label);
}

export function drawMeasureGraphics(){
  clearMeasureGraphics();

  // Show preview lines/indicators for current selection
  if (mode.measureMode === 'distance' && measurements.selectedAtoms.length === 1) {
    // Show preview for distance measurement (1 atom selected)
    const atom1 = measurements.selectedAtoms[0];
    const div = document.createElement('div');
    div.className = 'measure-label';
    div.style.background = 'rgba(255, 255, 255, 0.8)';
    div.style.border = '2px solid #000000';
    div.style.color = '#000000';
    div.style.fontWeight = '700';
    div.style.fontSize = '12px';
    div.style.padding = '4px 8px';
    div.style.borderRadius = '4px';
    //div.textContent = `${atom1.userData.element} — ? (click 2nd atom)`;
    div.textContent = `choose 2nd atom`;
    measureLabel = new CSS2DObject(div);
    measureLabel.position.copy(atom1.position);
    app.scene.add(measureLabel);
  } else if (mode.measureMode === 'angle' && measurements.selectedAtoms.length > 0) {
    // Show preview for angle measurement
    const div = document.createElement('div');
    div.className = 'measure-label';
    div.style.background = 'rgba(0, 255, 0, 0.8)';
    div.style.border = '2px solid #00ff00';
    div.style.color = '#000000';
    div.style.fontWeight = '700';
    div.style.fontSize = '10px';
    div.style.padding = '2px 4px';
    div.style.borderRadius = '4px';

    if (measurements.selectedAtoms.length === 1) {
      div.textContent = `${measurements.selectedAtoms[0].userData.element} — ? — ? (select vertex)`;
    } else if (measurements.selectedAtoms.length === 2) {
      div.textContent = `${measurements.selectedAtoms[0].userData.element} — ${measurements.selectedAtoms[1].userData.element} — ? (select 3rd atom)`;
    }

    measureLabel = new CSS2DObject(div);
    measureLabel.position.copy(measurements.selectedAtoms[measurements.selectedAtoms.length - 1].position);
    app.scene.add(measureLabel);
  }
}

export function clearMeasure(){
  measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
  measurements.selectedAtoms = [];
  clearMeasureGraphics();
}

function formatÅ(x){ return (Math.round(x*1000)/1000).toFixed(3); }


export function updateAllMeasurements() {
  if (!fileBrowser.selectedStructure?.atoms || !fileBrowser.selectedStructure?.lattice) return;

  measurements.measureLines.forEach(measureItem => {
    if (!measureItem.userData) return;

    if (measureItem.userData.type === 'distance') {
      // Update distance measurement
      const atom1 = resolveMeasurementAtom(measureItem.userData.atom1Ref, measureItem.userData.atom1Position);
      const atom2 = resolveMeasurementAtom(measureItem.userData.atom2Ref, measureItem.userData.atom2Position);

      if (atom1 && atom2) {
        // Recalculate distance and update display
        const pa = atom1.position.clone();
        const pb = atom2.position.clone();
        const distance = pa.distanceTo(pb);

        // Update the cylinder segments positions
        const direction = new THREE.Vector3().subVectors(pb, pa);
        const dashLength = 0.3;
        const gapLength = 0.2;
        const segmentLength = dashLength + gapLength;
        const numSegments = Math.floor(distance / segmentLength);

        // Clear old segments
        measureItem.clear();

        // Create new segments with updated positions
        for (let i = 0; i < numSegments; i++) {
          const segmentStart = i * segmentLength;
          const segmentGeometry = new THREE.CylinderGeometry(0.08, 0.08, dashLength, 8);
          const segmentMaterial = new THREE.MeshBasicMaterial({ color: 0x0066ff });
          const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);

          const segmentCenter = pa.clone().add(direction.clone().normalize().multiplyScalar(segmentStart + dashLength/2));
          segment.position.copy(segmentCenter);
          segment.lookAt(pb);
          segment.rotateX(Math.PI / 2);

          measureItem.add(segment);
        }
      }
    } else if (measureItem.userData.type === 'angle') {
      // Update angle measurement
      const lineIndex = measureItem.userData.lineIndex;

      const atom1 = resolveMeasurementAtom(measureItem.userData.atom1Ref, measureItem.userData.atom1Position);
      const atom2 = resolveMeasurementAtom(measureItem.userData.atom2Ref, measureItem.userData.atom2Position); // vertex
      const atom3 = resolveMeasurementAtom(measureItem.userData.atom3Ref, measureItem.userData.atom3Position);

      if (atom1 && atom2 && atom3) {
        // Determine which line this is (vertex to atom1 or vertex to atom3)
        const startPos = atom2.position.clone(); // vertex
        const endPos = lineIndex === 1 ? atom1.position.clone() : atom3.position.clone();

        const distance = startPos.distanceTo(endPos);
        const direction = new THREE.Vector3().subVectors(endPos, startPos);

        const dashLength = 0.25;
        const gapLength = 0.15;
        const segmentLength = dashLength + gapLength;
        const numSegments = Math.floor(distance / segmentLength);

        // Clear old segments
        measureItem.clear();
        // Create new segments with updated positions
        for (let i = 0; i < numSegments; i++) {
          const segmentStart = i * segmentLength;
          const segmentGeometry = new THREE.CylinderGeometry(0.06, 0.06, dashLength, 8);
          const segmentMaterial = new THREE.MeshBasicMaterial({ color: 0xff6600 }); // Orange
          const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);

          const segmentCenter = startPos.clone().add(direction.clone().normalize().multiplyScalar(segmentStart + dashLength/2));
          segment.position.copy(segmentCenter);
          segment.lookAt(endPos);
          segment.rotateX(Math.PI / 2);

          measureItem.add(segment);
        }
      }
    } else if (measureItem.userData.type === 'distanceMarker') {
      // Update distance marker position
      const atom = resolveMeasurementAtom(measureItem.userData.atomRef, measureItem.userData.atomPosition);

      if (atom) {
        measureItem.position.copy(atom.position);
      }
    } else if (measureItem.userData.type === 'angleMarker') {
      // Update angle marker position
      const atom = resolveMeasurementAtom(measureItem.userData.atomRef, measureItem.userData.atomPosition);

      if (atom) {
        measureItem.position.copy(atom.position);
      }
    }
  });

  // Update measurement labels
  measurements.measureLabels.forEach(label => {
    if (label.userData && label.userData.type === 'distance') {
      const atom1 = resolveMeasurementAtom(label.userData.atom1Ref, label.userData.atom1Position);
      const atom2 = resolveMeasurementAtom(label.userData.atom2Ref, label.userData.atom2Position);

      if (atom1 && atom2) {
        const pa = atom1.position.clone();
        const pb = atom2.position.clone();
        const distance = pa.distanceTo(pb);
        const midpoint = pa.clone().add(pb).multiplyScalar(0.5);

        // Update label position and text
        label.position.copy(midpoint);
        if (label.element && label.element.firstChild) {
          label.element.firstChild.textContent = distance.toFixed(3) + ' Å';
        }
      }
    } else if (label.userData && label.userData.type === 'angle') {
      // Update angle label
      const atom1 = resolveMeasurementAtom(label.userData.atom1Ref, label.userData.atom1Position);
      const atom2 = resolveMeasurementAtom(label.userData.atom2Ref, label.userData.atom2Position); // vertex
      const atom3 = resolveMeasurementAtom(label.userData.atom3Ref, label.userData.atom3Position);

      if (atom1 && atom2 && atom3) {
        // Recalculate angle
        const angle = calculateAngle(atom1, atom2, atom3);

        // Update label position to vertex
        label.position.copy(atom2.position);

        // Update label text
        if (label.element && label.element.firstChild) {
          const elements = [atom1.userData.element, atom2.userData.element, atom3.userData.element];
          label.element.firstChild.textContent = `∠${elements[0]}-${elements[1]}-${elements[2]}: ${angle.toFixed(1)}°`;
        }
      }
    }
  });

  // Update measurement marker sizes to match current atom sizes
  updateMeasurementMarkers();
}        
