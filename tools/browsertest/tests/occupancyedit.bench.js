// Modify Structure: how long one occupancy (and one element) edit in the atom
// table takes on a large structure, from the input event to the end of the
// live apply. Opt-in (.bench.js): run with
//   tools/browsertest/run.sh tests/occupancyedit.bench.js
// Prints ms per edit; absolute numbers are machine-dependent (software GL).
'use strict';
const H = require('../harness');

const MODIFY = '[data-panel-id="modifyStructure"]';
const N = Number(process.env.OCC_BENCH_N || 8); // N^3 * 2 atoms (rock salt)

function rockSaltPoscar(n) {
  const a = 5.64 * n;
  const lines = ['NaCl bench', '1.0', `${a} 0 0`, `0 ${a} 0`, `0 0 ${a}`, 'Na Cl'];
  const na = []; const cl = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    na.push([i / n, j / n, k / n]);
    cl.push([(i + 0.5) / n, (j + 0.5) / n, (k + 0.5) / n]);
  }
  lines.push(`${na.length} ${cl.length}`, 'Direct');
  for (const p of [...na, ...cl]) lines.push(p.map((v) => v.toFixed(6)).join(' '));
  return lines.join('\n');
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'POSCAR');
  }, rockSaltPoscar(N));
  await page.waitForTimeout(3000);

  const result = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
    await frame();
    const panel = document.querySelector(sel);
    const rows = panel.querySelectorAll('#atomsTable tbody tr');
    const time = async (fn) => {
      const t0 = performance.now();
      fn();
      await frame();
      return performance.now() - t0;
    };
    const occ = [];
    for (let i = 0; i < 5; i++) {
      const input = /** @type {HTMLInputElement} */ (rows[3].querySelector('.atom-occ'));
      occ.push(await time(() => {
        input.value = String(0.9 - 0.1 * i);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }));
    }
    const el = [];
    for (const element of ['K', 'Na', 'K']) {
      const input = /** @type {HTMLInputElement} */ (rows[5].querySelector('.atom-element'));
      el.push(await time(() => {
        input.value = element;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }));
    }
    const s = fileBrowser.selectedStructure;
    return {
      atoms: s.atoms.length,
      occMs: occ.map((v) => Math.round(v)),
      elementMs: el.map((v) => Math.round(v)),
      occApplied: s.atoms[3].species[0].occupancy,
    };
  }, MODIFY);
  console.log(`occupancy edit bench: ${JSON.stringify(result)}`);
  H.check('occupancy edit reached the structure', Math.abs(result.occApplied - 0.5) < 1e-6, JSON.stringify(result));
  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
