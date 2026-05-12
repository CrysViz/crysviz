// uncomment for GPU-centric marching cubes
//import * as GPUMarchCubes from '../external/GPU/marching_cubes.js';
let useGPUMarchCubes = false;

// uncomment for WASM-centric marching cubes
import MarchCubes from '../external/marching_cubes_wasm/MarchCubes.js';
var MarchingCubesModule = await MarchCubes();
let useWASMMarchCubes = false;

// uncomment for Three.js built-in marching cubes
import * as ThreeMarchingCubes from './JSMarchingCubes.js';
let useThreeMarchCubes = false;

const MarchingCubesBackend = Object.freeze({
    THREE: 'three',
    WASM: 'wasm'
});

function reorderArrayByPermutation(array, permutation, stride) {
    if (!array || !permutation || permutation.length <= 1) return array;

    const vertexCount = permutation.length;
    const expectedLength = vertexCount * stride;
    if (array.length < expectedLength) return array;

    const temp = ArrayBuffer.isView(array) ? new array.constructor(array) : array.slice();
    for (let i = 0; i < vertexCount; i++) {
        const srcBase = permutation[i] * stride;
        const dstBase = i * stride;
        for (let j = 0; j < stride; j++) {
            array[dstBase + j] = temp[srcBase + j];
        }
    }

    return array;
}

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

    const temp = ArrayBuffer.isView(array) ? new array.constructor(array) : array.slice();
    for (let i = 0; i < triangleCount; i++) {
        const srcBase = permutation[i] * triangleStride;
        const dstBase = i * triangleStride;
        for (let j = 0; j < triangleStride; j++) {
            array[dstBase + j] = temp[srcBase + j];
        }
    }

    return array;
}

/**
 * Sorts a flat position buffer by distance to a target point.
 *
 * The input `positions` is expected to be laid out as xyz triplets:
 * `[x0, y0, z0, x1, y1, z1, ...]`.
 *
 * Distances are computed from each vertex to `point` using Euclidean distance
 * (squared distance is sufficient for ordering). The default order is
 * ascending, so vertices closest to `point` appear first.
 *
 * Reorders the given `positions` array in-place and returns it.
 *
 * @param {Float32Array|number[]} positions - Flat xyz vertex array.
 * @param {{x:number, y:number, z:number}} point - Reference point.
 * @returns {Float32Array|number[]} The same `positions` array instance, sorted in-place.
 */
function sortPositionsToPoint(positions, point) {
    const permutation = buildDistancePermutation(positions, point);
    return reorderArrayByPermutation(positions, permutation, 3);
}

class MarchingCubesWrapper {

    /**
     * Create a MarchingCubes instance for the given field and backend.
     * @param {Object} field - The field data containing nx, ny, nz, values, origin, voxel.
     * @param {string} backend - The marching cubes backend to use.
     */
    constructor(field, backend = MarchingCubesBackend.WASM) {
        this.field = field;
        
        let backend_MC;
        // if (backend === "gpu") {
        //     backend_MC = new GPUMarchCubes.MarchCubes(field, field.nx, field.ny, field.nz);
        //     useGPUMarchCubes = true;
        //     console.log("Using GPU-based Marching Cubes");
        // } 
        if (backend === MarchingCubesBackend.WASM) {
            backend_MC = new MarchingCubesModule.MarchingCubes(field.nx, field.ny, field.nz);
            const fieldPtr = backend_MC.getField();
            MarchingCubesModule.HEAPF32.set(field.values, fieldPtr >> 2);
            useWASMMarchCubes = true;
            console.log("Using WASM-based Marching Cubes");
        } else if (backend === MarchingCubesBackend.THREE) {
            backend_MC = new ThreeMarchingCubes.MarchingCubes([field.nx, field.ny, field.nz], false, false, field.nx*field.ny*field.nz);
            backend_MC.field = field.values;
            useThreeMarchCubes = true;
            console.log("Using Three.js built-in Marching Cubes");
        }
        this.marchingCubes = backend_MC;
    }

    updateMesh(isoValue) {
        if (useWASMMarchCubes) {
            this.marchingCubes.updateVertices(isoValue);
        }
        else if (useThreeMarchCubes) {
            this.marchingCubes.isolation = isoValue;
            this.marchingCubes.update();
        }
    }

    getVertices() {
        // if (useGPUMarchCubes) {
        //     return this.marchingCubes.getVertices(isoValue);
        // }
        if (useWASMMarchCubes) {
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
        else if (useThreeMarchCubes) {
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
        // if (useGPUMarchCubes) {
        //     this.marchingCubes.delete();
        // }
        if (useWASMMarchCubes) {
            this.marchingCubes.delete();
        }
        else if (useThreeMarchCubes) {
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
        // if (useGPUMarchCubes) {
        //     this.marchingCubes.sortVerticesToCamera(cameraPosition);
        // }
        if (useWASMMarchCubes) {
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
        else if (useThreeMarchCubes) {
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
        if (useWASMMarchCubes) {
            const vertexCount = this.marchingCubes.getVertexCount();
            const verticesPtr = this.marchingCubes.getVertices();
            const normalsPtr  = this.marchingCubes.getNormals();
            const vertices = new Float32Array(MarchingCubesModule.HEAPF32.buffer, verticesPtr, vertexCount * 3).slice();
            const normals  = new Float32Array(MarchingCubesModule.HEAPF32.buffer, normalsPtr,  vertexCount * 3).slice();
            return { vertices, normals, vertexCount };
        }
        else if (useThreeMarchCubes) {
            const { vertices, normals, vertexCount } = this.marchingCubes.getVertices();
            return {
                vertices: vertices.slice(0, vertexCount * 3),
                normals:  normals.slice(0, vertexCount * 3),
                vertexCount
            };
        }
    }
}

export { MarchingCubesBackend, MarchingCubesWrapper, sortPositionsToPoint };