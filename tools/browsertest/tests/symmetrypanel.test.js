// Symmetry panel (ui/BackendPanel/MoyoWASM.js + styles/symmetryPanel.css).
//
// Covers the card layout, the symdata Hall-symbol link, and — the part that
// actually encodes physics — the protostructure label: the number in front of
// a Wyckoff letter is how many DISTINCT orbits of that element sit on that
// letter (always written, including 1), NOT the site multiplicity.
'use strict';
const H = require('../harness');

async function openSymmetry(page) {
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.openPanel('symmetry');
  });
  await page.waitForTimeout(1500); // wasm init + rebuild of the panel body
}

async function runSym(page) {
  await H.clickById(page, 'getSymBtn');
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const box = document.getElementById('symResult');
    const link = box.querySelector('a.sym-link');
    const dd = [...box.querySelectorAll('dd')].map((d) => d.textContent.trim());
    return {
      hidden: box.hidden,
      symbol: box.querySelector('.sym-spg-symbol')?.textContent.trim(),
      number: box.querySelector('.sym-spg-number')?.textContent.trim(),
      href: link ? link.getAttribute('href') : null,
      target: link ? link.getAttribute('target') : null,
      hall: dd[0],
      pearson: dd[1],
      proto: box.querySelector('.sym-proto-value')?.textContent.trim(),
      status: document.getElementById('calcResult').textContent.trim(),
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await openSymmetry(page);

  // --- layout -----------------------------------------------------------
  const layout = await page.evaluate(() => {
    const body = document.getElementById('cvPanelBody-symmetry');
    const cards = [...body.querySelectorAll('.sym-card')];
    const centred = cards.every((c) => {
      const row = c.querySelector('.sym-row');
      if (!row) return false;
      const cr = c.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      // the control row's centre line sits on the card's centre line
      return Math.abs((cr.left + cr.right) / 2 - (rr.left + rr.right) / 2) <= 2;
    });
    return {
      cards: cards.length,
      titles: cards.map((c) => c.querySelector('.sym-card-title')?.textContent.trim()),
      centred,
      resultHidden: document.getElementById('symResult').hidden,
      // the old inline-styled markup is gone
      hasInlineStyledButtons: !!body.querySelector('#getSymBtn[style]'),
      ids: ['symTolInput', 'getSymBtn', 'getPrimBtn', 'getConvBtn', 'getWyckoffBtn', 'calcResult']
        .filter((id) => !document.getElementById(id)),
    };
  });

  H.check('panel is three centred cards (info / symmetrize / Wyckoff)',
    layout.cards === 3 && layout.centred, JSON.stringify(layout.titles));
  H.check('result block starts hidden', layout.resultHidden === true);
  H.check('all control ids still present', layout.ids.length === 0, layout.ids.join(','));

  // --- symmetry info + link ---------------------------------------------
  const r = await runSym(page);
  H.check('result block appears after Get Symmetry Info', r.hidden === false);
  H.check('space group shown with its ITA number',
    !!r.symbol && /^No\. \d+$/.test(r.number || ''), `${r.symbol} ${r.number}`);
  H.check('Hall symbol links to symdata for that Hall symbol',
    !!r.href && r.href.startsWith('https://symdata.anyterial.se/hall/')
      && r.href.includes('#wyckoff-positions') && r.target === '_blank', r.href);
  H.check('link slug is the lower-cased Hall symbol with "_" for spaces',
    !!r.hall && r.href.includes(`/hall/${encodeURIComponent(r.hall.toLowerCase().replace(/ /g, '_'))}/`),
    `${r.hall} -> ${r.href}`);
  H.check('Pearson symbol reported', /^[acmothrf][PABCIRF]\d+$/i.test(r.pearson || ''), r.pearson);

  // YBCO (default structure): Pmmm, 5 elements-worth of orbits.
  H.check('protostructure has anon_pearson_spg_wyckoffs:elements shape',
    /^[A-Z][A-Za-z0-9]*_[a-zA-Z]{2}\d+_\d+_[0-9a-zA-Z]+(_[0-9a-zA-Z]+)*:[A-Za-z]+(-[A-Za-z]+)*$/
      .test(r.proto || ''), r.proto);

  const parts = (r.proto || '').split(':');
  const wyckGroups = parts[0].split('_').slice(3);
  const elems = (parts[1] || '').split('-');
  H.check('one Wyckoff group per element, elements sorted alphabetically',
    wyckGroups.length === elems.length
      && JSON.stringify(elems) === JSON.stringify([...elems].sort()),
    r.proto);
  H.check('every Wyckoff letter carries an explicit orbit count (incl. 1)',
    wyckGroups.every((g) => /^(\d+[a-zA-Z])+$/.test(g)), wyckGroups.join(' '));

  // The counts must be orbit counts, not multiplicities: recompute from the
  // moyo dataset in-page and compare.
  const expected = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const moyo = await import('./external/moyo-test/moyo_wasm.js');
    const { PT_INVERTED } = await import('./ui/BackendPanel/MoyoWASM.js');
    const s = fileBrowser.selectedStructure;
    const vis = s.atoms.map((a, i) => (a.hidden ? -1 : i)).filter((i) => i !== -1);
    const elements = vis.map((i) => s.elements[i]);
    const struct = {
      positions: vis.map((i) => s.atoms[i].position),
      lattice: { basis: s.lattice.map((row) => [...row]).flat() },
      numbers: elements.map((e) => PT_INVERTED[e]),
    };
    const d = moyo.analyze_cell(JSON.stringify(struct), 0.01, 'Standard');
    const reps = [...new Set(d.orbits)];
    const byEl = {};
    for (const i of reps) (byEl[elements[i]] ||= []).push(d.wyckoffs[i]);
    const groups = Object.keys(byEl).sort().map((el) => {
      const c = {};
      for (const l of byEl[el]) c[l] = (c[l] || 0) + 1;
      return Object.keys(c).sort().map((l) => `${c[l]}${l}`).join('');
    });
    return {
      groups,
      elements: Object.keys(byEl).sort(),
      orbits: reps.length,
      atoms: elements.length,
      pearson: d.pearson_symbol,
      hall_number: d.hall_number,
    };
  });

  H.check('Wyckoff groups equal the per-element orbit counts from moyo',
    JSON.stringify(wyckGroups) === JSON.stringify(expected.groups),
    `${wyckGroups.join('_')} vs ${expected.groups.join('_')}`);
  H.check('orbit count is below the atom count (counts are orbits, not atoms)',
    expected.orbits < expected.atoms, `${expected.orbits} orbits / ${expected.atoms} atoms`);
  H.check('moyo exposes orbits + pearson_symbol + hall_number',
    !!expected.pearson && expected.hall_number > 0 && expected.hall_number <= 530,
    `${expected.pearson} hall#${expected.hall_number}`);

  // --- hall table -------------------------------------------------------
  const hall = await page.evaluate(async () => {
    const m = await import('./ui/BackendPanel/hallSymbols.js');
    return {
      n: m.HALL_SYMBOLS.length,
      first: m.HALL_SYMBOLS[0][0],
      last: m.HALL_SYMBOLS[529][0],
      slugQuote: m.hallSlug('P 3 2"'),
      slugStar: m.hallSlug('-P 3* 2n'),
      entry61: m.hallEntry(61),
      allNonEmpty: m.HALL_SYMBOLS.every((r) => r[0] && r[1] >= 1 && r[1] <= 230),
    };
  });
  H.check('530 Hall symbols, all with a valid ITA number',
    hall.n === 530 && hall.allNonEmpty, `${hall.n} entries`);
  H.check('Hall slugs encode the odd characters',
    hall.slugQuote === 'p_3_2%22' && hall.slugStar === '-p_3*_2n',
    `${hall.slugQuote} ${hall.slugStar}`);

  // --- symmetrize + Wyckoff editor still work ---------------------------
  await H.clickById(page, 'getConvBtn');
  await page.waitForTimeout(1500);
  const afterConv = await page.evaluate(async () => {
    const { structureShip, fileBrowser } = await import('./state/store.js');
    return {
      containers: structureShip.container.length,
      name: fileBrowser.fileData[fileBrowser.fileData.length - 1]?.name,
      resultShown: !document.getElementById('symResult')?.hidden,
    };
  });
  H.check('Conv. Cell adds a symmetrised structure and keeps the result shown',
    afterConv.containers >= 2 && /^conv_sym_/.test(afterConv.name || '') && afterConv.resultShown,
    afterConv.name);

  await openSymmetry(page); // panel rebuilt for the new structure
  await H.clickById(page, 'getWyckoffBtn');
  await page.waitForTimeout(2500);
  const wyck = await page.evaluate(() => ({
    label: document.getElementById('getWyckoffBtn').textContent.trim(),
    status: document.getElementById('calcResult').textContent.trim(),
    resultShown: !document.getElementById('symResult').hidden,
  }));
  H.check('Wyckoff editor toggles on, status + result both shown',
    wyck.label === 'Disable Wyckoff Editor' && wyck.status === 'Wyckoff editor active'
      && wyck.resultShown, `${wyck.label} / ${wyck.status}`);

  const panelEl = await page.$('.cv-panel[data-panel-id="symmetry"]');
  if (panelEl) {
    await panelEl.screenshot({
      path: require('path').join(__dirname, '..', 'artifacts', 'symmetrypanel-ui.png'),
    });
  }

  H.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
