// Unit tests for the marching-cubes memory budget and the chunked resampler
// (docs/model/marchingCubesMemory.js + compiled/MarchCubes.wasm).
// Run: make unittest   (or: node --test tools/unittest/)
//
// The WASM instance preallocates MC_BYTES_PER_POINT bytes per grid point in a
// 4 GiB heap; a 300x300x324 CHGCAR (wav_data/CHGCAR) is ~3.7 GiB of that, so
// it must come out downsampled. When wav_data/CHGCAR is present the last test
// parses it for real and runs the isosurface on it; otherwise it is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import MarchCubes from '../../docs/compiled/MarchCubes.js';
import {
  MC_BYTES_PER_POINT, MC_INSTANCE_BUDGET_BYTES, MC_TOTAL_BUDGET_BYTES, MC_MIN_BUDGET_BYTES,
  MC_WASM_MEMORY_BYTES, marchingCubesGridBytes, marchingCubesBudget, planMarchingCubesGrid,
  fillByResampling, createMarchingCubesInstance, resampleGridValues,
} from '../../docs/model/marchingCubesMemory.js';

const M = await MarchCubes();
const CHGCAR_DIMS = { nx: 300, ny: 300, nz: 324 };
const REAL_CHGCAR = fileURLToPath(new URL('../../wav_data/CHGCAR', import.meta.url));

/** Reference trilinear sample of `values` (dims src) at target point (i,j,k)
 *  of a grid with dims dst spanning the same extent. */
function reference(values, src, dst, i, j, k) {
  const coord = (t, ns, nd) => {
    if (ns < 2 || nd < 2) return [0, 0, 0];
    const s = (t * (ns - 1)) / (nd - 1);
    const lo = Math.min(Math.floor(s), ns - 2);
    return [lo, lo + 1, s - lo];
  };
  const [x0, x1, tx] = coord(i, src.nx, dst.nx);
  const [y0, y1, ty] = coord(j, src.ny, dst.ny);
  const [z0, z1, tz] = coord(k, src.nz, dst.nz);
  const v = (x, y, z) => values[x + src.nx * (y + src.ny * z)];
  const lerp = (a, b, t) => a + (b - a) * t;
  const plane = (z) => lerp(lerp(v(x0, y0, z), v(x1, y0, z), tx), lerp(v(x0, y1, z), v(x1, y1, z), tx), ty);
  return lerp(plane(z0), plane(z1), tz);
}

function fieldOf(src, f) {
  const values = new Float32Array(src.nx * src.ny * src.nz);
  for (let z = 0; z < src.nz; z++)
    for (let y = 0; y < src.ny; y++)
      for (let x = 0; x < src.nx; x++) values[x + src.nx * (y + src.ny * z)] = f(x, y, z);
  return values;
}

function readField(instance, dst) {
  const n = dst.nx * dst.ny * dst.nz;
  return new Float32Array(M.HEAPF32.buffer, instance.getField(), n).slice();
}

test('JS per-point estimate matches the WASM allocation', () => {
  assert.equal(M.marchingCubesBytes(1, 1, 1), MC_BYTES_PER_POINT);
  assert.equal(M.marchingCubesBytes(300, 300, 324), marchingCubesGridBytes(300, 300, 324));
});

test('the CHGCAR grid is over budget and plans to a grid that fits', () => {
  const full = marchingCubesGridBytes(CHGCAR_DIMS.nx, CHGCAR_DIMS.ny, CHGCAR_DIMS.nz);
  assert.ok(full > MC_INSTANCE_BUDGET_BYTES, `${full} bytes should exceed the instance budget`);

  const plan = planMarchingCubesGrid(CHGCAR_DIMS);
  assert.equal(plan.downsampled, true);
  assert.ok(plan.bytes <= MC_INSTANCE_BUDGET_BYTES);
  assert.ok(plan.nx < 300 && plan.ny < 300 && plan.nz < 324);
  // Aspect kept, and not shrunk more than needed (within a plane per axis).
  assert.equal(plan.nx, plan.ny);
  assert.ok(plan.nz > plan.nx);
  const bigger = marchingCubesGridBytes(plan.nx + 1, plan.ny + 1, plan.nz + 1);
  assert.ok(bigger > MC_INSTANCE_BUDGET_BYTES);
});

test('a small grid is left alone', () => {
  const plan = planMarchingCubesGrid({ nx: 120, ny: 100, nz: 80 });
  assert.deepEqual([plan.nx, plan.ny, plan.nz, plan.downsampled], [120, 100, 80, false]);
});

