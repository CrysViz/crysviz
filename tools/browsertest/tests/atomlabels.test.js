// Atom labels: the "Aₓ" switch next to ✎ (and ❖) in the Structure window
// puts each atom's name ("Ba1", "O3"), as its row in the Atoms tab names it,
// on the atom in the main view and in the Selection Inspector; pressed while
// on. See render/AtomLabelModule.js.
//
//   - the switch sits in the Structure window's title-row buttons, off
//   - on: every atom (and periodic copy) gets a sprite with its name; the
//     names match the Atoms tab's rows; some are visible, and the view's
//     pixels change; the switch reads pressed
//   - a label is 22 CSS px tall on screen at any zoom; a hidden element's
//     labels go with it
//   - Settings ▸ Atom labels ▸ Size scales the main view's labels
//   - the Selection Inspector writes the selected atoms' names on them, sizes
//     them and its length/angle labels with its own Size sliders, and drops
//     the names when the switch goes off
//   - off: no sprites, the view is as before
//   - the inspector's title row has the same Aₓ switch (shared state)
//   - with a Wyckoff lock every member of an orbit reads like its Wyckoff-tab
//     row: "Ba1 2t"; switching the lock off or on renames them at once
//   - atomLabelTexts: element + number per site composition, "(Fe,Ni)1"
'use strict';
const fs = require('fs');
const { PNG } = require('pngjs');
const H = require('../harness');

