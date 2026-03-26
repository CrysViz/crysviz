import * as THREE from '../external/three/three.module.js';
// import { MarchCubes } from '../external/marching_cubes_wasm/MarchCubes.js';
import * as GPU from '../external/GPU/gpu-browser.min.js';
import * as WASMMarchCubes from '../external/marching_cubes_wasm/MarchCubes.js';
import * as GPUMarchCubes from '../external/GPU/marching_cubes.js';

const surface_options = {
    opacity: 0.4,
    roughness: 0.3,
    metalness: 0.05,
    clearcoat: 0.4,
    clearcoatRoughness: 0.1,
    side: THREE.DoubleSide,
    transparent: true,
  } 

const defaultKernelSize = 4096;

const defaultPosColor = new THREE.Color(0x33aaff);
const defaultNegColor = new THREE.Color(0xff3333);

// var MarchingCubesModule = await MarchCubes();

export class Isosurface extends THREE.Group {

    constructor(field) {
        super();
        this.field = field;

        this.fieldNormals = new Float32Array(field.nx * field.ny * field.nz * 3);
        this.cachedTextures = []

        const positiveMC = new MarchingCubesModule.MarchingCubes(field.nx, field.ny, field.nz);
        this.fieldPtr = positiveMC.get_field();
        const negativeMC = new MarchingCubesModule.MarchingCubes(field.nx, field.ny, field.nz, this.fieldPtr);
        this.marchingCubes = {
            positive: positiveMC,
            negative: negativeMC
        };

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

    cacheGPU() {
        const chunkSize = this.field.nx * 3 * 3; // 3 in y and 3 in z
        for (let i = 0; i < this.field.values.length; i += defaultKernelSize) {
            const chunk = this.field.values.subarray(i, Math.min(i + defaultKernelSize, this.field.values.length));
            const texture = send2GPUKernel(chunk);
            this.cachedTextures.push(texture);
        }
    }

    updateMesh(isoValue = this.field.isovalue) {
        this.clearMesh();

        if (this.marchingCubes.positive && (isoValue >= 0 || this.activeField.useAbsoluteValue)) {
            if (this.activeField.useAbsoluteValue) {
                isoValue = Math.abs(isoValue);
            }
            this.marchingCubes.positive.update_vertices(isoValue);
            const vertexPtr = this.marchingCubes.positive.get_vertices();
            const normalPtr = this.marchingCubes.positive.get_normals();
            const numVertices = this.marchingCubes.positive.get_num_vertices();

            const positionArray = new Float64Array(MarchingCubesModule.HEAPF64.buffer, vertexPtr, numVertices * 3);
            const positionAttribute = new THREE.BufferAttribute(positionArray, 3);
            positionAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.positive.geometry.setAttribute('position', positionAttribute);

            const normalArray = new Float64Array(MarchingCubesModule.HEAPF64.buffer, normalPtr, numVertices * 3);
            const normalAttribute = new THREE.BufferAttribute(normalArray, 3);
            normalAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.positive.geometry.setAttribute('normal', normalAttribute);
        }
        if (this.marchingCubes.negative && (isoValue < 0 || this.activeField.useAbsoluteValue)) {
            if (this.activeField.useAbsoluteValue) {
                isoValue = -Math.abs(isoValue);
            }
            this.marchingCubes.negative.update_vertices(isoValue);
            const vertexPtr = this.marchingCubes.negative.get_vertices();
            const normalPtr = this.marchingCubes.negative.get_normals();
            const numVertices = this.marchingCubes.negative.get_num_vertices();

            const positionArray = new Float64Array(MarchingCubesModule.HEAPF64.buffer, vertexPtr, numVertices * 3);
            const positionAttribute = new THREE.BufferAttribute(positionArray, 3);
            positionAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.negative.geometry.setAttribute('position', positionAttribute);

            const normalArray = new Float64Array(MarchingCubesModule.HEAPF64.buffer, normalPtr, numVertices * 3);
            const normalAttribute = new THREE.BufferAttribute(normalArray, 3);
            normalAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.negative.geometry.setAttribute('normal', normalAttribute);
        }

        this.matrixAutoUpdate = false;
        const cell = new THREE.Matrix4();
        cell.set(
            field.voxel[0][0], field.voxel[1][0], field.voxel[2][0], 0,
            field.voxel[0][1], field.voxel[1][1], field.voxel[2][1], 0,
            field.voxel[0][2], field.voxel[1][2], field.voxel[2][2], 0,
            0, 0, 0, 1
        );
        cell.scale(new THREE.Vector3(nx, ny, nz));
        this.applyMatrix4(cell);
    }

    updateNormals(field) {

    }

    setActiveField(field) {
        this.activeField = field;

        updateNormals(this.activeField);
    }

    clearMesh() {
        if (this.meshes.positive) {
            this.meshes.positive.geometry.dispose();
        }
        if (this.meshes.negative) {
            this.meshes.negative.geometry.dispose();
        }
    }

    delete() {
        this.clearMesh();

        for (const textures in this.cachedTextures) {
            this.textures.delete();
        }
        this.cachedTextures = [];
    }

}