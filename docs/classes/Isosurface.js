import * as THREE from '../external/three/three.module.js';
import { MarchCubes } from '../external/marching_cubes_wasm/MarchCubes.js';

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

export class Isosurface {
    constructor(field) {
        this.field = field;

        const positiveMC = MarchingCubesModule.MarchingCubes(field.nx, field.ny, field.nz);
        this.fieldPtr = positiveMC.get_field();
        const negativeMC = MarchingCubesModule.MarchingCubes(field.nx, field.ny, field.nz, this.fieldPtr);
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
    }

    setPositiveMesh(mesh) {
        this.meshes.positive = mesh;
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

    updateFieldMesh() {
        if (this.marchingCubes.positive) {

    }

    setNegativeMesh(mesh) {
        this.meshes.negative = mesh;
    }

    setActiveField(field) {
        this.activeField = field;
    }

    setPositiveMarchingCubes(mc) {
        this.marchingCubes.positive = mc;
    }

    setNegativeMarchingCubes(mc) {
        this.marchingCubes.negative = mc;
    }

    getActiveMarchingCubes() {
        return this.activeField === 'positive' ? this.marchingCubes.positive : this.marchingCubes.negative;
    }

    clearMesh() {
        this.meshes.positive.geometry.dispose();
        this.meshes.negative.geometry.dispose();
    }

}