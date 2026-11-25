// uncomment for GPU-centric marching cubes
//import * as GPUMarchCubes from '../external/GPU/marching_cubes.js';

// uncomment for WASM-centric marching cubes
import MarchCubes from '../compiled/MarchCubes.js';
var MarchingCubesModule = await MarchCubes();

// uncomment for Three.js built-in marching cubes
import * as ThreeMarchingCubes from './JSMarchingCubes.js';
import { createMarchingCubesInstance, marchingCubesBudget, resampleGridValues } from './marchingCubesMemory.js';

// Bytes the live WASM instances have preallocated, all in the module's one
// 4 GiB heap; a new instance is budgeted against what is left.
let liveWasmBytes = 0;

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
        /** Grid the WASM backend runs on; coarser than the field's when the
         *  field would not fit the module's memory (model/marchingCubesMemory.js).
         *  @type {{nx:number, ny:number, nz:number, bytes:number, downsampled:boolean} | null} */
        this.grid = null;
        if (backend === MarchingCubesBackend.WASM) {
            const { instance, grid } = createMarchingCubesInstance(
                MarchingCubesModule, field, marchingCubesBudget(liveWasmBytes));
            backend_MC = instance;
            this.grid = grid;
            liveWasmBytes += grid.bytes;
            if (grid.downsampled) {
                console.warn(`Marching cubes: ${field.nx}x${field.ny}x${field.nz} field resampled to `
                    + `${grid.nx}x${grid.ny}x${grid.nz} to fit WASM memory`);
            }
            // Field.maskValue: cubes touching a point at or above it are not
            // meshed (the NCI s field marks points outside its density window
            // this way). The THREE backend has no equivalent and ignores it.
            if (Number.isFinite(field.maskValue)) backend_MC.setMaskValue(field.maskValue);
            console.log("Using WASM-based Marching Cubes");
        } else if (backend === MarchingCubesBackend.THREE) {
            backend_MC = new ThreeMarchingCubes.MarchingCubes([field.nx, field.ny, field.nz], false, false, field.nx*field.ny*field.nz);
            /** @type {any} */ (backend_MC).field = field.values;
            console.log("Using Three.js built-in Marching Cubes");
        }
        this.marchingCubes = backend_MC;
        /** Values array last copied into the WASM colour buffer (identity
         *  check, so an unchanged colour field is not re-copied on every
         *  isovalue drag). Null while no colour field is set.
         *  @type {ArrayLike<number> | null} */
        this._colorValues = null;
    }

    /**
     * Set (or clear, with null) the secondary field whose values are
     * interpolated onto every isosurface vertex — see Field.colorBy and
     * model/Isosurface.js. The colour field must share this field's grid;
     * a mismatched one is refused (returns false) and colouring is cleared.
     *
     * WASM: the values are copied into the module's colour buffer (allocated
     * on first use, freed again on clear). THREE/JS backend: not supported,
     * getVertices() simply reports no values (flat colour).
     *
     * @param {{nx:number, ny:number, nz:number, values: ArrayLike<number>} | null} colorField
     * @param {boolean} [force] re-copy even if the values array is the same object
     *   (for a field whose values were rewritten in place)
     * @returns {boolean} whether per-vertex values will be produced
     */
    setColorField(colorField, force = false) {
        const field = this.field;
        const usable = Boolean(colorField?.values)
            && colorField.nx === field.nx && colorField.ny === field.ny && colorField.nz === field.nz
            && colorField.values.length >= field.nx * field.ny * field.nz;
        if (this.backend !== MarchingCubesBackend.WASM) {
            this._colorValues = usable ? colorField.values : null;
            return false;
        }
        if (!usable) {
            if (this._colorValues) this.marchingCubes.setColorFieldEnabled(false);
            this._colorValues = null;
            return false;
        }
        if (!force && this._colorValues === colorField.values) return true;
        this.marchingCubes.setColorFieldEnabled(true);
        if (!this.marchingCubes.getColorFieldEnabled()) {
            // the module could not allocate the colour buffers
            this._colorValues = null;
            return false;
        }
        const ptr = this.marchingCubes.getColorField();
        const size = field.nx * field.ny * field.nz;
        let src = colorField.values.length === size
            ? colorField.values
            : /** @type {any} */ (colorField.values).subarray(0, size);
        // A field too large for the module runs on a coarser grid
        // (this.grid.downsampled); the colour field must follow it there.
        if (this.grid?.downsampled) src = resampleGridValues(src, field, this.grid);
        MarchingCubesModule.HEAPF32.set(src, ptr >> 2);
        this._colorValues = colorField.values;
        return true;
    }

    /** Per-vertex colour-field values of the last updateMesh(), or null when
     *  no colour field is set (or the backend cannot produce them). */
    _readVertexValues(vertexCount) {
        if (this.backend !== MarchingCubesBackend.WASM || !this._colorValues) return null;
        const ptr = this.marchingCubes.getVertexValues();
        if (!ptr) return null;
        return new Float32Array(MarchingCubesModule.HEAPF32.buffer, ptr, vertexCount).slice();
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
            if (this.marchingCubes.isTruncated()) {
                console.warn('Marching cubes: vertex buffer full, isosurface truncated');
            }
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
                values: this._readVertexValues(vertexCount),
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
                values: null,
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
            if (!this.marchingCubes) return;
            this.marchingCubes.delete();
            this.marchingCubes = null;
            liveWasmBytes = Math.max(0, liveWasmBytes - (this.grid?.bytes ?? 0));
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
     * with the same permutation. Extra array stride is inferred as
     * array.length / vertexCount (1..4: values, uv, normals, RGBA colours);
     * an array whose length is not a whole multiple is skipped.
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
            MarchingCubesModule.HEAPF32.set(primaryArray, arrayPtr >>> 2);
            const permutationPtr = MarchingCubesModule.mallocUIntArray(triangleCount);

            MarchingCubesModule.buildTriangleDistancePermutation(arrayPtr, vertexCount, cameraPosition.x, cameraPosition.y, cameraPosition.z, permutationPtr);
            MarchingCubesModule.reorderArrayByPermutation(arrayPtr, vertexCount, 3, permutationPtr);
            for (const array of extraArrays) {
                if (!array) continue;

                const itemSize = array.length / vertexCount;
                if (!Number.isInteger(itemSize) || itemSize < 1 || itemSize > 4) continue;

                const extraArrayPtr = MarchingCubesModule.mallocFloatArray(array.length);
                MarchingCubesModule.HEAPF32.set(array, extraArrayPtr >>> 2);
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
                if (Number.isInteger(itemSize) && itemSize >= 1 && itemSize <= 4) {
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
            return { vertices, normals, values: this._readVertexValues(vertexCount), vertexCount };
        }
        else if (backend === MarchingCubesBackend.THREE) {
            const { vertices, normals, vertexCount } = this.marchingCubes.getVertices();
            return {
                vertices: vertices.slice(0, vertexCount * 3),
                normals:  normals.slice(0, vertexCount * 3),
                values: null,
                vertexCount
            };
        }
    }
}

export { MarchingCubesBackend, MarchingCubesWrapper };