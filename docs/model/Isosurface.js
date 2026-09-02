import * as THREE from '../external/three/three.module.js';
// import { MarchCubes } from '../compiled/MarchCubes.js';

import { groups } from '../state/store.js';

import { MarchingCubesWrapper, MarchingCubesBackend } from './MarchingCubesWrapper.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import { makeFractionalBoundsClippingPlanes } from './Plane.js';


// Transparency flags (transparent, depthWrite, renderOrder) are owned by the
// rendering pipeline policy ('isosurface' in render/pipeline/ForwardPipeline.js)
// and applied via applyIsosurfaceMaterialSettings below.
export let surface_options = {
    //transmission: 0.95,
    side: THREE.DoubleSide,
    opacity:0.6,
  }



export let defaultPosColor = new THREE.Color(0x33aaff);
export let defaultNegColor = new THREE.Color(0xff3333);
export let isosurfaceTriangleSortingEnabled = true;


const _sortCameraPosition = new THREE.Vector3();
const _sortCameraQuaternion = new THREE.Quaternion();
const _lastSortCameraPosition = new THREE.Vector3();
const _lastSortCameraQuaternion = new THREE.Quaternion();
let _hasLastSortCameraState = false;

function clampOpacity(opacity) {
    if (!Number.isFinite(opacity)) return surface_options.opacity;
    return Math.max(0, Math.min(1, opacity));
}

export function getIsosurfaceMaterialSettings() {
    return {
        positiveColor: `#${defaultPosColor.getHexString()}`,
        negativeColor: `#${defaultNegColor.getHexString()}`,
        opacity: surface_options.opacity
    };
}

export function setIsosurfaceMaterialSettings(settings = {}) {
    if (settings.positiveColor !== undefined) {
        defaultPosColor.set(settings.positiveColor);
    }
    if (settings.negativeColor !== undefined) {
        defaultNegColor.set(settings.negativeColor);
    }
    if (settings.opacity !== undefined) {
        surface_options.opacity = clampOpacity(settings.opacity);
    }
}

export function setIsosurfaceTriangleSortingEnabled(enabled) {
    isosurfaceTriangleSortingEnabled = Boolean(enabled);
}

export function getIsosurfaceTriangleSortingEnabled() {
    // return isosurfaceTriangleSortingEnabled;
    // Disabled as the rendering engine fixes the artifacts this was meant to
    // solve: below alpha 1 the order-independent pipelines (depth peeling /
    // WBOIT) blend the surface correctly, and AT alpha 1 the transparency
    // policy now marks it genuinely opaque (depth writes on, see
    // render/pipeline/ForwardPipeline.js 'isosurface'), so the depth buffer —
    // not the marching-cubes vertex order — decides what is in front.
    return false;
}

export function applyIsosurfaceMaterialSettings(isosurface, settings = {}) {
    if (!isosurface || !isosurface.meshes) return;

    const { positiveColor, negativeColor, opacity } = settings;

    const applyToMesh = (mesh, color) => {
        const material = mesh?.material;
        if (!material) return;
        if (color !== undefined) {
            material.color.set(color);
        }
        if (opacity !== undefined) {
            material.opacity = clampOpacity(opacity);
        }
        applyTransparency(material, { kind: 'isosurface', opacity: material.opacity, mesh });
    };

    applyToMesh(isosurface.meshes.positive, positiveColor);
    applyToMesh(isosurface.meshes.negative, negativeColor);
    // The periodic boundary copies share these materials but carry their own
    // renderOrder/visibility, which the transparency policy just rewrote.
    isosurface._syncImageState?.();
}

export function applyMaterialSettingsToStoredIsosurfaces(isosurfaceGroup, settings = {}) {
    if (!isosurfaceGroup) return;

    const applyOne = (entry) => {
        if (!entry) return;
        if (entry.meshes?.positive || entry.meshes?.negative) {
            applyIsosurfaceMaterialSettings(entry, settings);
            return;
        }
        if (entry.traverse) {
            entry.traverse((child) => {
                if (child?.meshes?.positive || child?.meshes?.negative) {
                    applyIsosurfaceMaterialSettings(child, settings);
                }
            });
        }
    };

    if (Array.isArray(isosurfaceGroup)) {
        isosurfaceGroup.forEach(applyOne);
    } else if (isosurfaceGroup instanceof Set) {
        isosurfaceGroup.forEach(applyOne);
    } else if (isosurfaceGroup instanceof Map) {
        isosurfaceGroup.forEach((value) => applyOne(value));
    } else {
        applyOne(isosurfaceGroup);
    }
}

