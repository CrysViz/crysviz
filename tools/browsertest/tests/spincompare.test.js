// Comparison spins (experimental): the Spins panel's "Comparison Spins"
// section loads a second spin set (one "x y z [scale]" line per atom) into
// structure.spins2, drawn by render/SpinModule.js into its own mesh pair.
//  - absent without ?experimental
//  - length controls (global scaling) are shared by both sets
//  - arrow diameter and colormap are per set
//  - the spin reference frame / visual rotation apply to both sets
//  - a file with the wrong number of vectors is rejected
'use strict';
const H = require('../harness');

const URL = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

// 2-atom cell: primary spins come from extXYZ's 10-column layout
// (species, pos, forces, spin).
const XYZ = [
  '2', 'Lattice="4 0 0 0 4 0 0 0 4"',
  'Fe 0 0 0 0 0 0 0 0 2',
  'Fe 2 2 2 0 0 0 0 0 -2',
].join('\n');

const openSpins = (page) => page.evaluate(async (xyz) => {
  const cv = await import('./core/crystal-viewer.js');
  const { openPanel } = await import('./ui/panels/PanelManager.js');
  const { isExperimentalMode } = await import('./debug/experimentalMode.js');
  const r = await cv.loadStructure(xyz, 'fe.xyz');
  openPanel('spins');
  await new Promise((res) => setTimeout(res, 500));
  return {
    ok: r?.ok,
    experimental: isExperimentalMode(),
    section: !!document.getElementById('spinComparisonSection'),
  };
}, XYZ);

// Feed text through the section's real file input (DataTransfer → change).
const loadFile = (page, text, name) => page.evaluate(async ({ text, name }) => {
  const input = /** @type {HTMLInputElement} */ (document.getElementById('spin2FileInput'));
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: 'text/plain' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await new Promise((res) => setTimeout(res, 300));
  return document.getElementById('spin2Status')?.textContent ?? '';
}, { text, name });

