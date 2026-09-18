import { usedIDs } from '../state/store.js';

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
 * Release ids that are no longer in use so the registry does not grow without
 * bound. Bonds are rebuilt on every trajectory frame (render/
 * BondsFracUpdateModule.js) and each rebuild minted new registered ids while
 * nothing ever dropped the previous frame's — ~80 bytes per bond per frame,
 * for as long as playback ran. Callers pass the objects being replaced.
 * @param {Iterable<{uuid?: string} | string>} items
 */
export function releaseIDs(items) {
  if (!items) return;
  for (const item of items) {
    const id = typeof item === 'string' ? item : item?.uuid;
    if (!id) continue;
    // generateID registers only the compact `<timestamp>-<random>` tail, not
    // the element-prefixed id it returns (so does InstanceMeshManager's
    // twin); a bare compact id IS its own tail.
    const parts = id.split('-');
    usedIDs.delete(parts.length > 2 ? parts.slice(-2).join('-') : id);
  }
}

/**
 * Reset the usedIDs set
 */
export function resetUsedIDs() {
  usedIDs.clear();
}

