// external/mlip_wasm/canvas_readback.js: PET-MAD's WebGPU readback through a
// canvas snapshot (Firefox resolves mapAsync on a ~100 ms timer, a snapshot is
// synchronous). Checks the GPU packing (3 bytes per pixel, rgba and bgra
// layouts) and the unpacking against known bytes, using a plain texture read
// with mapAsync in place of the canvas snapshot. Then checks the installed hook
// either returns exact bytes or declines with a reason, never wrong bytes.
// Needs WebGPU: run with CRYSVIZ_BROWSER=chromium CRYSVIZ_GPU=swiftshader.
// Skips (passes with a note) where WebGPU is unavailable.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const r = await page.evaluate(async () => {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    if (!adapter) return { skipped: navigator.gpu ? 'no WebGPU adapter' : 'navigator.gpu missing' };
    const device = await adapter.requestDevice();
    const mod = await import('./external/mlip_wasm/canvas_readback.js');
    const W = 1024;
    const src = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 17 + (i >> 5)) & 255);
    const gpuBuf = (bytes) => {
      const b = device.createBuffer({ size: Math.max(4, (bytes.length + 3) & ~3),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const padded = new Uint8Array(b.size);
      padded.set(bytes);
      device.queue.writeBuffer(b, 0, padded);
      return b;
    };
    // Pack `reads` into a texture of `format`, read it back as getImageData would (RGBA), unpack.
    const roundTrip = async (format, reads) => {
      const st = mod.createPackState(device, format === 'bgra8unorm');
      const tex = device.createTexture({ size: [W, 64], format,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
      const enc = device.createCommandEncoder();
      const { offsets, rows, total } = mod.encodePack(st, enc, reads, tex);
      const out = device.createBuffer({ size: W * 4 * rows, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      enc.copyTextureToBuffer({ texture: tex }, { buffer: out, bytesPerRow: W * 4, rowsPerImage: rows }, [W, rows]);
      device.queue.submit([enc.finish()]);
      await out.mapAsync(GPUMapMode.READ);
      const px = new Uint8Array(out.getMappedRange()).slice();
      out.unmap();
      if (format === 'bgra8unorm') {
        for (let i = 0; i < px.length; i += 4) [px[i], px[i + 2]] = [px[i + 2], px[i]];
      }
      // Pixels carrying data are opaque (the rest of the last row is never written).
      const nPx = Math.ceil(total / 3);
      const alphaOpaque = px.every((v, i) => (i & 3) !== 3 || i >= 4 * nPx || v === 255);
      return { got: reads.map((x, i) => mod.unpackBytes(px, offsets[i], x.size)), rows, alphaOpaque };
    };
    const cases = [];
    for (const format of ['rgba8unorm', 'bgra8unorm']) {
      // One read; several reads of odd sizes at odd buffer offsets; more than one
      // pixel row; an empty read set (a plain wait).
      const a = src(4000, 1);
      const b = src(10001, 2);
      const c = src(7, 3);
      const big = src(3 * W * 5 + 11, 4);
      const ba = gpuBuf(a);
      const bb = gpuBuf(b);
      const bc = gpuBuf(c);
      const bbig = gpuBuf(big);
      const sets = {
        one: [[ba, 0, a.length, a]],
        several: [[bb, 4, 9993, b.subarray(4, 4 + 9993)], [bc, 0, 7, c], [ba, 1000, 2, a.subarray(1000, 1002)]],
        rows: [[bbig, 8, big.length - 8, big.subarray(8)]],
        empty: [],
      };
      for (const [name, set] of Object.entries(sets)) {
        const reads = set.map(([buffer, offset, size]) => ({ buffer, offset, size }));
        const { got, rows, alphaOpaque } = await roundTrip(format, reads);
        const ok = got.length === set.length && set.every(([, , , want], i) => got[i].length === want.length
          && got[i].every((v, j) => v === want[j]));
        cases.push({ format, name, ok, rows, alphaOpaque });
      }
    }
    // The real hook on this browser: exact bytes through the canvas, or a clean decline.
    const hook = mod.createCanvasReadback();
    const want = src(5000, 9);
    const hb = gpuBuf(want);
    const res = hook(device, [{ buffer: hb, offset: 0, size: want.length }]);
    const hookOk = res === null ? hook.info.readback === 'map' && !!hook.info.reason
      : hook.info.readback === 'canvas' && res[0].every((v, i) => v === want[i]);
    device.destroy();
    return { cases, hook: { ...hook.info, returned: res === null ? null : 'bytes' }, hookOk };
  });
  if (r.skipped) {
    console.log(`  (skipped: ${r.skipped})`);
    H.check('WebGPU unavailable here: nothing to check', true);
  } else {
    for (const c of r.cases) {
      H.check(`${c.format}: "${c.name}" reads come back byte-exact through 3-byte pixels (${c.rows} row(s), opaque alpha)`,
        c.ok && c.alphaOpaque, JSON.stringify(c));
    }
    H.check('the canvas hook returns exact bytes, or declines with a reason (never wrong bytes)', r.hookOk,
      JSON.stringify(r.hook));
    console.log(`  canvas readback on this browser: ${JSON.stringify(r.hook)}`);
  }
  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
