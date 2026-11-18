// Polyhedra regression set: every structure of the stress run with the list
// of polyhedra CrysViz should draw for it (fixtures/polyhedra_golden.json).
// tests/polygolden{1..5}.test.js each run one fifth of the set, so no file
// comes near run.sh's per-file timeout; each structure is checked on the WASM
// path and on the JS path against the same list.
//
// After an INTENDED change to what gets drawn, regenerate the lists:
//   POLY_GOLDEN_UPDATE=1 tools/browsertest/run.sh tests/polygolden*.test.js
// (writes the WASM results, fails a structure where JS and WASM disagree), then
// review the diff of fixtures/polyhedra_golden.md, the readable copy.
//   node tools/browsertest/polygolden.js --md     rewrites only the .md
'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'polyhedra_golden.json');
const MARKDOWN = path.join(__dirname, 'fixtures', 'polyhedra_golden.md');
const SHARDS = 5;
const RELOAD_EVERY = 20; // a fresh page now and then keeps memory flat

function readFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

/** The readable list: one section per structure. */
function writeMarkdown(fixture) {
  const lines = [
    '# Polyhedra regression set',
    '',
    'Generated from `polyhedra_golden.json` by `tools/browsertest/polygolden.js`; do not edit by hand.',
    '',
    fixture.about,
    '',
    `${fixture.structures.length} structures, ${fixture.structures.filter((s) => Object.keys(s.polyhedra).length).length} with polyhedra.`,
    '',
    '| Structure | Formula | Atoms | Polyhedra drawn (count) |',
    '|---|---|---:|---|',
  ];
  for (const s of fixture.structures) {
    const polys = Object.entries(s.polyhedra).map(([k, n]) => `${k} ×${n}`).join('; ') || '—';
    const note = s.note ? `<br>*${s.note}*` : '';
    lines.push(`| ${s.name}<br><sub>${s.description}</sub> | ${s.formula} | ${s.atoms} | ${polys}${note} |`);
  }
  fs.writeFileSync(MARKDOWN, lines.join('\n') + '\n');
}

/** Differences between two {key: count} lists, as "missing …; extra …". */
function diff(expected, got) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(got)]);
  const missing = [];
  const extra = [];
  for (const k of [...keys].sort()) {
    const d = (got[k] || 0) - (expected[k] || 0);
    if (d < 0) missing.push(`${k} ×${-d}`);
    if (d > 0) extra.push(`${k} ×${d}`);
  }
  return [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : '']
    .filter(Boolean).join('; ');
}

async function freshPage(browser, H) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('panelPrefs', JSON.stringify({ hideRaytraceWarning: true, hideLeaveWarning: true, releaseNoteSeen: '9999' }));
      localStorage.setItem('featureStore', JSON.stringify({ version: 1, allByDefault: true, enabled: {} }));
    } catch { /* storage unavailable */ }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // A resource the sandbox's network blocks is no fault of the polyhedra.
    if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html', { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(page, async () => !!(await import('./state/store.js')).app?.scene, { timeout: 60000, interval: 500 });
  await page.waitForTimeout(1000);
  return { page, errors };
}

/** Load one structure and return {wasm, js} as {key: count} lists. */
async function polyhedraOf(page, poscar, name) {
  return page.evaluate(async ({ poscar, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, general } = await import('./state/store.js');
    const pm = await import('./render/PolyhedraModule.js');
    await cv.loadStructure(poscar, `${name}.vasp`);
    const s = fileBrowser.selectedStructure;
    if (!general.showPolyhedra) document.getElementById('showPolyhedra')?.click();
    const out = {};
    for (const wasm of [true, false]) {
      general.useWasmPolyhedra = wasm;
      s.polyhedra = null;
      const t0 = performance.now();
      pm.updatePolyhedra();
      while (!s.polyhedra?.polyhedra && performance.now() - t0 < 120000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const list = {};
      for (const p of s.polyhedra?.polyhedra ?? []) {
        const count = {};
        for (const j of p.vertexSrcList) count[s.elements[j]] = (count[s.elements[j]] || 0) + 1;
        const corners = Object.keys(count).sort().map((e) => `${e}${count[e]}`).join('');
        const key = `${p.type === 'centered' ? p.centerElement : 'cage'}: ${corners}`;
        list[key] = (list[key] || 0) + 1;
      }
      out[wasm ? 'wasm' : 'js'] = s.polyhedra?.polyhedra ? list : null;
    }
    general.useWasmPolyhedra = true;
    return out;
  }, { poscar, name });
}

/** Run shard `k` (1-based) of the set. */
async function runShard(k) {
  const H = require('./harness');
  const update = !!process.env.POLY_GOLDEN_UPDATE;
  const fixture = readFixture();
  const all = fixture.structures;
  const mine = all.filter((_, i) => i % SHARDS === k - 1);
  const { browser, page: first } = await H.launchApp({ navigate: false });
  await first.close();
  let ctx = null;
  let done = 0;
  for (const s of mine) {
    if (!ctx || done % RELOAD_EVERY === 0) {
      if (ctx) await ctx.page.close();
      ctx = await freshPage(browser, H);
    }
    done++;
    ctx.errors.length = 0;
    let got;
    try {
      got = await polyhedraOf(ctx.page, s.poscar, s.name);
    } catch (e) {
      H.check(`${s.name} (${s.formula}): loads and computes`, false, String(e).slice(0, 300));
      await ctx.page.close().catch(() => {});
      ctx = null;
      continue;
    }
    const label = `${s.name} (${s.formula})`;
    if (!got.wasm || !got.js) {
      H.check(`${label}: both paths finish`, false, JSON.stringify({ wasm: !!got.wasm, js: !!got.js }));
      continue;
    }
    if (update) {
      const same = !diff(got.wasm, got.js);
      H.check(`${label}: JS and WASM agree (update)`, same, diff(got.wasm, got.js));
      if (same) s.polyhedra = Object.fromEntries(Object.entries(got.wasm).sort());
    } else {
      const dw = diff(s.polyhedra, got.wasm);
      const dj = diff(s.polyhedra, got.js);
      H.check(`${label}: ${Object.keys(s.polyhedra).length ? Object.entries(s.polyhedra).map(([key, n]) => `${key} ×${n}`).join('; ') : 'no polyhedra'}`,
        !dw && !dj, [dw && `WASM: ${dw}`, dj && `JS: ${dj}`].filter(Boolean).join(' | '));
    }
    if (ctx.errors.length) H.check(`${label}: no page errors`, false, ctx.errors[0].slice(0, 200));
  }
  if (update) {
    // Re-read before writing: the shards run one after another, each owning
    // its own fifth of the entries.
    const latest = readFixture();
    const byName = new Map(mine.map((s) => [s.name, s.polyhedra]));
    for (const s of latest.structures) if (byName.has(s.name)) s.polyhedra = byName.get(s.name);
    fs.writeFileSync(FIXTURE, JSON.stringify(latest, null, 1) + '\n');
    writeMarkdown(latest);
  }
  await H.finish(browser);
}

module.exports = { runShard, writeMarkdown, readFixture, SHARDS };

if (require.main === module && process.argv.includes('--md')) {
  writeMarkdown(readFixture());
  console.log(`wrote ${MARKDOWN}`);
}
