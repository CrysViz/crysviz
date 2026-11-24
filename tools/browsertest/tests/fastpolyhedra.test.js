// Fast polyhedra search (Features ▸ Show Polyhedra ▸ Fast | Auto | Advanced).
// Fast is the hull of each centre's bonded ligands (element rule + bond
// cutoff), no Voronoi selection, no cages (periodic_wasm_src polyhedra.rs,
// the fast block of build_candidates; runJsPath's twin in PolyhedraModule.js).
// Checks:
//   - SrTiO3 3×3×3: fast and advanced draw the same polyhedra, on WASM and JS;
//     5×5×5 fast: the worker pool gives what the serial path gives;
//   - alpha-boron: no polyhedra in fast (B–B is no ligand pair, no cages),
//     its 8 B12 cages in advanced;
//   - the Features control switches general.polyhedraMode, the status line
//     follows, and the choice survives a reload (localStorage);
//   - Auto switches at general.polyhedraFastMin, with the viewport note;
//   - the Polyhedra window greys Detect Cages in fast (Use Chemical Filter
//     stays live: fast mode applies it to the bonded neighbours);
//   - SrTiO3 with the filter off in fast: Sr takes its 8 Ti neighbours too.
'use strict';
const H = require('../harness');
const fs = require('fs');
const path = require('path');

/** SrTiO3 n×n×n supercell (a = 3.905 Å; Sr 0,0,0; Ti ½,½,½; O on the faces). */
function srtio3(n) {
  const a = 3.905 * n;
  const basis = {
    Sr: [[0, 0, 0]],
    Ti: [[0.5, 0.5, 0.5]],
    O: [[0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]],
  };
  const lines = [`SrTiO3 ${n}x${n}x${n}`, '1.0', `${a} 0 0`, `0 ${a} 0`, `0 0 ${a}`, 'Sr Ti O'];
  const counts = [];
  const coords = [];
  for (const el of ['Sr', 'Ti', 'O']) {
    let c = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      for (const [x, y, z] of basis[el]) {
        coords.push(`${(x + i) / n} ${(y + j) / n} ${(z + k) / n}`);
        c++;
      }
    }
    counts.push(c);
  }
  return [...lines, counts.join(' '), 'Direct', ...coords].join('\n') + '\n';
}

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'polyhedra_golden.json'), 'utf8'));
const boron = golden.structures.find((s) => s.name === 'aflow152_B').poscar;

