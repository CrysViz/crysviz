import { usedIDs } from '../state/store.js';
import * as THREE from 'three';

/**
 * Generate a compact timestamp + random UUID string
 */
export function generateCompactTimeUUID() {
  const timestamp = Date.now().toString(36).substring(6,8)
  const randomSuffix = Math.random().toString(36).padEnd(8, '0').substring(2, 10);

  let uuid = `${timestamp}-${randomSuffix}`;
  while (usedIDs.has(uuid)) {
    uuid = `${timestamp}-${Math.random().toString(36).padEnd(8, '0').substring(2, 10)}`;
  }
  usedIDs.add(uuid);
  return uuid;
}

/**
 * Generate a full ID with element names + optional prefix
 */
export function generateID(elements) {
  // If only one element, append "X"
  const idElements = elements.length === 1
    ? `${elements[0]}-X`
    : [...elements].sort().join("-");
  return `${idElements}-${generateCompactTimeUUID()}`;
}

/**
 * Get instance index by UUID
 */
export function getIndexByUUID(mesh, uuid) {
  return mesh.userData.uuidToIndex?.get(uuid);
}

/**
 * Get UUID by instance index
 */
export function getUUIDByIndex(mesh, index) {
  return mesh.userData.indexToUUID?.get(index);
}


/**
 * Reset the usedIDs set
 */
export function resetUsedIDs() {
  usedIDs.clear();
}

