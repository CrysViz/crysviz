// EOS fits that do not succeed (ui/EOSPanel.js, eos/eosFit.js), through the
// window's file input:
//   - a fit whose errors are infinite (as many P-V points as parameters):
//     json.dumps wrote "Infinity", JSON.parse rejected the whole result and
//     the window said "the fit failed". Non-finite numbers now cross the
//     Pyodide boundary as null, and the window says the fit did not
//     converge, with the fitted values and no errors.
//   - a fit that fails, or is still running, no longer leaves the previous
//     file's result tables on screen as if they were the new file's.
// Needs SciPy in Pyodide from jsdelivr; offline, point CRYSVIZ_PYODIDE_DIR at
// an unpacked Pyodide 0.25.0 (harness.js).
'use strict';
const H = require('../harness');

// Cu3Au-like E-V-P data: a well-determined fit.
const GOOD = [
  '# V E P',
  '45.1099 0.31639 22.9810', '46.2471 0.17364 17.3575', '47.4032 0.06703 12.2961',
  '48.5784 -0.00615 7.7488', '49.7729 -0.04892 3.6739', '50.9871 -0.06150 0.0272',
  '52.2213 -0.04622 -3.2534', '53.4756 -0.00552 -6.1984', '54.7502 0.05838 -8.8415',
].join('\n');
// Three P-V points for three parameters: curve_fit's covariance is infinite.
const THREE_PV = ['# V P', '45.1 22.98', '47.4 12.30', '49.8 3.92'].join('\n');
// The same with energies: P-V as above, and E-V (four parameters) cannot run.
const THREE_EPV = ['# V E P', '45.1 0.316 22.98', '47.4 0.067 12.30', '49.8 -0.05 3.92'].join('\n');

/** Drop a data file on the EOS window and wait for the fit to settle. */
async function load(page, name, text) {
  await page.evaluate(({ name, text }) => {
    const input = document.getElementById('eosFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([text], name));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  }, { name, text });
  await H.waitFor(page, () => {
    const s = document.querySelector('#cvPanelBody-eos .eos-status')?.textContent || '';
    return s && !/Fitting|Reading/.test(s);
  }, { timeout: 240000, interval: 500 });
  return read(page);
}

function read(page) {
  return page.evaluate(() => ({
    status: document.querySelector('#cvPanelBody-eos .eos-status').textContent,
    shown: !document.querySelector('#cvPanelBody-eos .eos-results').hidden,
    evShown: !document.querySelector('#cvPanelBody-eos .eos-ev-results').hidden,
    pv: ['V0', 'K0', 'K0Prime', 'rms'].map((k) => document.getElementById(`eos-pv-${k}`).textContent),
    ev: ['E0', 'V0', 'K0', 'K0Prime'].map((k) => document.getElementById(`eos-ev-${k}`).textContent),
  }));
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('eos'));
  await page.waitForTimeout(800);

  const good = await load(page, 'good.dat', GOOD);
  if (/unavailable offline/.test(good.status)) {
    H.check('SciPy (Pyodide) loads — offline, set CRYSVIZ_PYODIDE_DIR', false, good.status);
    await H.finish(browser);
    return;
  }
  H.check('a well-determined fit completes, with errors', good.status === 'Fit complete.' && good.shown
    && good.pv.every((t, i) => i === 3 || / ± /.test(t)), JSON.stringify(good));

  const three = await load(page, 'three.dat', THREE_PV);
  H.check('infinite errors: "did not converge", not "the fit failed"',
    /^The P–V fit did not converge: its errors are infinite/.test(three.status), three.status);
  H.check('infinite errors: the fitted values are shown, without errors, and replace the previous file\'s',
    three.shown && !three.evShown && three.pv.slice(0, 3).every((t) => /\d/.test(t) && !/ ± /.test(t))
      && three.pv[0] !== good.pv[0], JSON.stringify(three));

  const threeE = await load(page, 'three-e.dat', THREE_EPV);
  H.check('E-V too few points: its starting guesses, P-V still its fit without errors',
    /P–V fit did not converge: its errors are infinite/.test(threeE.status)
      && /E–V fit did not converge: the values shown are its starting guesses/.test(threeE.status)
      && threeE.shown && threeE.evShown, JSON.stringify(threeE));

  // A fit that cannot run at all (here: the Python call throws). Before the
  // failure the previous file's tables must already be gone.
  await load(page, 'good.dat', GOOD);
  await page.evaluate(async () => {
    const pyodide = await (await import('./eos/eosFit.js')).ensurePyodideReady();
    const run = pyodide.runPythonAsync;
    pyodide.runPythonAsync = async () => {
      window.__eosShownDuringFit = !document.querySelector('#cvPanelBody-eos .eos-results').hidden;
      pyodide.runPythonAsync = run;
      throw new Error('simulated SciPy failure');
    };
  });
  const failed = await load(page, 'other.dat', THREE_EPV.replace('22.98', '23.5'));
  const shownDuring = await page.evaluate(() => window.__eosShownDuringFit);
  H.check('while a new file is fitted, the previous results are not shown', shownDuring === false, String(shownDuring));
  H.check('a failed fit: error status, and the previous file\'s tables are gone',
    /^Error: the fit failed/.test(failed.status) && !failed.shown, JSON.stringify(failed));
  const plotsOpen = await page.evaluate(async () => !(await import('./ui/panels/PanelManager.js')).getPanel('eosPlots').closed);
  H.check('a failed fit closes the plots window (nothing to show)', !plotsOpen, String(plotsOpen));

  const again = await load(page, 'good.dat', GOOD);
  H.check('the next good file fits and shows again', again.status === 'Fit complete.' && again.shown, JSON.stringify(again));

  // The simulated failure logs its own console.error; nothing else may. Match
  // the app's log line: Firefox prints the Error argument as just "Error".
  const other = errors.filter((e) => !/EOS SciPy fitting failed/.test(e));
  H.check('no other page errors (no JSON.parse failure)', other.length === 0, other[0] || '');
  await H.finish(browser);
})().catch(H.crash);
