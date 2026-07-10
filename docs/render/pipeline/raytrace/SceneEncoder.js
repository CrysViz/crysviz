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
import { groups, fileBrowser, general, app } from '../../../state/store.js';
import { bondKey } from '../../BondsFracUpdateModule.js';
import { getAtomImageStyle } from '../../AtomsFracUpdateModule.js';
import { MAX_CUT_PLANES } from '../../MaterialStyles.js';
import { getCutPlaneMaskSign, Plane } from '../../../model/index.js';
import { DATA_TEX_WIDTH } from './sceneFragment.js';

const MAX_PLANES = 20; // ConvexPolyhedronIntersect limit (vendored chunk)

// Ray/path-tracing material encoding: one texel with TYPE-MULTIPLEXED slots
// (the per-type knobs are mutually exclusive, so no layout growth needed):
//   standard:    (0, 0,          gloss,        reflectivity | -1)
//   metal:       (1, roughness,  0,            reflectivity | -1)
//   glass:       (2, frost,      ior,          tintDepth)
//   emissive:    (3, 0,          intensity,    0)
//   translucent: (4, 0,          scatterDepth, 0)
// reflectivity -1 = "use the global Reflectivity slider" (standard) / ideal
// mirror (metal). Codes/slots must match resolveMaterialType/resolveHitType
// in BOTH scene shaders.
const MATERIAL_CODES = { standard: 0, metal: 1, glass: 2, emissive: 3, translucent: 4 };
const DEFAULT_MATERIAL_TEXEL = [0, 0, 0.6, -1]; // standard, gloss 0.6 = classic look

function materialTexel(mat) {
  if (!mat) return DEFAULT_MATERIAL_TEXEL;
  switch (mat.type) {
    case 'metal':
      return [1, mat.roughness ?? 0.2, 0, mat.reflectivity ?? -1];
    case 'glass':
      return [2, mat.frost ?? 0, mat.ior ?? 1.5, mat.tintDepth ?? 0.2];
    case 'emissive':
      return [3, 0, mat.intensity ?? 5, 0];
    case 'translucent':
      return [4, 0, mat.scatterDepth ?? 0.5, 0];
    default: // standard
      return [0, 0, mat.gloss ?? 0.6, mat.reflectivity ?? -1];
  }
}

const _pos = new THREE.Vector3();
const _pos2 = new THREE.Vector3();
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

const FIELD_TEXEL_CAP = 16777216; // 256^3: max voxels uploaded (downsample above)

