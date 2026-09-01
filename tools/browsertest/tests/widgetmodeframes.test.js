// Widget mode, frames path (?widget=1): when the .crysviz session carries a
// top-level `frameKinds` array (the altermagnets DB precomputes loaded /
// conventional / primitive cells as frames), the Cell menu selects FRAMES
// instead of building variants with moyo. This test proves:
//   - the Cell menu switches frames (atom counts + spins follow per frame),
//   - the moyo WASM is never fetched (no in-browser symmetrisation),
//   - trajectory chrome (scrubber/panel) stays hidden, logo/menu intact,
//   - no console errors,
// and a second, frameKinds-less fixture proves the moyo fallback still engages.
'use strict';
const H = require('../harness');

const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

/** One frame: n atoms (Fe/O), a cubic cell of edge `a`, per-atom spins (Fe up,
 *  O zero) so spins.length === atoms.length. Positions are arbitrary but valid
 *  — the widget only SELECTS these DB-precomputed frames, it never recomputes
 *  them, so they need not be each other's true symmetry reductions. */
function frame(a, elements, positions) {
  return {
    elements,
    lattice: [[a, 0, 0], [0, a, 0], [0, 0, a]],
    positions,
    spins: elements.map((el) => ({ vector: el === 'Fe' ? [0, 0, 2] : [0, 0, 0] })),
  };
}

/** A 3-frame session: 8-atom "loaded", 4-atom "conventional", 2-atom
 *  "primitive" — distinct atom counts so each frame switch is unambiguous. */
function framesFixture() {
  const loaded = frame(4.3, ['Fe', 'Fe', 'Fe', 'Fe', 'O', 'O', 'O', 'O'], [
    [0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5],
    [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0.5, 0.5],
  ]);
  const conventional = frame(3.6, ['Fe', 'Fe', 'O', 'O'],
    [[0, 0, 0], [0.5, 0.5, 0.5], [0.5, 0, 0], [0, 0.5, 0.5]]);
  const primitive = frame(2.5, ['Fe', 'O'], [[0, 0, 0], [0.5, 0.5, 0.5]]);
  return JSON.stringify({
    format: 'crysviz',
    version: '2.16',
    frames: [loaded, conventional, primitive],
    frameKinds: ['loaded', 'conventional', 'primitive'],
    selectedFrameIndex: 0,
    colors: { useDefaultColors: true },
    display: { spinsActive: true, showAtoms: true, showBonds: true, showLattice: true },
    style: {},
  });
}

/** A single-frame session WITHOUT frameKinds — the moyo fallback must engage. */
function noKindsFixture() {
  return JSON.stringify({
    format: 'crysviz',
    version: '2.16',
    frames: [frame(4.4, ['Fe', 'Fe', 'Fe', 'Fe', 'O', 'O', 'O', 'O'], [
      [0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5],
      [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0.5, 0.5],
    ])],
    selectedFrameIndex: 0,
    colors: { useDefaultColors: true },
    display: { spinsActive: true, showAtoms: true, showBonds: true, showLattice: true },
    style: {},
  });
}

async function loadWidget(page, json, name) {
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const url = `${BASE}?widget=1#load-file=${encodeURIComponent(name)}|${encodeURIComponent(b64)}`;
  // about:blank first: two fixtures differ only in the hash, a same-document
  // navigation that would otherwise leave stale module state.
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return document.body.classList.contains('widget-mode') && !!fileBrowser.selectedStructure;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(1500);
}

const clickCell = (page, value) => page.evaluate((v) => {
  document.querySelector(`.widget-menu-item[data-group="cell"][data-value="${v}"]`).click();
}, value);

/** Poll until the selected structure has exactly `atoms` atoms; returns the
 *  atom/spin/mesh snapshot (or null while it hasn't landed). H.waitFor forwards
 *  no args to page.evaluate, so the count is baked into a string expression. */