(async () => {
  const { browser, page, errors } = await H.launchApp();

  /** Load a POSCAR and switch polyhedra on. */
  async function load(poscar, name) {
    await page.evaluate(async ({ poscar, name }) => {
      const cv = await import('./core/crystal-viewer.js');
      const { general } = await import('./state/store.js');
      await cv.loadStructure(poscar, name);
      if (!general.showPolyhedra) document.getElementById('showPolyhedra')?.click();
    }, { poscar, name });
    await page.waitForTimeout(1500);
  }

  /** Recompute with the given settings; the polyhedra as {key: count}. */
  async function polyhedraWith({ mode, wasm = true, serial = false }) {
    return page.evaluate(async ({ mode, wasm, serial }) => {
      const { fileBrowser, general } = await import('./state/store.js');
      const pm = await import('./render/PolyhedraModule.js');
      const s = fileBrowser.selectedStructure;
      general.polyhedraMode = mode;
      general.useWasmPolyhedra = wasm;
      general.serialPolyhedraAlgorithm = serial;
      s.polyhedra = null;
      await pm.updatePolyhedra();
      const t0 = performance.now();
      while (!s.polyhedra?.polyhedra && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
      general.useWasmPolyhedra = true;
      general.serialPolyhedraAlgorithm = false;
      const list = {};
      for (const p of s.polyhedra?.polyhedra ?? []) {
        const count = {};
        for (const j of p.vertexSrcList) count[s.elements[j]] = (count[s.elements[j]] || 0) + 1;
        const corners = Object.keys(count).sort().map((e) => `${e}${count[e]}`).join('');
        const key = `${p.type === 'centered' ? p.centerElement : 'cage'}: ${corners}`;
        list[key] = (list[key] || 0) + 1;
      }
      return { list, total: s.polyhedra?.polyhedra?.length ?? -1, effective: pm.effectivePolyhedraMode(s) };
    }, { mode, wasm, serial });
  }
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

  // ---- SrTiO3 3×3×3: fast draws what advanced draws -------------------------
  await load(srtio3(3), 'SrTiO3_333.vasp');
  const adv = await polyhedraWith({ mode: 'advanced' });
  const fast = await polyhedraWith({ mode: 'fast' });
  const fastJs = await polyhedraWith({ mode: 'fast', wasm: false });
  H.check('SrTiO3 3x3x3 advanced draws polyhedra', adv.total > 0 && adv.effective === 'advanced', JSON.stringify(adv));
  H.check('SrTiO3 3x3x3: fast draws the same polyhedra as advanced', fast.effective === 'fast' && fast.total === adv.total && same(fast.list, adv.list),
    JSON.stringify({ adv: adv.list, fast: fast.list }));
  H.check('SrTiO3 3x3x3: the JS fast path draws what the WASM fast path draws', same(fastJs.list, fast.list),
    JSON.stringify({ wasm: fast.list, js: fastJs.list }));

  // Filter off: no element rule beyond "another species" and no bridged-cation
  // test, so Sr takes the 8 Ti inside the default Sr–Ti cutoff as corners.
  const setFilter = (on) => page.evaluate(async (on) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    s.polyhedraSettings = { ...(s.polyhedraSettings || {}), useChemicalFilter: on };
  }, on);
  await setFilter(false);
  const off = await polyhedraWith({ mode: 'fast' });
  const offJs = await polyhedraWith({ mode: 'fast', wasm: false });
  await setFilter(true);
  H.check('SrTiO3 fast with the chemical filter off: Sr takes its 8 Ti neighbours (WASM = JS)',
    off.list['Sr: O12Ti8'] > 0 && same(off.list, offJs.list), JSON.stringify({ wasm: off.list, js: offJs.list }));

  // ---- 5×5×5 fast: worker pool vs serial ------------------------------------
  await load(srtio3(5), 'SrTiO3_555.vasp');
  const par = await polyhedraWith({ mode: 'fast' });
  const ser = await polyhedraWith({ mode: 'fast', serial: true });
  const adv5 = await polyhedraWith({ mode: 'advanced' });
  H.check('SrTiO3 5x5x5 fast: the worker pool draws what the serial path draws', par.total > 0 && same(par.list, ser.list),
    JSON.stringify({ par: par.list, ser: ser.list }));
  H.check('SrTiO3 5x5x5: fast and advanced agree', same(par.list, adv5.list), JSON.stringify({ fast: par.list, adv: adv5.list }));

  // ---- alpha-boron: no polyhedra fast, 8 cages advanced ----------------------
  await load(boron, 'aflow152_B.vasp');
  const bFast = await polyhedraWith({ mode: 'fast' });
  const bFastJs = await polyhedraWith({ mode: 'fast', wasm: false });
  const bAdv = await polyhedraWith({ mode: 'advanced' });
  H.check('alpha-boron fast: no polyhedra (WASM and JS)', bFast.total === 0 && bFastJs.total === 0, JSON.stringify({ bFast, bFastJs }));
  H.check('alpha-boron advanced: 8 B12 cages', bAdv.total === 8 && bAdv.list['cage: B12'] === 8, JSON.stringify(bAdv));

  // ---- the Features control --------------------------------------------------
  await page.evaluate(async () => {
    const { getPanel, openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('features');
    getPanel('features')?.expand();
  });
  await page.waitForTimeout(300);
  /** Click one of Fast/Auto/Advanced and wait for the recompute. */
  async function clickMode(text) {
    return page.evaluate(async (text) => {
      const { fileBrowser, general } = await import('./state/store.js');
      const s = fileBrowser.selectedStructure;
      const before = s.polyhedra;
      document.getElementById(`polyhedraSearch${text}`).click();
      const t0 = performance.now();
      while ((s.polyhedra === before || !s.polyhedra?.polyhedra) && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
      const notice = document.querySelector('.cv-polyhedra-fast-notice');
      return {
        setting: general.polyhedraMode,
        // What runs now lives in the control's tooltip (no status line).
        status: document.getElementById('polyhedraSearchControl')?.title,
        autoTitle: document.getElementById('polyhedraSearchAuto')?.title,
        checked: [...document.querySelectorAll('#polyhedraSearchRow [role="radio"]')]
          .filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent),
        count: s.polyhedra?.polyhedra?.length ?? -1,
        notice: notice && getComputedStyle(notice).display !== 'none' ? notice.textContent : null,
        stored: localStorage.getItem('crysvizPolyhedraSearch'),
      };
    }, text);
  }
  const row = await page.evaluate(() => {
    const r = document.getElementById('polyhedraSearchRow');
    const show = document.getElementById('showPolyhedra')?.closest('label');
    const seg = document.getElementById('polyhedraSearchControl');
    return {
      exists: !!r, afterShow: !!r && show?.nextElementSibling === r, inFeatures: !!r?.closest('#cvPanelBody-features'),
      // only the three buttons: no visible label, no status line
      children: r ? [...r.querySelectorAll('*')].filter((e) => e.offsetParent !== null && !e.closest('button') && e !== seg).length : -1,
      text: r?.textContent, ariaLabel: seg?.getAttribute('aria-label'),
      // same line as the toggle (vertical centres within 2 px), right of its label
      ...(() => {
        if (!seg || !show) return {};
        const a = show.querySelector('.toggle_switch').getBoundingClientRect();
        const t = show.querySelector('.toggle_text').getBoundingClientRect();
        const b = seg.getBoundingClientRect();
        return { dy: Math.round(Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2)), rightOfLabel: b.left >= t.right };
      })(),
      notInLabel: !show?.contains(r),
    };
  });
  H.check('Features window: the Fast | Auto | Advanced control sits on the Show Polyhedra line, nothing else',
    row.exists && row.afterShow && row.inFeatures && row.children === 0 && row.text === 'FastAutoAdvanced' && row.ariaLabel === 'Polyhedra Search'
    && row.dy <= 2 && row.rightOfLabel && row.notInLabel,
    JSON.stringify(row));

  let st = await clickMode('Fast');
  H.check('Fast button: fast mode, tooltip "Fast (12 atoms)", no cages', st.setting === 'fast' && st.status === 'Polyhedra Search — Fast (12 atoms)'
    && st.checked.join() === 'Fast' && st.count === 0 && st.notice === null, JSON.stringify(st));
  H.check('the choice is stored in this browser', JSON.parse(st.stored || '{}').mode === 'fast', st.stored);
  st = await clickMode('Advanced');
  H.check('Advanced button: tooltip "Advanced (12 atoms)", 8 cages back', st.setting === 'advanced' && st.status === 'Polyhedra Search — Advanced (12 atoms)'
    && st.count === 8, JSON.stringify(st));

  // ---- the choice survives a reload ------------------------------------------
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  const kept = await page.evaluate(async () => (await import('./state/store.js')).general.polyhedraMode);
  H.check('polyhedraMode survives a reload', kept === 'advanced', kept);

  // ---- Auto switches at polyhedraFastMin -------------------------------------
  await load(srtio3(3), 'SrTiO3_333.vasp'); // 135 atoms
  await page.evaluate(async () => {
    const { getPanel, openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('features');
    getPanel('features')?.expand();
    openPanel('polyhedra');
    getPanel('polyhedra')?.expand();
    const { general } = await import('./state/store.js');
    general.polyhedraFastMin = 200;
  });
  await page.waitForTimeout(500);
  st = await clickMode('Auto');
  H.check('Auto below polyhedraFastMin: tooltip "Auto: advanced now (135 atoms; Fast from 200)", no note', st.setting === 'auto'
    && st.status === 'Polyhedra Search — Auto: advanced now (135 atoms; Fast from 200)' && st.notice === null, JSON.stringify(st));
  H.check('the Auto button tooltip names the threshold and what runs now',
    st.autoTitle === 'Auto: Fast from 200 atoms on, Advanced below. Now: advanced (135 atoms)', String(st.autoTitle));
  const advCount = st.count;
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.polyhedraFastMin = 100;
  });
  // Re-run through the control: Advanced then Auto.
  await clickMode('Advanced');
  st = await clickMode('Auto');
  H.check('Auto at/above polyhedraFastMin: tooltip "Auto: fast now (135 atoms; Fast from 100)"', st.status === 'Polyhedra Search — Auto: fast now (135 atoms; Fast from 100)' && st.count === advCount,
    JSON.stringify(st));
  H.check('Auto picking fast shows the viewport note', /^Fast polyhedra search \(135 atoms\): bonded neighbours only, no cages — Features ▸ Show Polyhedra ▸ Fast \| Auto \| Advanced$/.test(st.notice || ''),
    String(st.notice));

  const greyed = () => page.evaluate(() => {
    const out = {};
    for (const id of ['polyhedraChemicalFilterToggle', 'polyhedraDetectCagesToggle', 'polyhedraUseWasmToggle']) {
      const input = document.getElementById(id);
      out[id] = input ? { disabled: input.disabled, inactive: input.closest('label').classList.contains('is-mode-inactive') } : null;
    }
    const note = document.getElementById('polyhedraModeNote');
    out.note = !!note && !note.hidden && getComputedStyle(note).display !== 'none';
    return out;
  });
  let g = await greyed();
  // Use Chemical Filter stays live: fast mode applies it to the bonded neighbours.
  H.check('Polyhedra window in fast: Detect Cages greyed, with the note; Use Chemical Filter and Use WASM live',
    g.polyhedraChemicalFilterToggle && !g.polyhedraChemicalFilterToggle.disabled && !g.polyhedraChemicalFilterToggle.inactive
    && g.polyhedraDetectCagesToggle?.disabled && g.polyhedraDetectCagesToggle.inactive
    && g.polyhedraUseWasmToggle && !g.polyhedraUseWasmToggle.disabled && g.note, JSON.stringify(g));

  st = await clickMode('Advanced');
  g = await greyed();
  H.check('Advanced: the note over the 3D view is gone', st.notice === null, JSON.stringify(st));
  H.check('Polyhedra window in advanced: the rows are live again, no note',
    !g.polyhedraChemicalFilterToggle?.disabled && !g.polyhedraChemicalFilterToggle?.inactive
    && !g.polyhedraDetectCagesToggle?.disabled && !g.note, JSON.stringify(g));

  // Back to the defaults for whoever uses this profile next.
  await page.evaluate(async () => {
    const { general, savePolyhedraSearchPrefs } = await import('./state/store.js');
    general.polyhedraMode = 'auto';
    general.polyhedraFastMin = 2000;
    savePolyhedraSearchPrefs();
  });

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
