// Widget mode (?widget=1): the embed loads a .crysviz session straight off the
// #load-file= hash, hides all full-app chrome except the composition legend,
// draws spin arrows, links its logo back to the full UI with the same
// structure, and its settings menu drives the cell choice + rendering style.
//
// The fixture is a rock-salt FeO conventional cell (8 atoms, FM Fe moments)
// authored to match ShareModule's .crysviz writer (frames[0] with spins,
// display.spinsActive) — see docs/ui/ShareModule.js captureState/applySharedState.
'use strict';
const H = require('../harness');

const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

/** A frames-style .crysviz session matching ShareModule's writer. */
function fixtureJson() {
  const a = 4.3;
  const lattice = [[a, 0, 0], [0, a, 0], [0, 0, a]];
  // Rock-salt conventional cell: 4 Fe (fcc) + 4 O (edge/body centres).
  const positions = [
    [0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5],
    [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0.5, 0.5],
  ];
  const elements = ['Fe', 'Fe', 'Fe', 'Fe', 'O', 'O', 'O', 'O'];
  // Index-aligned per-atom spins; ferromagnetic Fe so the primitive fold (all
  // 4 Fe → 1 site) is representable and the remap succeeds.
  const spins = elements.map((el) => ({ vector: el === 'Fe' ? [0, 0, 2] : [0, 0, 0] }));
  return JSON.stringify({
    // SavePanel.js writes { format: 'crysviz', ...captureState() }; loadCrysvizFile
    // rejects a file without this top-level tag.
    format: 'crysviz',
    version: '2.16',
    frames: [{ elements, lattice, positions, spins }],
    selectedFrameIndex: 0,
    colors: { useDefaultColors: true },
    display: { spinsActive: true, showAtoms: true, showBonds: true, showLattice: true },
    style: {},
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });

  const b64 = Buffer.from(fixtureJson(), 'utf8').toString('base64');
  const name = 'FeO.crysviz';
  const url = `${BASE}?widget=1#load-file=${encodeURIComponent(name)}|${encodeURIComponent(b64)}`;
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  // init + authoritative bootstrap (hash load) + initWidgetMode.
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return document.body.classList.contains('widget-mode') && !!fileBrowser.selectedStructure;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(1500);

  // --- Chrome ---------------------------------------------------------------
  const cls = await page.evaluate(() => ({
    widget: document.body.classList.contains('widget-mode'),
    ui: document.getElementById('ui')?.classList.contains('panel-hidden'),
  }));
  H.check('body carries widget-mode', cls.widget === true);
  H.check('#ui is panel-hidden', cls.ui === true);

  const hidden = await page.evaluate(() => {
    const invisible = (id) => {
      const el = document.getElementById(id);
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return s.display === 'none' || (r.width === 0 && r.height === 0);
    };
    return {
      ui: invisible('ui'),
      cameraTools: invisible('cameraTools'),
      measurementTools: invisible('measurementTools'),
      backgroundDot: invisible('backgroundDot'),
    };
  });
  H.check('#ui not visible', hidden.ui, JSON.stringify(hidden));
  H.check('#cameraTools not visible', hidden.cameraTools, JSON.stringify(hidden));
  H.check('#measurementTools not visible', hidden.measurementTools, JSON.stringify(hidden));
  H.check('#backgroundDot not visible', hidden.backgroundDot, JSON.stringify(hidden));

  // --- Composition legend ---------------------------------------------------
  const legend = await page.evaluate(() => {
    const w = document.querySelector('.comp-legend-widget');
    if (!w) return { present: false };
    const r = w.getBoundingClientRect();
    const labels = [...w.querySelectorAll('.comp-legend-label')].map((el) => (el.textContent || '').trim());
    return {
      present: true,
      visible: r.width > 0 && r.height > 0 && getComputedStyle(w).display !== 'none',
      rows: w.querySelectorAll('.comp-legend-row').length,
      labels,
    };
  });
  H.check('composition legend is on screen', legend.present && legend.visible, JSON.stringify(legend));
  H.check('legend shows the two element rows (Fe, O)',
    legend.rows === 2 && legend.labels.includes('Fe') && legend.labels.includes('O'),
    JSON.stringify(legend));

  // --- Spins ----------------------------------------------------------------
  const spins0 = await page.evaluate(async () => {
    const { groups, fileBrowser } = await import('./state/store.js');
    return {
      shaft: groups.spinShaftMesh ? groups.spinShaftMesh.count : 0,
      tip: groups.spinTipMesh ? groups.spinTipMesh.count : 0,
      atoms: fileBrowser.selectedStructure.atoms.length,
      spinCount: fileBrowser.selectedStructure.spins?.length ?? 0,
    };
  });
  H.check('spin meshes present (4 Fe arrows)', spins0.shaft > 0 && spins0.tip > 0, JSON.stringify(spins0));
  H.check('loaded structure is the 8-atom conventional cell', spins0.atoms === 8, JSON.stringify(spins0));

  // --- Logo -----------------------------------------------------------------
  const logo = await page.evaluate(() => {
    const a = document.querySelector('#widgetLogo');
    return { href: a ? a.getAttribute('href') : null, target: a ? a.getAttribute('target') : null };
  });
  H.check('logo links to the same structure (#load-file=), full UI (no widget=)',
    !!logo.href && logo.href.includes('#load-file=') && !logo.href.includes('widget='),
    JSON.stringify(logo));
  H.check('logo opens in a new tab', logo.target === '_blank');

  // --- Cell: Primitive changes the displayed structure ----------------------
  // Cell swaps run first, in the default Normal pipeline; ray tracing is tested
  // last so no structure swap follows a tracer activation (a headless-WebGL
  // transient otherwise fires when a swap interrupts an in-flight tracer frame).
  await page.evaluate(() => {
    document.querySelector('.widget-menu-item[data-group="cell"][data-value="prim"]').click();
  });
  const prim = await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    if (!s || s.atoms.length !== 2) return null;
    return { atoms: s.atoms.length, spins: s.spins?.length ?? 0 };
  }, { timeout: 30000, interval: 1000 });
  H.check('Primitive reduces the cell to 2 atoms', !!prim && prim.atoms === 2, JSON.stringify(prim));
  H.check('primitive spins stay index-aligned to atoms', !!prim && prim.spins === prim.atoms, JSON.stringify(prim));

  const primMesh = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    return groups.spinShaftMesh ? groups.spinShaftMesh.count : 0;
  });
  H.check('primitive still draws its spin arrow', primMesh > 0, `shaft ${primMesh}`);

  // Check the Primitive menu entry is now the checked one.
  const primChecked = await page.evaluate(() =>
    document.querySelector('.widget-menu-item[data-group="cell"][data-value="prim"]')
      .getAttribute('aria-checked'));
  H.check('Primitive is marked checked in the menu', primChecked === 'true', String(primChecked));

  // --- Round-trip: back to As loaded, then Conventional ---------------------
  await page.evaluate(() => {
    document.querySelector('.widget-menu-item[data-group="cell"][data-value="loaded"]').click();
  });
  const back = await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    if (!s || s.atoms.length !== 8) return null;
    return { atoms: s.atoms.length, spins: s.spins?.length ?? 0 };
  }, { timeout: 20000, interval: 500 });
  H.check('As loaded restores the 8-atom cell', !!back && back.atoms === 8, JSON.stringify(back));
  H.check('restored spins stay index-aligned', !!back && back.spins === back.atoms, JSON.stringify(back));

  await page.evaluate(() => {
    document.querySelector('.widget-menu-item[data-group="cell"][data-value="conv"]').click();
  });
  const conv = await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    // Conventional == loaded size for this rock-salt cell; the point is a
    // successful swap whose spins remain index-aligned.
    if (!s || s.atoms.length !== 8) return null;
    return { atoms: s.atoms.length, spins: s.spins?.length ?? 0, checked:
      document.querySelector('.widget-menu-item[data-group="cell"][data-value="conv"]').getAttribute('aria-checked') };
  }, { timeout: 25000, interval: 1000 });
  H.check('Conventional swap succeeds with index-aligned spins',
    !!conv && conv.atoms === 8 && conv.spins === conv.atoms && conv.checked === 'true', JSON.stringify(conv));

  // --- Rendering: ray tracing, no warning modal (LAST — no swap follows) -----
  await page.evaluate(() => {
    document.querySelector('.widget-menu-item[data-group="render"][data-value="raytrace"]').click();
  });
  await H.waitFor(page, async () => {
    const { general } = await import('./state/store.js');
    return general.renderPipeline === 'raytrace';
  }, { timeout: 20000, interval: 500 });
  const rt = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const modal = document.getElementById('raytraceWarningModal');
    const modalVisible = !!modal && !modal.hidden
      && getComputedStyle(modal).display !== 'none'
      && modal.getBoundingClientRect().width > 0;
    return { pipeline: general.renderPipeline, modalVisible };
  });
  H.check('Ray tracing sets renderPipeline=raytrace', rt.pipeline === 'raytrace', JSON.stringify(rt));
  H.check('no ray/path-tracing warning modal appears', rt.modalVisible === false, JSON.stringify(rt));
  await page.waitForTimeout(1500); // let the tracer settle before teardown

  // --- Console cleanliness --------------------------------------------------
  H.check('no console errors during the widget session',
    errors.length === 0, errors.slice(0, 3).join(' | '));

  await H.finish(browser);
})().catch(H.crash);
