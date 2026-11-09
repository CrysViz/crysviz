// The feature search's generated control list (docs/ui/search/controlIndex.js)
// must match what the windows actually contain: re-harvest it exactly the way
// `make search-index` does (searchIndexSetup.js) and compare. A failure lists
// the first differing entries — run `make search-index` and commit the file.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');
const { buildSearchIndex, renderIndexFile } = require('../searchIndexSetup');

const FILE = path.join(__dirname, '..', '..', '..', 'docs', 'ui', 'search', 'controlIndex.js');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const body = await buildSearchIndex(page);
  const fresh = renderIndexFile(body);
  const committed = fs.readFileSync(FILE, 'utf8');
  const a = committed.split('\n');
  const b = fresh.split('\n');
  const onlyCommitted = a.filter((l) => !b.includes(l)).slice(0, 8);
  const onlyFresh = b.filter((l) => !a.includes(l)).slice(0, 8);
  H.check('controlIndex.js is current (else: make search-index)', committed === fresh,
    committed === fresh ? `${b.length} lines`
      : `stale — removed: ${onlyCommitted.join(' | ') || '(order only)'} — added: ${onlyFresh.join(' | ') || '(order only)'}`);
  const unresolved = await page.evaluate(async () => (await import('./ui/FeatureSearch.js')).unresolvedConcepts());
  H.check('every search-vocabulary target exists (search/concepts.js)', unresolved.length === 0, JSON.stringify(unresolved));

  // Every vocabulary phrase must find its target — among the first three
  // results of a search for it; a phrase a closer match shadows should go or
  // point elsewhere. And each best bet's word leads with its targets, in order.
  const vocab = await page.evaluate(async () => {
    const fs = await import('./ui/FeatureSearch.js');
    const { CONCEPTS, BEST_BETS } = await import('./ui/search/concepts.js');
    fs.openFeatureSearch('');
    fs.closeFeatureSearch();
    const is = (e, to) => (to.structure ? e.type === 'structure' && e.key === to.structure
      : to.panel && to.label ? e.type === 'control' && e.panelId === to.panel && e.label === to.label
      : to.panel ? e.type === 'window' && e.panelId === to.panel
      : to.control ? e.type === 'control' && e.id === to.control
        : e.type === 'action' && e.label === to.action);
    const misses = [];
    let phrases = 0;
    for (const c of CONCEPTS) {
      for (const phrase of c.phrases) {
        phrases += 1;
        const top = fs.searchEntries(phrase).slice(0, 3);
        if (!top.some((r) => is(r.entry, c.to))) misses.push(`"${phrase}" -> ${top.map((r) => r.entry.label).join(', ')}`);
      }
    }
    const betMisses = [];
    for (const bet of BEST_BETS) {
      // Targets that exist now (the structure's colour dots come and go).
      const all = fs.searchEntries(bet.words[0]);
      const present = bet.targets.filter((to) => all.some((r) => is(r.entry, to)));
      const lead = all.slice(0, present.length);
      if (!present.length || !present.every((to, i) => is(lead[i].entry, to))) {
        betMisses.push(`"${bet.words[0]}" -> ${lead.map((r) => r.entry.label).join(', ')}`);
      }
    }
    return { phrases, misses, betMisses };
  });
  H.check(`every vocabulary phrase finds its target in the top three (${vocab.phrases} phrases)`,
    vocab.misses.length === 0, `${vocab.misses.length} misses: ${vocab.misses.join(' | ')}`);
  H.check('each best bet leads with its targets, in order', vocab.betMisses.length === 0, vocab.betMisses.join(' | '));
  H.check('index covers the essential windows',
    ['features', 'visual', 'cell'].every((id) => body.includes(`"panel":"${id}"`)));
  // The harvest itself must not trip anything (failed network fetches of
  // optional CDN assets are environment noise, not app errors).
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
