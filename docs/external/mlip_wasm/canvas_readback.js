/**
 * Synchronous WebGPU readback through a canvas snapshot, for ggml-webgpu's
 * host readback hook (crysviz-ggml-webgpu.patch: Module.ggmlWebgpuReadback).
 *
 * mapAsync is how WebGPU reads a buffer back, but a browser may resolve it
 * only on a timer: Firefox polls its GPU process every 100 ms, so every
 * PET-MAD step waited 100–200 ms whatever the GPU did. A snapshot of a WebGPU
 * canvas (drawImage into a 2D canvas, then getImageData) is synchronous, and
 * Firefox serves it with a blocking map in the GPU process: about 1 ms
 * measured, page or worker.
 *
 * The reads are copied into one buffer. A compute shader packs it 3 bytes per
 * pixel (an opaque canvas returns colour channels exactly, alpha is forced to
 * 255). The pixels are copied into the canvas texture, the canvas is
 * snapshotted and the bytes unpacked. On first use a self-test reads known
 * bytes back. If they don't come back exact (some browsers snapshot WebGPU
 * canvases blank), the hook declines from then on and ggml maps as before.
 *
 * Only worth it where mapAsync is slow: the runner measures it first
 * (mapRoundTripMs) and declines the hook where it is fast (Chrome: ~1 ms),
 * so those browsers never touch a WebGPU canvas. Headless Chromium even loses
 * its WebGPU instance after such a snapshot.
 */

/** Canvas width in pixels: 4096 bytes per row, a multiple of WebGPU's 256-byte row alignment. */
const WIDTH = 1024;

const PACK_WGSL = /* wgsl */ `
struct Params { n_bytes : u32, swap_rb : u32, n_px : u32, pad : u32 };
@group(0) @binding(0) var<storage, read> src : array<u32>;
@group(0) @binding(1) var<storage, read_write> dst : array<u32>;
@group(0) @binding(2) var<uniform> P : Params;

fn byte_at(i : u32) -> u32 {
  if (i >= P.n_bytes) { return 0u; }
  return (src[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
}

// Pixel p carries bytes 3p, 3p+1, 3p+2 as (r, g, b) of the snapshot. A bgra8unorm
// texel stores b, g, r, a in memory, so swap_rb puts byte 3p where red is read.
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let p = id.x;
  if (p >= P.n_px) { return; }
  let b0 = byte_at(3u * p);
  let b1 = byte_at(3u * p + 1u);
  let b2 = byte_at(3u * p + 2u);
  if (P.swap_rb == 1u) {
    dst[p] = b2 | (b1 << 8u) | (b0 << 16u) | 0xff000000u;
  } else {
    dst[p] = b0 | (b1 << 8u) | (b2 << 16u) | 0xff000000u;
  }
}
`;

/**
 * `size` bytes starting at byte `start` of the packed stream, from snapshot
 * pixels in RGBA order (getImageData's layout).
 * @param {ArrayLike<number>} px
 * @param {number} start
 * @param {number} size
 * @returns {Uint8Array}
 */
export function unpackBytes(px, start, size) {
  const out = new Uint8Array(size);
  const p = Math.floor(start / 3);
  let c = start - 3 * p;
  let k = 4 * p + c;
  for (let j = 0; j < size; j += 1) {
    out[j] = px[k];
    if (c === 2) {
      c = 0;
      k += 2;
    } else {
      c += 1;
      k += 1;
    }
  }
  return out;
}

const ceil4 = (n) => (n + 3) & ~3;

/**
 * GPU side of a readback: copy `reads` into the gather buffer, pack them,
 * and copy the pixels into `texture`. Exported for tests, which pass a plain
 * texture instead of a canvas's. Returns each read's offset in the stream and
 * the number of pixel rows written.
 * @param {any} st state from createPackState
 * @param {any} enc GPUCommandEncoder
 * @param {{ buffer: any, offset: number, size: number }[]} reads GPUBuffer regions
 * @param {any} texture GPUTexture, at least WIDTH wide and `rows` high
 * @returns {{ offsets: number[], rows: number, total: number }}
 */
