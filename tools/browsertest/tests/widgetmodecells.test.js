// Widget mode cell-swap edge cases (companion to widgetmode.test.js):
//  (a) an AFM cell whose nuclear PRIMITIVE folds two opposite-moment atoms onto
//      one site — Primitive must refuse (magnetic supercell) and grey out, while
//      Conventional (1:1 with the loaded cell) still works (per-kind disable, S4);
//  (c) a spin-less structure — the cell swap works with no spin bookkeeping.
'use strict';
const H = require('../harness');

const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

/** A rock-salt FeO conventional cell (.crysviz). `moments` (or null) sets the
 *  per-atom Fe spins; O is always zero. */
function fixtureJson(moments) {
  const a = 4.4;
  const lattice = [[a, 0, 0], [0, a, 0], [0, 0, a]];
  const positions = [
    [0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5],
    [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0.5, 0.5],
  ];
  const elements = ['Fe', 'Fe', 'Fe', 'Fe', 'O', 'O', 'O', 'O'];
  const frame = { elements, lattice, positions };
  if (moments) frame.spins = moments.map((v) => ({ vector: v }));
  return JSON.stringify({
    format: 'crysviz',
    version: '2.16',
    frames: [frame],
    selectedFrameIndex: 0,
    colors: { useDefaultColors: true },
    display: { spinsActive: !!moments, showAtoms: true, showBonds: true, showLattice: true },
    style: {},
  });
}

async function loadWidget(page, json) {
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const url = `${BASE}?widget=1#load-file=${encodeURIComponent('FeO.crysviz')}|${encodeURIComponent(b64)}`;
  // Two fixtures differ only in the URL fragment, which the browser treats as a
  // same-document navigation (no reload, stale module state). about:blank first
  // forces a genuine reload so early.js re-runs against the new fixture.
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

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });

  // ---- (a) AFM: type-II moments (+z,+z,−z,−z) on the 4 Fe --------------------
  await loadWidget(page, fixtureJson([
    [0, 0, 3], [0, 0, 3], [0, 0, -3], [0, 0, -3], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ]));

  await clickCell(page, 'prim');
  // The primitive refusal is synchronous after the moyo build; poll until the
  // entry is greyed out (or a short timeout).
  const primState = await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    const disabled = document.querySelector('.widget-menu-item[data-group="cell"][data-value="prim"]')
      .getAttribute('aria-disabled');
    if (disabled !== 'true') return null;
    return { disabled, atoms: fileBrowser.selectedStructure.atoms.length };
  }, { timeout: 30000, interval: 1000 });
  H.check('AFM: Primitive is refused and greyed out', !!primState && primState.disabled === 'true',
    JSON.stringify(primState));
  H.check('AFM: refusal keeps the loaded 8-atom cell (no swap)',
    !!primState && primState.atoms === 8, JSON.stringify(primState));

  // Per-kind (S4): Conventional was NOT disabled by the prim refusal, and works.
  const convDisabled = await page.evaluate(() =>
    document.querySelector('.widget-menu-item[data-group="cell"][data-value="conv"]')
      .getAttribute('aria-disabled'));
  H.check('AFM: Conventional stays enabled after Primitive refusal (S4)', convDisabled !== 'true',
    String(convDisabled));

  await clickCell(page, 'conv');
  const conv = await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const checked = document.querySelector('.widget-menu-item[data-group="cell"][data-value="conv"]')
      .getAttribute('aria-checked');
    if (checked !== 'true') return null;
    // Sublattice pattern along the moments' dominant axis (the standardisation
    // rotates z→y here, so vector[2] is not it): 2 Fe up, 2 Fe down, 4 O zero.
    // This is the one cheap check that fails if the remap math regresses.
    const vecs = s.spins.map((sp) => sp.vector);
    const axisMag = [0, 1, 2].map((i) => vecs.reduce((a, v) => a + Math.abs(v[i]), 0));
    const axis = axisMag.indexOf(Math.max(...axisMag));
    const signs = vecs.map((v) => Math.sign(Math.round(v[axis] * 100) / 100));
    return {
      atoms: s.atoms.length, spins: s.spins.length,
      up: signs.filter((x) => x > 0).length,
      down: signs.filter((x) => x < 0).length,
      zero: signs.filter((x) => x === 0).length,
    };
  }, { timeout: 25000, interval: 1000 });
  H.check('AFM: Conventional swap succeeds with index-aligned spins',
    !!conv && conv.atoms === 8 && conv.spins === 8, JSON.stringify(conv));
  H.check('AFM: Conventional keeps the 2-up / 2-down / 4-zero sublattice pattern',
    !!conv && conv.up === 2 && conv.down === 2 && conv.zero === 4, JSON.stringify(conv));

  // ---- (c) spin-less: cell swap works, no spin work -------------------------
  await loadWidget(page, fixtureJson(null));
  await clickCell(page, 'prim');
  const noSpin = await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    if (!s || s.atoms.length !== 2) return null;
    return { atoms: s.atoms.length, spins: s.spins?.length ?? 0 };
  }, { timeout: 30000, interval: 1000 });
  H.check('spin-less: Primitive reduces to 2 atoms', !!noSpin && noSpin.atoms === 2, JSON.stringify(noSpin));
  H.check('spin-less: no spins created', !!noSpin && noSpin.spins === 0, JSON.stringify(noSpin));

  H.check('no console errors across cell-swap edge cases', errors.length === 0, errors.slice(0, 3).join(' | '));

  await H.finish(browser);
})().catch(H.crash);
