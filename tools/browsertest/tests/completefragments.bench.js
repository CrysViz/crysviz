// Cost of "Complete Rings & Fragments" in periodicWrapped, against the plain boundary
// set and Neighbour Bonds, on two large cells: a benzene crystal (finite
// molecules) and a graphite supercell (rings in an extended network). Prints the
// median of several runs per path; opt-in (`.bench.js`), run by hand:
//   tools/browsertest/run.sh tests/completefragments.bench.js
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const results = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { periodicWrapped } = await import('./render/index.js');

    // Benzene on the edge of an 8 Å box, repeated n×n×n.
    const benzene = (n) => {
      const L = 8, frac = [], elements = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
        for (const [r, el] of [[1.39, 'C'], [2.48, 'H']]) {
          for (let m = 0; m < 6; m++) {
            const t = Math.PI / 3 * m;
            const x = (i * L + r * Math.cos(t)) / (n * L), y = (j * L + r * Math.sin(t)) / (n * L);
            frac.push([x - Math.floor(x), y - Math.floor(y), (k + 0.5) / n]);
            elements.push(el);
          }
        }
      }
      return {
        frac, elements, lattice: [[n * L, 0, 0], [0, n * L, 0], [0, 0, n * L]],
        bondLengths: { 'C-C': { min: 0, max: 1.6 }, 'C-H': { min: 0, max: 1.2 }, 'H-H': { min: 0, max: 0 } },
      };
    };
    // AB graphite, n×n×m.
    const graphite = (n, m) => {
      const base = [[0, 0, 0.25], [0, 0, 0.75], [1 / 3, 2 / 3, 0.25], [2 / 3, 1 / 3, 0.75]];
      const frac = [], elements = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < m; k++) {
        for (const b of base) { frac.push([(b[0] + i) / n, (b[1] + j) / n, (b[2] + k) / m]); elements.push('C'); }
      }
      return {
        frac, elements, lattice: [[2.464 * n, 0, 0], [-1.232 * n, 2.133887 * n, 0], [0, 0, 6.711 * m]],
        bondLengths: { 'C-C': { min: 0, max: 1.6 } },
      };
    };

    const time = (fn, reps = 5) => {
      const t = [];
      let out;
      for (let r = 0; r < reps; r++) { const t0 = performance.now(); out = fn(); t.push(performance.now() - t0); }
      t.sort((a, b) => a - b);
      return { ms: +t[Math.floor(reps / 2)].toFixed(1), drawn: out.elements.length };
    };

    const out = {};
    for (const [name, s] of [['benzene 10x10x10', benzene(10)], ['graphite 25x25x4', graphite(25, 4)]]) {
      const row = { atoms: s.elements.length };
      for (const wasm of [true, false]) {
        const opts = (extra) => ({
          ...general, showPeriodic: true, bondLengths: s.bondLengths, bondVisibility: {},
          useWasmPeriodic: wasm, showPBCBonds: false, completeFragments: false, ...extra,
        });
        const run = (extra) => time(() => periodicWrapped(opts(extra), s.frac, s.elements, s.lattice));
        const tag = wasm ? 'wasm' : 'js';
        row[`${tag} boundary`] = run({});
        row[`${tag} neighbour bonds`] = run({ showPBCBonds: true });
        row[`${tag} complete fragments`] = run({ completeFragments: true });
        row[`${tag} both`] = run({ showPBCBonds: true, completeFragments: true });
      }
      out[name] = row;
    }
    return out;
  });
  for (const [name, row] of Object.entries(results)) {
    console.log(`  ${name} (${row.atoms} atoms)`);
    for (const [k, v] of Object.entries(row)) if (k !== 'atoms') console.log(`    ${k.padEnd(26)} ${String(v.ms).padStart(8)} ms   drawn ${v.drawn}`);
  }
  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
