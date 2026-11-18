// Crystal planes and the Planes colour bar in .crysviz sessions — not in share
// links (ui/ShareModule.js display.planes through state/structurePrefs.js's
// capture/restore for 'planes', and the plane bar's layout):
//   - a .crysviz session brings the planes back with their field colouring
//     (colour map, legend), bound to the saved field, opens the Planes window
//     on that plane, and its colour bar floats where it was, vertical,
//     flipped, locked
//   - a share link carries no planes and no Planes-bar settings
//   - an older session without planes leaves the planes on screen alone
//   - a colour bar that cannot take the settings (a stale cached widget) is
//     skipped instead of failing the whole load
'use strict';
const H = require('../harness');

const ANCHOR = { edgeX: 'left', offsetX: 60, edgeY: 'bottom', offsetY: 90 };

const STATE = async () => {
  const { fileBrowser, general } = await import('./state/store.js');
  const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
  const bar = listActiveColorBars().find((b) => b.id === 'plane')?.instance;
  const st = bar?.getSettings();
  return {
    planes: (fileBrowser.selectedStructure?.planes ?? []).map((p) => ({
      params: p.params, visualization: p.visualization, colormap: p.colormap,
      legendText: p.legendText ?? null, fieldLabel: p.fieldLabel ?? p.field?.label ?? null, fieldBound: p.field?.label ?? null,
    })),
    general: {
      orientation: general.planeColorBarOrientation, flip: general.planeColorBarFlipSide,
      floating: general.planeColorBarFloating, anchor: general.planeColorBarFloatPos, locked: general.planeColorBarLocked,
    },
    bar: bar ? { floating: bar.isFloating(), anchor: bar.isFloating() ? bar.getAnchor() : null, orientation: st.orientation, flipSide: st.flipSide, legend: st.legend } : null,
  };
};

