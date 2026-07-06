// Encodes the live crystal scene into RGBA32F data textures for the
// ray-tracing pipeline's scene shader (see sceneFragment.js for the texel
// layouts). Reads the same sources the raster pipelines draw — the atoms/bonds
// InstancedMesh buffers, the polyhedra group, the lattice — so every existing
// write path (per-atom edits, trajectory frames, style changes) is picked up
// with no coupling into other modules. Change detection is a cheap
// fingerprint over the instanced-attribute `version` counters plus the
// polyhedra/lattice style values; the pipeline re-encodes and resets the
// progressive accumulation when it changes.

import * as THREE from '../../../external/three/three.module.js';
import { ConvexHull } from '../../../external/three/ConvexHull.js';
import { groups, fileBrowser, general } from '../../../state/store.js';
import { DATA_TEX_WIDTH } from './sceneFragment.js';

const MAX_PLANES = 20; // ConvexPolyhedronIntersect limit (vendored chunk)

// Ray/path-tracing material encoding: one texel (type, roughness, ior,
// intensity). Type codes match MAT_* in both scene shaders.
const MATERIAL_CODES = { standard: 0, metal: 1, glass: 2, emissive: 3 };
const DEFAULT_MATERIAL_TEXEL = [0, 0.2, 1.5, 5];

