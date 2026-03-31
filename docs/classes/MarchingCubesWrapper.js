// uncomment for GPU-centric marching cubes
import * as GPUMarchCubes from '../external/GPU/marching_cubes.js';
let useGPUMarchCubes = false;

// uncomment for WASM-centric marching cubes
import MarchCubes from '../external/marching_cubes_wasm/MarchCubes.js';
var MarchingCubesModule = await MarchCubes();
let useWASMMarchCubes = false;

// uncomment for Three.js built-in marching cubes
import * as ThreeMarchingCubes from '../external/three/MarchingCubes.js';
let useThreeMarchCubes = false;

class MarchingCubesWrapper {

    /**
     * Create a MarchingCubes instance for the given field and backend.
     * @param {Object} field - The field data containing nx, ny, nz, values, origin, voxel.
     * @param {string} backend - The marching cubes backend to use ("three", "wasm", "gpu").
     */
    constructor(field, backend="javascript") {
        this.field = field;
        
        let backend_MC;
        if (backend === "gpu") {
            backend_MC = new GPUMarchCubes.MarchCubes(field, field.nx, field.ny, field.nz);
            useGPUMarchCubes = true;
            console.log("Using GPU-based Marching Cubes");
        } else if (backend === "wasm") {
            backend_MC = new MarchingCubesModule.MarchingCubes(field.nx, field.ny, field.nz);
            const fieldPtr = backend_MC.getField();
            MarchingCubesModule.HEAPF32.set(field.values, fieldPtr >> 2);
            useWASMMarchCubes = true;
            console.log("Using WASM-based Marching Cubes");
        } else if (backend === "three") {
            backend_MC = new ThreeMarchingCubes.MarchingCubes([field.nx, field.ny, field.nz], false, false, field.nx*field.ny*field.nz);
            backend_MC.field = field.values;
            useThreeMarchCubes = true;
            console.log("Using Three.js built-in Marching Cubes");
        }
        this.marchingCubes = backend_MC;
    }

    getVertices(isoValue) {
        if (useGPUMarchCubes) {
            return this.marchingCubes.getVertices(isoValue);
        }
        else if (useWASMMarchCubes) {
            this.marchingCubes.updateVertices(isoValue);
            const vertexCount = this.marchingCubes.getVertexCount();
            const verticesPtr = this.marchingCubes.getVertices();
            const normalsPtr = this.marchingCubes.getNormals();
            const vertices = new Float32Array(MarchingCubesModule.HEAPF32.buffer, verticesPtr, vertexCount * 3);
            const normals = new Float32Array(MarchingCubesModule.HEAPF32.buffer, normalsPtr, vertexCount * 3);
            return {
                vertices: vertices, 
                normals: normals, 
                vertexCount: vertexCount
            };
        }
        else if (useThreeMarchCubes) {
            this.marchingCubes.isolation = isoValue;
            this.marchingCubes.update();
            const { vertices, normals, vertexCount } = this.marchingCubes.getVertices();
            const verticesArray = vertices.slice(0, vertexCount*3);
            const normalsArray = normals.slice(0, vertexCount*3);
            return {
                vertices: verticesArray,
                normals: normalsArray,
                vertexCount: vertexCount
            };
        }
    }

    delete() {
        if (useGPUMarchCubes) {
            this.marchingCubes.delete();
        }
        else if (useWASMMarchCubes) {
            this.marchingCubes.delete();
        }
        else if (useThreeMarchCubes) {
            // Three.js built-in marching cubes does not require explicit deletion
        }
    }
}

export { MarchingCubesWrapper };