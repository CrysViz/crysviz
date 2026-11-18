// Atomistic window additions:
//  1. The potential's loading bar (AtomisticPanels.js setPotentialLoad):
//     NEP's start-up sweeps it; a PET-MAD model download fills it with the
//     megabytes received; it goes away when loading ends, also on failure.
//  2. Relax has a Stop button: Relax is locked while a run goes, Stop ends it
//     after the current step and keeps the trajectory so far. While it runs a
//     sweeping bar shows the step and max force, and the window's title bar
//     says "Relax step N".
//  3. MD shows its progress under its buttons (step of total, filling) and in
//     the title bar ("MD 37%"), also while the window is collapsed.
//  4. The potentials' accuracy warning collapses to a small orange ⚠ (its
//     Collapse button, or Settings ▸ Warnings) in every window, and the ⚠
//     expands it again; NEP's high-pressure warning stays in full.
'use strict';
const H = require('../harness');

const HOST = 'https://models.example.org/crysviz';
const CORS = { 'access-control-allow-origin': '*' };

/** A header-only PET GGUF padded to `mb` MB: downloads and inspects, does not load. */
function paddedGGUF(mb) {
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
  const str = (s) => { const b = Buffer.from(s, 'utf8'); u64(b.length); parts.push(b); };
  const kvString = (k, v) => { str(k); u32(8); str(v); };
  const kvInts = (k, values) => {
    str(k); u32(9); u32(5); u64(values.length);
    values.forEach((x) => { const b = Buffer.alloc(4); b.writeInt32LE(x); parts.push(b); });
  };
  parts.push(Buffer.from('GGUF'));
  u32(3); u64(0); u64(3);
  kvString('general.architecture', 'pet-graph');
  kvString('general.name', 'padded test model');
  kvInts('pet.species_map', [8, 0, 29, 1, 39, 2, 56, 3]);
  parts.push(Buffer.alloc(mb * 1e6));
  return Buffer.concat(parts);
}

/** Record every state the loading bar shows. */
const watchLoadBar = (page) => page.evaluate(() => {
  const box = document.querySelector('#BackendPotentialSelector [data-role="potential-load"]');
  window.__loadSeen = [];
  if (!box) return false;
  const note = () => {
    const bar = box.querySelector('[data-role="progress-bar"]');
    window.__loadSeen.push({
      hidden: box.hidden,
      label: box.querySelector('[data-role="progress-label"]').textContent,
      indeterminate: bar.classList.contains('is-indeterminate'),
      value: bar.getAttribute('aria-valuenow'),
    });
  };
  new MutationObserver(note).observe(box, { subtree: true, attributes: true, childList: true, characterData: true });
  return true;
});