function materialTexel(mat) {
  if (!mat) return DEFAULT_MATERIAL_TEXEL;
  return [
    MATERIAL_CODES[mat.type] ?? 0,
    mat.roughness ?? 0.2,
    mat.ior ?? 1.5,
    mat.intensity ?? 5,
  ];
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mInv = new THREE.Matrix4();
const _halfY = new THREE.Matrix4().makeScale(1, 0.5, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _color = new THREE.Color();

function makeDataTexture(texelCount) {
  const height = Math.max(1, Math.ceil(texelCount / DATA_TEX_WIDTH));
  const texture = new THREE.DataTexture(
    new Float32Array(DATA_TEX_WIDTH * height * 4), DATA_TEX_WIDTH, height,
    THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

export class SceneEncoder {
  atomsTexture = makeDataTexture(1);
  cylindersTexture = makeDataTexture(1);
  polyTexture = makeDataTexture(1);
  atomCount = 0;
  cylinderCount = 0;
  polyCount = 0;
  boundingRadius = 10; // max atom distance from the origin (light placement)
  _fingerprint = '';

  dispose() {
    this.atomsTexture.dispose();
    this.cylindersTexture.dispose();
    this.polyTexture.dispose();
  }

  /** Cheap change detector; true when the scene must be re-encoded. */
  fingerprintChanged() {
    const parts = [];
    const atoms = groups.atomsMesh;
    if (atoms && atoms.visible) {
      parts.push('a', atoms.count, atoms.instanceMatrix.version, atoms.instanceColor?.version,
        atoms.geometry.attributes.instanceOpacity?.version, atoms.material.opacity);
    }
    const bonds = groups.bondsMesh;
    if (bonds && bonds.visible) {
      parts.push('b', bonds.count, bonds.instanceMatrix.version, bonds.instanceColor?.version,
        bonds.geometry.attributes.instanceOpacity?.version, bonds.material.opacity);
    }
    const polyGroup = groups.polyhedraGroup;
    if (polyGroup) {
      for (const mesh of polyGroup.children) {
        if (mesh.userData?.type !== 'polyhedron') continue;
        parts.push('p', mesh.id, mesh.visible ? 1 : 0,
          mesh.material.color.getHex(), mesh.material.opacity);
      }
    }
    if (general.showLattice && fileBrowser.selectedStructure?.lattice
        && (!groups.latticeGroup || groups.latticeGroup.visible)) {
      parts.push('l', String(fileBrowser.selectedStructure.lattice.flat()),
        general.latticeLineWidth, String(general.currentLatticeColor));
    }
    // material edits (small sparse maps; category stores also carry colors,
    // whose mesh-side changes are already covered above — harmless overlap)
    const structure = fileBrowser.selectedStructure;
    if (structure) {
      parts.push('m', JSON.stringify(structure.atomMaterials ?? {}),
        JSON.stringify(structure.bondCategoryStyles ?? {}),
        JSON.stringify(structure.polyhedraCategoryStyles ?? {}));
    }
    const fingerprint = parts.join('|');
    if (fingerprint === this._fingerprint) return false;
    this._fingerprint = fingerprint;
    return true;
  }

  /** Re-encode everything into the data textures. */
  encode() {
    this._encodeAtoms();
    this._encodeCylinders();
    this._encodePolyhedra();
  }

  _ensureCapacity(key, texelCount) {
    const texture = this[key];
    if (texture.image.width * texture.image.height >= texelCount) return texture;
    texture.dispose();
    return (this[key] = makeDataTexture(texelCount));
  }

  _encodeAtoms() {
    const mesh = groups.atomsMesh;
    if (!mesh || !mesh.visible) {
      this.atomCount = 0;
      return;
    }
    const structure = fileBrowser.selectedStructure;
    const srcIndex = structure?.periodic?.wrapped?.srcIndex;
    const atomMaterials = structure?.atomMaterials ?? {};
    const matrices = mesh.instanceMatrix.array;
    const colors = mesh.instanceColor.array;
    const opacities = mesh.geometry.attributes.instanceOpacity?.array;
    const baseOpacity = mesh.material.opacity ?? 1;
    const texture = this._ensureCapacity('atomsTexture', mesh.count * 3);
    const data = texture.image.data;
    let n = 0;
    let maxR2 = 25;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 16;
      const radius = matrices[o]; // uniform scale; 0 = hidden instance
      if (!(radius > 0)) continue;
      const d = n * 12;
      data[d] = matrices[o + 12];
      data[d + 1] = matrices[o + 13];
      data[d + 2] = matrices[o + 14];
      data[d + 3] = radius;
      const r2 = data[d] * data[d] + data[d + 1] * data[d + 1] + data[d + 2] * data[d + 2];
      if (r2 > maxR2) maxR2 = r2;
      data[d + 4] = colors[i * 3];
      data[d + 5] = colors[i * 3 + 1];
      data[d + 6] = colors[i * 3 + 2];
      data[d + 7] = (opacities ? opacities[i] : 1) * baseOpacity;
      // per-species material (instance -> source atom -> element)
      const element = structure?.elements?.[srcIndex ? srcIndex[i] : i];
      data.set(materialTexel(element ? atomMaterials[element] : null), d + 8);
      n++;
    }
    this.atomCount = n;
    this.boundingRadius = Math.sqrt(maxR2) + 3;
    texture.needsUpdate = true;
  }

  _encodeCylinders() {
    // bonds + unit-cell edges share the cylinder encoding (6 texels each)
    const bonds = (groups.bondsMesh && groups.bondsMesh.visible) ? groups.bondsMesh : null;
    const edges = this._latticeEdges();
    const total = (bonds ? bonds.count : 0) + edges.length;
    const texture = this._ensureCapacity('cylindersTexture', Math.max(1, total * 6));
    const data = texture.image.data;
    let n = 0;

    const writeCylinder = (invM, r, g, b, a, matTexel) => {
      const d = n * 24;
      data.set(invM.elements.slice(0, 4), d);       // column-major elements become
      data.set(invM.elements.slice(4, 8), d + 4);   // vec4 columns re-assembled by
      data.set(invM.elements.slice(8, 12), d + 8);  // GLSL's column-major mat4()
      data.set(invM.elements.slice(12, 16), d + 12);
      data[d + 16] = r; data[d + 17] = g; data[d + 18] = b; data[d + 19] = a;
      data.set(matTexel, d + 20);
      n++;
    };

    if (bonds) {
      const structure = fileBrowser.selectedStructure;
      const bondCategoryStyles = structure?.bondCategoryStyles ?? {};
      const matrices = bonds.instanceMatrix.array;
      const colors = bonds.instanceColor.array;
      const opacities = bonds.geometry.attributes.instanceOpacity?.array;
      const baseOpacity = bonds.material.opacity ?? 1;
      for (let i = 0; i < bonds.count; i++) {
        const o = i * 16;
        // zero-scaled halves are culled bonds
        if (matrices[o] === 0 && matrices[o + 5] === 0) continue;
        _m.fromArray(matrices, o);
        // raster bond halves use a height-1 cylinder (local y in [-0.5, 0.5]);
        // the ray-traced unit cylinder spans y in [-1, 1] — pre-scale by 0.5
        _m.multiply(_halfY);
        _mInv.copy(_m).invert();
        // per-pair material (instance i -> bond floor(i/2) -> sorted pair key)
        const elements = structure?.bonds?.[Math.floor(i / 2)]?.elements;
        let material = null;
        if (elements) {
          const [e1, e2] = elements;
          material = bondCategoryStyles[e1 < e2 ? `${e1}-${e2}` : `${e2}-${e1}`]?.material;
        }
        writeCylinder(_mInv, colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2],
          (opacities ? opacities[i] : 1) * baseOpacity, materialTexel(material));
      }
    }
    for (const edge of edges) {
      writeCylinder(edge.invM, edge.r, edge.g, edge.b, 1, DEFAULT_MATERIAL_TEXEL);
    }

    this.cylinderCount = n;
    texture.needsUpdate = true;
  }

  _latticeEdges() {
    if (!general.showLattice) return [];
    // honor direct group hiding too (raster paths may toggle the group)
    if (groups.latticeGroup && !groups.latticeGroup.visible) return [];
    const lattice = fileBrowser.selectedStructure?.lattice;
    if (!lattice) return [];
    const radius = Math.max(0.002, general.latticeLineWidth ?? 0.015);
    _color.set(general.currentLatticeColor);
    const [a, b, c] = lattice.map((row) => new THREE.Vector3(...row));
    const zero = new THREE.Vector3();
    // 12 parallelepiped edges: each lattice vector at 4 corner offsets
    const combos = [
      [a, [zero, b, c, b.clone().add(c)]],
      [b, [zero, a, c, a.clone().add(c)]],
      [c, [zero, a, b, a.clone().add(b)]],
    ];
    const edges = [];
    for (const [dir, offsets] of combos) {
      const len = dir.length();
      if (len < 1e-8) continue;
      const unit = dir.clone().normalize();
      for (const offset of offsets) {
        _pos.copy(offset).addScaledVector(dir, 0.5);
        _quat.setFromUnitVectors(_yAxis, unit);
        _scale.set(radius, len / 2, radius); // unit cylinder y in [-1,1]
        _m.compose(_pos, _quat, _scale);
        edges.push({ invM: _m.clone().invert(), r: _color.r, g: _color.g, b: _color.b });
      }
    }
    return edges;
  }

  _encodePolyhedra() {
    const group = groups.polyhedraGroup;
    const meshes = (group?.children ?? []).filter(
      (m) => m.userData?.type === 'polyhedron' && m.visible && this._polyPlanes(m));
    // layout: 4 header texels per poly up front, then the plane texels
    let planeTexels = 0;
    for (const mesh of meshes) planeTexels += mesh.userData.rtPlanes.length;
    const texture = this._ensureCapacity('polyTexture', Math.max(1, meshes.length * 4 + planeTexels));
    const data = texture.image.data;
    let planeOffset = meshes.length * 4;
    const structure = fileBrowser.selectedStructure;
    meshes.forEach((mesh, p) => {
      const planes = mesh.userData.rtPlanes;
      const aabb = mesh.userData.rtAabb;
      // per-category material, packed into the spare header/AABB w slots
      // (poly.catKey is stamped by PolyhedraModule.assignPolyhedraKeys; when
      // absent — list panel never built — the default material applies)
      const poly = structure?.polyhedra?.polyhedra?.[mesh.userData.polyIndex];
      const material = poly?.catKey
        ? structure?.polyhedraCategoryStyles?.[poly.catKey]?.material : null;
      const [matType, roughness, ior, intensity] = materialTexel(material);
      const d = p * 16;
      data[d] = planeOffset; data[d + 1] = planes.length; data[d + 2] = matType; data[d + 3] = roughness;
      _color.copy(mesh.material.color);
      data[d + 4] = _color.r; data[d + 5] = _color.g; data[d + 6] = _color.b;
      data[d + 7] = mesh.material.opacity ?? 1;
      data[d + 8] = aabb.min.x; data[d + 9] = aabb.min.y; data[d + 10] = aabb.min.z; data[d + 11] = ior;
      data[d + 12] = aabb.max.x; data[d + 13] = aabb.max.y; data[d + 14] = aabb.max.z; data[d + 15] = intensity;
      for (const plane of planes) {
        data.set(plane, planeOffset * 4);
        planeOffset++;
      }
    });
    this.polyCount = meshes.length;
    texture.needsUpdate = true;
  }

  /** World-space face planes (deduped, <= MAX_PLANES) + AABB for one
   *  polyhedron mesh, cached on its userData (dies with the mesh on rebuild).
   *  Returns false (and warns once) for polyhedra beyond the plane limit. */
  _polyPlanes(mesh) {
    if (mesh.userData.rtPlanes) return true;
    if (mesh.userData.rtPlanesUnsupported) return false;
    const polyIndex = mesh.userData.polyIndex;
    const poly = fileBrowser.selectedStructure?.polyhedra?.polyhedra?.[polyIndex];
    const vertices = poly?.vertices;
    if (!vertices || vertices.length < 4) {
      mesh.userData.rtPlanesUnsupported = true;
      return false;
    }
    const points = vertices.map((v) => new THREE.Vector3(v[0], v[1], v[2]));
    let hull;
    try {
      hull = new ConvexHull().setFromPoints(points);
    } catch {
      mesh.userData.rtPlanesUnsupported = true;
      return false;
    }
    // dedupe coplanar hull faces into unique (normal, constant) planes
    const planes = [];
    for (const face of hull.faces) {
      const n = face.normal, w = face.constant;
      if (!planes.some((p) => (p[0] * n.x + p[1] * n.y + p[2] * n.z) > 0.9999
          && Math.abs(p[3] - w) < 1e-4)) {
        planes.push([n.x, n.y, n.z, w]);
      }
    }
    if (planes.length > MAX_PLANES) {
      console.warn(`raytrace: polyhedron with ${planes.length} faces exceeds the `
        + `${MAX_PLANES}-plane limit of ConvexPolyhedronIntersect — skipped`);
      mesh.userData.rtPlanesUnsupported = true;
      return false;
    }
    const aabb = new THREE.Box3().setFromPoints(points);
    mesh.userData.rtPlanes = planes;
    mesh.userData.rtAabb = aabb;
    return true;
  }
}