test('budget shrinks with live instances but never below the floor', () => {
  assert.equal(marchingCubesBudget(0), MC_INSTANCE_BUDGET_BYTES);
  assert.equal(marchingCubesBudget(MC_TOTAL_BUDGET_BYTES - 2 ** 29), 2 ** 29);
  assert.equal(marchingCubesBudget(MC_TOTAL_BUDGET_BYTES), MC_MIN_BUDGET_BYTES);
});

test('an unaddressable grid fails allocation instead of aborting the module', () => {
  const mc = new M.MarchingCubes(2000, 2000, 2000);
  assert.equal(mc.isAllocated(), false);
  mc.updateVertices(0.5); // a no-op, not a crash
  assert.equal(mc.getVertexCount(), 0);
  mc.delete();
});

test('chunked resampling matches trilinear interpolation, across slab seams', () => {
  const src = { nx: 13, ny: 11, nz: 17 };
  const dst = { nx: 6, ny: 5, nz: 7 };
  const values = fieldOf(src, (x, y, z) => Math.sin(x * 0.7) * Math.cos(y * 0.4) + 0.1 * z * z);
  const mc = new M.MarchingCubes(dst.nx, dst.ny, dst.nz);
  assert.ok(mc.isAllocated());
  // One plane's worth of bytes forces the minimum 2-plane slab: 16 seams.
  fillByResampling(M, mc, values, src, 4);
  const out = readField(mc, dst);
  for (let k = 0; k < dst.nz; k++)
    for (let j = 0; j < dst.ny; j++)
      for (let i = 0; i < dst.nx; i++) {
        const want = reference(values, src, dst, i, j, k);
        const got = out[i + dst.nx * (j + dst.ny * k)];
        assert.ok(Math.abs(got - want) < 1e-4, `(${i},${j},${k}) ${got} vs ${want}`);
      }
  // The corners are source corners exactly: same extent, same mesh placement.
  assert.equal(out[0], values[0]);
  assert.equal(out[out.length - 1], values[values.length - 1]);
  mc.delete();
});

test('slab size does not change the result', () => {
  const src = { nx: 9, ny: 8, nz: 23 };
  const dst = { nx: 5, ny: 4, nz: 10 };
  const values = fieldOf(src, (x, y, z) => Math.exp(-((x - 4) ** 2 + (y - 3) ** 2 + (z - 11) ** 2) / 20));
  const results = [4, 9 * 8 * 4 * 5, 1 << 26].map((slabBytes) => {
    const mc = new M.MarchingCubes(dst.nx, dst.ny, dst.nz);
    fillByResampling(M, mc, values, src, slabBytes);
    const out = readField(mc, dst);
    mc.delete();
    return out;
  });
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
});

/** Gaussian blobs on a CHGCAR-sized grid, plus the vertex count of a surface. */
function isosurfaceOf(field, iso) {
  const before = M.HEAPF32.buffer.byteLength;
  const { instance, grid } = createMarchingCubesInstance(M, field);
  instance.updateVertices(iso);
  const result = {
    grid,
    vertexCount: instance.getVertexCount(),
    truncated: instance.isTruncated(),
    heapBytes: M.HEAPF32.buffer.byteLength,
    heapBefore: before,
  };
  instance.delete();
  return result;
}

test('a CHGCAR-sized field is downsampled and still gets a surface', () => {
  const src = CHGCAR_DIMS;
  const centres = [[0.3, 0.3, 0.3], [0.7, 0.6, 0.5], [0.5, 0.2, 0.8]];
  const values = new Float32Array(src.nx * src.ny * src.nz);
  for (let z = 0, p = 0; z < src.nz; z++)
    for (let y = 0; y < src.ny; y++)
      for (let x = 0; x < src.nx; x++, p++) {
        let v = 0;
        for (const [cx, cy, cz] of centres) {
          const d2 = (x / src.nx - cx) ** 2 + (y / src.ny - cy) ** 2 + (z / src.nz - cz) ** 2;
          v += Math.exp(-d2 / 0.005);
        }
        values[p] = v;
      }
  const r = isosurfaceOf({ ...src, values }, 0.5);
  assert.equal(r.grid.downsampled, true);
  assert.ok(r.vertexCount > 1000, `vertexCount ${r.vertexCount}`);
  assert.equal(r.vertexCount % 3, 0);
  assert.equal(r.truncated, false);
  assert.ok(r.heapBytes <= MC_WASM_MEMORY_BYTES);
});

