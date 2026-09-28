// The shared view lock's ten Features switches survive a reload through the
// cascade (ui/FeatureLockModule.js, planning/2026-09-28-shared-view-lock-plan.md
// Phase 1): the shared set in 'crysviz.sharedFeatureToggles.v1' while locked,
// per-structure overrides in structurePrefs' 'featureToggles' while unlocked,
// resolved as override ?? shared ?? default.
//
// Sections (check names carry the DW ids of the plan):
//   A. no programmatic path writes either store (DW-1.4); lock-on stores the
//      current values; locked flips survive a reload (DW-1.1); unlocking on a
//      structure without overrides changes nothing (DW-1.3)
//   B. unlocked overrides per structure, across a row switch and a reload (DW-1.2);
//      an override flipped back to the shared value drops out of storage
//   C. "Clear local data" removes both stores and nothing returns until a user
//      edit (DW-1.6)
//   D. a share link, a .crysviz file and a plain widget ignore both stores; a
//      widget with prefs=1 applies them (DW-1.5); after a share boot, switching
//      rows and back brings the link's values back and a flip saves only that
//      switch (DW-1.9); widget init writes nothing (DW-1.4)
//   E. a Features window collapsed at boot applies a stored panel-built switch
//      once it is expanded
//   F. corrupted stored JSON boots with the defaults and no errors
'use strict';
const H = require('../harness');

const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';
const SHARED_KEY = 'crysviz.sharedFeatureToggles.v1';
const PREFS_KEY = 'crysviz.structurePrefs.v1';
const LOCK_KEY = 'crysvizLockPrefs';
const IDS = ['showAtoms', 'showBonds', 'showCharges', 'PBCBondToggle', 'showPolyhedra', 'completePolyhedraToggle',
  'showForcesToggle', 'showSpinsToggle', 'showFieldToggle', 'showPlanesMasterToggle'];
const DEFAULTS = {
  showAtoms: true, showBonds: true, showCharges: false, PBCBondToggle: false, showPolyhedra: false,
  completePolyhedraToggle: false, showForcesToggle: false, showSpinsToggle: false, showFieldToggle: true,
  showPlanesMasterToggle: true,
};

// Two ionic steps (clearlocaldata.test.js fixture) for the trajectory-step path.
const STEP = (oX, toten) => [
  '  direct lattice vectors                 reciprocal lattice vectors',
  '     4.000000000  0.000000000  0.000000000     0.250000000  0.000000000  0.000000000',
  '     0.000000000  4.000000000  0.000000000     0.000000000  0.250000000  0.000000000',
  '     0.000000000  0.000000000  4.000000000     0.000000000  0.000000000  0.250000000',
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

// Live state: lock, every checkbox (null = not built), the driven flags, the
// scene, and both stores as raw strings.
const STATE = async () => {
  const { general, groups, fileBrowser, structureShip } = await import('./state/store.js');
  const { planesData } = await import('./ui/PlanesPanel.js');
  const ids = ['showAtoms', 'showBonds', 'showCharges', 'PBCBondToggle', 'showPolyhedra', 'completePolyhedraToggle',
    'showForcesToggle', 'showSpinsToggle', 'showFieldToggle', 'showPlanesMasterToggle'];
  const checks = {};
  for (const id of ids) checks[id] = document.getElementById(id)?.checked ?? null;
  return {
    locked: general.featuresLocked,
    checks,
    g: {
      showAtoms: general.showAtoms, showBonds: general.showBonds, showCharges: general.showCharges,
      showPBCBonds: general.showPBCBonds, showPolyhedra: general.showPolyhedra, completePolyhedra: general.completePolyhedra,
      forcesActive: general.forcesActive, spinsActive: general.spinsActive, fieldActive: general.fieldActive,
      showPlanes: planesData.showPlanes,
    },
    atomsShown: !!groups.atomsMesh?.visible,
    bondsShown: !!groups.bondsMesh?.visible,
    polyCount: groups.polyhedraGroup?.children?.length ?? 0,
    row: fileBrowser.selectedRowIndex,
    rows: structureShip.container.length,
    overrides: structureShip.container[fileBrowser.selectedRowIndex]?.featureOverrides ?? null,
    shared: localStorage.getItem('crysviz.sharedFeatureToggles.v1'),
    prefs: localStorage.getItem('crysviz.structurePrefs.v1'),
  };
};

/** { name: featureToggles } for every stored structure record. */
const STORED_TOGGLES = (raw) => {
  const out = {};
  for (const rec of Object.values(JSON.parse(raw || '{}'))) if (rec && 'featureToggles' in rec) out[rec.name] = rec.featureToggles;
  return out;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function waitDefault(page) {
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return (fileBrowser.selectedStructure?.atoms?.length ?? 0) > 0;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(1500);
}

async function reload(page) {
  await page.reload({ waitUntil: 'load' });
  await waitDefault(page);
}

async function expandPanel(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel(id).expand();
  }, id);
  await page.waitForTimeout(300);
}

