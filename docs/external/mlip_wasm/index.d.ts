// Type definitions for mlip.js

export type Backend = 'cpu' | 'webgpu' | 'auto';

export interface CreateOptions {
    /** Which variant to load. Default: 'auto'. */
    backend?: Backend;
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
    forces: Float64Array;
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
}

declare function createMlipcpp(options?: CreateOptions): Promise<MlipcppModule>;

export default createMlipcpp;
export { createMlipcpp };
