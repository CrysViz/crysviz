// Scene pointer interaction: atom/bond picking for measurements, double-click /
// long-press highlight, and the touch long-press + ghost-click handling.
// Extracted verbatim from crystal-viewer.js initApp() (Stage 6). The handlers
// share a single raycaster/mouse and the long-press state, so they move as one
// unit. Wires its listeners onto app.renderer.domElement.

import * as THREE from '../external/three/three.module.js';
import { app, groups, mode, fileBrowser, measurements, general } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { updateForces, updateSpins } from '../render/index.js';
import {
  clearHighlightAtom, highlightAtomIn3D,
  clearAllHighlights, clearBondSelection, selectBondFromInstance,
  clearPolyhedronSelection, selectPolyhedronFromMesh,
  clearSelectedAtoms, updateAtomSelectionFrom3DHit,
} from './SelectAndHighlightModule.js';
import {
  clearMeasureGraphics, addDistanceMeasurement, addAngleMeasurement, drawMeasureGraphics,
} from '../render/MeasurementModule.js';
import { flashGhost, HIDE_FLASH_COLOR } from '../render/GhostAtomsModule.js';

const HIDE_FLASH_MS = 150;

// Single commit point for every hide/restore action (click, ghost-click, or
// rectangle-drag) — sets .hidden on both lists in one pass and re-renders
// exactly once, rather than each call site touching the structure directly.
// updateVisualization itself refreshes the ghost mesh (it's the one place
// that knows about every atoms re-render, not just this one), so no
// separate refreshGhostAtoms() call is needed here. Forces/spins are their
// own standalone meshes that updateVisualization never touches (every other
// caller that mutates atoms and cares about them follows this same
// convention — see SelectAndHighlightModule.js), so they need an explicit
// refresh here too, or a hidden atom's arrow would linger until a reload.
function commitHideRestore(hideIndices, restoreIndices) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  for (const idx of hideIndices) if (structure.atoms[idx]) structure.atoms[idx].hidden = true;
  for (const idx of restoreIndices) if (structure.atoms[idx]) structure.atoms[idx].hidden = false;
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderComposition: true });
  if (general.forcesActive) updateForces(general.forceScale ?? 1.0, general.forceColorMap ?? 'heatmap');
  if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
}

