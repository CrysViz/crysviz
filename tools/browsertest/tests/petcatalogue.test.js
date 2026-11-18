// PET models from any link (atomistic/petModels.js, ui/BackendPanel/
// PetModelList.js). A catalogue and its models are served from made-up hosts
// through Playwright routes, so nothing here depends on where models really
// live: a catalogue added through "from a link…" fills the model list, its
// relative and GitHub-page links resolve, bad entries are left out, a wrong
// checksum / a web page / a host that refuses cross-site downloads each get
// their own message, and the list survives a reload.
//
// The models are a tiny synthetic GGUF (header only), enough for every list
// and download check. With a real PET .gguf under docs/bench-models/
// (gitignored; MLIPBENCH_MODEL picks one) the models also load and evaluate,
// and the trained-elements note is checked.
//   tools/browsertest/run.sh tests/petcatalogue.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('../harness');

const MODEL_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'bench-models');
const PICK = process.env.MLIPBENCH_MODEL || 'pet-mad-xs.gguf';
const REAL = fs.existsSync(path.join(MODEL_DIR, PICK)) ? PICK : null;

/** A GGUF with metadata only: PET architecture, H/O/Ni/Cu, trained for Ni, Cu. */
function syntheticGGUF() {
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
  const str = (s) => { const b = Buffer.from(s, 'utf8'); u64(b.length); parts.push(b); };
  const kvString = (k, v) => { str(k); u32(8); str(v); };
  const kvInts = (k, values) => { str(k); u32(9); u32(5); u64(values.length); values.forEach((x) => { const b = Buffer.alloc(4); b.writeInt32LE(x); parts.push(b); }); };
  parts.push(Buffer.from('GGUF'));
  u32(3); u64(0); u64(5);
  kvString('general.architecture', 'pet-graph');
  kvString('general.name', 'synthetic XS');
  kvString('graph.json', '{"nodes": []}');
  kvInts('pet.species_map', [1, 0, 8, 1, 28, 2, 29, 3]);
  kvInts('pet.training_species', [28, 29]);
  return Buffer.concat(parts);
}

const MODEL_BYTES = REAL ? fs.readFileSync(path.join(MODEL_DIR, REAL)) : syntheticGGUF();
const MODEL_SHA = crypto.createHash('sha256').update(MODEL_BYTES).digest('hex');
const HOST = 'https://models.example.org/crysviz';
const CORS = { 'access-control-allow-origin': '*' };