/** Fraction of pixels that differ (any channel by more than 40) between two shots. */
function diffFraction(fileA, fileB) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0;
  const total = a.width * a.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (Math.abs(a.data[o] - b.data[o]) > 40 || Math.abs(a.data[o + 1] - b.data[o + 1]) > 40
      || Math.abs(a.data[o + 2] - b.data[o + 2]) > 40) n++;
  }
  return n / total;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO, 13 atoms

  const state = () => page.evaluate(async () => {
    const { atomLabelSprites } = await import('./render/AtomLabelModule.js');
    const { general } = await import('./state/store.js');
    const b = document.getElementById('atomLabelsButton');
    return {
      on: general.showAtomLabels,
      button: b ? {
        text: b.textContent, pressed: b.getAttribute('aria-pressed'), active: b.classList.contains('active'),
        title: b.title, inRow: !!b.closest('.si-add-buttons-row'),
        afterPen: b.parentElement ? [...b.parentElement.children].map((c) => c.id) : [],
      } : null,
      sprites: atomLabelSprites(),
    };
  });
  const render = () => page.evaluate(async () => {
    const { renderFrameNow } = await import('./render/AnimateModule.js');
    renderFrameNow();
  });

  // ---- 1. the switch, off -------------------------------------------------------------
  let s = await state();
  H.check('the label switch sits in the Structure window next to ✎ and ❖, off',
    s.button && s.button.inRow && s.button.text === 'Ax'
      && s.button.afterPen.join(',') === 'addButton,compositionLegendButton,atomLabelsButton,chargeBadgesButton'
      && s.button.pressed === 'false' && !s.button.active && s.on === false && s.sprites.length === 0
      && /Atom labels/.test(s.button.title),
    JSON.stringify(s));
  await render();
  const offShot = await H.shotCanvas(page, 'atomlabels-off');

  // ---- 2. on ----------------------------------------------------------------------------
  await H.clickById(page, 'atomLabelsButton');
  await page.waitForTimeout(300);
  await render();
  s = await state();
  const expected = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const st = fileBrowser.selectedStructure;
    const n = {};
    return {
      names: st.elements.map((e) => { n[e] = (n[e] ?? 0) + 1; return `${e}${n[e]}`; }),
      instances: st.periodic.visibleWrapped.cart.length,
    };
  });
  const texts = new Set(s.sprites.map((x) => x.text));
  H.check('on: the switch reads pressed', s.on === true && s.button.pressed === 'true' && s.button.active,
    JSON.stringify(s.button));
  H.check('every atom is named as its Atoms-tab row (element + number), every copy labelled',
    expected.names.every((t) => texts.has(t)) && texts.size === expected.names.length
      && s.sprites.length >= expected.names.length && s.sprites.length <= expected.instances
      && s.sprites.every((x) => x.text === expected.names[x.srcIndex]),
    JSON.stringify({ texts: [...texts], expected, sprites: s.sprites.length }));
  const visible = s.sprites.filter((x) => x.visible).length;
  H.check('labels are visible in the view (some hidden behind atoms or nearer labels)',
    visible > 0 && visible <= s.sprites.length, `${visible}/${s.sprites.length}`);
  const onShot = await H.shotCanvas(page, 'atomlabels-on');
  const changed = diffFraction(offShot, onShot);
  H.check('the view changes where the labels appear (a little of it)', changed > 0.0005 && changed < 0.2, String(changed));

  // Every row of the Atoms tab names its atom the same way.
  const rows = await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    const out = [];
    for (const c of document.querySelectorAll('#atomPanel .comp-container')) {
      c.querySelector('.individual-atoms')?._populateAtomRows?.();
      for (const r of c.querySelectorAll('.individual-atom-row')) {
        out.push([Number(r.dataset.atomIndex), r.querySelector('.iar-name')?.firstChild?.textContent?.trim()]);
      }
    }
    return out;
  });
  H.check('the names are the Atoms tab rows\' names',
    rows.length === expected.names.length && rows.every(([i, name]) => name === expected.names[i]),
    JSON.stringify(rows));

  // ---- 3. size on screen, hidden element -------------------------------------------
  const sized = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { atomLabelSprites } = await import('./render/AtomLabelModule.js');
    const { general, app } = await import('./state/store.js');
    const { renderFrameNow } = await import('./render/AnimateModule.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const group = app.scene.getObjectByName('atomLabels');
    // A label's height in CSS pixels, as drawn.
    const px = (sprite) => {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(app.camera.quaternion);
      const top = sprite.position.clone().addScaledVector(up, sprite.scale.y / 2).project(app.camera);
      const bottom = sprite.position.clone().addScaledVector(up, -sprite.scale.y / 2).project(app.camera);
      return Math.abs(top.y - bottom.y) / 2 * app.renderer.domElement.clientHeight;
    };
    const heights = () => group.children.map(px);
    const h0 = heights();
    const world0 = group.children[0].scale.y;
    // Zoom in 2× (an orthographic camera zooms; a perspective one moves in).
    const cam = app.camera;
    const saved = { pos: cam.position.clone(), zoom: cam.zoom };
    if (cam.isOrthographicCamera) cam.zoom *= 2;
    else cam.position.lerp(app.controls?.target?.clone?.() ?? new THREE.Vector3(), 0.5);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    renderFrameNow();
    const h1 = heights();
    const world1 = group.children[0].scale.y;
    cam.position.copy(saved.pos);
    cam.zoom = saved.zoom;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    renderFrameNow();
    general.atomVisibility = { ...(general.atomVisibility ?? {}), Ba: false };
    updateVisualization({ reRenderAtoms: true });
    renderFrameNow();
    const ba = atomLabelSprites().filter((x) => /^Ba/.test(x.text));
    general.atomVisibility = { ...general.atomVisibility, Ba: true };
    updateVisualization({ reRenderAtoms: true });
    renderFrameNow();
    return {
      h0: [Math.min(...h0), Math.max(...h0)], h1: [Math.min(...h1), Math.max(...h1)], world0, world1, ortho: !!cam.isOrthographicCamera,
      baVisible: ba.filter((x) => x.visible).length, baBack: atomLabelSprites().filter((x) => /^Ba/.test(x.text)).length,
    };
  });
  H.check('labels are 22 px tall on screen (about 13 px of text), whatever the zoom',
    sized.h0[0] > 21 && sized.h0[1] < 23 && sized.h1[0] > 21 && sized.h1[1] < 23 && sized.world1 < sized.world0 * 0.8,
    JSON.stringify(sized));
  H.check('a hidden element\'s atoms show no labels; shown again, they come back',
    sized.baVisible === 0 && sized.baBack > 0, JSON.stringify(sized));

  // Settings ▸ Atom labels ▸ Size scales them, live.
  const slider = await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('settings');
    const el = document.getElementById('atomLabelSize');
    const head = el ? [...el.closest('.cv-panel')?.querySelectorAll('*') ?? []]
      .some((n) => n.children.length === 0 && n.textContent.trim() === 'Atom labels') : false;
    return el ? { value: el.value, min: el.min, max: el.max, inSettings: !!el.closest('.cv-panel[data-panel-id="settings"]'), head } : null;
  });
  H.check('Settings has an Atom labels ▸ Size slider at 1',
    slider?.inSettings && slider.head && slider.value === '1' && Number(slider.min) < 1 && Number(slider.max) > 1, JSON.stringify(slider));
  await H.setSlider(page, 'atomLabelSize', 2);
  const doubled = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app, general } = await import('./state/store.js');
    const { renderFrameNow } = await import('./render/AnimateModule.js');
    renderFrameNow();
    const sprite = app.scene.getObjectByName('atomLabels').children[0];
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(app.camera.quaternion);
    const top = sprite.position.clone().addScaledVector(up, sprite.scale.y / 2).project(app.camera);
    const bottom = sprite.position.clone().addScaledVector(up, -sprite.scale.y / 2).project(app.camera);
    return { px: Math.abs(top.y - bottom.y) / 2 * app.renderer.domElement.clientHeight, scale: general.atomLabelScale,
      readout: document.getElementById('atomLabelSizeValue')?.textContent };
  });
  H.check('Size 2 draws them twice as tall (44 px)', doubled.scale === 2 && Math.abs(doubled.px - 44) < 1 && doubled.readout === '2.00',
    JSON.stringify(doubled));
  await H.shotCanvas(page, 'atomlabels-size2');
  await H.setSlider(page, 'atomLabelSize', 1);

  // ---- 4. the Selection Inspector ------------------------------------------------------
  const pick = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const cu = w.elements.indexOf('Cu');
    const o = w.cart.map((_, i) => i).filter((i) => w.elements[i] === 'O')
      .sort((i, j) => Math.hypot(...[0, 1, 2].map((k) => w.cart[i][k] - w.cart[cu][k]))
        - Math.hypot(...[0, 1, 2].map((k) => w.cart[j][k] - w.cart[cu][k])))[0];
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    selectAtomsByInstances([cu, o]);
    const { openSelectionInspector } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    openSelectionInspector();
    return { cu: w.srcIndex[cu], o: w.srcIndex[o] };
  });
  await page.waitForTimeout(1200);
  const inspector = () => page.evaluate(async () => {
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    const st = getSelectionInspectorState();
    return (st?.labels ?? []).filter((l) => /^atom:/.test(l.key ?? '')).map((l) => ({ text: l.text, visible: l.visible, height: l.height }));
  });
  let ins = await inspector();
  const want = [expected.names[pick.cu], expected.names[pick.o]].sort();
  H.check('the Selection Inspector writes the selected atoms\' names on them',
    ins.map((l) => l.text).sort().join(',') === want.join(',') && ins.some((l) => l.visible),
    JSON.stringify({ ins, want }));
  await H.shotCanvas(page, 'atomlabels-inspector');
  // Its own size sliders: Values (lengths and angles) and Atoms; the main
  // view's (Settings) leaves it alone.
  const lengthHeights = () => page.evaluate(async () => {
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    return (getSelectionInspectorState()?.labels ?? []).filter((l) => !/^atom:/.test(l.key ?? '')).map((l) => l.height);
  });
  const sliders = await page.evaluate(() => ['siSize-value', 'siSize-atom'].map((id) => {
    const el = document.getElementById(id);
    return el ? { value: el.value, inInspector: !!el.closest('.cv-panel[data-panel-id="selectionInspector"]') } : null;
  }));
  H.check('the inspector has its own Size sliders for the values and the atom labels, at 1',
    sliders.every((x) => x && x.value === '1' && x.inInspector), JSON.stringify(sliders));
  const len1 = await lengthHeights();
  await H.setSlider(page, 'atomLabelSize', 2); // Settings: the main view only
  await page.waitForTimeout(300);
  const insMain = await inspector();
  await H.setSlider(page, 'atomLabelSize', 1);
  await H.setSlider(page, 'siSize-atom', 2);
  await page.waitForTimeout(300);
  const ins2 = await inspector();
  const len2 = await lengthHeights();
  await H.setSlider(page, 'siSize-value', 1.5);
  await page.waitForTimeout(300);
  const len3 = await lengthHeights();
  const ins3 = await inspector();
  const readouts = await page.evaluate(() => ['siSizeValue-value', 'siSizeValue-atom'].map((id) => document.getElementById(id)?.textContent));
  await H.shotCanvas(page, 'atomlabels-inspector-sizes');
  await H.setSlider(page, 'siSize-atom', 1);
  await H.setSlider(page, 'siSize-value', 1);
  await page.waitForTimeout(300);
  const ratio = (a, b) => a.length === b.length && a.length > 0 ? a.map((v, k) => v / b[k]) : [];
  H.check('the Settings slider leaves the inspector\'s atom labels as they are',
    insMain.every((l, k) => Math.abs(l.height - ins[k].height) < 1e-9), JSON.stringify({ ins, insMain }));
  H.check('Atoms 2 doubles the inspector\'s atom labels and leaves the values alone',
    ratio(ins2.map((l) => l.height), ins.map((l) => l.height)).every((r) => Math.abs(r - 2) < 1e-6)
      && ratio(len2, len1).every((r) => Math.abs(r - 1) < 1e-6),
    JSON.stringify({ ins, ins2, len1, len2 }));
  H.check('Values 1.5 grows the length labels 1.5×, the atom labels stay; the readouts follow',
    ratio(len3, len1).every((r) => Math.abs(r - 1.5) < 1e-6) && ratio(ins3.map((l) => l.height), ins2.map((l) => l.height)).every((r) => Math.abs(r - 1) < 1e-6)
      && readouts.join(',') === '1.50,2.00',
    JSON.stringify({ len1, len3, readouts }));

  // ---- 5. the inspector's own Aₓ: the same switch -------------------------------------
  const insButton = () => page.evaluate(() => {
    const b = document.getElementById('siAtomLabelsButton');
    return b ? {
      text: b.textContent, pressed: b.getAttribute('aria-pressed'),
      inTitle: !!b.closest('.pi-title-row'),
      rightOfTitle: b.getBoundingClientRect().left > document.querySelector('#selection-inspector-item h4').getBoundingClientRect().left,
    } : null;
  });
  const insOn = await insButton();
  H.check('the inspector\'s title row has the same Aₓ switch, at the right, pressed while the labels are on',
    insOn?.text === 'Ax' && insOn.inTitle && insOn.rightOfTitle && insOn.pressed === 'true', JSON.stringify(insOn));

  // ---- 6. off, from the inspector -----------------------------------------------------
  await H.clickById(page, 'siAtomLabelsButton');
  await page.waitForTimeout(400);
  await render();
  s = await state();
  ins = await inspector();
  const insOff = await insButton();
  // Back as it was: the inspector closed, the same view without labels.
  await page.evaluate(async () => {
    const { removeSelectionInspectorPanel } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    removeSelectionInspectorPanel();
  });
  H.check('the inspector\'s Aₓ turns them off everywhere: no labels in the view or the inspector, both switches released',
    s.on === false && s.sprites.length === 0 && s.button.pressed === 'false' && !s.button.active && ins.length === 0
      && insOff?.pressed === 'false',
    JSON.stringify({ on: s.on, n: s.sprites.length, button: s.button, ins, insOff }));

  // ---- 7. Wyckoff lock: the orbit's name on every member ------------------------------
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('symmetry'));
  await page.waitForTimeout(1500);
  await H.clickById(page, 'getWyckoffBtn');
  await page.waitForTimeout(2500);
  await H.clickById(page, 'atomLabelsButton');
  await page.waitForTimeout(400);
  await render();
  const wy = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { atomLabelSprites } = await import('./render/AtomLabelModule.js');
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    const st = fileBrowser.selectedStructure;
    // The Wyckoff tab's rows: one per orbit, named "Ba1  2t", representative atom.
    const rows = [...document.querySelectorAll('#wyckoffPanel .individual-atom-row')]
      .map((r) => [Number(r.dataset.atomIndex), r.querySelector('.iar-name')?.firstChild?.textContent?.replace(/\s+/g, ' ').trim()]);
    return {
      locked: st.symmetry?.mode === 'wyckoff',
      orbits: st.symmetry?.orbitGroups?.map((g) => g.atomIndices) ?? [],
      rows,
      sprites: atomLabelSprites().map((x) => [x.srcIndex, x.text]),
    };
  });
  const nameOf = new Map(wy.sprites);
  const rowName = new Map(wy.rows);
  H.check('Wyckoff lock: every member of an orbit carries the orbit\'s Wyckoff-tab name ("Ba1 2t")',
    wy.locked && wy.orbits.length > 1 && wy.rows.length === wy.orbits.length
      && wy.orbits.every((members) => {
        const rep = members.find((i) => rowName.has(i));
        return rep != null && members.every((i) => !nameOf.has(i) || nameOf.get(i) === rowName.get(rep));
      })
      && wy.sprites.every(([, t]) => /^[A-Z][a-z]?\d+ \d+[a-z?]$/.test(t)),
    JSON.stringify({ rows: wy.rows, sprites: wy.sprites.slice(0, 8) }));
  await H.shotCanvas(page, 'atomlabels-wyckoff');

  // Switching the lock off renames them at once (the atoms are not rebuilt,
  // and no frame is forced here), and on again likewise.
  const namesNow = () => page.evaluate(async () => {
    const { atomLabelSprites } = await import('./render/AtomLabelModule.js');
    return atomLabelSprites().map((x) => [x.srcIndex, x.text]);
  });
  await H.clickById(page, 'getWyckoffBtn'); // off
  await page.waitForTimeout(300);
  const unlocked = await namesNow();
  H.check('Wyckoff lock off: the labels go back to the Atoms tab\'s names at once',
    unlocked.length > 0 && unlocked.every(([src, t]) => t === expected.names[src]), JSON.stringify(unlocked.slice(0, 6)));
  await H.clickById(page, 'getWyckoffBtn'); // on again
  await page.waitForTimeout(2500);
  const relocked = await namesNow();
  H.check('… and on again: the orbit names are back at once',
    relocked.length > 0 && relocked.every(([, t]) => /^[A-Z][a-z]?\d+ \d+[a-z?]$/.test(t)), JSON.stringify(relocked.slice(0, 6)));

  // ---- 8. the names, pure --------------------------------------------------------------
  const pure = await page.evaluate(async () => {
    const { atomLabelTexts } = await import('./render/AtomLabelModule.js');
    const atom = (species, vac = 0) => ({
      species: species.map((e) => ({ element: e })),
      isDisordered: () => species.length > 1 || vac > 0,
      getVacancyFraction: () => vac,
    });
    return atomLabelTexts({
      elements: ['Fe', 'O', 'Fe', 'Fe', 'O', 'Fe'],
      atoms: [atom(['Fe']), atom(['O']), atom(['Fe', 'Ni']), atom(['Fe']), atom(['O']), atom(['Ni', 'Fe'])],
    });
  });
  H.check('atomLabelTexts: element + number per site composition; a mixed site "(Fe,Ni)n"',
    JSON.stringify(pure) === JSON.stringify(['Fe1', 'O1', '(Fe,Ni)1', 'Fe2', 'O2', '(Fe,Ni)2']), JSON.stringify(pure));

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
