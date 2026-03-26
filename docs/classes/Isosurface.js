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



const defaultPosColor = new THREE.Color(0x33aaff);
const defaultNegColor = new THREE.Color(0xff3333);

var MarchingCubesModule = await MarchCubes();

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

    compileKernels() {
        if (this.field.nx > defaultKernelSize
            || this.field.ny > defaultKernelSize
            || this.field.nz > defaultKernelSize
            || 3 * this.field.nx * this.field.ny * this.field.nz > defaultKernelSize*defaultKernelSize) {
                console.warn("Field dimensions exceed default GPU texture size limits. Further use may require chunking, which is not implemented.");
        }

        this.send2GPUKernel = GPU.createKernel(function(field) {
            return field[this.thread.z][this.thread.y][this.thread.x];
        })
        .setOutput([this.field.nz, this.field.ny, this.field.nx])
        .setPipeline(true);

        /* const vertex2pos = GPU.createKernel(function(vertexIndex, x_step, y_step, z_step) {
            const vertex_id = vertexIndex[this.thread.x];
            const z = Math.floor(vertex_id / z_step);
            const y = Math.floor((vertex_id - z * z_step) / y_step);
            const x = vertex_id - z * z_step - y * y_step;
            return [x, y, z];
        }).setOutput([defaultKernelSize]); */


        this.normCalcKernel = GPU.createKernel(function(field, x_limit, y_limit, z_limit, dx, dy, dz) {
            const x_min = Math.max(this.thread.x - 1, 0);
            const x_max = Math.min(this.thread.x + 1, x_limit - 1);
            const y_min = Math.max(this.thread.y - 1, 0);
            const y_max = Math.min(this.thread.y + 1, y_limit - 1);
            const z_min = Math.max(this.thread.z - 1, 0);
            const z_max = Math.min(this.thread.z + 1, z_limit - 1);
            const norm_x = ( field[this.thread.z][this.thread.y][x_max] - field[this.thread.z][this.thread.y][x_min] ) / (x_max - x_min) / dx;
            const norm_y = ( field[this.thread.z][y_max][this.thread.x] - field[this.thread.z][y_min][this.thread.x] ) / (y_max - y_min) / dy;
            const norm_z = ( field[z_max][this.thread.y][this.thread.x] - field[z_min][this.thread.y][this.thread.x] ) / (z_max - z_min) / dz;
            return [norm_x, norm_y, norm_z];
        })
        .setOutput([this.field.nz, this.field.ny, this.field.nx])
        .setPipeline(true);


        this.countCubeKernel = GPU.createKernel(function(field, isoValue) {
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
            cube_index |= Number(field[this.thread.z][this.thread.y][this.thread.x] < isoValue);                                // v1
            cube_index |= Number(field[this.thread.z][this.thread.y][this.thread.x + 1] < isoValue)
                            << 1; // v2
            cube_index |= Number(field[this.thread.z][this.thread.y + 1][this.thread.x + 1] < isoValue)
                            << 2; // v3
            cube_index |= Number(field[this.thread.z][this.thread.y + 1][this.thread.x] < isoValue)
                            << 3; // v4
            cube_index |= Number(field[this.thread.z + 1][this.thread.y][this.thread.x] < isoValue)                   
                            << 4; // v5
            cube_index |= Number(field[this.thread.z + 1][this.thread.y][this.thread.x + 1] < isoValue)          
                            << 5; // v6
            cube_index |= Number(field[this.thread.z + 1][this.thread.y + 1][this.thread.x + 1] < isoValue) 
                            << 6; // v7
            cube_index |= Number(field[this.thread.z + 1][this.thread.y + 1][this.thread.x] < isoValue)          
                            << 7; // v8

            return cube_index;
        }).setOutput([this.field.nx - 1, this.field.ny - 1 , this.field.nz - 1]);

        triTableInput = GPU.input(triTable, [256, 15]);
        edge2vertexInput = GPU.input(edge2vertex, [12, 2]);
        cubeVertexPosInput = GPU.input(cubeVertexPos, [8, 3]);
        this.createVertexKernel = GPU.createKernel(function(field, normals, cubeInds, cubeFlags, isoValue) {
            const vertex_to_process = this.constants.triTable[cubeFlags[this.thread.x]][this.thread.y];
            if (vertex_to_process === -1) {
                return [-1, -1, -1];
            }

            const edge = this.constants.edge2vertex[this.thread.y];
            const v1_inds = [cubeInds[this.thread.x] + edge[0]];
            const v1_inds = this.thread.x + edge[0] % 4 * (this.field.nx - 1) + Math.floor(edge[0] / 4) * (this.field.nx - 1) * (this.field.ny - 1);
            const v2_index = this.thread.x + edge[1] % 4 * (this.field.nx - 1) + Math.floor(edge[1] / 4) * (this.field.nx - 1) * (this.field.ny - 1);
            const v1_value = field[Math.floor(v1_index / ((this.field.nx - 1) * (this.field.ny - 1)))][Math.floor((v1_index % ((this.field.nx - 1) * (this.field.ny - 1))) / (this.field.nx - 1))][v1_index % (this.field.nx - 1)];
            const v2_value = field[Math.floor(v2_index / ((this.field.nx - 1) * (this.field.ny - 1)))][Math.floor((v2_index % ((this.field.nx - 1) * (this.field.ny - 1))) / (this.field.nx - 1))][v2_index % (this.field.nx - 1)];
            const t = (isoValue - v1_value) / (v2_value - v1_value);
            const vertex_position = [
                this.thread.x + edge[0] % 4 * t + Math.floor(edge[0] / 4) * t,
                this.thread.y + edge[0] % 4 * t + Math.floor(edge[0] / 4) * t,
                this.thread.z + edge[0] % 4 * t + Math.floor(edge[0] / 4) * t
            ];
            return vertex_position;
        })
        .setDynamicOutput(true)
        .setConstants({triTable: triTableInput,
            edge2vertex: edge2vertexInput,
            cubeVertexPos: cubeVertexPosInput,
            max_vertices: 15});
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