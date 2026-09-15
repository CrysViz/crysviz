// POSCAR scale line (io/ReadPOSCARModule.js). VASP convention: a positive
// value multiplies the lattice vectors AND Cartesian coordinates; a negative
// value is the target cell volume, so the linear factor is the cube root of
// target / unscaled volume. Guards the negative-scale support that was once
// silently overwritten, the volume-ratio-without-cube-root bug it shipped
// with, and Cartesian positions that were never scaled at all.
'use strict';
const H = require('../harness');

// NaCl-like two-atom cell; `scale`, `lattice` rows and coordinate mode vary.
const poscar = (scale, lattice, mode, cl) => [
  'test cell',
  String(scale),
  ...lattice.map((r) => r.join(' ')),
  'Na Cl',
  '1 1',
  mode,
  '0 0 0',
  cl.join(' '),
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const cases = {
    unit: poscar(1, [[4, 0, 0], [0, 4, 0], [0, 0, 4]], 'Direct', [0.5, 0.5, 0.5]),
    scaled: poscar(2, [[2, 0, 0], [0, 2, 0], [0, 0, 2]], 'Direct', [0.5, 0.5, 0.5]),
    // Target volume 64 on a unit cube: a = cbrt(64) = 4 (the plain ratio gave 64).
    volumeUnit: poscar(-64, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 'Direct', [0.5, 0.5, 0.5]),
    // Target volume 64 on V0 = 8: linear factor cbrt(8) = 2 -> a = 4.
    volumeCube: poscar(-64, [[2, 0, 0], [0, 2, 0], [0, 0, 2]], 'Direct', [0.5, 0.5, 0.5]),
    // Skewed cell: the volume must land on the target, the shape must not change.
    volumeSkew: poscar(-100, [[3, 0, 0], [1.5, 2.6, 0], [0.5, 0.5, 4]], 'Direct', [0.25, 0.25, 0.25]),
    // Cartesian positions are in scaled units: (1,1,1) * 2 in a 4 Å cube = frac 0.5.
    cartScaled: poscar(2, [[2, 0, 0], [0, 2, 0], [0, 0, 2]], 'Cartesian', [1, 1, 1]),
    // Same with a target volume: factor 2 again.
    cartVolume: poscar(-64, [[2, 0, 0], [0, 2, 0], [0, 0, 2]], 'Cartesian', [1, 1, 1]),
  };

  const res = await page.evaluate(async (cases) => {
    const { readPOSCAR } = await import('./io/ReadPOSCARModule.js');
    const vol = (m) => Math.abs(
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]));
    const out = {};
    for (const [name, text] of Object.entries(cases)) {
      const s = readPOSCAR(text, `${name}.vasp`);
      out[name] = { lattice: s.lattice, volume: vol(s.lattice), cl: s.atoms[1].position };
    }
    // End to end through the normal load path.
    const cv = await import('./core/crystal-viewer.js');
    const loaded = await cv.loadStructure(cases.volumeUnit, 'POSCAR');
    out.loaded = { ok: loaded.ok, volume: vol(loaded.container.structures[0].lattice) };
    return out;
  }, cases);

  const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
  const cubeA = (r) => r.lattice[0][0];
  const clHalf = (r) => r.cl.every((v) => near(v, 0.5));

  H.check('scale 1 leaves the lattice as written', near(cubeA(res.unit), 4), JSON.stringify(res.unit.lattice));
  H.check('positive scale multiplies the lattice', near(cubeA(res.scaled), 4), JSON.stringify(res.scaled.lattice));
  H.check('negative scale is a target volume (cube root: unit cube -> a = 4)',
    near(res.volumeUnit.volume, 64) && near(cubeA(res.volumeUnit), 4), JSON.stringify(res.volumeUnit));
  H.check('negative scale on V0 = 8 -> linear factor 2, a = 4',
    near(res.volumeCube.volume, 64) && near(cubeA(res.volumeCube), 4), JSON.stringify(res.volumeCube));
  const skewRatio = res.volumeSkew.lattice[1][0] / res.volumeSkew.lattice[0][0];
  H.check('skewed cell reaches the target volume with its shape kept',
    near(res.volumeSkew.volume, 100) && near(skewRatio, 0.5), JSON.stringify(res.volumeSkew));
  H.check('fractional positions are unaffected by the scale', clHalf(res.volumeUnit) && clHalf(res.scaled), JSON.stringify([res.volumeUnit.cl, res.scaled.cl]));
  H.check('Cartesian positions are scaled with the lattice (positive scale)', clHalf(res.cartScaled), JSON.stringify(res.cartScaled));
  H.check('Cartesian positions are scaled with the lattice (target volume)', clHalf(res.cartVolume), JSON.stringify(res.cartVolume));
  H.check('negative-scale POSCAR loads end to end', res.loaded.ok === true && near(res.loaded.volume, 64), JSON.stringify(res.loaded));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
