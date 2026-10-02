// Per-structure spin / force arrow styles (issue #18, ui/ArrowStylePrefs.js):
// the Spins/Forces panel settings (length, size, tip, log length, colour
// map, range, log scale, legend), the per-element category colours and the
// per-arrow colour/hide overrides are stored under `spinStyle`/`forceStyle`
// by structure content and re-applied when the same file is loaded again.
// Then "Clear local data" + the programmatic redraw paths must not bring
// them back.
'use strict';
const H = require('../harness');

// Two ionic steps (a trajectory), Fe + O, each step with a collinear
// magnetization block (spins) and a POSITION/TOTAL-FORCE block (forces).
const STEP = (oX, toten) => [
  '  direct lattice vectors                 reciprocal lattice vectors',
  '     4.000000000  0.000000000  0.000000000     0.250000000  0.000000000  0.000000000',
  '     0.000000000  4.000000000  0.000000000     0.000000000  0.250000000  0.000000000',
  '     0.000000000  0.000000000  4.000000000     0.000000000  0.000000000  0.250000000',
  '',
  ' magnetization (x)',
  ' ',
  '# of ion       s       p       d       tot',
  '------------------------------------------',
  '    1        0.010   0.020   2.170   2.200',
  '    2        0.000   0.300   0.000   0.300',
  '--------------------------------------------------',
  'tot          0.010   0.320   2.170   2.500',
  '',
  ' POSITION                                       TOTAL-FORCE (eV/Angst)',
  ' -----------------------------------------------------------------------------------',
  '      0.00000      0.00000      0.00000         0.800000      0.100000      0.000000',
  `      ${oX.toFixed(5)}      2.00000      2.00000        -0.300000      0.000000      0.200000`,
  ' -----------------------------------------------------------------------------------',
  '    total drift:                                0.000000      0.000000      0.000000',
  '',
  `  free  energy   TOTEN  =      ${toten.toFixed(8)} eV`,
  '',
];
const OUTCAR = [
  ' vasp.6.4.2 20Jul23 complex',
  ' POTCAR:    PAW_PBE Fe 06Sep2000',
  ' POTCAR:    PAW_PBE O 08Apr2002',
  '   ions per type =               1   1',
  '',
  ...STEP(2.0, -10.0), ...STEP(1.9, -11.0),
].join('\n');

const KEY = 'crysviz.structurePrefs.v1';

async function loadFixture(page) {
  await page.evaluate(async (text) => {
    const { general } = await import('./state/store.js');
    // Arrows on before the load, so the restore's own redraw is observable.
    general.spinsActive = true;
    general.forcesActive = true;
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'OUTCAR');
  }, OUTCAR);
  await page.waitForTimeout(1500);
}

async function openPanels(page) {
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('spins').expand();
    getPanel('forces').expand();
  });
  await page.waitForTimeout(400);
}

