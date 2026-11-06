// "Complete Rings & Fragments" (Features window): fragments and small rings that a cell
// face cuts are drawn whole — built into the periodic image set by
// render/LatticeModule.js periodicWrapped (WASM: periodic_wasm_src/src/
// fragments.rs, JS twin: render/FragmentCompletion.js). Graphite and h-BN are
// the reference cases: their hexagonal cell is narrower than a 6-ring, so every
// ring crosses a face and the wrapped set shows none of them closed.
'use strict';
const H = require('../harness');

// AB graphite, C–C 1.4226 Å.
const GRAPHITE = [
  'graphite', '1.0',
  ' 2.464000  0.000000  0.000000',
  '-1.232000  2.133887  0.000000',
  ' 0.000000  0.000000  6.711000',
  'C', '4', 'Direct',
  '0.000000 0.000000 0.250000',
  '0.000000 0.000000 0.750000',
  '0.333333 0.666667 0.250000',
  '0.666667 0.333333 0.750000',
  '',
].join('\n');

// h-BN as a CIF with the atoms listed (no space group, so no symmetry prompt).
// B–N 1.4457 Å.
const HBN_CIF = [
  'data_hBN',
  '_cell_length_a   2.504',
  '_cell_length_b   2.504',
  '_cell_length_c   6.656',
  '_cell_angle_alpha   90',
  '_cell_angle_beta    90',
  '_cell_angle_gamma   120',
  'loop_',
  '_atom_site_label',
  '_atom_site_type_symbol',
  '_atom_site_fract_x',
  '_atom_site_fract_y',
  '_atom_site_fract_z',
  'B1 B 0.333333 0.666667 0.25',
  'N1 N 0.666667 0.333333 0.25',
  'B2 B 0.666667 0.333333 0.75',
  'N2 N 0.333333 0.666667 0.75',
  '',
].join('\n');

// Benzene centred on the cell edge x = y = 0 of an 8 Å box: the wrapped ring is
// split over four corners.
function benzenePoscar() {
  const L = 8;
  const lines = ['benzene', '1.0', `${L} 0 0`, `0 ${L} 0`, `0 0 ${L}`, 'C H', '6 6', 'Direct'];
  const wrap = (v) => v - Math.floor(v);
  for (const r of [1.39, 2.48]) {
    for (let k = 0; k < 6; k++) {
      const t = Math.PI / 3 * k;
      lines.push(`${wrap(r * Math.cos(t) / L).toFixed(6)} ${wrap(r * Math.sin(t) / L).toFixed(6)} 0.500000`);
    }
  }
  return lines.join('\n') + '\n';
}

// A CO3 on the cell edge next to a Ca that bonds to its oxygens: with bonds to
// metals dropped (the default) the carbonate is a molecule; with them kept,
// Ca links every carbonate to its images and nothing is finite any more.
function carbonatePoscar() {
  const L = 4;
  const lines = ['carbonate', '1.0', `${L} 0 0`, `0 ${L} 0`, `0 0 ${L}`, 'Ca C O', '1 1 3', 'Direct'];
  const wrap = (v) => v - Math.floor(v);
  lines.push('0.500000 0.500000 0.500000');
  lines.push('0.000000 0.000000 0.500000');
  for (let k = 0; k < 3; k++) {
    const t = 2 * Math.PI / 3 * k;
    lines.push(`${wrap(1.28 * Math.cos(t) / L).toFixed(6)} ${wrap(1.28 * Math.sin(t) / L).toFixed(6)} 0.500000`);
  }
  return lines.join('\n') + '\n';
}

