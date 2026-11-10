// Regenerate docs/ui/search/controlIndex.js — the feature search's full
// control list. Run via `make search-index` (tools/browsertest/run.sh serves
// the app and provides the browser). See searchIndexSetup.js.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { buildSearchIndex, renderIndexFile } = require('./searchIndexSetup');

const OUT = path.join(__dirname, '..', '..', 'docs', 'ui', 'search', 'controlIndex.js');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const body = await buildSearchIndex(page);
  fs.writeFileSync(OUT, renderIndexFile(body));
  console.log(`  wrote ${path.relative(process.cwd(), OUT)} (${body ? body.split('\n').length : 0} entries)`);
  if (errors.length) console.log(`  page errors during harvest:\n    ${errors.join('\n    ')}`);
  await browser.close();
})().catch(H.crash);
