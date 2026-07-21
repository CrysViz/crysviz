// Shared helpers for the browser tests (see README.md here). CommonJS, run by
// plain node via run.sh, which provides CRYSVIZ_URL, DISPLAY (Xvfb), the
// playwright browser path and NODE_PATH for playwright-core/pngjs.
//
// The one non-obvious trick used throughout: ES modules are cached per URL,
// so `page.evaluate(async () => { const m = await import('./state/store.js'); ... })`
// returns the SAME module singletons the running app uses — tests can read
// `groups`/`general`/`fileBrowser` and call exported app functions directly.

'use strict';

const fs = require('fs');
const path = require('path');
const { firefox } = require('playwright-core');
const { PNG } = require('pngjs');

const URL = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';
const ARTIFACTS = path.join(__dirname, 'artifacts');

// Region of the 1400x900 viewport that is pure 3D canvas: right of the side
// panel, below the measurement toolbar, above the structure-name chip.
const CANVAS_CLIP = { x: 460, y: 120, width: 920, height: 660 };

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

/** Launch the app. Returns { browser, page, errors } — errors collects
 *  pageerror + console.error text for the "no errors" assertion. */
async function launchApp() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  // headless FF has no WebGL. Caching is off because python's http.server
  // sends no Cache-Control: Firefox then caches heuristically and a test run
  // right after an edit can execute the PREVIOUS version of a module.
  const browser = await firefox.launch({
    headless: false,
    firefoxUserPrefs: {
      'browser.cache.disk.enable': false,
      'browser.cache.memory.enable': false,
      'network.http.use-cache': false,
    },
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // Pre-dismiss the ray/path-tracing performance-warning modal: shotCanvas is a
  // page screenshot (DOM overlays included), so the modal backdrop would dim
  // every capture taken after a dropdown switch into a tracer. Tests that TEST
  // the modal (tracerwarning) clear this pref explicitly at their start.
  await page.addInitScript(() => {
    try {
      const prefs = JSON.parse(localStorage.getItem('panelPrefs') || '{}');
      prefs.hideRaytraceWarning = true;
      localStorage.setItem('panelPrefs', JSON.stringify(prefs));
    } catch { /* storage unavailable */ }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300));
  });
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 }); // 'networkidle' can hang
  await page.waitForTimeout(5000); // init + default structure load
  return { browser, page, errors };
}

async function webglAvailable(page) {
  return page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
}

/** Load a bundled default structure by store export name (e.g. 'defaultPOSCAR'
 *  = YBCO, a good polyhedra test case). */
async function loadDefaultStructure(page, exportName = 'defaultPOSCAR', label = 'YBCO') {
  await page.evaluate(async ({ exportName, label }) => {
    const cv = await import('./core/crystal-viewer.js');
    const d = await import('./defaults/structure_defaults.js');
    await cv.loadStructure(d[exportName], label);
  }, { exportName, label });
  await page.waitForTimeout(2000);
}

/** Set a <select> through the UI (fires its change handler). */
async function setSelect(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event('change'));
  }, { id, value });
}

/** Set a range slider through the UI (fires its input handler). */
async function setSlider(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    el.value = String(value);
    el.dispatchEvent(new Event('input'));
  }, { id, value });
}

async function clickById(page, id) {
  await page.evaluate((id) => document.getElementById(id).click(), id);
}

/** Poll an in-page condition (a function body evaluated via page.evaluate)
 *  until it returns truthy; returns its last value. */
async function waitFor(page, fn, { timeout = 30000, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await page.evaluate(fn);
    if (last || Date.now() > deadline) return last;
    await page.waitForTimeout(interval);
  }
}

/** Screenshot the 3D canvas region into artifacts/<name>.png; returns path. */
async function shotCanvas(page, name) {
  const file = path.join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path: file, clip: CANVAS_CLIP });
  return file;
}

/** Fraction of near-black pixels in a PNG — the outline-visibility metric. */
function darkFraction(file, threshold = 60) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let dark = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (png.data[o] < threshold && png.data[o + 1] < threshold && png.data[o + 2] < threshold) dark++;
  }
  return dark / total;
}

/** Fraction of pixels that differ from the top-left pixel — "something is
 *  drawn" metric (a blank canvas is a uniform background color). */
function nonUniformFraction(file, tolerance = 30) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const [r0, g0, b0] = [png.data[0], png.data[1], png.data[2]];
  let diff = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (Math.abs(png.data[o] - r0) > tolerance
      || Math.abs(png.data[o + 1] - g0) > tolerance
      || Math.abs(png.data[o + 2] - b0) > tolerance) diff++;
  }
  return diff / total;
}

/** Print the summary, close the browser, exit non-zero on any failure. */
async function finish(browser) {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

function crash(err) {
  console.error('  TEST DRIVER ERROR:', err);
  process.exit(2);
}

module.exports = {
  launchApp, webglAvailable, loadDefaultStructure, setSelect, setSlider,
  clickById, waitFor, shotCanvas, darkFraction, nonUniformFraction,
  check, finish, crash,
};
