// @ts-nocheck
/**
 * Runs debug/gpuRoundTrip.js's measurement inside a worker (PET-MAD's WebGPU
 * build runs in one) and posts the result: { mapMs, workDoneMs, canvas,
 * dispatch } or null, or { error }.
 */
import { measureGpuRoundTrip, measureCanvasReadback, measureDispatchCost } from '../debug/gpuRoundTrip.js';
import { SLOW_MAP_MS } from '../external/mlip_wasm/canvas_readback.js';

self.onmessage = async () => {
  try {
    const rt = await measureGpuRoundTrip();
    // Kernel launches first (see potentialBenchmark.probeGpuRoundTrip).
    self.postMessage(rt && {
      ...rt,
      dispatch: await measureDispatchCost({ canvas: rt.mapMs > SLOW_MAP_MS }).catch((e) => ({ error: String(e) })),
      canvas: await measureCanvasReadback().catch((e) => ({ error: String(e) })),
    });
  } catch (error) {
    self.postMessage({ error: error?.message || String(error) });
  }
};
