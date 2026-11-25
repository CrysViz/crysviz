// Gaussian cube files through the real loader (core/crystal-viewer.js
// loadStructure → formats.js → io/ReadCubeModule.js → the field panel and the
// marching-cubes isosurface).
//
// The main case is a synthetic Gaussian blob written with NEGATIVE grid counts
// (Å units) and a `.cub` name — the two things the old reader got wrong (it
// multiplied the axes by the signed count, flipping the cell) or did not
// recognise. The node unit tests (tools/unittest/cubereader.test.mjs,
// cubeparse.test.mjs) pin the parser in detail; this checks that its output
// drives the app: the field label from the comment lines, the atoms, a
// right-handed cell, the Field unit and periodicity flags (atoms inside the
// grid: periodic, no dialog), and an isosurface that actually renders. Two of the unit
// fixtures (a Gradient cube and an orbital cube) check the multi-field paths.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
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

const UNIT_FIXTURES = path.join(__dirname, '..', '..', 'unittest', 'fixtures', 'cube');
const fixture = (name) => fs.readFileSync(path.join(UNIT_FIXTURES, name), 'utf8');

/** A 24³ Gaussian blob in a 6 Å box, Å units (negative counts), 2 atoms. */
function blobCube() {
  const n = 24;
  const step = 0.25;
  const f = (x) => x.toFixed(6).padStart(12);
  const e = (x) => x.toExponential(5).toUpperCase().padStart(13);
  const lines = [
    ' Synthetic blob',
    ' Electron density from Total SCF Density',
    `    2${f(-3)}${f(-3)}${f(-3)}    1`,
    `  -${n}${f(step)}${f(0)}${f(0)}`,
    `  -${n}${f(0)}${f(step)}${f(0)}`,
    `  -${n}${f(0)}${f(0)}${f(step)}`,
    `    8${f(8)}${f(0)}${f(0)}${f(0)}`,
    `    1${f(1)}${f(0.9)}${f(0)}${f(0)}`,
  ];
  const c = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const rec = [];
      for (let k = 0; k < n; k++) {
        const r2 = ((i - c) ** 2 + (j - c) ** 2 + (k - c) ** 2) * step * step;
        rec.push(Math.exp(-r2 / 2));
      }
      for (let s = 0; s < rec.length; s += 6) lines.push(rec.slice(s, s + 6).map(e).join(''));
    }
  }
  return lines.join('\n') + '\n';
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));

  const load = (text, name) => page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, groups } = await import('./state/store.js');
    const { detectFormat, headOf } = await import('./io/index.js');
    await cv.loadStructure(text, name);
    const s = fileBrowser.selectedStructure;
    const vf = s?.volumetricFields;
    const iso = groups.isosurfaceGroup;
    return {
      detected: detectFormat({ fileName: name, head: headOf(text) }).id,
      atoms: s?.atoms?.length ?? 0,
      elements: s?.elements ?? [],
      lattice: s?.lattice ?? null,
      source: vf?.source ?? null,
      fields: (vf?.fields ?? []).map((f) => ({
        label: f.label, valueUnit: f.valueUnit, periodic: f.periodic, n: [f.nx, f.ny, f.nz],
        max: f.maxValue, voxel: f.voxel,
      })),
      activeLabel: groups.activeField?.label ?? null,
      posVerts: iso?.meshes?.positive?.geometry?.attributes?.position?.count ?? 0,
      inScene: !!iso?.parent,
    };
  }, { text, name });

  // --- the blob: Å units, .cub name ------------------------------------------
  const blob = await load(blobCube(), 'blob.cub');
  await page.waitForTimeout(1000);
  H.check('a .cub file is detected as a cube', blob.detected === 'cube', blob.detected);
  H.check('two atoms, O and H', blob.atoms === 2 && blob.elements.join(',') === 'O,H', JSON.stringify(blob.elements));
  const lat = blob.lattice || [];
  H.check('Å axes are not flipped: lattice = +6 Å along each axis',
    Math.abs(lat[0]?.[0] - 6) < 1e-6 && Math.abs(lat[1]?.[1] - 6) < 1e-6 && Math.abs(lat[2]?.[2] - 6) < 1e-6,
    JSON.stringify(lat));
  const [f0] = blob.fields;
  H.check('one field, labelled from the comment lines', blob.fields.length === 1
    && f0.label === 'Synthetic blob Electron density from Total SCF Density', JSON.stringify(blob.fields.map((f) => f.label)));
  H.check('cube field carries valueUnit e/bohr³ and is periodic (atoms inside the grid)',
    f0?.valueUnit === 'e/bohr³' && f0?.periodic === true, JSON.stringify(f0));
  H.check('container source is Cube', blob.source === 'Cube', blob.source);
  H.check('the field is active and its isosurface has vertices',
    blob.activeLabel === f0?.label && blob.posVerts > 0 && blob.inScene, JSON.stringify({ a: blob.activeLabel, v: blob.posVerts }));
  // Pixels, not just a mesh: the same view with the isosurface group hidden
  // must differ substantially from the one with it shown.
  const setIsoVisible = (visible) => page.evaluate(async (visible) => {
    const { groups } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    if (groups.isosurfaceGroup) groups.isosurfaceGroup.visible = visible;
    requestRender();
  }, visible);
  const withIso = await H.shotCanvas(page, 'cube-blob');
  await setIsoVisible(false);
  await page.waitForTimeout(800);
  const withoutIso = await H.shotCanvas(page, 'cube-blob-hidden');
  await setIsoVisible(true);
  const delta = changedPixelCount(withIso, withoutIso);
  H.check('the blob isosurface is drawn', delta > 500, JSON.stringify({ delta }));

  // --- Gradient cube: four fields -------------------------------------------
  const grad = await load(fixture('gradient_nval4.cube'), 'grad.cube');
  H.check('NVal = 4 gradient cube gives Density, ∂ρ/∂x, ∂ρ/∂y, ∂ρ/∂z',
    JSON.stringify(grad.fields.map((f) => f.label.replace(/^.*\((.*)\)$/, '$1')))
      === JSON.stringify(['Density', '∂ρ/∂x', '∂ρ/∂y', '∂ρ/∂z']),
    JSON.stringify(grad.fields.map((f) => f.label)));
  H.check('only the density of a gradient cube has a unit',
    JSON.stringify(grad.fields.map((f) => f.valueUnit)) === JSON.stringify(['e/bohr³', null, null, null]),
    JSON.stringify(grad.fields.map((f) => f.valueUnit)));

  // --- orbital cube: one field per MO ---------------------------------------
  const mo = await load(fixture('mo_two_orbitals.cube'), 'orbitals.cube');
  H.check('orbital cube gives MO 5 and MO 6',
    JSON.stringify(mo.fields.map((f) => f.label)) === '["MO test MO coefficients (MO 5)","MO test MO coefficients (MO 6)"]',
    JSON.stringify(mo.fields.map((f) => f.label)));
  H.check('orbital cube container says so', mo.source === 'Cube (orbitals)', mo.source);

  // --- a truncated file is refused, not half-loaded -------------------------
  const truncated = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    try {
      await cv.loadStructure(text, 'truncated.cube');
      return 'loaded';
    } catch (e) {
      return String(e?.message || e);
    }
  }, fixture('truncated.cube'));
  H.check('a truncated cube is refused with a clear error', /expected 24 data values/.test(truncated), truncated);
  // loadStructure reports load failures on the console too; those are expected here.
  const unexpected = errors.filter((e) => !/truncated|expected 24 data values/.test(e));

  H.check('no page errors', unexpected.length === 0, unexpected.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
