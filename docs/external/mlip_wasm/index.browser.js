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
export default async function createMlipcpp(options = {}) {
    const { backend = 'auto', cpuWasmUrl, gpuWasmUrl, ...rest } = options;

    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const wantGpu = backend === 'webgpu' || (backend === 'auto' && hasWebGPU);

    if (wantGpu) {
        const mod = await import('./gpu/mlipcpp_wasm.js');
        return mod.default({
            ...rest,
            ...(gpuWasmUrl ? { locateFile: (p) => p.endsWith('.wasm') ? gpuWasmUrl : p } : {}),
        });
    }

    const mod = await import('./cpu/mlipcpp_wasm.js');
    return mod.default({
        ...rest,
        ...(cpuWasmUrl ? { locateFile: (p) => p.endsWith('.wasm') ? cpuWasmUrl : p } : {}),
    });
}
