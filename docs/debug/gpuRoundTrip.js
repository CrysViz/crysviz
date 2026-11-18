/**
 * WebGPU round-trip latency: how long one tiny copy + mapAsync (and one
 * queue.onSubmittedWorkDone) takes from submit to the promise resolving, in
 * the calling context. A PET-MAD WebGPU step waits for the GPU once; if this
 * alone is ~100 ms, that is the floor per step whatever the kernels do. The
 * Benchmark tab measures it on the page and in a worker (workers/gpuProbeWorker.js),
 * since PET-MAD runs in one.
 */

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * @param {number} [rounds]
 * @returns {Promise<{ mapMs: number, workDoneMs: number } | null>} medians; null without WebGPU
 */
export async function measureGpuRoundTrip(rounds = 12) {
  const gpu = /** @type {any} */ (globalThis.navigator)?.gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const G = /** @type {any} */ (globalThis);
  const src = device.createBuffer({ size: 256, usage: G.GPUBufferUsage.STORAGE | G.GPUBufferUsage.COPY_SRC });
  const dst = device.createBuffer({ size: 256, usage: G.GPUBufferUsage.MAP_READ | G.GPUBufferUsage.COPY_DST });
  const map = [];
  const done = [];
  try {
    for (let i = 0; i < rounds; i += 1) {
      let t = performance.now();
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, dst, 0, 256);
      device.queue.submit([enc.finish()]);
      await dst.mapAsync(G.GPUMapMode.READ);
      dst.unmap();
      map.push(performance.now() - t);
      t = performance.now();
      device.queue.submit([device.createCommandEncoder().finish()]);
      await device.queue.onSubmittedWorkDone();
      done.push(performance.now() - t);
    }
  } finally {
    device.destroy();
  }
  // The first rounds include warm-up.
  return { mapMs: median(map.slice(2)), workDoneMs: median(done.slice(2)) };
}

/**
 * The same wait, but reading through a WebGPU canvas instead of mapAsync.
 * Known bytes are copied into an OffscreenCanvas's current texture and read
 * back two ways: a 2D context's drawImage + getImageData ("snapshot") and
 * new VideoFrame(canvas).copyTo ("videoFrame"). Both take a canvas snapshot,
 * which browsers implement synchronously (Firefox maps a staging buffer with a
 * blocking wait in its GPU process), so a browser that answers mapAsync on a
 * timer (Firefox: ~100 ms) may answer these as soon as the GPU is done.
 * transferToImageBitmap is not used: Firefox unconfigures a WebGPU context on
 * it. Each path gets { ms, result } or { error }; result is 'exact' when the
 * colour channels come back bit for bit (alpha is opaque, so 3 bytes per
 * pixel), 'blank' when they are all zero, else 'wrong'. 256 × 128 pixels is
 * about what a 350-atom PET-MAD step would read back.
 * @param {number} [rounds]
 * @returns {Promise<object|null>} { format, width, height, snapshot, videoFrame } or { error }; null without WebGPU
 */
