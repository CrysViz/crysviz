// Cube load flow (DW-5.1..5.4): a cube whose atoms lie outside its grid box
// opens a choiceDialog (Periodic / Not periodic / Cancel); an explicit
// `periodic` option skips it; share payloads only restore a block for a
// literal `periodic: false`.
'use strict';
const H = require('../harness');

const BOHR = 0.529177210544;

/** n=4 grid, 0.75 Bohr steps, origin (1,1,1) Bohr. `far` puts one atom well outside the grid box. */
const cube = ({ far, mos = null } = {}) => {
  const f = (v) => v.toFixed(6);
  const nval = mos ? mos.length : 1;
  const data = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    const row = [];
    for (let z = 0; z < 4; z++) for (let d = 0; d < nval; d++) row.push(((x + 2 * y + 3 * z + 10 * d) / 10).toExponential(5));
    data.push(row.join(' '));
  }
  return [
    'block', 'cubeblock test',
    `${mos ? -2 : 2} ${f(1)} ${f(1)} ${f(1)}`,
    `4 ${f(0.75)} ${f(0)} ${f(0)}`, `4 ${f(0)} ${f(0.75)} ${f(0)}`, `4 ${f(0)} ${f(0)} ${f(0.75)}`,
    `8 8.0 ${f(2)} ${f(2)} ${f(2)}`,
    far ? `1 1.0 ${f(9)} ${f(2)} ${f(-3)}` : `1 1.0 ${f(2.5)} ${f(2)} ${f(2)}`,
    ...(mos ? [`${mos.length} ${mos.join(' ')}`] : []),
    ...data,
  ].join('\n');
};

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Drive loadStructure; `click` is the dialog button text (or 'Escape'/'backdrop'); null = expect no dialog.
  async function load(text, name, { options, click } = {}) {
    return page.evaluate(async ({ text, name, options, click }) => {
      const cv = await import('./core/crystal-viewer.js');
      const p = cv.loadStructure(text, name, false, '', options).catch((e) => ({ ok: false, threw: e.message }));
      await new Promise((r) => setTimeout(r, 300));
      const modal = document.getElementById('confirmModal');
      const shown = !!modal && !modal.hidden;
      const message = shown ? document.getElementById('confirmModalMessage').textContent : '';
      if (shown) {
        if (click === 'Escape') modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else if (click === 'backdrop') modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        else [...modal.querySelectorAll('button')].find((b) => b.textContent.includes(click))?.click();
      }
      const res = await p;
      const s = res.container?.structures?.[0];
      const fields = s?.volumetricFields?.fields ?? [];
      return {
        shown, message, ok: res.ok, cancelled: res.cancelled === true,
        lattice: s?.lattice, positions: s?.atoms.map((a) => a.position),
        fields: fields.map((f) => ({
          n: [f.nx, f.ny, f.nz], len: f.values.length, periodic: f.periodic, origin: f.origin, voxel: f.voxel,
        })),
        threw: res.threw,
      };
    }, { text, name, options, click });
  }

  const near = (a, b, tol = 1e-4) => Math.abs(a - b) < tol;
  const suspect = cube({ far: true });

  // --- DW-5.1 Not periodic
  const blk = await load(suspect, 'far.cube', { click: 'Not periodic' });
  H.check('suspect cube opens the dialog and states the count', blk.shown && /1 of 2 atoms/.test(blk.message), blk.message);
  H.check('Not periodic loads', blk.ok === true, JSON.stringify(blk).slice(0, 300));
  const cart = blk.positions.map((p) => p.map((_, k) => p.reduce((s, v, j) => s + v * blk.lattice[j][k], 0)));
  H.check('cell contains every atom',
    blk.positions.every((p) => p.every((v) => v > 0 && v < 1)), JSON.stringify(blk.positions));
  const o = blk.fields[0].origin;
  const rel = cart.map((c) => c.map((v, k) => v - o[k]));
  const expect = [[1, 1, 1], [8, 1, -4]].map((r) => r.map((v) => v * BOHR));
  H.check('atom positions relative to the grid match the file',
    rel.every((r, i) => r.every((v, k) => near(v, expect[i][k]))), JSON.stringify([rel, expect]));
  H.check('fields are blocks with the file grid and no padding',
    blk.fields.length === 1 && blk.fields[0].periodic === false && blk.fields[0].n.join() === '4,4,4'
      && blk.fields[0].len === 64, JSON.stringify(blk.fields));
  H.check('block field keeps the file voxel', near(blk.fields[0].voxel[0][0], 0.75 * BOHR), JSON.stringify(blk.fields[0].voxel));

  // --- DW-5.2 Periodic, option true, cancel
  const per = await load(suspect, 'far2.cube', { click: 'Periodic' });
  const optT = await load(suspect, 'far3.cube', { options: { periodic: true } });
  const a = 4 * 0.75 * BOHR;
  H.check('Periodic dialog choice gives the grid box as cell, periodic field',
    per.ok && per.lattice.every((r, i) => r.every((v, j) => near(v, i === j ? a : 0)))
      && per.fields[0].periodic === true && per.fields[0].origin.every((v) => v === 0)
      && per.positions.every((p) => p.every((v) => v >= 0 && v < 1)), JSON.stringify(per));
  H.check('periodic:true equals the dialog Periodic result, no dialog',
    !optT.shown && JSON.stringify(optT.lattice) === JSON.stringify(per.lattice)
      && JSON.stringify(optT.positions) === JSON.stringify(per.positions), JSON.stringify(optT).slice(0, 300));

  async function structureCount() {
    return page.evaluate(async () => (await import('./state/store.js')).fileBrowser.fileData.length);
  }
  const n0 = await structureCount();
  const cancel = await load(suspect, 'c1.cube', { click: 'Cancel' });
  const esc = await load(suspect, 'c2.cube', { click: 'Escape' });
  const bd = await load(suspect, 'c3.cube', { click: 'backdrop' });
  for (const [name, r] of [['Cancel', cancel], ['Escape', esc], ['backdrop click', bd]]) {
    H.check(`${name} cancels`, r.shown && r.ok === false && r.cancelled === true, JSON.stringify(r).slice(0, 200));
  }
  H.check('cancel loads nothing', n0 > 0 && (await structureCount()) === n0, `${n0} -> ${await structureCount()}`);

  // --- DW-5.3 options skip the dialog
  const optF = await load(suspect, 'f.cube', { options: { periodic: false } });
  H.check('periodic:false skips the dialog and builds the block',
    !optF.shown && optF.ok && optF.fields[0].periodic === false, JSON.stringify(optF).slice(0, 200));
  const inside = cube({ far: false });
  const noOpt = await load(inside, 'in.cube');
  H.check('non-suspect cube, no option: no dialog, periodic as today',
    !noOpt.shown && noOpt.ok && noOpt.fields[0].periodic === true && noOpt.fields[0].origin.every((v) => v === 0),
    JSON.stringify(noOpt).slice(0, 200));
  const inF = await load(inside, 'inf.cube', { options: { periodic: false } });
  H.check('periodic:false on a non-suspect cube still builds the box',
    !inF.shown && inF.ok && inF.fields[0].periodic === false
      && inF.lattice[0][0] > a && inF.lattice[0][1] === 0, JSON.stringify(inF).slice(0, 300));

  // --- unparseable: error, no dialog
  const bad = await load('not a cube\nat all', 'bad.cube');
  H.check('unparseable cube shows no cube dialog', !bad.shown && bad.ok === false && bad.cancelled === false && /header/.test(bad.threw || ''), JSON.stringify(bad).slice(0, 200));
  await page.evaluate(() => { document.querySelectorAll('.modal-close, [data-close], #loadErrorModal button').forEach((b) => b.click()); });

  // --- multi-orbital blocks
  const mo = await load(cube({ far: true, mos: [4, 5] }), 'mo.cube', { options: { periodic: false } });
  H.check('multi-orbital cube gives several block fields',
    mo.ok && mo.fields.length === 2 && mo.fields.every((f) => f.periodic === false && f.len === 64)
      && JSON.stringify(mo.fields[0].origin) === JSON.stringify(mo.fields[1].origin), JSON.stringify(mo.fields));

  // --- DW-5.4 share round trip and tampering
  const shared = await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const { fileBrowser } = await import('./state/store.js');
    const st = () => fileBrowser.selectedStructure.volumetricFields.fields[0];
    const state = captureState({ includeFields: true });
    const orig = { periodic: state.fields.fields[0].periodic, origin: state.fields.fields[0].origin };
    const out = { orig, restored: {} };
    const variants = { literal: false, str: 'false', zero: 0, nul: null, missing: undefined };
    for (const [k, v] of Object.entries(variants)) {
      const copy = JSON.parse(JSON.stringify(state));
      if (v === undefined) delete copy.fields.fields[0].periodic; else copy.fields.fields[0].periodic = v;
      await applySharedState(copy);
      out.restored[k] = { periodic: st().periodic, origin: st().origin };
    }
    return out;
  });
  H.check('captured block field carries periodic:false and its origin',
    shared.orig.periodic === false && shared.orig.origin.length === 3, JSON.stringify(shared.orig));
  H.check('share round trip keeps periodic:false and origin',
    shared.restored.literal.periodic === false
      && JSON.stringify(shared.restored.literal.origin) === JSON.stringify(shared.orig.origin), JSON.stringify(shared.restored.literal));
  H.check('tampered periodic values restore a periodic field',
    ['str', 'zero', 'nul', 'missing'].every((k) => shared.restored[k].periodic === true), JSON.stringify(shared.restored));

  H.check('no console/page errors', errors.filter((e) => !/bad\.cube|header is incomplete/i.test(e)).length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