export function updateStoredIsosurfaceRenderOrder(camera, isosurfaceGroup) {
    if (!camera || !isosurfaceGroup) return;

    camera.updateMatrixWorld(true);
    _sortCameraPosition.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldQuaternion(_sortCameraQuaternion);

    if (
        _hasLastSortCameraState
        && _lastSortCameraPosition.equals(_sortCameraPosition)
        && _lastSortCameraQuaternion.equals(_sortCameraQuaternion)
    ) {
        return;
    }

    _hasLastSortCameraState = true;
    _lastSortCameraPosition.copy(_sortCameraPosition);
    _lastSortCameraQuaternion.copy(_sortCameraQuaternion);

    const applyOne = (entry) => {
        if (!entry) return;
        if (typeof entry.sortTrianglesByCameraDistance === 'function') {
            entry.sortTrianglesByCameraDistance(_sortCameraPosition);
            return;
        }
        if (entry.traverse) {
            entry.traverse((child) => {
                if (typeof child?.sortTrianglesByCameraDistance === 'function') {
                    child.sortTrianglesByCameraDistance(_sortCameraPosition);
                }
            });
        }
    };

    if (Array.isArray(isosurfaceGroup)) {
        isosurfaceGroup.forEach(applyOne);
    } else if (isosurfaceGroup instanceof Set) {
        isosurfaceGroup.forEach(applyOne);
    } else if (isosurfaceGroup instanceof Map) {
        isosurfaceGroup.forEach((value) => applyOne(value));
    } else {
        applyOne(isosurfaceGroup);
    }
}



// ---------------------------------------------------------------------------
//  Periodic display boundary (VESTA-style "Active Cell Boundary")
//
//  general.periodicBounds gives a per-axis fractional [min, max] display
//  region, and render/LatticeModule.js draws every periodic image of every
//  atom that lands inside it. A volumetric field is periodic in exactly the
//  same way, so it follows the boundary the same way — it is just expressed
//  differently: instead of emitting extra atoms, the field is DRAWN AGAIN in
//  every cell the region reaches (the marching-cubes mesh is translated by
//  whole lattice vectors — same geometry, same material, one extra draw call)
//  and every copy is CLIPPED to the region, so a boundary that stops
//  part-way through a cell cuts the surface there instead of showing a whole
//  extra cell of it.
// ---------------------------------------------------------------------------

/** @type {[number, number][]} */
const UNIT_BOUNDS = [[0, 1], [0, 1], [0, 1]];
// Bounds are user-typed, so a value a hair over an integer (1.0000001) must
// not conjure a whole extra cell of field.
const BOUND_EPS = 1e-6;
// Safety net for a restored/shared state with wild bounds: the panel itself
// clamps to +/-2 cells (5 per axis), and 5^3 copies of one mesh is already a
// lot of geometry to push per frame.
const MAX_IMAGES_PER_AXIS = 5;

/** True for the plain unit cell [0,1] on every axis — the default, in which
 *  the field is exactly one copy and needs no clipping at all. */
function isUnitBounds(bounds) {
    return bounds.every(([lo, hi]) => Math.abs(lo) < BOUND_EPS && Math.abs(hi - 1) < BOUND_EPS);
}

/** Integer cell translations n whose own cell [n, n+1] overlaps [lo, hi].
 *  [0,1] -> [0] (today's single copy); [0,1.2] -> [0,1]; [-0.5,1] -> [-1,0]. */
function axisImageRange([lo, hi]) {
    const first = Math.floor(lo + BOUND_EPS);
    // max(): a zero-thickness region (lo === hi) still resolves to one cell,
    // which the clipping then reduces to nothing — better than no mesh at all.
    const last = Math.min(Math.max(first, Math.ceil(hi - BOUND_EPS) - 1), first + MAX_IMAGES_PER_AXIS - 1);
    const out = [];
    for (let n = first; n <= last; n++) out.push(n);
    return out;
}