export async function measureCanvasReadback(rounds = 10) {
  const G = /** @type {any} */ (globalThis);
  const gpu = G.navigator?.gpu;
  if (!gpu) return null;
  if (typeof G.OffscreenCanvas === 'undefined') return { error: 'no OffscreenCanvas' };
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const W = 256;
  const H = 128;
  const format = gpu.getPreferredCanvasFormat();
  const errors = [];
  device.addEventListener?.('uncapturederror', (e) => errors.push(e.error?.message || 'GPU error'));
  const bytes = new Uint8Array(W * H * 4);
  const src = device.createBuffer({ size: bytes.length, usage: G.GPUBufferUsage.COPY_SRC | G.GPUBufferUsage.COPY_DST });
  // Logical (r, g, b) of texel i in what was written, whatever the format.
  const bgraTex = format === 'bgra8unorm';
  const rgbOf = (i) => {
    const o = i * 4;
    return bgraTex ? [bytes[o + 2], bytes[o + 1], bytes[o]] : [bytes[o], bytes[o + 1], bytes[o + 2]];
  };
  /** @param {ArrayLike<number>} px @param {boolean} bgraOut @param {number} stride */
  const verdict = (px, bgraOut, stride = W * 4) => {
    let blank = true;
    let exact = true;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const o = y * stride + x * 4;
        const r = px[bgraOut ? o + 2 : o];
        const g = px[o + 1];
        const b = px[bgraOut ? o : o + 2];
        if (r || g || b) blank = false;
        const [er, eg, eb] = rgbOf(y * W + x);
        if (r !== er || g !== eg || b !== eb) exact = false;
      }
    }
    return exact ? 'exact' : (blank ? 'blank' : 'wrong');
  };
  // Fresh bytes each round, so a stale frame cannot pass.
  const fill = (canvasCtx, round) => {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i & 3) === 3 ? 255 : (i * 37 + round * 101 + 11) & 255;
    device.queue.writeBuffer(src, 0, bytes);
    const enc = device.createCommandEncoder();
    enc.copyBufferToTexture({ buffer: src, bytesPerRow: W * 4 }, { texture: canvasCtx.getCurrentTexture() }, [W, H]);
    device.queue.submit([enc.finish()]);
  };
  const newCanvas = () => {
    const canvas = new G.OffscreenCanvas(W, H);
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('no webgpu canvas context');
    ctx.configure({ device, format, alphaMode: 'opaque',
      usage: G.GPUTextureUsage.RENDER_ATTACHMENT | G.GPUTextureUsage.COPY_DST });
    return { canvas, ctx };
  };
  const run = async (read) => {
    try {
      const { canvas, ctx } = newCanvas();
      const times = [];
      let result = 'exact';
      for (let i = 0; i < rounds; i += 1) {
        fill(ctx, i);
        const t = performance.now();
        const { px, bgraOut, stride } = await read(canvas);
        times.push(performance.now() - t);
        const r = verdict(px, bgraOut, stride);
        if (r !== 'exact') result = r;
      }
      return { ms: median(times.slice(2)), result };
    } catch (error) {
      return { error: [error?.message || String(error), ...errors].join('; ') };
    }
  };
  try {
    const out2d = new G.OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
    const snapshot = await run(async (canvas) => {
      out2d.drawImage(canvas, 0, 0);
      return { px: out2d.getImageData(0, 0, W, H).data, bgraOut: false, stride: W * 4 };
    });
    const videoFrame = typeof G.VideoFrame === 'undefined' ? { error: 'no VideoFrame' } : await run(async (canvas) => {
      const frame = new G.VideoFrame(canvas, { timestamp: 0 });
      try {
        const px = new Uint8Array(frame.allocationSize());
        const [plane] = await frame.copyTo(px);
        return { px, bgraOut: /^BGR/.test(frame.format), stride: plane?.stride ?? W * 4 };
      } finally {
        frame.close();
      }
    });
    return { format, width: W, height: H, snapshot, videoFrame };
  } finally {
    device.destroy();
  }
}

const DISPATCH_WGSL = /* wgsl */ `
override K : f32 = 1.0;
struct P { k : u32, a : u32, b : u32, c : u32 };
@group(0) @binding(0) var<storage, read_write> x : array<f32>;
@group(0) @binding(1) var<storage, read_write> y : array<f32>;
@group(0) @binding(2) var<storage, read_write> z : array<f32>;
@group(0) @binding(3) var<uniform> p : P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  z[id.x] = x[id.x] * K * f32(p.k) + y[id.x];
}
`;

/**
 * What one kernel launch costs: `n` tiny dispatches (one 64-thread workgroup
 * each) in one compute pass, timed from encoding to the GPU being done, minus
 * an empty submit. 'same' reuses one pipeline and bind group; 'ggml' does what
 * ggml-webgpu does per kernel: its own bind group (three read_write ranges of
 * one shared buffer plus a uniform range) and alternating pipelines. A
 * PET-MAD-XS step is ~560 such launches. The wait goes through the canvas
 * snapshot readback where it works (Firefox's mapAsync and
 * onSubmittedWorkDone answer only every ~100 ms), else a tiny mapAsync.
 * @param {{ n?: number, rounds?: number, canvas?: boolean }} [opts] canvas: false waits with mapAsync only
 * @returns {Promise<object|null>} { n, wait, sameUs, ggmlUs, baseMs, encodeUs } (µs per dispatch), or { error }; null without WebGPU
 */
