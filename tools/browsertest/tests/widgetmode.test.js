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
    const { groups, fileBrowser, general, app } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const L = s.lattice;
    const center = [0, 1, 2].map((k) => 0.5 * (L[0][k] + L[1][k] + L[2][k]));
    const t = app.controls.target;
    return {
      shaft: groups.spinShaftMesh ? groups.spinShaftMesh.count : 0,
      tip: groups.spinTipMesh ? groups.spinTipMesh.count : 0,
      atoms: s.atoms.length,
      spinCount: s.spins?.length ?? 0,
      copiesOn: general.showSpinsOnCopies,
      target: [t.x, t.y, t.z],
      center,
      targetErr: Math.hypot(t.x - center[0], t.y - center[1], t.z - center[2]),
    };
  });
  H.check('spin meshes present', spins0.shaft > 0 && spins0.tip > 0, JSON.stringify(spins0));
  H.check('loaded structure is the 8-atom conventional cell', spins0.atoms === 8, JSON.stringify(spins0));
  // Item 1: initial load centers the orbit target on the structure (not a corner).
  H.check('initial camera target is the structure center (not a cell corner)',
    spins0.targetErr < 0.05, JSON.stringify({ target: spins0.target, center: spins0.center }));
  // Item 3: widget forces spins on periodic copies, so a corner atom (Fe at
  // 0,0,0) yields extra arrow instances beyond the 4 primary Fe (shaft = 2/arrow).
  H.check('widget forces spins on periodic copies (extra arrow instances)',
    spins0.copiesOn === true && spins0.shaft > 8, JSON.stringify(spins0));

  // Item 3: widget auto-applies spin scaling on load (not the default 1.0).
  const autoLoad = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { autoSpinScale } = await import('./render/index.js');
    const want = Math.min(Math.max(autoSpinScale(fileBrowser.selectedStructure), 0.1), 10);
    return { spinScale: general.spinScale, want };
  });
  H.check('widget auto-applies spin scaling on load',
    Math.abs(autoLoad.spinScale - autoLoad.want) < 1e-6 && Math.abs(autoLoad.spinScale - 1.0) > 1e-6,
    JSON.stringify(autoLoad));

  // Item 4: the locked composition legend is read-only (labels not editable).
  const editable = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.comp-legend-widget .comp-legend-label')];
    return { count: els.length, anyEditable: els.some((e) => e.isContentEditable) };
  });
  H.check('locked legend labels are not editable', editable.count > 0 && editable.anyEditable === false, JSON.stringify(editable));

  // Item 5: widget legend opens toward the lower-right of the view (the axes
  // gizmo below takes the lower-left).
  const pos = await page.evaluate(() => {
    const w = document.querySelector('.comp-legend-widget');
    const r = w.getBoundingClientRect();
    const view = document.getElementById('view').getBoundingClientRect();
    return {
      inRightHalf: (r.left + r.width / 2) > view.left + view.width / 2,
      rightEdgeGap: view.right - r.right,
      bottomEdgeGap: view.bottom - r.bottom,
    };
  });
  H.check('widget legend is anchored lower-right of the view (right/bottom edges within 40px)',
    pos.inRightHalf && Math.abs(pos.rightEdgeGap) < 40 && Math.abs(pos.bottomEdgeGap) < 40,
    JSON.stringify(pos));

  // --- Axes gizmo: shown lower-left, integrated arrow labels, no legend box --
  const gizmo = await page.evaluate(async () => {
    const { general, app } = await import('./state/store.js');
    const g = document.getElementById('axesGizmo');
    const legend = document.getElementById('axesLegend');
    const gr = g.getBoundingClientRect();
    const view = document.getElementById('view').getBoundingClientRect();
    const legendVisible = !!legend && legend.offsetParent !== null
      && getComputedStyle(legend).display !== 'none';
    const scene = app.gizmoScene;
    // Base --gizmo-size (theme token) vs the widget's rendered box: the embed
    // pins the gizmo at 2.5x. The renderer canvas must track the div box, so
    // resizeGizmoRenderer() actually scaled the drawing, not just the frame.
    const baseSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gizmo-size'));
    const canvas = g.querySelector('canvas');
    return {
      gizmoVisible: g.offsetParent !== null && getComputedStyle(g).display !== 'none',
      leftEdgeGap: gr.left - view.left,
      bottomEdgeGap: view.bottom - gr.bottom,
      pointerEvents: getComputedStyle(g).pointerEvents,
      labelsOnArrows: general.gizmoLabelsOnArrows,
      aVisible: !!scene?.userData?.aLabel?.visible,
      bVisible: !!scene?.userData?.bLabel?.visible,
      cVisible: !!scene?.userData?.cLabel?.visible,
      legendVisible,
      baseSize,
      boxWidth: gr.width,
      canvasWidth: canvas ? canvas.getBoundingClientRect().width : null,
    };
  });
  H.check('axes gizmo is visible, anchored lower-left of the view (left/bottom edges within 40px)',
    gizmo.gizmoVisible && Math.abs(gizmo.leftEdgeGap) < 40 && Math.abs(gizmo.bottomEdgeGap) < 40,
    JSON.stringify(gizmo));
  H.check('axes gizmo is purely decorative (pointer-events: none)',
    gizmo.pointerEvents === 'none', JSON.stringify(gizmo));
  H.check('gizmo labels are integrated onto the arrows (a/b/c sprites visible)',
    gizmo.labelsOnArrows === true && gizmo.aVisible && gizmo.bVisible && gizmo.cVisible,
    JSON.stringify(gizmo));
  H.check('the separate #axesLegend box is not shown', gizmo.legendVisible === false, JSON.stringify(gizmo));
  H.check('widget gizmo box is 2.5x the base --gizmo-size',
    gizmo.baseSize > 0 && Math.abs(gizmo.boxWidth - gizmo.baseSize * 2.5) < 2, JSON.stringify(gizmo));
  H.check('gizmo renderer canvas tracks the enlarged box (drawing scaled, not just the frame)',
    gizmo.canvasWidth != null && Math.abs(gizmo.canvasWidth - gizmo.boxWidth) < 2, JSON.stringify(gizmo));

  // --- Logo IS the menu trigger; no cog ------------------------------------
  const menu = await page.evaluate(() => {
    const logo = document.querySelector('#widgetLogo');
    const before = document.querySelector('.widget-settings-menu')?.hidden;
    logo.click();
    const m = document.querySelector('.widget-settings-menu');
    const titles = [...document.querySelectorAll('.widget-menu-group-label')].map((e) => e.textContent);
    const res = {
      isButton: logo.tagName === 'BUTTON',
      notAnchor: logo.tagName !== 'A',
      hasPopup: logo.getAttribute('aria-haspopup'),
      cog: !!document.querySelector('.widget-settings-btn'),
      hiddenBefore: before, hiddenAfter: m.hidden, expanded: logo.getAttribute('aria-expanded'),
      titles,
    };
    logo.click(); // close again
    return res;
  });
  H.check('logo is a role=button trigger, not a link', menu.isButton && menu.notAnchor && menu.hasPopup === 'menu', JSON.stringify(menu));
  H.check('no cog button exists', menu.cog === false, JSON.stringify(menu));
  H.check('clicking the logo opens the menu (aria-expanded)', menu.hiddenBefore === true && menu.hiddenAfter === false && menu.expanded === 'true', JSON.stringify(menu));
  H.check('groups are titled Structures + Presets', menu.titles.includes('Structures') && menu.titles.includes('Presets'), JSON.stringify(menu.titles));

  // "Open in CrysViz" opens the same structure minus widget= in a new tab.
  const opened = await page.evaluate(() => {
    let captured = null;
    const orig = window.open;
    window.open = (url, target, feat) => { captured = { url, target, feat }; return null; };
    document.querySelector('.widget-menu-item[data-action="open"]').click();
    window.open = orig;
    return captured;
  });
  H.check('Open in CrysViz opens the full UI (#load-file=, no widget=, new tab)',
    !!opened && opened.url.includes('#load-file=') && !opened.url.includes('widget=')
      && opened.target === '_blank' && String(opened.feat).includes('noopener'), JSON.stringify(opened));

  // --- Bonds / Polyhedra check-toggles -------------------------------------
  const toggles = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const bondsRow = document.querySelector('.widget-menu-item[data-toggle="bonds"]');
    const polyRow = document.querySelector('.widget-menu-item[data-toggle="poly"]');
    const before = { bonds: general.showBonds, poly: general.showPolyhedra,
      bondsChecked: bondsRow.getAttribute('aria-checked'), polyChecked: polyRow.getAttribute('aria-checked') };
    bondsRow.click();
    const afterBonds = { bonds: general.showBonds, checked: bondsRow.getAttribute('aria-checked') };
    return { before, afterBonds };
  });
  H.check('Polyhedra defaults OFF in the widget', toggles.before.poly === false && toggles.before.polyChecked === 'false', JSON.stringify(toggles));
  H.check('Bonds toggle flips state + checkmark', toggles.afterBonds.bonds === !toggles.before.bonds
    && toggles.afterBonds.checked === (toggles.afterBonds.bonds ? 'true' : 'false'), JSON.stringify(toggles));
  // Restore bonds on so the rest of the scene looks normal.
  await page.evaluate(() => { const r = document.querySelector('.widget-menu-item[data-toggle="bonds"]'); if (r.getAttribute('aria-checked') === 'false') r.click(); });

  // Boot atom/bond sizes = the "Normal" restore target.
  const boot = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return { atomSize: general.atomSize, bondRadius: general.bondRadius };
  });

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
  const autoSwap = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { autoSpinScale } = await import('./render/index.js');
    const want = Math.min(Math.max(autoSpinScale(fileBrowser.selectedStructure), 0.1), 10);
    return { spinScale: general.spinScale, want };
  });
  H.check('widget re-applies auto scaling after a structure switch',
    Math.abs(autoSwap.spinScale - autoSwap.want) < 1e-6, JSON.stringify(autoSwap));
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

  // --- Presets: ray tracing bumps sizes; Normal restores (LAST — no swap follows) ---
  await page.evaluate(() => {
    document.querySelector('.widget-menu-item[data-group="preset"][data-value="raytrace"]').click();
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
    return { pipeline: general.renderPipeline, modalVisible, atomSize: general.atomSize, bondRadius: general.bondRadius };
  });
  H.check('Ray tracing sets renderPipeline=raytrace', rt.pipeline === 'raytrace', JSON.stringify(rt));
  H.check('no ray/path-tracing warning modal appears', rt.modalVisible === false, JSON.stringify(rt));
  H.check('Ray tracing bumps atom size to 0.50 and bond diameter to 0.17',
    Math.abs(rt.atomSize - 0.50) < 1e-9 && Math.abs(rt.bondRadius - 0.17) < 1e-9, JSON.stringify(rt));

  // Cel shading also resets sizes to the boot defaults (every preset owns its look).
  await page.evaluate(() => {
    document.querySelector('.widget-menu-item[data-group="preset"][data-value="cel"]').click();
  });
  const cel = await H.waitFor(page, async () => {
    const { general } = await import('./state/store.js');
    if (general.renderStyle !== 'cel') return null;
    return { atomSize: general.atomSize, bondRadius: general.bondRadius };
  }, { timeout: 15000, interval: 500 });
  H.check('Cel shading resets atom/bond sizes to the boot defaults',
    !!cel && Math.abs(cel.atomSize - boot.atomSize) < 1e-9 && Math.abs(cel.bondRadius - boot.bondRadius) < 1e-9,
    JSON.stringify({ cel, boot }));

  await page.evaluate(() => {
    document.querySelector('.widget-menu-item[data-group="preset"][data-value="normal"]').click();
  });
  const back2 = await H.waitFor(page, async () => {
    const { general } = await import('./state/store.js');
    if (general.renderPipeline === 'raytrace') return null;
    return { pipeline: general.renderPipeline, atomSize: general.atomSize, bondRadius: general.bondRadius };
  }, { timeout: 20000, interval: 500 });
  H.check('Normal restores the boot atom/bond sizes',
    !!back2 && Math.abs(back2.atomSize - boot.atomSize) < 1e-9 && Math.abs(back2.bondRadius - boot.bondRadius) < 1e-9,
    JSON.stringify({ back2, boot }));
  await page.waitForTimeout(1000); // settle before teardown

  // --- Console cleanliness --------------------------------------------------
  H.check('no console errors during the widget session',
    errors.length === 0, errors.slice(0, 3).join(' | '));

  await H.finish(browser);
})().catch(H.crash);
