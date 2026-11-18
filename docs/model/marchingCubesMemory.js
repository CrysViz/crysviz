// marchingCubesMemory.js
// Keeps the WASM marching-cubes module (compiled/MarchCubes.js) inside its
// 4 GiB address space.
//
// Every MarchingCubes instance preallocates its output for the worst case on
// its grid: MC_BYTES_PER_POINT bytes per grid point (see marchingCubesBytes()
// in compiled/marching_cubes.cpp for the breakdown). A fine grid -- the
// 300x300x324 CHGCAR of a 575-atom SiC supercell is ~3.7 GiB of that -- leaves
// nothing for the mesh copies, the camera sort, or a second field, and before
// the per-point cost was trimmed it asked for more than wasm32 can address at
// all, which aborts the module.
//
// So before a field is handed to the module, planMarchingCubesGrid() checks
// the estimate against a budget and, when it is over, picks the largest grid
// with the same aspect that fits. fillByResampling() then fills that coarser
// grid by trilinear interpolation, feeding the source to WASM a few z-planes
// at a time: the full-resolution field never enters the module's memory, so
// it can be larger than the module's whole address space.
//
// Exports: MC_WASM_MEMORY_BYTES, MC_BYTES_PER_POINT, MC_INSTANCE_BUDGET_BYTES,
//   MC_TOTAL_BUDGET_BYTES, MC_MIN_BUDGET_BYTES, MC_SLAB_BYTES,
//   marchingCubesGridBytes(), marchingCubesBudget(), planMarchingCubesGrid(),
//   fillByResampling(), createMarchingCubesInstance()

const GiB = 2 ** 30;
const MiB = 2 ** 20;

/** wasm32 address space; the module is built with MAXIMUM_MEMORY=4GB. */
export const MC_WASM_MEMORY_BYTES = 4 * GiB;

/** Must match FLOATS_PER_POINT * 4 in compiled/marching_cubes.cpp (field +
 *  normal cache + vertex and normal lists); a unit test checks the two agree. */
export const MC_BYTES_PER_POINT = 136;

/** Most one instance may preallocate. Leaves half the address space for the
 *  mesh copies and camera sort (which malloc in the same heap), the resample
 *  slab, and heap fragmentation. */
export const MC_INSTANCE_BUDGET_BYTES = 2 * GiB;

/** Most all live instances together may hold, so a second large field is
 *  downsampled further instead of taking the module past its limit. */
export const MC_TOTAL_BUDGET_BYTES = 3 * GiB;

/** Floor for an instance's budget however full the module is (~1.9M points,
 *  a 124^3 grid): a field always gets a surface, if a coarse one. */
export const MC_MIN_BUDGET_BYTES = 256 * MiB;

/** Size of the source chunk copied into WASM per resampling step. */
export const MC_SLAB_BYTES = 64 * MiB;

/** Bytes an instance preallocates for an nx*ny*nz grid. */
export function marchingCubesGridBytes(nx, ny, nz) {
    return nx * ny * nz * MC_BYTES_PER_POINT;
}

/**
 * Budget for a new instance given what live instances already hold.
 * @param {number} [liveBytes]
 */
export function marchingCubesBudget(liveBytes = 0) {
    const left = MC_TOTAL_BUDGET_BYTES - liveBytes;
    return Math.max(MC_MIN_BUDGET_BYTES, Math.min(MC_INSTANCE_BUDGET_BYTES, left));
}

/**
 * The grid the marching cubes should run on: the field's own grid when it fits
 * `budgetBytes`, otherwise the largest grid with (close to) the same aspect
 * that does. Axes are never enlarged and never drop below 2 points.
 *
 * @param {{nx:number, ny:number, nz:number}} grid
 * @param {number} [budgetBytes]
 * @returns {{nx:number, ny:number, nz:number, bytes:number, downsampled:boolean}}
 */