const CATALOGUE = {
  name: 'Test fine-tunes',
  description: 'served from a made-up host',
  models: [
    { id: 'ybco', name: 'XS · YBCO', url: 'ybco.gguf', sha256: MODEL_SHA.toUpperCase(), size: MODEL_BYTES.length,
      base: 'PET-MAD-XS v1.5.0', method: 'full', elements: ['Y', 'Ba', 'Cu', 'O'], reference: 'PBEsol',
      license: 'BSD-3-Clause', citation: 'doi:10.0000/example' },
    { id: 'ni', name: 'XS · Ni', url: 'https://github.com/someone/pet-models/blob/main/ni.gguf', sha256: MODEL_SHA,
      elements: ['Ni'], reference: 'PBE' },
    { id: 'bad', name: 'wrong checksum', url: 'bad.gguf', sha256: '0'.repeat(64) },
    { id: 'page', name: 'a web page', url: 'page.gguf' },
    { id: 'blocked', name: 'no CORS', url: 'https://blocked.example.com/x.gguf' },
    { id: 'noname', url: 'noname.gguf' },
    { id: 'badsum', name: 'malformed checksum', url: 'y.gguf', sha256: 'xyz' },
  ],
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const ctx = page.context();
  const fulfilModel = (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: MODEL_BYTES });
  await ctx.route(`${HOST}/catalogue.json`, (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(CATALOGUE) }));
  await ctx.route(`${HOST}/ybco.gguf`, fulfilModel);
  await ctx.route(`${HOST}/bad.gguf`, fulfilModel);
  await ctx.route('https://raw.githubusercontent.com/someone/pet-models/main/**', fulfilModel);
  await ctx.route(`${HOST}/page.gguf`, (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/html' }, body: '<!DOCTYPE html><html><body>Download page</body></html>' }));
  await ctx.route('https://blocked.example.com/**', (route) => route.abort('failed'));
  await H.loadDefaultStructure(page); // YBCO: Y, Ba, Cu, O

  // --- the module on its own
  const unit = await page.evaluate(async ({ catalogue, host, gguf }) => {
    const m = await import('./atomistic/petModels.js');
    const links = {
      hf: m.directLink('https://huggingface.co/org/repo/blob/main/x.gguf'),
      gh: m.directLink('https://github.com/o/r/blob/v1/models/x.gguf'),
      gl: m.directLink('https://gitlab.com/g/p/-/blob/main/x.gguf'),
      dbx: m.directLink('https://www.dropbox.com/scl/fi/abc/x.gguf?rlkey=k&dl=0'),
      rel: m.directLink('x.gguf', 'https://h.example/dir/cat.json'),
    };
    let rejects = '';
    try { m.directLink('ftp://h.example/x.gguf'); } catch (e) { rejects = e.message; }
    const parsed = m.parsePetCatalogue(catalogue, `${host}/catalogue.json`);
    const kv = m.readGGUFMetadata(new Uint8Array(gguf).buffer);
    return {
      links, rejects,
      names: parsed.models.map((x) => x.name), warnings: parsed.warnings,
      first: parsed.models[0], second: parsed.models[1],
      info: m.describeGGUF(kv), graphSkipped: !kv.has('graph.json'),
      outside: m.elementsOutside(['Y', 'Ba', 'Cu', 'O', 'O'], ['Cu', 'O']),
    };
  }, { catalogue: CATALOGUE, host: HOST, gguf: [...syntheticGGUF()] });
  H.check('page links become file links (Hugging Face, GitHub, GitLab, Dropbox, relative)',
    unit.links.hf === 'https://huggingface.co/org/repo/resolve/main/x.gguf'
      && unit.links.gh === 'https://raw.githubusercontent.com/o/r/v1/models/x.gguf'
      && unit.links.gl === 'https://gitlab.com/g/p/-/raw/main/x.gguf'
      && new URL(unit.links.dbx).searchParams.get('dl') === '1'
      && unit.links.rel === 'https://h.example/dir/x.gguf'
      && /not an http/.test(unit.rejects), JSON.stringify(unit.links));
  H.check('a catalogue keeps its usable entries and says why the others are left out',
    unit.names.length === 5 && unit.warnings.length === 2
      && unit.warnings.some((w) => /no "name"/.test(w)) && unit.warnings.some((w) => /64 hex/.test(w))
      && unit.first.url === `${HOST}/ybco.gguf` && unit.first.sha256 === MODEL_SHA
      && unit.second.url === 'https://raw.githubusercontent.com/someone/pet-models/main/ni.gguf',
    JSON.stringify({ names: unit.names, warnings: unit.warnings }));
  H.check('GGUF metadata: name, species and trained elements, graph skipped',
    unit.info.architecture === 'pet-graph' && unit.info.name === 'synthetic XS'
      && unit.info.species.join() === 'H,O,Ni,Cu' && unit.info.elements.join() === 'Ni,Cu' && unit.graphSkipped,
    JSON.stringify(unit.info));
  H.check('elements outside a training set', unit.outside.join() === 'Y,Ba', JSON.stringify(unit.outside));

  // --- the panel
  const openControls = async () => page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    general.atomisticPotential = 'mlip';
    openPanel('backend');
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#BackendPotentialSelector [data-potential="mlip"]')?.click();
    await new Promise((r) => setTimeout(r, 100));
  });
  await openControls();
  const q = (role) => `#BackendPotentialSelector [data-role="${role}"]`;
  const status = () => page.$eval(q('mlip-status'), (el) => el.textContent);
  const waitStatus = async (re, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await status();
      if (re.test(s)) return s;
      await page.waitForTimeout(150);
    }
    return status();
  };
  const listState = () => page.evaluate((sel) => {
    const select = document.querySelector(sel);
    const groups = [...select.querySelectorAll('optgroup')].map((g) => ({ label: g.label, options: [...g.children].map((o) => o.textContent) }));
    return {
      value: select.value,
      selectedText: select.selectedOptions[0]?.textContent,
      groups,
      info: document.querySelector('#BackendPotentialSelector [data-role="mlip-model-info-text"]')?.textContent || '',
      forgetShown: !document.querySelector('#BackendPotentialSelector [data-role="mlip-forget"]').classList.contains('hidden'),
      linkRowShown: !document.querySelector('#BackendPotentialSelector [data-role="mlip-link-row"]').classList.contains('hidden'),
    };
  }, q('mlip-model'));
  const choose = (value) => page.$eval(q('mlip-model'), (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change'));
  }, value);
  const clearStatus = () => page.$eval(q('mlip-status'), (el) => { el.textContent = ''; });
  const load = async (re) => {
    await clearStatus();
    await page.click(q('mlip-load'));
    return waitStatus(re);
  };

  await choose('__link__');
  const before = await listState();
  H.check('"from a link…" opens the link box', before.linkRowShown, JSON.stringify(before));
  await page.fill(q('mlip-link'), `${HOST}/catalogue.json`);
  await clearStatus();
  await page.click(q('mlip-link-add'));
  const added = await waitStatus(/^Catalogue|^Link:/);
  const afterAdd = await listState();
  const group = afterAdd.groups.find((g) => g.label === 'Test fine-tunes');
  H.check('the catalogue from the link fills its own group in the model list',
    /^Catalogue "Test fine-tunes": 5 models added/.test(added) && /left out/.test(added)
      && group && group.options.length === 5 && afterAdd.value === `${HOST}/ybco.gguf` && !afterAdd.linkRowShown,
    JSON.stringify({ added, afterAdd }));
  H.check('the selected entry shows its training domain, reference, licence and catalogue',
    /trained for Y, Ba, Cu, O/.test(afterAdd.info) && /PBEsol/.test(afterAdd.info) && /BSD-3-Clause/.test(afterAdd.info)
      && /catalogue: Test fine-tunes/.test(afterAdd.info) && afterAdd.forgetShown, afterAdd.info);

  await choose(`${HOST}/bad.gguf`);
  const badSum = await load(/Load failed|ready/);
  H.check('a file whose checksum differs from the catalogue is refused', /checksum mismatch/.test(badSum), badSum);
  await choose(`${HOST}/page.gguf`);
  const pageMsg = await load(/Load failed|ready/);
  H.check('a web page instead of the file is refused with a hint', /is a web page/.test(pageMsg) && /downloads the file itself/.test(pageMsg), pageMsg);
  await choose('https://blocked.example.com/x.gguf');
  const blocked = await load(/Load failed|ready/);
  H.check('a host that refuses cross-site downloads is named, with CORS and local .gguf as ways out',
    /blocked\.example\.com/.test(blocked) && /CORS/.test(blocked) && /local \.gguf/.test(blocked), blocked);

  // A single model by link (a GitHub page link): listed under "Links".
  await choose('__link__');
  await page.fill(q('mlip-link'), 'https://github.com/someone/pet-models/blob/main/extra.gguf');
  await clearStatus();
  await page.click(q('mlip-link-add'));
  const linkMsg = await waitStatus(REAL ? /ready|Link:/ : /Link:|ready|Load failed/);
  const afterLink = await listState();
  const links = afterLink.groups.find((g) => g.label === 'Links');
  H.check('a model link (GitHub page) is listed under Links and selected',
    links && links.options.length === 1 && afterLink.value === 'https://raw.githubusercontent.com/someone/pet-models/main/extra.gguf',
    JSON.stringify({ linkMsg, afterLink }));
  if (REAL) H.check('the linked model loads', /^PET-MAD ready/.test(linkMsg), linkMsg);

  if (REAL) {
    await choose(`${HOST}/ybco.gguf`);
    const ready = await load(/ready|Load failed/);
    H.check('a catalogue model loads (checksum verified) with no note when the structure is inside its domain',
      /^PET-MAD ready: XS · YBCO/.test(ready) && !/outside/.test(ready), ready);
    const energy = await page.evaluate(async () => {
      const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
      const { buildNEPStructure } = await import('./atomistic/relaxer.js');
      const { fileBrowser } = await import('./state/store.js');
      const { runner } = await ensureCalculatorRunner(() => {});
      return (await runner.compute(buildNEPStructure(runner, fileBrowser.selectedStructure))).total_energy;
    });
    H.check('and evaluates', Number.isFinite(energy), String(energy));
    await choose('https://raw.githubusercontent.com/someone/pet-models/main/ni.gguf');
    const niReady = await load(/ready|Load failed/);
    H.check('a model trained for other elements loads with a note naming them',
      /^PET-MAD ready: XS · Ni/.test(niReady)
        && (niReady.match(/trained for Ni; (.*) are outside that/)?.[1] || '').split(', ').sort().join() === 'Ba,Cu,O,Y', niReady);
  } else {
    console.log('  (no real .gguf under docs/bench-models: load/evaluate checks skipped)');
  }

  // The list, its snapshot and the selection survive a reload.
  await choose('https://raw.githubusercontent.com/someone/pet-models/main/ni.gguf');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await openControls();
  const reloaded = await listState();
  H.check('after a reload the catalogue, the link and the selected model are still there',
    reloaded.groups.some((g) => g.label === 'Test fine-tunes' && g.options.length === 5)
      && reloaded.groups.some((g) => g.label === 'Links')
      && reloaded.value === 'https://raw.githubusercontent.com/someone/pet-models/main/ni.gguf',
    JSON.stringify(reloaded));

  await page.click(q('mlip-forget'));
  const forgotten = await listState();
  H.check('"forget" removes the whole catalogue and goes back to PET-MAD xs',
    !forgotten.groups.some((g) => g.label === 'Test fine-tunes') && forgotten.value === 'pet-mad-xs.gguf'
      && forgotten.groups.some((g) => g.label === 'Links'), JSON.stringify(forgotten));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_FAILED|Failed to load resource|Plotly|PET model catalogue not refreshed/.test(e));
  H.check('no unexpected console/page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
