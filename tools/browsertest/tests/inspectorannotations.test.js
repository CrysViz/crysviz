// Annotations shared by the 3D view and the inspectors:
//
//   - Aˣ⁺ (charges) sits next to Aₓ (atom labels) in the Structure window and
//     in the Selection Inspector's title row; it is the same setting as
//     Features ▸ Show Charges (either one moves the other). Greyed out for a
//     structure without charges (YBCO); a CIF with oxidation states (NaCl
//     written Na1+ / Cl1-) gets badges in the view and in the inspector.
//   - their size: Settings ▸ Atom labels ▸ Charges (3D view), the inspector's
//     own Charges size slider (its badges)
//   - the 3D view's measurements show in the Selection Inspector when their
//     atoms are inspected: a distance between two selected atoms appears
//     with its value (keyed m:<id>), the Measured switch hides them, and
//     removing the measurement removes it; one that repeats a labelled bond
//     is left to the bond's own label.
// See ui/AtomLabelsToggle.js and AnalysisPanels/inspectorLabels.js.
'use strict';
const H = require('../harness');

const NACL_CIF = [
  'data_nacl',
  '_cell_length_a 5.64', '_cell_length_b 5.64', '_cell_length_c 5.64',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
  'loop_', '_atom_site_label', '_atom_site_type_symbol',
  '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Na1 Na1+ 0 0 0', 'Na2 Na1+ 0.5 0.5 0', 'Na3 Na1+ 0.5 0 0.5', 'Na4 Na1+ 0 0.5 0.5',
  'Cl1 Cl1- 0.5 0 0', 'Cl2 Cl1- 0 0.5 0', 'Cl3 Cl1- 0 0 0.5', 'Cl4 Cl1- 0.5 0.5 0.5',
  '',
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO: no charges

  const buttons = () => page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const b = (id) => {
      const el = /** @type {HTMLButtonElement|null} */ (document.getElementById(id));
      return el ? { text: el.textContent, pressed: el.getAttribute('aria-pressed'), disabled: el.getAttribute('aria-disabled') === 'true', title: el.title } : null;
    };
    return {
      on: general.showCharges === true,
      box: /** @type {HTMLInputElement|null} */ (document.getElementById('showCharges'))?.checked ?? null,
      structure: b('chargeBadgesButton'),
      inspector: b('siChargeBadgesButton'),
      labels: b('atomLabelsButton'),
      order: [...(document.getElementById('atomLabelsButton')?.parentElement?.children ?? [])].map((c) => c.id),
    };
  });
  const inspectorLabels = () => page.evaluate(async () => {
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    return (getSelectionInspectorState()?.labels ?? []).map((l) => ({ key: l.key, text: l.text, bg: l.bg, visible: l.visible }));
  });

  // ---- 1. the two switches, side by side; no charges in YBCO ----------------------
  let b = await buttons();
  H.check('Aₓ and Aˣ⁺ sit side by side after ✎ and ❖', b.labels?.text === 'Ax' && b.structure?.text === 'Ax+'
    && b.order.join(',') === 'addButton,compositionLegendButton,atomLabelsButton,chargeBadgesButton', JSON.stringify(b));
  H.check('a structure without charges: Aˣ⁺ is greyed out and says why',
    b.structure.disabled && /has no charges/.test(b.structure.title) && /^Charges \(Aˣ⁺\)/.test(b.structure.title) && !b.on,
    JSON.stringify(b.structure));
  await H.clickById(page, 'chargeBadgesButton');
  await page.waitForTimeout(200);
  b = await buttons();
  H.check('… and pressing it does nothing', !b.on && b.structure.pressed === 'false', JSON.stringify(b.structure));
  H.check('Aₓ has a tooltip naming it', /^Atom labels \(Aₓ\)/.test(b.labels.title), b.labels.title);

  // ---- 2. NaCl with oxidation states ---------------------------------------------
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    window.__load = cv.loadStructure(text, 'nacl.cif');
  }, NACL_CIF);
  await page.waitForTimeout(1500);
  // A symmetry or errors dialog would wait for an answer: load it as it is.
  await page.evaluate(() => {
    const plain = [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')]
      .find((x) => /normal structure/i.test(x.textContent || ''));
    plain?.click();
  });
  await page.evaluate(async () => { await window.__load; });
  await page.waitForTimeout(800);
  b = await buttons();
  H.check('NaCl (Na1+, Cl1-): Aˣ⁺ is available, off', !b.structure.disabled && b.structure.pressed === 'false', JSON.stringify(b.structure));
  await H.clickById(page, 'chargeBadgesButton');
  await page.waitForTimeout(400);
  b = await buttons();
  const badges = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const g = app.scene.getObjectByName('chargeBadges');
    return g ? g.children.length : 0;
  });
  H.check('Aˣ⁺ on: badges in the view, pressed, and Features ▸ Show Charges ticked with it',
    b.on && b.structure.pressed === 'true' && b.box === true && badges > 0, JSON.stringify({ b, badges }));

  // The Selection Inspector on a Na and a Cl.
  const pair = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const na = w.elements.indexOf('Na');
    let cl = -1, best = Infinity;
    w.cart.forEach((c, i) => {
      if (w.elements[i] !== 'Cl') return;
      const d = Math.hypot(...[0, 1, 2].map((k) => c[k] - w.cart[na][k]));
      if (d < best) { best = d; cl = i; }
    });
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    selectAtomsByInstances([na, cl]);
    const { openSelectionInspector } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    openSelectionInspector();
    return { na, cl };
  });
  await page.waitForTimeout(1200);
  let ins = await inspectorLabels();
  b = await buttons();
  const charges = ins.filter((l) => /^charge:/.test(l.key)).map((l) => l.text).sort();
  H.check('the inspector has the same Aˣ⁺, pressed, and shows each atom\'s charge',
    b.inspector?.text === 'Ax+' && b.inspector.pressed === 'true' && charges.join(',') === '+,−', JSON.stringify({ charges, insp: b.inspector }));

  // Their sizes: Settings ▸ Atom labels ▸ Charges for the 3D view, the
  // inspector's own Charges slider for its badges.
  const badgeHeight = () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.scene.getObjectByName('chargeBadges')?.children[0]?.scale.y ?? null;
  });
  const insHeights = () => page.evaluate(async () => {
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    const ls = getSelectionInspectorState()?.labels ?? [];
    return { charge: ls.filter((l) => /^charge:/.test(l.key)).map((l) => l.height), other: ls.filter((l) => !/^charge:/.test(l.key)).map((l) => l.height) };
  });
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('settings'));
  await page.waitForTimeout(500);
  const main1 = await badgeHeight();
  const ins1 = await insHeights();
  await H.setSlider(page, 'chargeLabelSize', 2);
  await page.waitForTimeout(300);
  const main2 = await badgeHeight();
  const insAfterSettings = await insHeights();
  H.check('Settings ▸ Atom labels ▸ Charges at 2 doubles the 3D view\'s badges, not the inspector\'s',
    main1 > 0 && Math.abs(main2 / main1 - 2) < 1e-6 && JSON.stringify(insAfterSettings) === JSON.stringify(ins1),
    JSON.stringify({ main1, main2, ins1, insAfterSettings }));
  await H.setSlider(page, 'chargeLabelSize', 1);
  await H.setSlider(page, 'siSize-charge', 2);
  await page.waitForTimeout(300);
  const ins2 = await insHeights();
  const readout = await page.evaluate(() => document.getElementById('siSizeValue-charge')?.textContent);
  H.check('the inspector\'s Charges slider at 2 doubles its badges and nothing else',
    ins1.charge.length === 2 && ins2.charge.every((h, k) => Math.abs(h / ins1.charge[k] - 2) < 1e-6)
      && JSON.stringify(ins2.other) === JSON.stringify(ins1.other) && readout === '2.00',
    JSON.stringify({ ins1, ins2, readout }));
  await H.setSlider(page, 'siSize-charge', 1);
  await page.waitForTimeout(200);

  // Features ▸ Show Charges off: every Aˣ⁺ and the inspector follow.
  await page.evaluate(() => {
    const box = /** @type {HTMLInputElement} */ (document.getElementById('showCharges'));
    box.checked = false;
    box.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(400);
  b = await buttons();
  ins = await inspectorLabels();
  H.check('Show Charges unticked in Features: both Aˣ⁺ released, no charges in the inspector',
    !b.on && b.structure.pressed === 'false' && b.inspector.pressed === 'false' && !ins.some((l) => /^charge:/.test(l.key)),
    JSON.stringify({ b, ins }));

  // ---- 3. measurements in the inspector -----------------------------------------------
  // Na and Cl are bonded here: a distance between them repeats the bond's label.
  const measure = (a, c) => page.evaluate(async ({ a, c }) => {
    const THREE = await import('./external/three/three.module.js');
    const { fileBrowser } = await import('./state/store.js');
    const { addDistanceMeasurement } = await import('./render/MeasurementModule.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const atom = (i) => ({ position: new THREE.Vector3(...w.cart[i]),
      userData: { atomIndex: w.srcIndex[i], element: w.elements[i], wrappedFrac: [...w.frac[i]] } });
    addDistanceMeasurement(atom(a), atom(c));
    return Math.hypot(...[0, 1, 2].map((k) => w.cart[a][k] - w.cart[c][k]));
  }, { a, c });
  const bonded = await page.evaluate(async () => {
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    return getSelectionInspectorState()?.bonds ?? 0;
  });
  await measure(pair.na, pair.cl);
  await page.waitForTimeout(400);
  ins = await inspectorLabels();
  H.check('a measured distance that is also a labelled bond is left to the bond\'s label',
    bonded === 1 && !ins.some((l) => /^m:/.test(l.key)), JSON.stringify({ bonded, ins }));

  // Two Na (not bonded): select them, measure them.
  const nas = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const list = w.elements.map((e, i) => (e === 'Na' ? i : -1)).filter((i) => i >= 0);
    const a = list[0];
    let c = -1, best = Infinity;
    for (const i of list) {
      if (i === a || w.srcIndex[i] === w.srcIndex[a]) continue;
      const d = Math.hypot(...[0, 1, 2].map((k) => w.cart[i][k] - w.cart[a][k]));
      if (d < best) { best = d; c = i; }
    }
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    selectAtomsByInstances([a, c]);
    return { a, c };
  });
  await page.waitForTimeout(600);
  const d = await measure(nas.a, nas.c);
  await page.waitForTimeout(400);
  ins = await inspectorLabels();
  const m = ins.find((l) => /^m:/.test(l.key));
  H.check('a distance measured between two inspected atoms shows in the inspector, with its value',
    m && m.text === `${d.toFixed(3)} Å`, JSON.stringify({ m, d, ins }));
  await H.shotCanvas(page, 'inspector-measure');

  // Settings ▸ Measurements ▸ Colors: a new distance colour reaches the inspector.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { refreshMeasurementStyling } = await import('./render/MeasurementModule.js');
    general.measureDistanceColor = '#00aa00';
    refreshMeasurementStyling(); // what the Settings colour picker calls
  });
  await page.waitForTimeout(400);
  const recoloured = (await inspectorLabels()).find((l) => /^m:/.test(l.key));
  H.check('a measurement colour changed in Settings recolours it in the inspector',
    recoloured?.bg === 'rgba(0,170,0,0.92)', JSON.stringify(recoloured));

  await page.evaluate(() => {
    const box = /** @type {HTMLInputElement} */ (document.getElementById('siMeasuresToggle'));
    box.checked = false;
    box.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  ins = await inspectorLabels();
  const hidden = !ins.some((l) => /^m:/.test(l.key));
  await page.evaluate(() => {
    const box = /** @type {HTMLInputElement} */ (document.getElementById('siMeasuresToggle'));
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  ins = await inspectorLabels();
  H.check('the Measured switch hides them and shows them again', hidden && ins.some((l) => /^m:/.test(l.key)), JSON.stringify(ins));

  await page.evaluate(async () => (await import('./render/MeasurementModule.js')).clearAllMeasurements());
  await page.waitForTimeout(400);
  ins = await inspectorLabels();
  H.check('removing the measurements removes them from the inspector', !ins.some((l) => /^m:/.test(l.key)), JSON.stringify(ins));

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
