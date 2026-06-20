/**
 * InstanceMeshManager.js
 * A utility for managing UUID ↔ instance index mappings in Three.js InstancedMesh objects.
 */

import * as THREE from '../external/three/three.module.js';
import {usedIDs} from '../state/store.js'

function generateCompactTimeUUID() {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  let uuid = `${timestamp}-${randomSuffix}`;
  while ( usedIDs.has(uuid)) {
    uuid = `${timestamp}-${Math.random().toString(36).substring(2, 8)}`;
  }
  usedIDs.add(uuid);
  return uuid;
}

const InstanceMeshManager = {
  generateID(elements, prefix = "") {
    const sortedElements = [...elements].sort().join("-");
    return `${prefix}${sortedElements}-${generateCompactTimeUUID()}`;
  },

  initializeMesh(mesh, objects, prefix = "") {
    objects.forEach((obj) => {
      if (!obj.uuid) {
        obj.uuid = this.generateID(obj.elements, prefix);
      }
    });

    const indexToUUID = new Map();
    const uuidToIndex = new Map();

    objects.forEach((obj, index) => {
      indexToUUID.set(index, obj.uuid);
      uuidToIndex.set(obj.uuid, index);
    });

    mesh.userData.indexToUUID = indexToUUID;
    mesh.userData.uuidToIndex = uuidToIndex;

    const uuidAttribute = [];
    objects.forEach((obj) => {
      const encoder = new TextEncoder();
      const encodedUUID = encoder.encode(obj.uuid);
      const padded = new Uint8Array(16);
      padded.set(encodedUUID.subarray(0, 16));
      const floatView = new Float32Array(padded.buffer);
      uuidAttribute.push(...Array.from(floatView));
    });

    const instanceUUIDs = new THREE.InstancedBufferAttribute(
      new Float32Array(uuidAttribute),
      4
    );
    mesh.geometry.setAttribute('instanceUUID', instanceUUIDs);
  },

  getIndexByUUID(mesh, uuid) {
    return mesh.userData.uuidToIndex?.get(uuid);
  },

  getUUIDByIndex(mesh, index) {
    return mesh.userData.indexToUUID?.get(index);
  },

  updateInstanceByUUID(mesh, uuid, newMatrix, newColor) {
    const index = this.getIndexByUUID(mesh, uuid);
    if (index !== undefined) {
      if (newMatrix) mesh.setMatrixAt(index, newMatrix);
      if (newColor) mesh.setColorAt(index, newColor);
      mesh.instanceMatrix.needsUpdate = true;
      if (newColor) mesh.instanceColor.needsUpdate = true;
    } else {
      console.warn(`Instance not found for UUID: ${uuid}`);
    }
  },

  rebuildLookups(mesh, objects, prefix = "") {
    this.initializeMesh(mesh, objects, prefix);
  },

  reset() {
    usedIDs.clear();
  },
};

// Export for ES6 modules
export default InstanceMeshManager;

// For browser globals
if (typeof window !== 'undefined') {
  window.InstanceMeshManager = InstanceMeshManager;
}

