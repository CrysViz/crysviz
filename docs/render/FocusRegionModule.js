// Derived visibility for local environments in large cells. Focus regions do
// not mutate Atom.opacity: closing the panel or disabling every region must
// restore the authored appearance exactly.

import { fileBrowser, groups, general } from '../state/store.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import { requestRender } from './AnimateModule.js';

export const DEFAULT_FOCUS_REGION = Object.freeze({
  enabled: true,
  innerEnabled: true,
  innerRadius: 3.5,
  innerOpacity: 1,
  outerOpacity: 0.15,
  excludedSourceIndices: [],
});

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** Visibility proposed by one region for a Cartesian point. */
export function focusOpacityAt(point, region, sourceIndex = -1) {
  if (!region?.enabled || !region.center?.length) return 1;
  if (region.centerSourceIndices?.includes(sourceIndex)
      || region.excludedSourceIndices?.includes(sourceIndex)) return 1;
  const dx = point[0] - region.center[0];
  const dy = point[1] - region.center[1];
  const dz = point[2] - region.center[2];
  const distance = Math.hypot(dx, dy, dz);
  const innerRadius = Math.max(0, Number(region.innerRadius) || 0);
  if (region.innerEnabled && distance <= innerRadius) return clamp01(region.innerOpacity);
  return clamp01(region.outerOpacity);
}

/** Multiple regions combine by maximum visibility: importance in one region
 * cannot be cancelled by another region. */
export function combinedFocusOpacity(point, sourceIndex, regions) {
  const enabled = (regions ?? []).filter((region) => region?.enabled && region.center?.length);
  if (!enabled.length) return 1;
  // Focus atoms are global exceptions. Without this explicit union, a newly
  // added region could dim an earlier focus when region state is restored from
  // an older share or temporarily lacks a resolved center position.
  if (enabled.some((region) => region.centerSourceIndices?.includes(sourceIndex)
      || region.excludedSourceIndices?.includes(sourceIndex))) return 1;
  let opacity = 0;
  for (const region of enabled) opacity = Math.max(opacity, focusOpacityAt(point, region, sourceIndex));
  return opacity;
}

export function getFocusRegions(structure = fileBrowser.selectedStructure) {
  const regions = structure?.focusRegions ?? [];
  for (const region of regions) {
    // One-development-version migration: the former three-zone model called
    // the true outside value `beyondOpacity` and used outerOpacity for a shell.
    if (Object.hasOwn(region, 'beyondOpacity')) {
      region.outerOpacity = clamp01(region.beyondOpacity);
      delete region.beyondOpacity;
      delete region.outerRadius;
    }
  }
  return regions;
}

/** Keep centers attached to their chosen periodic atom copies as coordinates
 * move. Stable image keys survive ordinary mesh rebuilds and trajectory frames. */
export function prepareFocusRegions(structure = fileBrowser.selectedStructure) {
  const wrapped = structure?.periodic?.visibleWrapped;
  if (!wrapped) return;
  for (const region of getFocusRegions(structure)) {
    const indices = (region.centerImageKeys ?? []).map((key) =>
      structure.atomImageKeys?.indexOf(key)).filter((index) => index >= 0);
    if (!indices.length) continue;
    region.center = [0, 1, 2].map((axis) =>
      indices.reduce((sum, index) => sum + wrapped.cart[index][axis], 0) / indices.length);
  }
}

export function getFocusOpacityForInstance(instanceIndex, structure = fileBrowser.selectedStructure) {
  const wrapped = structure?.periodic?.visibleWrapped;
  const point = wrapped?.cart?.[instanceIndex];
  if (!point) return 1;
  return combinedFocusOpacity(point, wrapped.srcIndex?.[instanceIndex] ?? instanceIndex,
    getFocusRegions(structure));
}

export function createFocusRegion(centerAtoms, structure = fileBrowser.selectedStructure) {
  if (!structure || !centerAtoms?.length) return null;
  const positions = centerAtoms.map((atom) => {
    const p = atom.position;
    if (Array.isArray(p) && p.length >= 3) return p;
    if (p && [p.x, p.y, p.z].every(Number.isFinite)) return [p.x, p.y, p.z];
    return null;
  }).filter(Boolean);
  if (!positions.length) return null;
  const center = [0, 1, 2].map((axis) =>
    positions.reduce((sum, position) => sum + Number(position[axis]), 0) / positions.length);
  const region = {
    ...DEFAULT_FOCUS_REGION,
    id: `focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    center,
    centerSourceIndices: [...new Set(centerAtoms.map((atom) => atom.sourceIndex)
      .filter(Number.isInteger))],
    centerImageKeys: [...new Set(centerAtoms.map((atom) =>
      structure.atomImageKeys?.[atom.instanceId]).filter(Boolean))],
    excludedSourceIndices: [],
  };
  (structure.focusRegions ??= []).push(region);
  applyFocusRegions();
  return region;
}

export function removeFocusRegion(id, structure = fileBrowser.selectedStructure) {
  if (!structure?.focusRegions) return;
  structure.focusRegions = structure.focusRegions.filter((region) => region.id !== id);
  applyFocusRegions();
}

export function clearFocusRegions(structure = fileBrowser.selectedStructure) {
  if (structure) structure.focusRegions = [];
  applyFocusRegions();
}

export function applyFocusRegions(structure = fileBrowser.selectedStructure) {
  const mesh = groups.atomsMesh;
  const wrapped = structure?.periodic?.visibleWrapped;
  const opacityAttr = mesh?.geometry?.attributes?.instanceOpacity;
  if (!mesh || !wrapped || !opacityAttr) return;
  prepareFocusRegions(structure);
  let hasTransparency = general.mainOpacity < 0.999;
  for (let i = 0; i < wrapped.cart.length; i++) {
    const src = wrapped.srcIndex?.[i] ?? i;
    const atom = structure.atoms[src];
    const imageAlpha = structure.atomImageStyles?.[structure.atomImageKeys?.[i]]?.alpha;
    const authored = imageAlpha ?? atom?.getOpacity?.() ?? atom?.opacity ?? 1;
    const opacity = clamp01(authored) * getFocusOpacityForInstance(i, structure);
    opacityAttr.setX(i, opacity);
    if (opacity < 0.999) hasTransparency = true;
  }
  opacityAttr.needsUpdate = true;
  applyTransparency(mesh.material, {
    kind: 'atoms', opacity: general.mainOpacity, needsTransparency: hasTransparency,
    perInstanceOpacity: true, mesh,
  });
  const bondMesh = groups.bondsMesh;
  if (bondMesh && structure.bonds?.length) {
    const bondOpacity = bondMesh.geometry?.attributes?.instanceOpacity;
    structure.bonds.filter((bond) => bond.visibleLen > 1e-3).forEach((bond, index) => {
      const focus = Math.min(
        getFocusOpacityForInstance(bond.indices[0], structure),
        getFocusOpacityForInstance(bond.indices[1], structure),
      );
      const opacity = clamp01(bond.alpha ?? 1) * focus;
      bondOpacity?.setX(index * 2, opacity);
      bondOpacity?.setX(index * 2 + 1, opacity);
    });
    if (bondOpacity) bondOpacity.needsUpdate = true;
    const focusTransparent = getFocusRegions(structure).some((region) =>
      region.enabled !== false && region.center?.length);
    applyTransparency(bondMesh.material, {
      kind: 'bonds', opacity: general.mainOpacity,
      needsTransparency: general.mainOpacity < 0.999 || focusTransparent,
      perInstanceOpacity: true, mesh: bondMesh,
    });
  }
  requestRender();
}
