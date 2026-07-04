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
    const heads = document.querySelectorAll('#cvPanelBody-visual .panel-headline');
    return heads.length === 4 && [...heads].every((h) => h.tagName === 'LABEL');
  }));
  H.check('Settings keeps the storage switch', await inBody(page, 'settings', 'StorageOptionSwitch'));
  H.check('Settings keeps the drag toggles', await inBody(page, 'settings', 'dragIntoDockToggle'));

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
  H.check('Bonds: Histogram button present', await page.evaluate(() => !!document.getElementById('bondHistogram')));
  H.check('Bonds: stub Angle Histogram / Coordination Number buttons removed',
    await page.evaluate(() => !document.getElementById('angleHistogram') && !document.getElementById('coordinationNumber')));
  H.check('Bonds: Bond Length Controls section removed',
    await page.evaluate(() => !document.getElementById('bondControls') && !document.getElementById('bondLengthPanel')));
  H.check('Bonds: no collapsible flip-outs left',
    await page.evaluate(() => !document.querySelector('#cvPanelBody-bonds .bond-toggle')));
  H.check('Bonds keeps Neighbour Bonds row', await inBody(page, 'bonds', 'PBCBondToggle'));
  H.check('Bond Diameter moved out of Bonds', !(await inBody(page, 'bonds', 'bondWidth')));

  // --- Histogram window: normal closable floating window -----------------------
  await H.clickById(page, 'bondHistogram');
  await page.waitForTimeout(300);
  const hist = await page.evaluate(() => {
    const el = document.querySelector('.cv-panel[data-panel-id="histogram"]');
    if (!el) return null;
    const closeBtn = el.querySelector('.cv-panel-close');
    return {
      floating: el.classList.contains('cv-floating'),
      barVisible: !el.classList.contains('cv-bar-collapsed'),
      closable: !!closeBtn && !closeBtn.hidden,
    };
  });
  H.check('Histogram opens as a floating window with a visible title bar and close button',
    !!hist && hist.floating && hist.barVisible && hist.closable, JSON.stringify(hist));
  await page.screenshot({ path: path.join(ARTIFACTS, 'uipanels-histogram.png') });
  await page.evaluate(() => {
    /** @type {HTMLElement} */ (document.querySelector('.cv-panel[data-panel-id="histogram"] .cv-panel-close')).click();
  });
  await page.waitForTimeout(200);
  H.check('Histogram window closes via its close button',
    await page.evaluate(() => !document.querySelector('.cv-panel[data-panel-id="histogram"]')));

  // --- Cell & Supercell: flat sections -----------------------------------------
  await expandPanel(page, 'cell');
  const cell = await page.evaluate(() => ({
    flipouts: document.querySelectorAll('#cvPanelBody-cell .bond-toggle').length,
    headlines: document.querySelectorAll('#cvPanelBody-cell .panel-headline').length,
    latticeVisible: (document.getElementById('latticeContent')?.offsetHeight ?? 0) > 0,
    supercellVisible: (document.getElementById('supercellContent')?.offsetHeight ?? 0) > 0,
    transformVisible: (document.getElementById('transformContent')?.offsetHeight ?? 0) > 0,
  }));
  H.check('Cell: flip-outs replaced by flat headlines',
    cell.flipouts === 0 && cell.headlines === 3, JSON.stringify(cell));
  H.check('Cell: all three sections\' content visible',
    cell.latticeVisible && cell.supercellVisible && cell.transformVisible, JSON.stringify(cell));
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

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
