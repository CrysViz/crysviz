import * as THREE from '../external/three/three.module.js';

import { app, groups,fileBrowser, general} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {getAtomVisSettings} from '../defaults/color_texture_defaults.js'

import { getCutPlaneMaskSign } from '../model/Plane.js';
import {createStyledMaterial, addCelOutline, syncCelHullOpacitySuppression, MAX_CUT_PLANES} from './MaterialStyles.js'
import {CEL_OUTLINE_LAYER} from './CelOutlinePass.js'
import {runPeriodicWrapped} from './LatticeModule.js'

import {setAtomColor}  from '../utils/ColorModule.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';


// Module-scope scratch colour reused across the per-atom colour loop in updateAtoms
// (three.js setColorAt copies the colour, so reuse is safe) — avoids allocating a
// THREE.Color per atom per frame.
const _scratchColor = new THREE.Color();

function normalizePlaneNormal(x = 1, y = 0, z = 0) {
  const nx = Number(x) || 0;
  const ny = Number(y) || 0;
  const nz = Number(z) || 0;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-8) {
    return [1, 0, 0];
  }
  return [nx / length, ny / length, nz / length];
}

function getActiveCutPlanes() {
  return (general.atomCutPlanes || [])
    .filter((plane) => plane?.enabled)
    .slice(0, MAX_CUT_PLANES);
}

function applyCutPlaneUniformsToShader(shader) {
  if (!shader?.uniforms?.uCutPlanes || !shader.uniforms.uCutPlaneCount || !shader.uniforms.uCutPlaneMaskSide) return;
  const activePlanes = getActiveCutPlanes();
  shader.uniforms.uCutPlaneCount.value = activePlanes.length;
  activePlanes.forEach((plane, index) => {
    const [nx, ny, nz] = normalizePlaneNormal(plane.x, plane.y, plane.z);
    shader.uniforms.uCutPlanes.value[index].set(nx, ny, nz, Number(plane.r) || 0);
    shader.uniforms.uCutPlaneMaskSide.value[index] = getCutPlaneMaskSign(plane.side);
  });
  for (let index = activePlanes.length; index < MAX_CUT_PLANES; index++) {
    shader.uniforms.uCutPlanes.value[index].set(0, 0, 0, 0);
    shader.uniforms.uCutPlaneMaskSide.value[index] = 0;
  }
}

function applyAtomCutPlaneUniforms(material = groups.atomsMesh?.material) {
  applyCutPlaneUniformsToShader(material?.userData?.shader);
  // In hull outline mode the outline shell discards by the same planes, and a
  // pipeline's transparent-instance overlay pass carries the same uniforms.
  if (!material || material === groups.atomsMesh?.material) {
    const outline = groups.atomsMesh?.userData?.celOutline;
    if (outline) applyCutPlaneUniformsToShader(outline.material?.userData?.shader);
    const overlay = groups.atomsMesh?.userData?.transparentOverlay;
    if (overlay) applyCutPlaneUniformsToShader(overlay.material?.userData?.shader);
  }
}


export function getUUIDFromGeometry(index) {
  const mesh = groups.atomsMesh;
  const attr = mesh.geometry.attributes.instanceUUID;

  // Each instance = 4 floats = 16 bytes
  const floatOffset = index * 4;

  // View directly into the attribute buffer
  const floatView = attr.array.subarray(floatOffset, floatOffset + 4);

  // Reinterpret the same memory as bytes
  const byteView = new Uint8Array(floatView.buffer, floatView.byteOffset, 16);

  // Decode to string
  const decoder = new TextDecoder();
  const rawUUID = decoder.decode(byteView);

  // Remove padding nulls
  const cleanedUUID = rawUUID.replace(/\0/g, '');

  // Now, cleanedUUID = stored UUID WITHOUT dashes
  return cleanedUUID;
}



export function updateAtomByUUID(mesh, uuid, newPosition, newColor) {
  const index = mesh.userData.uuidToIndex.get(uuid);
  if (index !== undefined) {
    // Get the UUID from the geometry
    const geometryUUID = getUUIDFromGeometry(index);

    // Failsafe: Check that the UUID in the geometry matches the lookup
    if (geometryUUID === uuid) {
      updateSingleAtomPosition(index, newPosition);
      if (newColor) {
        mesh.setColorAt(index, new THREE.Color(newColor));
        mesh.instanceColor.needsUpdate = true;
      }
    } else {
      console.error(`UUID mismatch at index ${index}: Expected ${uuid}, got ${geometryUUID}`);
    }
  } else {
    console.error(`No sphere found for UUID: ${uuid}`);
  }
}