export function encodePack(st, enc, reads, texture) {
  const G = /** @type {any} */ (globalThis);
  const { device } = st;
  let total = 0;
  const offsets = reads.map((r) => {
    const o = total;
    total += ceil4(r.size);
    return o;
  });
  const nPx = Math.ceil(total / 3);
  const rows = Math.max(1, Math.ceil(nPx / WIDTH));
  if (!st.gather || st.gather.size < Math.max(4, total)) {
    st.gather?.destroy();
    st.gather = device.createBuffer({ size: Math.max(256, ceil4(Math.ceil(total * 1.25))),
      usage: G.GPUBufferUsage.STORAGE | G.GPUBufferUsage.COPY_DST });
    st.bindGroup = null;
  }
  if (!st.packed || st.packed.size < rows * WIDTH * 4) {
    st.packed?.destroy();
    st.packed = device.createBuffer({ size: Math.ceil(rows * 1.25) * WIDTH * 4,
      usage: G.GPUBufferUsage.STORAGE | G.GPUBufferUsage.COPY_SRC });
    st.bindGroup = null;
  }
  if (!st.bindGroup) {
    st.bindGroup = device.createBindGroup({
      layout: st.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: st.gather } },
        { binding: 1, resource: { buffer: st.packed } },
        { binding: 2, resource: { buffer: st.params } },
      ],
    });
  }
  reads.forEach((r, i) => {
    if (r.size) enc.copyBufferToBuffer(r.buffer, r.offset, st.gather, offsets[i], ceil4(r.size));
  });
  if (nPx) {
    device.queue.writeBuffer(st.params, 0, new Uint32Array([total, st.swapRB ? 1 : 0, nPx, 0]));
    const pass = enc.beginComputePass();
    pass.setPipeline(st.pipeline);
    pass.setBindGroup(0, st.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(nPx / 256));
    pass.end();
  }
  enc.copyBufferToTexture({ buffer: st.packed, bytesPerRow: WIDTH * 4, rowsPerImage: rows }, { texture }, [WIDTH, rows]);
  return { offsets, rows, total };
}

/**
 * Pipeline and buffers for encodePack on `device`.
 * @param {any} device GPUDevice
 * @param {boolean} swapRB the target texture is bgra8unorm
 */
export function createPackState(device, swapRB) {
  const G = /** @type {any} */ (globalThis);
  return {
    device,
    swapRB,
    pipeline: device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: PACK_WGSL }), entryPoint: 'main' },
    }),
    params: device.createBuffer({ size: 16, usage: G.GPUBufferUsage.UNIFORM | G.GPUBufferUsage.COPY_DST }),
    gather: null,
    packed: null,
    bindGroup: null,
  };
}

/** Max pixel rows: the device's texture limit, and the dispatch limit (65535 × 256 pixels). */
const maxRows = (device) => Math.min(device.limits.maxTextureDimension2D, Math.floor((65535 * 256) / WIDTH));

/**
 * The hook to install as Module.ggmlWebgpuReadback. `hook.info` says what it
 * does: readback 'pending' (not used yet), 'canvas' (self-test passed) or
 * 'map' (declining; `reason` says why), plus the self-test time.
 * @returns {((device: any, reads: { buffer: any, offset: number, size: number }[]) => Uint8Array[]|null)
 *   & { info: { readback: string, reason: string|null, selfTestMs: number|null, format: string|null },
 *       decline: (reason: string) => void }}
 */
