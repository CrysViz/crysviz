// The 2026-07 panel regroup: Visual window (sizes, unit cell, colors, camera),
// slim Settings placed last, flattened Bonds/Cell sections, histogram as a
// normal closable window, axes-gizmo line width, per-species/per-atom sizes.
'use strict';
const path = require('path');
const H = require('../harness');

const ARTIFACTS = path.join(__dirname, '..', 'artifacts');

async function inBody(page, panelId, elementId) {
  return page.evaluate(({ panelId, elementId }) => {
    const el = document.getElementById(elementId);
    return !!el && !!el.closest(`#cvPanelBody-${panelId}`);
  }, { panelId, elementId });
}

async function expandPanel(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel(id).expand();
  }, id);
  await page.waitForTimeout(300);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // --- dock order: Visual after Features, Settings last -----------------------
  const dockOrder = await page.evaluate(() => Array.from(
    document.querySelectorAll('#dock > .cv-panel')).map((el) => el.dataset.panelId));
  H.check('Visual window sits in Settings\' old slot',
    dockOrder.indexOf('visual') === dockOrder.indexOf('features') + 1, JSON.stringify(dockOrder));
  H.check('Settings window is last in the dock',
    dockOrder[dockOrder.length - 1] === 'settings', JSON.stringify(dockOrder));

  // --- Visual window contents --------------------------------------------------
  for (const id of ['atomSize', 'bondWidth', 'showLattice', 'latticeWidth', 'showAxes', 'axesWidth',
    'backgroundDotToggle', 'backgroundSwatch', 'colorControlsGroup', 'cameraControlsGroup']) {
    H.check(`Visual window hosts #${id}`, await inBody(page, 'visual', id));
  }
  H.check('headlines are plain labels', await page.evaluate(() => {
    // Sizes / Scene / Rendering / Colors / Camera
    const heads = document.querySelectorAll('#cvPanelBody-visual .panel-headline');
    return heads.length === 5 && [...heads].every((h) => h.tagName === 'LABEL');
  }));
  // The storage-granularity switch is deliberately NOT adopted into Settings
  // (no wiring yet) but stays in the DOM so it can return later — see
  // ui/panels/defaultPanels.js buildContent for the settings panel.
  H.check('storage switch stays out of Settings but in the DOM',
    !(await inBody(page, 'settings', 'StorageOptionSwitch'))
      && await page.evaluate(() => !!document.getElementById('StorageOptionSwitch')));
  H.check('Settings keeps the drag toggles', await inBody(page, 'settings', 'dragIntoDockToggle'));
  H.check('Settings hosts the drag-by-handle toggle', await inBody(page, 'settings', 'dragByHandleToggle'));
  H.check('drag-by-handle pref round-trips', await page.evaluate(async () => {
    const { getPanelPref, setPanelPref } = await import('./ui/panels/PanelManager.js');
    setPanelPref('dragByHandleOnly', true);
    const on = getPanelPref('dragByHandleOnly') === true
      && JSON.parse(localStorage.getItem('panelPrefs')).dragByHandleOnly === true;
    setPanelPref('dragByHandleOnly', false);
    return on && getPanelPref('dragByHandleOnly') === false;
  }));

  // --- axes gizmo line width slider -------------------------------------------
  await H.setSlider(page, 'axesWidth', 0.05);
  const shaftScale = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.gizmoScene.userData.aArrow.userData.shaft.scale.x;
  });
  H.check('axes width slider drives the gizmo arrow shafts',
    Math.abs(shaftScale - 0.05) < 1e-6, `scale.x=${shaftScale}`);

  // --- unit-cell outline width slider -------------------------------------------
  await H.setSlider(page, 'latticeWidth', 0.06);
  const lattice = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const child = groups.latticeGroup?.children?.[0];
    return {
      edges: groups.latticeGroup?.children?.length ?? 0,
      type: child?.geometry?.type,
      radius: child?.geometry?.parameters?.radiusTop,
    };
  });
  H.check('cell line width slider drives the outline cylinders',
    lattice.edges === 12 && lattice.type === 'CylinderGeometry' && Math.abs(lattice.radius - 0.06) < 1e-6,
    JSON.stringify(lattice));

  // --- background picker toggle + in-panel swatch --------------------------------
  await H.clickById(page, 'backgroundDotToggle');
  const dotHidden = await page.evaluate(() => document.getElementById('backgroundDot').style.display === 'none');
  await H.clickById(page, 'backgroundDotToggle');
  const dotBack = await page.evaluate(() => document.getElementById('backgroundDot').style.display !== 'none');
  H.check('toggle hides and restores the on-canvas background dot', dotHidden && dotBack);
  await H.clickById(page, 'backgroundSwatch');
  const pickerOpen = await page.evaluate(() => !!document.querySelector('.spin-color-picker'));
  await page.evaluate(() => document.querySelector('.spin-color-picker')?.remove());
  H.check('in-panel swatch opens the background color picker', pickerOpen);

  // --- Bonds window ------------------------------------------------------------
  await expandPanel(page, 'bonds');
  H.check('Bonds: histogram Open buttons present', await page.evaluate(() =>
    !!document.getElementById('openBondLengthHistogram') && !!document.getElementById('openCoordinationHistogram')));
  H.check('Bonds: Bond Length Controls section removed',
    await page.evaluate(() => !document.getElementById('bondControls') && !document.getElementById('bondLengthPanel')));
  H.check('Bonds: no collapsible flip-outs left',
    await page.evaluate(() => !document.querySelector('#cvPanelBody-bonds .bond-toggle')));
  H.check('Neighbour Bonds moved to Features',
    (await inBody(page, 'features', 'PBCBondToggle')) && !(await inBody(page, 'bonds', 'PBCBondToggle')));
  H.check('Bond Diameter moved out of Bonds', !(await inBody(page, 'bonds', 'bondWidth')));

  // --- Bond Length Histogram: ONE ordinary window, right dock by default -------
  await H.clickById(page, 'openBondLengthHistogram');
  await page.waitForTimeout(400);
  const hist = await page.evaluate(() => {
    const el = document.querySelector('#splitPaneBody > .cv-panel[data-panel-id="bondLengthHistogram"]');
    if (!el) return null;
    return {
      front: el.classList.contains('cv-front'),
      splitActive: document.getElementById('viewArea').classList.contains('split-active'),
      tab: [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
        .some((t) => t.dataset.panelId === 'bondLengthHistogram'),
      // One card per bond pair plus a combined "All Pairs" one, so the panel is
      // populated iff at least one card exists (was #bond-length-histogram-item,
      // a single item, before the per-pair rewrite).
      hasCard: !!el.querySelector('.blh-pair-card'),
    };
  });
  H.check('Bond Length Histogram opens as the right dock\'s front tab',
    !!hist && hist.front && hist.splitActive && hist.tab && hist.hasCard, JSON.stringify(hist));
  await page.screenshot({ path: path.join(ARTIFACTS, 'uipanels-histogram.png') });
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
      .find((t) => t.dataset.panelId === 'bondLengthHistogram');
    /** @type {HTMLElement} */ (tab.querySelector('.split-pane-tab-menu')).click();
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    [...document.querySelectorAll('.cv-panel-menu-item')]
      .find((b) => b.textContent === 'Close')?.click();
  });
  await page.waitForTimeout(200);
  H.check('Histogram window closes via its tab ≡ menu (transient: unregistered)',
    await page.evaluate(() => !document.querySelector('.cv-panel[data-panel-id="bondLengthHistogram"]')
      && !document.getElementById('viewArea').classList.contains('split-active')));

  // --- Cell & Supercell: flat sections -----------------------------------------
  await expandPanel(page, 'cell');
  const cell = await page.evaluate(() => ({
    flipouts: document.querySelectorAll('#cvPanelBody-cell .bond-toggle').length,
    // Assert the headline TEXTS, not just the count: a bare number goes stale
    // the moment a section is added (this expected 3 and started failing when
    // the Vacuum section landed) and tells you nothing about which one moved.
    headlines: [...document.querySelectorAll('#cvPanelBody-cell .panel-headline')]
      .map((h) => h.textContent.trim()),
    supercellVisible: (document.getElementById('supercellContent')?.offsetHeight ?? 0) > 0,
    transformVisible: (document.getElementById('transformContent')?.offsetHeight ?? 0) > 0,
  }));
  // The old "Lattice Parameters" (a/b/c/α/β/γ + Volume) section was removed —
  // that cell is now edited through the Modify Structure panel's lattice
  // inputs, so the Cell panel keeps only Supercell/Vacuum/Transformation.
  H.check('Cell: flip-outs replaced by flat headlines',
    cell.flipouts === 0
      && JSON.stringify(cell.headlines)
        === JSON.stringify(['Supercell', 'Vacuum', 'Lattice Transformation']),
    JSON.stringify(cell));
  H.check('Cell: remaining sections\' content visible',
    cell.supercellVisible && cell.transformVisible, JSON.stringify(cell));
  H.check('Cell keeps Show Periodic Images', await inBody(page, 'cell', 'showPeriodic'));
  H.check('Show Unit Cell moved out of Cell', !(await inBody(page, 'cell', 'showLattice')));

  // --- per-atom radius scale plumbing ------------------------------------------
  const radii = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updateSingleAtomDiameter } = await import('./render/AtomsFracUpdateModule.js');
    const s = fileBrowser.selectedStructure;
    const imageIndex = s.atomImages[0][0];
    const before = groups.atomsMesh.instanceMatrix.array[imageIndex * 16];
    s.atoms[0].setRadiusScale(2);
    updateSingleAtomDiameter(imageIndex, s.elements[0], s.atoms[0].getRadiusScale());
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
    const after = groups.atomsMesh.instanceMatrix.array[imageIndex * 16];
    return { before, after };
  });
  H.check('per-atom radius scale doubles the instance radius',
    Math.abs(radii.after - radii.before * 2) < 1e-6, JSON.stringify(radii));

  // --- Size sliders exist in the Structure window's atoms editors --------------
  const sizeSliders = await page.evaluate(() => {
    const editors = document.querySelectorAll('.element-color-editor');
    let withSize = 0;
    editors.forEach((ed) => {
      const spans = ed.querySelectorAll('span');
      for (const sp of spans) if (sp.textContent === 'Size') { withSize++; break; }
    });
    return { editors: editors.length, withSize };
  });
  H.check('per-species editors include a Size slider',
    sizeSliders.editors > 0 && sizeSliders.withSize === sizeSliders.editors, JSON.stringify(sizeSliders));

  await page.screenshot({ path: path.join(ARTIFACTS, 'uipanels-dock.png'), fullPage: false });

  // --- .crysviz save: menu entry + captured state contents ---------------------
  H.check('Download menu has a CrysViz entry', await page.evaluate(() => {
    const btn = document.getElementById('saveCrysvizButton');
    return !!btn && !!btn.closest('#downloadMenu');
  }));
  const state = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    return captureState();
  });
  H.check('captured state has the new visual keys (v2.15)',
    state.version === '2.15'
      && state.display.latticeLineWidth === 0.06
      && state.display.axesLineWidth === 0.05
      && typeof state.display.bondRadius === 'number'
      && typeof state.display.showAxes === 'boolean'
      && state.style && typeof state.style.renderStyle === 'string'
      && typeof state.style.renderPipeline === 'string'
      && /^#[0-9a-f]{6}$/.test(state.style.background || ''),
    JSON.stringify({ version: state.version, display: state.display, style: state.style }).slice(0, 300));
  H.check('captured state includes the per-atom size override',
    state.colors.atomRadiusScales && state.colors.atomRadiusScales['0'] === 2,
    JSON.stringify(state.colors.atomRadiusScales));
  H.check('captured state has no window placements',
    !JSON.stringify(state).includes('panelLayout') && !('panels' in state));

  // --- round-trip: restore the captured state through the ?state= loader -------
  const encoded = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const bytes = new TextEncoder().encode(JSON.stringify(captureState()));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  });
  const baseUrl = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';
  await page.goto(`${baseUrl}?state=${encoded}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(6000);
  const restored = await page.evaluate(async () => {
    const { general, app, fileBrowser } = await import('./state/store.js');
    return {
      latticeLineWidth: general.latticeLineWidth,
      axesLineWidth: general.axesLineWidth,
      shaftScale: app.gizmoScene.userData.aArrow.userData.shaft.scale.x,
      atom0Scale: fileBrowser.selectedStructure.atoms[0].getRadiusScale(),
      latticeSlider: /** @type {HTMLInputElement} */ (document.getElementById('latticeWidth')).value,
      cylinderRadius: (await import('./state/store.js')).groups.latticeGroup?.children?.[0]?.geometry?.parameters?.radiusTop,
    };
  });
  H.check('round-trip restores widths, per-atom size and slider positions',
    restored.latticeLineWidth === 0.06 && restored.axesLineWidth === 0.05
      && Math.abs(restored.shaftScale - 0.05) < 1e-6
      && restored.atom0Scale === 2
      && Number(restored.latticeSlider) === 0.06
      && Math.abs(restored.cylinderRadius - 0.06) < 1e-6,
    JSON.stringify(restored));

  // --- .crysviz load: save the state, change settings, load the file back ------
  // Rotate/zoom the camera first: orientation (incl. the trackball-rolled up
  // vector) and zoom must survive the save -> load round trip.
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.camera.position.set(12, 7, 25);
    app.camera.up.set(0, 0, 1);
    app.controls.target.set(2, 1, 3);
    app.camera.zoom = 1.7;
    app.camera.updateProjectionMatrix();
    app.controls.update();
  });
  const crysvizContent = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    return JSON.stringify({ format: 'crysviz', ...captureState() }, null, 2);
  });
  await H.setSlider(page, 'latticeWidth', 0.02); // diverge from the saved state
  await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updateSingleAtomDiameter } = await import('./render/AtomsFracUpdateModule.js');
    const s = fileBrowser.selectedStructure;
    s.atoms[0].setRadiusScale(1);
    updateSingleAtomDiameter(s.atomImages[0][0], s.elements[0], 1);
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
  });
  await page.evaluate(async (content) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(content, 'saved-session.crysviz');
  }, crysvizContent);
  await page.waitForTimeout(1000); // camera/measurement restore timers
  const loaded = await page.evaluate(async () => {
    const { general, fileBrowser, app } = await import('./state/store.js');
    return {
      latticeLineWidth: general.latticeLineWidth,
      atom0Scale: fileBrowser.selectedStructure.atoms[0].getRadiusScale(),
      camera: {
        position: [app.camera.position.x, app.camera.position.y, app.camera.position.z],
        up: [app.camera.up.x, app.camera.up.y, app.camera.up.z],
        target: [app.controls.target.x, app.controls.target.y, app.controls.target.z],
        zoom: app.camera.zoom,
      },
      rowNames: [...document.querySelectorAll('#structureTablePanel tbody tr')]
        .map((r) => { try { return JSON.parse(/** @type {HTMLElement} */ (r).dataset.obj).name; } catch { return null; } }),
    };
  });
  H.check('.crysviz load restores the saved visual state',
    loaded.latticeLineWidth === 0.06 && loaded.atom0Scale === 2, JSON.stringify(loaded));
  const vecNear = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-2);
  H.check('.crysviz load restores camera orientation, rotation and zoom',
    vecNear(loaded.camera.position, [12, 7, 25])
      && vecNear(loaded.camera.up, [0, 0, 1])
      && vecNear(loaded.camera.target, [2, 1, 3])
      && Math.abs(loaded.camera.zoom - 1.7) < 1e-3,
    JSON.stringify(loaded.camera));
  H.check('.crysviz load adds a structure row under its file name',
    loaded.rowNames.includes('saved-session.crysviz'), JSON.stringify(loaded.rowNames));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
