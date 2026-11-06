// CIF errors: a CIF's standard uncertainties (the digits in parentheses) can be
// read at load (a tick box in the symmetry dialog, or a dialog of its own for a
// CIF without symmetry), and then measured lengths and angles — measurement
// labels and the Selection Inspector — are written with their s.u., 1.234(5) Å.
// "Show CIF Errors" in the Features window hides them again. An atom moved
// away from where the CIF put it loses its error. See model/cifErrors.js.
'use strict';
const H = require('../harness');

// P-1 in a 5 Å cubic cell. C1 sits 0.1234 from the inversion centre at
// (½,½,½), so C1 and its inversion image are 1.234 Å apart; H1 is bonded to C1.
// Only a, b, c and three coordinates (C1 x, H1 x and y) carry an s.u.
const atomsLoop = [
  'loop_',
  '_atom_site_label',
  '_atom_site_type_symbol',
  '_atom_site_fract_x',
  '_atom_site_fract_y',
  '_atom_site_fract_z',
  'C1 C 0.6234(5) 0.5 0.5',
  'H1 H 0.80(1) 0.65(1) 0.5',
];
const cell = [
  '_cell_length_a   5.000(2)',
  '_cell_length_b   5.000(2)',
  '_cell_length_c   5.000(2)',
  '_cell_angle_alpha   90',
  '_cell_angle_beta    90',
  '_cell_angle_gamma   90',
];
const PM1_CIF = [
  'data_pm1',
  "_symmetry_space_group_name_H-M   'P -1'",
  '_space_group_IT_number   2',
  ...cell,
  'loop_',
  '_space_group_symop_operation_xyz',
  '  x,y,z',
  '  -x,-y,-z',
  ...atomsLoop,
  '',
].join('\n');
// The same atoms, all four written out, with no symmetry at all (P1): no
// symmetry dialog, so the errors get a dialog of their own.
const P1_CIF = [
  'data_p1',
  ...cell,
  ...atomsLoop,
  'C2 C 0.3766(5) 0.5 0.5',
  'H2 H 0.20(1) 0.35(1) 0.5',
  '',
].join('\n');

// α-quartz, P3₂21: SiO4 tetrahedra with s.u.s on the cell and coordinates
// (Si–O 1.6047(17) and 1.6135(12) Å).
const QUARTZ_CIF = [
  'data_quartz',
  "_symmetry_space_group_name_H-M   'P 32 2 1'",
  '_space_group_IT_number   154',
  '_cell_length_a   4.9160(1)',
  '_cell_length_b   4.9160(1)',
  '_cell_length_c   5.4054(1)',
  '_cell_angle_alpha   90',
  '_cell_angle_beta    90',
  '_cell_angle_gamma   120',
  'loop_',
  '_space_group_symop_operation_xyz',
  '  x,y,z', '  -y,x-y,z+2/3', '  -x+y,-x,z+1/3', '  y,x,-z', '  x-y,-y,-z+1/3', '  -x,-x+y,-z+2/3',
  'loop_',
  '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Si1 Si 0.4697(1) 0 0.66667',
  'O1 O 0.4135(3) 0.2669(3) 0.7858(2)',
  '',
].join('\n');