async function selectRow(page, i) {
  await page.evaluate(async (i) => {
    const { selectStructure } = await import('./ui/FileBrowswerPanel.js');
    selectStructure(i);
  }, i);
  await page.waitForTimeout(500);
}

/** A user flip of one switch (native click -> change). */
async function flip(page, id) {
  await H.clickById(page, id);
  await page.waitForTimeout(300);
}

/** Unlock through the real switch (no confirm on the way off). */
async function unlock(page) {
  await flip(page, 'featureSharedViewToggle');
}

/** Lock through the real switch and accept its confirm dialog. */
async function lock(page) {
  await H.clickById(page, 'featureSharedViewToggle');
  await page.waitForSelector('#confirmModalOk', { state: 'visible', timeout: 5000 });
  await H.clickById(page, 'confirmModalOk');
  await page.waitForTimeout(400);
}

async function setLockPref(page, locked) {
  await page.evaluate(({ k, locked }) => localStorage.setItem(k, JSON.stringify({ cameraLocked: true, featuresLocked: locked })),
    { k: LOCK_KEY, locked });
}

const bothStoresEmpty = (s) => s.shared === null && !/featureToggles/.test(s.prefs || '');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());

  // ==== A. programmatic paths never write; lock-on; locked reload; unlock ====
  await expandPanel(page, 'features');
  let s = await page.evaluate(STATE);
  H.check('DW-1.4 still empty after boot', bothStoresEmpty(s), JSON.stringify([s.shared, s.prefs]));
  H.check('boot: locked with the default switch values',
    s.locked === true && same(s.checks, DEFAULTS), JSON.stringify(s.checks));

  await H.loadDefaultStructure(page); // row 1: YBCO
  s = await page.evaluate(STATE);
  H.check('DW-1.4 still empty after a file load', bothStoresEmpty(s) && s.rows === 2, JSON.stringify([s.shared, s.prefs]));

  await selectRow(page, 0);
  await selectRow(page, 1);
  s = await page.evaluate(STATE);
  H.check('DW-1.4 still empty after row switches', bothStoresEmpty(s), JSON.stringify([s.shared, s.prefs]));

  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'OUTCAR');
  }, OUTCAR); // row 2
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    showTrajectoryFrame(1, container);
    await new Promise((r) => setTimeout(r, 200));
    showTrajectoryFrame(0, container);
  });
  await page.waitForTimeout(400);
  s = await page.evaluate(STATE);
  H.check('DW-1.4 still empty after trajectory steps', bothStoresEmpty(s) && s.rows === 3, JSON.stringify([s.shared, s.prefs]));

  const shareApplied = await page.evaluate(async () => {
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    return applySharedState(captureState(), 'shared.vasp');
  }); // row 3
  await page.waitForTimeout(800);
  s = await page.evaluate(STATE);
  H.check('DW-1.4 still empty after a share restore', shareApplied === true && bothStoresEmpty(s) && s.rows === 4,
    JSON.stringify([shareApplied, s.shared, s.prefs]));

  await selectRow(page, 0);
  const beforeUnlock = await page.evaluate(STATE);
  await page.evaluate(async () => {
    const { applyEffectiveFeatureToggles } = await import('./ui/FeatureLockModule.js');
    applyEffectiveFeatureToggles();
  });
  await unlock(page);
  s = await page.evaluate(STATE);
  H.check('DW-1.4 still empty after the cascade apply and an unlock', bothStoresEmpty(s) && s.locked === false,
    JSON.stringify([s.locked, s.shared, s.prefs]));
  H.check('DW-1.3 unlocking on a structure without overrides changes no switch (nothing stored)',
    same(s.checks, beforeUnlock.checks) && s.overrides === null, JSON.stringify([beforeUnlock.checks, s.checks]));

  // Lock back on: the current values become the shared set, nothing on screen changes.
  await lock(page);
  s = await page.evaluate(STATE);
  H.check('lock-on stores the current values as the shared set and changes no switch',
    s.locked === true && same(JSON.parse(s.shared || 'null'), s.checks) && same(s.checks, beforeUnlock.checks),
    JSON.stringify([s.locked, s.shared]));

  // DW-1.1 on YBCO (bonds + polyhedra to look at).
  await selectRow(page, 1);
  await flip(page, 'showBonds');
  await flip(page, 'showPolyhedra');
  await H.waitFor(page, async () => (await import('./state/store.js')).groups.polyhedraGroup?.children?.length > 0,
    { timeout: 20000, interval: 500 });
  s = await page.evaluate(STATE);
  const sharedNow = JSON.parse(s.shared || '{}');
  H.check('DW-1.1 shared set stored after user flips while locked',
    sharedNow.showBonds === false && sharedNow.showPolyhedra === true && !s.bondsShown && s.polyCount > 0
      && !/featureToggles/.test(s.prefs || ''),
    JSON.stringify([s.shared, s.bondsShown, s.polyCount]));

  await reload(page);
  await expandPanel(page, 'features');
  s = await page.evaluate(STATE);
  H.check('DW-1.1 reload: switches show the shared values',
    s.locked === true && s.checks.showBonds === false && s.checks.showPolyhedra === true
      && s.g.showBonds === false && s.g.showPolyhedra === true && s.checks.showAtoms === true,
    JSON.stringify([s.locked, s.checks]));
  await H.loadDefaultStructure(page); // row 1: YBCO again
  await H.waitFor(page, async () => (await import('./state/store.js')).groups.polyhedraGroup?.children?.length > 0,
    { timeout: 20000, interval: 500 });
  s = await page.evaluate(STATE);
  H.check('DW-1.1 reload: scene reflects the shared values (no bonds, polyhedra drawn)',
    !s.bondsShown && s.polyCount > 0 && s.checks.showBonds === false && s.checks.showPolyhedra === true,
    JSON.stringify([s.bondsShown, s.polyCount, s.checks]));

  // Unlock on the boot structure (no overrides): the shared values stay.
  await selectRow(page, 0);
  const lockedView = await page.evaluate(STATE);
  await unlock(page);
  s = await page.evaluate(STATE);
  H.check('DW-1.3 unlocking on a structure without overrides changes no switch (shared set stored)',
    s.locked === false && same(s.checks, lockedView.checks) && same(s.g, lockedView.g) && s.overrides === null,
    JSON.stringify([lockedView.checks, s.checks]));
  H.check('DW-1.4 unlock with a stored shared set writes nothing new',
    s.shared === lockedView.shared && !/featureToggles/.test(s.prefs || ''), JSON.stringify([s.shared, s.prefs]));

  // ==== B. per-structure overrides while unlocked (DW-1.2) ====
  await selectRow(page, 1); // B = YBCO
  await flip(page, 'showAtoms');
  s = await page.evaluate(STATE);
  H.check('DW-1.2 override stored as a per-switch patch on B only',
    same(STORED_TOGGLES(s.prefs), { YBCO: { showAtoms: false } }) && same(s.overrides, { showAtoms: false })
      && s.shared === lockedView.shared && !s.atomsShown,
    JSON.stringify([STORED_TOGGLES(s.prefs), s.overrides, s.atomsShown]));

  await selectRow(page, 0);
  const onA = await page.evaluate(STATE);
  await selectRow(page, 1);
  const onB = await page.evaluate(STATE);
  H.check('DW-1.2 A shows the shared value, B its override',
    onA.checks.showAtoms === true && onA.atomsShown && onB.checks.showAtoms === false && !onB.atomsShown
      && onA.checks.showBonds === false && onB.checks.showBonds === false,
    JSON.stringify([onA.checks, onA.atomsShown, onB.checks, onB.atomsShown]));

  await reload(page);
  await expandPanel(page, 'features');
  const bootA = await page.evaluate(STATE);
  await H.loadDefaultStructure(page);
  const loadB = await page.evaluate(STATE);
  await selectRow(page, 0);
  const againA = await page.evaluate(STATE);
  await selectRow(page, 1);
  const againB = await page.evaluate(STATE);
  H.check('DW-1.2 after reload A shows the shared value, B its override',
    bootA.locked === false && bootA.checks.showAtoms === true && loadB.checks.showAtoms === false && !loadB.atomsShown
      && againA.checks.showAtoms === true && againA.atomsShown && againB.checks.showAtoms === false && !againB.atomsShown
      && same(againB.overrides, { showAtoms: false }) && againA.overrides === null,
    JSON.stringify({ bootA: bootA.checks, loadB: loadB.checks, againA: againA.checks, againB: againB.checks }));
  H.check('DW-1.4 reload + load + row switches wrote nothing new',
    againB.shared === lockedView.shared && same(STORED_TOGGLES(againB.prefs), { YBCO: { showAtoms: false } }),
    JSON.stringify([againB.shared, STORED_TOGGLES(againB.prefs)]));

  // An override flipped back to the shared value leaves storage.
  await flip(page, 'showAtoms');
  s = await page.evaluate(STATE);
  H.check('override equal to the shared value is dropped from storage',
    !/featureToggles/.test(s.prefs || '') && s.checks.showAtoms === true && s.atomsShown,
    JSON.stringify([STORED_TOGGLES(s.prefs), s.checks.showAtoms]));

  // ==== C. Clear local data (DW-1.6) ====
  await flip(page, 'showCharges'); // an override on B again
  s = await page.evaluate(STATE);
  H.check('setup: both stores populated before the clear',
    s.shared !== null && same(STORED_TOGGLES(s.prefs), { YBCO: { showCharges: true } }), JSON.stringify([s.shared, s.prefs]));
  await expandPanel(page, 'settings');
  await H.clickById(page, 'clearLocalDataButton');
  await page.waitForTimeout(300);
  s = await page.evaluate(STATE);
  H.check('DW-1.6 clear removes both stores and leaves the screen alone',
    s.shared === null && s.prefs === null && s.checks.showCharges === true && s.checks.showBonds === false,
    JSON.stringify([s.shared, s.prefs, s.checks]));
  await selectRow(page, 0);
  await selectRow(page, 1);
  await page.evaluate(async () => {
    const { applyEffectiveFeatureToggles } = await import('./ui/FeatureLockModule.js');
    applyEffectiveFeatureToggles();
  });
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'OUTCAR');
  }, OUTCAR);
  await page.waitForTimeout(800);
  s = await page.evaluate(STATE);
  H.check('DW-1.6 nothing written back by row switches, a cascade apply and a load',
    s.shared === null && !/featureToggles/.test(s.prefs || '') && s.checks.showBonds === true,
    JSON.stringify([s.shared, s.prefs, s.checks]));
  await flip(page, 'PBCBondToggle');
  s = await page.evaluate(STATE);
  H.check('DW-1.6 a new user edit writes again (unlocked -> an override)',
    same(STORED_TOGGLES(s.prefs), { OUTCAR: { PBCBondToggle: true } }) && s.shared === null,
    JSON.stringify([s.shared, STORED_TOGGLES(s.prefs)]));
  await flip(page, 'PBCBondToggle');

  // ==== D. share link, .crysviz, widget (DW-1.5, DW-1.9, DW-1.4) ====
  // Captured BEFORE the stores are populated: a share link of the boot
  // structure (row 0), a .crysviz of YBCO, and YBCO's POSCAR for the widget.
  await selectRow(page, 0);
  const link = await page.evaluate(async () => {
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    document.getElementById('shareLinkClose').click();
    return url;
  });
  await selectRow(page, 1);
  const { crysvizText, poscar } = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const d = await import('./defaults/structure_defaults.js');
    return { crysvizText: JSON.stringify({ format: 'crysviz', ...captureState() }), poscar: d.defaultPOSCAR };
  });
  const b64 = Buffer.from(poscar, 'utf8').toString('base64');
  const widgetUrl = (extra) => `${BASE}?widget=1${extra}#load-file=${encodeURIComponent('YBCO.vasp')}|${encodeURIComponent(b64)}`;
  H.check('setup: share link, .crysviz and POSCAR captured at the default view',
    /state=|#/.test(link) && crysvizText.includes('"showBonds":true') && poscar.length > 0, link.slice(0, 80));

  // Populate: shared { ..., showBonds: false } (flip while locked), YBCO override { showCharges: true }.
  await lock(page);
  await flip(page, 'showBonds');
  await unlock(page);
  await flip(page, 'showCharges');
  s = await page.evaluate(STATE);
  H.check('setup: shared set has showBonds off, YBCO overrides showCharges on',
    JSON.parse(s.shared || '{}').showBonds === false && same(STORED_TOGGLES(s.prefs), { YBCO: { showCharges: true } })
      && s.locked === false,
    JSON.stringify([s.shared, STORED_TOGGLES(s.prefs)]));
  const populated = { shared: s.shared, prefs: s.prefs };

  // .crysviz load in the running app (unlocked): the file's values, not the stores.
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'ybco.crysviz');
  }, crysvizText);
  await page.waitForTimeout(1000);
  s = await page.evaluate(STATE);
  H.check('DW-1.5 .crysviz load ignores both stores (same structure as a stored override)',
    s.checks.showBonds === true && s.checks.showCharges === false && s.g.showBonds === true && s.g.showCharges === false
      && s.bondsShown && same(s.overrides, DEFAULTS), // seeded from the file's values, in memory only
    JSON.stringify([s.checks, s.g, s.overrides]));
  H.check('DW-1.4 .crysviz load wrote nothing', s.shared === populated.shared && s.prefs === populated.prefs,
    JSON.stringify([s.shared, s.prefs]));

  // Share-link boot while locked: the link's values, the shared set is ignored.
  await setLockPref(page, true);
  await page.goto(link, { waitUntil: 'load' });
  await H.waitFor(page, async () => (await import('./state/store.js')).general.sharedStructureLoaded, { timeout: 40000, interval: 1000 });
  await waitDefault(page);
  await expandPanel(page, 'features');
  s = await page.evaluate(STATE);
  H.check('DW-1.5 share-link load (locked) ignores the stored shared set',
    s.locked === true && s.checks.showBonds === true && s.g.showBonds === true && s.bondsShown,
    JSON.stringify([s.locked, s.checks]));

  // Share-link boot while unlocked, then DW-1.9.
  await setLockPref(page, false);
  await page.goto(link, { waitUntil: 'load' });
  await H.waitFor(page, async () => (await import('./state/store.js')).general.sharedStructureLoaded, { timeout: 40000, interval: 1000 });
  await waitDefault(page);
  await expandPanel(page, 'features');
  s = await page.evaluate(STATE);
  H.check('DW-1.5 share-link load (unlocked) ignores both stores',
    s.locked === false && s.checks.showBonds === true && s.checks.showCharges === false && s.bondsShown
      && s.overrides?.showBonds === true,
    JSON.stringify([s.locked, s.checks, s.overrides]));
  H.check('DW-1.4 share-link boot wrote nothing', s.shared === populated.shared && s.prefs === populated.prefs,
    JSON.stringify([s.shared, s.prefs]));
  const shareRow = s.row;

  await H.loadDefaultStructure(page); // YBCO: a plain load, so the stores apply to it
  const ybco = await page.evaluate(STATE);
  H.check('a plain load after a share boot resolves the stores (override + shared)',
    ybco.checks.showCharges === true && ybco.checks.showBonds === false && !ybco.bondsShown,
    JSON.stringify(ybco.checks));
  await selectRow(page, shareRow);
  s = await page.evaluate(STATE);
  H.check("DW-1.9 link values reappear after switching rows and back",
    s.checks.showBonds === true && s.checks.showCharges === false && s.bondsShown && s.g.showBonds === true,
    JSON.stringify(s.checks));
  await flip(page, 'showPolyhedra');
  s = await page.evaluate(STATE);
  const storedShare = STORED_TOGGLES(s.prefs);
  const shareName = Object.keys(storedShare).find((n) => n !== 'YBCO');
  H.check('DW-1.9 a user flip saves only that one switch',
    shareName !== undefined && same(storedShare[shareName], { showPolyhedra: true })
      && same(storedShare.YBCO, { showCharges: true }) && s.shared === populated.shared,
    JSON.stringify([storedShare, s.shared]));
  await flip(page, 'showPolyhedra'); // back: the record disappears again
  s = await page.evaluate(STATE);
  H.check('DW-1.9 flipping it back drops the record', same(STORED_TOGGLES(s.prefs), { YBCO: { showCharges: true } }),
    JSON.stringify(STORED_TOGGLES(s.prefs)));

  // Widget embeds (same origin, same stores; lock pref is unlocked).
  const widgetWait = async () => {
    await H.waitFor(page, async () => {
      const { fileBrowser } = await import('./state/store.js');
      return document.body.classList.contains('widget-mode') && !!fileBrowser.selectedStructure;
    }, { timeout: 40000, interval: 1000 });
    await page.waitForTimeout(1500);
  };
  await page.goto(widgetUrl(''), { waitUntil: 'load', timeout: 90000 });
  await widgetWait();
  s = await page.evaluate(STATE);
  H.check('DW-1.5 plain widget ignores both stores',
    s.checks.showBonds === true && s.checks.showCharges === false && s.g.showBonds === true && s.g.showCharges === false
      && s.locked === true,
    JSON.stringify([s.checks, s.g, s.locked]));
  H.check('DW-1.4 plain widget init wrote nothing', s.shared === populated.shared && s.prefs === populated.prefs,
    JSON.stringify([s.shared, s.prefs]));

  await page.goto('about:blank');
  await page.goto(widgetUrl('&prefs=1'), { waitUntil: 'load', timeout: 90000 });
  await widgetWait();
  s = await page.evaluate(STATE);
  H.check('DW-1.5 widget with prefs=1 applies both stores (shared showBonds off, override showCharges on)',
    s.checks.showBonds === false && s.checks.showCharges === true && s.g.showBonds === false && s.g.showCharges === true
      && !s.bondsShown && s.locked === true,
    JSON.stringify([s.checks, s.g, s.locked]));
  H.check('DW-1.4 widget with prefs=1 init wrote nothing', s.shared === populated.shared && s.prefs === populated.prefs,
    JSON.stringify([s.shared, s.prefs]));

  // Widget init with empty storage writes neither store (fresh context).
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const fresh = await ctx.newPage();
  const freshErrors = [];
  fresh.on('pageerror', (e) => freshErrors.push(String(e.message).slice(0, 300)));
  await fresh.goto(widgetUrl('&prefs=1'), { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(fresh, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return document.body.classList.contains('widget-mode') && !!fileBrowser.selectedStructure;
  }, { timeout: 40000, interval: 1000 });
  await fresh.waitForTimeout(1500);
  const freshStores = await fresh.evaluate(({ a, b }) => [localStorage.getItem(a), localStorage.getItem(b)], { a: SHARED_KEY, b: PREFS_KEY });
  H.check('DW-1.4 widget-mode init with empty storage writes neither store',
    freshStores[0] === null && freshStores[1] === null && freshErrors.length === 0, JSON.stringify([freshStores, freshErrors]));
  await ctx.close();

  // ==== E. Features window collapsed at boot ====
  await setLockPref(page, true); // still on the widget page: same origin
  await page.goto('about:blank');
  await page.goto(BASE, { waitUntil: 'load', timeout: 90000 });
  await waitDefault(page);
  await expandPanel(page, 'features');
  await flip(page, 'showFieldToggle'); // locked: shared.showFieldToggle = false
  s = await page.evaluate(STATE);
  H.check('setup: a panel-built switch stored in the shared set',
    JSON.parse(s.shared || '{}').showFieldToggle === false && s.g.fieldActive === false, s.shared);
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('features').collapse();
  });
  await page.waitForTimeout(800); // past the layout-save debounce
  await reload(page);
  const collapsed = await page.evaluate(STATE);
  await expandPanel(page, 'features');
  s = await page.evaluate(STATE);
  H.check('collapsed Features window: the panel-built switch applies once the window is expanded',
    collapsed.checks.showFieldToggle === null && s.checks.showFieldToggle === false && s.g.fieldActive === false
      && s.checks.showBonds === false,
    JSON.stringify([collapsed.checks.showFieldToggle, s.checks, s.g.fieldActive]));
  await flip(page, 'showFieldToggle'); // shared.showFieldToggle back on for the sections below

  // ==== F. corrupted stored JSON ====
  const key0 = await page.evaluate(async () => {
    const { structurePrefsKey } = await import('./state/structurePrefs.js');
    const { structureShip } = await import('./state/store.js');
    return structurePrefsKey(structureShip.container[0]);
  });
  await page.evaluate(({ SHARED_KEY, PREFS_KEY, key0 }) => {
    localStorage.setItem(SHARED_KEY, 'not json {');
    localStorage.setItem(PREFS_KEY, JSON.stringify({ [key0]: { name: 'boot', t: 1, featureToggles: 'garbage' } }));
  }, { SHARED_KEY, PREFS_KEY, key0 });
  await setLockPref(page, false);
  await reload(page);
  await expandPanel(page, 'features');
  s = await page.evaluate(STATE);
  const readNull = await page.evaluate(async () => (await import('./ui/FeatureLockModule.js')).readSharedFeatureToggles());
  H.check('dirty: corrupted shared JSON and a non-object override boot with the defaults',
    same(s.checks, DEFAULTS) && readNull === null && s.overrides === null, JSON.stringify([s.checks, readNull, s.overrides]));

  await page.evaluate(({ SHARED_KEY, PREFS_KEY, key0 }) => {
    localStorage.setItem(SHARED_KEY, JSON.stringify({ showBonds: 'no', bogus: true, showCharges: true }));
    localStorage.setItem(PREFS_KEY, JSON.stringify({ [key0]: { name: 'boot', t: 1, featureToggles: { bogus: true, showBonds: 'no', showAtoms: false, showPolyhedra: 1 } } }));
  }, { SHARED_KEY, PREFS_KEY, key0 });
  await reload(page);
  await expandPanel(page, 'features');
  s = await page.evaluate(STATE);
  const readPartial = await page.evaluate(async () => (await import('./ui/FeatureLockModule.js')).readSharedFeatureToggles());
  H.check('dirty: unknown ids and non-booleans are ignored, valid entries apply',
    same(s.checks, { ...DEFAULTS, showCharges: true, showAtoms: false }) && same(readPartial, { showCharges: true })
      && same(s.overrides, { showAtoms: false }) && !s.atomsShown,
    JSON.stringify([s.checks, readPartial, s.overrides]));
  H.check('DW-1.4 a boot from corrupted stores rewrites nothing',
    s.shared === JSON.stringify({ showBonds: 'no', bogus: true, showCharges: true }), s.shared);

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
