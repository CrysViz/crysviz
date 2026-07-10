// AddonAPI ↔ file browser interaction (docs/ui/AddonAPI.js): an addon can list
// the loaded structures, select one programmatically (same as a user clicking
// its row), and subscribe to active-structure changes. Covers the plumbing an
// addon like EOS would use for "click a point → show that structure".
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page);

  // Build an API and wire a structure-change spy on window.
  const listed = await page.evaluate(async () => {
    const { createAddonAPI } = await import('./ui/AddonAPI.js');
    const api = createAddonAPI();
    window.__api = api;
    window.__sc = [];
    api.onStructureChange((s) => window.__sc.push(!!s));
    return api.getStructures();
  });
  H.check('getStructures lists the loaded structure', Array.isArray(listed) && listed.length >= 1,
    JSON.stringify(listed));
  H.check('entry has index + frame count', listed[0] && listed[0].index === 0 && listed[0].frames >= 1,
    JSON.stringify(listed[0]));

  // Programmatic selection drives the active structure + fires the change.
  const sel = await page.evaluate(() => {
    const ok = window.__api.selectStructure(0, 0);
    return { ok, hasStructure: !!window.__api.getStructure(), changes: window.__sc.length };
  });
  H.check('selectStructure(0,0) succeeds', sel.ok === true);
  H.check('active structure present after select', sel.hasStructure);
  H.check('onStructureChange fired on select', sel.changes >= 1, String(sel.changes));

  // Out-of-range selection is a no-op that reports false.
  const bad = await page.evaluate(() => window.__api.selectStructure(99, 0));
  H.check('selectStructure out of range returns false', bad === false);

  // dispose() drops the subscription — later selections no longer notify.
  const afterDispose = await page.evaluate(() => {
    const before = window.__sc.length;
    window.__api.dispose();
    window.__api.selectStructure(0, 0);
    return { before, after: window.__sc.length };
  });
  H.check('dispose() stops further notifications',
    afterDispose.after === afterDispose.before,
    `${afterDispose.before} -> ${afterDispose.after}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
