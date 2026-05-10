import * as THREE from '../external/three/three.module.js';
// import { MarchCubes } from '../external/marching_cubes_wasm/MarchCubes.js';

import { mergeVertices } from '../external/three/BufferGeometryUtils.js';
import { groups } from '../store.js';

import { MarchingCubesWrapper } from './MarchingCubesWrapper.js';


export let surface_options = {
    //transmission: 0.95,
    side: THREE.DoubleSide,
    opacity:0.4,
    transparent: true,
    alphaTest: 0.01,
    //depthWrite: false,
    //depthTest: true,
  } 

export let defaultPosColor = new THREE.Color(0x33aaff);
export let defaultNegColor = new THREE.Color(0xff3333);

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

export function applyIsosurfaceMaterialSettings(isosurface, settings = {}) {
    if (!isosurface || !isosurface.meshes) return;

    const { positiveColor, negativeColor, opacity } = settings;
    const positiveMat = isosurface.meshes.positive?.material;
    const negativeMat = isosurface.meshes.negative?.material;

    if (positiveMat) {
        if (positiveColor !== undefined) {
            positiveMat.color.set(positiveColor);
        }
        if (opacity !== undefined) {
            positiveMat.opacity = clampOpacity(opacity);
            positiveMat.transparent = positiveMat.opacity < 1;
        }
        positiveMat.needsUpdate = true;
    }

    if (negativeMat) {
        if (negativeColor !== undefined) {
            negativeMat.color.set(negativeColor);
        }
        if (opacity !== undefined) {
            negativeMat.opacity = clampOpacity(opacity);
            negativeMat.transparent = negativeMat.opacity < 1;
        }
        negativeMat.needsUpdate = true;
    }
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



export class Isosurface extends THREE.Group{

    constructor(field) {
        super();
        this.field = field;

        this.marchingCubes = new MarchingCubesWrapper(field, "wasm");
        
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

    addMeshes() {
        let material_options = {};
        Object.assign(material_options, surface_options);
        material_options.color = defaultPosColor;
        const materialPos = new THREE.MeshPhysicalMaterial(material_options);
        material_options.color = defaultNegColor;
        const materialNeg = new THREE.MeshPhysicalMaterial(material_options);
        const positiveGeom = new THREE.BufferGeometry();
        const negativeGeom = new THREE.BufferGeometry();
        
        this.meshes = {
            positive: new THREE.Mesh(positiveGeom, materialPos),
            negative: new THREE.Mesh(negativeGeom, materialNeg)
        };
        this.meshes.positive.name = 'isosurface_pos';
        this.meshes.negative.name = 'isosurface_neg';

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

        const merged = tmpGeom // mergeVertices(tmpGeom); // merging vertices might be a good idea, but currently way more expensive
        //merged.computeVertexNormals();
        //merged.computeBoundingSphere();

        this.meshes[meshKey].geometry = merged;
    }

    updateMesh(isoValue = this.field.isovalue) {
        const t0 = performance.now();

        let iso = isoValue;
        if (this.marchingCubes && this.meshes.positive && (iso >= 0 || groups.activeField.useAbsoluteIsoValue)) {
            if (groups.activeField.useAbsoluteIsoValue) {
                iso = Math.abs(isoValue);
            }
            const { vertices, normals } = this.marchingCubes.getVertices(iso);
            this._replaceGeometry('positive', vertices, normals);
            this.meshes.positive.needUpdate = true;
            this.add(this.meshes.positive);
        }
        if (this.marchingCubes && this.meshes.negative && (iso < 0 || groups.activeField.useAbsoluteIsoValue)) {
            if (groups.activeField.useAbsoluteIsoValue) {
                iso = -Math.abs(isoValue);
            }
            const { vertices, normals } = this.marchingCubes.getVertices(iso);
            this._replaceGeometry('negative', vertices, normals);
            this.meshes.negative.needUpdate = true;
            this.add(this.meshes.negative);
        }
        const t1 = performance.now();
        console.log(`Marching Cubes took ${t1 - t0} milliseconds.`);
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