//-------------------------------------------------------------------------------


export function rebuildAtoms(opacity) {
  if (groups.atomsMesh) {
    // A pipeline-owned transparent-instance overlay (userData.transparentOverlay)
    // goes down with the mesh; remove it from its parent (it may be a scene-root
    // sibling rather than a child — the WBOIT pipeline parents it to the scene)
    // and dispose its own resources (its geometry may be shared with the mesh).
    const overlay = groups.atomsMesh.userData.transparentOverlay;
    if (overlay) {
      overlay.parent?.remove(overlay);
      if (overlay.geometry !== groups.atomsMesh.geometry) overlay.geometry.dispose();
      overlay.material.dispose();
    }
    groups.atomsMesh.geometry.dispose();
    groups.atomsMesh.material.dispose();
    app.scene.remove(groups.atomsMesh);
    groups.atomsMesh = null;
  }
  fileBrowser.selectedStructure.atomImages={}
  fileBrowser.selectedStructure.atomImageKeys=[] // rebuilt by finishAtomsMesh
  console.log("Rebuilding periodic")
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  let elements = [...fileBrowser.selectedStructure.elements];
  let _ = runPeriodicWrapped(fileBrowser.selectedStructure.periodic, positions, elements,lattice)

  console.log("Building atoms")
  buildAtoms();
  console.log("updating atoms")
  let ok = updateAtoms(opacity);
  console.log("status updateAtoms", ok)
 }

// Shared mesh finalization for atom InstancedMeshes (main + comparison/"second").
// The caller (buildAtoms / buildSecondAtoms) creates the geometry + material
// (incl. its own onBeforeCompile shader) and passes them in; this fills the
// instance color / UUID / emissive (+ cut-plane) buffers, adds the mesh to the
// scene, and stores it at groups[meshKey]. Only meshKey, the structure source,
// and the two cut-plane-only attributes (gated by `cutPlanes`) differ.
export function finishAtomsMesh({ geometry, material, structure, wrapped, atoms, meshKey, cutPlanes = false }) {
  const atomCount = wrapped.elements.length;

  // Instanced mesh
  const mesh = new THREE.InstancedMesh(geometry, material, atomCount);

  // Initialize instance color buffer with a default color (e.g., grey)
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(atomCount * 3), 3, false);

  for (let i = 0; i < atomCount; i++) {
    mesh.setColorAt(i, new THREE.Color(0x808080)); // Default grey color
  }

  const instanceElementIndices = new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1);

  // Store UUIDs in mesh.userData as an array
  mesh.userData.uuids = [];
  const uuidToIndex = new Map();

  wrapped.elements.forEach((element, index) => {
    const atom = atoms[wrapped.srcIndex[index]];
    mesh.userData.uuids.push(atom.uuid);
    uuidToIndex.set(atom.uuid, index);
    instanceElementIndices.setX(index, index);
  });

  // Store the lookup table in mesh.userData
  mesh.userData.uuidToIndex = uuidToIndex;

  // Encode UUIDs as a vec4 and store them in the geometry
  const uuidAttributeData = new Float32Array(atomCount * 4); // 4 floats per UUID
  wrapped.elements.forEach((element, index) => {
    let key = wrapped.srcIndex[index]
    if (!structure.atomImages[key]) {
        structure.atomImages[key] = []; // Initialize with an empty array
    }
    structure.atomImages[key].push(index)

    // Stable per-image identity for the per-copy style store: source index +
    // integer periodic image offset (derived from the wrapped fractional coords;
    // main atoms mesh only). See atomImageKey()/getAtomImageStyle() below.
    if (meshKey === 'atomsMesh') {
      const srcPos = atoms[key]?.position;
      const frac = wrapped.frac?.[index];
      const off = (srcPos && frac)
        ? [0, 1, 2].map((a) => Math.round(frac[a] - srcPos[a])).join(',')
        : '0,0,0';
      (structure.atomImageKeys ??= [])[index] = `${key}:${off}`;
    }

    const atom = atoms[wrapped.srcIndex[index]];
    const cleanedUUID = atom.uuid.replace(/-/g, '');

    const encoder = new TextEncoder();
    const encodedUUID = encoder.encode(cleanedUUID);

    if (encodedUUID.length > 16) {
      console.warn("UUID too long, will be truncated:", atom.uuid);
    }

    const padded = new Uint8Array(16);
    padded.set(encodedUUID.subarray(0, 16));

    const floatView = new Float32Array(padded.buffer);
    uuidAttributeData.set(floatView, index * 4);
  });

  // Add the UUID attribute to the geometry
  const instanceUUIDs = new THREE.InstancedBufferAttribute(uuidAttributeData, 4);

  mesh.geometry.setAttribute('instanceUUID', instanceUUIDs);
  mesh.geometry.setAttribute('instanceElementIndex', instanceElementIndices);

  // Existing attributes
  mesh.geometry.setAttribute(
    'instanceEmissive',
    new THREE.InstancedBufferAttribute(new Float32Array(atomCount * 3), 3)
  );
  mesh.geometry.setAttribute(
    'instanceEmissiveIntensity',
    new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1)
  );

  // Cut-plane attributes (main atoms mesh only)
  if (cutPlanes) {
    mesh.geometry.setAttribute(
      'instanceOpacity',
      new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1)
    );
    mesh.geometry.setAttribute(
      'instanceCutPlaneImmune',
      new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1)
    );
  }

  // Mark buffers as dynamic
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);


  // Mark instanceColor as needing update
  mesh.instanceColor.needsUpdate = true;

  // Participate in the screen-space cel outline pass (active only in cel
  // style with 'screen' outline mode; the extra layer bit is free otherwise).
  mesh.layers.enable(CEL_OUTLINE_LAYER);

  // Add to scene & store reference
  app.scene.add(mesh);
  groups[meshKey] = mesh;
  groups[meshKey].userData.elementNames = wrapped.elements;

  if (general.renderStyle === 'cel' && general.celOutlineMode === 'hull') {
    // The hull shader compiles lazily on first render; seed its cut-plane
    // uniforms from the current plane state once it exists.
    addCelOutline(mesh, {
      cutPlanes,
      onCompiled: cutPlanes ? () => applyAtomCutPlaneUniforms() : undefined,
    });
  }
  // Honour the "Show Atoms" toggle on (re)build — the toggle only flips visibility on the
  // live mesh, so a rebuild (e.g. Complete Polyhedra appending atoms) would otherwise
  // reset the main atoms to visible. Comparison atoms keep their own visibility logic.
  if (meshKey === 'atomsMesh') mesh.visible = general.showAtoms !== false;
  return mesh;
}

