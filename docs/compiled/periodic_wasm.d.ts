/* tslint:disable */
/* eslint-disable */

/**
 * Bonding pairs (i, j) with i < j, as two parallel index arrays.
 */
export class BondPairsResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    count(): number;
    i(): Uint32Array;
    j(): Uint32Array;
}

/**
 * Flattened candidate polyhedra for one worker partition (before acceptance). Centred
 * candidates precede cage candidates; `n_centered` records the split so the main thread
 * can regroup all workers' results into serial order. Layout mirrors
 * `polyhedra::CandidateFlat`.
 */
export class CandidateResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    center_shift(): Int32Array;
    center_src(): Int32Array;
    color_elem(): Uint32Array;
    count(): number;
    is_cage(): Uint8Array;
    n_centered(): number;
    ref_point(): Float64Array;
    vert_counts(): Uint32Array;
    vertex_shifts(): Int32Array;
    vertex_srcs(): Uint32Array;
    vertices(): Float64Array;
}

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
 * Flat arrays describing the accepted polyhedra. One slot per polyhedron in
 * `kinds`/`color_elem`/`center_src`/`vert_counts`; `vertices` and `vertex_srcs`
 * are concatenated per-polyhedron (use `vert_counts` to split them).
 */
export class PolyhedraResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    accept_ms(): number;
    bands_built(): number;
    bands_skipped(): number;
    cage_band_ms(): number;
    cage_nloop_ms(): number;
    cage_pool_ms(): number;
    cages_ms(): number;
    center_src(): Int32Array;
    centered_ms(): number;
    color_elem(): Uint32Array;
    count(): number;
    kinds(): Uint32Array;
    setup_ms(): number;
    vert_counts(): Uint32Array;
    vertex_srcs(): Uint32Array;
    vertices(): Float64Array;
}

/**
 * Parallel entry, part 2: accept the merged candidates (already in serial order) on the
 * main thread. Inputs are the concatenated `CandidateResult` arrays. Timing fields are 0.
 */
export function accept_candidates(is_cage: Uint8Array, color_elem: Uint32Array, center_src: Int32Array, center_shift: Int32Array, ref_point: Float64Array, vert_counts: Uint32Array, vertices: Float64Array, vertex_srcs: Uint32Array, vertex_shifts: Int32Array): PolyhedraResult;

/**
 * Find bonding pairs in the wrapped atom set via the shared Cartesian cell list. See
 * `bonds::compute_bond_pairs`; `i_start`/`i_end` allow worker partitioning later (use
 * `0`/`n` for the serial path).
 */
export function compute_bond_pairs(cart: Float64Array, elem_idx: Uint32Array, cutoff_sq: Float64Array, min_cutoff_sq: Float64Array, n_elem: number, min_dist_sq: number, max_cutoff: number, i_start: number, i_end: number): BondPairsResult;

/**
 * Parallel entry, part 1: generate the candidates for centre range
 * `[center_start,center_end)` and seed range `[seed_start,seed_end)`. Runs in a worker.
 */
export function compute_candidates(frac: Float64Array, elem_idx: Uint32Array, lattice_flat: Float64Array, cutoff_matrix: Float64Array, n_elem: number, electroneg: Float64Array, radii: Float64Array, max_cutoff: number, use_chem_filter: boolean, detect_cages: boolean, center_src: Uint32Array, center_shift: Int32Array, center_cart: Float64Array, visible_keys: Int32Array, seed_visible: Uint8Array, center_start: number, center_end: number, seed_start: number, seed_end: number): CandidateResult;

/**
 * Compute coordination polyhedra. See `polyhedra::compute_polyhedra` for the
 * argument contract; the JS wrapper (`polyhedraWasm.js`) packs these arrays.
 */
export function compute_polyhedra(frac: Float64Array, elem_idx: Uint32Array, lattice_flat: Float64Array, cutoff_matrix: Float64Array, n_elem: number, electroneg: Float64Array, radii: Float64Array, max_cutoff: number, use_chem_filter: boolean, detect_cages: boolean, center_src: Uint32Array, center_shift: Int32Array, center_cart: Float64Array, visible_keys: Int32Array, seed_visible: Uint8Array): PolyhedraResult;

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
 */
export function periodic_wrapped(show_periodic: boolean, show_pbc_bonds: boolean, elements_in: Uint32Array, frac_in: Float64Array, lattice_flat: Float64Array, bond_table: Float64Array, n_elem: number, face_tol: number): PeriodicResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_bondpairsresult_free: (a: number, b: number) => void;
    readonly __wbg_candidateresult_free: (a: number, b: number) => void;
    readonly __wbg_periodicresult_free: (a: number, b: number) => void;
    readonly __wbg_polyhedraresult_free: (a: number, b: number) => void;
    readonly accept_candidates: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => number;
    readonly bondpairsresult_count: (a: number) => number;
    readonly bondpairsresult_i: (a: number) => [number, number];
    readonly bondpairsresult_j: (a: number) => [number, number];
    readonly candidateresult_center_shift: (a: number) => [number, number];
    readonly candidateresult_center_src: (a: number) => [number, number];
    readonly candidateresult_color_elem: (a: number) => [number, number];
    readonly candidateresult_count: (a: number) => number;
    readonly candidateresult_is_cage: (a: number) => [number, number];
    readonly candidateresult_n_centered: (a: number) => number;
    readonly candidateresult_ref_point: (a: number) => [number, number];
    readonly candidateresult_vert_counts: (a: number) => [number, number];
    readonly candidateresult_vertex_shifts: (a: number) => [number, number];
    readonly candidateresult_vertex_srcs: (a: number) => [number, number];
    readonly candidateresult_vertices: (a: number) => [number, number];
    readonly compute_bond_pairs: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => number;
    readonly compute_candidates: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number) => number;
    readonly compute_polyhedra: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => number;
    readonly periodic_wrapped: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => number;
    readonly periodicresult_cart: (a: number) => [number, number];
    readonly periodicresult_elements: (a: number) => [number, number];
    readonly periodicresult_frac: (a: number) => [number, number];
    readonly periodicresult_src_index: (a: number) => [number, number];
    readonly polyhedraresult_accept_ms: (a: number) => number;
    readonly polyhedraresult_bands_built: (a: number) => number;
    readonly polyhedraresult_bands_skipped: (a: number) => number;
    readonly polyhedraresult_cage_band_ms: (a: number) => number;
    readonly polyhedraresult_cage_nloop_ms: (a: number) => number;
    readonly polyhedraresult_cage_pool_ms: (a: number) => number;
    readonly polyhedraresult_cages_ms: (a: number) => number;
    readonly polyhedraresult_center_src: (a: number) => [number, number];
    readonly polyhedraresult_centered_ms: (a: number) => number;
    readonly polyhedraresult_color_elem: (a: number) => [number, number];
    readonly polyhedraresult_count: (a: number) => number;
    readonly polyhedraresult_kinds: (a: number) => [number, number];
    readonly polyhedraresult_setup_ms: (a: number) => number;
    readonly polyhedraresult_vert_counts: (a: number) => [number, number];
    readonly polyhedraresult_vertex_srcs: (a: number) => [number, number];
    readonly polyhedraresult_vertices: (a: number) => [number, number];
    readonly periodicresult_len: (a: number) => number;
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
