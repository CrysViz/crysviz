// Ray tracer follows a BLOCK field (field.periodic === false): a finite grid
// with an origin that fills only part of the structure cell and may cross a
// cell face. Synthetic crisp-box fields are attached to the default YBCO
// structure through the real field path (setActiveField + updateField) and
// compared between the raster pipeline (marching-cubes mesh, the reference for
// where the block is) and the ray tracer (implicit surface).
// Asserts (DW-4.1) the traced silhouette overlaps the raster one for a block
// inside the cell, one crossing a cell face and one spanning more than one
// cell, at unit and widened bounds; (DW-4.2) changing only origin / voxel /
// the periodic flag re-encodes the field; and that a periodic field keeps its
// wrap modes (0 at unit bounds, 1 widened) while a block gets 0 / 2.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

const CONVERGED = 40;

/** Boolean mask of the pixels that differ substantially between two shots. */
function diffMask(fileBase, fileShot) {
  const a = PNG.sync.read(fs.readFileSync(fileBase));
  const b = PNG.sync.read(fs.readFileSync(fileShot));
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * a.width + x) * 4, q = (y * b.width + x) * 4;
      const d = Math.abs(a.data[p] - b.data[q]) + Math.abs(a.data[p + 1] - b.data[q + 1])
        + Math.abs(a.data[p + 2] - b.data[q + 2]);
      if (d > 90) mask[y * w + x] = 1;
    }
  }
  return { mask, w, h };
}