/** Node 18 has no fs.openAsBlob; parseChgcarBlob only needs size + slice().arrayBuffer(). */
function fileBlob(path, start = 0, end = statSync(path).size) {
  return {
    size: end - start,
    slice(a = 0, b = end - start) {
      return fileBlob(path, start + a, Math.min(end, start + b));
    },
    async arrayBuffer() {
      const buf = Buffer.alloc(end - start);
      const fd = openSync(path, 'r');
      try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    },
  };
}

test('wav_data/CHGCAR: real field is downsampled and its surface built in WASM memory',
  { skip: !existsSync(REAL_CHGCAR) && 'wav_data/CHGCAR not present', timeout: 600_000 },
  async () => {
    const { parseChgcarBlob } = await import('../../docs/io/chgcarParse.js');
    const { blocks } = await parseChgcarBlob(/** @type {any} */ (fileBlob(REAL_CHGCAR)), 'CHGCAR');
    const block = blocks[0];
    assert.deepEqual([block.nx, block.ny, block.nz], [CHGCAR_DIMS.nx, CHGCAR_DIMS.ny, CHGCAR_DIMS.nz]);

    // The full grid would not fit: what the module used to try and allocate.
    assert.ok(marchingCubesGridBytes(block.nx, block.ny, block.nz) > MC_INSTANCE_BUDGET_BYTES);

    const { instance, grid } = createMarchingCubesInstance(M, block);
    try {
      assert.equal(grid.downsampled, true);
      const iso = instance.defaultIsoValue(0.05);
      assert.ok(iso > 0, `default isovalue ${iso}`);
      instance.updateVertices(iso);
      const vertexCount = instance.getVertexCount();
      assert.ok(vertexCount > 0);
      assert.equal(instance.isTruncated(), false);
      assert.ok(M.HEAPF32.buffer.byteLength <= MC_WASM_MEMORY_BYTES);
      // Same extent: the resampled grid's corners are the source corners.
      const out = new Float32Array(M.HEAPF32.buffer, instance.getField(), grid.nx * grid.ny * grid.nz);
      assert.equal(out[0], block.values[0]);
      assert.equal(out[out.length - 1], block.values[block.values.length - 1]);
    } finally {
      instance.delete();
    }
  });

test('resampleGridValues (colour field) matches the WASM resampler point for point', () => {
  const src = { nx: 7, ny: 5, nz: 9 };
  const dst = { nx: 4, ny: 3, nz: 5 };
  const values = new Float32Array(src.nx * src.ny * src.nz).map((_, i) => Math.sin(i * 0.37) * 3 + i * 0.01);
  const instance = new M.MarchingCubes(dst.nx, dst.ny, dst.nz);
  try {
    fillByResampling(M, instance, values, src);
    const wasm = new Float32Array(M.HEAPF32.buffer, instance.getField(), dst.nx * dst.ny * dst.nz).slice();
    const js = resampleGridValues(values, src, dst);
    assert.equal(js.length, wasm.length);
    for (let i = 0; i < js.length; i++) assert.ok(Math.abs(js[i] - wasm[i]) < 1e-5, `point ${i}: ${js[i]} vs ${wasm[i]}`);
  } finally {
    instance.delete();
  }
});

test('colour field: per-vertex values follow the mesh; mask removes masked cubes', () => {
  const n = 12;
  const c = (n - 1) / 2;
  const field = new Float32Array(n * n * n);
  const colour = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const idx = i + n * (j + n * k);
    field[idx] = Math.hypot(i - c, j - c, k - c);
    colour[idx] = i; // x index: vertex value must equal its x position in grid units
  }
  const mc = new M.MarchingCubes(n, n, n);
  try {
    M.HEAPF32.set(field, mc.getField() >>> 2);
    mc.setColorFieldEnabled(true);
    assert.ok(mc.getColorFieldEnabled());
    M.HEAPF32.set(colour, mc.getColorField() >>> 2);
    mc.updateVertices(4);
    const count = mc.getVertexCount();
    assert.ok(count > 0);
    const pos = new Float32Array(M.HEAPF32.buffer, mc.getVertices(), count * 3).slice();
    const vals = new Float32Array(M.HEAPF32.buffer, mc.getVertexValues(), count).slice();
    for (let v = 0; v < count; v++) {
      assert.ok(Math.abs(vals[v] - pos[3 * v] * (n - 1)) < 1e-3, `vertex ${v}`);
    }
    // Every grid point is >= 0, so a mask at 0 hides every cube.
    mc.setMaskValue(0);
    mc.updateVertices(4);
    assert.equal(mc.getVertexCount(), 0);
  } finally {
    mc.delete();
  }
});
