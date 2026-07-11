// Encodes the live crystal scene into RGBA32F data textures for the
// ray-tracing pipeline's scene shader (see sceneFragment.js for the texel
// layouts). Reads the same sources the raster pipelines draw — the atoms/bonds
// InstancedMesh buffers, the polyhedra group, the lattice — so every existing
// write path (per-atom edits, trajectory frames, style changes) is picked up
// with no coupling into other modules. Change detection is a cheap
// fingerprint over the instanced-attribute `version` counters plus the
// polyhedra/lattice style values; the pipeline re-encodes and resets the
// progressive accumulation when it changes. The fingerprint is split into two
// strings so callers can tell WHICH kind of edit happened: a CORE part (atom
// geometry/colors, cut planes, bonds, polyhedra, lattice, field, planes, plus
// the raster-only fields of the mixed style maps) and a TRACER-MATERIAL part
// (the per-species/per-atom tracer material maps). fingerprintChanged() returns
// their union (unchanged external contract) and records lastChangeWasCoreScene
// so the interactive raster preview can ignore tracer-only look edits.

import * as THREE from '../../../external/three/three.module.js';
import { ConvexHull } from '../../../external/three/ConvexHull.js';
import { groups, fileBrowser, general, app, measurements } from '../../../state/store.js';
import { bondKey } from '../../BondsFracUpdateModule.js';
import { getAtomImageStyle } from '../../AtomsFracUpdateModule.js';
import { MAX_CUT_PLANES } from '../../MaterialStyles.js';
import { getCutPlaneMaskSign, Plane } from '../../../model/index.js';
import { DATA_TEX_WIDTH } from './sceneFragment.js';

// Texture/perf sanity cap on unique face planes per polyhedron. No longer the
// vendored intersector limit: the shaders now stream planes straight from the
// data texture (raytrace/convexChunk.js -> ConvexPolyStreamIntersect), so any
// plane count is supported. This bound only guards against a pathological hull
// blowing up the texture; real coordination shells (faces = 2*verts - 4) never
// approach it (256 would need >130 ligands).
const MAX_PLANES = 256;

// Ray/path-tracing material encoding: one texel with TYPE-MULTIPLEXED slots
// (the per-type knobs are mutually exclusive, so no layout growth needed):
//   standard:    (0, 0,          gloss,        reflectivity | -1)
//   metal:       (1, roughness,  0,            reflectivity | -1)
//   glass:       (2, frost,      ior,          tintDepth)
//   emissive:    (3, 0,          intensity,    listed)   // w = NEE "listed" bit
//   translucent: (4, 0,          scatterDepth, 0)
// reflectivity -1 = "use the global Reflectivity slider" (standard) / ideal
// mirror (metal). For emissive the reflectivity slot is unused, so B1/B2
// repurpose it as the "listed" bit (1 = in the emissive NEE list; the PT shader
// gates diffuse-arrival emission on it). Codes/slots must match
// resolveMaterialType/resolveHitType in BOTH scene shaders.
const MATERIAL_CODES = { standard: 0, metal: 1, glass: 2, emissive: 3, translucent: 4 };
const DEFAULT_MATERIAL_TEXEL = [0, 0, 0.6, -1]; // standard, gloss 0.6 = classic look

// Emissive next-event-estimation list cap (B1/B2): the path tracer directly
// samples up to this many emissive primitives per frame (2 texels each in
// emissiveTexture). Emitters beyond the cap keep the old implicit diffuse-
// arrival lighting (their material texel's "listed" bit stays 0) so they never
// go dark — see the LIGHT-branch gate in ptSceneFragment.js.
const EMISSIVE_CAP = 64;

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

// World-space geometry of a unit cylinder (object y in [-1,1], radius 1) under
// its forward matrix m. Columns of the 3x3 are orthogonal for every cylinder
// here (all built via Matrix4.compose = R*diag(scale)): center = translation,
// axis half-vector = col1 (|col1| = the half-length along the axis), radial
// extent rad = max(|col0|,|col2|). The tight bounding-sphere radius is then
// sqrt(|col1|^2 + rad^2). Returns [cx,cy,cz, hx,hy,hz, rad, sphereR]: the sphere
// feeds the shader pre-reject + steps 3/6; the segment (center +/- axisHalf) +
// rad feed the grid's capsule-vs-cell insertion. A tiny pad keeps the sphere
// strictly enclosing under float rounding (never clips a real grazing hit).
function cylinderGeom(m) {
  const e = m.elements;
  const hx = e[4], hy = e[5], hz = e[6]; // col1 = axis half-vector
  const col1 = Math.hypot(hx, hy, hz);
  const rad = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[8], e[9], e[10]));
  const sphereR = Math.sqrt(col1 * col1 + rad * rad) + 1e-4;
  return [e[12], e[13], e[14], hx, hy, hz, rad, sphereR];
}

// Squared distance between a line segment p0->p1 and an axis-aligned box
// [bmin,bmax]. dist^2(P(u), box) is convex in u (distance to a convex set of an
// affine path), so a ternary search converges to the global minimum; ~40 steps
// shrink [0,1] below 1e-6. Used by the grid's cylinder insertion filter — the
// caller pads the radius so numerical slack can only OVER-insert (never skip a
// cell the capsule truly overlaps).
function segBoxDist2(p0, p1, bmin, bmax) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const distAt = (u) => {
    const x = p0[0] + dx * u, y = p0[1] + dy * u, z = p0[2] + dz * u;
    const ex = Math.max(bmin[0] - x, 0, x - bmax[0]);
    const ey = Math.max(bmin[1] - y, 0, y - bmax[1]);
    const ez = Math.max(bmin[2] - z, 0, z - bmax[2]);
    return ex * ex + ey * ey + ez * ez;
  };
  let lo = 0, hi = 1;
  for (let it = 0; it < 40; it++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (distAt(m1) < distAt(m2)) hi = m2; else lo = m1;
  }
  return distAt((lo + hi) * 0.5);
}

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