export function planMarchingCubesGrid({ nx, ny, nz }, budgetBytes = MC_INSTANCE_BUDGET_BYTES) {
    const bytes = marchingCubesGridBytes(nx, ny, nz);
    if (bytes <= budgetBytes) return { nx, ny, nz, bytes, downsampled: false };

    const scale = Math.cbrt(budgetBytes / bytes);
    const dims = [nx, ny, nz].map((n) => Math.max(2, Math.min(n, Math.floor(n * scale))));
    // floor() per axis normally lands under budget already; trim the largest
    // axis until it does (covers axes held at the 2-point floor).
    while (marchingCubesGridBytes(dims[0], dims[1], dims[2]) > budgetBytes) {
        let a = 0;
        for (let i = 1; i < 3; i++) if (dims[i] > dims[a]) a = i;
        if (dims[a] <= 2) break;
        dims[a]--;
    }
    return {
        nx: dims[0], ny: dims[1], nz: dims[2],
        bytes: marchingCubesGridBytes(dims[0], dims[1], dims[2]),
        downsampled: true,
    };
}

/**
 * Fill `instance`'s field (dims `dst`) by trilinear interpolation of `values`
 * (dims `src`, x fastest), copying the source into WASM one z-slab at a time.
 * Slabs overlap by one plane so every target plane has both its source planes
 * in some slab (see MarchingCubes::resample_slab).
 *
 * @param {any} module MarchCubes module
 * @param {any} instance MarchingCubes instance allocated at `dst`
 * @param {ArrayLike<number> & {subarray?: Function, slice?: Function}} values
 * @param {{nx:number, ny:number, nz:number}} src
 * @param {number} [slabBytes]
 */
export function fillByResampling(module, instance, values, src, slabBytes = MC_SLAB_BYTES) {
    const planeLen = src.nx * src.ny;
    const planes = Math.min(src.nz, Math.max(2, Math.floor(slabBytes / (planeLen * 4))));
    const ptr = module.mallocFloatArray(planes * planeLen);
    if (!ptr) throw new Error('marching cubes: no memory for the resampling slab');
    const cut = typeof values.subarray === 'function'
        ? (a, b) => values.subarray(a, b)
        : (a, b) => Array.prototype.slice.call(values, a, b);
    try {
        for (let z0 = 0; ; z0 += planes - 1) {
            const count = Math.min(planes, src.nz - z0);
            // HEAPF32 is re-read each step: a heap growth replaces the view.
            module.HEAPF32.set(cut(z0 * planeLen, (z0 + count) * planeLen), ptr >>> 2);
            instance.resampleSlab(ptr, src.nx, src.ny, src.nz, z0, count);
            if (z0 + count >= src.nz) break;
        }
    } finally {
        module.freeArray(ptr);
    }
}

/**
 * Build a MarchingCubes instance for `field` that fits the memory budget,
 * downsampling the field when it would not. If the allocation still fails
 * (a fragmented heap), the budget is halved and it tries again, down to
 * MC_MIN_BUDGET_BYTES.
 *
 * @param {any} module MarchCubes module
 * @param {{nx:number, ny:number, nz:number, values:any}} field
 * @param {number} [budgetBytes]
 * @returns {{instance:any, grid:{nx:number, ny:number, nz:number, bytes:number, downsampled:boolean}}}
 */
export function createMarchingCubesInstance(module, field, budgetBytes = MC_INSTANCE_BUDGET_BYTES) {
    let budget = budgetBytes;
    for (;;) {
        const grid = planMarchingCubesGrid(field, budget);
        const instance = new module.MarchingCubes(grid.nx, grid.ny, grid.nz);
        if (instance.isAllocated()) {
            try {
                if (grid.downsampled) {
                    fillByResampling(module, instance, field.values, field);
                } else {
                    module.HEAPF32.set(field.values, instance.getField() >>> 2);
                }
            } catch (err) {
                instance.delete();
                throw err;
            }
            return { instance, grid };
        }
        instance.delete();
        if (budget <= MC_MIN_BUDGET_BYTES) {
            throw new Error(`marching cubes: cannot allocate ${grid.nx}x${grid.ny}x${grid.nz} grid`);
        }
        budget = Math.max(MC_MIN_BUDGET_BYTES, Math.floor(budget / 2));
    }
}
