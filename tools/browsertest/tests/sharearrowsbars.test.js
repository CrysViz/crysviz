// Share links and .crysviz sessions carry the force and spin arrows and the
// colour bars (ui/ShareModule.js captureColorBars/applyColorBars, the share
// codec's arrow block and baseline 5):
//   - a share link opened in a fresh browser (another person) draws the
//     forces and spins (a link had only their display settings, so it drew
//     none), and the Forces/Spins colour bars come back floating where they
//     were, vertical, flipped, with their legend, lock and length; the Bonds
//     colour scale too
//   - a .crysviz session restores the same colour-bar layout onto the bars
//   - an older session without these settings leaves the bars as they are
//   - the recipient's Forces and Spins windows open by themselves, so the bars
//     show without looking for them
'use strict';
const H = require('../harness');

const EXTXYZ = `4
Lattice="4.2 0 0 0 4.2 0 0 0 4.2" Properties=species:S:1:pos:R:3:forces:R:3 pbc="T T T"
Na 0.0 0.0 0.0 0.10 0.20 -0.30
Cl 2.1 2.1 2.1 -0.10 -0.20 0.30
Na 2.1 2.1 0.0 0.50 0.00 0.00
Cl 0.0 0.0 2.1 0.00 0.50 0.00
`;

const ANCHOR = { edgeX: 'right', offsetX: 40, edgeY: 'top', offsetY: 130 };

/** The force/spin data, arrows drawn, and the colour bars as general and the live widgets have them. */
const STATE = async () => {
  const { fileBrowser, general, groups } = await import('./state/store.js');
  const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
  const s = fileBrowser.selectedStructure;
  const bars = {};
  for (const { id, instance } of listActiveColorBars()) {
    const st = instance.getSettings();
    bars[id] = { floating: instance.isFloating(), anchor: instance.isFloating() ? instance.getAnchor() : null, orientation: st.orientation, flipSide: st.flipSide, legend: st.legend, size: st.size };
  }
  return {
    forces: s?.forces?.length ?? 0,
    force1: s?.forces?.[1] ? [...s.forces[1].vector] : null,
    spins: s?.spins?.length ?? 0,
    forceArrows: groups.forcesShaftMesh?.count ?? 0,
    spinArrows: groups.spinShaftMesh?.count ?? 0,
    general: {
      forceOrientation: general.forceColorBarOrientation, forceFlip: general.forceColorBarFlipSide,
      forceLegend: general.forceLegendText, forceFloating: general.forceColorBarFloating,
      forceAnchor: general.forceColorBarFloatPos, forceLocked: general.forceColorBarLocked,
      spinLegend: general.spinLegendText, spinFlip: general.spinColorBarFlipSide,
      size: general.colorBarSize, bondMin: general.BondMin, bondMax: general.BondMax,
      bondScale: general.bondColorScale, bondMap: general.bondsColorMap,
    },
    bars,
  };
};

async function openArrowWindows(page) {
  await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('forces');
    openPanel('spins');
  });
  await page.waitForTimeout(800);
}

