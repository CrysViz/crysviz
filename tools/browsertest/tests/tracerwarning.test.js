// First-run ray/path-tracing performance-warning modal (ui/RaytraceWarningModal.js).
//
// The modal is a CONFIRM gate that DEFERS the pipeline switch: while it is open
// the prior raster pipeline keeps rendering (responsive GUI). Deterministic flow:
//   (0) suppressRaytraceWarningOnce() BEFORE any modal has shown -> the next
//       tracer enable is silently consumed AND switches immediately (ShareModule
//       session-restore path).
//   (a) a fresh raster->tracer switch SHOWS the modal and does NOT switch yet
//       (general.renderPipeline + app.pipeline.id still the prior raster id).
//   (b) Ok -> the pipeline switches to the tracer.
//   (c) leaving to a raster mode and flipping back re-shows the modal; Cancel
//       keeps the raster pipeline AND reverts the dropdown select.
//   (d) Escape and backdrop-click behave as Cancel.
//   (e) "Don't show again" + Cancel persists the pref and does NOT switch; the
//       next tracer selection then switches immediately with no modal.
//   (g) unchecking the Settings toggle clears the pref, so the next tracer
//       enable shows the modal again.
'use strict';
const H = require('../harness');

const visible = (page) => page.evaluate(() =>
  document.getElementById('raytraceWarningModal')?.hidden === false);
