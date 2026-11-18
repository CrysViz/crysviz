// Force and spin arrows on a trajectory: length comes from the vectors alone,
// colours clamp to the bar's ends, and stepping through the file browser
// draws every step's arrows on that step's atoms.
//
// - Arrow length is |v| × scaling, or on "log length" the log against the
//   file's own extent (render/ArrowLength.js). It used to be mapped through
//   the colour range, so Auto Range, typed limits or a reload rescaled the
//   arrows; a constant force/moment now has one length on every step.
// - Colour limits narrower than the data put everything outside them on the
//   end colours; lengths don't change.
// - The colour range is the structure's own when it is entered, even with
//   the Forces/Spins window closed (ui/ArrowRange.js) — it used to stay at
//   the previous structure's (or 0 .. 2) until the window was built.
// - A step chosen in the file browser drew its arrows before that step's
//   atom positions existed, i.e. on the previous step's atoms.
'use strict';
const H = require('../harness');

const STEP = (oX, f1, m1, toten) => [
  '  direct lattice vectors                 reciprocal lattice vectors',
  '     4.000000000  0.000000000  0.000000000     0.250000000  0.000000000  0.000000000',
  '     0.000000000  4.000000000  0.000000000     0.000000000  0.250000000  0.000000000',
  '     0.000000000  0.000000000  4.000000000     0.000000000  0.000000000  0.250000000',
  '',
  ' magnetization (x)',
  ' ',
  '# of ion       s       p       d       tot',
  '------------------------------------------',
  `    1        0.010   0.020   ${(m1 - 0.03).toFixed(3)}   ${m1.toFixed(3)}`,
  '    2        0.000   0.300   0.000   0.300',
  '--------------------------------------------------',
  `tot          0.010   0.320   ${(m1 - 0.03).toFixed(3)}   ${(m1 + 0.3).toFixed(3)}`,
  '',
  ' POSITION                                       TOTAL-FORCE (eV/Angst)',
  ' -----------------------------------------------------------------------------------',
  `      0.50000      0.50000      0.50000         ${f1.toFixed(6)}      0.100000      0.000000`,
  `      ${oX.toFixed(5)}      2.00000      2.00000        -0.003000      0.000000      0.002000`,
  ' -----------------------------------------------------------------------------------',
  '    total drift:                                0.000000      0.000000      0.000000',
  '',
  `  free  energy   TOTEN  =      ${toten.toFixed(8)} eV`,
  '',
];
// Atom 1's force and moment shrink over the run; atom 2's stay constant
// (|F| = 0.0036 eV/Å, 0.3 μB) while it moves.
const OUTCAR = [
  ' vasp.6.4.2 20Jul23 complex', ' POTCAR:    PAW_PBE Fe 06Sep2000', ' POTCAR:    PAW_PBE O 08Apr2002',
  '   ions per type =               1   1', '',
  ...STEP(2.0, 0.8, 2.2, -10.0), ...STEP(1.9, 0.5, 2.0, -11.0), ...STEP(1.8, 0.2, 1.8, -11.5),
].join('\n');
const F2 = Math.hypot(0.003, 0.002);

/** Per source atom: [total length, shaft centre] of its first arrow, and its colour. */
const arrows = (page, kind) => page.evaluate(async (kind) => {
  const THREE = await import('./external/three/three.module.js');
  const { groups, fileBrowser } = await import('./state/store.js');
  const mesh = groups[kind === 'force' ? 'forcesShaftMesh' : 'spinShaftMesh'];
  const by = groups[kind === 'force' ? 'forcesInstancesBySrcIndex' : 'spinsInstancesBySrcIndex'];
  const list = fileBrowser.selectedStructure?.[kind === 'force' ? 'forces' : 'spins'] ?? [];
  if (!mesh || !by) return null;
  const m = new THREE.Matrix4(); const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
  const out = {};
  for (const [src, idx] of by) {
    mesh.getMatrixAt(idx[0] * 2, m); m.decompose(p, q, s);
    out[src] = { len: s.y * 2, at: p.toArray().map((v) => +v.toFixed(4)), color: list[src]?.color?.getHexString?.() ?? null };
  }
  return out;
}, kind);

const setStep = (page, step) => page.evaluate(async (step) => {
  const fb = await import('./ui/FileBrowswerPanel.js');
  const { fileBrowser } = await import('./state/store.js');
  fb.selectStructure(fileBrowser.selectedRowIndex, step);
  await new Promise((r) => setTimeout(r, 500));
}, step);

const redraw = (page) => page.evaluate(async () => {
  const { updateForces, updateSpins } = await import('./render/index.js');
  const { general } = await import('./state/store.js');
  if (general.forcesActive) updateForces();
  if (general.spinsActive) updateSpins();
});

const general = (page, keys) => page.evaluate(async (keys) => {
  const { general } = await import('./state/store.js');
  return Object.fromEntries(keys.map((k) => [k, general[k]]));
}, keys);

const setGeneral = (page, values) => page.evaluate(async (values) => {
  const { general } = await import('./state/store.js');
  Object.assign(general, values);
}, values);

