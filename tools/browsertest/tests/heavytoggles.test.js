// Rebuild-heavy display toggles on large structures (ui/HeavyRebuild.js).
//  1. Small structure: toggling periodic images rebuilds at once, as before —
//     no busy state, nothing deferred — and playing it locks nothing.
//  2. A 22k-atom trajectory: while it plays, Show Bonds / Periodic Images /
//     Neighbour Bonds / Polyhedra / Complete Polyhedra are disabled and greyed
//     with a "pause first" hint, and the player shows a note; clicking one
//     changes nothing. Pausing (and a step button) releases them.
//  3. Paused, toggling periodic images there shows the busy strip (the ray
//     tracer's progress bar, sweeping by transform) before the rebuild runs,
//     then the rebuild lands and the strip hides. An atom size edit runs the
//     strip until its debounced bond rebuild is done.
'use strict';
const H = require('../harness');

const SMALL = [0, 1].map((t) => ['2', 'Lattice="5.43 0 0 0 5.43 0 0 0 5.43" Properties=species:S:1:pos:R:3',
  `Si ${0.01 * t} 0 0`, 'Si 1.3575 1.3575 1.3575'].join('\n')).join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // ---- 1. Small structure ----
  const small = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip, general, groups } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, 'small.xyz');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 300));
    const toggle = /** @type {HTMLInputElement} */ (document.getElementById('showPeriodic'));
    const was = general.showPeriodic;
    const countBefore = groups.atomsMesh.count;
    toggle.checked = !was;
    toggle.dispatchEvent(new Event('change'));
    const res = {
      flippedAtOnce: general.showPeriodic === !was,
      countChanged: groups.atomsMesh.count !== countBefore,
      busy: document.body.classList.contains('cv-busy'),
    };
    toggle.checked = was;
    toggle.dispatchEvent(new Event('change'));
    document.getElementById('playPauseBtn').click();
    await new Promise((r) => setTimeout(r, 200));
    res.lockedWhilePlaying = /** @type {HTMLInputElement} */ (document.getElementById('showBonds')).disabled;
    res.noteShown = !document.getElementById('trajLockNote').hidden;
    document.getElementById('playPauseBtn').click();
    return res;
  }, SMALL);
  H.check('small structure: periodic images toggle at once, no busy state',
    small.flippedAtOnce && small.countChanged && !small.busy, JSON.stringify(small));
  H.check('small structure: playing locks nothing', !small.lockedWhilePlaying && !small.noteShown, JSON.stringify(small));

  // ---- 2./3. Large trajectory ----
  const big = await page.evaluate(async () => {
    const n = 14;
    const a = 5.43;
    const base = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0],
      [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
    const L = n * a;
    const sites = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      for (const f of base) sites.push([(f[0] + i) * a, (f[1] + j) * a, (f[2] + k) * a]);
    }
    const parts = [];
    for (let t = 0; t < 4; t++) {
      parts.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
      sites.forEach((p, s) => parts.push(`Si ${(p[0] + 0.02 * Math.sin(t + s)).toFixed(4)} ${p[1].toFixed(4)} ${p[2].toFixed(4)}`));
    }
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip, general, groups } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const { HEAVY_TOGGLE_IDS, PAUSE_FIRST_MSG } = await import('./ui/HeavyRebuild.js');
    const before = structureShip.container.length;
    await cv.loadStructure(parts.join('\n'), 'big.xyz');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 300));
    const inputs = HEAVY_TOGGLE_IDS.map((id) => /** @type {HTMLInputElement} */ (document.getElementById(id)));
    const state = () => inputs.map((el) => ({
      id: el.id,
      disabled: el.disabled,
      greyed: el.closest('.toggle_row').classList.contains('is-playback-locked'),
      hint: el.closest('.toggle_row').title === PAUSE_FIRST_MSG,
    }));
    const note = () => !document.getElementById('trajLockNote').hidden;
    const out = { atoms: sites.length };

    const play = document.getElementById('playPauseBtn');
    play.click();
    await new Promise((r) => setTimeout(r, 300));
    out.playing = { toggles: state(), note: note() };
    const bondsWas = general.showBonds;
    inputs[0].click();
    out.clickWhileLocked = { unchanged: general.showBonds === bondsWas && inputs[0].checked === bondsWas };
    play.click();
    await new Promise((r) => setTimeout(r, 300));
    out.paused = { toggles: state(), note: note() };
    play.click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('stepFwdBtn').click();
    out.stepped = { toggles: state(), note: note() };

    // Paused: the periodic images toggle runs behind the busy strip.
    await new Promise((r) => setTimeout(r, 300));
    const toggle = inputs[1];
    const was = general.showPeriodic;
    const countBefore = groups.atomsMesh.count;
    toggle.checked = !was;
    toggle.dispatchEvent(new Event('change'));
    const bar = document.getElementById('tracerProgress');
    const fill = document.getElementById('tracerProgressFill');
    out.during = {
      deferred: general.showPeriodic === was,
      busy: document.body.classList.contains('cv-busy'),
      bar: (bar?.classList.contains('is-shown') ? '1' : '0'),
      sweep: (fill ? getComputedStyle(fill).animationName : ''),
    };
    const t0 = performance.now();
    while (document.body.classList.contains('cv-busy') && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
    out.after = {
      flipped: general.showPeriodic === !was,
      countBefore,
      count: groups.atomsMesh.count,
      bar: (bar?.classList.contains('is-shown') ? '1' : '0'),
      busy: document.body.classList.contains('cv-busy'),
    };

    // The atom size slider: atoms resize at once, the bonds (whose clipped
    // ends bake the radii in) rebuild once the edits settle — the strip runs
    // from the edit until that rebuild is done.
    const size = /** @type {HTMLInputElement} */ (document.getElementById('atomSize'));
    const build0 = general.bondsBuildCounter;
    size.value = String(Math.min(1, Number(size.value) + 0.05));
    size.dispatchEvent(new Event('input'));
    out.sizeEdit = { bar: (bar?.classList.contains('is-shown') ? '1' : '0'), sweep: (fill ? getComputedStyle(fill).animationName : '') };
    const t1 = performance.now();
    while (general.bondsBuildCounter === build0 && performance.now() - t1 < 60000) await new Promise((r) => setTimeout(r, 50));
    out.sizeEdit.rebuilt = general.bondsBuildCounter !== build0;
    out.sizeEdit.barAfter = (bar?.classList.contains('is-shown') ? '1' : '0');
    return out;
  });
  const all = (list, f) => list.every(f);
  H.check(`${big.atoms} atoms playing: the heavy toggles are disabled, greyed, with a "pause first" hint; the player shows a note`,
    all(big.playing.toggles, (t) => t.disabled && t.greyed && t.hint) && big.playing.note, JSON.stringify(big.playing));
  H.check('clicking a locked toggle changes nothing', big.clickWhileLocked.unchanged, JSON.stringify(big.clickWhileLocked));
  H.check('pause releases them', all(big.paused.toggles, (t) => !t.disabled && !t.greyed && !t.hint) && !big.paused.note, JSON.stringify(big.paused));
  H.check('a step button during playback releases them too', all(big.stepped.toggles, (t) => !t.disabled && !t.greyed) && !big.stepped.note, JSON.stringify(big.stepped));
  H.check('paused: periodic images toggle shows the busy strip before the rebuild',
    big.during.deferred && big.during.busy && big.during.bar === '1' && /tracerBusySlide/.test(big.during.sweep), JSON.stringify(big.during));
  H.check('then the rebuild lands and the strip hides',
    big.after.flipped && big.after.count !== big.after.countBefore && big.after.bar === '0' && !big.after.busy, JSON.stringify(big.after));

  H.check('atom size slider: the strip runs until the bonds have rebuilt',
    big.sizeEdit.bar === '1' && /tracerBusySlide/.test(big.sizeEdit.sweep) && big.sizeEdit.rebuilt && big.sizeEdit.barAfter === '0',
    JSON.stringify(big.sizeEdit));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
