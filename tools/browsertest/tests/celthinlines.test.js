// Cel shading at the zoom levels where lines are one or two pixels wide:
// outlines, cell lines and hull shells must not stair-step.
//
// - Screen-space outlines are grown from edge pixels found in the depth
//   buffer, which knows an edge only to the pixel; along a shallow edge the
//   edge points followed the pixel staircase, and a thin line showed every
//   step. The pass now refines the edge points along each run of edge
//   pixels (CelOutlinePass.js REFINE_FRAGMENT): the upper outline of a bond
//   at 10° from horizontal must be straight to a fraction of a pixel.
// - The cell lines are cylinders of fixed world radius (0.015 Å): zoomed
//   out they fell below a pixel and broke up. They now keep a minimum width
//   on screen (LatticeModule.js syncLatticeLineWidth).
// - The 3D-hull shells (world width) likewise keep a minimum width on
//   screen (MaterialStyles.js syncCelHullPixelFloor).
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');
const fs = require('fs');

// Two Si atoms 2.35 Å apart, bonded, 10° above the x axis, centred in the cell.
const XYZ = ['2', 'Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3',
  'Si 2.843 3.794 4.0', 'Si 5.157 4.206 4.0'].join('\n');

const read = (file) => PNG.sync.read(fs.readFileSync(file));

/** Straightness of the bond's upper outline across the middle of the bond:
 *  per column, the ink-weighted centroid of the first inked run from the
 *  top (ink: dark grey/black, not the bond's blue), fitted by a line. */
