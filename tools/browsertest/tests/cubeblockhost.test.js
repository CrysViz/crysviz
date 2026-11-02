// External `periodic` load option (DW-6.1, DW-6.3): host `load` command (data and
// inputUrl forms), the cancelled-load error, and `?cubePeriodic=` on `#load-file=` URLs.
'use strict';
const H = require('../harness');

const f = (v) => v.toFixed(6);
/** n=4 cube; `far` puts one atom well outside the grid box (=> suspect, dialog when no option). */
const cube = (far) => {
  const data = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    const row = [];
    for (let z = 0; z < 4; z++) row.push(((x + 2 * y + 3 * z) / 10).toExponential(5));
    data.push(row.join(' '));
  }
  return [
    'block', 'cubeblockhost test', `2 ${f(1)} ${f(1)} ${f(1)}`,
    `4 ${f(0.75)} ${f(0)} ${f(0)}`, `4 ${f(0)} ${f(0.75)} ${f(0)}`, `4 ${f(0)} ${f(0)} ${f(0.75)}`,
    `8 8.0 ${f(2)} ${f(2)} ${f(2)}`,
    far ? `1 1.0 ${f(9)} ${f(2)} ${f(-3)}` : `1 1.0 ${f(2.5)} ${f(2)} ${f(2)}`,
    ...data,
  ].join('\n');
};
const SUSPECT = cube(true);