export function createCanvasReadback() {
  const info = { readback: 'pending', reason: null, selfTestMs: null, format: null };
  /** @type {any} */
  let st = null;

  const setup = (device) => {
    const G = /** @type {any} */ (globalThis);
    if (typeof G.OffscreenCanvas !== 'function') throw new Error('no OffscreenCanvas');
    const format = G.navigator?.gpu?.getPreferredCanvasFormat?.() || 'rgba8unorm';
    if (format !== 'bgra8unorm' && format !== 'rgba8unorm') throw new Error(`canvas format ${format}`);
    const canvas = new G.OffscreenCanvas(WIDTH, 1);
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('no webgpu canvas context');
    ctx.configure({ device, format, alphaMode: 'opaque',
      usage: G.GPUTextureUsage.RENDER_ATTACHMENT | G.GPUTextureUsage.COPY_DST });
    const out = new G.OffscreenCanvas(WIDTH, 1).getContext('2d', { willReadFrequently: true });
    if (!out) throw new Error('no 2d canvas context');
    info.format = format;
    return { ...createPackState(device, format === 'bgra8unorm'), canvas, ctx, out };
  };

  const read = (reads) => {
    const total = reads.reduce((s, r) => s + ceil4(r.size), 0);
    const rows = Math.max(1, Math.ceil(Math.ceil(total / 3) / WIDTH));
    if (rows > maxRows(st.device)) return null;
    if (rows > st.canvas.height) {
      // Resizing keeps the configuration; the next getCurrentTexture has the new size.
      st.canvas.height = rows;
      st.out.canvas.height = rows;
    }
    const enc = st.device.createCommandEncoder();
    const { offsets } = encodePack(st, enc, reads, st.ctx.getCurrentTexture());
    st.device.queue.submit([enc.finish()]);
    st.out.drawImage(st.canvas, 0, 0);
    const px = st.out.getImageData(0, 0, WIDTH, rows).data;
    return reads.map((r, i) => unpackBytes(px, offsets[i], r.size));
  };

  // Known bytes over more than one pixel row, at an odd size, must come back exact.
  const selfTest = (device) => {
    const G = /** @type {any} */ (globalThis);
    const n = 3 * WIDTH + 1000;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) bytes[i] = i % 7 === 0 ? 255 : (i * 131 + 7) & 255;
    const buf = device.createBuffer({ size: n, usage: G.GPUBufferUsage.COPY_SRC | G.GPUBufferUsage.COPY_DST });
    try {
      device.queue.writeBuffer(buf, 0, bytes);
      const t = performance.now();
      const [got] = read([{ buffer: buf, offset: 4, size: n - 6 }]);
      info.selfTestMs = performance.now() - t;
      const want = bytes.subarray(4, n - 2);
      if (got.every((v, i) => v === want[i])) return null;
      return got.every((v) => v === 0) ? 'canvas snapshot came back blank' : 'canvas snapshot bytes differ';
    } finally {
      buf.destroy();
    }
  };

  const hook = (device, reads) => {
    if (info.readback === 'map') return null;
    if (!st || st.device !== device) {
      try {
        st = setup(device);
        const why = selfTest(device);
        if (why) {
          info.readback = 'map';
          info.reason = why;
          return null;
        }
        info.readback = 'canvas';
      } catch (error) {
        info.readback = 'map';
        info.reason = error?.message || String(error);
        return null;
      }
    }
    return read(reads);
  };
  hook.info = info;
  /** Turn the hook off for good (it then always declines), saying why. */
  hook.decline = (/** @type {string} */ reason) => {
    info.readback = 'map';
    info.reason = reason;
  };
  return hook;
}

/**
 * Median time of a tiny copy + mapAsync on a fresh device, in ms: what one
 * mapAsync readback costs in this browser and context (Firefox ~104 ms,
 * Chrome ~1 ms). Null without WebGPU.
 * @param {number} [rounds]
 * @returns {Promise<number|null>}
 */
export async function mapRoundTripMs(rounds = 3) {
  const G = /** @type {any} */ (globalThis);
  const adapter = await G.navigator?.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  try {
    const src = device.createBuffer({ size: 4, usage: G.GPUBufferUsage.COPY_SRC });
    const dst = device.createBuffer({ size: 4, usage: G.GPUBufferUsage.MAP_READ | G.GPUBufferUsage.COPY_DST });
    const times = [];
    for (let i = 0; i < rounds; i += 1) {
      const t = performance.now();
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, dst, 0, 4);
      device.queue.submit([enc.finish()]);
      await dst.mapAsync(G.GPUMapMode.READ);
      dst.unmap();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return times[times.length >> 1];
  } finally {
    device.destroy();
  }
}

/** mapAsync slower than this (ms) makes the canvas readback worth using. */
export const SLOW_MAP_MS = 20;
