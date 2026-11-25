// NCI analysis (ui/NciControls.js, model/NciField.js, workers/nciTasks.js).
//
// A synthetic Gaussian cube — the promolecular density of three H atoms on an
// equilateral triangle (side 3 bohr) on a 41³ grid, 0.15 bohr spacing — is
// loaded through the real file path. ∇ρ vanishes at the three edge midpoints
// (λ₂ < 0, attractive) and at the ring centre (λ₂ > 0, repulsive), so the
// s = 0.5 surface is three discs and a ring-centre blob in contrasting colours.
// (A He dimer is too tight for this: its s < 0.5 basin is thinner than a
// grid step.) Asserts, for the SCF button and then the promolecular one:
//   (1) the NCI block renders under the field list with both buttons enabled
//       and an "i" button;
//   (2) pressing a button adds the s and sign(λ₂)ρ fields with the expected
//       labels and selects the s field at iso 0.5, coloured by sign(λ₂)ρ
//       through 'bgyor';
//   (3) the isosurface mesh exists and carries a per-vertex colour attribute
//       that is not flat;
//   (4) the status line reports the added fields;
// and that the "i" button opens the NCI document.
'use strict';
const path = require('path');
const H = require('../harness');

const N = 41;          // grid points per axis (odd: the centre is a grid point)
const STEP = 0.15;     // bohr
const SIDE = 3.0;      // bohr, H–H distance
const TITLE = 'H3 NCI browser-test fixture';
const DESCRIPTION = 'Electron density from Total SCF Density';

/** H free-atom density, NCIPLOT fit (the H–Ar tables Jmol uses). */
function hydrogenDensity(r) {
  return 0.2815 * Math.exp(-r / 0.5288);
}

