// First-run ray/path-tracing performance-warning modal (ui/RaytraceWarningModal.js).
//
// Deterministic single-page flow (order matters for the one-shot suppression
// and the persisted pref):
//   (0) suppressRaytraceWarningOnce() BEFORE any modal has shown -> the next
//       tracer enable is silently consumed (models the ShareModule restore).
//   (1) enabling a tracer again shows the modal, and the pipeline ALSO switches
//       (the warning is non-blocking). Ok closes it.
//   (2) tracer->tracer switches do not re-warn, but leaving to a raster mode
//       and flipping back into a tracer shows the warning again.
//   (3) showRaytraceWarning() + tick "Don't show again" + Ok -> pref persisted
//       and the Settings-window toggle reflects it.
//   (4) unchecking the Settings toggle clears the pref, so the next tracer
//       enable shows the modal again.
'use strict';
const H = require('../harness');

const visible = (page) => page.evaluate(() =>
  document.getElementById('raytraceWarningModal')?.hidden === false);
const pipelineId = (page) => page.evaluate(async () => {
  const { general } = await import('./state/store.js');
  return general.renderPipeline;
});

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

  // --- (0) One-shot suppression consumed by the next tracer enable ---------------
  await page.evaluate(async () => {
    const { suppressRaytraceWarningOnce } = await import('./ui/RaytraceWarningModal.js');
    suppressRaytraceWarningOnce();
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('suppressRaytraceWarningOnce() swallows the next tracer enable (modal hidden)',
    (await visible(page)) === false);
  H.check('...but the pipeline still switched to raytrace', (await pipelineId(page)) === 'raytrace');

  // --- (1) Fresh enable now shows the modal AND switches the pipeline -------------
  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('first (non-suppressed) tracer enable shows the modal', (await visible(page)) === true);
  H.check('pipeline switched to raytrace alongside the modal (non-blocking)',
    (await pipelineId(page)) === 'raytrace');
  await H.clickById(page, 'raytraceWarningOk');
  await page.waitForTimeout(150);
  H.check('Ok closes the modal', (await visible(page)) === false);

  // --- (2) Tracer -> tracer does not re-warn; leaving and re-entering does -------
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace'); // raytrace -> pathtrace
  await page.waitForTimeout(300);
  H.check('switching between the two tracers does NOT re-show the modal',
    (await visible(page)) === false);
  H.check('pathtrace pipeline active', (await pipelineId(page)) === 'pathtrace');
  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace'); // re-entry from raster
  await page.waitForTimeout(300);
  H.check('flipping back into a tracer (raster -> tracer) shows the modal again',
    (await visible(page)) === true);
  await H.clickById(page, 'raytraceWarningOk');
  await page.waitForTimeout(150);
  H.check('Ok closes the re-shown modal', (await visible(page)) === false);

  // --- (3) "Don't show again" persists the pref + syncs the Settings toggle ------
  const persisted = await page.evaluate(async () => {
    const { showRaytraceWarning } = await import('./ui/RaytraceWarningModal.js');
    const { getPanelPref } = await import('./ui/panels/PanelManager.js');
    showRaytraceWarning();
    const shown = document.getElementById('raytraceWarningModal')?.hidden === false;
    /** @type {HTMLInputElement} */
    (document.getElementById('raytraceWarningDontShow')).checked = true;
    document.getElementById('raytraceWarningOk').click();
    return {
      shown,
      hiddenAfter: document.getElementById('raytraceWarningModal')?.hidden === true,
      pref: getPanelPref('hideRaytraceWarning') === true,
      settingsChecked: /** @type {HTMLInputElement} */ (
        document.getElementById('disableRaytraceWarningToggle'))?.checked === true,
    };
  });
  H.check('showRaytraceWarning() shows the modal unconditionally', persisted.shown);
  H.check('"Don\'t show again" + Ok closes the modal', persisted.hiddenAfter);
  H.check('"Don\'t show again" persists hideRaytraceWarning=true', persisted.pref);
  H.check('...and syncs the Settings-window toggle to checked', persisted.settingsChecked);

  // --- (4) Unchecking the Settings toggle re-enables it this same session --------
  const reEnabled = await page.evaluate(async () => {
    const { getPanelPref } = await import('./ui/panels/PanelManager.js');
    const toggle = /** @type {HTMLInputElement} */ (
      document.getElementById('disableRaytraceWarningToggle'));
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    return { pref: getPanelPref('hideRaytraceWarning') };
  });
  H.check('unchecking the Settings toggle clears the pref', reEnabled.pref === false);
  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(300);
  H.check('re-enabled warning shows again on the next tracer enable',
    (await visible(page)) === true);
  await H.clickById(page, 'raytraceWarningOk');
  await page.waitForTimeout(150);

  // Restore a benign pipeline for teardown.
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
