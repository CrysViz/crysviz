/* @ts-self-types="./periodic_wasm.d.ts" */

/**
 * The flat arrays returned to JavaScript.
 * Each atom occupies one slot:
 *   elements[i]         – element index (u32, mirrors the input u32 array)
 *   frac[3*i..3*i+3]    – fractional coordinates
 *   cart[3*i..3*i+3]    – Cartesian coordinates
 *   src_index[i]        – index into original atoms array
 */
export class PeriodicResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PeriodicResult.prototype);
        obj.__wbg_ptr = ptr;
        PeriodicResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PeriodicResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_periodicresult_free(ptr, 0);
    }
    /**
     * @returns {Float64Array}
     */
    cart() {
        const ret = wasm.periodicresult_cart(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    elements() {
        const ret = wasm.periodicresult_elements(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    frac() {
        const ret = wasm.periodicresult_frac(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    len() {
        const ret = wasm.periodicresult_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint32Array}
     */
    src_index() {
        const ret = wasm.periodicresult_src_index(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) PeriodicResult.prototype[Symbol.dispose] = PeriodicResult.prototype.free;

/**
 * Flat arrays describing the accepted polyhedra. One slot per polyhedron in
 * `kinds`/`color_elem`/`center_src`/`vert_counts`; `vertices` and `vertex_srcs`
 * are concatenated per-polyhedron (use `vert_counts` to split them).
 */
export class PolyhedraResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PolyhedraResult.prototype);
        obj.__wbg_ptr = ptr;
        PolyhedraResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PolyhedraResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_polyhedraresult_free(ptr, 0);
    }
    /**
     * @returns {Int32Array}
     */
    center_src() {
        const ret = wasm.polyhedraresult_center_src(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    color_elem() {
        const ret = wasm.polyhedraresult_color_elem(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    count() {
        const ret = wasm.polyhedraresult_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint32Array}
     */
    kinds() {
        const ret = wasm.polyhedraresult_kinds(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    vert_counts() {
        const ret = wasm.polyhedraresult_vert_counts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    vertex_srcs() {
        const ret = wasm.polyhedraresult_vertex_srcs(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    vertices() {
        const ret = wasm.polyhedraresult_vertices(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) PolyhedraResult.prototype[Symbol.dispose] = PolyhedraResult.prototype.free;

/**
 * Compute coordination polyhedra. See `polyhedra::compute_polyhedra` for the
 * argument contract; the JS wrapper (`polyhedraWasm.js`) packs these arrays.
 * @param {Float64Array} frac
 * @param {Uint32Array} elem_idx
 * @param {Float64Array} lattice_flat
 * @param {Float64Array} cutoff_matrix
 * @param {number} n_elem
 * @param {Float64Array} electroneg
 * @param {Float64Array} radii
 * @param {number} max_cutoff
 * @param {boolean} use_chem_filter
 * @param {boolean} detect_cages
 * @param {Uint32Array} center_src
 * @param {Int32Array} center_shift
 * @param {Float64Array} center_cart
 * @param {Int32Array} visible_keys
 * @param {Uint8Array} seed_visible
 * @returns {PolyhedraResult}
 */
export function compute_polyhedra(frac, elem_idx, lattice_flat, cutoff_matrix, n_elem, electroneg, radii, max_cutoff, use_chem_filter, detect_cages, center_src, center_shift, center_cart, visible_keys, seed_visible) {
    const ptr0 = passArrayF64ToWasm0(frac, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(elem_idx, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(lattice_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(cutoff_matrix, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(electroneg, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF64ToWasm0(radii, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray32ToWasm0(center_src, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArray32ToWasm0(center_shift, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArrayF64ToWasm0(center_cart, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ptr9 = passArray32ToWasm0(visible_keys, wasm.__wbindgen_malloc);
    const len9 = WASM_VECTOR_LEN;
    const ptr10 = passArray8ToWasm0(seed_visible, wasm.__wbindgen_malloc);
    const len10 = WASM_VECTOR_LEN;
    const ret = wasm.compute_polyhedra(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, n_elem, ptr4, len4, ptr5, len5, max_cutoff, use_chem_filter, detect_cages, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10);
    return PolyhedraResult.__wrap(ret);
}

/**
 * Rust implementation of `periodicWrapped`.
 *
 * # Arguments
 * * `show_periodic` – if false, return atoms wrapped into unit cell (no ghosts).
 * * `show_pbc_bonds` – if true, append ghost atoms needed for cross-boundary bonds.
 * * `elements_in` – flat u32 array of element indices (length N).
 * * `frac_in`     – flat f64 array of fractional coords (length 3N, row-major).
 * * `lattice_flat`– flat f64 array, row-major 3×3 lattice matrix [a; b; c].
 * * `bond_table`  – flat f64 cutoff matrix, length n_elem × n_elem.
 * * `n_elem`      – number of element species.
 * * `face_tol`    – tolerance (fractional coords) for treating an atom as
 *   sitting on a cell face/edge/corner. Real structures carry small offsets
 *   from 0/1, so this must be looser than machine eps (default ~1e-3).
 * @param {boolean} show_periodic
 * @param {boolean} show_pbc_bonds
 * @param {Uint32Array} elements_in
 * @param {Float64Array} frac_in
 * @param {Float64Array} lattice_flat
 * @param {Float64Array} bond_table
 * @param {number} n_elem
 * @param {number} face_tol
 * @returns {PeriodicResult}
 */
export function periodic_wrapped(show_periodic, show_pbc_bonds, elements_in, frac_in, lattice_flat, bond_table, n_elem, face_tol) {
    const ptr0 = passArray32ToWasm0(elements_in, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(frac_in, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(lattice_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(bond_table, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.periodic_wrapped(show_periodic, show_pbc_bonds, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, n_elem, face_tol);
    return PeriodicResult.__wrap(ret);
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./periodic_wasm_bg.js": import0,
    };
}

const PeriodicResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_periodicresult_free(ptr >>> 0, 1));
const PolyhedraResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_polyhedraresult_free(ptr >>> 0, 1));

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('periodic_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
