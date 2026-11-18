// mlip.js — browser entry with variant-aware loader.
//
// Usage in a bundler (Vite / webpack / Rollup):
//   import createMlipcpp from '@peterspackman/mlip.js'
//   import cpuWasmUrl from '@peterspackman/mlip.js/cpu-wasm?url'
//   import gpuWasmUrl from '@peterspackman/mlip.js/gpu-wasm?url'  // optional
//   const mod = await createMlipcpp({ backend: 'auto', cpuWasmUrl, gpuWasmUrl })
//
// `backend`: 'cpu' | 'webgpu' | 'auto' (default 'auto').
//   - 'cpu'   → always load the CPU-only build (no ASYNCIFY, no WebGPU).
//   - 'webgpu'→ always load the GPU build (WebGPU + ASYNCIFY).
//   - 'auto'  → load GPU build if navigator.gpu is present, else CPU.
//
// The two WASM URL options are plumbed to Emscripten's `locateFile`. If
// omitted, Emscripten's default (import.meta.url-relative resolution) is used,
// which works outside of bundlers.
//
// Local addition (CrysViz): `threads`. The CPU build also exists as a pthreads
// variant in ./cpu-mt/ (ggml runs the graph on several threads). It needs
// SharedArrayBuffer, i.e. a cross-origin isolated page; when that is not the
// case, or `threads === false`, the single-threaded ./cpu/ build is used. The
// loader reports which one it picked as `module.crysvizVariant`.
export function threadsAvailable() {
    return typeof SharedArrayBuffer !== 'undefined'
        && typeof globalThis.crossOriginIsolated === 'boolean' && globalThis.crossOriginIsolated;
}

export default async function createMlipcpp(options = {}) {
    const { backend = 'auto', cpuWasmUrl, gpuWasmUrl, mtWasmUrl, threads = 'auto', ...rest } = options;

    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const wantGpu = backend === 'webgpu' || (backend === 'auto' && hasWebGPU);
    const wantThreads = !wantGpu && threads !== false && threadsAvailable();

    if (wantGpu) {
        const mod = await import('./gpu/mlipcpp_wasm.js');
        const instance = await mod.default({
            ...rest,
            ...(gpuWasmUrl ? { locateFile: (p) => p.endsWith('.wasm') ? gpuWasmUrl : p } : {}),
        });
        instance.crysvizVariant = 'gpu';
        return instance;
    }

    if (wantThreads) {
        try {
            const mod = await import('./cpu-mt/mlipcpp_wasm.js');
            const instance = await mod.default({
                ...rest,
                ...(mtWasmUrl ? { locateFile: (p) => p.endsWith('.wasm') ? mtWasmUrl : p } : {}),
            });
            instance.crysvizVariant = 'cpu-mt';
            return instance;
        } catch (error) {
            // A browser that isolates but cannot run the threaded build (no
            // nested workers, wasm threads disabled) falls through to the
            // single-threaded one instead of leaving PET-MAD unusable.
            console.warn('[mlip] threaded build unavailable, using the single-threaded build:', error);
        }
    }

    const mod = await import('./cpu/mlipcpp_wasm.js');
    const instance = await mod.default({
        ...rest,
        ...(cpuWasmUrl ? { locateFile: (p) => p.endsWith('.wasm') ? cpuWasmUrl : p } : {}),
    });
    instance.crysvizVariant = 'cpu';
    return instance;
}