/** A run's progress bar under its buttons, and the window's title-bar status. */
const runState = (page, role) => page.evaluate((role) => {
  const box = document.querySelector(`#BackendCalcPanel [data-role="${role}"]`);
  const bar = box?.querySelector('[data-role="progress-bar"]');
  const title = document.querySelector('.cv-panel[data-panel-id="backend"] [data-role="panel-status"]');
  return {
    shown: !!box && !box.hidden,
    label: box?.querySelector('[data-role="progress-label"]')?.textContent || '',
    indeterminate: !!bar?.classList.contains('is-indeterminate'),
    value: bar?.getAttribute('aria-valuenow') ?? null,
    title: title && !title.hidden ? title.textContent : null,
    titleVisible: !!title && !title.hidden && title.getClientRects().length > 0,
  };
}, role);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const model = paddedGGUF(6);
  await page.context().route(`${HOST}/padded.gguf`, (route) => route.fulfill({
    status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream', 'content-length': String(model.length) },
    body: model,
  }));
  await H.loadDefaultStructure(page); // YBCO
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    general.atomisticPotential = 'nep';
    openPanel('backend');
  });
  await page.waitForTimeout(500);

  // ---- 1. loading bar ---------------------------------------------------------------
  H.check('the loading bar is there and hidden while nothing loads', await watchLoadBar(page)
    && await page.evaluate(() => document.querySelector('#BackendPotentialSelector [data-role="potential-load"]').hidden));
  await page.evaluate(() => document.getElementById('relaxEfsCard').click());
  await H.waitFor(page, () => /energy \/ atom: -?\d/.test(document.getElementById('relaxEfsMetrics')?.textContent || ''),
    { timeout: 60000, interval: 200 });
  let seen = await page.evaluate(() => window.__loadSeen);
  H.check('NEP start-up sweeps the bar, which then goes away',
    seen.some((s) => !s.hidden && /built-in NEP/.test(s.label) && s.indeterminate) && seen[seen.length - 1].hidden,
    JSON.stringify(seen));

  await watchLoadBar(page);
  await page.evaluate(async (url) => {
    const { general } = await import('./state/store.js');
    general.atomisticPotential = 'mlip';
    document.querySelector('#BackendPotentialSelector [data-potential="mlip"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    const select = document.querySelector('#BackendPotentialSelector [data-role="mlip-model"]');
    const opt = document.createElement('option');
    opt.value = url;
    opt.textContent = 'padded test model';
    select.appendChild(opt);
    select.value = url;
    document.querySelector('#BackendPotentialSelector [data-role="mlip-load"]').click();
  }, `${HOST}/padded.gguf`);
  const status = await H.waitFor(page, () => {
    const t = document.querySelector('#BackendPotentialSelector [data-role="mlip-status"]')?.textContent || '';
    return /Load failed|ready/.test(t) ? t : null;
  }, { timeout: 120000, interval: 250 });
  seen = await page.evaluate(() => window.__loadSeen);
  const download = seen.filter((s) => /^Downloading padded\.gguf: [\d.]+ of 6(\.0)? MB$/.test(s.label) && !s.indeterminate);
  H.check('a PET-MAD model download fills the bar, with the megabytes received',
    download.length > 0 && download.every((s) => Number(s.value) >= 0 && Number(s.value) <= 100)
      && download[download.length - 1].value === '100', JSON.stringify(seen));
  H.check('PET-MAD start-up and the model hand-over sweep the bar',
    seen.some((s) => /Starting PET-MAD/.test(s.label) && s.indeterminate)
      && seen.some((s) => /into PET-MAD/.test(s.label) && s.indeterminate), JSON.stringify(seen.map((s) => s.label)));
  H.check('the bar goes away when loading ends, also when it fails',
    seen[seen.length - 1].hidden && await page.evaluate(() =>
      document.querySelector('#BackendPotentialSelector [data-role="potential-load"]').hidden),
    JSON.stringify({ status, last: seen[seen.length - 1] }));

  // ---- 2. Stop for Relax ----------------------------------------------------------------
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.atomisticPotential = 'nep';
    document.querySelector('#BackendPotentialSelector [data-potential="nep"]')?.click();
  });
  await page.waitForTimeout(400);
  const before = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    const set = (id, v) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input')); };
    set('relaxMaxStepsInput', 100000);
    set('relaxForceTolInput', 0.0000001);
    const stop = document.getElementById('relaxStopBtn');
    const idle = { stopDisabled: !!stop?.disabled };
    const relax = document.getElementById('relaxBtn');
    relax.click();
    relax.click(); // a second click while running starts nothing
    return { ...idle, runs: structureShip.container.length };
  });
  H.check('Stop is there next to Relax, off while nothing runs', before.stopDisabled === true, JSON.stringify(before));
  await H.waitFor(page, () => {
    const m = /step (\d+) \//.exec(document.querySelector('#BackendPotentialSelector [data-role="source-state"]')?.textContent || '');
    return m && Number(m[1]) >= 5;
  }, { timeout: 60000, interval: 100 });
  const running = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    return {
      relaxDisabled: document.getElementById('relaxBtn').disabled,
      stopDisabled: document.getElementById('relaxStopBtn').disabled,
      relaxRuns: structureShip.container.filter((c) => /^relax_/.test(c.fileName || '')).length,
    };
  });
  H.check('while it runs, Relax is locked and Stop is on; two clicks started one run',
    running.relaxDisabled && !running.stopDisabled && running.relaxRuns === 1, JSON.stringify(running));
  const relaxRun = await runState(page, 'relax-progress');
  H.check('a relaxation shows a sweeping bar with its step and max force, and "Relax step N" in the title bar',
    relaxRun.shown && relaxRun.indeterminate && /^Relaxation: step \d+ \(max 100000\) · max force [\d.]+ eV\/Å/.test(relaxRun.label)
      && /^Relax step \d+$/.test(relaxRun.title || ''), JSON.stringify(relaxRun));
  await page.evaluate(() => document.getElementById('relaxStopBtn').click());
  const result = await H.waitFor(page, () => {
    const t = document.querySelector('#BackendPotentialSelector [data-role="source-state"]')?.textContent || '';
    return /Stopped after \d+ steps, before converging\./.test(t) ? t : null;
  }, { timeout: 60000, interval: 200 });
  const after = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    const runs = structureShip.container.filter((c) => /^relax_/.test(c.fileName || ''));
    return {
      relaxDisabled: document.getElementById('relaxBtn').disabled,
      stopDisabled: document.getElementById('relaxStopBtn').disabled,
      frames: runs[runs.length - 1]?.structures?.length ?? 0,
    };
  });
  H.check('Stop ends the relaxation and says it did not converge', !!result, String(result));
  H.check('...keeps the steps so far, and unlocks Relax again',
    after.frames >= 2 && !after.relaxDisabled && after.stopDisabled, JSON.stringify(after));
  const relaxDone = await runState(page, 'relax-progress');
  H.check('...and its bar and title status go away', !relaxDone.shown && relaxDone.title === null, JSON.stringify(relaxDone));

  // ---- 3. MD progress --------------------------------------------------------------------
  await page.evaluate(() => {
    document.querySelector('#BackendModeSwitch button[data-mode="md"]').click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input')); };
    set('mdStepsInput', 20000);
    document.getElementById('mdStartBtn').click();
  });
  await H.waitFor(page, () => {
    const t = document.querySelector('#BackendCalcPanel [data-role="md-progress"] [data-role="progress-label"]')?.textContent || '';
    const m = /step (\d+) of/.exec(t);
    return m && Number(m[1]) >= 50;
  }, { timeout: 60000, interval: 100 });
  const md1 = await runState(page, 'md-progress');
  await page.waitForTimeout(1500);
  const md2 = await runState(page, 'md-progress');
  H.check('MD fills its bar with the steps done, "MD: step N of 20000"',
    md1.shown && !md1.indeterminate && /^MD: step \d+ of 20000 · [\d.]+ fs$/.test(md1.label)
      && Number(md2.value) >= Number(md1.value), JSON.stringify({ md1, md2 }));
  const collapsed = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const w = getPanel('backend');
    w.collapse();
    await new Promise((r) => setTimeout(r, 400));
    return { collapsed: !w.isExpanded() };
  });
  const md3 = await runState(page, 'md-progress');
  H.check('with the Atomistic window collapsed, its title bar still says "MD N%"',
    collapsed.collapsed && md3.titleVisible && /^MD \d+%$/.test(md3.title || ''), JSON.stringify({ collapsed, md3 }));
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('backend').expand();
    document.getElementById('mdStopBtn').click();
  });
  await H.waitFor(page, () => /Stopped at step/.test(
    document.querySelector('#BackendPotentialSelector [data-role="source-state"]')?.textContent || ''), { timeout: 60000, interval: 200 });
  const mdDone = await runState(page, 'md-progress');
  H.check('when MD stops, its bar and title status go away', !mdDone.shown && mdDone.title === null, JSON.stringify(mdDone));

  // A browser that still runs a cached PanelWindow.js from before setStatus
  // existed (a page mixing new and old modules after a deploy) must still
  // run MD and relaxations: the title status is decoration.
  const oldWindow = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('backend').setStatus = undefined;
    const set = (id, v) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input')); };
    const text = () => document.querySelector('#BackendPotentialSelector [data-role="source-state"]')?.textContent || '';
    const until = async (re) => {
      for (let i = 0; i < 300 && !re.test(text()); i++) await new Promise((r) => setTimeout(r, 200));
      return text();
    };
    set('mdStepsInput', 30); // continues the run stopped above: the step count carries on
    document.getElementById('mdStartBtn').click();
    const md = await until(/Finished at step|MD failed/);
    document.querySelector('#BackendModeSwitch button[data-mode="relax"]').click();
    await new Promise((r) => setTimeout(r, 300));
    set('relaxMaxStepsInput', 10);
    document.getElementById('relaxBtn').click();
    const relax = await until(/Converged after|Stopped after|Relax failed/);
    delete getPanel('backend').setStatus;
    return { md, relax };
  });
  H.check('a window without setStatus (an old cached PanelWindow.js) does not stop MD or Relax',
    /^Finished at step \d+\./.test(oldWindow.md) && /^(Converged|Stopped) after/.test(oldWindow.relax), JSON.stringify(oldWindow));

  // ---- 4. collapsing the accuracy warning ----------------------------------------------------
  const notice = () => page.evaluate(async () => {
    const n = document.querySelector('#BackendPotentialSelector [data-role="potential-notice"]');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { mountPotentialNotice } = await import('./atomistic/potentialNotice.js');
    const other = mountPotentialNotice(host, { pressures: () => [{ label: 'target pressure', gpa: 12 }] }).element;
    const expand = n?.querySelector('[data-role="potential-notice-expand"]');
    const out = {
      caveat: !!n?.querySelector('[data-role="potential-notice-caveat"]'),
      collapseButton: !!n?.querySelector('[data-role="potential-notice-collapse"]'),
      triangle: expand ? { text: expand.textContent, expanded: expand.getAttribute('aria-expanded'),
        color: getComputedStyle(expand).color, title: expand.title } : null,
      otherCaveat: !!other.querySelector('[data-role="potential-notice-caveat"]'),
      otherTriangleInLine: !!other.querySelector('[data-role="potential-notice-line"] [data-role="potential-notice-expand"]'),
      otherAlert: other.querySelector('[data-role="potential-notice-alert"]')?.textContent || '',
    };
    host.remove();
    return out;
  });
  let n = await notice();
  H.check('the accuracy warning shows in full, with a Collapse button', n.caveat && n.collapseButton && n.otherCaveat && !n.triangle,
    JSON.stringify(n));
  await page.click('#BackendPotentialSelector [data-role="potential-notice-collapse"]');
  await page.waitForTimeout(200);
  n = await notice();
  const pref = await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).getPanelPref('collapsePotentialCaveat'));
  H.check('Collapse folds it to an orange ⚠ here and in the other windows (at the end of "Runs with …"), and remembers it',
    !n.caveat && !n.otherCaveat && n.triangle?.text === '⚠' && n.triangle.expanded === 'false'
      && /^rgb\(255, 207, 79/.test(n.triangle.color) && /check the results that matter/i.test(n.triangle.title)
      && n.otherTriangleInLine && pref === true, JSON.stringify({ n, pref }));
  H.check('NEP\'s high-pressure warning still shows in full', /PET.MAD models are recommended/.test(n.otherAlert), n.otherAlert);
  const settingsChecked = await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.openPanel('settings');
    await new Promise((r) => setTimeout(r, 300));
    return /** @type {HTMLInputElement} */ (document.getElementById('collapsePotentialCaveatToggle'))?.checked ?? null;
  });
  H.check('Settings ▸ Warnings shows it collapsed', settingsChecked === true, String(settingsChecked));
  await page.click('#BackendPotentialSelector [data-role="potential-notice-expand"]');
  await page.waitForTimeout(200);
  n = await notice();
  const afterExpand = await page.evaluate(async () => ({
    pref: (await import('./ui/panels/PanelManager.js')).getPanelPref('collapsePotentialCaveat'),
    settings: /** @type {HTMLInputElement} */ (document.getElementById('collapsePotentialCaveatToggle'))?.checked ?? null,
  }));
  H.check('clicking the ⚠ expands it again everywhere, and the Settings switch follows',
    n.caveat && n.otherCaveat && !n.triangle && afterExpand.pref === false && afterExpand.settings === false,
    JSON.stringify({ n, afterExpand }));
  const viaSettings = await page.evaluate(async () => {
    const cb = /** @type {HTMLInputElement} */ (document.getElementById('collapsePotentialCaveatToggle'));
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return !!document.querySelector('#BackendPotentialSelector [data-role="potential-notice-expand"]');
  });
  H.check('the Settings switch collapses it too', viaSettings === true);

  const real = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED/.test(e));
  H.check('no console/page errors', real.length === 0, real.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