const waitForCell = (page, atoms) => H.waitFor(page, `(async () => {
  const { fileBrowser, groups } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  if (!s || s.atoms.length !== ${atoms}) return null;
  return {
    atoms: s.atoms.length,
    spins: s.spins?.length ?? 0,
    shaft: groups.spinShaftMesh ? groups.spinShaftMesh.count : 0,
  };
})()`, { timeout: 20000, interval: 500 });

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });

  // Collect any request for the moyo WASM binary — the one network signal that
  // the in-browser symmetrisation path ran.
  const moyoReqs = [];
  page.on('request', (r) => {
    if (r.url().includes('moyo_wasm_bg.wasm')) moyoReqs.push(r.url());
  });

  // ── Frames mode ────────────────────────────────────────────────────────
  await loadWidget(page, framesFixture(), 'altermagnet.crysviz');

  // Starts on the loaded frame (8 atoms, spins drawn).
  const loaded = await waitForCell(page, 8);
  H.check('frames: starts on the 8-atom loaded cell with spins',
    !!loaded && loaded.atoms === 8 && loaded.spins === 8 && loaded.shaft > 0, JSON.stringify(loaded));

  // Cell → Conventional selects the 4-atom frame.
  await clickCell(page, 'conv');
  const conv = await waitForCell(page, 4);
  H.check('frames: Conventional switches to the 4-atom frame, spins index-aligned',
    !!conv && conv.atoms === 4 && conv.spins === 4 && conv.shaft > 0, JSON.stringify(conv));
  const convChecked = await page.evaluate(() =>
    document.querySelector('.widget-menu-item[data-group="cell"][data-value="conv"]').getAttribute('aria-checked'));
  H.check('frames: Conventional is marked checked', convChecked === 'true', String(convChecked));

  // Cell → Primitive selects the 2-atom frame.
  await clickCell(page, 'prim');
  const prim = await waitForCell(page, 2);
  H.check('frames: Primitive switches to the 2-atom frame, spins index-aligned',
    !!prim && prim.atoms === 2 && prim.spins === 2 && prim.shaft > 0, JSON.stringify(prim));

  // Back to As loaded.
  await clickCell(page, 'loaded');
  const back = await waitForCell(page, 8);
  H.check('frames: As loaded returns to the 8-atom frame',
    !!back && back.atoms === 8 && back.spins === 8, JSON.stringify(back));

  // The whole frames session must not have touched moyo.
  H.check('frames: moyo WASM never fetched (no in-browser symmetrisation)',
    moyoReqs.length === 0, moyoReqs.slice(0, 2).join(' | '));

  // Trajectory chrome stays hidden (the multi-frame load fires the trajectory
  // UI; widget mode must keep it out of sight).
  const chrome = await page.evaluate(() => {
    const invisible = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return true;
      const r = el.getBoundingClientRect();
      return getComputedStyle(el).display === 'none' || (r.width === 0 && r.height === 0);
    };
    return {
      trajPanel: invisible('#TrajControlPanel'),
      slider: invisible('#frameSlider'),
      splitPane: invisible('#splitPane'),
    };
  });
  H.check('frames: trajectory scrubber/panel not visible', chrome.trajPanel, JSON.stringify(chrome));
  H.check('frames: frame slider not visible', chrome.slider, JSON.stringify(chrome));
  H.check('frames: side dock not visible', chrome.splitPane, JSON.stringify(chrome));

  // Logo + menu intact.
  const ui = await page.evaluate(() => {
    const a = document.querySelector('#widgetLogo');
    const cells = [...document.querySelectorAll('.widget-menu-item[data-group="cell"]')]
      .map((el) => el.dataset.value);
    return { href: a ? a.getAttribute('href') : null, cells };
  });
  H.check('frames: logo links back to the full UI (no widget=)',
    !!ui.href && ui.href.includes('#load-file=') && !ui.href.includes('widget='), JSON.stringify(ui));
  H.check('frames: Cell menu has loaded/conv/prim entries',
    ui.cells.length === 3 && ui.cells.includes('conv') && ui.cells.includes('prim'), JSON.stringify(ui));

  H.check('frames: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  const moyoAfterFrames = moyoReqs.length;

  // ── Fallback (no frameKinds) ─────────────────────────────────────────────
  // A frameKinds-less session must still build the primitive with moyo.
  await loadWidget(page, noKindsFixture(), 'plain.crysviz');
  await clickCell(page, 'prim');
  const fallback = await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    if (!s || s.atoms.length !== 2) return null;
    return { atoms: s.atoms.length, spins: s.spins?.length ?? 0 };
  }, { timeout: 30000, interval: 1000 });
  H.check('fallback: no frameKinds → moyo builds the 2-atom primitive',
    !!fallback && fallback.atoms === 2, JSON.stringify(fallback));
  H.check('fallback: moyo WASM WAS fetched (in-browser symmetrisation ran)',
    moyoReqs.length > moyoAfterFrames, `${moyoAfterFrames} → ${moyoReqs.length}`);

  await H.finish(browser);
})().catch(H.crash);
