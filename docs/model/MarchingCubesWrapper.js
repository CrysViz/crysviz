// uncomment for GPU-centric marching cubes
//import * as GPUMarchCubes from '../external/GPU/marching_cubes.js';

// uncomment for WASM-centric marching cubes
import MarchCubes from '../compiled/MarchCubes.js';
var MarchingCubesModule = await MarchCubes();

// uncomment for Three.js built-in marching cubes
import * as ThreeMarchingCubes from './JSMarchingCubes.js';

const MarchingCubesBackend = Object.freeze({
    THREE: 'three',
    WASM: 'wasm'
});


function buildTriangleDistancePermutation(positions, point) {
    if (!positions || !point) return [];

    const triangleCount = Math.floor(positions.length / 9);
    if (triangleCount <= 1) return triangleCount === 1 ? [0] : [];

    const triangleDistances = new Array(triangleCount);
    for (let i = 0; i < triangleCount; i++) {
        const base = i * 9;
        const centerX = (positions[base] + positions[base + 3] + positions[base + 6]) / 3;
        const centerY = (positions[base + 1] + positions[base + 4] + positions[base + 7]) / 3;
        const centerZ = (positions[base + 2] + positions[base + 5] + positions[base + 8]) / 3;
        const dx = centerX - point.x;
        const dy = centerY - point.y;
        const dz = centerZ - point.z;
        triangleDistances[i] = { index: i, distanceSq: dx * dx + dy * dy + dz * dz };
    }

    triangleDistances.sort((a, b) => b.distanceSq - a.distanceSq);

    const permutation = new Array(triangleCount);
    for (let i = 0; i < triangleCount; i++) {
        permutation[i] = triangleDistances[i].index;
    }
    return permutation;
}

function reorderTriangleArrayByPermutation(array, permutation, itemSize) {
    if (!array || !permutation || permutation.length <= 1) return array;

    const triangleCount = permutation.length;
    const triangleStride = itemSize * 3;
    const expectedLength = triangleCount * triangleStride;
    if (array.length < expectedLength) return array;

    const temp = ArrayBuffer.isView(array) ? new (/** @type {any} */ (array.constructor))(array) : array.slice();
    for (let i = 0; i < triangleCount; i++) {
        const srcBase = permutation[i] * triangleStride;
        const dstBase = i * triangleStride;
        for (let j = 0; j < triangleStride; j++) {
            array[dstBase + j] = temp[srcBase + j];
        }
    }

    return array;
}

class MarchingCubesWrapper {

    /**
     * Create a MarchingCubes instance for the given field and backend.
     * @param {Object} field - The field data containing nx, ny, nz, values, origin, voxel.
     * @param {string} backend - The marching cubes backend to use.
     */
    constructor(field, backend = MarchingCubesBackend.WASM) {
        this.field = field;
        this.backend = backend;
        
        let backend_MC;
        // if (backend === "gpu") {
        //     backend_MC = new GPUMarchCubes.MarchCubes(field, field.nx, field.ny, field.nz);
        //     console.log("Using GPU-based Marching Cubes");
        // } 
        if (backend === MarchingCubesBackend.WASM) {
            backend_MC = new MarchingCubesModule.MarchingCubes(field.nx, field.ny, field.nz);
            const fieldPtr = backend_MC.getField();
            MarchingCubesModule.HEAPF32.set(field.values, fieldPtr >> 2);
            console.log("Using WASM-based Marching Cubes");
        } else if (backend === MarchingCubesBackend.THREE) {
            backend_MC = new ThreeMarchingCubes.MarchingCubes([field.nx, field.ny, field.nz], false, false, field.nx*field.ny*field.nz);
            /** @type {any} */ (backend_MC).field = field.values;
            console.log("Using Three.js built-in Marching Cubes");
        }
        this.marchingCubes = backend_MC;
    }

    /**
     * A starting isosurface level: the magnitude exceeded by `fraction` of the
     * grid points. The field is already in this module's memory, so the WASM
     * backend answers from a single pass over it with no copy and no sort.
     *
     * @param {number} [fraction] target fraction of the cell inside the surface
     * @returns {number | null} null when the backend cannot compute it, so the
     *   caller can fall back to model/CompositeField.js defaultIsoValue()
     */
    defaultIsoValue(fraction = 0.05) {
        if (this.backend !== MarchingCubesBackend.WASM) return null;
        const level = this.marchingCubes.defaultIsoValue(fraction);
        return Number.isFinite(level) && level > 0 ? level : null;
    }

    updateMesh(isoValue) {
        const backend = this.backend;
        if (backend === MarchingCubesBackend.WASM) {
            this.marchingCubes.updateVertices(isoValue);
        }
        else if (backend === MarchingCubesBackend.THREE) {
            this.marchingCubes.isolation = isoValue;
            this.marchingCubes.update();
        }
    }

