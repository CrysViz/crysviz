// Database reference links (issue #144, phase 5). A structure fetched from
// Alexandria and left unchanged is shared by reference: the link names the
// entry instead of carrying coordinates, and opening it fetches the entry.
// An edited structure embeds its coordinates; a supercell of the entry shares
// the reference plus multipliers; a changed entry warns; a crafted link that
// names a host outside the allowlist is refused without contacting it.
// The Alexandria API is served by page.route, so no network is needed.
'use strict';
const H = require('../harness');

const ID = 'agm000000123';
const entry = (shift = 0) => ({
  data: [{
    id: ID, type: 'structures',
    attributes: {
      chemical_formula_descriptive: 'NaCl',
      lattice_vectors: [[5.64, 0, 0], [0, 5.64, 0], [0, 0, 5.64]],
      species: [{ name: 'Na', chemical_symbols: ['Na'], concentration: [1] },
        { name: 'Cl', chemical_symbols: ['Cl'], concentration: [1] }],
      species_at_sites: ['Na', 'Na', 'Na', 'Na', 'Cl', 'Cl', 'Cl', 'Cl'],
      cartesian_site_positions: [[shift, 0, 0], [0, 2.82, 2.82], [2.82, 0, 2.82], [2.82, 2.82, 0],
        [2.82, 0, 0], [0, 2.82, 0], [0, 0, 2.82], [2.82, 2.82, 2.82]],
    },
  }],
});

(async () => {
  const { browser, page, errors } = await H.launchApp();
  let served = entry(0);
  let requests = 0;
  const foreign = [];
  await page.route('https://alexandria.icams.rub.de/**', (route) => {
    requests++;
    route.fulfill({ status: 200, contentType: 'application/vnd.api+json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(served) });
  });
  await page.route('https://evil.example/**', (route) => { foreign.push(route.request().url()); route.abort(); });

  // Decode a link's compact payload in the page (for asserting its shape).
  const payloadOf = (link) => page.evaluate(async (url) => {
    const env = await import('./io/share/shareEnvelope.js');
    const b = env.b64URLToBytes(url.slice(url.indexOf('#z=') + 3));
    const opened = await env.openEnvelope(b, { requestPassword: async () => null });
    return JSON.parse(new TextDecoder().decode(opened.json));
  }, link);
  const share = () => page.evaluate(async () => {
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    const note = document.getElementById('shareLinkLengthNote')?.textContent ?? '';
    document.getElementById('shareLinkClose').click();
    return { url, note };
  });
  const pasteId = async () => {
    await page.click('#pasteTextButton');
    await page.fill('#structureText', ID);
    await page.click('#loadTextButton');
    await H.waitFor(page, async () => {
      const { structureShip } = await import('./state/store.js');
      return !!structureShip.container.at(-1)?.provenance;
    }, { timeout: 20000, interval: 300 });
    await page.waitForTimeout(1000);
  };
  const openLink = async (url) => {
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'load' });
    return H.waitFor(page, async () => {
      const { general, fileBrowser } = await import('./state/store.js');
      return general.sharedStructureLoaded ? {
        n: fileBrowser.selectedStructure.atoms.length,
        elements: [...new Set(fileBrowser.selectedStructure.elements)].sort().join(','),
        status: document.getElementById('status')?.textContent ?? '',
      } : null;
    }, { timeout: 40000, interval: 500 });
  };

  // 1. Unchanged database structure -> reference link.
  await pasteId();
  const plain = await share();
  const p1 = await payloadOf(plain.url);
  console.log(`  [info] reference link ${plain.url.length} chars`);
  H.check('unchanged database structure is shared by reference',
    p1.r?.a === ID && !p1.s?.p, JSON.stringify({ r: p1.r, s: p1.s }));
  H.check('reference link is short', plain.url.length <= 300, `${plain.url.length} chars`);
  H.check('dialog says where the structure loads from', /loads from Alexandria/.test(plain.note), plain.note);

  // 2. Opening it fetches the entry.
  const before = requests;
  const opened = await openLink(plain.url);
  H.check('opening the reference link fetches and shows the structure',
    opened && opened.n === 8 && opened.elements === 'Cl,Na' && requests > before, JSON.stringify(opened));

  // 3. Edited structure -> coordinates embedded.
  await pasteId();
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    // Assign, don't mutate: Atom.position hands out a copy.
    const atom = fileBrowser.selectedStructure.atoms[0];
    const p = atom.position;
    atom.position = [p[0] + 0.05, p[1], p[2]];
  });
  const edited = await payloadOf((await share()).url);
  H.check('an edited structure embeds its coordinates', !edited.r && Array.isArray(edited.s?.p), JSON.stringify(Object.keys(edited)));

  // 4. Supercell of the entry -> reference + multipliers.
  await pasteId();
  await page.evaluate(async () => { (await import('./ui/SuperCellModule.js')).createSupercell(2, 2, 2); });
  await page.waitForTimeout(1000);
  const superLink = (await share()).url;
  const sp = await payloadOf(superLink);
  H.check('a supercell of the entry shares reference + multipliers',
    sp.r?.a === ID && JSON.stringify(sp.s?.x) === '[2,2,2]' && !sp.s?.p, JSON.stringify({ r: sp.r, s: sp.s }));
  const superOpened = await openLink(superLink);
  H.check('the supercell reference link opens as the 2x2x2 supercell', superOpened?.n === 64, JSON.stringify(superOpened));

  // 5. Changed database entry -> warning.
  served = entry(0.3);
  const warnings = [];
  const onConsole = (m) => { if (m.type() === 'warning') warnings.push(m.text()); };
  page.on('console', onConsole);
  const changed = await openLink(plain.url);
  page.off('console', onConsole);
  H.check('a changed database entry still opens, with a warning',
    changed?.n === 8 && (/entry changed/.test(changed.status) || warnings.some((w) => /entry changed/.test(w))),
    JSON.stringify({ changed, warnings: warnings.slice(-3) }));

  // 6. Crafted link naming a host outside the allowlist -> refused, never contacted.
  const refused = await page.evaluate(async (url) => {
    const env = await import('./io/share/shareEnvelope.js');
    const b = env.b64URLToBytes(url.slice(url.indexOf('#z=') + 3));
    const opened = await env.openEnvelope(b, { requestPassword: async () => null });
    const obj = JSON.parse(new TextDecoder().decode(opened.json));
    obj.r = { u: 'https://evil.example/v1/structures/x', k: obj.r.k };
    const sealed = await env.sealEnvelope(new TextEncoder().encode(JSON.stringify(obj)), { codec: env.CODEC_COMPACT_V3 });
    const { openShareLink } = await import('./ui/ShareModule.js');
    try { await openShareLink(`https://crysviz.org/#z=${env.bytesToB64URL(sealed)}`); return 'opened'; }
    catch (e) { return String(e.message); }
  }, plain.url);
  H.check('a non-allowlisted host is refused', /does not load share links from/.test(refused), refused);
  H.check('the non-allowlisted host is never contacted', foreign.length === 0, foreign.join(' '));

  // The refused link logs its decode failure on purpose.
  const unexpected = errors.filter((e) => !/Failed to decode shared state/.test(e));
  H.check('no unexpected page errors', unexpected.length === 0, unexpected.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