/** Spins get a colour bar only with a colour map (the default is none). */
async function colourSpins(page) {
  await page.evaluate(() => {
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('spinColorMapSelect'));
    const option = [...sel.options].find((o) => o.value === 'viridis') || [...sel.options].find((o) => o.value !== 'none');
    sel.value = option.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
}

const sameAnchor = (a, b) => !!a && !!b && a.edgeX === b.edgeX && a.edgeY === b.edgeY
  && Math.abs(a.offsetX - b.offsetX) <= 1 && Math.abs(a.offsetY - b.offsetY) <= 1;

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // ---- the sender: forces from the file, spins, both shown, bars customised ----
  await page.evaluate(async (text) => {
    await (await import('./core/crystal-viewer.js')).loadStructure(text, 'nacl.extxyz');
  }, EXTXYZ);
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { Spin } = await import('./model/index.js');
    const s = fileBrowser.selectedStructure;
    s.spins = s.atoms.map((_, i) => new Spin({ vector: [0, 0, i % 2 ? 2 : -2], scaling: 1 }));
    for (const id of ['showForcesToggle', 'showSpinsToggle']) {
      const cb = /** @type {HTMLInputElement} */ (document.getElementById(id));
      if (!cb.checked) cb.click();
    }
  });
  await openArrowWindows(page);
  await colourSpins(page);
  await page.evaluate(async (anchor) => {
    const { general } = await import('./state/store.js');
    const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
    const bars = new Map(listActiveColorBars().map((b) => [b.id, b.instance]));
    general.colorBarSize = 420;
    bars.get('force').applySettings({ floating: true, anchor, orientation: 'vertical', flipSide: true, legend: 'F<sub>tot</sub> (eV/Å)', size: 420 });
    general.forceColorBarLocked = true;
    bars.get('spin').applySettings({ flipSide: true, legend: 'm (μB)' });
    Object.assign(general, { BondMin: 1.6, BondMax: 3.2, bondColorScale: 'log', bondsColorMap: 'viridis' });
  }, ANCHOR);
  await page.waitForTimeout(300);
  const sender = await page.evaluate(STATE);
  H.check('the sender has forces (from the file) and spins, both drawn, and customised bars',
    sender.forces === 4 && sender.spins === 4 && sender.forceArrows > 0 && sender.spinArrows > 0
      && sender.bars.force?.floating && sender.bars.force.orientation === 'vertical', JSON.stringify(sender));

  const { url, saved } = await page.evaluate(async () => {
    window.confirm = () => true;
    const { shareStructure, captureState } = await import('./ui/ShareModule.js');
    const saved = captureState({ includeFrames: true });
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    document.getElementById('shareLinkClose').click();
    return { url, saved };
  });
  H.check('the share link is made', /#z=/.test(url), url.slice(0, 80));

  // ---- the recipient: a fresh browser opens the link ----
  const context2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (process.env.CRYSVIZ_PLOTLY_ESM) await context2.route('https://esm.sh/plotly.js-dist-min*', (route) => route.fulfill({ path: process.env.CRYSVIZ_PLOTLY_ESM, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  const page2 = await context2.newPage();
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(`pageerror: ${e.message}`));
  page2.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors2.push(`console: ${m.text().slice(0, 200)}`); });
  await page2.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page2.waitForTimeout(6000);
  const opened = await page2.evaluate(STATE);
  H.check('the link draws the forces and spins it was made with (it drew none)',
    opened.forces === 4 && opened.spins === 4 && opened.forceArrows > 0 && opened.spinArrows > 0
      && JSON.stringify(opened.force1) === JSON.stringify(sender.force1), JSON.stringify({ opened, force1: sender.force1 }));
  H.check('… and brings the colour bars\' settings: floating where it was, vertical, flipped, legend, lock, length',
    opened.general.forceOrientation === 'vertical' && opened.general.forceFlip === true
      && opened.general.forceLegend === 'F<sub>tot</sub> (eV/Å)' && opened.general.forceFloating === true
      && sameAnchor(opened.general.forceAnchor, ANCHOR) && opened.general.forceLocked === true
      && opened.general.spinLegend === 'm (μB)' && opened.general.spinFlip === true && opened.general.size === 420,
    JSON.stringify(opened.general));
  H.check('… and the Bonds colour scale', opened.general.bondMin === 1.6 && opened.general.bondMax === 3.2
    && opened.general.bondScale === 'log' && opened.general.bondMap === 'viridis', JSON.stringify(opened.general));
  const windows2 = await page2.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    return ['forces', 'spins'].map((id) => { const p = getPanel(id); return { id, open: !!p && !p.closed && !p.collapsed && p.built }; });
  });
  H.check('the link opens the Forces and Spins windows by itself (they hold the colour bars)',
    windows2.every((w) => w.open), JSON.stringify(windows2));
  const bars2 = (await page2.evaluate(STATE)).bars;
  H.check('the recipient\'s Forces bar floats at that place, vertical, flipped, with the legend and length',
    bars2.force?.floating && sameAnchor(bars2.force.anchor, ANCHOR) && bars2.force.orientation === 'vertical'
      && bars2.force.flipSide === true && bars2.force.legend === 'F<sub>tot</sub> (eV/Å)' && bars2.force.size === 420,
    JSON.stringify(bars2));
  H.check('… and its Spins bar has the legend and side', bars2.spin?.legend === 'm (μB)' && bars2.spin.flipSide === true, JSON.stringify(bars2.spin));
  H.check('no errors on the recipient\'s side', errors2.length === 0, errors2.join(' | '));
  await context2.close();

  // ---- a .crysviz session: back to defaults, then open the saved state ----
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
    for (const { id, instance } of listActiveColorBars()) {
      instance.applySettings({ floating: false, orientation: 'horizontal', flipSide: false, legend: id === 'force' ? 'Force (eV/Å)' : 'Spin (μB)' });
    }
    Object.assign(general, { forceColorBarLocked: false, colorBarSize: null, BondMin: 1.1, BondMax: 4.5, bondColorScale: 'linear', bondsColorMap: null });
  });
  const reset = await page.evaluate(STATE);
  H.check('(the bars are back at their defaults)', !reset.bars.force?.floating && reset.bars.force?.orientation === 'horizontal', JSON.stringify(reset.bars));
  await page.evaluate(async (state) => {
    const { applySharedState } = await import('./ui/ShareModule.js');
    await applySharedState(state, 'roundtrip.crysviz');
  }, saved);
  await page.waitForTimeout(1200);
  await openArrowWindows(page);
  const session = await page.evaluate(STATE);
  H.check('a .crysviz session puts the bars back: floating there, vertical, flipped, legend, length',
    session.bars.force?.floating && sameAnchor(session.bars.force.anchor, ANCHOR) && session.bars.force.orientation === 'vertical'
      && session.bars.force.flipSide === true && session.bars.force.legend === 'F<sub>tot</sub> (eV/Å)' && session.bars.force.size === 420
      && session.general.forceLocked === true && session.bars.spin?.legend === 'm (μB)',
    JSON.stringify(session));
  H.check('… with its forces and spins', session.forces === 4 && session.spins === 4 && session.forceArrows > 0, JSON.stringify(session));

  // ---- an older session (no colour-bar settings) leaves the bars alone ----
  const older = await page.evaluate(async (state) => {
    const { applySharedState } = await import('./ui/ShareModule.js');
    const old = JSON.parse(JSON.stringify(state));
    for (const k of Object.keys(old.display)) if (/ColorBar|LegendText|colorBarSize|^(atom|bond)Color(Min|Max|Scale|Map)$/.test(k)) delete old.display[k];
    await applySharedState(old, 'older.crysviz');
    await new Promise((r) => setTimeout(r, 1000));
    return null;
  }, saved);
  void older;
  await openArrowWindows(page);
  const afterOld = await page.evaluate(STATE);
  H.check('an older session without them leaves the bars as they were',
    afterOld.bars.force?.floating && afterOld.bars.force.orientation === 'vertical' && afterOld.general.forceLocked === true,
    JSON.stringify(afterOld.bars));

  const own = errors.filter((e) => !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/.test(e));
  H.check('no console/page errors', own.length === 0, own.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
