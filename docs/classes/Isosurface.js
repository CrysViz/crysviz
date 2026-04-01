import * as THREE from '../external/three/three.module.js';
// import { MarchCubes } from '../external/marching_cubes_wasm/MarchCubes.js';

import { mergeVertices } from '../external/three/BufferGeometryUtils.js';
import { groups } from '../store.js';

import { MarchingCubesWrapper } from './MarchingCubesWrapper.js';


const surface_options = {
    //transmission: 0.95,
    side: THREE.DoubleSide,
    opacity:0.4,
    transparent: true,
    //depthWrite: false,
    //depthTest: true,
  } 

const defaultPosColor = new THREE.Color(0x33aaff);
const defaultNegColor = new THREE.Color(0xff3333);



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

    _replaceGeometry(meshKey, vertices, normals) {
        const tmpGeom = new THREE.BufferGeometry();
        tmpGeom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        tmpGeom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

        const merged = tmpGeom; //mergeVertices(tmpGeom);
        merged.computeVertexNormals();
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