    getVertices() {
        // if (this.backend === "gpu") {
        //     return this.marchingCubes.getVertices(isoValue);
        // }
        const backend = this.backend;
        if (backend === MarchingCubesBackend.WASM) {
            const vertexCount = this.marchingCubes.getVertexCount();
            const verticesPtr = this.marchingCubes.getVertices();
            const normalsPtr = this.marchingCubes.getNormals();
            const vertices = new Float32Array(MarchingCubesModule.HEAPF32.buffer, verticesPtr, vertexCount * 3).slice();
            const normals = new Float32Array(MarchingCubesModule.HEAPF32.buffer, normalsPtr, vertexCount * 3).slice();
            return {
                vertices: vertices, 
                normals: normals, 
                vertexCount: vertexCount
            };
        }
        else if (backend === MarchingCubesBackend.THREE) {
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
        // if (this.backend === "gpu") {
        //     this.marchingCubes.delete();
        // }
        const backend = this.backend;
        if (backend === MarchingCubesBackend.WASM) {
            this.marchingCubes.delete();
        }
        else if (backend === MarchingCubesBackend.THREE) {
            // Three.js built-in marching cubes does not require explicit deletion
        }
    }

    /**
     * Sorts arrays by camera distance using the vertex order derived from `primaryArray`.
     *
     * Signature:
     * sortVerticesToCamera(cameraPosition, primaryArray, ...extraArrays)
     *
     * `primaryArray` must be xyz triplets (stride 3). Each `extraArray` is reordered
     * with the same permutation. Extra array stride is inferred as:
     * - 3 when array length is vertexCount * 3
     * - 2 when array length is vertexCount * 2
     * - otherwise it is skipped.
     */
    sortVerticesToCamera(cameraPosition, primaryArray, ...extraArrays) {
        // if (this.backend === "gpu") {
        //     this.marchingCubes.sortVerticesToCamera(cameraPosition);
        // }
        const backend = this.backend;
        if (backend === MarchingCubesBackend.WASM) {
            const vertexCount = primaryArray.length / 3;
            const triangleCount = Math.floor(vertexCount / 3);

            if (triangleCount <= 1) {
                return [primaryArray, ...extraArrays];
            }

            const arrayPtr = MarchingCubesModule.mallocFloatArray(primaryArray.length);
            MarchingCubesModule.HEAPF32.set(primaryArray, arrayPtr >> 2);
            const permutationPtr = MarchingCubesModule.mallocUIntArray(triangleCount);

            MarchingCubesModule.buildTriangleDistancePermutation(arrayPtr, vertexCount, cameraPosition.x, cameraPosition.y, cameraPosition.z, permutationPtr);
            MarchingCubesModule.reorderArrayByPermutation(arrayPtr, vertexCount, 3, permutationPtr);
            for (const array of extraArrays) {
                if (!array) continue;

                const itemSize = 3;

                const extraArrayPtr = MarchingCubesModule.mallocFloatArray(array.length);
                MarchingCubesModule.HEAPF32.set(array, extraArrayPtr >> 2);
                MarchingCubesModule.reorderArrayByPermutation(extraArrayPtr, vertexCount, itemSize, permutationPtr);
                const sortedExtra = new array.constructor(MarchingCubesModule.HEAPF32.buffer, extraArrayPtr, array.length).slice();
                array.set(sortedExtra);
                MarchingCubesModule.freeArray(extraArrayPtr);
            }
            const sortedPrimary = new primaryArray.constructor(MarchingCubesModule.HEAPF32.buffer, arrayPtr, primaryArray.length).slice();
            primaryArray.set(sortedPrimary);
            MarchingCubesModule.freeArray(arrayPtr);
            MarchingCubesModule.freeArray(permutationPtr);
        }
        else if (backend === MarchingCubesBackend.THREE) {
            const permutation = buildTriangleDistancePermutation(primaryArray, cameraPosition);
            for (const array of [primaryArray, ...extraArrays]) {
                if (!array) continue;

                const itemSize = array.length / (permutation.length * 3);
                if (itemSize === 3 || itemSize === 2) {
                    reorderTriangleArrayByPermutation(array, permutation, itemSize);
                }
            }
        }

        return [primaryArray, ...extraArrays];
    }

    /**
     * Returns the currently computed vertex/normal arrays without re-running marching cubes.
     */
    getCurrentVertices() {
        const backend = this.backend;
        if (backend === MarchingCubesBackend.WASM) {
            const vertexCount = this.marchingCubes.getVertexCount();
            const verticesPtr = this.marchingCubes.getVertices();
            const normalsPtr  = this.marchingCubes.getNormals();
            const vertices = new Float32Array(MarchingCubesModule.HEAPF32.buffer, verticesPtr, vertexCount * 3).slice();
            const normals  = new Float32Array(MarchingCubesModule.HEAPF32.buffer, normalsPtr,  vertexCount * 3).slice();
            return { vertices, normals, vertexCount };
        }
        else if (backend === MarchingCubesBackend.THREE) {
            const { vertices, normals, vertexCount } = this.marchingCubes.getVertices();
            return {
                vertices: vertices.slice(0, vertexCount * 3),
                normals:  normals.slice(0, vertexCount * 3),
                vertexCount
            };
        }
    }
}

export { MarchingCubesBackend, MarchingCubesWrapper };