// A magnetic CIF (C-centred P-1 with two Cr moments) whose cell and
// coordinates carry s.u.s.
const MCIF = `#\\#CIF_2.0
data_test
_space_group_magn.number_BNS  2.4
_space_group_magn.name_BNS  "P -1"
_cell_length_a             5.5680(3)
_cell_length_b             8.2080(4)
_cell_length_c             5.9770(3)
_cell_angle_alpha          90.00
_cell_angle_beta           90.00
_cell_angle_gamma          90.00

loop_
_space_group_symop_magn_operation.id
_space_group_symop_magn_operation.xyz
1 x,y,z,+1
2 -x,-y,-z,+1

loop_
_space_group_symop_magn_centering.id
_space_group_symop_magn_centering.xyz
1 x,y,z,+1
2 x+1/2,y+1/2,z,+1

loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Cr1_1 Cr 0.00000 0.00000 0.00000
Cr1_2 Cr  0.00000 0.00000 0.50000
V1 V 0.00000 0.3550(4) 0.25000
O1_1 O 0.00000 0.2410(9) 0.0260(8)
O1_2 O  0.00000 0.7590(9) 0.5260(8)
O2_1 O 0.2510(8) 0.4750(6) 0.25000
O2_2 O  0.7490(8) 0.4750(6) 0.25000

loop_
_atom_site_moment.label
_atom_site_moment.crystalaxis_x
_atom_site_moment.crystalaxis_y
_atom_site_moment.crystalaxis_z
_atom_site_moment.symmform
_atom_site_moment.magnitude
Cr1_1 1.87 0.92 0.33 mx,my,mz       2.1(2)
Cr1_2 -1.87 -0.92 -0.33 mx,my,mz    2.1
`;

// I2N3 at pressure, P-3m1 (trimmed from a SHELXL CIF): a hexagonal cell,
// whose a = b must move together, and N1 on a special position (x, 2x, z),
// whose x and y are one parameter. SHELXL's own (full covariance) values:
// I001–I001–I001 119.874(8)°, N1–N1 1.09(2) Å. Treating a, b and N1's x, y
// as independent gives (13) for the angle.
const I2N3_CIF = [
  'data_i2n3',
  "_space_group_name_H-M_alt 'P -3 m 1'",
  '_space_group_IT_number 164',
  'loop_', '_space_group_symop_operation_xyz',
  "'x, y, z'", "'-y, x-y, z'", "'-x+y, -x, z'", "'y, x, -z'", "'x-y, -y, -z'", "'-x, -x+y, -z'",
  "'-x, -y, -z'", "'y, -x+y, -z'", "'x-y, x, -z'", "'-y, -x, z'", "'-x+y, y, z'", "'x, x-y, z'",
  '_cell_length_a 4.7666(7)', '_cell_length_b 4.7666(7)', '_cell_length_c 5.4639(9)',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 120',
  'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  '_atom_site_site_symmetry_order',
  'I001 I 0.666667 0.333333 0.4910(3) 6',
  'I002 I 1.000000 0.000000 0.25519(19) 6',
  'N1 N 1.4937(13) -0.013(3) 0.099(2) 2',
  '',
].join('\n');

// The s.u. written the crystallographic way (model/cifErrors.js formatWithSu).
function withSu(value, su) {
  const e = Math.floor(Math.log10(su));
  let dec = 1 - e;
  let n = Math.round(su * 10 ** dec);
  if (n > 19) { dec = -e; n = Math.round(su * 10 ** dec); }
  return `${value.toFixed(dec)}(${n})`;
}
// C1 to its inversion image: d = 2(x − ½)a, so σ² = (2aσx)² + (2(x − ½)σa)².
const CC = 2 * (0.6234 - 0.5) * 5;
const CC_SU = Math.hypot(2 * 5 * 0.0005, 2 * (0.6234 - 0.5) * 0.002);
const CC_LABEL = `${withSu(CC, CC_SU)} Å`;

async function beginLoad(page, text, name) {
  await page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    window.__cifLoad = cv.loadStructure(text, name);
  }, { text, name });
}

async function waitShown(page, id) {
  await page.waitForFunction((sel) => {
    const m = document.getElementById(sel);
    return !!m && !m.hidden;
  }, id, { timeout: 30000, polling: 250 });
}

async function finishLoad(page) {
  await page.evaluate(async () => { await window.__cifLoad; });
  await page.waitForTimeout(800);
}

/** Measure C1 to its inversion image (and the angle H1–C1–C1'), the way a
 *  click does; return the two label texts. */