async function load(page, content, name) {
  await page.evaluate(async ({ content, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(content, name);
  }, { content, name });
  await page.waitForTimeout(1500);
}

// Drawn-set summary: count, and per drawn atom the number of drawn partners at
// the given bond length. `added` = atoms beyond the boundary set.
async function summary(page, bond) {
  return page.evaluate(async (bond) => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const w = s.periodic.wrapped;
    const cart = w.cart;
    const partners = cart.map((p) => cart.filter((q) =>
      Math.abs(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) - bond) < 0.02).length);
    return {
      atoms: s.atoms.length,
      drawn: cart.length,
      mesh: groups.atomsMesh?.count ?? -1,
      partners,
    };
  }, bond);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // ---- Graphite --------------------------------------------------------------
  await load(page, GRAPHITE, 'graphite.vasp');
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.bondLengths['C-C'] = { min: 0, max: 1.6 };
    general.bondVisibility['C-C'] = true;
    general.showPBCBonds = false;
    general.showPeriodic = true;
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
  });
  await page.waitForTimeout(500);
  const before = await summary(page, 1.4226);
  H.check('graphite: without the option, no ring is closed (some atoms lack partners)',
    before.partners.some((n) => n < 3), JSON.stringify({ drawn: before.drawn }));

  await H.clickById(page, 'completeFragmentsToggle');
  await page.waitForTimeout(800);
  const after = await summary(page, 1.4226);
  const flag = await page.evaluate(async () => (await import('./state/store.js')).general.completeFragments);
  // Each boundary atom (the first `before.drawn` atoms) has all 3 sheet partners;
  // each added atom sits on a closed ring (≥ 2 partners).
  const baseFull = after.partners.slice(0, before.drawn).every((n) => n === 3);
  const addedOnRings = after.partners.slice(before.drawn).every((n) => n >= 2);
  H.check('graphite: toggle on closes every ring through the boundary',
    flag && after.drawn > before.drawn && baseFull && addedOnRings && after.mesh === after.drawn,
    JSON.stringify({ before: before.drawn, after: after.drawn, mesh: after.mesh, baseFull, addedOnRings }));
  H.check('graphite: only a ring shell is added (sheet not grown wholesale)',
    after.drawn < 12 * before.drawn, `${before.drawn} -> ${after.drawn}`);
  await H.shotCanvas(page, 'completefragments-graphite');

  // Hiding the C–C pair in the Bonds tab removes the molecule bonds → nothing to
  // complete. Driven through the pair's own checkbox (BondLengthPanel), which must
  // re-render atoms now that the image set depends on it.
  const pairToggled = await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    const cb = /** @type {HTMLInputElement|null} */ (document.querySelector('[data-pair="C-C"] .bond-checkbox input'));
    if (!cb) return false;
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  await page.waitForTimeout(800);
  const hidden = await summary(page, 1.4226);
  H.check('graphite: hiding the C–C pair drops the completed rings (atom set recomputed)',
    pairToggled && hidden.drawn === before.drawn && hidden.mesh === hidden.drawn,
    JSON.stringify({ pairToggled, drawn: hidden.drawn, mesh: hidden.mesh }));
  await page.evaluate(async () => {
    const cb = /** @type {HTMLInputElement} */ (document.querySelector('[data-pair="C-C"] .bond-checkbox input'));
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(800);

  // Ring completion off (max ring 0) through the Bonds tab's setting, shown only
  // while the option is on: a sheet is an extended network, so nothing is added.
  const noRings = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    const select = /** @type {HTMLSelectElement|null} */ (document.querySelector('#infoBondControls #fragmentMaxRing'));
    const metal = document.querySelector('#infoBondControls #fragmentIgnoreMetalBonds');
    if (!select) return { found: false };
    const count = () => fileBrowser.selectedStructure.periodic.wrapped.cart.length;
    select.value = '0';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const n = count();
    select.value = '6';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, metal: !!metal, n, back: count() };
  });
  H.check('graphite: Bonds-tab ring size "off" adds nothing; 6 brings the rings back',
    noRings.found && noRings.metal && noRings.n === before.drawn && noRings.back === after.drawn,
    JSON.stringify(noRings));

  // JS and WASM paths agree on the image set (as (source, cell shift) keys), with
  // and without Neighbour Bonds on top.
  const parity = async () => page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { periodicWrapped } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const frac = s.atoms.map((a) => a.position);
    const keys = (w) => w.srcIndex.map((src, i) =>
      `${src}:${w.frac[i].map((v, k) => Math.round(v - frac[src][k])).join(',')}`).sort();
    const out = {};
    for (const pbc of [false, true]) {
      const opts = { ...general, completeFragments: true, showPBCBonds: pbc };
      const wasm = keys(periodicWrapped({ ...opts, useWasmPeriodic: true }, frac, [...s.elements], s.lattice));
      const js = keys(periodicWrapped({ ...opts, useWasmPeriodic: false }, frac, [...s.elements], s.lattice));
      out[pbc ? 'withNeighbourBonds' : 'plain'] = {
        same: wasm.length === js.length && wasm.every((k, i) => k === js[i]),
        unique: new Set(wasm).size === wasm.length,
        n: wasm.length,
      };
    }
    return out;
  });
  const graphiteParity = await parity();
  H.check('graphite: JS and WASM give the same image set, without duplicates',
    Object.values(graphiteParity).every((r) => r.same && r.unique), JSON.stringify(graphiteParity));

  // Toggle off restores the boundary set.
  await H.clickById(page, 'completeFragmentsToggle');
  await page.waitForTimeout(800);
  const off = await summary(page, 1.4226);
  const settingsGone = await page.evaluate(() => !document.querySelector('#infoBondControls #fragmentMaxRing'));
  H.check('graphite: toggle off restores the original atom set and hides the settings',
    off.drawn === before.drawn && off.mesh === off.drawn && settingsGone,
    JSON.stringify({ drawn: off.drawn, before: before.drawn, settingsGone }));

  // Turning it on while periodic images are off turns those on (the completed
  // atoms are periodic images).
  const turnsOnPeriodic = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const periodic = /** @type {HTMLInputElement} */ (document.getElementById('showPeriodic'));
    periodic.checked = false;
    periodic.dispatchEvent(new Event('change', { bubbles: true }));
    const before = general.showPeriodic;
    const cb = /** @type {HTMLInputElement} */ (document.getElementById('completeFragmentsToggle'));
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return { before, after: general.showPeriodic, box: periodic.checked };
  });
  H.check('enabling with periodic images off turns them on',
    !turnsOnPeriodic.before && turnsOnPeriodic.after && turnsOnPeriodic.box, JSON.stringify(turnsOnPeriodic));

  // ---- h-BN (CIF) --------------------------------------------------------------
  await load(page, HBN_CIF, 'hBN.cif');
  const hbn = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    general.bondLengths['B-N'] = { min: 0, max: 1.7 };
    general.bondLengths['B-B'] = { min: 0, max: 0 };
    general.bondLengths['N-N'] = { min: 0, max: 0 };
    general.completeFragments = false;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    const base = fileBrowser.selectedStructure.periodic.wrapped.cart.length;
    general.completeFragments = true;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    return { base, atoms: fileBrowser.selectedStructure.atoms.length };
  });
  await page.waitForTimeout(500);
  const hbnSum = await summary(page, 1.4457);
  H.check('h-BN CIF: every boundary atom gets its 3 partners; added atoms sit on rings',
    hbn.atoms === 4 && hbnSum.drawn > hbn.base
      && hbnSum.partners.slice(0, hbn.base).every((n) => n === 3)
      && hbnSum.partners.slice(hbn.base).every((n) => n >= 2),
    JSON.stringify({ ...hbn, drawn: hbnSum.drawn }));
  const hbnParity = await parity();
  H.check('h-BN: JS and WASM agree', Object.values(hbnParity).every((r) => r.same && r.unique),
    JSON.stringify(hbnParity));
  await H.shotCanvas(page, 'completefragments-hbn');

  // ---- Benzene (finite molecule) -----------------------------------------------
  await load(page, benzenePoscar(), 'benzene.vasp');
  const benz = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    general.bondLengths['C-C'] = { min: 0, max: 1.6 };
    general.bondLengths['C-H'] = { min: 0, max: 1.2 };
    general.bondLengths['H-H'] = { min: 0, max: 0 };
    general.completeFragments = true;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    const w = fileBrowser.selectedStructure.periodic.wrapped;
    const els = w.elements;
    const cart = w.cart;
    const near = (p, el, d) => cart.filter((q, k) => els[k] === el
      && Math.abs(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) - d) < 0.02).length;
    // Every drawn C has 2 C and 1 H; every drawn H has 1 C: whole molecules only.
    const okC = cart.every((p, k) => els[k] !== 'C' || (near(p, 'C', 1.39) === 2 && near(p, 'H', 1.09) === 1));
    const okH = cart.every((p, k) => els[k] !== 'H' || near(p, 'C', 1.09) === 1);
    return { drawn: cart.length, okC, okH };
  });
  H.check('benzene across a cell edge: every drawn copy is a whole C6H6',
    benz.okC && benz.okH && benz.drawn % 12 === 0 && benz.drawn > 12, JSON.stringify(benz));
  const benzParity = await parity();
  H.check('benzene: JS and WASM agree', Object.values(benzParity).every((r) => r.same && r.unique),
    JSON.stringify(benzParity));

  // ---- Carbonate next to Ca (metal filter) ----------------------------------------
  await load(page, carbonatePoscar(), 'carbonate.vasp');
  const carb = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    for (const p of ['C-Ca', 'C-C', 'Ca-Ca', 'O-O']) general.bondLengths[p] = { min: 0, max: 0 };
    general.bondLengths['C-O'] = { min: 0, max: 1.5 };
    general.bondLengths['Ca-O'] = { min: 0, max: 2.7 };
    general.completeFragments = true;
    const coAround = () => {
      const w = fileBrowser.selectedStructure.periodic.wrapped;
      const c = w.cart[w.elements.indexOf('C')];
      return {
        n: w.cart.length,
        o: w.cart.filter((q, k) => w.elements[k] === 'O'
          && Math.abs(Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2]) - 1.28) < 0.02).length,
      };
    };
    general.fragmentIgnoreMetalBonds = true;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    const dropped = coAround();
    general.fragmentIgnoreMetalBonds = false;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    const kept = coAround();
    general.fragmentIgnoreMetalBonds = true;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    return { dropped, kept };
  });
  H.check('carbonate: with bonds to metals dropped (default) the CO3 is completed',
    carb.dropped.o === 3, JSON.stringify(carb));
  H.check('carbonate: keeping Ca–O bonds makes it part of a network (setting matters)',
    carb.kept.n !== carb.dropped.n, JSON.stringify(carb));

  // ---- Share link round trip ---------------------------------------------------
  const shared = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    general.fragmentMaxRing = 5;
    const state = captureState();
    general.completeFragments = false;
    general.fragmentMaxRing = 6;
    await applySharedState(state, 'carbonate.vasp');
    return {
      on: general.completeFragments,
      ring: general.fragmentMaxRing,
      box: /** @type {HTMLInputElement} */ (document.getElementById('completeFragmentsToggle')).checked,
    };
  });
  H.check('share link restores Complete Rings & Fragments and its ring size',
    shared.on && shared.ring === 5 && shared.box, JSON.stringify(shared));

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
