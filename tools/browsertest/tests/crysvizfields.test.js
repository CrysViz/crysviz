// Volumetric fields embedded in a .crysviz + two ShareModule restore bug fixes.
//
// Item 2 — a synthetic Gaussian-blob Field is attached to YBCO and driven through
// the real field path (setActiveField + updateField). Asserts:
//   (1) captureState({includeFrames,includeFields}) adds a top-level `fields`
//       block (metadata + selectedIndex + isoSettings; base64 float bytes decode
//       back to the exact samples) at version 2.13;
//   (2) plain captureState() (the share-URL path) carries NO `fields` block;
//   (3) round-trip: after wiping the field, applySharedState(deep copy) rebuilds
//       structure.volumetricFields, the isosurface (vertices > 0 at the saved
//       isoValue), the iso colors/opacity, structure.fieldMaterial, and the Field
//       panel availability.
//
// Item 1 — the restore no longer leaves rendering controls stale and no longer
// leaks the raytrace-warning one-shot:
//   (4a) in raytrace, restoring a 'forward' state hides rtControlsBlock + the
//        tracer-pipeline body class and shows the raster-only Render Style menu;
//   (4b) after restoring a 'depthpeel' state (which the OLD code armed a leaked
//        one-shot for), a genuine dropdown switch to raytrace DOES show the modal.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- (1)/(2) Build a Gaussian blob field, capture with and without fields --------
  const cap = await page.evaluate(async () => {
    const { Field, FieldContainer, setIsosurfaceMaterialSettings } = await import('./model/index.js');
    const { fileBrowser } = await import('./state/store.js');
    const { fieldBrowser } = await import('./ui/FieldPanel.js');
    const { setActiveField, updateField } = await import('./render/index.js');
    const { captureState } = await import('./ui/ShareModule.js');

    const structure = fileBrowser.selectedStructure;
    const lat = structure.lattice;
    const nx = 20, ny = 20, nz = 20;
    const values = new Float32Array(nx * ny * nz);
    const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2, sigma = 4.0;
    let maxV = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const d2 = (i - cx) ** 2 + (j - cy) ** 2 + (k - cz) ** 2;
          const v = Math.exp(-d2 / (2 * sigma * sigma));
          values[i + nx * (j + ny * k)] = v;
          if (v > maxV) maxV = v;
        }
    const voxel = [
      [lat[0][0] / nx, lat[0][1] / nx, lat[0][2] / nx],
      [lat[1][0] / ny, lat[1][1] / ny, lat[1][2] / ny],
      [lat[2][0] / nz, lat[2][1] / nz, lat[2][2] / nz],
    ];
    const field = new Field({
      nx, ny, nz, origin: [0.1, 0.2, 0.3], voxel, values, label: 'TestBlob',
      isoValue: 0.5, minValue: 0, maxValue: maxV, absMinValue: 0, absMaxValue: maxV,
      useAbsoluteIsoValue: false, isVisible: true,
    });
    structure.volumetricFields = new FieldContainer({ fileName: 'blob.cube', source: 'Cube', fields: [field] });
    fieldBrowser.selectedField = null;
    fieldBrowser.setAvailableFields([field]);
    fieldBrowser.setSelectedField(0);
    setActiveField(field, false);
    updateField(0.5);

    // Distinctive iso material + a per-structure tracer field material.
    setIsosurfaceMaterialSettings({ positiveColor: '#112277', negativeColor: '#aa3311', opacity: 0.42 });
    structure.fieldMaterial = { type: 'metal', roughness: 0.25 };

    const state = captureState({ includeFrames: true, includeFields: true });
    const plain = captureState(); // share-URL path — must NOT include fields

    // Decode the base64 float bytes back and spot-check samples.
    const f0 = state.fields?.fields?.[0];
    let samplesMatch = false, decodedLen = 0;
    if (f0?.values) {
      const bin = atob(f0.values);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const decoded = new Float32Array(bytes.buffer);
      decodedLen = decoded.length;
      const idxs = [0, 137, 4000, 7999, nx * ny * nz - 1];
      samplesMatch = idxs.every((ix) => Math.abs(decoded[ix] - values[ix]) < 1e-6);
    }

    return {
      version: state.version,
      hasFields: !!state.fields,
      fileName: state.fields?.fileName,
      source: state.fields?.source,
      selectedIndex: state.fields?.selectedIndex,
      fieldCount: state.fields?.fields?.length,
      label: f0?.label, nx: f0?.nx, ny: f0?.ny, nz: f0?.nz,
      origin: f0?.origin, useAbs: f0?.useAbsoluteIsoValue, isoValue: f0?.isoValue,
      decodedLen, expectLen: nx * ny * nz, samplesMatch,
      isoSettings: state.fields?.isoSettings,
      plainHasFields: !!plain.fields,
      plainVersion: plain.version,
    };
  });

  H.check('captureState({includeFields}) adds a fields block at v2.13 with correct metadata',
    cap.version === '2.13' && cap.hasFields === true && cap.fileName === 'blob.cube'
      && cap.source === 'Cube' && cap.selectedIndex === 0 && cap.fieldCount === 1
      && cap.label === 'TestBlob' && cap.nx === 20 && cap.ny === 20 && cap.nz === 20
      && cap.useAbs === false && Math.abs(cap.isoValue - 0.5) < 1e-9,
    JSON.stringify(cap));
  H.check('field values base64 decode back to the exact Float32 samples',
    cap.decodedLen === cap.expectLen && cap.samplesMatch === true,
    JSON.stringify({ decodedLen: cap.decodedLen, expectLen: cap.expectLen, samplesMatch: cap.samplesMatch }));
  H.check('isoSettings (pos/neg colors + opacity) are captured in the fields block',
    cap.isoSettings?.positiveColor === '#112277' && cap.isoSettings?.negativeColor === '#aa3311'
      && Math.abs(cap.isoSettings?.opacity - 0.42) < 1e-9,
    JSON.stringify(cap.isoSettings));
  H.check('plain captureState() (share-URL path) has NO fields block, still v2.13',
    cap.plainHasFields === false && cap.plainVersion === '2.13',
    JSON.stringify({ plainHasFields: cap.plainHasFields, plainVersion: cap.plainVersion }));

  // --- (3) Round-trip: wipe the field, then applySharedState restores it ------------
  const rt = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const { getIsosurfaceMaterialSettings, setIsosurfaceMaterialSettings } = await import('./model/index.js');
    const { clearField } = await import('./render/index.js');

    const state = captureState({ includeFrames: true, includeFields: true });
    const copy = JSON.parse(JSON.stringify(state));

    // Decode the saved samples for post-restore comparison.
    const savedB64 = copy.fields.fields[0].values;
    const bin = atob(savedB64);
    const sbytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) sbytes[i] = bin.charCodeAt(i);
    const savedDecoded = new Float32Array(sbytes.buffer);

    // Mutate the scene: drop the field + selection and stomp the iso material so a
    // successful restore has to put everything back.
    clearField();
    fileBrowser.selectedStructure.volumetricFields = null;
    setIsosurfaceMaterialSettings({ positiveColor: '#000000', negativeColor: '#000000', opacity: 0.99 });

    applySharedState(copy, 'roundtrip.crysviz');
    await new Promise((r) => setTimeout(r, 400));

    const s = fileBrowser.selectedStructure;
    const vf = s?.volumetricFields;
    const f = vf?.fields?.[0];
    const iso = groups.isosurfaceGroup;
    const posCount = iso?.meshes?.positive?.geometry?.attributes?.position?.count ?? 0;

    let valuesMatch = false;
    if (f?.values) {
      const idxs = [0, 137, 4000, 7999];
      valuesMatch = idxs.every((ix) => Math.abs(f.values[ix] - savedDecoded[ix]) < 1e-6);
    }

    const settings = getIsosurfaceMaterialSettings();
    const panelEl = document.querySelector('[data-panel-id="field"]');

    return {
      fieldCount: vf?.fields?.length ?? 0,
      label: f?.label, nx: f?.nx, ny: f?.ny, nz: f?.nz,
      valuesMatch, posCount,
      settings,
      fieldMaterial: s?.fieldMaterial,
      fieldPanelPresent: !!panelEl,
      fieldPanelAvailable: !!panelEl && !panelEl.classList.contains('cv-unavailable'),
      inScene: !!iso?.parent,
    };
  });

  H.check('applySharedState restores volumetricFields (count, label, dims)',
    rt.fieldCount === 1 && rt.label === 'TestBlob' && rt.nx === 20 && rt.ny === 20 && rt.nz === 20,
    JSON.stringify(rt));
  H.check('restored field values match the saved samples',
    rt.valuesMatch === true, JSON.stringify({ valuesMatch: rt.valuesMatch }));
  H.check('restored isosurface exists with vertices > 0 at the saved isoValue',
    rt.posCount > 0 && rt.inScene === true, JSON.stringify({ posCount: rt.posCount, inScene: rt.inScene }));
  H.check('restored iso colors + opacity match the saved isoSettings',
    rt.settings?.positiveColor === '#112277' && rt.settings?.negativeColor === '#aa3311'
      && Math.abs(rt.settings?.opacity - 0.42) < 1e-9,
    JSON.stringify(rt.settings));
  H.check('restored structure.fieldMaterial round-trips (metal, roughness 0.25)',
    rt.fieldMaterial?.type === 'metal' && Math.abs(rt.fieldMaterial?.roughness - 0.25) < 1e-9,
    JSON.stringify(rt.fieldMaterial));
  H.check('the Field window is available after restore',
    rt.fieldPanelPresent === true && rt.fieldPanelAvailable === true,
    JSON.stringify({ present: rt.fieldPanelPresent, available: rt.fieldPanelAvailable }));

  // --- (4a) Restore of a raster ('forward') pipeline while in raytrace -------------
  // The harness pre-seeds hideRaytraceWarning=true, so this switches immediately.
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(400);
  const staleFix = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const { clearField } = await import('./render/index.js');
    clearField(); // drop the field before a fields-free forward restore
    const state = captureState();
    state.style.renderPipeline = 'forward';
    applySharedState(state, 'forward.crysviz');
    await new Promise((r) => setTimeout(r, 300));
    const rtBlock = document.getElementById('rtControlsBlock');
    const styleSel = document.getElementById('renderStyleMenu');
    const styleRow = styleSel?.closest('.control-row');
    return {
      pipeline: general.renderPipeline,
      rtBlockHidden: rtBlock ? getComputedStyle(rtBlock).display === 'none' : null,
      tracerClass: document.body.classList.contains('tracer-pipeline'),
      renderStyleVisible: styleRow ? getComputedStyle(styleRow).display !== 'none' : null,
    };
  });
  H.check('restoring a forward state while in raytrace un-stales the rendering controls',
    staleFix.pipeline === 'forward' && staleFix.rtBlockHidden === true
      && staleFix.tracerClass === false && staleFix.renderStyleVisible === true,
    JSON.stringify(staleFix));

  // --- (4b) No suppression leak: restore depthpeel, then a genuine raytrace switch --
  // Clear the pref so a real raster->tracer switch WOULD warn; the old code leaked
  // a one-shot on the depthpeel restore and swallowed this warning.
  await page.evaluate(async () => {
    const { setPanelPref } = await import('./ui/panels/PanelManager.js');
    setPanelPref('hideRaytraceWarning', false);
    const toggle = document.getElementById('disableRaytraceWarningToggle');
    if (toggle) toggle.checked = false;
  });
  await page.evaluate(async () => {
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const state = captureState();
    state.style.renderPipeline = 'depthpeel';
    applySharedState(state, 'depthpeel.crysviz');
    await new Promise((r) => setTimeout(r, 300));
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(400);
  const modalShown = await page.evaluate(() =>
    document.getElementById('raytraceWarningModal')?.hidden === false);
  H.check('after a depthpeel restore, a genuine raytrace switch still shows the warning (no leak)',
    modalShown === true, JSON.stringify({ modalShown }));

  // Dismiss (Cancel) and restore the pref for teardown.
  await H.clickById(page, 'raytraceWarningCancel');
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const { setPanelPref } = await import('./ui/panels/PanelManager.js');
    setPanelPref('hideRaytraceWarning', true);
  });
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