const STATE = async () => {
  const { general, fileBrowser, groups } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  const val = (id) => {
    const el = /** @type {any} */ (document.getElementById(id));
    return el ? (el.type === 'checkbox' ? el.checked : el.value) : null;
  };
  const legend = (id) => document.querySelector(`#${id} .cv-colorbar-legend`)?.textContent ?? null;
  const limits = (id) => [...document.querySelectorAll(`#${id} .cv-colorbar-value-input`)].map((i) => /** @type {any} */ (i).value);
  const forceInst = groups.forcesInstancesBySrcIndex?.get(1)?.[0];
  const forceRgb = forceInst != null && groups.forcesShaftMesh?.instanceColor
    ? [...groups.forcesShaftMesh.instanceColor.array.slice(forceInst * 6, forceInst * 6 + 3)].map((v) => Math.round(v * 255))
    : null;
  return {
    g: {
      spinScale: general.spinScale, spinRadius: general.spinRadius, spinTipLength: general.spinTipLength,
      spinLengthLogScale: general.spinLengthLogScale, spinColorMap: general.spinColorMap,
      spinColorScale: general.spinColorScale, spinMin: general.spinMin, spinMax: general.spinMax,
      spinLegendText: general.spinLegendText,
      forceScale: general.forceScale, forceRadius: general.forceRadius, forceColorMap: general.forceColorMap,
      forceColorScale: general.forceColorScale, forceMin: general.forceMin, forceMax: general.forceMax,
      forceLengthLogScale: general.forceLengthLogScale, forceLegendText: general.forceLegendText,
    },
    w: {
      spinLength: val('spinLengthSlider'), spinSize: val('spinSizeSlider'), spinTip: val('spinTipLengthSlider'),
      spinLogLength: val('spinLogLengthCheckbox'), spinLog: val('spinLogScaleCheckbox'), spinCmap: val('spinColorMapSelect'),
      spinLegend: legend('spinColorBarContainer'), spinLimits: limits('spinColorBarContainer'),
      forceScale: val('forceScaleSlider'), forceRadius: val('forceRadiusSlider'), forceCmap: val('forceColorMapSelect'),
      forceLog: val('forceLogScaleCheckbox'), forceLegend: legend('forceColorBarContainer'),
      forceLimits: limits('forceColorBarContainer'),
    },
    spinCat: s?.spinCategoryStyles ?? null,
    forceCat: s?.forceCategoryStyles ?? null,
    forceUserColor1: s?.forces?.[1]?.userColor?.getHexString?.() ?? null,
    spinHidden1: !!s?.spins?.[1]?.hidden,
    spinDrawn: [...(groups.spinsInstancesBySrcIndex?.keys?.() ?? [])],
    forceCount: groups.forcesShaftMesh?.count ?? 0,
    forceRgb,
    stored: localStorage.getItem('crysviz.structurePrefs.v1'),
  };
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());

  await loadFixture(page);
  await openPanels(page);
  const base = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return { spins: s.spins?.length ?? 0, forces: s.forces?.length ?? 0, elements: s.elements.join(',') };
  });
  H.check('fixture has spins and forces', base.spins === 2 && base.forces === 2, JSON.stringify(base));

  // ---- User edits through the real widgets ----------------------------------
  await H.setSlider(page, 'spinLengthSlider', 2.5);
  await H.setSlider(page, 'spinSizeSlider', 0.12);
  await H.setSlider(page, 'spinTipLengthSlider', 0.8);
  await H.setSelect(page, 'spinColorMapSelect', 'viridis');
  await H.clickById(page, 'spinLogLengthCheckbox');
  await H.setSlider(page, 'forceScaleSlider', 3);
  await H.setSlider(page, 'forceRadiusSlider', 0.05);
  await H.setSelect(page, 'forceColorMapSelect', 'jet');
  await H.clickById(page, 'forceLogScaleCheckbox');
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    // Colour-bar range + legend (the widget's own inputs).
    const [mn, mx] = document.querySelectorAll('#forceColorBarContainer .cv-colorbar-value-input');
    /** @type {any} */ (mn).value = '0.2'; /** @type {any} */ (mx).value = '1.7';
    mn.dispatchEvent(new Event('blur'));
    const lg = /** @type {HTMLElement} */ (document.querySelector('#spinColorBarContainer .cv-colorbar-legend'));
    lg.click();
    lg.textContent = 'My moment';
    lg.dispatchEvent(new Event('blur'));
  });
  // Per-element (category) colour, per-arrow colour and hide.
  await page.evaluate(async () => {
    const { createSpinForceCategoryEditor } = await import('./ui/StructureInfoPanel/components/SpinForceCategoryEditor.js');
    const { createSpinForceEditor } = await import('./ui/StructureInfoPanel/components/SpinForceEditor.js');
    const cat = createSpinForceCategoryEditor(['Fe']);
    document.body.appendChild(cat);
    const hex = cat.querySelector('input[placeholder="#ffcc00"]');
    /** @type {any} */ (hex).value = '#11AA33';
    hex.dispatchEvent(new Event('change'));

    const ed = createSpinForceEditor(1, document.createElement('div'));
    document.body.appendChild(ed);
    /** @type {any} */ (ed.querySelector('.spin-hide-label input')).click(); // spin mode: hide atom 1's spin
    /** @type {any} */ (ed.querySelectorAll('.spin-mode-switch-btn')[1]).click(); // force mode
    /** @type {any} */ (ed.querySelector('.spin-buttons-row button:nth-child(3)')).click();
    const pick = ed.querySelector('.spin-color-picker-section input[placeholder="#ffcc00"]');
    /** @type {any} */ (pick).value = '#FF00AA';
    pick.dispatchEvent(new Event('change'));
    cat.remove(); ed.remove();
  });
  await page.waitForTimeout(600); // past the 250 ms debounce

  const saved = await page.evaluate(STATE);
  const rec = Object.values(JSON.parse(saved.stored || '{}')).find((r) => r.spinStyle || r.forceStyle) || {};
  const sp = rec.spinStyle || {}, fo = rec.forceStyle || {};
  H.check('spinStyle stored with only the edited keys',
    sp.scale === 2.5 && sp.radius === 0.12 && sp.tipLength === 0.8 && sp.colorMap === 'viridis'
      && sp.lengthLogScale === true && sp.colorScale === 'log' && sp.legendText === 'My moment'
      && sp.categoryStyles?.Fe?.color?.toLowerCase() === '#11aa33'
      && JSON.stringify(sp.hidden) === '[1]' && !('min' in sp), JSON.stringify(sp));
  H.check('forceStyle stored', fo.scale === 3 && fo.radius === 0.05 && fo.colorMap === 'jet'
      && fo.colorScale === 'log' && fo.min === 0.2 && fo.max === 1.7
      && fo.arrowColors?.[1] === '#ff00aa' && !('lengthLogScale' in fo), JSON.stringify(fo));

  // ---- Reload, load the same file again: everything comes back ------------
  const reload = async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(5000);
  };
  await reload();
  await loadFixture(page);
  await openPanels(page);
  const back = await page.evaluate(STATE);
  const g = back.g, w = back.w;
  H.check('spin general.* restored', g.spinScale === 2.5 && g.spinRadius === 0.12 && g.spinTipLength === 0.8
    && g.spinColorMap === 'viridis' && g.spinLengthLogScale === true && g.spinColorScale === 'log'
    && g.spinLegendText === 'My moment', JSON.stringify(g));
  H.check('force general.* restored', g.forceScale === 3 && g.forceRadius === 0.05 && g.forceColorMap === 'jet'
    && g.forceColorScale === 'log' && g.forceMin === 0.2 && g.forceMax === 1.7, JSON.stringify(g));
  H.check('spin widgets restored', Number(w.spinLength) === 2.5 && Number(w.spinSize) === 0.12
    && Number(w.spinTip) === 0.8 && w.spinCmap === 'viridis' && w.spinLogLength === true && w.spinLog === true
    && w.spinLegend === 'My moment', JSON.stringify(w));
  H.check('force widgets restored', Number(w.forceScale) === 3 && Number(w.forceRadius) === 0.05
    && w.forceCmap === 'jet' && w.forceLog === true
    && Number(w.forceLimits[0]) === 0.2 && Number(w.forceLimits[1]) === 1.7, JSON.stringify(w));
  H.check('category style restored', back.spinCat?.Fe?.color?.toLowerCase() === '#11aa33', JSON.stringify(back.spinCat));
  H.check('per-arrow overrides restored', back.forceUserColor1 === 'ff00aa' && back.spinHidden1 === true,
    JSON.stringify({ c: back.forceUserColor1, h: back.spinHidden1 }));
  H.check('arrows redrawn with the restored overrides',
    back.forceCount > 0
      // #ff00aa; the instance colour buffer holds it in linear space (0xaa -> 103).
      && ['[255,0,170]', '[255,0,103]'].includes(JSON.stringify(back.forceRgb))
      && back.spinDrawn.includes(0) && !back.spinDrawn.includes(1),
    JSON.stringify({ n: back.forceCount, rgb: back.forceRgb, spins: back.spinDrawn }));

  // The other trajectory frame carries the per-arrow/category overrides too.
  const frame1 = await page.evaluate(async () => {
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    showTrajectoryFrame(1, container);
    await new Promise((r) => setTimeout(r, 300));
    const s = fileBrowser.selectedStructure;
    return { color: s.forces?.[1]?.userColor?.getHexString?.() ?? null, hidden: !!s.spins?.[1]?.hidden,
      cat: s.spinCategoryStyles?.Fe?.color ?? null };
  });
  H.check('frame 1 carries the restored overrides', frame1.color === 'ff00aa' && frame1.hidden === true
    && String(frame1.cat).toLowerCase() === '#11aa33', JSON.stringify(frame1));

  // ---- Clear local data (the real button), programmatic paths, reload ------
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('settings').expand();
  });
  await page.waitForTimeout(300);
  await H.clickById(page, 'clearLocalDataButton');
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const { general, fileBrowser, structureShip } = await import('./state/store.js');
    const { updateSpins, updateForces } = await import('./render/index.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { selectLastAddedRow } = await import('./ui/FileBrowswerPanel.js');
    const { restoreArrowStyle } = await import('./ui/ArrowStylePrefs.js');
    const { rebuildPanel } = await import('./ui/panels/PanelManager.js');
    updateSpins(general.spinScale, false, [], general.spinColorMap);
    updateForces();
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    showTrajectoryFrame(0, container);
    selectLastAddedRow();
    rebuildPanel('spins');
    rebuildPanel('forces');
    restoreArrowStyle('force', container, { scale: 4 }, fileBrowser.selectedStructure);
  });
  await page.waitForTimeout(700);
  const afterClear = await page.evaluate((k) => localStorage.getItem(k), KEY);
  H.check('nothing written back after clear + programmatic applies',
    !afterClear || !/spinStyle|forceStyle/.test(afterClear), String(afterClear).slice(0, 200));

  await reload();
  await loadFixture(page);
  await openPanels(page);
  const cleared = await page.evaluate(STATE);
  H.check('settings back at defaults', cleared.g.spinScale === 1 && cleared.g.spinRadius === 0.08
    && cleared.g.spinColorMap === 'none' && cleared.g.forceScale === 1 && cleared.g.forceColorMap === 'heatmap'
    && cleared.g.forceColorScale === 'linear' && cleared.g.spinLegendText == null, JSON.stringify(cleared.g));
  H.check('overrides gone', !cleared.spinCat?.Fe && cleared.forceUserColor1 == null && cleared.spinHidden1 === false,
    JSON.stringify({ cat: cleared.spinCat, c: cleared.forceUserColor1, h: cleared.spinHidden1 }));
  H.check('no stored record with the arrow fields', !cleared.stored || !/spinStyle|forceStyle/.test(cleared.stored),
    String(cleared.stored).slice(0, 200));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