export async function measureDispatchCost({ n = 512, rounds = 5, canvas = true } = {}) {
  const G = /** @type {any} */ (globalThis);
  const gpu = G.navigator?.gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  try {
    const { createCanvasReadback } = await import('../external/mlip_wasm/canvas_readback.js');
    const hook = createCanvasReadback();
    if (!canvas) hook.decline('not asked for');
    const fence = device.createBuffer({ size: 4, usage: G.GPUBufferUsage.MAP_READ | G.GPUBufferUsage.COPY_DST });
    const fenceSrc = device.createBuffer({ size: 4, usage: G.GPUBufferUsage.COPY_SRC });
    const wait = async () => {
      if (hook(device, [])) return;
      // No exact canvas snapshot here: wait with a tiny copy + mapAsync, as PET-MAD then does.
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(fenceSrc, 0, fence, 0, 4);
      device.queue.submit([enc.finish()]);
      await fence.mapAsync(G.GPUMapMode.READ);
      fence.unmap();
    };
    const S = G.GPUShaderStage.COMPUTE;
    const bgl = device.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) => ({ binding, visibility: S, buffer: { type: 'storage' } }))
        .concat([{ binding: 3, visibility: S, buffer: { type: 'uniform' } }]),
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const module = device.createShaderModule({ code: DISPATCH_WGSL });
    const pipes = [1, 2].map((K) => device.createComputePipeline({ layout, compute: { module, entryPoint: 'main', constants: { K } } }));
    const data = device.createBuffer({ size: 3 * 256 * n, usage: G.GPUBufferUsage.STORAGE });
    const params = device.createBuffer({ size: 256 * n, usage: G.GPUBufferUsage.UNIFORM | G.GPUBufferUsage.COPY_DST });
    const group = (i) => device.createBindGroup({
      layout: bgl,
      entries: [0, 1, 2].map((b) => ({ binding: b, resource: { buffer: data, offset: (3 * i + b) * 256, size: 256 } }))
        .concat([{ binding: 3, resource: { buffer: params, offset: 256 * i, size: 16 } }]),
    });
    const groups = Array.from({ length: n }, (_, i) => group(i));
    const run = async (count, variant) => {
      const t0 = performance.now();
      const enc = device.createCommandEncoder();
      if (count) {
        const pass = enc.beginComputePass();
        for (let i = 0; i < count; i += 1) {
          if (variant === 'same') {
            if (i === 0) {
              pass.setPipeline(pipes[0]);
              pass.setBindGroup(0, groups[0]);
            }
          } else {
            pass.setPipeline(pipes[i & 1]);
            pass.setBindGroup(0, groups[i]);
          }
          pass.dispatchWorkgroups(1);
        }
        pass.end();
      }
      device.queue.submit([enc.finish()]);
      const t1 = performance.now();
      await wait();
      return { total: performance.now() - t0, encode: t1 - t0 };
    };
    await run(n, 'ggml'); // warm-up: pipelines, the canvas self-test
    const med = async (count, variant) => {
      const v = [];
      for (let r = 0; r < rounds; r += 1) v.push(await run(count, variant));
      return { total: median(v.map((x) => x.total)), encode: median(v.map((x) => x.encode)) };
    };
    const base = await med(0, 'same');
    const same = await med(n, 'same');
    const ggml = await med(n, 'ggml');
    const per = (x) => (1000 * Math.max(0, x.total - base.total)) / n;
    return {
      n,
      wait: hook.info.readback === 'canvas' ? 'canvas' : 'mapAsync',
      sameUs: per(same),
      ggmlUs: per(ggml),
      encodeUs: (1000 * ggml.encode) / n,
      baseMs: base.total,
    };
  } catch (error) {
    return { error: error?.message || String(error) };
  } finally {
    device.destroy();
  }
}
