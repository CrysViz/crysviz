// Raster isosurface of a BLOCK field (field.periodic === false): a finite grid
// with an origin that fills only part of the structure cell. Synthetic fields
// are attached to the default YBCO structure through the real field path
// (setActiveField + updateField). The values are a crisp box (1 inside index
// [2, n-3] on every axis, 0 outside), so the iso = 0.5 surface sits exactly on
// the half-edges 1.5 and n-2.5 and the mesh bounding box is known to the
// voxel. Asserts (DW-2.2) the block is drawn at origin + i*step, (DW-2.3) it
// is not cut at unit bounds when it crosses a cell face and that widened
// bounds repeat it with the structure lattice, (DW-2.4) a periodic field's
// matrix and copies are what they always were, and (DW-2.6) the own-cell
// shortcut rules.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Pixels that differ substantially between two screenshots. */
function changedPixelCount(fileA, fileB) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > 90) n++;
  }
  return n;
}

const nearVec = (a, b, eps) => a.every((x, k) => Math.abs(x - b[k]) <= eps);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO, orthorhombic
  await page.waitForTimeout(500);
  const baseline = await H.shotCanvas(page, 'fieldblock-nofield');

  const lattice = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    return fileBrowser.selectedStructure.lattice;
  });
  const [a, b, c] = lattice;

  /**
   * Build a box-valued field in the page and drive it through the real field
   * path. `voxel` rows are the step vectors; `n` points per axis.
   * @returns {Promise<any>} scene facts about the live isosurface
   */
  async function showField({ n, voxel, origin, periodic }) {
    return page.evaluate(async ({ n, voxel, origin, periodic }) => {
      const { Field } = await import('./model/index.js');
      const { groups } = await import('./state/store.js');
      const { setActiveField, updateField, requestRender } = await import('./render/index.js');
      const values = new Float32Array(n * n * n);
      const inside = (i) => i >= 2 && i <= n - 3;
      for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        values[i + n * (j + n * k)] = inside(i) && inside(j) && inside(k) ? 1 : 0;
      }
      const field = new Field({
        nx: n, ny: n, nz: n, origin, voxel, values, periodic,
        isoValue: 0.5, minValue: 0, maxValue: 1, useAbsoluteIsoValue: false,
      });
      setActiveField(field, false);
      updateField(0.5);
      requestRender();
      const iso = groups.isosurfaceGroup;
      return { verts: iso?.meshes?.positive?.geometry?.attributes?.position?.count ?? 0, inScene: !!iso?.parent };
    }, { n, voxel, origin, periodic });
  }

  /** World-space bounding boxes of the base positive mesh and every image mesh, plus clip/copy state. */
  async function isoState() {
    return page.evaluate(async () => {
      const { groups } = await import('./state/store.js');
      const iso = groups.isosurfaceGroup;
      iso.updateMatrixWorld(true);
      const worldBox = (mesh) => {
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        return { min: box.min.toArray(), max: box.max.toArray() };
      };
      const planes = iso.meshes.positive.material.clippingPlanes;
      return {
        matrix: iso.matrix.toArray(),
        base: worldBox(iso.meshes.positive),
        basePosition: iso.meshes.positive.position.toArray(),
        images: iso._imageMeshes.filter((m) => m.userData.fieldLobe === 'positive').map((m) => ({
          box: worldBox(m), position: m.position.toArray(),
        })),
        imageCount: iso._imageMeshes.length,
        planeCount: planes?.length ?? 0,
        planes: (planes ?? []).map((p) => ({ normal: p.normal.toArray(), constant: p.constant })),
        ownCell: iso._latticeIsOwnCell(),
      };
    });
  }

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

  // ---- DW-2.2: a block inside the cell, origin != 0, grid smaller than the cell
  const n = 12, step = 0.2;
  const stepVoxel = [[step, 0, 0], [0, step, 0], [0, 0, step]];
  const origin = [1.0, 1.0, 3.0];
  const built = await showField({ n, voxel: stepVoxel, origin, periodic: false });
  H.check('block: marching cubes produced a mesh in the scene', built.verts > 0 && built.inScene, JSON.stringify(built));
  let s = await isoState();
  // Surface at half-edges: point 1.5 and n-2.5, i.e. origin + 1.5*step .. origin + 9.5*step.
  const expMin = origin.map((o) => o + 1.5 * step);
  const expMax = origin.map((o) => o + (n - 2.5) * step);
  H.check('DW-2.2 block mesh bounding box at origin + i*step (within half a voxel)',
    nearVec(s.base.min, expMin, step / 2) && nearVec(s.base.max, expMax, step / 2),
    JSON.stringify({ got: s.base, expMin, expMax }));
  H.check('DW-2.2 group matrix = voxel*(n-1) columns plus the origin translation',
    nearVec(s.matrix.slice(0, 3), [step * (n - 1), 0, 0], 1e-9)
      && nearVec(s.matrix.slice(12, 15), origin, 1e-9),
    JSON.stringify(s.matrix));
  await page.waitForTimeout(600);
  const blockShot = await H.shotCanvas(page, 'fieldblock-block');
  const blockDelta = changedPixelCount(baseline, blockShot);
  H.check('DW-2.2 the block is visibly drawn (raster)', blockDelta > 200, JSON.stringify({ blockDelta }));

  // ---- DW-2.3: a block crossing the +a cell face
  const crossOrigin = [a[0] - 1.0, 1.0, 3.0]; // world x from a-0.7 to a+0.9 (surface), grid reaches a+1.2
  await showField({ n, voxel: stepVoxel, origin: crossOrigin, periodic: false });
  s = await isoState();
  H.check('DW-2.3 unit bounds: block not cut at the cell face (no clipping planes, no images, bbox past the face)',
    s.planeCount === 0 && s.imageCount === 0 && s.base.max[0] > a[0] + 0.5 && s.ownCell === false,
    JSON.stringify({ planeCount: s.planeCount, imageCount: s.imageCount, maxX: s.base.max[0], a: a[0], ownCell: s.ownCell }));

  await setBounds(2);
  s = await isoState();
  // Block spans cell fractions ~[0.82, 1.24] along a; bounds [0,2] need n = -1, 0, +1.
  const crossMin = crossOrigin.map((o) => o + 1.5 * step);
  const copies = [s.base, ...s.images.map((im) => im.box)];
  const offsets = copies.map((box) => Math.round((box.min[0] - crossMin[0]) / a[0]));
  const exact = copies.every((box, i) => nearVec(box.min, [crossMin[0] + offsets[i] * a[0], crossMin[1], crossMin[2]], 1e-3));
  H.check('DW-2.3 widened bounds [0,2]: copies at -a, 0, +a of the structure lattice, clipped',
    s.imageCount === 4 && exact && [...offsets].sort().join(',') === '-1,0,1' && s.planeCount === 6,
    JSON.stringify({ imageCount: s.imageCount, offsets, exact, planeCount: s.planeCount }));

  // A block spanning more than one cell along a: 51 points * 0.2 = 10 A > a = 3.8 A.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.periodicBounds = { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 };
  });
  {
    const wide = 51;
    await page.evaluate(async ({ wide, step, origin }) => {
      const { Field } = await import('./model/index.js');
      const { setActiveField, updateField } = await import('./render/index.js');
      const values = new Float32Array(wide * 12 * 12).fill(0);
      for (let k = 2; k <= 9; k++) for (let j = 2; j <= 9; j++) for (let i = 2; i <= wide - 3; i++) {
        values[i + wide * (j + 12 * k)] = 1;
      }
      const field = new Field({
        nx: wide, ny: 12, nz: 12, origin, voxel: [[step, 0, 0], [0, step, 0], [0, 0, step]], values,
        periodic: false, isoValue: 0.5, minValue: 0, maxValue: 1, useAbsoluteIsoValue: false,
      });
      setActiveField(field, false);
      updateField(0.5);
    }, { wide, step, origin: [-1, 1, 3] });
    await setBounds(1);
    s = await isoState();
    H.check('block spanning more than one cell at unit bounds: drawn once, whole',
      s.imageCount === 0 && s.planeCount === 0, JSON.stringify({ imageCount: s.imageCount, planeCount: s.planeCount }));
    await setBounds(1.5);
    s = await isoState();
    // Extent along a: [-1, 9] A = fractions [-0.26, 2.36]; images -2 .. 1 reach into [0, 1.5].
    const wideMin = [-1 + 1.5 * step, 1 + 1.5 * step, 3 + 1.5 * step];
    const wideCopies = [s.base, ...s.images.map((im) => im.box)];
    const wideOffsets = wideCopies.map((box) => Math.round((box.min[0] - wideMin[0]) / a[0]));
    H.check('block spanning more than one cell, widened bounds: every image reaching into the bounds is drawn',
      s.imageCount === 6 && [...wideOffsets].sort((x, y) => x - y).join(',') === '-2,-1,0,1' && s.planeCount === 6,
      JSON.stringify({ imageCount: s.imageCount, wideOffsets, planeCount: s.planeCount }));
  }

  // ---- DW-2.4: a periodic field is exactly what it always was
  const pn = 24;
  const periodicVoxel = lattice.map((row) => row.map((v) => v / pn));
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.periodicBounds = { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 };
  });
  await showField({ n: pn, voxel: periodicVoxel, origin: [0, 0, 0], periodic: true });
  await setBounds(1);
  s = await isoState();
  // Today's matrix: columns voxel_k * n_k (== the lattice vectors), no translation.
  const todays = [
    ...periodicVoxel[0].map((v) => v * pn), 0,
    ...periodicVoxel[1].map((v) => v * pn), 0,
    ...periodicVoxel[2].map((v) => v * pn), 0,
    0, 0, 0, 1,
  ];
  H.check('DW-2.4 periodic group matrix == voxel*n, no translation; own cell; no images/clipping at unit bounds',
    nearVec(s.matrix, todays, 1e-9) && s.ownCell === true && s.imageCount === 0 && s.planeCount === 0,
    JSON.stringify({ matrix: s.matrix, todays, ownCell: s.ownCell, imageCount: s.imageCount, planeCount: s.planeCount }));
  await setBounds(2);
  s = await isoState();
  H.check('DW-2.4 periodic [0,2]: one extra copy per lobe at local (1,0,0), 6 clipping planes',
    s.imageCount === 2 && nearVec(s.basePosition, [0, 0, 0], 1e-9)
      && s.images.length === 1 && nearVec(s.images[0].position, [1, 0, 0], 1e-9) && s.planeCount === 6,
    JSON.stringify({ imageCount: s.imageCount, basePosition: s.basePosition, images: s.images.map((i) => i.position), planeCount: s.planeCount }));
  await setBounds(1, -0.5);
  s = await isoState();
  H.check('DW-2.4 periodic [-0.5,1]: base takes the -1 cell, one copy at 0 (today\'s rule)',
    s.imageCount === 2 && nearVec(s.basePosition, [-1, 0, 0], 1e-9)
      && nearVec(s.images[0].position, [0, 0, 0], 1e-9),
    JSON.stringify({ imageCount: s.imageCount, basePosition: s.basePosition, images: s.images.map((i) => i.position) }));

  // ---- DW-2.6: the own-cell shortcut
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.periodicBounds = { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 };
  });
  const cellVoxel = lattice.map((row) => row.map((v) => v / (n - 1))); // (n-1)*step == the cell
  await showField({ n, voxel: cellVoxel, origin: [0.5, 0, 0], periodic: false });
  await setBounds(1);
  s = await isoState();
  H.check('DW-2.6 block whose grid equals the cell with a non-zero origin is NOT own cell',
    s.ownCell === false && nearVec(s.matrix.slice(0, 3), a, 1e-9) && nearVec(s.matrix.slice(12, 15), [0.5, 0, 0], 1e-9),
    JSON.stringify({ ownCell: s.ownCell, matrix: s.matrix }));

  await showField({ n, voxel: cellVoxel, origin: [0, 0, 0], periodic: false });
  await setBounds(1);
  s = await isoState();
  H.check('DW-2.6 block with grid == cell and zero origin is still not own cell (blocks take the range path)',
    s.ownCell === false, JSON.stringify({ ownCell: s.ownCell }));

  // Missing lattice: falls back to the block's own cell, no errors.
  const missing = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const iso = groups.isosurfaceGroup;
    try {
      iso.setPeriodicBounds([[0, 1.5], [0, 1], [0, 1]], null);
    } catch (e) {
      return { error: String(e) };
    }
    const planes = iso.meshes.positive.material.clippingPlanes ?? [];
    const nearX = planes.find((p) => p.normal.x > 0.99);
    return {
      ownCell: iso._latticeIsOwnCell(),
      imageCount: iso._imageMeshes.length,
      imagePosition: iso._imageMeshes[0]?.position.toArray(),
      planeCount: planes.length,
      nearXConstant: nearX?.constant,
    };
  });
  H.check('DW-2.6 missing lattice: own cell, integer image offsets, 6 planes, no error',
    !missing.error && missing.ownCell === true && missing.imageCount === 2
      && nearVec(missing.imagePosition, [1, 0, 0], 1e-9) && missing.planeCount === 6,
    JSON.stringify(missing));

  // The same fallback with a displaced block: the clip box starts at the field origin, not the world origin.
  await showField({ n, voxel: cellVoxel, origin: [0.5, 0, 0], periodic: false });
  const displaced = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const iso = groups.isosurfaceGroup;
    iso.setPeriodicBounds([[0, 1.5], [0, 1], [0, 1]], null);
    const planes = iso.meshes.positive.material.clippingPlanes ?? [];
    const nearX = planes.find((p) => p.normal.x > 0.99);
    // Near face keeps nr.x >= lo*span - 1e-3 -> plane constant = -(0.5 - 1e-3) once translated by the origin.
    return { nearXConstant: nearX?.constant, planeCount: planes.length };
  });
  H.check('missing lattice + displaced block: clipping box anchored at the field origin',
    displaced.planeCount === 6 && Math.abs(displaced.nearXConstant + 0.5) < 2e-3, JSON.stringify(displaced));

  // ---- Cleanup
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { clearField, requestRender } = await import('./render/index.js');
    general.periodicBounds = { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 };
    clearField();
    requestRender();
  });

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
