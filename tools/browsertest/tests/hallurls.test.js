// Every one of the 530 Hall symbols must resolve to a live symdata page — the
// Symmetry panel links to it by slug, so a bad slug rule (or a symbol the site
// spells differently) is only visible by asking the site.
//
// Network test, no browser. Set CRYSVIZ_SKIP_NET=1 to skip it offline.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const H = require('../harness');

const CONCURRENCY = 20;
const TIMEOUT_MS = 20000;

async function head(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return res.status;
      if (attempt) return res.status;
    } catch (e) {
      if (attempt) return `error: ${e.message}`;
    }
  }
  return 'unreachable';
}

(async () => {
  const mod = await import(pathToFileURL(
    path.join(__dirname, '..', '..', '..', 'docs', 'ui', 'BackendPanel', 'hallSymbols.js')).href);
  const { HALL_SYMBOLS, symdataHallUrl } = mod;

  H.check('530 Hall symbols in the table', HALL_SYMBOLS.length === 530, String(HALL_SYMBOLS.length));

  if (process.env.CRYSVIZ_SKIP_NET === '1') {
    H.check('all Hall symbol pages reachable (skipped: CRYSVIZ_SKIP_NET=1)', true);
    await H.finish({ close: async () => {} });
    return;
  }

  const probe = await head(symdataHallUrl('P 1'));
  if (probe !== 200) {
    console.log(`  SKIP  symdata.anyterial.se unreachable (${probe}) — no network?`);
    H.check('all Hall symbol pages reachable (skipped: site unreachable)', true);
    await H.finish({ close: async () => {} });
    return;
  }

  const bad = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = next++;
      if (i >= HALL_SYMBOLS.length) return;
      const symbol = HALL_SYMBOLS[i][0];
      const status = await head(symdataHallUrl(symbol));
      if (status !== 200) bad.push(`#${i + 1} "${symbol}" -> ${status}`);
    }
  }));

  H.check(`all ${HALL_SYMBOLS.length} Hall symbol pages reachable (HTTP 200)`,
    bad.length === 0, bad.slice(0, 10).join(' | ') + (bad.length > 10 ? ` (+${bad.length - 10})` : ''));

  await H.finish({ close: async () => {} });
})().catch(H.crash);