export function setupSceneInteraction() {
  let raycaster = new THREE.Raycaster();
  let mouse = new THREE.Vector2();
  const _dragSelectMatrix = new THREE.Matrix4(); // scratch, reused by commitDragSelectRect's ghost-instance position lookup

  // Resolves an event's pointer position to NDC coordinates, or null if the
  // event carries none (used by both the hide-mode click handler below and
  // the plain click/distance/angle path).
  function pointerNDC(event) {
    let clientX, clientY;
    if (event.type === 'touchend' || event.type === 'touchstart') {
      const touchList = event.type === 'touchstart' ? event.touches : event.changedTouches;
      if (!touchList || !touchList.length) return null;
      clientX = touchList[0].clientX;
      clientY = touchList[0].clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }
    if (clientX === undefined || clientY === undefined) return null;
    const rect = app.renderer.domElement.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: -((clientY - rect.top) / rect.height) * 2 + 1,
    };
  }

  // Hide mode: a plain click (no modifier) directly hides a real atom, with
  // a brief flash first — no selection step, no confirmation. Only ever
  // picks groups.atomsMesh — a ghost under the cursor is ignored entirely,
  // so Hide mode can never accidentally restore something. Never engages
  // outside mode.measureMode === 'hide', so it can't interfere with
  // distance/angle picking or the double-click atom-selection flow used by
  // the Planes panel.
  function handleHideModeClick(event) {
    const ndc = pointerNDC(event);
    if (!ndc) return;
    event.preventDefault();
    event.stopPropagation();

    mouse.set(ndc.x, ndc.y);
    raycaster.setFromCamera(mouse, app.camera);

    const atomsMesh = groups.atomsMesh;
    const atomHit = atomsMesh ? raycaster.intersectObject(atomsMesh)[0] : undefined;
    if (!atomHit) return;

    const instanceId = atomHit.instanceId;
    const wrapped = fileBrowser.selectedStructure?.periodic?.visibleWrapped;
    const srcIdx = wrapped?.srcIndex ? wrapped.srcIndex[instanceId] : instanceId;
    if (!Number.isInteger(srcIdx)) return;
    if (atomsMesh.instanceColor) {
      atomsMesh.setColorAt(instanceId, HIDE_FLASH_COLOR);
      atomsMesh.instanceColor.needsUpdate = true;
    }
    setTimeout(() => commitHideRestore([srcIdx], []), HIDE_FLASH_MS);
  }

  // Restore mode's counterpart: only ever picks groups.ghostAtomsMesh — a
  // real, visible atom under the cursor is ignored entirely, so Restore
  // mode can never accidentally hide something you didn't mean to touch.
  function handleRestoreModeClick(event) {
    const ndc = pointerNDC(event);
    if (!ndc) return;
    event.preventDefault();
    event.stopPropagation();

    mouse.set(ndc.x, ndc.y);
    raycaster.setFromCamera(mouse, app.camera);

    const ghostMesh = groups.ghostAtomsMesh;
    const ghostHit = ghostMesh ? raycaster.intersectObject(ghostMesh)[0] : undefined;
    if (!ghostHit) return;

    const instanceId = ghostHit.instanceId;
    const srcIdx = ghostMesh.userData.srcIndex?.[instanceId];
    if (!Number.isInteger(srcIdx)) return;
    flashGhost(instanceId);
    setTimeout(() => commitHideRestore([], [srcIdx]), HIDE_FLASH_MS);
  }

  function onClickPick(event){
    if (mode.measureMode === 'hide') {
      handleHideModeClick(event);
      return;
    }
    if (mode.measureMode === 'restore') {
      handleRestoreModeClick(event);
      return;
    }
    if (mode.measureMode === 'none') return;

    // Prevent default behavior to avoid conflicts with pan/zoom
    event.preventDefault();
    event.stopPropagation();

    // Note: Double-click detection is handled by separate onDoubleClickAtom function

    const ndc = pointerNDC(event);
    if (!ndc) {
      console.warn('Could not get event coordinates');
      return;
    }

    mouse.set(ndc.x, ndc.y);
    raycaster.setFromCamera(mouse, app.camera);
    const targetMesh = groups.atomsMesh;
    if (!targetMesh) return;

    const hits = raycaster.intersectObject(targetMesh);
    if (!hits.length) {
      // Clicked on empty space - reset selection
      measurements.selectedAtoms.forEach(a => clearHighlightAtom());
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
      return;
    }

    const rawHit = hits[0];
    const instanceId = rawHit.instanceId;

    const wrapped = fileBrowser.selectedStructure?.periodic?.visibleWrapped;
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

  // Raycast against InstancedMesh objects. Both meshes can be absent: atoms
  // before the first structure loads, bonds whenever "Show Bonds" is off
  // (disposeBondsMesh nulls groups.bondsMesh rather than hiding the mesh).
  const atomHits = groups.atomsMesh ? raycaster.intersectObject(groups.atomsMesh) : [];
  const bondHits = groups.bondsMesh ? raycaster.intersectObject(groups.bondsMesh) : [];
  // Polyhedron faces, lowest pick priority (an atom/bond hit wins). Non-recursive
  // so the edge lines / outline proxies never participate; the visible filter is
  // required because THREE.Raycaster does NOT skip invisible meshes (hidden
  // categories must not be pickable).
  const polyHits = groups.polyhedraGroup
    ? raycaster.intersectObjects(groups.polyhedraGroup.children, false).filter((h) => h.object.visible)
    : [];

  let hit = null;

  // Pick the hit object. If both an atom and a bond are under the cursor, the
  // bond wins because it is assigned last (it overwrites the atom hit here).
  // Note: this compares first-hit-per-mesh, not true nearest object across the
  // two meshes, so the chosen hit isn't necessarily the closest to the camera.
  if (atomHits.length > 0) {
    hit = atomHits[0];
  }
  if (bondHits.length > 0) {
    hit = bondHits[0];
  }



  // Raycast for bonds
  //const bondHits = raycaster.intersectObjects(groups.bondsGroup.children, true);

  if (atomHits.length > 0) {
    hit = atomHits[0];
    clearBondSelection();
    clearPolyhedronSelection();
    updateAtomSelectionFrom3DHit(hit, {
      selectionMode: (event.ctrlKey || event.metaKey) ? 'toggle' : (event.shiftKey ? 'add' : 'replace'),
      sourceEvent: event,
      scrollToSelection: true,
      // A Shift-add is building a multi-atom selection in the 3D view (e.g.
      // for the Planes panel's best-fit-plane calculation) — the atom still
      // glows, but every click yanking focus to the Structure panel is
      // disruptive for a workflow that's staying in the 3D view.
      revealPanel: !event.shiftKey,
    });

  } else if (bondHits.length > 0) {
    clearSelectedAtoms({
      sourceEvent: event,
      reason: 'bond-select',
    });
    clearPolyhedronSelection();
    // Orange 3D highlight + open/expand/scroll to the bond's row in the
    // Structure window's Bonds tab (double-click same bond deselects).
    selectBondFromInstance(hit.instanceId, { scrollToSelection: true });
  } else if (polyHits.length > 0) {
    clearSelectedAtoms({
      sourceEvent: event,
      reason: 'polyhedron-select',
    });
    // Emissive glow + open/expand/scroll to the polyhedron's row in the
    // Structure window's Poly tab (double-click same polyhedron deselects).
    selectPolyhedronFromMesh(polyHits[0].object, { scrollToSelection: true });
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
const cameraOnlyPointerIds = new Set();
const LONG_PRESS_MS = 700;        // adjust to preference
const MOVE_THRESHOLD_PX = 10;

// Shift+drag rectangle-toggle: mouse-only (touch has no modifier key to hold
// — a touch-friendly equivalent is a future improvement), active in hide or
// restore mode. Reuses TrackballControls' own drag gesture space, so it must
// disable app.controls for the duration or a shift-drag would also rotate
// the camera; a plain (non-shift) drag in either mode still orbits normally.
let dragSelectStart = null;   // {x,y} in viewport px, set on a qualifying pointerdown
let dragSelectEl = null;      // the live rectangle overlay, built lazily on first move past threshold
let dragSelectActive = false; // true once the rect is actually showing (past DRAG_THRESHOLD_PX)
let dragSelectSuppressClick = false; // sours the click that follows a completed drag-select
const DRAG_THRESHOLD_PX = 6;

function isDragSelectEligible(e) {
  return e.pointerType === 'mouse' && e.button === 0 && e.shiftKey
    && (mode.measureMode === 'hide' || mode.measureMode === 'restore');
}

function ensureDragSelectEl() {
  if (dragSelectEl) return dragSelectEl;
  const div = document.createElement('div');
  div.className = 'cv-drag-select-rect';
  document.body.appendChild(div);
  dragSelectEl = div;
  return div;
}

function renderDragSelectRect(x0, y0, x1, y1) {
  const el = ensureDragSelectEl();
  const left = Math.min(x0, x1), top = Math.min(y0, y1);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${Math.abs(x1 - x0)}px`;
  el.style.height = `${Math.abs(y1 - y0)}px`;
  el.hidden = false;
}

function teardownDragSelect() {
  if (dragSelectEl) { dragSelectEl.remove(); dragSelectEl = null; }
  if (app.controls) app.controls.enabled = true;
  dragSelectStart = null;
  dragSelectActive = false;
}

// Projects every instance of whichever ONE mesh the active mode owns to
// screen space and toggles everything inside the given viewport-px
// rectangle — hide mode only ever tests groups.atomsMesh (hides), restore
// mode only ever tests groups.ghostAtomsMesh (restores). Keeping the two
// modes mesh-exclusive (rather than testing both, as a merged mode once
// did) means a restore-drag can never accidentally hide a real atom that
// happens to sit inside the same rectangle, and vice versa.
function commitDragSelectRect(x0, y0, x1, y1) {
  const restoring = mode.measureMode === 'restore';
  const left = Math.min(x0, x1), right = Math.max(x0, x1);
  const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const rect = app.renderer.domElement.getBoundingClientRect();
  const dummy = new THREE.Vector3();

  function projectInRect() {
    const proj = dummy.project(app.camera);
    if (proj.z < -1 || proj.z > 1) return false; // behind camera or past far plane
    const sx = (proj.x * 0.5 + 0.5) * rect.width + rect.left;
    const sy = (-proj.y * 0.5 + 0.5) * rect.height + rect.top;
    return sx >= left && sx <= right && sy >= top && sy <= bottom;
  }

  if (restoring) {
    const ghostMesh = groups.ghostAtomsMesh;
    if (!ghostMesh) return;
    const restoreInstanceIds = [];
    const restoreSrcIndices = [];
    for (let i = 0; i < ghostMesh.count; i++) {
      ghostMesh.getMatrixAt(i, _dragSelectMatrix);
      dummy.setFromMatrixPosition(_dragSelectMatrix);
      if (!projectInRect()) continue;
      restoreInstanceIds.push(i);
      restoreSrcIndices.push(ghostMesh.userData.srcIndex?.[i]);
    }
    if (!restoreSrcIndices.length) return;
    restoreInstanceIds.forEach(id => flashGhost(id));
    setTimeout(() => commitHideRestore([], restoreSrcIndices), HIDE_FLASH_MS);
    return;
  }

  const atomsMesh = groups.atomsMesh;
  const wrapped = fileBrowser.selectedStructure?.periodic?.visibleWrapped;
  if (!atomsMesh || !wrapped) return;
  const hideInstanceIds = [];
  const hideSrcIndices = [];
  for (let i = 0; i < atomsMesh.count; i++) {
    dummy.set(...wrapped.cart[i]);
    if (!projectInRect()) continue;
    hideInstanceIds.push(i);
    hideSrcIndices.push(wrapped.srcIndex ? wrapped.srcIndex[i] : i);
  }
  if (!hideSrcIndices.length) return;
  if (atomsMesh.instanceColor) {
    for (const id of hideInstanceIds) atomsMesh.setColorAt(id, HIDE_FLASH_COLOR);
    atomsMesh.instanceColor.needsUpdate = true;
  }
  setTimeout(() => commitHideRestore(hideSrcIndices, []), HIDE_FLASH_MS);
}

// Debounce to suppress synthetic click after touch
let lastTouchTime = 0;
const GHOST_CLICK_DELAY = 400;    // ms window to ignore duplicate clicks

// Desktop: keep double-click
el.addEventListener('dblclick', onDoubleClickAtom);

// Desktop: keep normal click
el.addEventListener('click', (e) => {
  if (dragSelectSuppressClick) {
    // The click that fires right after a completed drag-select (pointerup
    // already did the work) — consume it once, don't re-pick.
    dragSelectSuppressClick = false;
    return;
  }
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
  // GestureArbiter marks promoted camera-only touch pointers with this flag.
  if (e._cvCameraOnly) {
    cameraOnlyPointerIds.add(e.pointerId);
    return;
  }

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
  } else if (isDragSelectEligible(e)) {
    // Don't build the rect yet — wait for real movement (onPointerMove) so a
    // plain shift+click still reaches the click handler as a single pick.
    dragSelectStart = { x: e.clientX, y: e.clientY };
    if (app.controls) app.controls.enabled = false; // Shift+drag must not also rotate the camera
  }

  try { e.target.setPointerCapture(e.pointerId); } catch {}
}

function onPointerMove(e) {
  if (cameraOnlyPointerIds.has(e.pointerId)) return;

  if (dragSelectStart) {
    const dx = e.clientX - dragSelectStart.x;
    const dy = e.clientY - dragSelectStart.y;
    if (!dragSelectActive && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) dragSelectActive = true;
    if (dragSelectActive) renderDragSelectRect(dragSelectStart.x, dragSelectStart.y, e.clientX, e.clientY);
    return;
  }

  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
    moved = true;
    clearLongPress();
  }
}

function onPointerUp(e) {
  if (cameraOnlyPointerIds.delete(e.pointerId)) return;

  clearLongPress();
  try { e.target.releasePointerCapture(e.pointerId); } catch {}

  if (dragSelectStart) {
    if (dragSelectActive) {
      commitDragSelectRect(dragSelectStart.x, dragSelectStart.y, e.clientX, e.clientY);
      dragSelectSuppressClick = true; // the click that follows this pointerup shouldn't also re-pick
    }
    teardownDragSelect();
    return;
  }

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

function onPointerCancel(e) {
  if (cameraOnlyPointerIds.delete(e.pointerId)) return;

  clearLongPress();
  pointerDownPos = null;
  if (dragSelectStart) teardownDragSelect();
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