/** Enabled atom cut planes as {nx,ny,nz,w,sign}, replicating the raster
 *  semantics (AtomsFracUpdateModule.applyCutPlaneUniformsToShader): normalized
 *  normal, w = r, sign = getCutPlaneMaskSign(side), degenerate normals fall back
 *  to (1,0,0), capped at MAX_CUT_PLANES. Extracted as a free function so the
 *  encoder's atom scan and GroundPlaneModule's duplicated bounds loop filter
 *  atoms identically (the subtle shared logic; the AABB loop itself is kept
 *  duplicated with lockstep comments). */
export function activeAtomCutPlanes() {
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

export class SceneEncoder {
  atomsTexture = makeDataTexture(1);
  cylindersTexture = makeDataTexture(1);
  polyTexture = makeDataTexture(1);
  atomCount = 0;
  cylinderCount = 0;
  polyCount = 0;
  _cylBounds = new Float32Array(4); // per-cylinder world bounding spheres (cx,cy,cz,r)
  _cylSegs = new Float32Array(8);   // per-cylinder (cx,cy,cz, hx,hy,hz, rad, sphereR)
  hasEmissive = false; // any emissive (code 3) material texel written this encode
  //   (the PT any-hit shadow early-out is disabled when true: emissive objects
  //   are LIGHTs a light-sample ray must still be able to reach and add)
  // ---- emissive next-event-estimation list (B1) ---------------------------
  // Up to EMISSIVE_CAP emissive primitives the path tracer samples directly
  // (NEE). emissiveTexture: 2 texels/emitter — (cx,cy,cz,r) bounding sphere,
  // (objectID, power, 0, 0). objectID matches the shader's per-primitive id
  // (atoms 1+i, cylinders 1+atomCount+i, polys 1+atomCount+cylCount+p), so the
  // NEE shadow ray's closest hit can be identity-checked against the pick.
  emissiveTexture = makeDataTexture(1);
  emissiveCount = 0;
  _emissiveList = []; // {kind:0 atom|1 cyl|2 poly, encIndex, cx,cy,cz,r, power}
  _emissiveWarned = false; // one-time overflow warning
  // ---- uniform grid (3D-DDA accelerator over atoms + cylinders) -----------
  // Built by _buildGrid() only when atomCount + cylinderCount >= gridMinPrims;
  // the shaders swap the brute loops for a grid walk when gridEnabled. Cells
  // texture: 1 texel/cell (offset, count, 0, 0); index texture: 4 entries/texel
  // (primIndex*2 + typeBit). See gridChunk.js.
  gridEnabled = false;
  gridMin = new THREE.Vector3();
  gridInvCellSize = new THREE.Vector3(1, 1, 1);
  gridDims = [1, 1, 1];
  gridMinPrims = 256; // GRID_MIN_PRIMS (instance field so tests can force 0/Infinity)
  gridCellsTexture = makeDataTexture(1);
  gridIndexTexture = makeDataTexture(1);
  _gridWarned = false; // one-time entry-cap warning
  boundingRadius = 10; // max atom distance from the origin (light placement)
  minY = -5; // lowest atom point (ground plane placement; driver adds the offset)
  structureCenter = new THREE.Vector3(); // atom bounding-box center
  structureRadius = 5; // half-diagonal of the atom bounding box (from the center)
  // whole-scene world AABB (atoms + cylinder spheres + poly AABBs + cell-clipped
  // planes + field box), padded; the shaders early-out the interior primitive
  // loops when a ray misses it. sceneBoundsValid=false => nothing to trace.
  sceneBoundsMin = new THREE.Vector3();
  sceneBoundsMax = new THREE.Vector3();
  sceneBoundsValid = false;
  _atomMin = [Infinity, Infinity, Infinity]; // atom-only AABB (for scene bounds)
  _atomMax = [-Infinity, -Infinity, -Infinity];
  _polyMin = [Infinity, Infinity, Infinity]; // poly-only AABB (for scene bounds)
  _polyMax = [-Infinity, -Infinity, -Infinity];
  _fieldForward = null; // forward field matrix (frac [0,1]^3 -> world), or null
  _coreFingerprint = '';   // atoms/cut/bonds/poly/lattice/field/planes + raster style fields
  _matFingerprint = '';    // per-species/per-atom tracer material maps
  lastChangeWasCoreScene = false; // set by fingerprintChanged(): was the last diff a CORE edit?

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
    this.gridCellsTexture.dispose();
    this.gridIndexTexture.dispose();
    this.emissiveTexture.dispose();
  }

  /** Cheap change detector; true when the scene must be re-encoded. Splits the
   *  probe into a CORE string (geometry/colors/planes/field + raster style
   *  fields) and a TRACER-MATERIAL string (the tracer material maps). Returns
   *  their union and records lastChangeWasCoreScene = whether the CORE part
   *  changed (the raster preview keys triggers on that so tracer-only look
   *  edits stay live-traced). */
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
    // CORE side of the mixed style maps: their RASTER fields (colors, radii,
    // visibility ...) but NOT the tracer `material` sub-object — a replacer
    // drops the 'material' key so a tracer-only material edit does not land in
    // the core string (it belongs in the tracer-material part below). The two
    // pure tracer maps (atomMaterials/atomUserMaterials) are values that ARE
    // material objects, so they are excluded from core entirely.
    const structure = fileBrowser.selectedStructure;
    const dropMaterialKey = (key, value) => (key === 'material' ? undefined : value);
    if (structure) {
      parts.push('ms',
        JSON.stringify(structure.atomImageStyles ?? {}, dropMaterialKey),
        JSON.stringify(structure.bondCategoryStyles ?? {}, dropMaterialKey),
        JSON.stringify(structure.bondUserStyles ?? {}, dropMaterialKey),
        JSON.stringify(structure.polyhedraCategoryStyles ?? {}, dropMaterialKey),
        JSON.stringify(structure.polyhedraUserStyles ?? {}, dropMaterialKey));
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

    // measurements (shells + dashes): traced as ghost spheres / thin cylinders.
    // Cheap signal — count, and per traced group its id, child count, visibility
    // and first-child world position (rounded to 1e-3). add/clear changes the
    // count/ids; updateAllMeasurements rebuilds children + moves positions.
    const mLines = measurements?.measureLines;
    if (Array.isArray(mLines)) {
      parts.push('me', mLines.length);
      const r3 = (x) => Math.round(x * 1000);
      for (const g of mLines) {
        const t = g?.userData?.type;
        if (t !== 'distance' && t !== 'angle' && t !== 'distanceMarker' && t !== 'angleMarker') continue;
        const child = g.children?.[0];
        if (child) child.updateWorldMatrix(true, false);
        if (child) child.getWorldPosition(_pos); else _pos.set(0, 0, 0);
        parts.push(g.id, t, g.visible === false ? 0 : 1, g.children?.length ?? 0,
          r3(_pos.x), r3(_pos.y), r3(_pos.z));
      }
    }

    // TRACER-MATERIAL side: today's 'm' block verbatim (all seven maps, full
    // serialization) — a raster-field edit that flips BOTH parts is harmless
    // since the preview trigger keys only on the core part.
    const matParts = [];
    if (structure) {
      matParts.push('m', JSON.stringify(structure.atomMaterials ?? {}),
        JSON.stringify(structure.atomUserMaterials ?? {}),
        JSON.stringify(structure.atomImageStyles ?? {}),
        JSON.stringify(structure.bondCategoryStyles ?? {}),
        JSON.stringify(structure.bondUserStyles ?? {}),
        JSON.stringify(structure.polyhedraCategoryStyles ?? {}),
        JSON.stringify(structure.polyhedraUserStyles ?? {}));
    }

    const coreFp = parts.join('|');
    const matFp = matParts.join('|');
    const coreChanged = coreFp !== this._coreFingerprint;
    const matChanged = matFp !== this._matFingerprint;
    this._coreFingerprint = coreFp;
    this._matFingerprint = matFp;
    this.lastChangeWasCoreScene = coreChanged;
    return coreChanged || matChanged;
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
    this.hasEmissive = false; // sub-encoders set it when an emissive texel is written
    this._emissiveList = [];  // sub-encoders push emissive prims (encode order)
    this._encodeAtoms();
    this._encodeCylinders();
    this._encodePolyhedra();
    this._encodeField();
    this._encodePlanes();
    this._buildEmissiveList(); // resolves objectIDs (needs the final counts)
    this._computeSceneBounds();
    this._buildGrid();
  }

  /** Build emissiveTexture from the emissive primitives pushed by the atom /
   *  cylinder / polyhedron encoders (in that encode order). Each emitter's
   *  objectID is resolved now that atomCount / cylinderCount are final, and
   *  must match the shader's per-primitive hitObjectID. Only the first
   *  EMISSIVE_CAP are written (the "listed" ones); the rest keep the implicit
   *  diffuse-arrival lighting via their material texel's listed bit = 0. */
  _buildEmissiveList() {
    const list = this._emissiveList;
    if (list.length > EMISSIVE_CAP && !this._emissiveWarned) {
      console.warn(`raytrace: ${list.length} emissive primitives exceed the `
        + `${EMISSIVE_CAP}-emitter NEE cap — the overflow keeps implicit `
        + '(slower-converging) lighting');
      this._emissiveWarned = true;
    }
    this.emissiveCount = Math.min(list.length, EMISSIVE_CAP);
    const texture = this._ensureCapacity('emissiveTexture', Math.max(1, this.emissiveCount * 2));
    const data = texture.image.data;
    for (let e = 0; e < this.emissiveCount; e++) {
      const rec = list[e];
      const objectID = rec.kind === 0 ? 1 + rec.encIndex
        : rec.kind === 1 ? 1 + this.atomCount + rec.encIndex
          : 1 + this.atomCount + this.cylinderCount + rec.encIndex;
      const o = e * 8;
      data[o] = rec.cx; data[o + 1] = rec.cy; data[o + 2] = rec.cz; data[o + 3] = rec.r;
      data[o + 4] = objectID; data[o + 5] = rec.power; data[o + 6] = 0; data[o + 7] = 0;
    }
    texture.needsUpdate = true;
  }

  /** Build the uniform grid over atoms + cylinders (a counting-sort insertion
   *  into a cells texture + an entry-index texture; see gridChunk.js). Skipped
   *  (gridEnabled=false) below gridMinPrims, where the brute loops are already
   *  cheap. Grid bounds are the union of atom AABBs + cylinder bounding spheres
   *  (tighter than the whole-scene box); cell count targets ~2.5 prims/cell,
   *  clamped to <= 64 per axis. Atoms insert into their center +/- radius cell
   *  range; cylinders insert only into cells within `rad` of their segment
   *  (exact point-segment-vs-cell-box distance), keeping long diagonal edges at
   *  O(dims) cells instead of O(dims^3). Multi-cell entries are correct (the
   *  first cell along a ray that holds a primitive finds its true hit). */
  _buildGrid() {
    const N = this.atomCount + this.cylinderCount;
    if (N < this.gridMinPrims) { this.gridEnabled = false; return; }

    // 1. grid bounds = union of atom AABBs + cylinder bounding spheres
    const atomData = this.atomsTexture.image.data;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.atomCount; i++) {
      const o = i * 12;
      const x = atomData[o], y = atomData[o + 1], z = atomData[o + 2], r = atomData[o + 3];
      if (x - r < minX) minX = x - r; if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r; if (y + r > maxY) maxY = y + r;
      if (z - r < minZ) minZ = z - r; if (z + r > maxZ) maxZ = z + r;
    }
    for (let i = 0; i < this.cylinderCount; i++) {
      const b = i * 4;
      const cx = this._cylBounds[b], cy = this._cylBounds[b + 1], cz = this._cylBounds[b + 2];
      const r = this._cylBounds[b + 3];
      if (cx - r < minX) minX = cx - r; if (cx + r > maxX) maxX = cx + r;
      if (cy - r < minY) minY = cy - r; if (cy + r > maxY) maxY = cy + r;
      if (cz - r < minZ) minZ = cz - r; if (cz + r > maxZ) maxZ = cz + r;
    }
    if (!Number.isFinite(minX)) { this.gridEnabled = false; return; }
    const pad = 1e-3;
    minX -= pad; minY -= pad; minZ -= pad; maxX += pad; maxY += pad; maxZ += pad;

    // 2. cell counts: ~2.5 prims/cell, near-cubic, <= 64 per axis
    const ex = Math.max(maxX - minX, 1e-6);
    const ey = Math.max(maxY - minY, 1e-6);
    const ez = Math.max(maxZ - minZ, 1e-6);
    const lambda = Math.cbrt(N / (2.5 * ex * ey * ez));
    const clampDim = (e) => Math.max(1, Math.min(64, Math.round(e * lambda)));
    const dx = clampDim(ex), dy = clampDim(ey), dz = clampDim(ez);
    const numCells = dx * dy * dz;
    const invX = dx / ex, invY = dy / ey, invZ = dz / ez;
    const cellSx = ex / dx, cellSy = ey / dy, cellSz = ez / dz;
    const cellIndex = (i, j, k) => (k * dy + j) * dx + i;
    const clampI = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

    // 3a. counting-sort pass 1: per-cell entry counts
    const counts = new Int32Array(numCells);
    // reusable box scratch for the cylinder distance filter
    const bmin = [0, 0, 0], bmax = [0, 0, 0];
    const p0 = [0, 0, 0], p1 = [0, 0, 0];
    let totalEntries = 0;
    const forEachCell = (visit) => {
      // atoms: whole center +/- radius cell range
      for (let a = 0; a < this.atomCount; a++) {
        const o = a * 12;
        const x = atomData[o], y = atomData[o + 1], z = atomData[o + 2], r = atomData[o + 3];
        const i0 = clampI(Math.floor((x - r - minX) * invX), dx - 1);
        const i1 = clampI(Math.floor((x + r - minX) * invX), dx - 1);
        const j0 = clampI(Math.floor((y - r - minY) * invY), dy - 1);
        const j1 = clampI(Math.floor((y + r - minY) * invY), dy - 1);
        const k0 = clampI(Math.floor((z - r - minZ) * invZ), dz - 1);
        const k1 = clampI(Math.floor((z + r - minZ) * invZ), dz - 1);
        const entry = a * 2; // typeBit 0 = atom
        for (let k = k0; k <= k1; k++)
          for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) visit(cellIndex(i, j, k), entry);
      }
      // cylinders: capsule-AABB cell range, kept only where the cell box is
      // within rad of the segment (exact point-segment-vs-box distance)
      for (let c = 0; c < this.cylinderCount; c++) {
        const s = c * 8;
        const cxx = this._cylSegs[s], cyy = this._cylSegs[s + 1], czz = this._cylSegs[s + 2];
        const hx = this._cylSegs[s + 3], hy = this._cylSegs[s + 4], hz = this._cylSegs[s + 5];
        const rad = this._cylSegs[s + 6];
        p0[0] = cxx - hx; p0[1] = cyy - hy; p0[2] = czz - hz;
        p1[0] = cxx + hx; p1[1] = cyy + hy; p1[2] = czz + hz;
        const loX = Math.min(p0[0], p1[0]) - rad, hiX = Math.max(p0[0], p1[0]) + rad;
        const loY = Math.min(p0[1], p1[1]) - rad, hiY = Math.max(p0[1], p1[1]) + rad;
        const loZ = Math.min(p0[2], p1[2]) - rad, hiZ = Math.max(p0[2], p1[2]) + rad;
        const i0 = clampI(Math.floor((loX - minX) * invX), dx - 1);
        const i1 = clampI(Math.floor((hiX - minX) * invX), dx - 1);
        const j0 = clampI(Math.floor((loY - minY) * invY), dy - 1);
        const j1 = clampI(Math.floor((hiY - minY) * invY), dy - 1);
        const k0 = clampI(Math.floor((loZ - minZ) * invZ), dz - 1);
        const k1 = clampI(Math.floor((hiZ - minZ) * invZ), dz - 1);
        const rad2 = (rad + 1e-4) * (rad + 1e-4); // tiny pad: never under-insert
        const entry = c * 2 + 1; // typeBit 1 = cylinder
        for (let k = k0; k <= k1; k++) {
          bmin[2] = minZ + k * cellSz; bmax[2] = bmin[2] + cellSz;
          for (let j = j0; j <= j1; j++) {
            bmin[1] = minY + j * cellSy; bmax[1] = bmin[1] + cellSy;
            for (let i = i0; i <= i1; i++) {
              bmin[0] = minX + i * cellSx; bmax[0] = bmin[0] + cellSx;
              if (segBoxDist2(p0, p1, bmin, bmax) <= rad2) visit(cellIndex(i, j, k), entry);
            }
          }
        }
      }
    };
    forEachCell((cell) => { counts[cell]++; totalEntries++; });

    if (totalEntries > 4194304) { // 2^22 entry cap
      if (!this._gridWarned) {
        console.warn(`raytrace: uniform grid entry count ${totalEntries} exceeds `
          + '2^22 — falling back to brute force for this scene');
        this._gridWarned = true;
      }
      this.gridEnabled = false;
      return;
    }

    // 3b. prefix-sum offsets, then pass 2 scatter into the index texture
    const offsets = new Int32Array(numCells);
    let acc = 0;
    for (let c = 0; c < numCells; c++) { offsets[c] = acc; acc += counts[c]; }
    const cursor = offsets.slice();

    const cellsTex = this._ensureCapacity('gridCellsTexture', Math.max(1, numCells));
    const cellsData = cellsTex.image.data;
    for (let c = 0; c < numCells; c++) {
      const o = c * 4;
      cellsData[o] = offsets[c]; cellsData[o + 1] = counts[c];
      cellsData[o + 2] = 0; cellsData[o + 3] = 0;
    }
    cellsTex.needsUpdate = true;

    // 4 entries/texel -> ceil(totalEntries/4) texels
    const indexTex = this._ensureCapacity('gridIndexTexture', Math.max(1, Math.ceil(totalEntries / 4)));
    const indexData = indexTex.image.data;
    forEachCell((cell, entry) => { indexData[cursor[cell]++] = entry; });
    indexTex.needsUpdate = true;

    this.gridMin.set(minX, minY, minZ);
    this.gridInvCellSize.set(invX, invY, invZ);
    this.gridDims = [dx, dy, dz];
    this.gridEnabled = true;
  }

  /** Fold the whole-scene world AABB from every traced primitive group, so the
   *  shaders can skip the interior loops when a ray misses the structure. Uses
   *  the atom AABB, each cylinder bounding sphere, each poly AABB, the 8
   *  unit-cell corners (planes are cell-clipped) and the field parallelepiped's
   *  8 corners. Padded by a small epsilon; sceneBoundsValid=false when empty. */
  _computeSceneBounds() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const fold = (x, y, z) => {
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    };
    if (this.atomCount > 0 && Number.isFinite(this._atomMin[0])) {
      fold(this._atomMin[0], this._atomMin[1], this._atomMin[2]);
      fold(this._atomMax[0], this._atomMax[1], this._atomMax[2]);
    }
    for (let i = 0; i < this.cylinderCount; i++) {
      const b = i * 4;
      const cx = this._cylBounds[b], cy = this._cylBounds[b + 1], cz = this._cylBounds[b + 2];
      const r = this._cylBounds[b + 3];
      fold(cx - r, cy - r, cz - r); fold(cx + r, cy + r, cz + r);
    }
    if (this.polyCount > 0 && Number.isFinite(this._polyMin[0])) {
      fold(this._polyMin[0], this._polyMin[1], this._polyMin[2]);
      fold(this._polyMax[0], this._polyMax[1], this._polyMax[2]);
    }
    if (this.planeCount > 0) {
      const lattice = fileBrowser.selectedStructure?.lattice;
      if (Array.isArray(lattice) && lattice.length === 3) {
        const [a, b, c] = lattice;
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
          fold(i * a[0] + j * b[0] + k * c[0],
            i * a[1] + j * b[1] + k * c[1],
            i * a[2] + j * b[2] + k * c[2]);
        }
      }
    }
    if (this.fieldEnabled && this._fieldForward) {
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
        _pos.set(i, j, k).applyMatrix4(this._fieldForward);
        fold(_pos.x, _pos.y, _pos.z);
      }
    }
    if (minX === Infinity) {
      this.sceneBoundsValid = false;
      return;
    }
    const pad = 1e-3;
    this.sceneBoundsMin.set(minX - pad, minY - pad, minZ - pad);
    this.sceneBoundsMax.set(maxX + pad, maxY + pad, maxZ + pad);
    this.sceneBoundsValid = true;
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

  /** Enabled atom cut planes as {nx,ny,nz,w,sign} (see the exported free
   *  function activeAtomCutPlanes — shared with GroundPlaneModule so the two
   *  atom-scans filter identically). The hot encode path keeps this method. */
  _activeCutPlanes() {
    return activeAtomCutPlanes();
  }

  _encodeAtoms() {
    const mesh = groups.atomsMesh;
    // Measurement shell markers ('distanceMarker'/'angleMarker') are traced as
    // extra ghost spheres appended after the real atoms (so they share the atom
    // hit loop + uniform grid); gathered up front to size the texture.
    const measSpheres = this._measurementSpheres();
    const meshVisible = !!(mesh && mesh.visible);
    if (!meshVisible && measSpheres.length === 0) {
      this.atomCount = 0;
      return;
    }
    const structure = fileBrowser.selectedStructure;
    // whole-atom cut-plane removal by world CENTER, matching the raster shader
    // discard (AtomsFracUpdateModule); per-atom "Keep" immunity is honored.
    const cutPlanes = this._activeCutPlanes();
    const texture = this._ensureCapacity('atomsTexture',
      Math.max(1, ((meshVisible ? mesh.count : 0) + measSpheres.length) * 3));
    const data = texture.image.data;
    let n = 0;
    let maxR2 = 25;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    if (meshVisible) {
      const srcIndex = structure?.periodic?.wrapped?.srcIndex;
      const atomMaterials = structure?.atomMaterials ?? {};
      const atomUserMaterials = structure?.atomUserMaterials ?? {};
      const matrices = mesh.instanceMatrix.array;
      const colors = mesh.instanceColor.array;
      const opacities = mesh.geometry.attributes.instanceOpacity?.array;
      const baseOpacity = mesh.material.opacity ?? 1;
      const immune = mesh.geometry.attributes.instanceCutPlaneImmune?.array;
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
        const mt = materialTexel(
          getAtomImageStyle(structure, i)?.material
            ?? atomUserMaterials[src]
            ?? (element ? atomMaterials[element] : null));
        if (mt[0] === 3) {
          this.hasEmissive = true;
          // listed bit into the free reflectivity slot (unused for emissive);
          // the emitter's bounding sphere is its own atom sphere.
          const listed = this._emissiveList.length < EMISSIVE_CAP;
          mt[3] = listed ? 1 : 0;
          this._emissiveList.push({ kind: 0, encIndex: n,
            cx: data[d], cy: data[d + 1], cz: data[d + 2], r: radius, power: mt[2] });
        }
        data.set(mt, d + 8);
        n++;
      }
    }
    this.boundingRadius = Math.sqrt(maxR2) + 3;
    this.minY = Number.isFinite(minY) ? minY : -5;
    if (Number.isFinite(minX)) {
      this.structureCenter.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      this.structureRadius = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) / 2;
    } else {
      this.structureCenter.set(0, 0, 0);
      this.structureRadius = 5;
    }
    // atom-only AABB for the whole-scene bound (kept separate from
    // structureCenter/minY, which stay atoms-only for ground/light placement)
    this._atomMin = [minX, minY, minZ];
    this._atomMax = [maxX, maxY, maxZ];
    // Append the measurement shells as ghost spheres (alpha 0.32 → the tracers'
    // stochastic see-through gives the ghost look). They extend the whole-scene
    // AABB (so the grid / bounds early-out include them) but NOT the atoms-only
    // center/minY/boundingRadius used for ground & light placement.
    for (const s of measSpheres) {
      const d = n * 12;
      data[d] = s.cx; data[d + 1] = s.cy; data[d + 2] = s.cz; data[d + 3] = s.r;
      data[d + 4] = s.cr; data[d + 5] = s.cg; data[d + 6] = s.cb; data[d + 7] = 0.32;
      data.set(DEFAULT_MATERIAL_TEXEL, d + 8);
      if (s.cx - s.r < this._atomMin[0]) this._atomMin[0] = s.cx - s.r;
      if (s.cy - s.r < this._atomMin[1]) this._atomMin[1] = s.cy - s.r;
      if (s.cz - s.r < this._atomMin[2]) this._atomMin[2] = s.cz - s.r;
      if (s.cx + s.r > this._atomMax[0]) this._atomMax[0] = s.cx + s.r;
      if (s.cy + s.r > this._atomMax[1]) this._atomMax[1] = s.cy + s.r;
      if (s.cz + s.r > this._atomMax[2]) this._atomMax[2] = s.cz + s.r;
      n++;
    }
    this.atomCount = n;
    texture.needsUpdate = true;
  }

  /** Visible measurement shell markers ('distanceMarker'/'angleMarker' groups)
   *  as ghost spheres {cx,cy,cz,r, cr,cg,cb}. World center + radius come from
   *  the child shell mesh's world matrix (radius = SphereGeometry parameter x
   *  world scale); colour from its MeshBasicMaterial. */
  _measurementSpheres() {
    const lines = measurements?.measureLines;
    if (!Array.isArray(lines) || lines.length === 0) return [];
    const result = [];
    for (const group of lines) {
      const type = group?.userData?.type;
      if (type !== 'distanceMarker' && type !== 'angleMarker') continue;
      if (group.visible === false) continue;
      const shell = group.children?.[0];
      if (!shell || shell.visible === false || !shell.geometry?.parameters) continue;
      shell.updateWorldMatrix(true, false);
      shell.matrixWorld.decompose(_pos, _quat, _scale);
      const worldScale = Math.max(Math.abs(_scale.x), Math.abs(_scale.y), Math.abs(_scale.z));
      const r = (shell.geometry.parameters.radius ?? 1) * worldScale;
      if (!(r > 0)) continue;
      _color.copy(shell.material.color);
      result.push({ cx: _pos.x, cy: _pos.y, cz: _pos.z, r, cr: _color.r, cg: _color.g, cb: _color.b });
    }
    return result;
  }

  /** Visible measurement dash segments ('distance'/'angle' groups) as thin
   *  cylinder edge entries {invM, geom, r,g,b,a}, one per dash child. Each dash
   *  is a CylinderGeometry mesh (local +y axis) placed by position+lookAt; its
   *  world endpoints (center +/- worldDir x worldLen/2) feed the same
   *  endpoint->cylinder path the lattice/poly edges use. */
  _measurementCylinders() {
    const lines = measurements?.measureLines;
    if (!Array.isArray(lines) || lines.length === 0) return [];
    const result = [];
    for (const group of lines) {
      const type = group?.userData?.type;
      if (type !== 'distance' && type !== 'angle') continue;
      if (group.visible === false) continue;
      for (const dash of group.children ?? []) {
        if (dash.visible === false || !dash.geometry?.parameters) continue;
        dash.updateWorldMatrix(true, false);
        dash.matrixWorld.decompose(_pos, _quat, _scale);
        const height = dash.geometry.parameters.height ?? 1;
        const radiusTop = dash.geometry.parameters.radiusTop ?? 0.08;
        const worldLen = height * Math.abs(_scale.y);
        const worldRad = radiusTop * Math.max(Math.abs(_scale.x), Math.abs(_scale.z));
        if (!(worldLen > 1e-6) || !(worldRad > 0)) continue;
        // cylinder local axis is +y; rotate into world
        _pos2.set(0, 1, 0).applyQuaternion(_quat).normalize();
        const half = worldLen / 2;
        _color.copy(dash.material.color);
        // compose the unit-cylinder (y in [-1,1]) forward matrix from the
        // world center, axis rotation and (radius, half-length, radius) scale
        _scale.set(worldRad, half, worldRad);
        _quat.setFromUnitVectors(_yAxis, _pos2);
        _m.compose(_pos, _quat, _scale);
        result.push({ invM: _m.clone().invert(), geom: cylinderGeom(_m),
          r: _color.r, g: _color.g, b: _color.b, a: dash.material.opacity ?? 1 });
      }
    }
    return result;
  }

  _encodeCylinders() {
    // bonds + unit-cell edges + polyhedra edges share the cylinder encoding
    // (8 texels each: bounding sphere, 4 inverse-matrix columns, colour,
    // material, reserved — see sceneFragment.js layout comment)
    const bonds = (groups.bondsMesh && groups.bondsMesh.visible) ? groups.bondsMesh : null;
    const edges = this._latticeEdges();
    const polyEdges = this._polyEdges();
    const planeBorders = this._planeBorders();
    const measCyls = this._measurementCylinders();
    const total = (bonds ? bonds.count : 0) + edges.length + polyEdges.length
      + planeBorders.length + measCyls.length;
    const texture = this._ensureCapacity('cylindersTexture', Math.max(1, total * 8));
    const data = texture.image.data;
    // per-cylinder world bounding spheres (cx,cy,cz,r), reused by the whole-
    // scene bound (step 3) and the uniform grid (step 6); sized to `total` but
    // only [0, cylinderCount) is filled (culled bonds are skipped).
    this._cylBounds = new Float32Array(Math.max(4, total * 4));
    // per-cylinder segment geometry for the grid's capsule-vs-cell insertion:
    // (cx,cy,cz, hx,hy,hz, rad, sphereR) — center, axis half-vector, radius.
    this._cylSegs = new Float32Array(Math.max(8, total * 8));
    let n = 0;

    const writeCylinder = (invM, geom, r, g, b, a, matTexel) => {
      const d = n * 32;
      data[d] = geom[0]; data[d + 1] = geom[1];      // texel 0: bounding sphere
      data[d + 2] = geom[2]; data[d + 3] = geom[7];  // (center.xyz, radius)
      data.set(invM.elements.slice(0, 4), d + 4);    // texels 1-4: column-major
      data.set(invM.elements.slice(4, 8), d + 8);    // elements become vec4 columns
      data.set(invM.elements.slice(8, 12), d + 12);  // re-assembled by GLSL's mat4()
      data.set(invM.elements.slice(12, 16), d + 16);
      data[d + 20] = r; data[d + 21] = g; data[d + 22] = b; data[d + 23] = a; // texel 5
      if (matTexel[0] === 3) {
        this.hasEmissive = true;
        // listed bit into the free reflectivity slot; bounding sphere = the
        // cylinder's own world bounding sphere (geom[0..2] center, geom[7] r).
        const listed = this._emissiveList.length < EMISSIVE_CAP;
        matTexel[3] = listed ? 1 : 0;
        this._emissiveList.push({ kind: 1, encIndex: n,
          cx: geom[0], cy: geom[1], cz: geom[2], r: geom[7], power: matTexel[2] });
      }
      data.set(matTexel, d + 24);                    // texel 6: material
      data[d + 28] = 0; data[d + 29] = 0; data[d + 30] = 0; data[d + 31] = 0; // texel 7: reserved
      const cb = n * 4;
      this._cylBounds[cb] = geom[0]; this._cylBounds[cb + 1] = geom[1];
      this._cylBounds[cb + 2] = geom[2]; this._cylBounds[cb + 3] = geom[7];
      this._cylSegs.set(geom, n * 8);
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
        writeCylinder(_mInv, cylinderGeom(_m), colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2],
          (opacities ? opacities[i] : 1) * baseOpacity, materialTexel(material));
      }
    }
    for (const edge of edges) {
      writeCylinder(edge.invM, edge.geom, edge.r, edge.g, edge.b, 1, DEFAULT_MATERIAL_TEXEL);
    }
    for (const edge of polyEdges) {
      writeCylinder(edge.invM, edge.geom, edge.r, edge.g, edge.b, edge.a, DEFAULT_MATERIAL_TEXEL);
    }
    for (const edge of planeBorders) {
      writeCylinder(edge.invM, edge.geom, edge.r, edge.g, edge.b, edge.a, DEFAULT_MATERIAL_TEXEL);
    }
    for (const edge of measCyls) {
      writeCylinder(edge.invM, edge.geom, edge.r, edge.g, edge.b, edge.a, DEFAULT_MATERIAL_TEXEL);
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
        result.push({ invM: _m.clone().invert(), geom: cylinderGeom(_m), r: _color.r, g: _color.g, b: _color.b, a: 1 });
      }
    }
    return result;
  }

  /** Polyhedra edge segments as thin cylinders. The raster edges are fat
   *  lines in PIXEL units; here the width maps to world units pinned to the
   *  unit-cell line thickness (polyEdgeWidth 1 ~ a 0.015-radius cell edge).
   *  Note: with the streaming intersector, poly FACES are no longer capped at
   *  20 planes, so an edge cage no longer outruns its (now-rendered) filled
   *  body for high-face-count polyhedra. */
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
        result.push({ invM: _m.clone().invert(), geom: cylinderGeom(_m), r: _color.r, g: _color.g, b: _color.b, a: alpha });
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
        edges.push({ invM: _m.clone().invert(), geom: cylinderGeom(_m), r: _color.r, g: _color.g, b: _color.b });
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
    // poly-only AABB union for the whole-scene bound (step 3)
    this._polyMin = [Infinity, Infinity, Infinity];
    this._polyMax = [-Infinity, -Infinity, -Infinity];
    meshes.forEach((mesh, p) => {
      const planes = mesh.userData.rtPlanes;
      const aabb = mesh.userData.rtAabb;
      if (aabb.min.x < this._polyMin[0]) this._polyMin[0] = aabb.min.x;
      if (aabb.min.y < this._polyMin[1]) this._polyMin[1] = aabb.min.y;
      if (aabb.min.z < this._polyMin[2]) this._polyMin[2] = aabb.min.z;
      if (aabb.max.x > this._polyMax[0]) this._polyMax[0] = aabb.max.x;
      if (aabb.max.y > this._polyMax[1]) this._polyMax[1] = aabb.max.y;
      if (aabb.max.z > this._polyMax[2]) this._polyMax[2] = aabb.max.z;
      // per-polyhedron override > per-category material, packed into the
      // spare header/AABB w slots (poly.key/catKey are stamped by
      // PolyhedraModule.assignPolyhedraKeys; when absent — list panel never
      // built — the default material applies)
      const poly = structure?.polyhedra?.polyhedra?.[mesh.userData.polyIndex];
      const material = (poly?.key ? structure?.polyhedraUserStyles?.[poly.key]?.material : null)
        ?? (poly?.catKey ? structure?.polyhedraCategoryStyles?.[poly.catKey]?.material : null);
      const [matType, roughness, typeParam, reflectivity] = materialTexel(material);
      let listedReflect = reflectivity; // aabbMax.w slot (listed bit for emissive)
      if (matType === 3) {
        this.hasEmissive = true;
        const listed = this._emissiveList.length < EMISSIVE_CAP;
        listedReflect = listed ? 1 : 0;
        // emitter bounding sphere from the poly AABB (center + half-diagonal)
        const cx = (aabb.min.x + aabb.max.x) / 2;
        const cy = (aabb.min.y + aabb.max.y) / 2;
        const cz = (aabb.min.z + aabb.max.z) / 2;
        const r = 0.5 * Math.hypot(
          aabb.max.x - aabb.min.x, aabb.max.y - aabb.min.y, aabb.max.z - aabb.min.z);
        this._emissiveList.push({ kind: 2, encIndex: p, cx, cy, cz, r, power: typeParam });
      }
      const d = p * 16;
      data[d] = planeOffset; data[d + 1] = planes.length; data[d + 2] = matType; data[d + 3] = roughness;
      _color.copy(mesh.material.color);
      data[d + 4] = _color.r; data[d + 5] = _color.g; data[d + 6] = _color.b;
      data[d + 7] = mesh.material.opacity ?? 1;
      data[d + 8] = aabb.min.x; data[d + 9] = aabb.min.y; data[d + 10] = aabb.min.z; data[d + 11] = typeParam;
      data[d + 12] = aabb.max.x; data[d + 13] = aabb.max.y; data[d + 14] = aabb.max.z; data[d + 15] = listedReflect;
      for (const plane of planes) {
        data.set(plane, planeOffset * 4);
        planeOffset++;
      }
    });
    this.polyCount = meshes.length;
    texture.needsUpdate = true;
  }

  /** World-space face planes (deduped, any count up to the MAX_PLANES sanity
   *  cap) + AABB for one polyhedron mesh, cached on its userData (dies with the
   *  mesh on rebuild). The shader streams these planes (convexChunk.js), so
   *  there is no fixed-array limit; returns false (and warns once) only for a
   *  degenerate hull or one beyond the sanity cap. */
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
        + `${MAX_PLANES}-plane texture/perf sanity cap — skipped (should never `
        + `fire for real coordination shells)`);
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
      this._fieldForward = null;
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
    this._fieldForward = _m.clone(); // frac [0,1]^3 -> world (scene-bounds corners)

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