// A single-voxel R32F volume, bound to the sampler whenever no field is active
// (the shader's uFieldEnabled=false branch never samples it, but the sampler
// must still point at a valid texture).
function makeVolumeTexture(values, nx, ny, nz) {
  const texture = new THREE.Data3DTexture(values, nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.FloatType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const PLANE_ATLAS_TILE = 256; // RGBA8 colormap-atlas region per Field-mode plane

// An RGBA8 colour atlas for Field-mode lattice planes. LinearFilter so the
// shader gets bilinear filtering for free; the encoder insets each tile's
// sampling rect by half a texel so neighbouring tiles never bleed.
function makeAtlasTexture(data, width, height) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
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
  minY = -5; // lowest atom point (ground plane placement; driver adds the offset)
  structureCenter = new THREE.Vector3(); // atom bounding-box center
  structureRadius = 5; // half-diagonal of the atom bounding box (from the center)
  _fingerprint = '';

  // ---- volumetric field (isosurface) --------------------------------------
  // fieldTexture always points at a valid Data3DTexture (a 1-voxel dummy when
  // no field is active); the pipeline reads these into its uField* uniforms.
  _dummyFieldTexture = makeVolumeTexture(new Float32Array([0]), 1, 1, 1);
  _realFieldTexture = null; // the uploaded field volume (disposed on replace)
  fieldTexture = this._dummyFieldTexture;
  fieldEnabled = false;
  fieldWorldToFrac = new THREE.Matrix4();
  fieldDims = [1, 1, 1];
  fieldIso = 0;
  fieldAbsMode = false;
  fieldPosColor = new THREE.Color(0x33aaff);
  fieldNegColor = new THREE.Color(0xff3333);
  fieldAlpha = 0.6;
  _fieldValuesRef = null; // last uploaded field.values (re-upload on change)
  _fieldDimsKey = '';

  // ---- crystallographic lattice planes ------------------------------------
  // planesTexture holds 6 texels/plane (see planeChunk.js); planeAtlasTexture
  // is the shared RGBA8 colormap atlas for Field-mode planes (a 1x1 dummy when
  // no Field plane is present). cellWorldToFrac clips planes to the unit cell.
  planesTexture = makeDataTexture(1);
  planeCount = 0;
  cellWorldToFrac = new THREE.Matrix4();
  _dummyAtlas = makeAtlasTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  _realAtlas = null; // the baked colormap atlas (disposed on replace)
  planeAtlasTexture = this._dummyAtlas;

  dispose() {
    this.atomsTexture.dispose();
    this.cylindersTexture.dispose();
    this.polyTexture.dispose();
    this.planesTexture.dispose();
    this._dummyAtlas.dispose();
    if (this._realAtlas) this._realAtlas.dispose();
    this._dummyFieldTexture.dispose();
    if (this._realFieldTexture) this._realFieldTexture.dispose();
  }

  /** Cheap change detector; true when the scene must be re-encoded. */
  fingerprintChanged() {
    const parts = [];
    const atoms = groups.atomsMesh;
    if (atoms && atoms.visible) {
      parts.push('a', atoms.count, atoms.instanceMatrix.version, atoms.instanceColor?.version,
        atoms.geometry.attributes.instanceOpacity?.version, atoms.material.opacity,
        atoms.geometry.attributes.instanceCutPlaneImmune?.version);
    }
    // cut planes remove whole atoms at encode time; re-encode when they change
    // (only the enabled-relevant fields matter — see _activeCutPlanes)
    if (Array.isArray(general.atomCutPlanes)) {
      parts.push('cut', JSON.stringify(general.atomCutPlanes
        .filter((plane) => plane?.enabled)
        .map((plane) => [plane.x, plane.y, plane.z, plane.r, plane.side])));
    }
    const bonds = groups.bondsMesh;
    if (bonds && bonds.visible) {
      parts.push('b', bonds.count, bonds.instanceMatrix.version, bonds.instanceColor?.version,
        bonds.geometry.attributes.instanceOpacity?.version, bonds.material.opacity);
    }
    const polyGroup = groups.polyhedraGroup;
    if (polyGroup) {
      parts.push('pe', general.polyEdgeWidth ?? 1);
      for (const mesh of polyGroup.children) {
        if (mesh.userData?.type !== 'polyhedron') continue;
        parts.push('p', mesh.id, mesh.visible ? 1 : 0,
          mesh.material.color.getHex(), mesh.material.opacity);
        const edgeLines = mesh.children?.find((c) => c.userData?.type === 'polyhedron-edges');
        if (edgeLines?.material) {
          parts.push(edgeLines.visible ? 1 : 0,
            edgeLines.material.color.getHex(), edgeLines.material.opacity);
        }
      }
    }
    if (general.showLattice && fileBrowser.selectedStructure?.lattice
        && (!groups.latticeGroup || groups.latticeGroup.visible)) {
      parts.push('l', String(fileBrowser.selectedStructure.lattice.flat()),
        general.latticeLineWidth, String(general.currentLatticeColor));
    }
    // material edits (small sparse maps; the style stores also carry colors,
    // whose mesh-side changes are already covered above — harmless overlap)
    const structure = fileBrowser.selectedStructure;
    if (structure) {
      parts.push('m', JSON.stringify(structure.atomMaterials ?? {}),
        JSON.stringify(structure.atomUserMaterials ?? {}),
        JSON.stringify(structure.atomImageStyles ?? {}),
        JSON.stringify(structure.bondCategoryStyles ?? {}),
        JSON.stringify(structure.bondUserStyles ?? {}),
        JSON.stringify(structure.polyhedraCategoryStyles ?? {}),
        JSON.stringify(structure.polyhedraUserStyles ?? {}));
    }
    // volumetric field isosurface (same source the raster pipelines draw):
    // presence/visibility, dims, iso, abs mode, pos/neg colours, opacity, and
    // a cheap identity probe so a swapped field of the same dims re-encodes.
    const field = this._activeField();
    if (field) {
      const iso = groups.isosurfaceGroup;
      const vals = field.values;
      parts.push('f', field.nx, field.ny, field.nz, field.isoValue,
        field.useAbsoluteIsoValue ? 1 : 0,
        iso.meshes?.positive?.material?.color?.getHexString(),
        iso.meshes?.negative?.material?.color?.getHexString(),
        iso.meshes?.positive?.material?.opacity,
        vals?.length, vals ? vals[0] : 0, vals ? vals[(vals.length / 2) | 0] : 0);
    }
    // crystallographic lattice planes: geometry (n/d), mode, flat colour +
    // opacity, colormap name + range, and a cheap field-identity probe so a
    // field/colormap edit re-encodes (and re-bakes the atlas).
    const planes = this._visiblePlanes();
    for (const plane of planes) {
      const n = plane.planeNormal;
      const mat = plane.material;
      const f = plane.field;
      const vals = f?.values;
      parts.push('pl', plane.mode, n.x, n.y, n.z, plane.planeD,
        mat?.color?.getHex?.(), mat?.opacity,
        plane.colormap, plane.colormapMin, plane.colormapMax,
        f ? `${f.label}|${f.nx}|${f.ny}|${f.nz}|${f.minValue}|${f.maxValue}` : 'nofield',
        vals?.length, vals ? vals[(vals.length / 2) | 0] : 0);
    }
    parts.push('plc', planes.length);
    const fingerprint = parts.join('|');
    if (fingerprint === this._fingerprint) return false;
    this._fingerprint = fingerprint;
    return true;
  }

  /** The live volumetric field to trace, or null. Same source as the raster
   *  isosurface: the isosurfaceGroup, in the scene (clearField removes it) and
   *  not hidden, carrying a field with values. */
  _activeField() {
    const iso = groups.isosurfaceGroup;
    const field = iso?.field;
    if (!field || !field.values || !(field.nx > 0) || !(field.ny > 0) || !(field.nz > 0)) return null;
    if (!iso.parent) return null; // removed from the scene (clearField)
    if (field.isVisible === false) return null;
    return field;
  }

  /** Re-encode everything into the data textures. */
  encode() {
    this._encodeAtoms();
    this._encodeCylinders();
    this._encodePolyhedra();
    this._encodeField();
    this._encodePlanes();
  }

  /** Visible crystallographic Plane groups in the scene (their `.visible`
   *  already encodes planesData.showPlanes && planeDef.enabled). */
  _visiblePlanes() {
    const children = app.scene?.children;
    if (!Array.isArray(children)) return [];
    return children.filter((obj) => obj instanceof Plane && obj.visible);
  }

  _ensureCapacity(key, texelCount) {
    const texture = this[key];
    if (texture.image.width * texture.image.height >= texelCount) return texture;
    texture.dispose();
    return (this[key] = makeDataTexture(texelCount));
  }

  /** Enabled atom cut planes as {nx,ny,nz,w,sign}, replicating the raster
   *  semantics (AtomsFracUpdateModule.applyCutPlaneUniformsToShader):
   *  normalized normal, w = r, sign = getCutPlaneMaskSign(side), degenerate
   *  normals fall back to (1,0,0), capped at MAX_CUT_PLANES. */
  _activeCutPlanes() {
    const planes = general.atomCutPlanes;
    if (!Array.isArray(planes) || planes.length === 0) return [];
    const active = [];
    for (const plane of planes) {
      if (!plane?.enabled) continue;
      let nx = Number(plane.x) || 0, ny = Number(plane.y) || 0, nz = Number(plane.z) || 0;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-8) { nx = 1; ny = 0; nz = 0; } // raster normalizePlaneNormal fallback
      else { nx /= len; ny /= len; nz /= len; }
      active.push({ nx, ny, nz, w: Number(plane.r) || 0, sign: getCutPlaneMaskSign(plane.side) });
      if (active.length >= MAX_CUT_PLANES) break;
    }
    return active;
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
    const atomUserMaterials = structure?.atomUserMaterials ?? {};
    const matrices = mesh.instanceMatrix.array;
    const colors = mesh.instanceColor.array;
    const opacities = mesh.geometry.attributes.instanceOpacity?.array;
    const baseOpacity = mesh.material.opacity ?? 1;
    // whole-atom cut-plane removal by world CENTER, matching the raster shader
    // discard (AtomsFracUpdateModule); per-atom "Keep" immunity is honored.
    const cutPlanes = this._activeCutPlanes();
    const immune = mesh.geometry.attributes.instanceCutPlaneImmune?.array;
    const texture = this._ensureCapacity('atomsTexture', mesh.count * 3);
    const data = texture.image.data;
    let n = 0;
    let maxR2 = 25;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 16;
      const radius = matrices[o]; // uniform scale; 0 = hidden instance
      if (!(radius > 0)) continue;
      if (cutPlanes.length && !(immune && immune[i] >= 0.5)) {
        const cx = matrices[o + 12], cy = matrices[o + 13], cz = matrices[o + 14];
        let cut = false;
        for (const p of cutPlanes) {
          if ((cx * p.nx + cy * p.ny + cz * p.nz - p.w) * p.sign > 0) { cut = true; break; }
        }
        if (cut) continue;
      }
      const d = n * 12;
      data[d] = matrices[o + 12];
      data[d + 1] = matrices[o + 13];
      data[d + 2] = matrices[o + 14];
      data[d + 3] = radius;
      const r2 = data[d] * data[d] + data[d + 1] * data[d + 1] + data[d + 2] * data[d + 2];
      if (r2 > maxR2) maxR2 = r2;
      if (data[d] - radius < minX) minX = data[d] - radius;
      if (data[d] + radius > maxX) maxX = data[d] + radius;
      if (data[d + 1] - radius < minY) minY = data[d + 1] - radius;
      if (data[d + 1] + radius > maxY) maxY = data[d + 1] + radius;
      if (data[d + 2] - radius < minZ) minZ = data[d + 2] - radius;
      if (data[d + 2] + radius > maxZ) maxZ = data[d + 2] + radius;
      data[d + 4] = colors[i * 3];
      data[d + 5] = colors[i * 3 + 1];
      data[d + 6] = colors[i * 3 + 2];
      data[d + 7] = (opacities ? opacities[i] : 1) * baseOpacity;
      // per-copy override > per-atom override > per-species material
      // (per-copy = "Link periodic copies" off, stored in atomImageStyles)
      const src = srcIndex ? srcIndex[i] : i;
      const element = structure?.elements?.[src];
      data.set(materialTexel(
        getAtomImageStyle(structure, i)?.material
          ?? atomUserMaterials[src]
          ?? (element ? atomMaterials[element] : null)), d + 8);
      n++;
    }
    this.atomCount = n;
    this.boundingRadius = Math.sqrt(maxR2) + 3;
    this.minY = Number.isFinite(minY) ? minY : -5;
    if (Number.isFinite(minX)) {
      this.structureCenter.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      this.structureRadius = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) / 2;
    } else {
      this.structureCenter.set(0, 0, 0);
      this.structureRadius = 5;
    }
    texture.needsUpdate = true;
  }

  _encodeCylinders() {
    // bonds + unit-cell edges + polyhedra edges share the cylinder encoding
    // (6 texels each)
    const bonds = (groups.bondsMesh && groups.bondsMesh.visible) ? groups.bondsMesh : null;
    const edges = this._latticeEdges();
    const polyEdges = this._polyEdges();
    const planeBorders = this._planeBorders();
    const total = (bonds ? bonds.count : 0) + edges.length + polyEdges.length + planeBorders.length;
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
        // per-bond override > per-pair material (instance i -> bond floor(i/2))
        const bond = structure?.bonds?.[Math.floor(i / 2)];
        let material = null;
        if (bond) {
          material = (bond.indices
            ? structure.bondUserStyles?.[bondKey(bond.indices)]?.material : null) ?? null;
          if (!material && bond.elements) {
            const [e1, e2] = bond.elements;
            material = bondCategoryStyles[e1 < e2 ? `${e1}-${e2}` : `${e2}-${e1}`]?.material;
          }
        }
        writeCylinder(_mInv, colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2],
          (opacities ? opacities[i] : 1) * baseOpacity, materialTexel(material));
      }
    }
    for (const edge of edges) {
      writeCylinder(edge.invM, edge.r, edge.g, edge.b, 1, DEFAULT_MATERIAL_TEXEL);
    }
    for (const edge of polyEdges) {
      writeCylinder(edge.invM, edge.r, edge.g, edge.b, edge.a, DEFAULT_MATERIAL_TEXEL);
    }
    for (const edge of planeBorders) {
      writeCylinder(edge.invM, edge.r, edge.g, edge.b, edge.a, DEFAULT_MATERIAL_TEXEL);
    }

    this.cylinderCount = n;
    texture.needsUpdate = true;
  }

  /** Purple perimeter borders of 'None'-mode lattice planes as thin cylinders
   *  (appended to the cylinder bucket, exactly like polyhedra edges). The plane
   *  Group sits at scene identity, so its border LineSegments positions are
   *  already world-space. Radius pinned to the unit-cell line thickness. */
  _planeBorders() {
    const planes = this._visiblePlanes();
    if (planes.length === 0) return [];
    const radius = 0.02;
    const result = [];
    for (const plane of planes) {
      if (plane.mode !== 'None') continue; // border shown only in None mode
      const border = plane.border;
      if (!border?.visible) continue;
      const pos = border.geometry?.getAttribute?.('position');
      const seg = pos?.array;
      if (!seg) continue;
      _color.copy(border.material.color);
      for (let s = 0; s + 5 < seg.length; s += 6) {
        const dx = seg[s + 3] - seg[s];
        const dy = seg[s + 4] - seg[s + 1];
        const dz = seg[s + 5] - seg[s + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) continue;
        _pos.set((seg[s] + seg[s + 3]) / 2, (seg[s + 1] + seg[s + 4]) / 2, (seg[s + 2] + seg[s + 5]) / 2);
        _scale.set(radius, len / 2, radius); // unit cylinder y in [-1,1]
        _quat.setFromUnitVectors(_yAxis, _pos2.set(dx / len, dy / len, dz / len));
        _m.compose(_pos, _quat, _scale);
        result.push({ invM: _m.clone().invert(), r: _color.r, g: _color.g, b: _color.b, a: 1 });
      }
    }
    return result;
  }

  /** Polyhedra edge segments as thin cylinders. The raster edges are fat
   *  lines in PIXEL units; here the width maps to world units pinned to the
   *  unit-cell line thickness (polyEdgeWidth 1 ~ a 0.015-radius cell edge). */
  _polyEdges() {
    const width = general.polyEdgeWidth ?? 1;
    if (!(width > 0)) return [];
    const group = groups.polyhedraGroup;
    if (!group) return [];
    const radius = 0.015 * width;
    const result = [];
    for (const mesh of group.children) {
      if (mesh.userData?.type !== 'polyhedron' || !mesh.visible) continue;
      const edgeLines = mesh.children?.find((c) => c.userData?.type === 'polyhedron-edges');
      const segments = edgeLines?.userData?.segments;
      if (!edgeLines?.visible || !segments) continue;
      const alpha = edgeLines.material?.opacity ?? 1;
      if (alpha <= 0.01) continue;
      _color.copy(edgeLines.material.color);
      for (let s = 0; s + 5 < segments.length; s += 6) {
        const dx = segments[s + 3] - segments[s];
        const dy = segments[s + 4] - segments[s + 1];
        const dz = segments[s + 5] - segments[s + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) continue;
        _pos.set((segments[s] + segments[s + 3]) / 2,
          (segments[s + 1] + segments[s + 4]) / 2,
          (segments[s + 2] + segments[s + 5]) / 2);
        _scale.set(radius, len / 2, radius); // unit cylinder y in [-1,1]
        _quat.setFromUnitVectors(_yAxis, _pos2.set(dx / len, dy / len, dz / len));
        _m.compose(_pos, _quat, _scale);
        result.push({ invM: _m.clone().invert(), r: _color.r, g: _color.g, b: _color.b, a: alpha });
      }
    }
    return result;
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
      // per-polyhedron override > per-category material, packed into the
      // spare header/AABB w slots (poly.key/catKey are stamped by
      // PolyhedraModule.assignPolyhedraKeys; when absent — list panel never
      // built — the default material applies)
      const poly = structure?.polyhedra?.polyhedra?.[mesh.userData.polyIndex];
      const material = (poly?.key ? structure?.polyhedraUserStyles?.[poly.key]?.material : null)
        ?? (poly?.catKey ? structure?.polyhedraCategoryStyles?.[poly.catKey]?.material : null);
      const [matType, roughness, typeParam, reflectivity] = materialTexel(material);
      const d = p * 16;
      data[d] = planeOffset; data[d + 1] = planes.length; data[d + 2] = matType; data[d + 3] = roughness;
      _color.copy(mesh.material.color);
      data[d + 4] = _color.r; data[d + 5] = _color.g; data[d + 6] = _color.b;
      data[d + 7] = mesh.material.opacity ?? 1;
      data[d + 8] = aabb.min.x; data[d + 9] = aabb.min.y; data[d + 10] = aabb.min.z; data[d + 11] = typeParam;
      data[d + 12] = aabb.max.x; data[d + 13] = aabb.max.y; data[d + 14] = aabb.max.z; data[d + 15] = reflectivity;
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

  /** Encode the live isosurface field for the tracers: uploads field.values as
   *  a Data3DTexture (only when the values reference / dims change) and derives
   *  the world->fractional matrix, iso, abs-mode, lobe colours and opacity from
   *  the same Isosurface the raster pipelines draw. */
  _encodeField() {
    const field = this._activeField();
    if (!field) {
      this.fieldEnabled = false;
      this.fieldTexture = this._dummyFieldTexture;
      return;
    }
    const iso = groups.isosurfaceGroup;
    this.fieldEnabled = true;

    // world -> fractional [0,1]^3: invert the SAME origin + voxel*dims mapping
    // Isosurface builds for its group matrix (columns = lattice vectors).
    const v = field.voxel;
    const o = field.origin ?? [0, 0, 0];
    _m.set(
      v[0][0], v[1][0], v[2][0], o[0] ?? 0,
      v[0][1], v[1][1], v[2][1], o[1] ?? 0,
      v[0][2], v[1][2], v[2][2], o[2] ?? 0,
      0, 0, 0, 1);
    _m.scale(_scale.set(field.nx, field.ny, field.nz));
    this.fieldWorldToFrac.copy(_m).invert();

    this.fieldIso = Number.isFinite(field.isoValue) ? field.isoValue : 0;
    this.fieldAbsMode = !!field.useAbsoluteIsoValue;
    if (iso.meshes?.positive?.material?.color) this.fieldPosColor.copy(iso.meshes.positive.material.color);
    if (iso.meshes?.negative?.material?.color) this.fieldNegColor.copy(iso.meshes.negative.material.color);
    this.fieldAlpha = iso.meshes?.positive?.material?.opacity ?? 0.6;

    const dimsKey = `${field.nx},${field.ny},${field.nz}`;
    if (this._fieldValuesRef !== field.values || this._fieldDimsKey !== dimsKey) {
      this._uploadFieldTexture(field);
      this._fieldValuesRef = field.values;
      this._fieldDimsKey = dimsKey;
    }
  }

  /** (Re)build the Data3DTexture from field.values, downsampling by an integer
   *  stride if the grid exceeds FIELD_TEXEL_CAP voxels. */
  _uploadFieldTexture(field) {
    let { nx, ny, nz } = field;
    const src = field.values;
    let data;
    if (nx * ny * nz > FIELD_TEXEL_CAP) {
      const stride = Math.max(2, Math.ceil(Math.cbrt((nx * ny * nz) / FIELD_TEXEL_CAP)));
      const dnx = Math.ceil(nx / stride), dny = Math.ceil(ny / stride), dnz = Math.ceil(nz / stride);
      console.warn(`raytrace: field ${nx}x${ny}x${nz} exceeds ${FIELD_TEXEL_CAP} voxels — `
        + `downsampling by stride ${stride} to ${dnx}x${dny}x${dnz}`);
      data = new Float32Array(dnx * dny * dnz);
      let p = 0;
      for (let k = 0; k < nz; k += stride)
        for (let j = 0; j < ny; j += stride)
          for (let i = 0; i < nx; i += stride)
            data[p++] = src[i + nx * (j + ny * k)];
      nx = dnx; ny = dny; nz = dnz;
    } else {
      data = (src instanceof Float32Array) ? new Float32Array(src) : new Float32Array(src);
    }
    if (this._realFieldTexture) this._realFieldTexture.dispose();
    this._realFieldTexture = makeVolumeTexture(data, nx, ny, nz);
    this.fieldTexture = this._realFieldTexture;
    this.fieldDims = [nx, ny, nz];
  }

  /** Encode the visible crystallographic planes for the tracers: 6 texels per
   *  plane (see planeChunk.js), the cell world->fractional matrix (from the
   *  lattice basis, for exact cell clipping), and — for Field-mode planes — a
   *  CPU-baked colormap atlas (each plane gets its own tile, so planes may
   *  reference different fields). The bake reuses Plane.bakeFieldAtlasTile, the
   *  same sampling path as the raster updateColorMap. */
  _encodePlanes() {
    const planes = this._visiblePlanes();
    this.planeCount = planes.length;
    if (planes.length === 0) {
      this.planeAtlasTexture = this._dummyAtlas;
      return;
    }

    // world -> fractional cell coords: invert the lattice-vector basis (columns
    // = a, b, c; origin 0), matching makeCellClippingPlanes' cell faces.
    const lattice = fileBrowser.selectedStructure?.lattice;
    if (Array.isArray(lattice) && lattice.length === 3) {
      _m.set(
        lattice[0][0], lattice[1][0], lattice[2][0], 0,
        lattice[0][1], lattice[1][1], lattice[2][1], 0,
        lattice[0][2], lattice[1][2], lattice[2][2], 0,
        0, 0, 0, 1);
      this.cellWorldToFrac.copy(_m).invert();
    } else {
      this.cellWorldToFrac.identity();
    }

    // Field-mode planes that can actually bake (have a field with a voxel grid)
    // get an atlas tile; index them into a square-ish grid.
    const fieldPlanes = planes.filter((p) => p.mode === 'Field' && p.field?.voxel);
    const nField = fieldPlanes.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(nField)));
    const rows = Math.max(1, Math.ceil(nField / cols));
    const atlasW = nField > 0 ? cols * PLANE_ATLAS_TILE : 1;
    const atlasH = nField > 0 ? rows * PLANE_ATLAS_TILE : 1;
    const atlasData = new Uint8Array(atlasW * atlasH * 4);
    const atlasRects = new Map(); // plane -> [uMin, vMin, uSize, vSize]
    fieldPlanes.forEach((plane, j) => {
      const cx = j % cols, cy = (j / cols) | 0;
      const x0 = cx * PLANE_ATLAS_TILE, y0 = cy * PLANE_ATLAS_TILE;
      plane.bakeFieldAtlasTile(atlasData, atlasW, x0, y0, PLANE_ATLAS_TILE);
      // half-texel inset so bilinear filtering never bleeds across tiles
      atlasRects.set(plane, [
        (x0 + 0.5) / atlasW, (y0 + 0.5) / atlasH,
        (PLANE_ATLAS_TILE - 1) / atlasW, (PLANE_ATLAS_TILE - 1) / atlasH,
      ]);
    });
    if (this._realAtlas) this._realAtlas.dispose();
    if (nField > 0) {
      this._realAtlas = makeAtlasTexture(atlasData, atlasW, atlasH);
      this.planeAtlasTexture = this._realAtlas;
    } else {
      this._realAtlas = null;
      this.planeAtlasTexture = this._dummyAtlas;
    }

    const texture = this._ensureCapacity('planesTexture', planes.length * 6);
    const data = texture.image.data;
    planes.forEach((plane, p) => {
      const d = p * 24;
      const n = plane.planeNormal;
      const isField = atlasRects.has(plane);
      // texel 0: normal.xyz, d
      data[d] = n.x; data[d + 1] = n.y; data[d + 2] = n.z; data[d + 3] = plane.planeD;
      // texel 1: flat colour + alpha ('None' look; unused in Field mode)
      const mat = plane.material;
      if (plane.mode === 'None' && mat?.color) _color.copy(mat.color);
      else _color.setHex(0x8c8c99);
      const flatAlpha = (plane.mode === 'None' && Number.isFinite(mat?.opacity)) ? mat.opacity : 0.70;
      data[d + 4] = _color.r; data[d + 5] = _color.g; data[d + 6] = _color.b; data[d + 7] = flatAlpha;
      // texel 2: centroid.xyz, mode (0 None / 1 Field)
      const c = plane.planeCentroid;
      data[d + 8] = c.x; data[d + 9] = c.y; data[d + 10] = c.z; data[d + 11] = isField ? 1 : 0;
      // texel 3/4: uAxis.xyz + halfU, vAxis.xyz + halfV (rect frame for atlas UV)
      const u = plane.uAxis, v = plane.vAxis;
      data[d + 12] = u.x; data[d + 13] = u.y; data[d + 14] = u.z; data[d + 15] = plane.halfU;
      data[d + 16] = v.x; data[d + 17] = v.y; data[d + 18] = v.z; data[d + 19] = plane.halfV;
      // texel 5: atlas rect (uMin, vMin, uSize, vSize)
      const rect = atlasRects.get(plane) ?? [0, 0, 0, 0];
      data[d + 20] = rect[0]; data[d + 21] = rect[1]; data[d + 22] = rect[2]; data[d + 23] = rect[3];
    });
    texture.needsUpdate = true;
  }
}
