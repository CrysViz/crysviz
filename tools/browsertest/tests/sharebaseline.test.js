// Guards the frozen settings baseline of compact share links
// (docs/io/share/shareBaselines.js). A compact link only carries settings that
// differ from the baseline it names, so the baseline must equal what a freshly
// booted app captures. When an app default changes this test fails: do NOT
// edit baseline 1 (old links would change) — add baseline 2 with the new
// values and bump LATEST_BASELINE_ID, then regenerate the unit-test fixtures
// with tools/browsertest/run.sh gen_share_fixtures.js.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const result = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const { BASELINES, LATEST_BASELINE_ID, SETTING_KEYS, STRUCTURE_DERIVED_KEYS } = await import('./io/share/shareBaselines.js');
    const state = captureState();
    const base = BASELINES[LATEST_BASELINE_ID];
    const known = new Set([...SETTING_KEYS.map(([p]) => p), ...STRUCTURE_DERIVED_KEYS]);
    const round = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v);
    const norm = (v) => JSON.stringify(v, (_, x) => round(x));
    const drift = [];
    const unknown = [];
    for (const sect of ['colors', 'display', 'style']) {
      for (const [key, value] of Object.entries(state[sect])) {
        const path = `${sect}.${key}`;
        if (!known.has(path)) unknown.push(path);
        if (value === undefined || STRUCTURE_DERIVED_KEYS.includes(path)) continue;
        if (norm(value) !== norm(base[sect][key])) drift.push(`${path}: app ${norm(value)} vs baseline ${norm(base[sect][key])}`);
      }
    }
    return { drift, unknown };
  });

  H.check('fresh boot settings equal the latest share baseline', result.drift.length === 0, result.drift.join('; '));
  H.check('every captured setting has a short key or is structure-derived', result.unknown.length === 0, result.unknown.join(', '));
  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