/** Every integer cell translation [i,j,k] the display boundary reaches. */
function boundsImageOffsets(bounds) {
    const [ri, rj, rk] = bounds.map(axisImageRange);
    const out = [];
    for (const i of ri) for (const j of rj) for (const k of rk) out.push([i, j, k]);
    return out;
}

export class Isosurface extends THREE.Group{

    constructor(field) {
        super();
        this.field = field;
        /** @type {string} */
        this.backend = MarchingCubesBackend.WASM;
        this.lastCameraPosition = new THREE.Vector3();

        this.marchingCubes = new MarchingCubesWrapper(field, this.backend);

        /** Extra meshes drawing this field in the other cells the periodic
         *  display boundary reaches. They SHARE the positive/negative meshes'
         *  geometry and material — only the cell translation differs. */
        this._imageMeshes = [];
        /** @type {[number, number][]} the boundary these copies were built for */
        this._periodicBounds = UNIT_BOUNDS;

        this.addMeshes();

        this.matrixAutoUpdate = false;
        const transform_cell = new THREE.Matrix4();
        transform_cell.set(
            this.field.voxel[0][0], this.field.voxel[1][0], this.field.voxel[2][0], 0,
            this.field.voxel[0][1], this.field.voxel[1][1], this.field.voxel[2][1], 0,
            this.field.voxel[0][2], this.field.voxel[1][2], this.field.voxel[2][2], 0,
            0, 0, 0, 1
        );
        transform_cell.scale(new THREE.Vector3(this.field.nx, this.field.ny, this.field.nz));
        this.applyMatrix4(transform_cell);
    }

    sortTrianglesByCameraDistance(cameraPosition) {
        if (!cameraPosition || !this.marchingCubes) return;

        // Transform camera position into the isosurface's local coordinate system
        this.updateMatrixWorld(true);
        this.lastCameraPosition.copy(cameraPosition);
        const localCameraPosition = cameraPosition.clone();
        const inverseMatrix = new THREE.Matrix4().copy(this.matrixWorld).invert();
        localCameraPosition.applyMatrix4(inverseMatrix);

        for (const meshKey of ['positive', 'negative']) {
            const mesh = this.meshes?.[meshKey];
            if (!mesh?.geometry) continue;

            const positionAttr = mesh.geometry.getAttribute('position');
            if (!positionAttr?.array || positionAttr.count < 3) continue;
            const normalAttr = mesh.geometry.getAttribute('normal');

            this.marchingCubes.sortVerticesToCamera(localCameraPosition, positionAttr.array, normalAttr?.array);

            positionAttr.needsUpdate = true;
            if (normalAttr) {
                normalAttr.needsUpdate = true;
            }
        }
    }

    addMeshes() {
        let material_options = {};
        Object.assign(material_options, surface_options);
        material_options.color = defaultPosColor;
        const materialPos = new THREE.MeshPhysicalMaterial(material_options);
        material_options.color = defaultNegColor;
        const materialNeg = new THREE.MeshPhysicalMaterial(material_options);
        const positiveGeom = new THREE.BufferGeometry();
        const negativeGeom = new THREE.BufferGeometry();
        
        /** @type {{positive: any, negative: any}} */
        this.meshes = {
            positive: new THREE.Mesh(positiveGeom, materialPos),
            negative: new THREE.Mesh(negativeGeom, materialNeg)
        };
        this.meshes.positive.name = 'isosurface_pos';
        this.meshes.negative.name = 'isosurface_neg';

        // Applies the pipeline transparency policy too (incl. renderOrder).
        this.applyMaterialSettings(getIsosurfaceMaterialSettings());

        this.add(this.meshes.positive);
        this.add(this.meshes.negative);
    }

    applyMaterialSettings(settings = {}) {
        applyIsosurfaceMaterialSettings(this, settings);
    }

    get positiveMesh() {
        return this.meshes.positive;
    }

    get negativeMesh() {
        return this.meshes.negative;
    }