// Material for the main atoms mesh and (in the split/sorted pipelines) its
// transparent-instance overlay pass. The shader carries a generic uAlphaPass
// capability that splits instances by their effective alpha: 0 = draw all
// (single-pass; the forward pipeline never changes it), 1 = opaque instances
// only, 2 = transparent instances only. Pipelines drive it via
// setAlphaPass (render/MaterialStyles.js); see render/pipeline/SplitAtomsPipeline.js.
export function createAtomsMaterial() {
  const atomVisSettings = getAtomVisSettings();
  const material = createStyledMaterial({
    ...atomVisSettings,
    transparent: false,
    opacity: 1.0,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute vec4 instanceUUID;
      varying vec4 vInstanceUUID;
      attribute vec3 instanceEmissive;
      attribute float instanceEmissiveIntensity;
      attribute float instanceElementIndex;
      attribute float instanceOpacity;
      attribute float instanceCutPlaneImmune;
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying float vInstanceElementIndex;
      varying float vInstanceOpacity;
      varying float vInstanceCutPlaneImmune;
      varying vec3 vInstanceWorldCenter;
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
        #include <begin_vertex>
        vec4 instanceWorldCenter = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vInstanceEmissive = instanceEmissive;
        vInstanceEmissiveIntensity = instanceEmissiveIntensity;
        vInstanceUUID = instanceUUID;
        vInstanceElementIndex = instanceElementIndex;
        vInstanceOpacity = instanceOpacity;
        vInstanceCutPlaneImmune = instanceCutPlaneImmune;
        vInstanceWorldCenter = instanceWorldCenter.xyz;
      `
    );

    shader.fragmentShader = `
      uniform int uAlphaPass;
      uniform int uCutPlaneCount;
      uniform vec4 uCutPlanes[${MAX_CUT_PLANES}];
      uniform float uCutPlaneMaskSide[${MAX_CUT_PLANES}];
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying vec4 vInstanceUUID;
      varying float vInstanceElementIndex;
      varying float vInstanceOpacity;
      varying float vInstanceCutPlaneImmune;
      varying vec3 vInstanceWorldCenter;
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `
      vec4 diffuseColor = vec4( diffuse, opacity * vInstanceOpacity );
      if (uAlphaPass == 1 && diffuseColor.a < 0.999) discard;
      if (uAlphaPass == 2 && diffuseColor.a >= 0.999) discard;
      if (vInstanceCutPlaneImmune < 0.5) {
        for (int i = 0; i < ${MAX_CUT_PLANES}; i++) {
          if (i >= uCutPlaneCount) break;
          vec4 cutPlane = uCutPlanes[i];
          float planeSide = (dot(vInstanceWorldCenter, cutPlane.xyz) - cutPlane.w) * uCutPlaneMaskSide[i];
          if (planeSide > 0.0) {
            discard;
          }
        }
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      ` 
        totalEmissiveRadiance += vInstanceEmissive * vInstanceEmissiveIntensity;
      `
    );

    shader.uniforms.uAlphaPass = { value: material.userData.alphaPass ?? 0 };
    shader.uniforms.uCutPlaneCount = { value: 0 };
    shader.uniforms.uCutPlanes = {
      value: Array.from({ length: MAX_CUT_PLANES }, () => new THREE.Vector4(0, 0, 0, 0)),
    };
    shader.uniforms.uCutPlaneMaskSide = {
      value: new Float32Array(MAX_CUT_PLANES),
    };
    material.userData.shader = shader;
    applyAtomCutPlaneUniforms(material);
  };
  return material;
}

export function buildAtoms() {
  let atoms=fileBrowser.selectedStructure.atoms
  let structure = fileBrowser.selectedStructure
  //perdic.wrapped

  let wrapped = fileBrowser.selectedStructure.periodic.wrapped

  const atomCount = wrapped.elements.length;
  console.log("Building mesh for",atomCount,"atoms")

  // Geometry: unit sphere, scaled per instance
  const geometry = new THREE.SphereGeometry(1, 32, 24);

  // Material: visualization-mode dependent
  const material = createAtomsMaterial();

  finishAtomsMesh({ geometry, material, structure, wrapped, atoms, meshKey: 'atomsMesh', cutPlanes: true });
}




export function updateSingleAtomPosition(index, position) {
  //console.log("Updatng atom",index,"to",position)
  const a = groups.atomsMesh.instanceMatrix.array;
  const mOffset = index * 16;
  a[mOffset + 12] = position[0];
  a[mOffset + 13] = position[1];
  a[mOffset + 14] = position[2];

 // console.log("Matrix array length:", groups.atomsMesh.instanceMatrix.array.length);
 // console.log("Expected length:", 16 * groups.atomsMesh.count);
}

// ---------- PER-IMAGE (per periodic copy) STYLE OVERRIDES ----------
// When "Link periodic copies" is off, the Atoms tab edits individual on-screen
// copies. Styles live in structure.atomImageStyles keyed by atomImageKey()
// (srcIndex + integer image offset — stable across rebuilds for a fixed
// wrapped set) and ALWAYS win over the source atom's model values at
// repaint-from-model time, regardless of the toggle. The stored element is a
// stale-key sanity check (same policy as bondUserStyles).

/** Stable per-image key of a mesh instance, or null. */
export function atomImageKey(structure, instanceId) {
  return structure?.atomImageKeys?.[instanceId] ?? null;
}

/** The per-image style entry for an instance, or null (stale keys ignored). */
export function getAtomImageStyle(structure, instanceId) {
  const key = atomImageKey(structure, instanceId);
  const entry = key ? structure.atomImageStyles?.[key] : null;
  if (!entry) return null;
  return entry.element === structure.periodic?.wrapped?.elements?.[instanceId] ? entry : null;
}

/** Upsert per-image style fields for an instance; returns the entry (or null). */
export function setAtomImageStyle(structure, instanceId, patch) {
  const key = atomImageKey(structure, instanceId);
  if (!key) return null;
  structure.atomImageStyles ??= {};
  const entry = structure.atomImageStyles[key]
    ??= { element: structure.periodic?.wrapped?.elements?.[instanceId] };
  Object.assign(entry, patch);
  return entry;
}

/** Remove one style field (or the whole entry when field is null / emptied). */
export function clearAtomImageStyle(structure, instanceId, field = null) {
  const key = atomImageKey(structure, instanceId);
  const entry = key ? structure.atomImageStyles?.[key] : null;
  if (!entry) return;
  if (field) {
    delete entry[field];
    if (entry.color == null && entry.alpha == null && entry.radiusScale == null) {
      delete structure.atomImageStyles[key];
    }
  } else {
    delete structure.atomImageStyles[key];
  }
}

/** Clear a field (or everything) on every image of a source atom — used by
 *  linked-row and element-level edits so the newest edit wins. */
export function clearAtomImageStylesForAtom(structure, srcIndex, field = null) {
  (structure.atomImages?.[srcIndex] ?? []).forEach((imageIndex) => {
    clearAtomImageStyle(structure, imageIndex, field);
  });
}

/** Resolved face color of one on-screen copy (override ?? source atom color). */
export function getAtomImageColor(structure, instanceId) {
  const override = getAtomImageStyle(structure, instanceId)?.color;
  if (override != null) return override;
  const srcIndex = structure.periodic?.wrapped?.srcIndex?.[instanceId] ?? instanceId;
  return structure.atoms[srcIndex]?.getColor();
}

/** Paint one instance only — no source-atom model mutation. */
export function updateSingleAtomImageColor(instanceId, hex) {
  if (!groups.atomsMesh) return;
  groups.atomsMesh.setColorAt(instanceId, new THREE.Color(hex));
  groups.atomsMesh.instanceColor.needsUpdate = true;
}

export function updateSingleAtomColor(originalIndex, index, element, hex=null,userColor=null) {
  //console.log("Updating color of atom",index)
  let structure = fileBrowser.selectedStructure
  let atom = structure.atoms[originalIndex]
  if (hex == null){
    hex = structure.atoms[originalIndex].getColor(originalIndex)
    // Repaint-from-model path: a per-image override wins over the source color.
    const imageColor = getAtomImageStyle(structure, index)?.color;
    if (imageColor != null) hex = imageColor;
  }
  else{
    if (userColor==null){
      setAtomColor(atom, hex);
    }
    else{
      structure.atoms[originalIndex].userColor = userColor
      setAtomColor(atom, userColor);
    }
  }
  // console.log(`Element: ${element}, Hex: ${hex}, RGB: [${((hex >> 16) & 0xFF) / 255}, ${((hex >> 8) & 0xFF) / 255}, ${(hex & 0xFF) / 255}]`);
  groups.atomsMesh.setColorAt(index, new THREE.Color(hex));
  groups.atomsMesh.instanceColor.needsUpdate = true;
}

export function updateSingleAtomOpacity(index, opacity = 1.0) {
  const normalizedOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
  groups.atomsMesh.geometry.attributes.instanceOpacity.setX(index, normalizedOpacity);
  groups.atomsMesh.geometry.attributes.instanceOpacity.needsUpdate = true;
  syncAtomMaterialTransparency(general.mainOpacity);
}

export function updateSingleAtomCutPlaneImmunity(index, immune = false) {
  groups.atomsMesh.geometry.attributes.instanceCutPlaneImmune.setX(index, immune ? 1 : 0);
  groups.atomsMesh.geometry.attributes.instanceCutPlaneImmune.needsUpdate = true;
}

export function updateAtomCutPlaneState() {
  const mesh = groups.atomsMesh;
  if (!mesh || !fileBrowser.selectedStructure) return;
  const wrapped = fileBrowser.selectedStructure.periodic?.wrapped;
  if (!wrapped?.srcIndex) {
    applyAtomCutPlaneUniforms(mesh.material);
    return;
  }
  for (let i = 0; i < wrapped.srcIndex.length; i++) {
    const atom = fileBrowser.selectedStructure.atoms[wrapped.srcIndex[i]];
    updateSingleAtomCutPlaneImmunity(i, atom?.cutPlaneImmune);
  }
  applyAtomCutPlaneUniforms(mesh.material);
}

function syncAtomMaterialTransparency(baseOpacity = 1.0) {
  const mesh = groups.atomsMesh;
  if (!mesh?.material) return;
  const structure = fileBrowser.selectedStructure;
  const hasTransparentInstances = (structure?.atoms?.some((atom) => (atom.getOpacity?.() ?? atom.opacity ?? 1) < 0.999) ?? false)
    || Object.values(structure?.atomImageStyles ?? {}).some((entry) => (entry?.alpha ?? 1) < 0.999);
  const needsTransparency = baseOpacity < 0.999 || hasTransparentInstances;
  applyTransparency(mesh.material, {
    kind: 'atoms', opacity: baseOpacity, needsTransparency, perInstanceOpacity: true, mesh,
  });
  syncCelHullOpacitySuppression(mesh, baseOpacity);
}

export function updateSingleAtomDiameter(index, element, scale = 1) {
  const mesh = groups.atomsMesh;
  const a = mesh.instanceMatrix.array;
  const atomSize = general.atomSize;
  // Per-element visibility (Atoms tab header checkbox): hidden elements are
  // zero-scaled — renders nothing AND produces no raycast hits (unlike the
  // cut-plane shader discard). Checked here so no other diameter writer
  // (global size slider, per-atom/per-element size edits) can un-hide them.
  const hidden = general.atomVisibility?.[element] === false;
  const radius = hidden ? 0 : (atomicRadii[element] || 1.0) * atomSize * scale;
  const mOffset = index * 16;
  a[mOffset + 0] = radius;
  a[mOffset + 5] = radius;
  a[mOffset + 10] = radius;
}


export function updateAtoms(opacity = 1.0) {
  //console.error("Update main opacity", opacity)
  const atoms = fileBrowser.selectedStructure.atoms;
  const periodic = fileBrowser.selectedStructure.periodic;

  const wrapped = periodic.wrapped;
  const wrappedCart = wrapped.cart;
  const mesh = groups.atomsMesh;

  // Keep the instance -> element mapping current: FastFrameModule's compatibility
  // check compares against it, and a count-preserving membership change that lands
  // here (updateAtoms, not rebuildAtoms) would otherwise leave it stale forever.
  mesh.userData.elementNames = wrapped.elements;

  mesh.material.opacity = opacity;
  // Once per call (not per atom): syncAtomMaterialTransparency scans all atoms, so
  // calling it inside the loop was O(N^2). It handles transparency/depthWrite and
  // flags material.needsUpdate, which is why no separate material.needsUpdate is
  // needed at the end of this function.
  syncAtomMaterialTransparency(opacity);

  const emissiveAttr = mesh.geometry.attributes.instanceEmissive;
  const emissiveIntensityAttr = mesh.geometry.attributes.instanceEmissiveIntensity;
  const opacityAttr = mesh.geometry.attributes.instanceOpacity;
  const immuneAttr = mesh.geometry.attributes.instanceCutPlaneImmune;
  const structure = fileBrowser.selectedStructure;

  for (let i = 0; i < wrappedCart.length; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const atom = atoms[originalIndex];
    const imageStyle = getAtomImageStyle(structure, i);
    updateSingleAtomPosition(i, wrappedCart[i]);

    // Per-image overrides win over the source atom model; reuse one THREE.Color
    // instead of allocating per atom.
    _scratchColor.set(imageStyle?.color ?? atom.getColor(originalIndex));
    mesh.setColorAt(i, _scratchColor);
    updateSingleAtomDiameter(i, wrapped.elements[i], imageStyle?.radiusScale ?? atom.getRadiusScale?.() ?? 1);

    // Opacity + cut-plane immunity written inline (the per-atom helpers each flag
    // needsUpdate / re-sync transparency; done once after the loop instead).
    const op = imageStyle?.alpha ?? atom.getOpacity?.() ?? atom.opacity ?? 1;
    opacityAttr.setX(i, Math.max(0, Math.min(1, Number(op) || 0)));
    immuneAttr.setX(i, atom.cutPlaneImmune ? 1 : 0);

    emissiveAttr.setXYZ(i, 0, 0, 0);
    emissiveIntensityAttr.setX(i, 0.0);
  }

  // Mark attributes as needing update
  emissiveAttr.needsUpdate = true;
  emissiveIntensityAttr.needsUpdate = true;
  opacityAttr.needsUpdate = true;
  immuneAttr.needsUpdate = true;
  applyAtomCutPlaneUniforms(mesh.material);

  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
}