/** The cube text: bohr axes (positive N), one value set, z fastest. */
function buildCube() {
  const origin = -(N - 1) * STEP / 2;
  const R = SIDE / Math.sqrt(3); // circumradius
  const atoms = [0, 1, 2].map((i) => {
    const a = (2 * Math.PI * i) / 3;
    return [R * Math.cos(a), R * Math.sin(a), 0];
  });
  const lines = [
    TITLE,
    DESCRIPTION,
    `    3 ${origin.toFixed(6)} ${origin.toFixed(6)} ${origin.toFixed(6)}`,
    `   ${N} ${STEP.toFixed(6)} 0.000000 0.000000`,
    `   ${N} 0.000000 ${STEP.toFixed(6)} 0.000000`,
    `   ${N} 0.000000 0.000000 ${STEP.toFixed(6)}`,
    ...atoms.map(([x, y, z]) => `    1 1.000000 ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`),
  ];
  for (let i = 0; i < N; i++) {
    const x = origin + i * STEP;
    for (let j = 0; j < N; j++) {
      const y = origin + j * STEP;
      let row = [];
      for (let k = 0; k < N; k++) {
        const z = origin + k * STEP;
        let rho = 0;
        for (const [ax, ay, az] of atoms) rho += hydrogenDensity(Math.hypot(x - ax, y - ay, z - az));
        row.push(rho.toExponential(5).toUpperCase());
        if (row.length === 6) { lines.push(` ${row.join(' ')}`); row = []; }
      }
      if (row.length) lines.push(` ${row.join(' ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Wait for a run started by `buttonId` to finish and report the app state. */
async function pressAndInspect(page, buttonId) {
  await page.evaluate((id) => document.getElementById(id).click(), buttonId);
  await H.waitFor(page, () => {
    const status = document.getElementById('nciStatus');
    const busy = document.querySelector('.nci-controls')?.getAttribute('aria-busy') === 'true';
    return !busy && /Added 2 fields/.test(status?.textContent || '');
  }, { timeout: 60000, interval: 250 });
  await page.waitForTimeout(500);
  return page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const { fieldBrowser } = await import('./ui/FieldPanel.js');
    const selected = fieldBrowser.selectedField;
    const mesh = groups.isosurfaceGroup?.meshes?.positive;
    const geometry = mesh?.geometry;
    const color = geometry?.getAttribute?.('color');
    let rgbSpread = 0;
    if (color) {
      const a = color.array;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < color.count; i++) {
        // Blue minus red: -1 for red, +1 for blue — spans the NCI colour scale.
        const t = a[i * 4 + 2] - a[i * 4];
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
      rgbSpread = hi - lo;
    }
    const checkedRadio = document.querySelector('#fieldCatalogMount .fc-leaf-radio:checked');
    return {
      labels: fieldBrowser.availableFields.map((f) => f.label),
      selectedLabel: selected?.label,
      isoValue: selected?.isoValue,
      useAbs: selected?.useAbsoluteIsoValue,
      colorByLabel: selected?.colorBy?.field?.label,
      colormap: selected?.colorBy?.colormap,
      colorRange: [selected?.colorBy?.min, selected?.colorBy?.max],
      sMax: selected?.maxValue,
      colourUnit: selected?.colorBy?.field?.valueUnit,
      derivedOp: selected?.derivedOp,
      vertexCount: geometry?.getAttribute?.('position')?.count ?? 0,
      hasColor: Boolean(color),
      vertexColors: Boolean(mesh?.material?.vertexColors),
      rgbSpread,
      checkedRadioLabel: checkedRadio?.parentElement?.querySelector('.fc-leaf-label')?.textContent,
      status: document.getElementById('nciStatus')?.textContent,
      error: document.getElementById('fieldCatalogError')?.textContent,
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));

  const cube = buildCube();
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'h3.cube');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('field');
  }, cube);
  await page.waitForTimeout(2500);

  // --- (1) the block renders ------------------------------------------------
  const block = await page.evaluate(() => {
    const scf = document.getElementById('nciScfBtn');
    const promo = document.getElementById('nciPromolecularBtn');
    const root = document.querySelector('#nciControlsMount .nci-controls');
    return {
      present: Boolean(scf && promo && root),
      scfEnabled: scf ? !scf.disabled : false,
      promoEnabled: promo ? !promo.disabled : false,
      scfText: scf?.textContent,
      promoText: promo?.textContent,
      hasInfo: Boolean(root?.querySelector('.info-button')),
      afterList: Boolean(document.getElementById('fieldCatalogMount')
        ?.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });
  H.check('NCI block renders under the field list with both buttons and an "i" button',
    block.present && block.hasInfo && block.afterList
      && block.scfText === 'Create SCF-NCI field' && block.promoText === 'Create Promolecular NCI field',
    JSON.stringify(block));
  H.check('both buttons are enabled for a cube with atoms and a selected density',
    block.scfEnabled && block.promoEnabled, JSON.stringify(block));

  // --- (2)-(4) SCF-NCI ------------------------------------------------------
  const scf = await pressAndInspect(page, 'nciScfBtn');
  // A cube field is labelled with both comment lines (io/ReadCubeModule.js).
  const densityLabel = `${TITLE} ${DESCRIPTION}`;
  const scfS = `Reduced density gradient s (SCF-NCI of ${densityLabel})`;
  const scfC = `sign(λ₂)ρ (SCF-NCI of ${densityLabel})`;
  H.check('SCF-NCI adds the s and sign(λ₂)ρ fields', scf.labels.includes(scfS) && scf.labels.includes(scfC),
    JSON.stringify(scf.labels));
  H.check('SCF-NCI selects the s field at iso 0.5, coloured by sign(λ₂)ρ via bgyor over ±0.04',
    scf.selectedLabel === scfS && scf.isoValue === 0.5 && scf.useAbs === false
      && scf.colorByLabel === scfC && scf.colormap === 'bgyor'
      && scf.colorRange[0] === -0.04 && scf.colorRange[1] === 0.04
      && scf.derivedOp === 'nci-s' && scf.colourUnit === 'e/bohr³',
    JSON.stringify(scf));
  H.check('the field list radio follows the new selection', scf.checkedRadioLabel === scfS,
    String(scf.checkedRadioLabel));
  H.check('SCF-NCI isosurface has vertices and a non-flat per-vertex colour',
    scf.vertexCount > 0 && scf.hasColor && scf.vertexColors && scf.rgbSpread > 0.05,
    JSON.stringify({ n: scf.vertexCount, hasColor: scf.hasColor, vc: scf.vertexColors, spread: scf.rgbSpread }));
  H.check('status line reports the run and no error is shown', /Added 2 fields/.test(scf.status) && !scf.error,
    JSON.stringify({ status: scf.status, error: scf.error }));
  await H.shotCanvas(page, 'nci-scf');
  await page.evaluate(() => document.getElementById('nciControlsMount')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', 'nci-scf-panel.png') });

  // --- promolecular -----------------------------------------------------------
  const promo = await pressAndInspect(page, 'nciPromolecularBtn');
  const proS = 'Reduced density gradient s (promolecular NCI)';
  const proC = 'sign(λ₂)ρ (promolecular NCI)';
  H.check('promolecular NCI adds its two fields (5 fields in total)',
    promo.labels.includes(proS) && promo.labels.includes(proC) && promo.labels.length === 5,
    JSON.stringify(promo.labels));
  H.check('promolecular NCI selects its s field at iso 0.5, coloured by its sign(λ₂)ρ',
    promo.selectedLabel === proS && promo.isoValue === 0.5 && promo.colorByLabel === proC
      && promo.colormap === 'bgyor',
    JSON.stringify(promo));
  H.check('promolecular isosurface has vertices and a non-flat per-vertex colour',
    promo.vertexCount > 0 && promo.hasColor && promo.rgbSpread > 0.05,
    JSON.stringify({ n: promo.vertexCount, hasColor: promo.hasColor, spread: promo.rgbSpread }));
  await H.shotCanvas(page, 'nci-promolecular');

  // A second SCF run on the same source must not duplicate a label.
  await page.evaluate(async () => {
    const { fieldBrowser } = await import('./ui/FieldPanel.js');
    const source = fieldBrowser.availableFields[0];
    const radio = [...document.querySelectorAll('#fieldCatalogMount .fc-leaf')]
      .find((row) => row.querySelector('.fc-leaf-label')?.textContent === source.label)
      ?.querySelector('.fc-leaf-radio');
    radio?.click();
  });
  await page.waitForTimeout(300);
  const again = await pressAndInspect(page, 'nciScfBtn');
  H.check('re-running SCF-NCI gives unique labels', new Set(again.labels).size === again.labels.length
    && again.labels.length === 7, JSON.stringify(again.labels));

  // --- the "i" document -------------------------------------------------------
  await page.evaluate(() => document.querySelector('.nci-controls .info-button').click());
  await H.waitFor(page, () => /Non-covalent interactions/.test(
    document.querySelector('.info-panel-content')?.textContent || ''), { timeout: 10000, interval: 250 });
  const doc = await page.evaluate(() => document.querySelector('.info-panel-content')?.textContent || '');
  H.check('the "i" button opens the NCI document',
    /Non-covalent interactions/.test(doc) && /sign\(λ₂\)ρ/.test(doc) && /AECCAR0/.test(doc), doc.slice(0, 120));
  await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', 'nci-info.png') });

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