    set isovalue(value) {
        this.field.isovalue = value;
    }

    _replaceGeometry(meshKey, vertices, normals) {
        const tmpGeom = new THREE.BufferGeometry();
        tmpGeom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        tmpGeom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

        const merged = tmpGeom; // mergeVertices(tmpGeom); // merging vertices might be a good idea, but currently way more expensive
        if (this.backend === MarchingCubesBackend.THREE) {
            // the JS/THREE gets the normal wrong somehow, so we recompute it here.
            // The WASM backend computes correct normals, so we can skip this step for it.
            merged.computeVertexNormals();
        }
        //merged.computeBoundingSphere();

        this.meshes[meshKey].geometry = merged;
        this._syncImageState(); // the copies draw this same geometry
    }

    refreshGeometry(field_key, vertices, normals) {
        if (field_key == "positive") {
            if (vertices === undefined || normals === undefined) {
                const data = this.marchingCubes.getVertices();
                vertices = data.vertices;
                normals = data.normals;
            }
            this._replaceGeometry('positive', vertices, normals);
            this.meshes.positive.needsUpdate = true;
            this.add(this.meshes.positive);
        }
        else if (field_key == "negative") {
            if (vertices === undefined || normals === undefined) {
                const data = this.marchingCubes.getVertices();
                vertices = data.vertices;
                normals = data.normals;
            }
            this._replaceGeometry('negative', vertices, normals);
            this.meshes.negative.needsUpdate = true;
            this.add(this.meshes.negative);
        }
    }

    /**
     * A representative first isosurface level for this field, computed by the
     * marching-cubes backend from the values it already holds.
     *
     * @param {number} [fraction] target fraction of the cell inside the surface
     * @returns {number | null} null if the backend cannot supply one
     */
    defaultIsoValue(fraction = 0.05) {
        return this.marchingCubes ? this.marchingCubes.defaultIsoValue(fraction) : null;
    }

    /**
     * Follow the periodic display boundary: draw this field in every cell the
     * boundary reaches and clip every copy to it.
     *
     * Idempotent and cheap — no marching cubes rerun, the copies share the
     * base meshes' geometry and material — so it is safe to call whenever the
     * boundary, the field or the pipeline changes.
     *
     * @param {[number, number][]} [bounds] per-axis [min, max] in fractional
     *   coordinates, as render/LatticeModule.js normalizePeriodicBounds()
     *   returns. Defaults to the plain unit cell.
     */
    setPeriodicBounds(bounds = UNIT_BOUNDS) {
        const safe = /** @type {[number, number][]} */ (
            Array.isArray(bounds) && bounds.length === 3
                && bounds.every((b) => Array.isArray(b) && b.length === 2 && b.every(Number.isFinite))
                ? bounds.map(([lo, hi]) => (lo <= hi ? [lo, hi] : [hi, lo]))
                : UNIT_BOUNDS);
        this._periodicBounds = safe;
        this._syncImageMeshes(boundsImageOffsets(safe));
        this._applyBoundsClipping(safe);
    }

    /** The cell this field is drawn in, read back out of the group's own
     *  voxel*dims matrix (its columns ARE the lattice vectors), so the copies
     *  and the clipping box use exactly the basis the surface is drawn in. */
    _cellVectors() {
        const e = this.matrix.elements;
        return [
            [e[0], e[1], e[2]],
            [e[4], e[5], e[6]],
            [e[8], e[9], e[10]],
        ];
    }