const pipelineId = (page) => page.evaluate(async () => {
  const { general } = await import('./state/store.js');
  return general.renderPipeline;
});
const activePipelineId = (page) => page.evaluate(async () => {
  const { app } = await import('./state/store.js');
  return app.pipeline?.id;
});
const selectValue = (page) => page.evaluate(() =>
  /** @type {HTMLSelectElement|null} */ (
    document.getElementById('renderPipelineMenu'))?.value);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // The harness pre-seeds hideRaytraceWarning=true (so other tests' page
  // screenshots aren't dimmed by the modal backdrop) — this test IS about the
  // modal, so clear the pref first and sync the Settings toggle.
  await page.evaluate(async () => {
    const { setPanelPref } = await import('./ui/panels/PanelManager.js');
    setPanelPref('hideRaytraceWarning', false);
    const toggle = /** @type {HTMLInputElement|null} */ (
      document.getElementById('disableRaytraceWarningToggle'));
    if (toggle) toggle.checked = false;
  });

  // The settings panel is persistent — its toggle exists once panels register.
  const hasSettingsToggle = await page.evaluate(() =>
    !!document.getElementById('disableRaytraceWarningToggle'));
  H.check('Settings window hosts the raytracing-warning toggle', hasSettingsToggle);

  // --- (0)/(f) One-shot suppression: swallowed AND switches immediately ----------
  await page.evaluate(async () => {
    const { suppressRaytraceWarningOnce } = await import('./ui/RaytraceWarningModal.js');
    suppressRaytraceWarningOnce();
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('suppressRaytraceWarningOnce() swallows the next tracer enable (modal hidden)',
    (await visible(page)) === false);
  H.check('...and the pipeline switched immediately to raytrace',
    (await pipelineId(page)) === 'raytrace');

  // --- (a) Fresh raster->tracer SHOWS the modal but DEFERS the switch ------------
  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await page.waitForTimeout(150);
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('fresh (non-suppressed) tracer enable shows the modal', (await visible(page)) === true);
  H.check('...and the pipeline has NOT switched yet (general.renderPipeline still forward)',
    (await pipelineId(page)) === 'forward');
  H.check('...and app.pipeline is still the forward instance',
    (await activePipelineId(page)) === 'forward');

  // --- (b) Ok performs the deferred switch --------------------------------------
  await H.clickById(page, 'raytraceWarningOk');
  await page.waitForTimeout(200);
  H.check('Ok closes the modal', (await visible(page)) === false);
  H.check('Ok performs the deferred switch to raytrace', (await pipelineId(page)) === 'raytrace');
  H.check('...and app.pipeline is now the raytrace instance',
    (await activePipelineId(page)) === 'raytrace');

  // --- (c) Re-enter from raster, then Cancel keeps forward + reverts the select --
  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await page.waitForTimeout(150);
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  await page.waitForTimeout(300);
  H.check('re-entry (raster -> tracer) shows the modal again', (await visible(page)) === true);
  H.check('select shows the tentative tracer value while the modal is open',
    (await selectValue(page)) === 'pathtrace');
  await H.clickById(page, 'raytraceWarningCancel');
  await page.waitForTimeout(200);
  H.check('Cancel closes the modal', (await visible(page)) === false);
  H.check('Cancel does NOT switch (pipeline stays forward)', (await pipelineId(page)) === 'forward');
  H.check('Cancel reverts the dropdown select to forward', (await selectValue(page)) === 'forward');

  // --- (d) Escape behaves as Cancel ---------------------------------------------
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('modal shown before Escape', (await visible(page)) === true);
  await page.evaluate(() => {
    document.getElementById('raytraceWarningModal')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.waitForTimeout(200);
  H.check('Escape acts as Cancel (modal hidden)', (await visible(page)) === false);
  H.check('Escape acts as Cancel (pipeline stays forward)', (await pipelineId(page)) === 'forward');
  H.check('Escape reverts the dropdown select to forward', (await selectValue(page)) === 'forward');

  // --- (d) Backdrop-click behaves as Cancel -------------------------------------
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('modal shown before backdrop click', (await visible(page)) === true);
  await page.evaluate(() => {
    const m = document.getElementById('raytraceWarningModal');
    // The modal root IS the backdrop; dispatch a click whose target is the root.
    m?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  H.check('backdrop click acts as Cancel (modal hidden)', (await visible(page)) === false);
  H.check('backdrop click acts as Cancel (pipeline stays forward)',
    (await pipelineId(page)) === 'forward');

  // --- (e) "Don't show again" + Cancel persists the pref and does NOT switch -----
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('modal shown before "Don\'t show again" + Cancel', (await visible(page)) === true);
  const afterDontShowCancel = await page.evaluate(async () => {
    const { getPanelPref } = await import('./ui/panels/PanelManager.js');
    /** @type {HTMLInputElement} */
    (document.getElementById('raytraceWarningDontShow')).checked = true;
    document.getElementById('raytraceWarningCancel').click();
    return {
      hiddenAfter: document.getElementById('raytraceWarningModal')?.hidden === true,
      pref: getPanelPref('hideRaytraceWarning') === true,
      settingsChecked: /** @type {HTMLInputElement} */ (
        document.getElementById('disableRaytraceWarningToggle'))?.checked === true,
    };
  });
  H.check('"Don\'t show again" + Cancel closes the modal', afterDontShowCancel.hiddenAfter);
  H.check('"Don\'t show again" persists on Cancel too', afterDontShowCancel.pref);
  H.check('...and syncs the Settings-window toggle to checked', afterDontShowCancel.settingsChecked);
  H.check('Cancel with "Don\'t show again" did NOT switch (still forward)',
    (await pipelineId(page)) === 'forward');
  // Next tracer selection now switches immediately with no modal.
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('with the pref set, the next tracer enable shows NO modal',
    (await visible(page)) === false);
  H.check('...and switches immediately to raytrace', (await pipelineId(page)) === 'raytrace');

  // --- (g) Unchecking the Settings toggle re-enables it this same session --------
  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await page.waitForTimeout(150);
  const reEnabled = await page.evaluate(async () => {
    const { getPanelPref } = await import('./ui/panels/PanelManager.js');
    const toggle = /** @type {HTMLInputElement} */ (
      document.getElementById('disableRaytraceWarningToggle'));
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    return { pref: getPanelPref('hideRaytraceWarning') };
  });
  H.check('unchecking the Settings toggle clears the pref', reEnabled.pref === false);
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('re-enabled warning shows again on the next tracer enable',
    (await visible(page)) === true);
  await H.clickById(page, 'raytraceWarningOk');
  await page.waitForTimeout(200);

  // Restore a benign pipeline for teardown.
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