const sameAnchor = (a, b) => !!a && !!b && a.edgeX === b.edgeX && a.edgeY === b.edgeY
  && Math.abs(a.offsetX - b.offsetX) <= 1 && Math.abs(a.offsetY - b.offsetY) <= 1;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  page.on('dialog', (d) => d.accept());

  const expand = (id) => page.evaluate(async (id) => (await import('./ui/panels/PanelManager.js')).getPanel(id).expand(), id);
  // An in-page field 'TestBlob' on the structure, as a field file attaches one
  // (tests/planesprefs.test.js).
  async function attachField() {
    await page.evaluate(async () => {
      const { Field, FieldContainer } = await import('./model/index.js');
      const { fileBrowser } = await import('./state/store.js');
      const { fieldBrowser } = await import('./ui/FieldPanel.js');
      const structure = fileBrowser.selectedStructure;
      const n = 12;
      const values = new Float32Array(n * n * n);
      let maxV = 0;
      for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = (n - 1) / 2;
        const v = Math.exp(-((i - c) ** 2 + (j - c) ** 2 + (k - c) ** 2) / 18);
        values[i + n * (j + n * k)] = v;
        if (v > maxV) maxV = v;
      }
      const field = new Field({
        nx: n, ny: n, nz: n, origin: [0, 0, 0], voxel: structure.lattice.map((row) => row.map((x) => x / n)), values, label: 'TestBlob',
        isoValue: 0.5, minValue: 0, maxValue: maxV, absMinValue: 0, absMaxValue: maxV, useAbsoluteIsoValue: false, isVisible: true,
      });
      structure.volumetricFields = new FieldContainer({ fileName: 'blob.cube', source: 'Cube', fields: [field] });
      fieldBrowser.setCatalog(structure.volumetricFields.catalog);
    });
    await page.waitForTimeout(300);
  }

  // ---- a plane coloured by the field, its own legend, the bar customised ----
  await expand('planes');
  await page.waitForTimeout(300);
  await attachField();
  await H.clickById(page, 'addPlaneBtn');
  await H.setSelect(page, 'planesFieldSelect', 'TestBlob');
  await H.setSelect(page, 'planesColormapSelect', 'viridis');
  await page.waitForTimeout(600);
  await page.evaluate(async (anchor) => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
    fileBrowser.selectedStructure.planes[0].legendText = 'ρ (e/Å³)';
    const bar = listActiveColorBars().find((b) => b.id === 'plane').instance;
    bar.applySettings({ floating: true, anchor, orientation: 'vertical', flipSide: true, legend: 'ρ (e/Å³)' });
    general.planeColorBarLocked = true;
  }, ANCHOR);
  const made = await page.evaluate(STATE);
  H.check('a plane coloured by the field, with its legend, and a floating vertical Planes bar',
    made.planes.length === 1 && made.planes[0].fieldBound === 'TestBlob' && made.planes[0].colormap === 'viridis'
      && made.bar?.floating && made.bar.orientation === 'vertical', JSON.stringify(made));

  const { session, url } = await page.evaluate(async () => {
    window.confirm = () => true;
    const { captureState, shareStructure } = await import('./ui/ShareModule.js');
    const session = JSON.parse(JSON.stringify(captureState({ includeFrames: true, includeFields: true })));
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    document.getElementById('shareLinkClose').click();
    return { session, url };
  });
  H.check('the session saves the plane (its colour map and legend) and the bar layout',
    session.display.planes?.length === 1 && session.display.planes[0].colormap === 'viridis'
      && session.display.planes[0].legendText === 'ρ (e/Å³)' && session.display.planeColorBarFloating === true
      && session.display.planeColorBarOrientation === 'vertical' && !('planeLegendText' in session.display),
    JSON.stringify({ planes: session.display.planes, o: session.display.planeColorBarOrientation }));

  /** Remove the planes and put the bar back to its defaults (a fresh session). */
  const clear = () => page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { syncPlanesForSelectedStructure } = await import('./ui/PlanesPanel.js');
    const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
    listActiveColorBars().find((b) => b.id === 'plane')?.instance.applySettings({ floating: false, orientation: 'horizontal', flipSide: false });
    Object.assign(general, { planeColorBarOrientation: 'horizontal', planeColorBarFlipSide: false, planeColorBarFloating: false, planeColorBarFloatPos: null, planeColorBarLocked: false });
    fileBrowser.selectedStructure.planes = [];
    syncPlanesForSelectedStructure();
  });

  // ---- .crysviz ----
  await clear();
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).getPanel('planes').collapse());
  await page.evaluate(async (state) => (await import('./ui/ShareModule.js')).applySharedState(state, 'planes.crysviz'), session);
  await page.waitForTimeout(1500);
  const fromFile = await page.evaluate(STATE);
  const planesWindow = await page.evaluate(async () => { const p = (await import('./ui/panels/PanelManager.js')).getPanel('planes'); return !p.closed && !p.collapsed; });
  H.check('the session opens the Planes window on the field plane by itself', planesWindow && !!fromFile.bar, JSON.stringify({ planesWindow, bar: fromFile.bar }));
  H.check('a .crysviz session brings the plane back, coloured by the saved field, with its legend',
    fromFile.planes.length === 1 && fromFile.planes[0].fieldBound === 'TestBlob' && fromFile.planes[0].colormap === 'viridis'
      && fromFile.planes[0].legendText === 'ρ (e/Å³)', JSON.stringify(fromFile.planes));
  H.check('… and the Planes bar floating there, vertical, flipped, locked, with the legend',
    fromFile.bar?.floating && sameAnchor(fromFile.bar.anchor, ANCHOR) && fromFile.bar.orientation === 'vertical'
      && fromFile.bar.flipSide === true && fromFile.bar.legend === 'ρ (e/Å³)' && fromFile.general.locked === true,
    JSON.stringify({ bar: fromFile.bar, general: fromFile.general }));

  // ---- an older session without planes leaves them alone ----
  await page.evaluate(async (state) => {
    const old = JSON.parse(JSON.stringify(state));
    delete old.display.planes;
    for (const k of Object.keys(old.display)) if (/^planeColorBar/.test(k)) delete old.display[k];
    await (await import('./ui/ShareModule.js')).applySharedState(old, 'older.crysviz');
  }, session);
  await page.waitForTimeout(1000);
  const afterOld = await page.evaluate(STATE);
  H.check('an older session without planes or plane-bar settings changes neither',
    afterOld.general.floating === true && afterOld.general.orientation === 'vertical' && afterOld.general.locked === true,
    JSON.stringify(afterOld.general));

  // ---- the share link ----
  await clear();
  await page.evaluate(async (u) => (await import('./ui/ShareModule.js')).openShareLink(u), url);
  await page.waitForTimeout(1500);
  const fromLink = await page.evaluate(STATE);
  H.check('a share link carries no planes and no Planes-bar settings',
    fromLink.planes.length === 0 && fromLink.general.floating === false && fromLink.general.orientation === 'horizontal'
      && fromLink.general.locked === false, JSON.stringify(fromLink));
  const linkState = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const d = captureState().display;
    return { planes: 'planes' in d, planeKeys: Object.keys(d).filter((k) => /^planeColorBar/.test(k)) };
  });
  H.check('(the link capture has neither)', !linkState.planes && linkState.planeKeys.length === 0, JSON.stringify(linkState));

  // ---- a bar that cannot take the settings (a stale cached widget, an older
  // build: "applySettings is not a function") must not fail the load ----
  const robust = await page.evaluate(async (state) => {
    const registry = await import('./ui/ColorBarRegistry.js');
    const stale = { getSettings: () => ({ orientation: 'horizontal', flipSide: false, legend: '' }), isFloating: () => false, getAnchor: () => null };
    for (const id of ['plane', 'force', 'atom']) registry.registerColorBarSource(id, id, () => stale);
    const { applySharedState } = await import('./ui/ShareModule.js');
    let result;
    try { result = await applySharedState(JSON.parse(JSON.stringify(state)), 'stale.crysviz'); } catch (e) { result = `threw ${e.message}`; }
    const { fileBrowser } = await import('./state/store.js');
    return { result, planes: fileBrowser.selectedStructure?.planes?.length ?? 0 };
  }, session);
  H.check('a colour bar that cannot take the settings does not fail the load (it is skipped)',
    robust.result !== false && !String(robust.result).startsWith('threw') && robust.planes === 1, JSON.stringify(robust));

  const own = errors.filter((e) => !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/.test(e));
  H.check('no console/page errors', own.length === 0, own.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
