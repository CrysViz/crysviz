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
    const body = w.querySelector('.comp-legend-body');
    const bg = getComputedStyle(body).backgroundColor;
    // Transparent = rgba(...,0) or the keyword; anything opaque is a surface.
    const bgTransparent = bg === 'transparent' || /,\s*0\s*\)$/.test(bg) || bg === 'rgba(0, 0, 0, 0)';
    return {
      present: true,
      visible: r.width > 0 && r.height > 0 && getComputedStyle(w).display !== 'none',
      rows: w.querySelectorAll('.comp-legend-row').length,
      labels,
      bg,
      bgTransparent,
    };
  });
  H.check('composition legend is on screen', legend.present && legend.visible, JSON.stringify(legend));
  H.check('legend shows the two element rows (Fe, O)',
    legend.rows === 2 && legend.labels.includes('Fe') && legend.labels.includes('O'),
    JSON.stringify(legend));
  H.check('widget legend has no background surface', legend.bgTransparent === true, JSON.stringify(legend));

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
    // The embed sizes the compass relative to the widget: --widget-gizmo is
    // clamp(48px, 17vmin, 150px). The renderer canvas must track the div box, so
    // resizeGizmoRenderer() actually scaled the drawing, not just the frame.
    const vmin = Math.min(view.width, view.height);
    const expectedBox = Math.min(Math.max(48, 0.17 * vmin), 150);
    const canvas = g.querySelector('canvas');
    return {
      // offsetParent is null for position:fixed under Chromium, so judge
      // visibility from the computed display + a laid-out box instead.
      gizmoVisible: getComputedStyle(g).display !== 'none' && gr.width > 0 && gr.height > 0,
      leftEdgeGap: gr.left - view.left,
      bottomEdgeGap: view.bottom - gr.bottom,
      pointerEvents: getComputedStyle(g).pointerEvents,
      labelsOnArrows: general.gizmoLabelsOnArrows,
      labelFactor: general.gizmoLabelSizeFactor,
      aVisible: !!scene?.userData?.aLabel?.visible,
      bVisible: !!scene?.userData?.bLabel?.visible,
      cVisible: !!scene?.userData?.cLabel?.visible,
      legendVisible,
      expectedBox,
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
  H.check('widget enlarges the on-arrow label sprites (factor > 1)',
    gizmo.labelFactor > 1, JSON.stringify(gizmo));
  H.check('the separate #axesLegend box is not shown', gizmo.legendVisible === false, JSON.stringify(gizmo));
  H.check('widget gizmo box is sized relative to the widget (clamp(48px,17vmin,150px))',
    Math.abs(gizmo.boxWidth - gizmo.expectedBox) < 2, JSON.stringify(gizmo));
  H.check('gizmo renderer canvas tracks the box (drawing scaled, not just the frame)',
    gizmo.canvasWidth != null && Math.abs(gizmo.canvasWidth - gizmo.boxWidth) < 2, JSON.stringify(gizmo));

  // --- Reduced camera control: top-right, a/b/c view + reset ----------------
  const cam = await page.evaluate(() => {
    const host = document.getElementById('widgetCamera');
    if (!host) return { present: false };
    const r = host.getBoundingClientRect();
    const view = document.getElementById('view').getBoundingClientRect();
    const titles = [...host.querySelectorAll('.cv-tb-btn')].map((b) => b.title);
    return {
      present: true,
      visible: r.width > 0 && r.height > 0 && getComputedStyle(host).display !== 'none',
      inTopRight: (r.left + r.width / 2) > view.left + view.width / 2 && r.top < view.top + view.height / 2,
      titles,
      hasReset: !!host.querySelector('.camera-tool-reset-btn'),
    };
  });
  H.check('reduced camera control is present, top-right',
    cam.present && cam.visible && cam.inTopRight, JSON.stringify(cam));
  H.check('camera control carries a/b/c view buttons + reset',
    cam.titles.includes('View A axis') && cam.titles.includes('View B axis')
      && cam.titles.includes('View C axis') && cam.hasReset, JSON.stringify(cam));

  // Clicking a lattice-axis view button re-aims the camera (no error, pose changes).
  const aim = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const before = app.camera.position.clone();
    [...document.querySelectorAll('#widgetCamera .camera-tool-btn')][0].click(); // View A
    const after = app.camera.position;
    return { moved: before.distanceTo(after) > 1e-6 };
  });
  H.check('View A re-aims the camera', aim.moved === true, JSON.stringify(aim));

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
  H.check('groups are titled Structures + Shading', menu.titles.includes('Structures') && menu.titles.includes('Shading'), JSON.stringify(menu.titles));

  // "Open in CrysViz" leads the menu (top item).
  const firstItem = await page.evaluate(() => {
    document.querySelector('#widgetLogo').click(); // open
    const first = document.querySelector('.widget-settings-menu .widget-menu-item');
    const res = { action: first?.dataset.action, text: first?.querySelector('.widget-menu-text')?.textContent?.trim() };
    document.querySelector('#widgetLogo').click(); // close
    return res;
  });
  H.check('Open in CrysViz is the top menu item',
    firstItem.action === 'open' && firstItem.text === 'Open in CrysViz', JSON.stringify(firstItem));

  // Download POSCAR / CIF menu items are present and generate a file from the
  // shown structure (they use the app's own writers; SavePanel is already in the
  // widget graph via ShareModule).
  const dl = await page.evaluate(() => {
    document.querySelector('#widgetLogo').click(); // open
    const p = document.querySelector('.widget-menu-item[data-action="download-poscar"]');
    const c = document.querySelector('.widget-menu-item[data-action="download-cif"]');
    let downloaded = null;
    // Let the writer build a REAL blob URL (no console error) but no-op the
    // anchor click so nothing actually navigates/saves during the test.
    const origCreate = window.URL.createObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    window.URL.createObjectURL = (b) => { downloaded = true; return origCreate.call(window.URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    p?.click();
    HTMLAnchorElement.prototype.click = origClick;
    window.URL.createObjectURL = origCreate;
    document.querySelector('#widgetLogo').click(); // close
    return { hasPoscar: !!p, hasCif: !!c,
      poscarText: p?.querySelector('.widget-menu-text')?.textContent?.trim(),
      cifText: c?.querySelector('.widget-menu-text')?.textContent?.trim(),
      downloaded };
  });
  H.check('menu has Download POSCAR + Download CIF',
    dl.hasPoscar && dl.hasCif && dl.poscarText === 'Download POSCAR' && dl.cifText === 'Download CIF', JSON.stringify(dl));
  H.check('Download POSCAR generates a file (createObjectURL called)', dl.downloaded === true, JSON.stringify(dl));

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

  // --- Cell: Primitive changes the displayed structure ----------------------
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

  // --- Shading: metallic / matte / cel, all on the depth-peel pipeline ------
  // The widget offers only the three material styles — no ray/path tracing and
  // no atom/bond size bumping; only general.renderStyle changes.
  const sizes = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return { atomSize: general.atomSize, bondRadius: general.bondRadius };
  });

  async function pickShading(value) {
    await page.evaluate((v) => {
      document.querySelector(`.widget-menu-item[data-group="preset"][data-value="${v}"]`).click();
    }, value);
    const deadline = Date.now() + 15000;
    for (;;) {
      const r = await page.evaluate(async (v) => {
        const { general } = await import('./state/store.js');
        if (general.renderStyle !== v) return null;
        return { style: general.renderStyle, pipeline: general.renderPipeline,
          atomSize: general.atomSize, bondRadius: general.bondRadius,
          checked: document.querySelector(`.widget-menu-item[data-group="preset"][data-value="${v}"]`).getAttribute('aria-checked') };
      }, value);
      if (r || Date.now() > deadline) return r;
      await page.waitForTimeout(300);
    }
  }

  const matte = await pickShading('matte');
  H.check('Matte sets renderStyle=matte on the depth-peel pipeline, sizes untouched',
    !!matte && matte.style === 'matte' && matte.pipeline === 'depthpeel'
      && Math.abs(matte.atomSize - sizes.atomSize) < 1e-9 && Math.abs(matte.bondRadius - sizes.bondRadius) < 1e-9
      && matte.checked === 'true', JSON.stringify({ matte, sizes }));

  const cel = await pickShading('cel');
  H.check('Cel sets renderStyle=cel on the depth-peel pipeline, sizes untouched',
    !!cel && cel.style === 'cel' && cel.pipeline === 'depthpeel'
      && Math.abs(cel.atomSize - sizes.atomSize) < 1e-9 && Math.abs(cel.bondRadius - sizes.bondRadius) < 1e-9
      && cel.checked === 'true', JSON.stringify({ cel, sizes }));

  const metallic = await pickShading('metallic');
  H.check('Metallic sets renderStyle=metallic on the depth-peel pipeline, sizes untouched',
    !!metallic && metallic.style === 'metallic' && metallic.pipeline === 'depthpeel'
      && Math.abs(metallic.atomSize - sizes.atomSize) < 1e-9 && Math.abs(metallic.bondRadius - sizes.bondRadius) < 1e-9
      && metallic.checked === 'true', JSON.stringify({ metallic, sizes }));

  await page.waitForTimeout(1000); // settle before teardown

  // --- Console cleanliness --------------------------------------------------
  H.check('no console errors during the widget session',
    errors.length === 0, errors.slice(0, 3).join(' | '));

  await H.finish(browser);
})().catch(H.crash);
