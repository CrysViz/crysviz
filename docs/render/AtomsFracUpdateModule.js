import * as THREE from '../external/three/three.module.js';

import { app, groups,fileBrowser, general} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {getAtomVisSettings} from '../defaults/color_texture_defaults.js'

import { getCutPlaneMaskSign } from '../model/Plane.js';
import {createStyledMaterial, addCelOutline, MAX_CUT_PLANES} from './MaterialStyles.js'
import {CEL_OUTLINE_LAYER} from './CelOutlinePass.js'
import {runPeriodicWrapped} from './LatticeModule.js'

import {setAtomColor}  from '../utils/ColorModule.js';


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
  // In hull outline mode the outline shell discards by the same planes, and the
  // transparent-instance overlay pass carries the same shader uniforms.
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
    const overlay = groups.atomsMesh.userData.transparentOverlay;
    if (overlay) {
      overlay.geometry.dispose(); // shares vertex buffers with the main geometry, disposed below anyway
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

// Material for the main atoms mesh and its transparent-instance overlay pass
// (see syncAtomMaterialTransparency). uAlphaPass splits instances by their
// effective alpha: 0 = draw all (single-pass), 1 = opaque instances only,
// 2 = transparent instances only.
function createAtomsMaterial() {
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

function setAtomAlphaPass(material, pass) {
  material.userData.alphaPass = pass;
  const uniform = material.userData.shader?.uniforms?.uAlphaPass;
  if (uniform) uniform.value = pass;
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

// Second render pass for per-instance transparency: a compact, depth-SORTED
// child InstancedMesh holding private copies of ONLY the transparent
// instances, blended and depth-TESTED against the opaque instances the main
// pass drew with depth writes on. Instances inside one InstancedMesh render
// in index order — three.js cannot depth-sort them — so the overlay's buffers
// are rewritten back-to-front relative to the camera on every rendered frame
// (syncTransparentOverlayInstances), which makes transparent-over-transparent
// blending order-correct too. The main mesh's buffers are never permuted:
// instance indices are stable atom ids for picking / per-atom edits /
// selection, so the sort only touches the overlay's private copies, and
// re-copying from the live main buffers each frame keeps every write path
// (trajectory positions, colors, emissive highlights) in sync for free.
//
// The sort runs from scene.onBeforeRender — NOT the overlay's own
// onBeforeRender: the renderer uploads needsUpdate'd attributes during
// projectObject (WebGLObjects.update), which happens BEFORE per-object
// onBeforeRender fires, so buffers mutated there would draw one frame stale.
// scene.onBeforeRender fires after the camera matrices update and before
// projectObject — same-frame, current camera, and it covers every
// renderer.render() caller (main loop, PNG export).

// Per-instance attributes mirrored into the overlay: geometry-level ones
// here, plus instanceMatrix / instanceColor which live on the mesh.
/** @type {Array<[string, number]>} */
const OVERLAY_INSTANCED_ATTRS = [
  ['instanceOpacity', 1],
  ['instanceCutPlaneImmune', 1],
  ['instanceEmissive', 3],
  ['instanceEmissiveIntensity', 1],
  ['instanceUUID', 4],
  ['instanceElementIndex', 1],
];

function ensureTransparentAtomsOverlay(mesh) {
  let overlay = mesh.userData.transparentOverlay;
  if (overlay) return overlay;
  const material = createAtomsMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.userData.alphaPass = 2; // no-op safety net: buffers only hold transparent instances

  const capacity = mesh.count;
  // Own geometry: sphere vertex data shared by reference, instance data private
  // (the sort permutes it, so it cannot alias the main mesh's attributes).
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(mesh.geometry.getIndex());
  geometry.setAttribute('position', mesh.geometry.attributes.position);
  geometry.setAttribute('normal', mesh.geometry.attributes.normal);
  geometry.setAttribute('uv', mesh.geometry.attributes.uv);
  for (const [name, itemSize] of OVERLAY_INSTANCED_ATTRS) {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
  }

  overlay = new THREE.InstancedMesh(geometry, material, capacity);
  overlay.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  overlay.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  overlay.instanceColor.setUsage(THREE.DynamicDrawUsage);
  overlay.raycast = () => {}; // never intercept picking
  overlay.frustumCulled = false; // contents are rewritten per frame; skip stale culling
  overlay.name = 'transparentAtomsOverlay';
  mesh.userData.transparentOverlay = overlay;
  mesh.add(overlay);

  // Reads groups.atomsMesh live, so one assignment survives atom rebuilds.
  app.scene.onBeforeRender = (renderer, scene, camera) => {
    const atomsMesh = groups.atomsMesh;
    const liveOverlay = atomsMesh?.userData.transparentOverlay;
    if (liveOverlay?.visible) syncTransparentOverlayInstances(atomsMesh, liveOverlay, camera);
  };
  return overlay;
}

/** Rewrite the overlay's instance buffers with the transparent instances of
 *  the main atoms mesh, sorted back-to-front in view space. */
function syncTransparentOverlayInstances(mesh, overlay, camera) {
  const srcAttrs = mesh.geometry.attributes;
  const srcOpacity = srcAttrs.instanceOpacity.array;
  const srcMatrix = mesh.instanceMatrix.array;
  // View-space depth from row 3 of the inverse world matrix — valid for both
  // the perspective and the default orthographic camera.
  const e = camera.matrixWorldInverse.elements;
  /** @type {Array<[number, number]>} */
  const order = [];
  for (let i = 0; i < mesh.count; i++) {
    if (srcOpacity[i] >= 0.999) continue;
    const o = i * 16;
    const z = e[2] * srcMatrix[o + 12] + e[6] * srcMatrix[o + 13] + e[10] * srcMatrix[o + 14] + e[14];
    order.push([z, i]);
  }
  order.sort((a, b) => a[0] - b[0]); // most negative z = farthest = drawn first

  const dstAttrs = overlay.geometry.attributes;
  const srcColor = mesh.instanceColor.array;
  const dstMatrix = overlay.instanceMatrix.array;
  const dstColor = overlay.instanceColor.array;
  for (let k = 0; k < order.length; k++) {
    const i = order[k][1];
    dstMatrix.set(srcMatrix.subarray(i * 16, i * 16 + 16), k * 16);
    dstColor.set(srcColor.subarray(i * 3, i * 3 + 3), k * 3);
    for (const [name, itemSize] of OVERLAY_INSTANCED_ATTRS) {
      dstAttrs[name].array.set(
        srcAttrs[name].array.subarray(i * itemSize, i * itemSize + itemSize), k * itemSize);
    }
  }
  overlay.count = order.length;
  overlay.instanceMatrix.needsUpdate = true;
  overlay.instanceColor.needsUpdate = true;
  for (const [name] of OVERLAY_INSTANCED_ATTRS) dstAttrs[name].needsUpdate = true;
}

function syncAtomMaterialTransparency(baseOpacity = 1.0) {
  const mesh = groups.atomsMesh;
  if (!mesh?.material) return;
  const structure = fileBrowser.selectedStructure;
  const hasTransparentInstances = (structure?.atoms?.some((atom) => (atom.getOpacity?.() ?? atom.opacity ?? 1) < 0.999) ?? false)
    || Object.values(structure?.atomImageStyles ?? {}).some((entry) => (entry?.alpha ?? 1) < 0.999);
  // Whole-structure transparency (opacity slider) keeps the legacy single
  // blended pass: every atom blends, so per-pair order errors are much less
  // visible than losing the see-through-everything look.
  const globalTransparency = baseOpacity < 0.999;
  const splitPasses = !globalTransparency && hasTransparentInstances;
  mesh.material.transparent = globalTransparency;
  mesh.material.depthWrite = !globalTransparency;
  setAtomAlphaPass(mesh.material, splitPasses ? 1 : 0);
  mesh.material.needsUpdate = true;

  const overlay = splitPasses ? ensureTransparentAtomsOverlay(mesh) : mesh.userData.transparentOverlay;
  if (overlay) {
    overlay.visible = splitPasses;
    overlay.material.opacity = baseOpacity;
  }
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
  let atoms = [...fileBrowser.selectedStructure.atoms];
  let periodic = fileBrowser.selectedStructure.periodic;

  let wrapped;
  let wrappedCart;

  wrapped = periodic.wrapped
  wrappedCart = wrapped.cart
  const mesh = groups.atomsMesh

  mesh.material.opacity = opacity;
  syncAtomMaterialTransparency(opacity);

  const structure = fileBrowser.selectedStructure;
  for (let i = 0; i < wrappedCart.length; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    // Per-image (per periodic copy) overrides win over the source atom's model
    // values (color is resolved inside updateSingleAtomColor's hex==null path).
    const imageStyle = getAtomImageStyle(structure, i);
    updateSingleAtomPosition(i, wrappedCart[i])
    updateSingleAtomColor(originalIndex,i, wrapped.elements[i])
    updateSingleAtomDiameter(i, wrapped.elements[i], imageStyle?.radiusScale ?? atoms[originalIndex].getRadiusScale?.() ?? 1)
    updateSingleAtomOpacity(i, imageStyle?.alpha ?? atoms[originalIndex].getOpacity?.() ?? atoms[originalIndex].opacity ?? 1)
    updateSingleAtomCutPlaneImmunity(i, atoms[originalIndex].cutPlaneImmune)

    groups.atomsMesh.geometry.attributes.instanceEmissive.setXYZ(i, 0, 0, 0);
    groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.setX(i, 0.0);
  }

  // Mark attributes as needing update
  groups.atomsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceOpacity.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceCutPlaneImmune.needsUpdate = true;
  applyAtomCutPlaneUniforms(mesh.material);

  groups.atomsMesh.instanceMatrix.needsUpdate = true;
  groups.atomsMesh.instanceColor.needsUpdate = true;
  groups.atomsMesh.material.needsUpdate = true;
  
}