// Runs in the page: start `start()`, wait, report whether the cube dialog is up, optionally click a button.
const PAGE_HELPERS = `(() => {
  window.__probe = async (start, click) => {
    const p = start();
    p.catch(() => {}); // rejections are reported by the later await, not as page errors
    await new Promise((r) => setTimeout(r, 400));
    const modal = document.getElementById('confirmModal');
    const shown = !!modal && !modal.hidden;
    if (shown && click) [...modal.querySelectorAll('button')].find((b) => b.textContent.includes(click))?.click();
    return { shown, res: await p };
  };
  window.__activeField = async () => {
    const { getActiveStructure } = await import('./state/structures.js');
    return getActiveStructure()?.volumetricFields?.fields?.[0]?.periodic;
  };
})()`;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(PAGE_HELPERS);
  const dispatchLoad = (args, click) => page.evaluate(async ({ args, click }) => {
    const { shown, res } = await window.__probe(() => window.crysvizHost.dispatch({ command: 'load', args }), click);
    return { shown, ok: res.ok, code: res.error?.code, message: res.error?.message, periodic: res.ok ? await window.__activeField() : undefined };
  }, { args, click });

  // --- DW-6.1 data form: literal booleans skip the dialog
  const t = await dispatchLoad({ name: 'a.cube', data: SUSPECT, periodic: true });
  H.check('DW-6.1 periodic:true loads without dialog as a periodic field', !t.shown && t.ok && t.periodic === true, JSON.stringify(t));
  const fl = await dispatchLoad({ name: 'b.cube', data: SUSPECT, periodic: false });
  H.check('DW-6.1 periodic:false loads without dialog as a block field', !fl.shown && fl.ok && fl.periodic === false, JSON.stringify(fl));
  const none = await dispatchLoad({ name: 'c.cube', data: SUSPECT }, 'Not periodic');
  H.check('DW-6.1 no option still asks (dialog shown)', none.shown && none.ok && none.periodic === false, JSON.stringify(none));

  // --- dirty: non-boolean values rejected with INVALID_ARGS, nothing loaded
  for (const bad of ['false', 'true', 0, 1, null, [], {}]) {
    const r = await dispatchLoad({ name: 'd.cube', data: SUSPECT, periodic: bad });
    H.check(`DW-6.1 periodic=${JSON.stringify(bad)} rejected`, !r.shown && r.ok === false && r.code === 'INVALID_ARGS', JSON.stringify(r));
  }

  // --- cancelled host load: clear error, not the generic "no structure"
  const cancel = await dispatchLoad({ name: 'e.cube', data: SUSPECT }, 'Cancel');
  H.check('cancelled load reports LOAD_CANCELLED',
    cancel.shown && cancel.ok === false && cancel.code === 'LOAD_CANCELLED' && !/no structure/.test(cancel.message), JSON.stringify(cancel));

  // --- DW-6.3 URL form
  const BASE = await page.evaluate(() => location.origin + location.pathname);
  const urlLoad = (search, click = null) => page.evaluate(async ({ search, b64, click }) => {
    const hash = `#load-file=${encodeURIComponent('u.cube')}|${encodeURIComponent(b64)}`;
    history.replaceState({}, document.title, `${location.pathname}${search}${hash}`);
    const { loadFromFilePath } = await import('./io/FileURLLoader.js');
    let threw = null;
    let probe = { shown: false, res: null };
    try { probe = await window.__probe(() => loadFromFilePath(), click); } catch (e) { threw = e.message; }
    return {
      shown: probe.shown, loaded: probe.res, threw, search: location.search, hash: location.hash.slice(0, 20),
      periodic: threw ? undefined : await window.__activeField(),
    };
  }, { search, b64: Buffer.from(SUSPECT).toString('base64'), click });

  const u1 = await urlLoad('?cubePeriodic=false&keep=1');
  H.check('DW-6.3 ?cubePeriodic=false skips the dialog and builds a block',
    !u1.shown && u1.loaded === true && u1.periodic === false, JSON.stringify(u1));
  H.check('cubePeriodic removed with the hash; other params kept', u1.search === '?keep=1' && u1.hash === '', JSON.stringify(u1));
  const u2 = await urlLoad('?cubePeriodic=true');
  H.check('?cubePeriodic=true loads periodic without dialog', !u2.shown && u2.loaded === true && u2.periodic === true && u2.search === '', JSON.stringify(u2));
  for (const bad of ['?cubePeriodic=maybe', '?cubePeriodic=', '?cubePeriodic=FALSE', '?cubePeriodic=false&cubePeriodic=true']) {
    const r = await urlLoad(bad);
    H.check(`unknown cubePeriodic ${bad} rejected before loading`, !r.shown && /cubePeriodic/.test(r.threw || ''), JSON.stringify(r));
  }
  const u3 = await urlLoad('', 'Cancel');
  H.check('no cubePeriodic: dialog still shown; cancel loads nothing and clears the hash',
    u3.shown === true && u3.loaded === 'cancelled' && u3.hash === '', JSON.stringify(u3));

  // --- startup path: a cancelled #load-file dialog is LOAD_CANCELLED; a genuine failure stays HASH_LOAD_FAILED
  const boot = await page.evaluate(async () => {
    const { bootstrapAuthoritative } = await import('./host/BrowserHost.js');
    history.replaceState({}, document.title, `${location.pathname}#load-file=x|y`);
    const run = async (loadHash) => {
      try { return { ok: true, res: await bootstrapAuthoritative({ host: null, launch: { present: false }, initialize: async () => ({ loadHash }) }) }; }
      catch (e) { return { ok: false, code: e.code, message: e.message }; }
    };
    const out = { cancelled: await run(async () => 'cancelled'), failed: await run(async () => false), loaded: await run(async () => true) };
    history.replaceState({}, document.title, location.pathname);
    return out;
  });
  H.check('startup: cancelled #load-file reports LOAD_CANCELLED',
    boot.cancelled.ok === false && boot.cancelled.code === 'LOAD_CANCELLED' && /cancelled by the user/.test(boot.cancelled.message), JSON.stringify(boot));
  H.check('startup: a genuine #load-file failure stays HASH_LOAD_FAILED', boot.failed.ok === false && boot.failed.code === 'HASH_LOAD_FAILED', JSON.stringify(boot));
  H.check('startup: a successful #load-file reports source hash', boot.loaded.ok === true && boot.loaded.res.source === 'hash', JSON.stringify(boot));

  // --- DW-6.3 full page load in widget mode (hash rewriting + search param cleanup)
  const widget = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await widget.goto(`${BASE}?widget=1&cubePeriodic=false#load-file=${encodeURIComponent('w.cube')}|${encodeURIComponent(Buffer.from(SUSPECT).toString('base64'))}`,
    { waitUntil: 'load', timeout: 90000 });
  const ws = await H.waitFor(widget, async () => {
    const { getActiveStructure } = await import('./state/structures.js');
    const s = getActiveStructure();
    return s ? { periodic: s.volumetricFields?.fields?.[0]?.periodic, search: location.search, hash: location.hash,
      modal: !!document.getElementById('confirmModal') && !document.getElementById('confirmModal').hidden } : null;
  }, { timeout: 60000, interval: 500 });
  H.check('widget-mode #load-file with cubePeriodic=false loads a block without dialog',
    ws && ws.periodic === false && !ws.modal && ws.search === '?widget=1' && ws.hash === '', JSON.stringify(ws));
  await widget.close();

  // --- DW-6.1 inputUrl form through the bridge command path
  const bridge = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let cubeFetches = 0;
  await bridge.addInitScript(PAGE_HELPERS);
  await bridge.addInitScript(() => {
    window.__queue = []; window.__results = [];
    window.pywebview = { api: {
      receive_event: () => {},
      next_command: async () => window.__queue.shift(),
      command_result: async (cap, id, result) => { window.__results.push({ id, result }); },
    } };
  });
  await bridge.route('**/_crysviz/manifest/bridge{,/complete}', async (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, bridgeCapability: 'cap', inputs: [] }) });
  });
  await bridge.route('**/host/cube', (route) => { cubeFetches += 1; return route.fulfill({ status: 200, body: SUSPECT }); });
  await bridge.goto(`${BASE}?_crysviz_manifest=bridge`, { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(bridge, () => window.crysvizHost?.dispatch ? true : null, { timeout: 60000, interval: 500 });
  await bridge.waitForTimeout(3000);
  const bridgeLoad = (periodic, withKey = true) => bridge.evaluate(async ({ periodic, withKey }) => {
    const args = { name: 'i.cube', inputUrl: '/host/cube', binary: false };
    if (withKey) args.periodic = periodic;
    window.__results.length = 0;
    window.__queue.push({ id: 'r', request: { command: 'load', args } });
    const { shown } = await window.__probe(() => window.crysvizHost.processBridgeCommand());
    return { shown, result: window.__results[0]?.result, periodic: window.__results[0]?.result?.ok ? await window.__activeField() : undefined };
  }, { periodic, withKey });
  for (const bad of ['false', 0, null]) {
    const r = await bridgeLoad(bad);
    H.check(`DW-6.1 inputUrl form rejects periodic=${JSON.stringify(bad)}`,
      r.result?.ok === false && r.result.error?.code === 'INVALID_ARGS', JSON.stringify(r));
  }
  H.check('rejected inputUrl loads never fetch the input', cubeFetches === 0, String(cubeFetches));
  const bf = await bridgeLoad(false);
  H.check('DW-6.1 inputUrl form accepts periodic:false (block, no dialog)',
    !bf.shown && bf.result?.ok === true && bf.periodic === false, JSON.stringify(bf));
  const bt = await bridgeLoad(true);
  H.check('DW-6.1 inputUrl form accepts periodic:true', !bt.shown && bt.result?.ok === true && bt.periodic === true, JSON.stringify(bt));

  H.check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
  await H.finish(browser);
})().catch(H.crash);
