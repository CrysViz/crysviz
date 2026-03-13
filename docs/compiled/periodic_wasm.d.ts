/* tslint:disable */
/* eslint-disable */

/**
 * The flat arrays returned to JavaScript.
 * Each atom occupies one slot:
 *   elements[i]         – element index (u32, mirrors the input u32 array)
 *   frac[3*i..3*i+3]    – fractional coordinates
 *   cart[3*i..3*i+3]    – Cartesian coordinates
 *   src_index[i]        – index into original atoms array
 */
export class PeriodicResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cart(): Float64Array;
    elements(): Uint32Array;
    frac(): Float64Array;
    len(): number;
    src_index(): Uint32Array;
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
 */
export function periodic_wrapped(show_periodic: boolean, show_pbc_bonds: boolean, elements_in: Uint32Array, frac_in: Float64Array, lattice_flat: Float64Array, bond_table: Float64Array, n_elem: number): PeriodicResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_periodicresult_free: (a: number, b: number) => void;
    readonly periodic_wrapped: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly periodicresult_cart: (a: number) => [number, number];
    readonly periodicresult_elements: (a: number) => [number, number];
    readonly periodicresult_frac: (a: number) => [number, number];
    readonly periodicresult_len: (a: number) => number;
    readonly periodicresult_src_index: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