const close = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }
  // Forces on, Forces/Spins windows closed, then load (shows the last step).
  await setGeneral(page, { forcesActive: true, forceColorMap: 'viridis' });
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'OUTCAR'), OUTCAR);
  await page.waitForTimeout(1500);

  const r0 = await general(page, ['forceMin', 'forceMax']);
  // Last step: |F| 0.2236 and 0.0036 -> Auto Range 0 .. 0.28.
  H.check('forces: with the window closed the bar still gets this structure\'s Auto Range (was 0 .. 2)',
    r0.forceMin === 0 && r0.forceMax === 0.28, JSON.stringify(r0));

  // --- forces: positions and linear length per step --------------------------
  const lin = {};
  let lagFree = true;
  for (const step of [0, 1, 2]) {
    await setStep(page, step);
    const shown = await arrows(page, 'force');
    await redraw(page);
    const fresh = await arrows(page, 'force');
    if (JSON.stringify(shown) !== JSON.stringify(fresh)) lagFree = false;
    lin[step] = shown;
  }
  H.check('forces: a step picked in the file browser is drawn on that step\'s atoms (was the previous step\'s)',
    lagFree, JSON.stringify(lin));
  H.check('forces: length is |F| (Global Scaling 1) on every step',
    close(lin[0][0].len, Math.hypot(0.8, 0.1)) && close(lin[2][0].len, Math.hypot(0.2, 0.1))
    && [0, 1, 2].every((s) => close(lin[s][1].len, F2)), JSON.stringify(lin));

  // --- forces: colours clamp, lengths stay ------------------------------------
  await setGeneral(page, { forceMin: 0.3, forceMax: 0.5 });
  await setStep(page, 0);
  await redraw(page);
  const clamp = await arrows(page, 'force');
  const ends = await page.evaluate(async () => {
    const { getColorFromMap } = await import('./defaults/color_texture_defaults.js');
    return [getColorFromMap(0, 'viridis').getHexString(), getColorFromMap(1, 'viridis').getHexString()];
  });
  H.check('forces: outside narrow limits the arrows take the end colours (0.806 -> top, 0.0036 -> bottom)',
    clamp[0].color === ends[1] && clamp[1].color === ends[0], JSON.stringify({ clamp, ends }));
  H.check('forces: and keep their lengths', close(clamp[0].len, lin[0][0].len) && close(clamp[1].len, lin[0][1].len),
    JSON.stringify(clamp));

  // --- forces: log length ------------------------------------------------------
  await setGeneral(page, { forceLengthLogScale: true, forceColorScale: 'log', forceMin: 0.001, forceMax: 1 });
  const logLen = {};
  for (const step of [0, 1, 2]) { await setStep(page, step); logLen[step] = await arrows(page, 'force'); }
  // File extent: 0.0036 (atom 2) .. 0.806 (atom 1, step 0) -> 0.3 .. 2 Å.
  H.check('forces, log length: the file\'s smallest force is 0.3 Å and its largest 2 Å',
    close(logLen[0][1].len, 0.3) && close(logLen[0][0].len, 2.0), JSON.stringify(logLen[0]));
  H.check('forces, log length: a constant force has one length on every step',
    [1, 2].every((s) => close(logLen[s][1].len, logLen[0][1].len)), JSON.stringify(logLen));
  const before = await arrows(page, 'force');
  await setGeneral(page, { forceMin: 0.05, forceMax: 0.1 });
  await redraw(page);
  const after = await arrows(page, 'force');
  H.check('forces, log length: changing the colour limits leaves every length alone',
    Object.keys(before).every((k) => close(before[k].len, after[k].len)), JSON.stringify({ before, after }));
  await setGeneral(page, { forceLengthLogScale: false, forceColorScale: 'linear', forcesActive: false });
  await page.evaluate(async () => (await import('./render/index.js')).removeForces());

  // --- spins: same checks -------------------------------------------------------
  await setGeneral(page, { spinsActive: true, spinColorMap: 'viridis' });
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'OUTCAR'), OUTCAR);
  await page.waitForTimeout(1500);
  const rs = await general(page, ['spinMin', 'spinMax']);
  // Last step: 1.8 and 0.3 μB -> linear Auto Range 0 .. 2.2.
  H.check('spins: the newly loaded structure gets its own Auto Range with the window closed',
    rs.spinMin === 0 && rs.spinMax === 2.2, JSON.stringify(rs));
  const slin = {};
  let spinLagFree = true;
  for (const step of [0, 1, 2]) {
    await setStep(page, step);
    const shown = await arrows(page, 'spin');
    await redraw(page);
    const fresh = await arrows(page, 'spin');
    if (JSON.stringify(shown) !== JSON.stringify(fresh)) spinLagFree = false;
    slin[step] = shown;
  }
  H.check('spins: a step picked in the file browser is drawn on that step\'s atoms', spinLagFree, JSON.stringify(slin));
  H.check('spins: length is the moment (scale 1) on every step',
    close(slin[0][0].len, 2.2, 1e-3) && close(slin[2][0].len, 1.8, 1e-3) && [0, 1, 2].every((s) => close(slin[s][1].len, 0.3, 1e-3)),
    JSON.stringify(slin));
  await setGeneral(page, { spinLengthLogScale: true, spinColorScale: 'log', spinMin: 0.1, spinMax: 10 });
  const slog = {};
  for (const step of [0, 1, 2]) { await setStep(page, step); slog[step] = await arrows(page, 'spin'); }
  H.check('spins, log length: 0.3 μB (file minimum) 0.3 Å, 2.2 μB (maximum) 2 Å, constant moment constant length',
    close(slog[0][1].len, 0.3) && close(slog[0][0].len, 2.0) && [1, 2].every((s) => close(slog[s][1].len, slog[0][1].len)),
    JSON.stringify(slog));
  const sb = await arrows(page, 'spin');
  await setGeneral(page, { spinMin: 1, spinMax: 1.5 });
  await redraw(page);
  const sa = await arrows(page, 'spin');
  H.check('spins, log length: colour limits leave lengths alone',
    Object.keys(sb).every((k) => close(sb[k].len, sa[k].len)), JSON.stringify({ sb, sa }));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
