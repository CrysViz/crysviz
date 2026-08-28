import * as THREE from '../external/three/three.module.js';
// import { MarchCubes } from '../compiled/MarchCubes.js';

import { groups } from '../state/store.js';

import { MarchingCubesWrapper, MarchingCubesBackend } from './MarchingCubesWrapper.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';


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



export class Isosurface extends THREE.Group{

    constructor(field) {
        super();
        this.field = field;
        /** @type {string} */
        this.backend = MarchingCubesBackend.WASM;
        this.lastCameraPosition = new THREE.Vector3();

        this.marchingCubes = new MarchingCubesWrapper(field, this.backend);
        
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
        this.field.isVisible = visible;
    }
}