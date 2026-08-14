// Shared viewport-relative layout math for scene-resident gizmos.
// ColorBarDrag/CompositionLegendWidget still carry their own equivalent math;
// consolidating those is a separate cleanup candidate outside this change.

export const GIZMO_FOV = 45;
// The perspective gizmo is at z=3, so this is its vertical half-span at the
// near-facing center plane. The orthographic camera uses the same span.
export const GIZMO_ORTHO_HALF_HEIGHT = 3 * Math.tan((GIZMO_FOV * Math.PI) / 360);

export function configureGizmoCameraProjection(camera, aspect) {
  if (camera.isOrthographicCamera) {
    camera.left = -GIZMO_ORTHO_HALF_HEIGHT * aspect;
    camera.right = GIZMO_ORTHO_HALF_HEIGHT * aspect;
    camera.top = GIZMO_ORTHO_HALF_HEIGHT;
    camera.bottom = -GIZMO_ORTHO_HALF_HEIGHT;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}

export function getViewRect() {
  const view = document.getElementById('view');
  return view ? view.getBoundingClientRect() : null;
}

export function clampToScene(left, top, width, height) {
  const rect = getViewRect();
  if (!rect) return { left, top };
  const minLeft = rect.left + 4;
  const maxLeft = Math.max(minLeft, rect.right - width - 4);
  const minTop = rect.top + 4;
  const maxTop = Math.max(minTop, rect.bottom - height - 4);
  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
  };
}

export function captureAnchor(element) {
  const rect = getViewRect();
  if (!rect) return null;
  const elementRect = element.getBoundingClientRect();
  const leftGap = elementRect.left - rect.left;
  const rightGap = rect.right - elementRect.right;
  const topGap = elementRect.top - rect.top;
  const bottomGap = rect.bottom - elementRect.bottom;
  return {
    edgeX: leftGap <= rightGap ? 'left' : 'right',
    offsetX: leftGap <= rightGap ? leftGap : rightGap,
    edgeY: topGap <= bottomGap ? 'top' : 'bottom',
    offsetY: topGap <= bottomGap ? topGap : bottomGap,
  };
}

export function positionFromAnchor(element, anchor) {
  const rect = getViewRect();
  if (!rect || !anchor) return null;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const left = anchor.edgeX === 'left'
    ? rect.left + anchor.offsetX
    : rect.right - anchor.offsetX - width;
  const top = anchor.edgeY === 'top'
    ? rect.top + anchor.offsetY
    : rect.bottom - anchor.offsetY - height;
  return clampToScene(left, top, width, height);
}
