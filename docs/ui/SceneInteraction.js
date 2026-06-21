// Scene pointer interaction: atom/bond picking for measurements, double-click /
// long-press highlight, and the touch long-press + ghost-click handling.
// Extracted verbatim from crystal-viewer.js initApp() (Stage 6). The handlers
// share a single raycaster/mouse and the long-press state, so they move as one
// unit. Wires its listeners onto app.renderer.domElement.

import * as THREE from '../external/three/three.module.js';
import { app, groups, mode, fileBrowser, measurements } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import {
  clearHighlightAtom, clearHighlightBond, highlightAtomIn3D,
  highlightBondIn3D, clearAllHighlights,
  clearSelectedAtoms, updateAtomSelectionFrom3DHit,
} from './SelectAndHighlightModule.js';
import {
  clearMeasureGraphics, addDistanceMeasurement, addAngleMeasurement, drawMeasureGraphics,
} from '../render/MeasurementModule.js';
import { createBondLengthControls } from './BondLengthPanel.js';

export function setupSceneInteraction() {
  let raycaster = new THREE.Raycaster();
  let mouse = new THREE.Vector2();
  function onClickPick(event){
    // Only handle clicks if a mode is enabled
    if (mode.measureMode === 'none') return;

    // Prevent default behavior to avoid conflicts with pan/zoom
    event.preventDefault();
    event.stopPropagation();

    // Note: Double-click detection is handled by separate onDoubleClickAtom function

    // Handle both mouse and touch events with better error checking
    let clientX, clientY;

    if (event.type === 'touchend' || event.type === 'touchstart') {
      // For touch events, use the appropriate touch list
      const touchList = event.type === 'touchstart' ? event.touches : event.changedTouches;
      if (touchList && touchList.length > 0) {
        clientX = touchList[0].clientX;
        clientY = touchList[0].clientY;
      } else {
        console.warn('Touch event without touch coordinates');
        return;
      }
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    if (clientX === undefined || clientY === undefined) {
      console.warn('Could not get event coordinates');
      return;
    }

    const rect = app.renderer.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    mouse.set(x, y);
    raycaster.setFromCamera(mouse, app.camera);
    if (!groups.atomsMesh) return;

    const hits = raycaster.intersectObject(groups.atomsMesh);
    if (!hits.length) {
      // Clicked on empty space - reset selection
      measurements.selectedAtoms.forEach(a => clearHighlightAtom());
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
      return;
    }

    const rawHit = hits[0];
    const instanceId = rawHit.instanceId;
    const wrapped = fileBrowser.selectedStructure?.periodic?.wrapped;
    if (!wrapped) return;
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[instanceId] : instanceId;
    const element = groups.atomsMesh.userData.elementNames?.[instanceId] || wrapped.elements?.[instanceId] || '?';
    const hit = {
      position: new THREE.Vector3(...wrapped.cart[instanceId]),
      userData: {
        atomIndex: srcIdx,
        element,
        instanceId,
        wrappedFrac: wrapped.frac?.[instanceId] ? [...wrapped.frac[instanceId]] : null,
      }
    };

    // Allow selecting the same source atom through a different periodic image,
    // but avoid double-picking the exact same rendered instance.
    if (measurements.selectedAtoms.some(a => a.userData.instanceId === instanceId)) return;

    // Add atom to selection and highlight it
    measurements.selectedAtoms.push(hit);
    highlightAtomIn3D(instanceId);

    // Handle actions based on mode
    if (mode.measureMode === 'distance' && measurements.selectedAtoms.length === 2) {
      // Distance measurement complete
      addDistanceMeasurement(measurements.selectedAtoms[0], measurements.selectedAtoms[1]);

      // Clear selection
      measurements.selectedAtoms.forEach(atom => clearHighlightAtom());
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
      resetControlsTouch();
    } else if (mode.measureMode === 'angle' && measurements.selectedAtoms.length === 3) {
      // Angle measurement complete
      addAngleMeasurement(measurements.selectedAtoms[0], measurements.selectedAtoms[1], measurements.selectedAtoms[2]);

      // Clear selection
      measurements.selectedAtoms.forEach(atom => clearHighlightAtom());
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
      resetControlsTouch();
    } else if (mode.measureMode === 'delete') {
      const idx = hit.userData.atomIndex;
      const structure = fileBrowser.selectedStructure;
      if (structure && idx !== undefined && idx >= 0 && idx < structure.atoms.length) {
        // Remove the atom (and any parallel per-atom data) from the structure
        structure.atoms.splice(idx, 1);
        structure.elements.splice(idx, 1);
        structure.uniqueElements = [...new Set(structure.elements)];
        if (Array.isArray(structure.spins) && structure.spins.length > idx) structure.spins.splice(idx, 1);
        if (Array.isArray(structure.forces) && structure.forces.length > idx) structure.forces.splice(idx, 1);
        // Clean selections and graphics
        measurements.selectedAtoms.forEach(atom => clearHighlightAtom());
        measurements.selectedAtoms = [];
        clearMeasureGraphics();
        // Atom count changed, so rebuild the meshes (not just update them)
        createBondLengthControls();
        updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
      }
      return; // nothing else to do in delete mode
    }

    drawMeasureGraphics();
  }

  // Double-click handler for atom highlighting feature
  function onDoubleClickAtom(event) {
  // Don't open info panel while measuring — two measurement clicks look like a dblclick
  if (mode.measureMode !== 'none') return;
  event.preventDefault();
  event.stopPropagation();

  // Handle both mouse and touch events
  let clientX, clientY;
  if (event.changedTouches && event.changedTouches.length > 0) {
    clientX = event.changedTouches[0].clientX;
    clientY = event.changedTouches[0].clientY;
  } else {
    clientX = event.clientX;
    clientY = event.clientY;
  }

  const rect = app.renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  // Raycast for atoms
  raycaster.setFromCamera(mouse, app.camera);

  // Raycast against InstancedMesh objects
  const atomHits = raycaster.intersectObject(groups.atomsMesh);
  const bondHits = raycaster.intersectObject(groups.bondsMesh);

  let hit = null;

  // Handle atom hits
  if (atomHits.length > 0) {
    hit = atomHits[0];
    // You can now use hit.instanceId to identify the specific atom
  }

  // Handle atom hits
  if (bondHits.length > 0) {
    hit = bondHits[0];
    // You can now use hit.instanceId to identify the specific atom
  }    



  // Raycast for bonds
  //const bondHits = raycaster.intersectObjects(groups.bondsGroup.children, true);

  if (atomHits.length > 0) {
    hit = atomHits[0];
    clearHighlightBond();
    updateAtomSelectionFrom3DHit(hit, {
      selectionMode: (event.ctrlKey || event.metaKey) ? 'toggle' : (event.shiftKey ? 'add' : 'replace'),
      sourceEvent: event,
      scrollToSelection: true,
    });

  } else if (bondHits.length > 0) {
    clearSelectedAtoms({
      sourceEvent: event,
      reason: 'bond-select',
    });
    let id2;
    if (hit.instanceId%2 == 0){
      id2 = hit.instanceId+1
    }
    else{
      id2 = hit.instanceId-1
    }
    //highlightBondInStructurePanel(bondIndex);
    highlightBondIn3D([hit.instanceId,id2]);
    //highlightBondInfoInStructurePanel()


  }
  else  {
     clearAllHighlights({
       sourceEvent: event,
       reason: 'empty-space',
     });
  }


}


  // Add double-click listener for atom highlighting feature
  app.renderer.domElement.addEventListener('dblclick', onDoubleClickAtom);




// --- Event setup for Three.js renderer element ---
const el = app.renderer.domElement;

// Prevent browser gestures (zoom, scroll, long-press menu)
el.style.touchAction = 'none';

// Long-press config
let longPressTimer = null;
let longPressFired = false;
let pointerDownPos = null;
let moved = false;
const LONG_PRESS_MS = 700;        // adjust to preference
const MOVE_THRESHOLD_PX = 10;

// Debounce to suppress synthetic click after touch
let lastTouchTime = 0;
const GHOST_CLICK_DELAY = 400;    // ms window to ignore duplicate clicks

// Desktop: keep double-click
el.addEventListener('dblclick', onDoubleClickAtom);

// Desktop: keep normal click
el.addEventListener('click', (e) => {
  const now = Date.now();
  if (now - lastTouchTime < GHOST_CLICK_DELAY) {
    // Ignore the synthetic click that follows a touch
    return;
  }
  onClickPick(e);
});

// Pointer events handle touch + pen + mouse consistently
el.addEventListener('pointerdown', onPointerDown);
el.addEventListener('pointermove', onPointerMove);
el.addEventListener('pointerup', onPointerUp);
el.addEventListener('pointercancel', onPointerCancel);

function onPointerDown(e) {
  // Track touch separately for long-press
  if (e.pointerType === 'touch') {
    clearLongPress(); // always clear any pending timer before starting a new one
    longPressFired = false;
    moved = false;
    pointerDownPos = { x: e.clientX, y: e.clientY };

    longPressTimer = setTimeout(() => {
      longPressFired = true;
      onDoubleClickAtom(e);   // use same logic as double-click
      lastTouchTime = Date.now(); // prevent follow-up ghost click
    }, LONG_PRESS_MS);
  }

  try { e.target.setPointerCapture(e.pointerId); } catch {}
}

function onPointerMove(e) {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
    moved = true;
    clearLongPress();
  }
}

function onPointerUp(e) {
  clearLongPress();
  try { e.target.releasePointerCapture(e.pointerId); } catch {}

  if (e.pointerType === 'touch') {
    // If the long-press already triggered, skip normal tap
    if (longPressFired) {
      longPressFired = false;
      pointerDownPos = null;
      return;
    }

    // Ignore small drags
    if (moved) {
      pointerDownPos = null;
      moved = false;
      return;
    }

    // Normal tap on touch → behave like click
    lastTouchTime = Date.now();
    e.preventDefault(); // prevent synthetic mouse click
    onClickPick(e);
  }

  pointerDownPos = null;
}

function onPointerCancel() {
  clearLongPress();
  pointerDownPos = null;
}

function clearLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

// After a touch-based measurement completes, TrackballControls may have stale
// pointer state that causes 1-finger drag to zoom instead of rotate.
// Dispatching pointercancel flushes its internal pointer list.
function resetControlsTouch() {
  try {
    const cancel = new PointerEvent('pointercancel', { bubbles: true, cancelable: false, pointerId: 1 });
    el.dispatchEvent(cancel);
  } catch {}
}
}
