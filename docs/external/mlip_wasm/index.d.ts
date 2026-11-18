// Type definitions for mlip.js

export type Backend = 'cpu' | 'webgpu' | 'auto';

export interface CreateOptions {
    /** Which variant to load. Default: 'auto'. */
    backend?: Backend;
    /** Local addition: CPU thread count for the pthreads build ('auto' = the
     *  wasm's default, false = always the single-threaded build). */
    threads?: number | 'auto' | false;
    /** Local addition: URL of the pthreads CPU variant's .wasm file. */
    mtWasmUrl?: string;
    /** URL of the CPU variant's .wasm file (use Vite `?url` import). */
    cpuWasmUrl?: string;
    /** URL of the GPU variant's .wasm file. */
    gpuWasmUrl?: string;
    /** Any additional Emscripten Module options. */
    [key: string]: unknown;
}

export interface Vec3 { x: number; y: number; z: number; }

export interface PredictionResult {
    energy: number;
    /** Flat row-major [fx0,fy0,fz0, ...]. NOTE: at runtime this is actually a
     *  Float32Array (native f32); declared Float64Array here to match upstream's
     *  d.ts and existing consumers — element access is interchangeable. */
    forces: Float64Array;
    /** Voigt [xx, yy, zz, yz, xz, xy], eV/A^3, tension-positive; present for
     *  periodic systems (local compute_stress patch). Runtime: Float32Array. */
    stress?: Float64Array;
}

export interface AtomicSystem {
    numAtoms(): number;
    isPeriodic(): boolean;
    getPositions(): Float64Array;
    getAtomicNumbers(): Int32Array;
    getCell(): Float64Array | null;
    /** embind-owned WASM heap handle; frees the native allocation. */
    delete(): void;
}

export interface AtomicSystemStatic {
    create(
        positions: Float64Array,
        atomicNumbers: Int32Array,
        cell: Float64Array | null,
        periodic: boolean
    ): AtomicSystem;
    fromXyzString(xyzContent: string): AtomicSystem;
}

export interface Model {
    modelType(): string;
    cutoff(): number;
    isLoaded(): boolean;
    predictEnergy(system: AtomicSystem): number;
    predict(system: AtomicSystem): PredictionResult;
    predictWithOptions(system: AtomicSystem, useNcForces: boolean): PredictionResult;
    /** New in 0.1.2: energy + per-node activation capture for visualisation (untyped here; unused by CrysViz). */
    predictWithActivations(system: AtomicSystem): unknown;
    /** embind-owned WASM heap handle; frees the native allocation. */
    delete(): void;
}

export interface ModelStatic {
    load(path: string): Model;
    loadFromBuffer(buffer: ArrayBuffer): Model;
    loadFromBufferWithBackend(buffer: ArrayBuffer, backend: string): Model;
}

export interface MlipcppModule {
    AtomicSystem: AtomicSystemStatic;
    Model: ModelStatic;
    getVersion(): string;
    getBackendName(): string;
    setBackend(name: string): void;
    /** Local additions (CrysViz pthreads patch): CPU threads the ggml graph
     *  runs on. setNumThreads clamps to [1, getMaxThreads()] and returns the
     *  value applied; the single-threaded build reports 1 and ignores it. Must
     *  be set before a model is loaded. */
    getNumThreads(): number;
    getMaxThreads(): number;
    setNumThreads(n: number): number;
    hasThreads(): boolean;
    /** Local additions (CrysViz GEMM patches): the CPU matrix kernel. true =
     *  ggml's blocked tinyBLAS GEMM (with its WebAssembly SIMD path), false =
     *  ggml's dot-product path, as builds before it. From the next prediction;
     *  setBlockedGemm returns the state applied. hasBlockedGemm is false for a
     *  build without the kernel (the getter then reports false). */
    hasBlockedGemm(): boolean;
    getBlockedGemm(): boolean;
    setBlockedGemm(on: boolean): boolean;
    /** Local addition (CrysViz timings patch): where the last prediction
     *  spent its time, in ms — neighbour list + inputs, graph build,
     *  allocation, graph compute, reading the results, total; on the WebGPU
     *  build also encoding + submitting, waiting for the GPU and read-backs. */
    getLastTimings(): {
        inputsMs: number; graphMs: number; allocMs: number; computeMs: number; resultsMs: number; totalMs: number;
        gpuEncodeMs?: number; gpuWaitMs?: number; gpuReadMs?: number; gpuReads?: number;
    };
    /** Local addition: which build index.browser.js loaded. */
    crysvizVariant?: 'cpu' | 'cpu-mt' | 'gpu';
    /** Local addition (CrysViz WebGPU patch), set by the page: the WebGPU
     *  build offers its result reads here first and copies what it returns
     *  into wasm memory (one Uint8Array per read); null declines and the build
     *  maps the buffers itself. Must not return before earlier GPU work is
     *  done. See canvas_readback.js. */
    ggmlWebgpuReadback?: ((device: GPUDevice, reads: { buffer: GPUBuffer; offset: number; size: number }[])
        => Uint8Array[] | null) | null;
    /** Local addition (CrysViz WebGPU patch), diagnostics: when true, every
     *  GPU kernel is submitted and waited for on its own and its time pushed
     *  to ggmlWebgpuOpProfile (three "(wait)" entries first per prediction). */
    ggmlWebgpuProfileOps?: boolean;
    /** Local addition (CrysViz WebGPU patch): 'reg_tile' runs f32 matrix
     *  products with upstream's register-tile kernel instead of the vec4
     *  one (default; README "f32 matrix kernel"). */
    ggmlWebgpuMatmul?: 'tile4' | 'reg_tile';
    ggmlWebgpuOpProfile?: { op: string; name: string; ne: number[]; ms: number }[];
}

declare function createMlipcpp(options?: CreateOptions): Promise<MlipcppModule>;

export default createMlipcpp;
export { createMlipcpp };