function edgeStraightness(png, pxPerA) {
  const { width: w, height: h, data } = png;
  const px = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const ink = (x, y) => {
    const [r, g, b] = px(x, y);
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    return (b - r) < 80 ? Math.max(0, 160 - l) : 0;
  };
  const cx = Math.round(w / 2);
  let top = -1;
  for (let y = 0; y < h; y++) if (ink(cx, y) > 0) { top = y; break; }
  if (top < 0) return null;
  const res = [];
  const half = Math.round(0.42 * pxPerA);
  for (let x = cx - half; x <= cx + half; x++) {
    let y0 = -1;
    for (let y = top - 16; y <= top + 16; y++) if (ink(x, y) > 0) { y0 = y; break; }
    if (y0 < 0) continue;
    let sw = 0;
    let sy = 0;
    for (let y = y0 - 1; y <= y0 + 12; y++) { const d = ink(x, y); if (d === 0 && y > y0) break; sw += d; sy += d * y; }
    res.push([x, sy / sw]);
  }
  const n = res.length;
  const mx = res.reduce((a, r) => a + r[0], 0) / n;
  const my = res.reduce((a, r) => a + r[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of res) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  const slope = sxy / sxx;
  const b = my - slope * mx;
  let maxDev = 0;
  let rms = 0;
  for (const [x, y] of res) { const d = Math.abs(y - (slope * x + b)); maxDev = Math.max(maxDev, d); rms += d * d; }
  return { n, slope: +slope.toFixed(3), maxDev: +maxDev.toFixed(3), rms: +Math.sqrt(rms / n).toFixed(3) };
}

/** Length of the first ink run (dark grey/black, not the blue of the atoms
 *  and bonds) met walking from (x0, y0) in direction (dx, dy). */
function darkRun(png, x0, y0, dx, dy, threshold = 150) {
  const { width: w, data } = png;
  const ink = (x, y) => {
    const i = (y * w + x) * 4;
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return l < threshold && (data[i + 2] - data[i]) < 80;
  };
  const lum = (x, y) => { const i = (y * w + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  let x = x0;
  let y = y0;
  for (let k = 0; k < 600; k++, x += dx, y += dy) if (ink(x, y)) break;
  let run = 0;
  let darkest = 255;
  for (let k = 0; k < 40; k++, x += dx, y += dy) { if (ink(x, y)) { run++; darkest = Math.min(darkest, lum(x, y)); } else break; }
  return { run, darkest };
}

// Zoom relative to the fitted view (setViewDirection's refit keeps camera.zoom).
const setZoom = (page, factor) => page.evaluate(async (factor) => {
  (await import('./ui/WindowAndSceneControls.js')).setViewDirection([0, 0, 1], { refit: true });
  const { app, general } = await import('./state/store.js');
  if (window.__fitZoom == null) window.__fitZoom = app.camera.zoom;
  app.camera.zoom = window.__fitZoom * factor;
  app.camera.updateProjectionMatrix();
  (await import('./render/AnimateModule.js')).requestRender();
  const h = app.renderer.domElement.height;
  const pxPerA = (h * app.camera.zoom) / (app.camera.top - app.camera.bottom);
  return { pxPerA, radiusPx: general.celOutlineWidth * pxPerA };
}, factor).then(async (r) => { await page.waitForTimeout(900); return r; });

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'bond.xyz'), XYZ);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const t = document.getElementById('showLattice'); if (t && t.checked) t.click(); });
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(400);
  await H.setSelect(page, 'renderStyleMenu', 'cel');
  await page.waitForTimeout(600);
  await H.setSelect(page, 'celOutlineModeMenu', 'screen');
  await page.waitForTimeout(300);
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).closePanel('visual'));

  // --- screen-space outline, one to two pixels wide -----------------------------
  for (const [factor, maxRms, maxDev] of [[1, 0.12, 0.28], [2, 0.1, 0.26]]) {
    const z = await setZoom(page, factor);
    const straight = edgeStraightness(read(await H.shotCanvas(page, `celthin_screen_z${factor}`)), z.pxPerA);
    // Before the refinement: rms 0.15 / max 0.35 (zoom 1), 0.16 / 0.33 (zoom 2).
    H.check(`screen space, ${z.radiusPx.toFixed(1)} px line: a shallow edge is straight to a fraction of a pixel (was stair-stepped)`,
      straight && straight.n > 20 && Math.abs(straight.slope + 0.178) < 0.02 && straight.rms < maxRms && straight.maxDev < maxDev,
      JSON.stringify({ z, straight }));
  }

  // --- cell lines zoomed far out keep a minimum width ----------------------------
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.showLattice = true;
    (await import('./render/LatticeModule.js')).updateLattice();
  });
  const zc = await setZoom(page, 0.35);
  const cellPng = read(await H.shotCanvas(page, 'celthin_cell'));
  // The cell's bottom edge below the structure, walked upward from the
  // bottom of the frame along the centre column.
  const cellRun = darkRun(cellPng, Math.round(cellPng.width / 2), cellPng.height - 2, 0, -1, 200);
  // 0.015 Å at this zoom is under half a pixel; the floor makes it ~1.2 px
  // plus antialiasing (2 or more dark-ish pixels).
  H.check('cell lines far out keep a minimum width (two dark pixels across, were under one)',
    zc.pxPerA * 0.015 < 0.5 && cellRun.run >= 2, JSON.stringify({ zc, cellRun }));

  // --- 3D-hull shells zoomed far out keep a minimum width -------------------------
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.showLattice = false;
    (await import('./render/LatticeModule.js')).updateLattice();
  });
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(300);
  await H.setSelect(page, 'celOutlineModeMenu', 'hull');
  await page.waitForTimeout(400);
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).closePanel('visual'));
  const zh = await setZoom(page, 0.35);
  const hullPng = read(await H.shotCanvas(page, 'celthin_hull'));
  // The left atom's left edge: walked rightward along the row through its centre.
  const cy = Math.round(hullPng.height / 2 + 0.206 * zh.pxPerA);
  const hullRun = darkRun(hullPng, 1, cy, 1, 0, 150);
  // 0.025 Å at this zoom is 0.3 px: a faint grey pixel; with the floor the
  // shell is three quarters of a pixel wide and reads as a dark line.
  H.check('3D hull shells far out keep a minimum width (a dark pixel across, was faint grey)',
    zh.pxPerA * 0.025 < 0.6 && hullRun.run >= 1 && hullRun.darkest < 80, JSON.stringify({ zh, cy, hullRun }));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
