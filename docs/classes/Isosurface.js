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

        const MC = new GPUMarchCubes.MarchCubes(field);
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
        this.clearMesh();

        if (this.marchingCubes.positive && (isoValue >= 0 || this.activeField.useAbsoluteValue)) {
            if (this.activeField.useAbsoluteValue) {
                isoValue = Math.abs(isoValue);
            }
            const { vertices, normals } = this.marchingCubes.getVerticesForIso(isoValue);

            const positionArray = vertices;
            const positionAttribute = new THREE.BufferAttribute(positionArray, 3);
            positionAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.positive.geometry.setAttribute('position', positionAttribute);
            this.meshes.positive.geometry.setDrawRange(0, vertices.length / 3);

            const normalArray = normals;
            const normalAttribute = new THREE.BufferAttribute(normalArray, 3);
            normalAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.positive.geometry.setAttribute('normal', normalAttribute);
            this.meshes.positive.geometry.setDrawRange(0, normals.length / 3);
        }
        if (this.marchingCubes.negative && (isoValue < 0 || this.activeField.useAbsoluteValue)) {
            if (this.activeField.useAbsoluteValue) {
                isoValue = -Math.abs(isoValue);
            }
            const { vertices, normals } = this.marchingCubes.getVerticesForIso(isoValue);

            const positionArray = vertices;
            const positionAttribute = new THREE.BufferAttribute(positionArray, 3);
            positionAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.negative.geometry.setAttribute('position', positionAttribute);
            this.meshes.negative.geometry.setDrawRange(0, vertices.length / 3);

            const normalArray = normals;
            const normalAttribute = new THREE.BufferAttribute(normalArray, 3);
            normalAttribute.setUsage(THREE.DynamicDrawUsage);
            this.meshes.negative.geometry.setAttribute('normal', normalAttribute);
            this.meshes.negative.geometry.setDrawRange(0, normals.length / 3);
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

        this.marchingCubes.delete();
    }

    setVisible(visible) {
        this.meshes.positive.visible = visible;
        this.meshes.negative.visible = visible;
        this.field.isVisible = visible;
    }

}