/** Overlap (intersection over union), areas and centroid distance (fraction of width) of two masks. */
function compareMasks(m1, m2) {
  let inter = 0;
  const acc = [m1, m2].map(() => ({ n: 0, sx: 0, sy: 0 }));
  for (let i = 0; i < m1.mask.length; i++) {
    const x = i % m1.w, y = (i / m1.w) | 0;
    [m1, m2].forEach((m, k) => { if (m.mask[i]) { acc[k].n++; acc[k].sx += x; acc[k].sy += y; } });
    if (m1.mask[i] && m2.mask[i]) inter++;
  }
  const [a1, a2] = [acc[0].n, acc[1].n];
  const iou = a1 + a2 - inter > 0 ? inter / (a1 + a2 - inter) : 0;
  const centreDist = Math.hypot(acc[0].sx / a1 - acc[1].sx / a2, acc[0].sy / a1 - acc[1].sy / a2) / m1.w;
  return { iou, a1, a2, centreDist };
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO, orthorhombic
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false;
  });
  const lattice = await page.evaluate(async () => (await import('./state/store.js')).fileBrowser.selectedStructure.lattice);
  const [a, b, c] = lattice;

  async function waitForSamples(n, timeout = 90000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const s = await page.evaluate(async () => (await import('./state/store.js')).app.pipeline?._uniforms?.uSampleCounter?.value ?? 0);
      if (s >= n || Date.now() > deadline) return s;
      await page.waitForTimeout(1500);
    }
  }

  /** Tracer field uniforms as plain data. */
  const tracerState = () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const u = app.pipeline?._uniforms;
    return {
      id: app.pipeline?.id,
      enabled: u?.uFieldEnabled?.value,
      wrap: Number(u?.uFieldWrap?.value),
      min: u?.uFieldBoundsMin?.value?.toArray(),
      max: u?.uFieldBoundsMax?.value?.toArray(),
      toFrac: u?.uFieldWorldToFrac?.value?.toArray(),
      dims: u?.uFieldDims?.value?.toArray(),
    };
  });

  /** Poll until the tracer uniforms satisfy `pred` (re-encode lands on a render frame). */
  async function waitForTracer(pred, timeout = 60000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const s = await tracerState();
      if (pred(s) || Date.now() > deadline) return s;
      await page.evaluate(async () => (await import('./render/index.js')).requestRender());
      await page.waitForTimeout(800);
    }
  }

  /** Attach a crisp-box block field (1 inside index [2, n-3], else 0). */
  async function showField({ nx, ny, nz, voxel, origin, periodic }) {
    await page.evaluate(async ({ nx, ny, nz, voxel, origin, periodic }) => {
      const { Field } = await import('./model/index.js');
      const { setActiveField, updateField, requestRender } = await import('./render/index.js');
      const values = new Float32Array(nx * ny * nz);
      const ins = (i, n) => i >= 2 && i <= n - 3;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        values[i + nx * (j + ny * k)] = ins(i, nx) && ins(j, ny) && ins(k, nz) ? 1 : 0;
      }
      const field = new Field({
        nx, ny, nz, origin, voxel, values, periodic,
        isoValue: 0.5, minValue: 0, maxValue: 1, useAbsoluteIsoValue: false,
      });
      setActiveField(field, false);
      updateField(0.5);
      // Opaque saturated lobe: a translucent surface barely changes the tracer
      // image, which would leave the silhouette comparison with nothing to match.
      const { groups } = await import('./state/store.js');
      for (const lobe of ['positive', 'negative']) {
        const mat = groups.isosurfaceGroup.meshes?.[lobe]?.material;
        if (mat) { mat.color.set(0xff00ff); mat.opacity = 1; mat.transparent = false; }
      }
      requestRender();
    }, { nx, ny, nz, voxel, origin, periodic });
  }

  const clearField = () => page.evaluate(async () => {
    const { clearField, requestRender } = await import('./render/index.js');
    clearField();
    requestRender();
  });

  async function setBounds(xmax, xmin = 0) {
    await page.evaluate(async ({ xmin, xmax }) => {
      const { general } = await import('./state/store.js');
      const { applyFieldPeriodicBounds, requestRender } = await import('./render/index.js');
      general.showPeriodic = true;
      general.periodicBounds = { xmin, xmax, ymin: 0, ymax: 1, zmin: 0, zmax: 1 };
      applyFieldPeriodicBounds();
      requestRender();
    }, { xmin, xmax });
  }

  /**
   * Silhouette of `field` in the raster and in the tracer (each diffed against
   * its own no-field shot at the same bounds) and how well they overlap.
   * Leaves the tracer pipeline active with the field shown.
   */
  async function silhouettes(tag, fieldSpec, wantWrap) {
    await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
    await clearField();
    await page.waitForTimeout(700);
    const rBase = await H.shotCanvas(page, `tfb-${tag}-raster0`);
    await showField(fieldSpec);
    await page.waitForTimeout(900);
    const rField = await H.shotCanvas(page, `tfb-${tag}-raster1`);

    await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
    const st = await waitForTracer((s) => s.enabled === true && s.wrap === wantWrap);
    await waitForSamples(CONVERGED);
    const tField = await H.shotCanvas(page, `tfb-${tag}-trace1`);
    await clearField();
    await waitForTracer((s) => s.enabled === false);
    await waitForSamples(CONVERGED);
    const tBase = await H.shotCanvas(page, `tfb-${tag}-trace0`);
    await showField(fieldSpec); // leave the field on for follow-up checks
    await waitForTracer((s) => s.enabled === true && s.wrap === wantWrap);
    return { st, ...compareMasks(diffMask(rBase, rField), diffMask(tBase, tField)) };
  }

  const n = 12, step = 0.2;
  const stepVoxel = [[step, 0, 0], [0, step, 0], [0, 0, step]];
  const near = (x, y, e) => Math.abs(x - y) <= e;
  const fmt = (r) => JSON.stringify({ iou: +r.iou.toFixed(2), a1: r.a1, a2: r.a2, centreDist: +r.centreDist.toFixed(3) });
  const overlaps = (r) => r.a1 > 200 && r.a2 > 200 && r.iou > 0.5 && r.centreDist < 0.06;

  // ---- DW-4.1: a block inside the cell, unit bounds --------------------------------
  const inside = { nx: n, ny: n, nz: n, voxel: stepVoxel, origin: [1.0, 1.0, 3.0], periodic: false };
  let r = await silhouettes('inside', inside, 0);
  // Uniforms: no fold, march box = the block's own extent in the cell.
  const wantMin = [1.0 / a[0], 1.0 / b[1], 3.0 / c[2]];
  const wantMax = [(1.0 + (n - 1) * step) / a[0], (1.0 + (n - 1) * step) / b[1], (3.0 + (n - 1) * step) / c[2]];
  H.check('DW-4.1 block inside the cell: no fold, march box == block extent in cell fractions',
    r.st.wrap === 0 && r.st.min.every((v, k) => near(v, wantMin[k], 1e-5)) && r.st.max.every((v, k) => near(v, wantMax[k], 1e-5)),
    JSON.stringify({ st: r.st, wantMin, wantMax }));
  H.check('DW-4.1 block inside the cell: traced silhouette overlaps the raster mesh', overlaps(r), fmt(r));

  // ---- a block crossing the +a cell face at unit bounds ----------------------------
  const crossing = { ...inside, origin: [a[0] - 1.0, 1.0, 3.0] };
  r = await silhouettes('cross', crossing, 0);
  H.check('block crossing a cell face, unit bounds: drawn once, whole (box extends past cell fraction 1)',
    r.st.wrap === 0 && r.st.max[0] > 1.1 && near(r.st.min[0], (a[0] - 1.0) / a[0], 1e-5), JSON.stringify(r.st));
  H.check('block crossing a cell face, unit bounds: traced silhouette overlaps the raster mesh', overlaps(r), fmt(r));

  // ---- the same block with widened bounds: images with the structure lattice -------
  await setBounds(2);
  r = await silhouettes('cross2', crossing, 2);
  H.check('block crossing a cell face, bounds [0,2]: image mode, march box = display bounds',
    r.st.wrap === 2 && near(r.st.min[0], 0, 1e-6) && near(r.st.max[0], 2, 1e-6), JSON.stringify(r.st));
  H.check('block crossing a cell face, bounds [0,2]: traced silhouette overlaps the raster copies', overlaps(r), fmt(r));

  // ---- a block spanning more than one cell along a ---------------------------------
  const wide = { nx: 51, ny: 12, nz: 12, voxel: stepVoxel, origin: [-1, 1, 3], periodic: false }; // 10 A > a
  await setBounds(1);
  r = await silhouettes('wide1', wide, 0);
  H.check('block spanning more than one cell, unit bounds: box covers the whole block (> 1 cell)',
    r.st.wrap === 0 && r.st.max[0] - r.st.min[0] > 1.5, JSON.stringify(r.st));
  H.check('block spanning more than one cell, unit bounds: traced silhouette overlaps the raster mesh', overlaps(r), fmt(r));
  await setBounds(1.5);
  r = await silhouettes('wide15', wide, 2);
  H.check('block spanning more than one cell, bounds [0,1.5]: traced silhouette overlaps the raster copies', overlaps(r), fmt(r));

  // ---- DW-4.2: only origin / voxel / periodic flag changes re-encode ---------------
  await setBounds(1);
  await showField(inside);
  let before = await waitForTracer((s) => s.enabled === true && s.wrap === 0);
  const edit = (patch) => page.evaluate(async (patch) => {
    const { groups } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const f = groups.isosurfaceGroup.field;
    if (patch.origin) f.origin = patch.origin;
    if (patch.voxel) f.voxel = patch.voxel;
    if ('periodic' in patch) f.periodic = patch.periodic;
    requestRender();
  }, patch);
  const changed = (prev) => (s) => s.toFrac.some((v, k) => Math.abs(v - prev.toFrac[k]) > 1e-9);

  await edit({ origin: [1.4, 1.0, 3.0] });
  let after = await waitForTracer(changed(before));
  H.check('DW-4.2 changing only field.origin re-encodes (world->grid translation moves)',
    changed(before)(after) && near(after.min[0], 1.4 / a[0], 1e-5), JSON.stringify({ before: before.min, after: after.min }));

  before = after;
  await edit({ voxel: [[0.25, 0, 0], [0, step, 0], [0, 0, step]] });
  after = await waitForTracer(changed(before));
  H.check('DW-4.2 changing only field.voxel re-encodes', changed(before)(after), JSON.stringify({ before: before.toFrac, after: after.toFrac }));

  before = after;
  await edit({ periodic: true });
  after = await waitForTracer((s) => s.wrap === 0 && changed(before)(s));
  H.check('DW-4.2 flipping only the periodic flag re-encodes (spacing n vs n-1)', changed(before)(after),
    JSON.stringify({ before: before.toFrac[0], after: after.toFrac[0] }));

  // ---- periodic field: wrap modes are what they always were ------------------------
  const pn = 24;
  const periodic = {
    nx: pn, ny: pn, nz: pn, origin: [0, 0, 0], periodic: true,
    voxel: lattice.map((row) => row.map((v) => v / pn)),
  };
  await showField(periodic);
  let ps = await waitForTracer((s) => s.enabled === true && s.wrap === 0 && s.dims?.[0] === pn);
  H.check('periodic field at unit bounds: wrap 0, box = unit cell',
    ps.wrap === 0 && ps.min.every((v) => v === 0) && ps.max.every((v) => v === 1), JSON.stringify(ps));
  await setBounds(2);
  ps = await waitForTracer((s) => s.wrap === 1);
  H.check('periodic field at bounds [0,2]: wrap 1 (fold), box = display bounds', ps.wrap === 1 && ps.max[0] === 2, JSON.stringify(ps));
  // Wrapped sampling must still show the periodic image: more surface than at unit bounds.
  await waitForSamples(CONVERGED);

  // ---- Cleanup ----------------------------------------------------------------------
  await clearField();
  await setBounds(1);
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
