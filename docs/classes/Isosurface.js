import * as THREE from '../external/three/three.module.js';
// import { MarchCubes } from '../external/marching_cubes_wasm/MarchCubes.js';
import * as WASMMarchCubes from '../external/marching_cubes_wasm/MarchCubes.js';
import * as GPUMarchCubes from '../external/GPU/marching_cubes.js';
import { mergeVertices } from '../external/three/BufferGeometryUtils.js';
import { groups } from '../store.js';

const surface_options = {
    //transmission: 0.95,
    side: THREE.DoubleSide,
    opacity:0.4,
    transparent: true,
    //depthWrite: false,
    //depthTest: true,
  } 

const defaultKernelSize = 4096;

const defaultPosColor = new THREE.Color(0x33aaff);
const defaultNegColor = new THREE.Color(0xff3333);

// var MarchingCubesModule = await MarchCubes();

export class Isosurface extends THREE.Group {

    constructor(field) {
        super();
        this.field = field;

        const MC = new GPUMarchCubes.MarchCubes(field, field.nx, field.ny, field.nz);
        this.marchingCubes = MC;

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

        this.add(this.meshes.positive);
        this.add(this.meshes.negative);

        this.matrixAutoUpdate = false;
        const cell = new THREE.Matrix4();
        cell.set(
            this.field.voxel[0][0], this.field.voxel[1][0], this.field.voxel[2][0], 0,
            this.field.voxel[0][1], this.field.voxel[1][1], this.field.voxel[2][1], 0,
            this.field.voxel[0][2], this.field.voxel[1][2], this.field.voxel[2][2], 0,
            0, 0, 0, 1
        );
        cell.scale(new THREE.Vector3(this.field.nx, this.field.ny, this.field.nz));
        this.applyMatrix4(cell);
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

        const merged = mergeVertices(tmpGeom);
        merged.computeVertexNormals();
        merged.computeBoundingSphere();

        const oldMesh = this.meshes[meshKey];
        const newMesh = new THREE.Mesh(merged, oldMesh.material);
        newMesh.frustumCulled = false;
        this.remove(oldMesh);
        this.add(newMesh);
        this.meshes[meshKey] = newMesh;
    }

    updateMesh(isoValue = this.field.isovalue) {

        if (this.marchingCubes && this.meshes.positive && (isoValue >= 0 || groups.activeField.useAbsoluteIsoValue)) {
            if (groups.activeField.useAbsoluteIsoValue) {
                isoValue = Math.abs(isoValue);
            }
            const { vertices, normals } = this.marchingCubes.getVerticesForIso(isoValue);
            this._replaceGeometry('positive', vertices, normals);
        }
        if (this.marchingCubes && this.meshes.negative && (isoValue < 0 || groups.activeField.useAbsoluteIsoValue)) {
            if (groups.activeField.useAbsoluteIsoValue) {
                isoValue = -Math.abs(isoValue);
            }
            const { vertices, normals } = this.marchingCubes.getVerticesForIso(isoValue);
            this._replaceGeometry('negative', vertices, normals);
        }
    }

    setActiveField(field) {
        groups.activeField = field;

        updateNormals(groups.activeField);
    }

    clearMesh() {
        if (this.meshes.positive) {
            this.remove(this.meshes.positive);
            this.meshes.positive.geometry.dispose();
            this.meshes.positive.geometry = new THREE.BufferGeometry();
            this.add(this.meshes.positive);
        }
        if (this.meshes.negative) {
            this.remove(this.meshes.negative);
            this.meshes.negative.geometry.dispose();
            this.meshes.negative.geometry = new THREE.BufferGeometry();
            this.add(this.meshes.negative);
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