import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { requestRender } from '../render/index.js';

const cameraPanRight = new THREE.Vector3();
const cameraPanUp = new THREE.Vector3();

// The promotion pointerdown is intentionally allowed through this module's
// capture filter, while still being synthetic and invisible to the registry.
let allowedSyntheticPointerEvent = null;

function pointerKind(event) {
  return event.pointerType === 'touch' ? 'touch' : 'mouse';
}

export function installGestureArbiter(domElement) {
  const ownerDocument = domElement.ownerDocument;
  let modality = 'none';
  let activeMousePointerId = null;
  let mousePanActive = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  const activeTouches = new Map();
  const forwardedTouches = new Set();
  const suppressedPointerIds = new Set();
  let touchMidpointX = 0;
  let touchMidpointY = 0;
  let touchMidpointValid = false;
  let touchPanMoved = false;
  let pendingTouchActivation = false;

  const stop = (event) => event.stopImmediatePropagation();

  const resetTouchMidpoint = () => {
    if (activeTouches.size !== 2) {
      touchMidpointValid = false;
      return;
    }
    const points = activeTouches.values();
    const first = points.next().value;
    const second = points.next().value;
    touchMidpointX = (first.x + second.x) / 2;
    touchMidpointY = (first.y + second.y) / 2;
    touchMidpointValid = true;
  };

  const dispatchAllowedSyntheticEvent = (event) => {
    /** @type {any} */ (event)._cvCameraOnly = true;
    allowedSyntheticPointerEvent = event;
    domElement.dispatchEvent(event);
    if (allowedSyntheticPointerEvent === event) allowedSyntheticPointerEvent = null;
  };

  const currentTouchDistance = () => {
    if (forwardedTouches.size !== 2) return 0;
    const points = [...forwardedTouches].map((pointerId) => activeTouches.get(pointerId));
    if (points.some((point) => !point)) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  };

  const reanchorPinch = () => {
    const distance = currentTouchDistance();
    if (distance === 0) return;
    // TrackballControls measures pinch in raw page pixels and uses these two
    // private anchors as the start/end distance for its next zoom update.
    app.controls._touchZoomDistanceStart = distance;
    app.controls._touchZoomDistanceEnd = distance;
  };

  const dispatchControlsEnd = () => {
    app.controls?.dispatchEvent({ type: 'end' });
  };

  const finishTouchPan = () => {
    if (!touchPanMoved) return;
    touchPanMoved = false;
    dispatchControlsEnd();
  };

  const clearMouseState = (releaseCapture = true) => {
    const pointerId = activeMousePointerId;
    activeMousePointerId = null;
    mousePanActive = false;
    if (releaseCapture && pointerId !== null && domElement.hasPointerCapture(pointerId)) {
      domElement.releasePointerCapture(pointerId);
    }
    if (modality === 'mouse') {
      modality = 'none';
      schedulePendingTouchActivation();
    }
  };

  const clearInteractionState = () => {
    finishTouchPan();
    cancelForwardedPointers();
    const pointerId = activeMousePointerId;
    activeMousePointerId = null;
    mousePanActive = false;
    modality = 'none';
    activeTouches.clear();
    forwardedTouches.clear();
    suppressedPointerIds.clear();
    touchMidpointX = 0;
    touchMidpointY = 0;
    touchMidpointValid = false;
    touchPanMoved = false;
    if (pointerId !== null && domElement.hasPointerCapture(pointerId)) {
      domElement.releasePointerCapture(pointerId);
    }
  };

  const unlockIfIdle = () => {
    if (modality === 'touch' && activeTouches.size === 0) {
      finishTouchPan();
      modality = 'none';
      forwardedTouches.clear();
    } else if (modality === 'mouse' && activeMousePointerId === null) {
      modality = 'none';
      schedulePendingTouchActivation();
    }
  };

  const applyPanDelta = (dxPx, dyPx) => {
    const camera = app.camera;
    const viewportHeightPx = domElement.clientHeight
      || domElement.getBoundingClientRect().height
      || window.innerHeight;
    let worldPerPixel;
    if (camera.isPerspectiveCamera) {
      // The offset is perpendicular to the view direction. Removing its
      // squared length recovers the unpanned axial distance used by the
      // perspective projection scale.
      const eyeLengthSq = camera.position.distanceToSquared(app.controls.target);
      const panLengthSq = app.cameraPan.x ** 2 + app.cameraPan.y ** 2;
      const dist = Math.sqrt(Math.max(0, eyeLengthSq - panLengthSq));
      worldPerPixel = 2 * dist * Math.tan(camera.fov * Math.PI / 360) / viewportHeightPx;
    } else {
      worldPerPixel = (camera.top - camera.bottom) / camera.zoom / viewportHeightPx;
    }

    // Pan runs off a custom pixel->world mapping (noPan on the trackball), so
    // the Visual ▸ Camera speed slider is applied here rather than via
    // controls.panSpeed. 1 = the original 1:1 mapping.
    const speed = general.cameraSpeedFactor || 1;
    const deltaX = -dxPx * worldPerPixel * speed;
    const deltaY = dyPx * worldPerPixel * speed;
    app.cameraPan.x += deltaX;
    app.cameraPan.y += deltaY;

    // Pointer events can arrive in a burst before animation_update(). Keep
    // the real camera pose synchronized with the state used above.
    camera.updateMatrixWorld(true);
    cameraPanRight.setFromMatrixColumn(camera.matrixWorld, 0);
    cameraPanUp.setFromMatrixColumn(camera.matrixWorld, 1);
    camera.position.addScaledVector(cameraPanRight, deltaX);
    camera.position.addScaledVector(cameraPanUp, deltaY);
    camera.updateMatrixWorld(true);
    requestRender();
  };

  const updateTouchMidpoint = () => {
    if (activeTouches.size !== 2) {
      touchMidpointValid = false;
      return;
    }
    const points = activeTouches.values();
    const first = points.next().value;
    const second = points.next().value;
    const nextX = (first.x + second.x) / 2;
    const nextY = (first.y + second.y) / 2;
    if (touchMidpointValid) {
      const dx = nextX - touchMidpointX;
      const dy = nextY - touchMidpointY;
      if (dx !== 0 || dy !== 0) touchPanMoved = true;
      applyPanDelta(dx, dy);
    }
    touchMidpointX = nextX;
    touchMidpointY = nextY;
    touchMidpointValid = true;
  };

  const clearRotationMomentum = () => {
    const controls = app.controls;
    controls._movePrev.copy(controls._moveCurr);
    controls._lastAngle = 0;
  };

  const synthesizePromotion = (pointerId) => {
    const point = activeTouches.get(pointerId);
    if (!point || forwardedTouches.has(pointerId)) return;
    const beforeCount = forwardedTouches.size;
    forwardedTouches.add(pointerId);
    if (beforeCount === 1 && forwardedTouches.size === 2) clearRotationMomentum();

    queueMicrotask(() => {
      const current = activeTouches.get(pointerId);
      if (!current || allowedSyntheticPointerEvent) return;
      const event = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: false,
        clientX: current.x,
        clientY: current.y,
        screenX: current.x,
        screenY: current.y,
        button: 0,
        buttons: 1,
        pressure: 0.5,
      });
      dispatchAllowedSyntheticEvent(event);
      reanchorPinch();
    });
  };

  const forwardExistingTouch = (pointerId) => {
    const record = activeTouches.get(pointerId);
    if (!record || forwardedTouches.has(pointerId)) return;
    const beforeCount = forwardedTouches.size;
    forwardedTouches.add(pointerId);
    suppressedPointerIds.delete(pointerId);
    if (beforeCount === 1) clearRotationMomentum();

    if (record.downEvent) {
      // The original event was stopped while the other modality owned the
      // lock; redispatching it would retain that event's stop flag. Rebuild
      // a camera-only down at the current coordinates instead.
      dispatchAllowedSyntheticEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: false,
        clientX: record.x,
        clientY: record.y,
        screenX: record.x,
        screenY: record.y,
        button: 0,
        buttons: 1,
        pressure: 0.5,
      }));
    } else {
      dispatchAllowedSyntheticEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: false,
        clientX: record.x,
        clientY: record.y,
        screenX: record.x,
        screenY: record.y,
        button: 0,
        buttons: 1,
        pressure: 0.5,
      }));
    }
  };

  const activatePendingTouches = () => {
    if (modality !== 'none' || activeTouches.size === 0) return;
    modality = 'touch';
    resetTouchMidpoint();
    for (const pointerId of activeTouches.keys()) {
      if (forwardedTouches.size >= 2) break;
      forwardExistingTouch(pointerId);
    }
    reanchorPinch();
  };

  const schedulePendingTouchActivation = () => {
    if (pendingTouchActivation || modality !== 'none' || activeTouches.size === 0) return;
    pendingTouchActivation = true;
    queueMicrotask(() => {
      pendingTouchActivation = false;
      activatePendingTouches();
    });
  };

  const cancelForwardedPointers = () => {
    const forwarded = [...forwardedTouches];
    for (const pointerId of forwarded) {
      const point = activeTouches.get(pointerId);
      if (!point) continue;
      dispatchAllowedSyntheticEvent(new PointerEvent('pointercancel', {
        bubbles: true,
        cancelable: false,
        pointerId,
        pointerType: 'touch',
        isPrimary: false,
        clientX: point.x,
        clientY: point.y,
        screenX: point.x,
        screenY: point.y,
        buttons: 0,
        pressure: 0,
      }));
    }
    if (activeMousePointerId !== null && !mousePanActive) {
      dispatchAllowedSyntheticEvent(new PointerEvent('pointercancel', {
        bubbles: true,
        cancelable: false,
        pointerId: activeMousePointerId,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: lastMouseX,
        clientY: lastMouseY,
        screenX: lastMouseX,
        screenY: lastMouseY,
        buttons: 0,
        pressure: 0,
      }));
    }
  };

  const promoteSuppressedTouch = () => {
    if (forwardedTouches.size >= 2) return;
    for (const pointerId of activeTouches.keys()) {
      if (!forwardedTouches.has(pointerId)) {
        suppressedPointerIds.delete(pointerId);
        synthesizePromotion(pointerId);
        return;
      }
    }
  };

  const removeTouch = (event, promote) => {
    const pointerId = event.pointerId;
    const wasForwarded = forwardedTouches.delete(pointerId);
    activeTouches.delete(pointerId);
    suppressedPointerIds.delete(pointerId);
    resetTouchMidpoint();
    if (activeTouches.size !== 2) finishTouchPan();
    if (promote && wasForwarded) promoteSuppressedTouch();
    unlockIfIdle();
    return wasForwarded;
  };

  const onPointerDown = (event) => {
    if (event === allowedSyntheticPointerEvent) return;

    const kind = pointerKind(event);
    if (kind === 'touch') {
      const touchCountBefore = activeTouches.size;
      activeTouches.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        downEvent: event,
      });
      resetTouchMidpoint();
      if (touchCountBefore === 2) finishTouchPan();
    }
    if (modality === 'none') modality = kind;
    if (modality !== kind) {
      suppressedPointerIds.add(event.pointerId);
      stop(event);
      return;
    }

    if (kind === 'mouse') {
      if (activeMousePointerId !== null) {
        suppressedPointerIds.add(event.pointerId);
        stop(event);
        return;
      }
      activeMousePointerId = event.pointerId;
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
      if (event.button !== 2) return;
      mousePanActive = true;
      domElement.setPointerCapture(event.pointerId);
      event.preventDefault();
      stop(event);
      return;
    }

    if (forwardedTouches.size < 2) {
      const beforeCount = forwardedTouches.size;
      forwardedTouches.add(event.pointerId);
      if (beforeCount === 1) clearRotationMomentum();
      return;
    }
    suppressedPointerIds.add(event.pointerId);
    stop(event);
  };

  const onPointerMove = (event) => {
    if (event === allowedSyntheticPointerEvent) return;
    const kind = pointerKind(event);
    if (kind === 'touch' && activeTouches.has(event.pointerId)) {
      const point = activeTouches.get(event.pointerId);
      point.x = event.clientX;
      point.y = event.clientY;
      if (modality === 'touch') updateTouchMidpoint();
      if (modality !== 'touch' || suppressedPointerIds.has(event.pointerId)) stop(event);
      return;
    }

    if (kind === 'mouse' && event.pointerId === activeMousePointerId) {
      if (!mousePanActive) return;
      if ((event.buttons & 2) === 0) {
        clearMouseState();
        dispatchControlsEnd();
        stop(event);
        return;
      }
      const dxPx = event.clientX - lastMouseX;
      const dyPx = event.clientY - lastMouseY;
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
      if (dxPx !== 0 || dyPx !== 0) applyPanDelta(dxPx, dyPx);
      stop(event);
      return;
    }

    if (suppressedPointerIds.has(event.pointerId)) stop(event);
  };

  const onPointerUp = (event) => {
    const kind = pointerKind(event);
    if (kind === 'touch' && activeTouches.has(event.pointerId)) {
      const wasForwarded = removeTouch(event, true);
      if (!wasForwarded) stop(event);
      return;
    }

    if (kind === 'mouse' && event.pointerId === activeMousePointerId) {
      const wasPan = mousePanActive;
      clearMouseState(wasPan);
      if (wasPan) {
        dispatchControlsEnd();
        stop(event);
      }
      return;
    }

    if (suppressedPointerIds.delete(event.pointerId)) stop(event);
  };

  const onPointerCancel = (event) => {
    if (event === allowedSyntheticPointerEvent) return;
    const kind = pointerKind(event);
    if (kind === 'touch' && activeTouches.has(event.pointerId)) {
      const wasForwarded = removeTouch(event, true);
      if (!wasForwarded) stop(event);
      return;
    }
    if (kind === 'mouse' && event.pointerId === activeMousePointerId) {
      const wasPan = mousePanActive;
      clearMouseState(wasPan);
      if (wasPan) {
        dispatchControlsEnd();
        stop(event);
      }
      return;
    }
    if (suppressedPointerIds.delete(event.pointerId)) stop(event);
  };

  const onLostPointerCapture = (event) => {
    if (activeTouches.has(event.pointerId)) {
      const wasForwarded = forwardedTouches.has(event.pointerId);
      if (wasForwarded) {
        const point = activeTouches.get(event.pointerId);
        dispatchAllowedSyntheticEvent(new PointerEvent('pointercancel', {
          bubbles: true,
          cancelable: false,
          pointerId: event.pointerId,
          pointerType: 'touch',
          isPrimary: false,
          clientX: point.x,
          clientY: point.y,
          screenX: point.x,
          screenY: point.y,
          buttons: 0,
          pressure: 0,
        }));
      }
      activeTouches.delete(event.pointerId);
      forwardedTouches.delete(event.pointerId);
      suppressedPointerIds.delete(event.pointerId);
      resetTouchMidpoint();
      if (activeTouches.size !== 2) finishTouchPan();
      if (wasForwarded) promoteSuppressedTouch();
      unlockIfIdle();
      return;
    }
    if (event.pointerId === activeMousePointerId) {
      const wasPan = mousePanActive;
      if (!wasPan) {
        dispatchAllowedSyntheticEvent(new PointerEvent('pointercancel', {
          bubbles: true,
          cancelable: false,
          pointerId: event.pointerId,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: lastMouseX,
          clientY: lastMouseY,
          buttons: 0,
          pressure: 0,
        }));
      }
      clearMouseState(false);
      if (wasPan) dispatchControlsEnd();
      return;
    }
    suppressedPointerIds.delete(event.pointerId);
  };

  domElement.addEventListener('pointerdown', onPointerDown, true);
  domElement.addEventListener('pointercancel', onPointerCancel, true);
  ownerDocument.addEventListener('pointermove', onPointerMove, true);
  ownerDocument.addEventListener('pointerup', onPointerUp, true);
  domElement.addEventListener('lostpointercapture', onLostPointerCapture);
  window.addEventListener('blur', clearInteractionState);
  ownerDocument.addEventListener('visibilitychange', () => {
    if (ownerDocument.hidden) clearInteractionState();
  });
}
