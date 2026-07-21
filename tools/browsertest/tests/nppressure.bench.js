// Which sign of the NEP stress tensor is "pressure"? Compress a crystal and
// expand it: the compressed one must come out at HIGHER pressure. Needed
// before wiring a barostat, which would otherwise happily drive the cell the
// wrong way.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async () => {
    const loadScript = (src) => new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve(null);
      el.onerror = () => reject(new Error(`failed ${src}`));
      document.head.appendChild(el);
    });
    await loadScript('./external/nep_wasm/nep_wasm.js');
    await loadScript('./external/nep_wasm/nep_simple.js');
    const runner = new window.NEPWasmRunner({ defaultModelUrl: './external/nep_wasm/nep89_20250409.txt' });
    await runner.init();
    await runner.loadDefaultModel();
    const elements = runner.modelInfo.element_list;
    const cuIndex = elements.indexOf('Cu');

    // FCC Cu, conventional cell, 4 atoms, tiled 2x2x2 = 32 atoms.
    const fccCu = (a) => {
      const basis = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
      const positions = [];
      for (let i = 0; i < 2; i += 1) {
        for (let j = 0; j < 2; j += 1) {
          for (let k = 0; k < 2; k += 1) {
            basis.forEach((b) => positions.push([
              (b[0] + i) * a, (b[1] + j) * a, (b[2] + k) * a,
            ]));
          }
        }
      }
      return {
        lattice: [[2 * a, 0, 0], [0, 2 * a, 0], [0, 0, 2 * a]],
        positions,
        types: positions.map(() => cuIndex),
      };
    };

    const EV_A3_TO_GPA = 160.21766208;
    const rows = [];
    for (const a of [3.2, 3.4, 3.615, 3.8, 4.0]) {
      const cell = fccCu(a);
      const out = runner.compute(cell);
      const t = out.stress.matrix3x3;
      const trace = t[0][0] + t[1][1] + t[2][2];
      rows.push({
        a,
        volume: (2 * a) ** 3,
        energyPerAtom: out.total_energy / cell.positions.length,
        plusTraceGPa: (trace / 3) * EV_A3_TO_GPA,
        minusTraceGPa: (-trace / 3) * EV_A3_TO_GPA,
      });
    }
    return { cuIndex, rows };
  });

  console.log(`  Cu type index ${res.cuIndex}`);
  console.log('      a(A)   E/atom(eV)   +tr/3 (GPa)   -tr/3 (GPa)');
  for (const r of res.rows) {
    console.log(`  ${r.a.toFixed(3).padStart(8)} ${r.energyPerAtom.toFixed(4).padStart(12)}`
      + ` ${r.plusTraceGPa.toFixed(2).padStart(13)} ${r.minusTraceGPa.toFixed(2).padStart(13)}`);
  }

  const compressed = res.rows[0];
  const expanded = res.rows[res.rows.length - 1];
  console.log(`  compressed(a=${compressed.a}) vs expanded(a=${expanded.a}):`
    + ` +tr/3 ${compressed.plusTraceGPa > expanded.plusTraceGPa ? 'RISES' : 'falls'},`
    + ` -tr/3 ${compressed.minusTraceGPa > expanded.minusTraceGPa ? 'RISES' : 'falls'}`);

  H.check('one of the two conventions rises under compression',
    (compressed.plusTraceGPa > expanded.plusTraceGPa)
      !== (compressed.minusTraceGPa > expanded.minusTraceGPa),
    JSON.stringify(res.rows));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