async function measure(page) {
  return page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { fileBrowser, measurements } = await import('./state/store.js');
    const { addDistanceMeasurement, addAngleMeasurement, clearAllMeasurements } = await import('./render/MeasurementModule.js');
    clearAllMeasurements();
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const find = (x, y) => {
      for (let i = 0; i < w.cart.length; i++) {
        const f = w.frac[i];
        if (Math.abs(f[0] - x) < 1e-3 && Math.abs(f[1] - y) < 1e-3 && Math.abs(f[2] - 0.5) < 1e-3) {
          return {
            position: new THREE.Vector3(...w.cart[i]),
            userData: { atomIndex: w.srcIndex ? w.srcIndex[i] : i, element: w.elements[i], wrappedFrac: [...f] },
          };
        }
      }
      return null;
    };
    const c1 = find(0.6234, 0.5), c2 = find(0.3766, 0.5), h1 = find(0.8, 0.65);
    if (!c1 || !c2 || !h1) return { error: 'atoms not found' };
    addDistanceMeasurement(c1, c2);
    addAngleMeasurement(h1, c1, c2);
    return { labels: measurements.measureLabels.map((l) => l.userData.labelText) };
  });
}

async function labelTexts(page) {
  return page.evaluate(async () => {
    const { measurements } = await import('./state/store.js');
    const { updateAllMeasurements } = await import('./render/MeasurementModule.js');
    updateAllMeasurements();
    return measurements.measureLabels.map((l) => l.userData.labelText);
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // --- 1. A CIF with symmetry: the tick box in the symmetry dialog -------------
  await beginLoad(page, PM1_CIF, 'pm1.cif');
  await waitShown(page, 'cifSymmetryModal');
  const row = await page.evaluate(() => {
    const r = document.getElementById('cifSymmetryModalErrorsRow');
    const box = /** @type {HTMLInputElement} */ (document.getElementById('cifSymmetryModalErrors'));
    return {
      shown: !!r && !r.hidden && getComputedStyle(r).display !== 'none',
      checked: box?.checked,
      note: document.getElementById('cifSymmetryModalErrorsNote')?.textContent ?? '',
    };
  });
  H.check('the symmetry dialog offers to read the errors, ticked by default', row.shown && row.checked === true, JSON.stringify(row));
  H.check('it says what the file gives errors for', /the cell \(a, b, c\)/.test(row.note) && /3 of 6 atomic coordinates/.test(row.note), row.note);

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')]
      .find((b) => /Load as a normal structure/.test(b.textContent || ''));
    btn.click();
  });
  await finishLoad(page);
  const state1 = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return { atoms: s.atoms.length, read: !!s.cifErrors && !s.cifErrors.pending, sites: s.atoms.filter((a) => a.cifSite).length };
  });
  H.check('ticked: the errors are read, every atom knows its site', state1.read && state1.atoms === 4 && state1.sites === 4, JSON.stringify(state1));

  const m1 = await measure(page);
  H.check('the distance label carries its s.u., correlated through the shared site', m1.labels?.[0] === CC_LABEL,
    `${JSON.stringify(m1)} expected ${CC_LABEL}`);
  // An s.u. of 2.5° leaves no decimal worth writing: 140(2)°.
  H.check('the angle label carries its s.u., to its last significant digit', m1.labels?.[1] === '140(2)°', JSON.stringify(m1.labels));

  // --- 2. Show CIF Errors (Features) hides and shows them -----------------------
  const toggle = await page.evaluate(() => {
    const box = /** @type {HTMLInputElement} */ (document.getElementById('showCifErrorsToggle'));
    return box ? { checked: box.checked, label: box.closest('label')?.textContent?.trim() } : null;
  });
  H.check('Features has a Show CIF Errors switch, on', toggle?.checked === true && /Show CIF Errors/.test(toggle.label ?? ''), JSON.stringify(toggle));
  await page.evaluate(() => document.getElementById('showCifErrorsToggle').click());
  await page.waitForTimeout(200);
  const off = await labelTexts(page);
  H.check('off: the labels are plain values', off[0] === `${CC.toFixed(3)} Å` && /^\d+\.\d°$/.test(off[1]), JSON.stringify(off));
  await page.evaluate(() => document.getElementById('showCifErrorsToggle').click());
  await page.waitForTimeout(200);
  const on = await labelTexts(page);
  H.check('on again: the errors are back', on[0] === CC_LABEL, JSON.stringify(on));

  // --- 3. The Selection Inspector writes them too -------------------------------
  const insp = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    const { openSelectionInspector, getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const at = (x, y) => w.frac.findIndex((f) => Math.abs(f[0] - x) < 1e-3 && Math.abs(f[1] - y) < 1e-3 && Math.abs(f[2] - 0.5) < 1e-3);
    selectAtomsByInstances([at(0.6234, 0.5), at(0.3766, 0.5), at(0.8, 0.65)]);
    openSelectionInspector();
    await new Promise((r) => setTimeout(r, 1200));
    const s = getSelectionInspectorState();
    return { bonds: s.bonds, lengths: s.errors.lengths, angles: s.errors.angles, summary: s.errors.summary,
      labels: s.labels.map((l) => l.text) };
  });
  H.check('the inspector gives each bond and angle an s.u.',
    insp.bonds >= 1 && insp.lengths.length === insp.bonds && insp.lengths.every((v) => v > 0) && insp.angles.every((v) => v > 0),
    JSON.stringify({ bonds: insp.bonds, lengths: insp.lengths, angles: insp.angles }));
  H.check('the C–C bond has the same s.u. as the measurement', insp.lengths.some((v) => Math.abs(v - CC_SU) < 1e-6),
    JSON.stringify(insp.lengths));
  H.check('its summary says where they come from', /from the CIF/.test(insp.summary), insp.summary);
  H.check('its 3D view labels read like the measurement', insp.labels.includes(CC_LABEL) && insp.labels.some((t) => /^\d+\(\d+\)°$/.test(t)),
    JSON.stringify(insp.labels));
  await H.shotCanvas(page, 'ciferrors-inspector');
  await page.evaluate(() => document.getElementById('showCifErrorsToggle').click());
  await page.waitForTimeout(300);
  const inspOff = await page.evaluate(async () => (await import('./ui/AnalysisPanels/SelectionInspector.js')).getSelectionInspectorState().errors);
  H.check('Show CIF Errors off empties the inspector\'s errors too', inspOff.lengths.every((v) => v == null) && !/from the CIF/.test(inspOff.summary),
    JSON.stringify(inspOff));
  await page.evaluate(() => document.getElementById('showCifErrorsToggle').click());

  // --- 4. A moved atom has no error any more ------------------------------------
  const moved = await page.evaluate(async () => {
    const { fileBrowser, measurements } = await import('./state/store.js');
    const { updateAllMeasurements } = await import('./render/MeasurementModule.js');
    const s = fileBrowser.selectedStructure;
    const i = s.atoms.findIndex((a) => Math.abs(a.position[0] - 0.6234) < 1e-3);
    const before = [...s.atoms[i].position];
    s.atoms[i].position = [before[0] + 0.0001, before[1], before[2]]; // within its 0.0005 s.u.
    updateAllMeasurements();
    const small = measurements.measureLabels.map((l) => l.userData.labelText);
    s.atoms[i].position = [before[0] + 0.01, before[1], before[2]];
    updateAllMeasurements();
    const big = measurements.measureLabels.map((l) => l.userData.labelText);
    s.atoms[i].position = before;
    updateAllMeasurements();
    return { small, big };
  });
  H.check('a nudge within the s.u. keeps the error', /\(\d+\) Å$/.test(moved.small[0]), JSON.stringify(moved.small));
  H.check('a real move drops it: plain values', /^\d+\.\d{3} Å$/.test(moved.big[0]) && /^\d+\.\d°$/.test(moved.big[1]), JSON.stringify(moved.big));

  // --- 4b. Saved with the session: share link and .crysviz file -----------------
  const sessions = await page.evaluate(async () => {
    const { captureState, applySharedState, loadCrysvizFile, waitForStateRestoration } = await import('./ui/ShareModule.js');
    const { fileBrowser, measurements } = await import('./state/store.js');
    const read = () => {
      const s = fileBrowser.selectedStructure;
      return {
        read: !!s.cifErrors && !s.cifErrors.pending, sites: s.atoms.filter((a) => a.cifSite).length,
        // The restored measurements are the last two (the scene still has
        // the ones measured before).
        labels: measurements.measureLabels.slice(-2).map((l) => l.userData.labelText),
      };
    };
    const link = JSON.parse(JSON.stringify(captureState()));
    applySharedState(link, 'link.vasp');
    await waitForStateRestoration();
    const fromLink = { saved: !!link.cifErrors, ...read() };
    const file = { ...JSON.parse(JSON.stringify(captureState({ includeFrames: true }))), format: 'crysviz' };
    await loadCrysvizFile(JSON.stringify(file), 'session.crysviz');
    await waitForStateRestoration();
    return { fromLink, fromFile: { saved: !!file.cifErrors, ...read() } };
  });
  H.check('a share link keeps the errors, and the restored measurement shows them',
    sessions.fromLink.saved && sessions.fromLink.read && sessions.fromLink.sites === 4 && sessions.fromLink.labels[0] === CC_LABEL,
    JSON.stringify(sessions.fromLink));
  H.check('so does a .crysviz file', sessions.fromFile.saved && sessions.fromFile.read && sessions.fromFile.sites === 4
    && sessions.fromFile.labels[0] === CC_LABEL, JSON.stringify(sessions.fromFile));

  // --- 4c. A supercell keeps them, and so does its share link -------------------
  const supercell = await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { captureState, applySharedState, waitForStateRestoration } = await import('./ui/ShareModule.js');
    const { fileBrowser } = await import('./state/store.js');
    const ce = await import('./model/cifErrors.js');
    const pair = (x1, x2) => {
      const s = fileBrowser.selectedStructure;
      const find = (x) => s.atoms.findIndex((a) => Math.abs(a.position[0] - x) < 1e-6 && Math.abs(a.position[1] - 0.5) < 1e-6);
      const i = find(x1), j = find(x2);
      if (i < 0 || j < 0) return null;
      return ce.distanceSu(s, { atomIndex: i, frac: s.atoms[i].position }, { atomIndex: j, frac: s.atoms[j].position });
    };
    createSupercell(2, 1, 1);
    const s = fileBrowser.selectedStructure;
    const out = {
      atoms: s.atoms.length, cell: ce.cellMatchesCif(s),
      first: pair(0.6234 / 2, 0.3766 / 2), second: pair(1.6234 / 2, 1.3766 / 2),
    };
    createSupercell(1, 1, 1);
    out.back = pair(0.6234, 0.3766);
    createSupercell(2, 1, 1);
    applySharedState(JSON.parse(JSON.stringify(captureState())), 'supercell.vasp');
    await waitForStateRestoration();
    out.restored = pair(0.6234 / 2, 0.3766 / 2);
    return out;
  });
  const sameSu = (v) => v != null && Math.abs(v - CC_SU) < 1e-6;
  H.check('a 2×1×1 supercell keeps the errors in both copies, back to 1×1×1, and through a share link',
    supercell.atoms === 8 && supercell.cell && sameSu(supercell.first) && sameSu(supercell.second)
      && sameSu(supercell.restored) && sameSu(supercell.back), JSON.stringify(supercell));

  // --- 5. A CIF without symmetry: a dialog of its own, remembering the answer ---
  await beginLoad(page, P1_CIF, 'p1.cif');
  await waitShown(page, 'confirmModal');
  const dlg = await page.evaluate(() => ({
    title: document.getElementById('confirmModalTitle')?.textContent ?? '',
    buttons: [...document.querySelectorAll('#confirmModal .confirm-choice-label')].map((b) => b.textContent),
  }));
  H.check('a P1 CIF asks about the errors in a dialog of its own', /Read errors from the CIF/.test(dlg.title)
    && dlg.buttons.includes('Read the errors') && dlg.buttons.includes('Load without errors'), JSON.stringify(dlg));
  // Escape takes the remembered answer (yes, from the tick box above).
  await page.keyboard.press('Escape');
  await finishLoad(page);
  const p1Read = await page.evaluate(async () => {
    const s = (await import('./state/store.js')).fileBrowser.selectedStructure;
    return { read: !!s.cifErrors && !s.cifErrors.pending, atoms: s.atoms.length };
  });
  H.check('Escape keeps the remembered answer: read', p1Read.read && p1Read.atoms === 4, JSON.stringify(p1Read));
  const m2 = await measure(page);
  H.check('the same distance has the same error without symmetry', m2.labels?.[0] === withSu(CC, Math.hypot(Math.SQRT2 * 5 * 0.0005, 2 * (0.6234 - 0.5) * 0.002)) + ' Å',
    JSON.stringify(m2.labels));

  // --- 5b. Compare: both structures' values carry their own errors -------------
  await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('#objectTable tbody tr')];
    const name = (r) => r.querySelector('.name-inner')?.textContent;
    const fb = await import('./ui/FileBrowswerPanel.js');
    const { general } = await import('./state/store.js');
    fb.selectStructure(rows.findIndex((r) => name(r) === 'p1.cif'), 0);
    await new Promise((r) => setTimeout(r, 800));
    general.compareModeOn = false;
    for (const r of rows) {
      const box = r.querySelector('input[type="checkbox"]');
      const want = name(r) === 'pm1.cif';
      if (box && box.checked !== want) { box.checked = want; box.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  });
  await page.waitForTimeout(1200);
  const compared = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    const si = await import('./ui/AnalysisPanels/SelectionInspector.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const at = (x, y) => w.frac.findIndex((f) => Math.abs(f[0] - x) < 1e-3 && Math.abs(f[1] - y) < 1e-3 && Math.abs(f[2] - 0.5) < 1e-3);
    selectAtomsByInstances([at(0.6234, 0.5), at(0.3766, 0.5), at(0.8, 0.65)]);
    si.openSelectionInspector();
    await new Promise((r) => setTimeout(r, 800));
    if (!si.getSelectionInspectorState().compareButton.pressed) document.getElementById('siCompareBtn').click();
    await new Promise((r) => setTimeout(r, 1000));
    const s = si.getSelectionInspectorState();
    return { compare: s.compare && { ok: s.compare.ok, lengths: s.compare.lengths, lengthSus: s.compare.lengthSus }, labels: s.labels.map((l) => l.text) };
  });
  const P1_SU = Math.hypot(Math.SQRT2 * 5 * 0.0005, 2 * (0.6234 - 0.5) * 0.002);
  const ccPair = compared.compare?.lengthSus?.find((p) => p[0] != null && Math.abs(p[0] - P1_SU) < 1e-6);
  H.check('Compare: each structure\'s value carries its own error (independent sites here, one shared site there)',
    compared.compare?.ok && !!ccPair && Math.abs(ccPair[1] - CC_SU) < 1e-6
      && compared.labels.includes(`${withSu(CC, P1_SU)}  ${withSu(CC, CC_SU)} Å`), JSON.stringify(compared));
  await page.evaluate(async () => {
    if ((await import('./ui/AnalysisPanels/SelectionInspector.js')).getSelectionInspectorState()?.compareButton.pressed) {
      document.getElementById('siCompareBtn').click();
    }
    for (const box of document.querySelectorAll('#objectTable tbody tr input[type="checkbox"]')) {
      if (box.checked) { box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  });

  await beginLoad(page, P1_CIF, 'p1-again.cif');
  await waitShown(page, 'confirmModal');
  await page.click('#cifErrorsSkip');
  await finishLoad(page);
  const skipped = await page.evaluate(async () => {
    const s = (await import('./state/store.js')).fileBrowser.selectedStructure;
    return { errors: s.cifErrors, tagged: s.atoms.filter((a) => a.cifSite).length };
  });
  H.check('Load without errors drops them', skipped.errors === null && skipped.tagged === 0, JSON.stringify(skipped));
  const m3 = await measure(page);
  H.check('…and its labels are plain', m3.labels?.[0] === `${CC.toFixed(3)} Å`, JSON.stringify(m3.labels));

  await beginLoad(page, PM1_CIF, 'pm1-again.cif');
  await waitShown(page, 'cifSymmetryModal');
  const remembered = await page.evaluate(() => /** @type {HTMLInputElement} */ (document.getElementById('cifSymmetryModalErrors')).checked);
  H.check('the tick box starts from the last answer (no)', remembered === false, String(remembered));
  await page.evaluate(() => {
    [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')]
      .find((b) => /Load as a normal structure/.test(b.textContent || '')).click();
  });
  await finishLoad(page);

  // --- 6. The Polyhedron Inspector, on quartz kept in its own symmetry ----------
  await beginLoad(page, QUARTZ_CIF, 'quartz.cif');
  await waitShown(page, 'cifSymmetryModal');
  await page.evaluate(() => {
    /** @type {HTMLInputElement} */ (document.getElementById('cifSymmetryModalErrors')).click();
    [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')].find((b) => /Keep symmetry/.test(b.textContent || '')).click();
  });
  await finishLoad(page);
  await page.evaluate(async () => {
    const { removeSelectionInspectorPanel } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    removeSelectionInspectorPanel();
    const { addPolyhedronInspectorPanel } = await import('./ui/AnalysisPanels/PolyhedronInspector.js');
    addPolyhedronInspectorPanel();
  });
  const pollPoly = () => page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { selectAtomsByInstances, getSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    const { getInspectorState } = await import('./ui/AnalysisPanels/PolyhedronInspector.js');
    const s = fileBrowser.selectedStructure;
    if (!s.polyhedra?.polyhedra?.length) return null;
    if (!getSelectedAtoms().length) {
      const w = s.periodic.visibleWrapped;
      const si = s.polyhedra.polyhedra.find((p) => p.type === 'centered' && s.elements[p.centerIndex] === 'Si')?.centerIndex;
      const inst = w.cart.findIndex((_, i) => (w.srcIndex ? w.srcIndex[i] : i) === si);
      selectAtomsByInstances([inst]);
      document.dispatchEvent(new CustomEvent('crysviz:polyhedron-selection-changed', { detail: { key: null } }));
      return null;
    }
    const labels = (getInspectorState()?.labels ?? []).map((l) => l.text);
    return labels.length ? labels : null;
  });
  let polyLabels = [];
  for (let t = 0; t < 120 && !polyLabels.length; t++) {
    polyLabels = (await pollPoly()) ?? [];
    if (!polyLabels.length) await page.waitForTimeout(500);
  }
  const polySummary = await page.evaluate(async () => (await import('./ui/AnalysisPanels/PolyhedronInspector.js')).getInspectorState()?.summary ?? '');
  H.check('…and its volume, distortion index and angle variance, through the same maths',
    /Volume\s*\d+\.\d+\(\d+\) Å³/.test(polySummary) && /distortion\s*\d+\.\d+\(\d+\)/.test(polySummary)
      && /TAV[^0-9]*\d+\.?\d*\(\d+\)/.test(polySummary) && /s\.u\. from the CIF/.test(polySummary), polySummary);
  H.check('the Polyhedron Inspector writes the SiO4 lengths and angles with their errors',
    polyLabels.length >= 8 && polyLabels.filter((t) => /Å$/.test(t)).every((t) => /^1\.6\d+\(\d+\) Å$/.test(t))
      && polyLabels.filter((t) => /°$/.test(t)).every((t) => /^\d+\.\d+\(\d+\)°$/.test(t)),
    JSON.stringify(polyLabels));

  // --- 7. A magnetic CIF reads them too -----------------------------------------
  await beginLoad(page, MCIF, 'cr.mcif');
  await waitShown(page, 'confirmModal');
  const mcifDialog = await page.evaluate(() => document.getElementById('confirmModalTitle')?.textContent ?? '');
  await page.click('#cifErrorsRead');
  await finishLoad(page);
  const mcif = await page.evaluate(async () => {
    const s = (await import('./state/store.js')).fileBrowser.selectedStructure;
    const ce = await import('./model/cifErrors.js');
    const i = s.atoms.findIndex((a) => Math.abs(a.position[1] - 0.355) < 1e-3);
    const j = s.atoms.findIndex((a) => Math.abs(a.position[1] - 0.241) < 1e-3);
    return {
      read: ce.hasCifErrors(s), sites: s.atoms.filter((a) => a.cifSite).length, atoms: s.atoms.length,
      spins: s.spins.length, su: ce.distanceSu(s, { atomIndex: i, frac: s.atoms[i].position }, { atomIndex: j, frac: s.atoms[j].position }),
    };
  });
  H.check('an mCIF with errors asks too, and reads them for every atom', /Read errors from the CIF/.test(mcifDialog)
    && mcif.read && mcif.sites === mcif.atoms && mcif.atoms > 0 && mcif.su > 0, JSON.stringify({ mcifDialog, ...mcif }));

  // --- 8. Symmetry-tied parameters: hexagonal a = b, a site at (x, 2x, z) ----
  await beginLoad(page, I2N3_CIF, 'i2n3.cif');
  await waitShown(page, 'cifSymmetryModal');
  await page.evaluate(() => {
    const box = /** @type {HTMLInputElement} */ (document.getElementById('cifSymmetryModalErrors'));
    if (!box.checked) box.click();
    [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')].find((b) => /normal structure/.test(b.textContent || '')).click();
  });
  await finishLoad(page);
  const tied = await page.evaluate(async () => {
    const ce = await import('./model/cifErrors.js');
    const s = (await import('./state/store.js')).fileBrowser.selectedStructure;
    const ops = s.cifSymmetry.symops;
    const site = (label) => s.cifErrors.sites.findIndex((x) => x.label === label);
    // An atom by label and SHELXL symmetry code (op_klm), as the CIF's geom tables name them.
    const place = (label, code) => {
      const si = site(label);
      const x = s.cifErrors.sites[si].frac;
      const [op, tr] = code === '.' ? ['1', '555'] : code.split('_');
      const [R, t] = ops[Number(op) - 1];
      const k = [...tr].map((d) => Number(d) - 5);
      const p = [0, 1, 2].map((i) => R[i][0] * x[0] + R[i][1] * x[1] + R[i][2] * x[2] + t[i] + k[i]);
      const atomIndex = s.atoms.findIndex((a) => a.cifSite?.site === si
        && a.position.every((v, i) => { const d = v - p[i]; return Math.abs(d - Math.round(d)) < 1e-3; }));
      return { atomIndex, frac: p };
    };
    const angle = ce.angleSu(s, place('I001', '7_656'), place('I001', '.'), place('I001', '7_666'));
    const bond = ce.distanceSu(s, place('N1', '.'), place('N1', '7_855'));
    return {
      cellDirs: s.cifErrors.cell.dirs.length, n1Dirs: s.cifErrors.sites[site('N1')].dirs.length,
      angle: ce.formatWithSu(119.874, angle, 3), bond: ce.formatWithSu(1.09, bond, 2),
    };
  });
  H.check('a = b move together and N1 keeps to (x, 2x, z): the s.u.s match SHELXL\'s (119.874(8)°, 1.09(2) Å)',
    tied.cellDirs === 2 && tied.n1Dirs === 2 && tied.angle === '119.874(8)' && tied.bond === '1.09(2)', JSON.stringify(tied));

  // The search finds the switch by the words people use (the manual names these).
  const found = await page.evaluate(async () => {
    const fs = await import('./ui/FeatureSearch.js');
    fs.openFeatureSearch('');
    fs.closeFeatureSearch();
    return Object.fromEntries(['errors', 'esd', 'standard uncertainty'].map((q) => [q,
      fs.searchEntries(q).slice(0, 3).some((r) => r.entry.type === 'control' && r.entry.id === 'showCifErrorsToggle')]));
  });
  H.check('the search finds Show CIF Errors by "errors", "esd" and "standard uncertainty"', Object.values(found).every(Boolean), JSON.stringify(found));

  H.check('no console/page errors', errors.length === 0, errors.slice(0, 3).join(' ; '));

  await H.finish(browser);
})().catch(H.crash);