    /** One mesh per (cell translation x lobe). The FIRST translation is given
     *  to the base meshes themselves — the group's local space is fractional
     *  coordinates, so a whole-cell translation is just an integer position —
     *  and the rest become shared-geometry copies. */
    _syncImageMeshes(offsets) {
        const [first, ...rest] = offsets.length ? offsets : [[0, 0, 0]];
        for (const key of ['positive', 'negative']) {
            this.meshes?.[key]?.position.set(first[0], first[1], first[2]);
        }

        // Rebuild the copy list only when the cells themselves changed; a
        // slider drag inside one cell then costs nothing but the clip update.
        const key = rest.map((o) => o.join(',')).join(';');
        if (key !== this._imageKey) {
            for (const mesh of this._imageMeshes) this.remove(mesh);
            this._imageMeshes = [];
            for (const [i, j, k] of rest) {
                for (const lobe of ['positive', 'negative']) {
                    const base = this.meshes?.[lobe];
                    if (!base) continue;
                    // Shared geometry AND material: the copies are the same
                    // surface seen in the next cell, so they must never drift
                    // from the original's colour, opacity or transparency
                    // policy — and sharing keeps a wide boundary cheap.
                    const image = new THREE.Mesh(base.geometry, base.material);
                    image.position.set(i, j, k);
                    image.name = `${base.name}_image_${i}_${j}_${k}`;
                    image.userData.fieldLobe = lobe;
                    image.userData.isFieldPeriodicImage = true;
                    this._imageMeshes.push(image);
                    this.add(image);
                }
            }
            this._imageKey = key;
        }
        this._syncImageState();
    }

    /** Copies track their source mesh's geometry (replaced on every isovalue
     *  rebuild), visibility and render order. */
    _syncImageState() {
        for (const image of this._imageMeshes) {
            const base = this.meshes?.[image.userData.fieldLobe];
            if (!base) continue;
            image.geometry = base.geometry;
            image.material = base.material;
            image.visible = base.visible;
            image.renderOrder = base.renderOrder;
        }
    }

    /** Clip every copy to the boundary box. Nothing is clipped for the plain
     *  unit cell — the field already ends at the cell faces there, so the
     *  default costs no clipping planes in the shader at all. */
    _applyBoundsClipping(bounds) {
        const planes = isUnitBounds(bounds)
            ? null
            : makeFractionalBoundsClippingPlanes(this._cellVectors(), bounds);
        for (const key of ['positive', 'negative']) {
            const material = this.meshes?.[key]?.material;
            if (!material) continue;
            const before = material.clippingPlanes?.length ?? 0;
            material.clippingPlanes = planes;
            // The plane COUNT is compiled into the program.
            if (before !== (planes?.length ?? 0)) material.needsUpdate = true;
        }
    }

    updateMesh(isoValue = this.field.isovalue, useAbsoluteIsoValue = false) {
        if (!groups.activeField) return;

        let iso = isoValue;
        if (this.marchingCubes && this.meshes.positive && (iso >= 0 || useAbsoluteIsoValue)) {
            if (useAbsoluteIsoValue) {
                iso = Math.abs(isoValue);
            }
            this._lastIsoPositive = iso;
            this.marchingCubes.updateMesh(iso);
            const posData = this.marchingCubes.getVertices();
            //this.marchingCubes.sortVerticesToCamera(this.lastCameraPosition, posData.vertices, posData.normals);
            this.refreshGeometry("positive", posData.vertices, posData.normals);
        }
        if (this.marchingCubes && this.meshes.negative && (iso < 0 || useAbsoluteIsoValue)) {
            if (useAbsoluteIsoValue) {
                iso = -Math.abs(isoValue);
            }
            this._lastIsoNegative = iso;
            this.marchingCubes.updateMesh(iso);
            const negData = this.marchingCubes.getVertices();
            //this.marchingCubes.sortVerticesToCamera(this.lastCameraPosition, negData.vertices, negData.normals);
            this.refreshGeometry("negative", negData.vertices, negData.normals);
        }
    }

    clearMesh() {
        // The copies share the geometry disposed below, so they go first; the
        // next setPeriodicBounds() rebuilds them against the new geometry.
        for (const image of this._imageMeshes) this.remove(image);
        this._imageMeshes = [];
        this._imageKey = null;
        if (this.meshes.positive) {
            this.remove(this.meshes.positive);
            this.meshes.positive.geometry.dispose();
        }
        if (this.meshes.negative) {
            this.remove(this.meshes.negative);
            this.meshes.negative.geometry.dispose();
        }
    }

    delete() {
        this.clearMesh();

        this.marchingCubes.delete();
    }

    setVisible(visible) {
        this.meshes.positive.visible = visible;
        this.meshes.negative.visible = visible;
        for (const image of this._imageMeshes) image.visible = visible;
        this.field.isVisible = visible;
    }
}