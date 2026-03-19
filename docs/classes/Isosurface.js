import * as THREE from '../external/three/three.module.js';
import MarchCubes from '../external/marching_cubes_wasm/MarchCubes.js';
import { groups } from '../store.js';

const surface_options = {
    opacity: 0.4,
    roughness: 0.3,
    metalness: 0.05,
    clearcoat: 0.4,
    clearcoatRoughness: 0.1,
    side: THREE.DoubleSide,
    transparent: true,
  } 

const defaultPosColor = new THREE.Color(0x33aaff);
const defaultNegColor = new THREE.Color(0xff3333);

var MarchingCubesModule = await MarchCubes();
//var Module = import('../external/marching_cubes_wasm/MarchCubes.js').then(module => MarchingCubesModule = module.MarchCubes);

export class Isosurface extends THREE.Group {
    constructor(field) {
        super();
        this.field = field;

        console.log("Initializing Marching Cubes with field size:", field.nx, field.ny, field.nz, "in total", field.nx * field.ny * field.nz, "voxels");
        const positiveMC = new MarchingCubesModule.MarchingCubes(field.nx, field.ny, field.nz);
        this.fieldPtr = positiveMC.getField();
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

    updateMesh(isoValue = this.field.isovalue) {

        if (this.marchingCubes.positive && (isoValue >= 0 || groups.activeField.useAbsoluteValue)) {
            if (groups.activeField.useAbsoluteValue) {
                isoValue = Math.abs(isoValue);
            }
            this.marchingCubes.positive.updateVertices(isoValue);
            const vertexPtr = this.marchingCubes.positive.getVertices();
            const normalPtr = this.marchingCubes.positive.getNormals();
            const numVertices = this.marchingCubes.positive.getVertexCount();
            const vertexData = vertexPtr.dataPtr();
            const normalData = normalPtr.dataPtr();

            const positionArray = new Float32Array(MarchingCubesModule.HEAPF32.buffer, vertexData, numVertices * 3);
            const positionAttribute = new THREE.BufferAttribute(positionArray, 3);
            positionAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.positive.geometry.setAttribute('position', positionAttribute);

            const normalArray = new Float32Array(MarchingCubesModule.HEAPF32.buffer, normalData, numVertices * 3);
            const normalAttribute = new THREE.BufferAttribute(normalArray, 3);
            normalAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.positive.geometry.setAttribute('normal', normalAttribute);

            this.meshes.positive.geometry.computeVertexNormals();
        }
        if (this.marchingCubes.negative && (isoValue < 0 || groups.activeField.useAbsoluteValue)) {
            if (groups.activeField.useAbsoluteValue) {
                isoValue = -Math.abs(isoValue);
            }
            this.marchingCubes.negative.updateVertices(isoValue);
            const vertexPtr = this.marchingCubes.negative.getVertices();
            const normalPtr = this.marchingCubes.negative.getNormals();
            const numVertices = this.marchingCubes.negative.getVertexCount();
            const vertexData = vertexPtr.dataPtr();
            const normalData = normalPtr.dataPtr();

            const positionArray = new Float32Array(MarchingCubesModule.HEAPF32.buffer, vertexData, numVertices * 3);
            const positionAttribute = new THREE.BufferAttribute(positionArray, 3);
            positionAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.negative.geometry.setAttribute('position', positionAttribute);

            const normalArray = new Float32Array(MarchingCubesModule.HEAPF32.buffer, normalData, numVertices * 3);
            const normalAttribute = new THREE.BufferAttribute(normalArray, 3);
            normalAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.negative.geometry.setAttribute('normal', normalAttribute);

            this.meshes.negative.geometry.computeVertexNormals();
        }



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

    setActiveField(field) {
        this.activeField = field;
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
        this.marchingCubes.positive.delete();
        this.marchingCubes.negative.delete();
    }

}