import * as THREE from '../external/three/three.module.js';
import { MarchCubes } from '../external/marching_cubes_wasm/MarchCubes.js';
import * as GPU from '../external/gpu-browser.min.js';

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

const vertex2pos = GPU.createKernel(function(vertexIndex, x_step, y_step, z_step) {
    const vertex_id = vertexIndex[this.thread.x];
    const z = Math.floor(vertex_id / z_step);
    const y = Math.floor((vertex_id - z * z_step) / y_step);
    const x = vertex_id - z * z_step - y * y_step;
    return [x, y, z];
}).setOutput([defaultKernelSize]);


const normCalcKernel = GPU.createKernel(function(field, indexOffset, x_step, y_step, z_step, dx, dy, dz) {
    const vertex_id = this.thread.x + indexOffset;
    const x_min = vertex_id - x_step, x_max = vertex_id + x_step;
    const y_min = vertex_id - y_step, y_max = vertex_id + y_step;
    const z_min = vertex_id - z_step, z_max = vertex_id + z_step;

    const norm_x = 0.5 * ( field[x_max] - field[x_min] ) / dx;
    const norm_y = 0.5 * ( field[y_max] - field[y_min] ) / dy;
    const norm_z = 0.5 * ( field[z_max] - field[z_min] ) / dz;

    return [norm_x, norm_y, norm_z];
}).setOutput([defaultKernelSize]);


const countCubeKernel = GPU.createKernel(function(field, indexOffset, isoValue, x_step, y_step, z_step) {
    vertex_index++;
					
    /* 
    cube_points[0] = vertex_index; 								// v1
    cube_points[1] = vertex_index + x_step; 					// v2
    cube_points[2] = vertex_index + x_step + y_step; 			// v3
    cube_points[3] = vertex_index +        + y_step; 			// v4
    cube_points[4] = vertex_index + 				+ z_step; 	// v5
    cube_points[5] = vertex_index + x_step 			+ z_step; 	// v6
    cube_points[6] = vertex_index + x_step + y_step + z_step; 	// v7
    cube_points[7] = vertex_index 		   + y_step + z_step; 	// v8 
    */
    
    // map the isosurface encapsulation to byte-formatted table index
    let cube_index = 0;
    cube_index |= Number(field[this.thread.x + indexOffset] < isoValue);                                // v1
    cube_index |= Number(field[this.thread.x + indexOffset + x_step] < isoValue) << 1;                  // v2
    cube_index |= Number(field[this.thread.x + indexOffset + x_step + y_step] < isoValue) << 2;         // v3
    cube_index |= Number(field[this.thread.x + indexOffset + y_step] < isoValue) << 3;                  // v4
    cube_index |= Number(field[this.thread.x + indexOffset + z_step] < isoValue) << 4;                  // v5
    cube_index |= Number(field[this.thread.x + indexOffset + x_step + z_step] < isoValue) << 5;         // v6
    cube_index |= Number(field[this.thread.x + indexOffset + x_step + y_step + z_step] < isoValue) << 6;// v7
    cube_index |= Number(field[this.thread.x + indexOffset + y_step + z_step] < isoValue) << 7;         // v8

    return cube_index;

}).setOutput([defaultKernelSize]);

const defaultPosColor = new THREE.Color(0x33aaff);
const defaultNegColor = new THREE.Color(0xff3333);

var MarchingCubesModule = await MarchCubes();

export class Isosurface extends THREE.Group {
    constructor(field) {
        super();
        this.field = field;

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

}