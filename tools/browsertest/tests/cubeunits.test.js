// Gaussian cube header units (io/cubeParse.js + io/ReadCubeModule.js). A
// positive grid count means Bohr, a negative one Angstrom with the grid size
// |N|. Guards the Angstrom case, which once produced an inverted lattice and
// then crashed allocating a negative-length grid, and a negative atom count,
// whose dataset-id line was once read as density.
'use strict';
const H = require('../harness');

const BOHR = 0.529177210544;
const GRID = [4, 4, 4];

// One water molecule in a 4x4x4 grid of 0.75 Bohr steps, written in `units`.
const cube = (units, { mos = null } = {}) => {
  const k = units === 'angstrom' ? BOHR : 1;
  const sign = units === 'angstrom' ? -1 : 1;
  const f = (v) => (v * k).toFixed(6);
  const nval = mos ? mos.length : 1;
  const data = [];
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      const row = [];
      for (let z = 0; z < 4; z++) {
        for (let d = 0; d < nval; d++) row.push((x + y + z + 10 * d) / 10);
      }
      data.push(row.map((v) => v.toExponential(5)).join(' '));
    }
  }
  return [
    'water', 'cubeunits test',
    `${mos ? -3 : 3} ${f(0)} ${f(0)} ${f(0)}`,
    `${sign * 4} ${f(0.75)} ${f(0)} ${f(0)}`,
    `${sign * 4} ${f(0)} ${f(0.75)} ${f(0)}`,
    `${sign * 4} ${f(0)} ${f(0)} ${f(0.75)}`,
    `8 8.0 ${f(1.5)} ${f(1.5)} ${f(1.7)}`,
    `1 1.0 ${f(1.5)} ${f(2.9)} ${f(0.6)}`,
    `1 1.0 ${f(1.5)} ${f(0.1)} ${f(0.6)}`,
    ...(mos ? [`${mos.length} ${mos.join(' ')}`] : []),
    ...data,
  ].join('\n');
};

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const cases = {
    bohr: cube('bohr'),
    angstrom: cube('angstrom'),
    orbitals: cube('angstrom', { mos: [4, 5] }),
  };

  const res = await page.evaluate(async (cases) => {
    const cv = await import('./core/crystal-viewer.js');
    const out = {};
    for (const [name, text] of Object.entries(cases)) {
      const loaded = await cv.loadStructure(text, `${name}.cube`);
      const s = loaded.container?.structures?.[0];
      const fields = s?.volumetricFields?.fields ?? [];
      out[name] = {
        ok: loaded.ok,
        lattice: s?.lattice,
        elements: s?.elements,
        positions: s?.atoms.map((a) => a.position),
        fields: fields.map((f) => ({
          grid: [f.nx, f.ny, f.nz], label: f.label,
          values: Array.from(f.values.slice(0, 8)), max: f.maxValue,
        })),
      };
    }
    return out;
  }, cases);

  const near = (a, b, tol = 1e-5) => Math.abs(a - b) < tol;
  const a = 4 * 0.75 * BOHR; // 1.5875 Angstrom
  const latticeOk = (r) => r.lattice && r.lattice.every((row, i) => row.every((v, j) => near(v, i === j ? a : 0)));
  const samePositions = (p, q) => p.every((pos, i) => pos.every((v, k) => near(v, q[i][k])));

  H.check('Bohr cube loads', res.bohr.ok === true, JSON.stringify(res.bohr).slice(0, 300));
  H.check('Bohr grid counts scale by Bohr -> Angstrom', latticeOk(res.bohr), JSON.stringify(res.bohr.lattice));
  H.check('Angstrom cube (negative grid counts) loads', res.angstrom.ok === true, JSON.stringify(res.angstrom).slice(0, 300));
  H.check('Angstrom lattice is positive and unscaled', latticeOk(res.angstrom), JSON.stringify(res.angstrom.lattice));
  H.check('Angstrom grid size is |N|', JSON.stringify(res.angstrom.fields.map((f) => f.grid)) === JSON.stringify([GRID]),
    JSON.stringify(res.angstrom.fields));
  H.check('both units give the same atoms',
    JSON.stringify(res.bohr.elements) === JSON.stringify(['O', 'H', 'H'])
      && JSON.stringify(res.angstrom.elements) === JSON.stringify(['O', 'H', 'H'])
      && samePositions(res.angstrom.positions, res.bohr.positions),
    JSON.stringify([res.bohr.positions, res.angstrom.positions]));
  H.check('both units give the same field values',
    JSON.stringify(res.bohr.fields[0].values) === JSON.stringify(res.angstrom.fields[0].values),
    JSON.stringify([res.bohr.fields[0].values, res.angstrom.fields[0].values]));
  H.check('negative atom count: one field per orbital, labelled by id',
    res.orbitals.ok === true && res.orbitals.fields.length === 2
      && res.orbitals.fields[0].label.endsWith('(MO 4)') && res.orbitals.fields[1].label.endsWith('(MO 5)'),
    JSON.stringify(res.orbitals.fields.map((f) => f.label)));
  H.check('negative atom count: orbitals are de-interleaved, ids not read as data',
    near(res.orbitals.fields[0].values[0], 0) && near(res.orbitals.fields[1].values[0], 1)
      && near(res.orbitals.fields[0].max, 0.9) && near(res.orbitals.fields[1].max, 1.9),
    JSON.stringify(res.orbitals.fields));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