// Shaft instance 0's world-space length along its axis, and its diameter.
const meshInfo = (page) => page.evaluate(async () => {
  const THREE = await import('./external/three/three.module.js');
  const { groups, fileBrowser } = await import('./state/store.js');
  const read = (mesh) => {
    if (!mesh) return null;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return { count: mesh.count, halfLen: s.y, diameter: s.x };
  };
  const s = fileBrowser.selectedStructure;
  return {
    primary: read(groups.spinShaftMesh),
    compare: read(groups.spin2ShaftMesh),
    spins2: s.spins2?.map((sp) => sp.vector) ?? null,
  };
});

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const plain = await openSpins(page);
  H.check('plain URL: structure loads, flag off', plain.ok === true && plain.experimental === false, JSON.stringify(plain));
  H.check('plain URL: no Comparison Spins section', plain.section === false, JSON.stringify(plain));

  await page.goto(`${URL}?experimental`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  const exp = await openSpins(page);
  H.check('?experimental: Comparison Spins section present', exp.ok === true && exp.section === true, JSON.stringify(exp));

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { updateSpins } = await import('./render/index.js');
    general.spinsActive = true;
    general.spinScale = 1.0;
    updateSpins(1.0);
  });

  const bad = await loadFile(page, '1 0 0\n', 'bad.txt');
  const afterBad = await meshInfo(page);
  H.check('wrong vector count is rejected', /Could not load/.test(bad) && !afterBad.spins2?.length && !afterBad.compare, bad);

  // Comment + blank line skipped; second vector has an explicit scale.
  const good = await loadFile(page, '# comparison\n1 0 0\n\n0 0 -1 2.0\n', 'cmp.txt');
  const loaded = await meshInfo(page);
  H.check('valid file loads 2 vectors', /Loaded 2 vectors/.test(good) && loaded.spins2?.length === 2, good);
  H.check('both sets drawn', loaded.primary?.count === 4 && loaded.compare?.count === 4, JSON.stringify(loaded));

  // Global length: doubling spinScale doubles both sets' arrows.
  const scaled = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { updateSpins } = await import('./render/index.js');
    general.spinScale = 2.0;
    updateSpins(2.0);
  }).then(() => meshInfo(page));
  H.check('global length scales the primary set',
    Math.abs(scaled.primary.halfLen / loaded.primary.halfLen - 2) < 1e-6, JSON.stringify([loaded.primary, scaled.primary]));
  H.check('global length scales the comparison set',
    Math.abs(scaled.compare.halfLen / loaded.compare.halfLen - 2) < 1e-6, JSON.stringify([loaded.compare, scaled.compare]));

  // Per-set diameter: the section's own slider moves only the comparison set.
  const sized = await page.evaluate(async () => {
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('spin2SizeSlider'));
    slider.value = '0.12';
    slider.dispatchEvent(new Event('input'));
  }).then(() => meshInfo(page));
  H.check('comparison diameter follows its own slider',
    Math.abs(sized.compare.diameter - 0.12) < 1e-6, JSON.stringify(sized.compare));
  H.check('primary diameter unchanged',
    Math.abs(sized.primary.diameter - scaled.primary.diameter) < 1e-6, JSON.stringify(sized.primary));

  // Per-set colormap: 'direction' on the comparison set only.
  const colors = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('spin2ColorMapSelect'));
    const primarySel = /** @type {HTMLSelectElement} */ (document.querySelector('#spinControlsGroup .cv-spin-colormap-select'));
    const sameOptions = JSON.stringify([...sel.options].map((o) => o.value)) === JSON.stringify([...primarySel.options].map((o) => o.value));
    sel.value = 'direction';
    sel.dispatchEvent(new Event('change'));
    const c2 = groups.spin2ShaftMesh.instanceColor;
    const c1 = groups.spinShaftMesh.instanceColor;
    return {
      sameOptions,
      compare0: [c2.getX(0), c2.getY(0), c2.getZ(0)],
      primary0: [c1.getX(0), c1.getY(0), c1.getZ(0)],
      primaryMap: primarySel.value,
    };
  });
  H.check('comparison offers the same colormaps', colors.sameOptions, '');
  H.check('comparison "direction" map colours its x-vector red',
    Math.abs(colors.compare0[0] - 1) < 1e-6 && colors.compare0[1] < 1e-6 && colors.compare0[2] < 1e-6, JSON.stringify(colors));
  H.check('primary colours untouched by the comparison map',
    colors.primaryMap === 'none' && JSON.stringify(colors.primary0) !== JSON.stringify(colors.compare0), JSON.stringify(colors));

  // Reference frame / visual rotation apply to the comparison set too:
  // 90° about z turns [1,0,0] into [0,1,0].
  const rotated = await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { applySpinFrame } = await import('./utils/index.js');
    const s = fileBrowser.selectedStructure;
    applySpinFrame(s, { mode: 'cartesian', visualRot: [0, 0, 90] });
    const v = s.spins2[0].vector;
    applySpinFrame(s, { mode: general.spinFrameMode ?? 'file', visualRot: [0, 0, 0] });
    return v;
  });
  H.check('visual rotation applies to comparison spins',
    Math.abs(rotated[0]) < 1e-6 && Math.abs(rotated[1] - 1) < 1e-6, JSON.stringify(rotated));

  // Highlight toggles: each lights up every arrow of its own set only, and
  // the glow survives a redraw (e.g. a length change).
  const glow = await page.evaluate(async () => {
    const { groups, general } = await import('./state/store.js');
    const { updateSpins } = await import('./render/index.js');
    const lit = (mesh) => {
      const a = mesh.geometry.attributes.instanceEmissiveIntensity;
      let n = 0;
      for (let i = 0; i < a.count; i++) if (a.getX(i) > 0) n++;
      return { lit: n, total: a.count };
    };
    document.getElementById('spin2HighlightAllBtn').click();
    updateSpins(general.spinScale ?? 1.0);
    const compareOn = { compare: lit(groups.spin2ShaftMesh), primary: lit(groups.spinShaftMesh),
      pressed: document.getElementById('spin2HighlightAllBtn').classList.contains('is-active') };
    document.getElementById('spin2HighlightAllBtn').click();
    document.getElementById('spinHighlightAllBtn').click();
    const primaryOn = { compare: lit(groups.spin2ShaftMesh), primary: lit(groups.spinShaftMesh) };
    document.getElementById('spinHighlightAllBtn').click();
    const off = { compare: lit(groups.spin2ShaftMesh), primary: lit(groups.spinShaftMesh) };
    return { compareOn, primaryOn, off };
  });
  H.check('comparison Highlight lights every comparison arrow and no primary one',
    glow.compareOn.pressed && glow.compareOn.compare.lit === glow.compareOn.compare.total && glow.compareOn.primary.lit === 0,
    JSON.stringify(glow));
  H.check('structure Highlight lights every primary arrow and no comparison one',
    glow.primaryOn.primary.lit === glow.primaryOn.primary.total && glow.primaryOn.compare.lit === 0, JSON.stringify(glow));
  H.check('toggling off clears the glow', glow.off.primary.lit === 0 && glow.off.compare.lit === 0, JSON.stringify(glow));

  // Drag-and-drop onto the section's drop zone loads the file too — and only
  // into spins2: the drop must not also reach the body-level handler that
  // opens dropped files as new structures.
  const dropped = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const before = fileBrowser.selectedStructure;
    const zone = document.getElementById('spin2DropZone');
    const dt = new DataTransfer();
    dt.items.add(new File(['0 1 0\n0 1 0\n'], 'dropped.txt', { type: 'text/plain' }));
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const highlighted = zone.classList.contains('highlight');
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 500));
    const s = fileBrowser.selectedStructure;
    return {
      highlighted,
      sameStructure: s === before,
      status: document.getElementById('spin2Status')?.textContent ?? '',
      v0: s.spins2?.[0]?.rawVector ?? null,
    };
  });
  H.check('drop zone highlights on dragover', dropped.highlighted, JSON.stringify(dropped));
  H.check('dropping a file loads it as comparison spins',
    /Loaded 2 vectors from dropped\.txt/.test(dropped.status) && JSON.stringify(dropped.v0) === '[0,1,0]', JSON.stringify(dropped));
  H.check('drop does not open a new structure', dropped.sameStructure, JSON.stringify(dropped));

  // Show toggle and Clear remove only the comparison meshes.
  const hidden = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const cb = /** @type {HTMLInputElement} */ (document.getElementById('spin2ShowCheckbox'));
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    const hiddenState = { compare: !!groups.spin2ShaftMesh, primary: !!groups.spinShaftMesh };
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    document.getElementById('spin2ClearBtn').click();
    return { hiddenState, cleared: { compare: !!groups.spin2ShaftMesh, primary: !!groups.spinShaftMesh } };
  });
  H.check('Show off hides only the comparison set', !hidden.hiddenState.compare && hidden.hiddenState.primary, JSON.stringify(hidden));
  H.check('Clear removes only the comparison set', !hidden.cleared.compare && hidden.cleared.primary, JSON.stringify(hidden));

  const real = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED/.test(e));
  H.check('no page errors', real.length === 0, real[0] || '');
  await H.finish(browser);
})().catch(H.crash);
