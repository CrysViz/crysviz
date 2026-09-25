// Lattice Analysis: the cell-parameter plots of a trajectory or of the checked
// Files-table rows, and their wiring.
//
// Plotly is stubbed at the network layer (page.route on the esm.sh module
// URL): the checks here are about what the windows hand to Plotly — traces,
// customdata, axis titles, the shown-point ring — and what a plot click does,
// not about Plotly's rendering, and a CDN fetch would make the test depend on
// the network. The stub keeps Plotly's one behaviour the click wiring relies
// on: newPlot drops the div's previous listeners.
//
//   - latticeSeriesFromContainer reads a, b, c, α, β, γ, volume, energy, max
//     force and pressure of every frame of a store-backed trajectory (a
//     4-step OUTCAR with a changing cell)
//   - parseCustomAxisValues: separators, comments, wrong count, bad token
//   - both windows are unavailable on a single-frame structure and available
//     on the trajectory; expanding the controls does NOT open the plots
//     window, the "Show plots" button does
//   - the parameter table is selectable text; Copy table copies it as TSV;
//     latticeCsv/latticeTableText build the export texts
//   - dragging a chart's native resize corner sets its height (persisted in
//     panel prefs), same handle as the Bond Length Histogram cards
//   - the a/b/c card carries three traces with point-index customdata and a
//     ring on the shown frame; the single-angle cards one trace each
//   - Sort by: pressure re-titles the x axis and orders the points by it;
//     Filename is greyed for a trajectory
//   - Custom x axis: the button unfolds the form, Apply re-titles the axis
//     "Pressure (GPa)" and sorts the points by x; a wrong count is refused
//   - clicking a point shows that frame (row step box + viewer lattice), and
//     the ring follows
//   - selecting the single-frame row closes the plots window; coming back
//     reopens it with the custom axis still remembered
//   - Checked structures: the ticked rows at their shown step become the
//     points (categorical x of names), Sort by volume / filename reorders
//     them, a step-box edit moves a point, a click selects its row, unticking
//     everything drops the source
'use strict';
const H = require('../harness');

// Four ionic steps of a 2-atom cell: cubic 4.0, cubic 4.1, tetragonal
// 4.2/4.2/4.4, then the same cell sheared (b picks up an x component, so γ
// leaves 90°). Each step carries an energy, a growing force on atom 2 and a
// hydrostatic "in kB" stress. Only the lines the reader keys on are present.
const STEP = (lat, toten, fx, pkb) => [
  '  direct lattice vectors                 reciprocal lattice vectors',
  ...lat.map((row) => `     ${row.map((v) => v.toFixed(9)).join('  ')}     0.250000000  0.000000000  0.000000000`),
  '',
  ' POSITION                                       TOTAL-FORCE (eV/Angst)',
  ' -----------------------------------------------------------------------------------',
  '      0.00000      0.00000      0.00000         0.000000      0.000000      0.000000',
  `      2.00000      0.00000      0.00000         ${fx.toFixed(6)}      0.000000      0.000000`,
  ' -----------------------------------------------------------------------------------',
  '    total drift:                                0.000000      0.000000      0.000000',
  '',
  `  in kB      ${pkb.toFixed(2)}     ${pkb.toFixed(2)}     ${pkb.toFixed(2)}      0.00      0.00      0.00`,
  '',
  '  FREE ENERGIE OF THE ION-ELECTRON SYSTEM (eV)',
  '  ---------------------------------------------------',
  `  free  energy   TOTEN  =      ${toten.toFixed(8)} eV`,
  '',
];
const HEADER = [
  ' vasp.6.4.2 20Jul23 complex',
  ' POTCAR:    PAW_PBE Na_pv 19Sep2006',
  ' POTCAR:    PAW_PBE Cl 06Sep2000',
  '   ions per type =               1   1',
  '',
];
const LATTICES = [
  [[4.0, 0, 0], [0, 4.0, 0], [0, 0, 4.0]],
  [[4.1, 0, 0], [0, 4.1, 0], [0, 0, 4.1]],
  [[4.2, 0, 0], [0, 4.2, 0], [0, 0, 4.4]],
  [[4.2, 0, 0], [0.4, 4.2, 0], [0, 0, 4.4]],
];
const OUTCAR = [...HEADER, ...LATTICES.flatMap((lat, i) => STEP(lat, -10 - i, -0.1 * (i + 1), 10 * (i + 1)))].join('\n');
const GAMMA_SHEARED = Math.acos(0.4 / Math.hypot(0.4, 4.2)) * 180 / Math.PI;

const PLOTLY_STUB = `
const stub = {
  newPlot(target, data, layout) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    el.data = data; el.layout = layout;
    const handlers = {};
    el.on = (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); };
    el.emit = (ev, arg) => { (handlers[ev] || []).forEach((cb) => cb(arg)); };
    el.innerHTML = '<div class="js-plotly-plot"></div>';
    return Promise.resolve(el);
  },
  react(...args) { return stub.newPlot(...args); },
  purge(target) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (el) { el.innerHTML = ''; el.data = null; el.layout = null; }
  },
  relayout() { return Promise.resolve(); },
  extendTraces() {},
  toImage() { return Promise.resolve('data:image/png;base64,'); },
  Plots: { resize() {} },
};
export default stub;
`;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.route(/esm\.sh\/plotly/, (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: PLOTLY_STUB,
  }));
  await H.loadDefaultStructure(page); // YBCO, one frame

  const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) < tol;
  const seq = (arr, want, tol) => Array.isArray(arr) && arr.length === want.length && want.every((v, i) => near(arr[i], v, tol));

  // Reads what the a/b/c card was handed, plus the controls' state.
  const readAbc = () => page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const { getCustomAxis } = await import('./ui/LatticeAnalysisPanel.js');
    const abc = document.getElementById('lattice-abc-plot');
    const body = document.getElementById('cvPanelBody-latticeAnalysis');
    const traces = (abc?.data ?? []).filter((t) => t.mode === 'lines+markers');
    const rings = (abc?.data ?? []).filter((t) => t.mode === 'markers');
    const disabledSort = [...(body?.querySelectorAll('#laSortBy option:disabled') ?? [])].map((o) => o.value);
    return {
      plotsOpen: !getPanel('latticePlots').closed,
      avail: getPanel('latticeAnalysis').available,
      names: traces.map((t) => t.name),
      x: traces[0]?.x ?? null,
      y: traces[0]?.y ?? null,
      custom: traces[0]?.customdata ?? null,
      text: traces[0]?.text ?? null,
      xTitle: abc?.layout?.xaxis?.title?.text ?? null,
      rings: rings.length,
      ringX: rings[0]?.x ?? null,
      shapeX: abc?.layout?.shapes?.[0]?.x0 ?? null,
      status: body?.querySelector('#laStatus')?.textContent ?? '',
      isError: !!body?.querySelector('#laStatus')?.classList.contains('la-status-error'),
      sourceName: body?.querySelector('#laSourceName')?.textContent ?? '',
      sourceMeta: body?.querySelector('#laSourceMeta')?.textContent ?? '',
      sourceValue: body?.querySelector('#laSource')?.value ?? null,
      sortValue: body?.querySelector('#laSortBy')?.value ?? null,
      disabledSort,
      stored: getCustomAxis()?.values ?? null,
      shownCell: body?.querySelector('#laTableBody tr td:nth-child(2)')?.textContent ?? null,
    };
  });

  // ---- 1. availability + the pure pieces --------------------------------------
  const pure = await page.evaluate(async ({ outcar }) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { latticeSeriesFromContainer, parseCustomAxisValues, customAxisTitle } = await import('./lattice/latticeSeries.js');

    const beforeAvail = getPanel('latticeAnalysis').available;
    await cv.loadStructure(outcar, 'OUTCAR_cell');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const series = await latticeSeriesFromContainer(container);

    const parse = (text, n, noun) => {
      try { return parseCustomAxisValues(text, n, noun); } catch (e) { return `ERR ${e.message}`; }
    };
    return {
      beforeAvail,
      afterAvail: getPanel('latticeAnalysis').available,
      plotsAvail: getPanel('latticePlots').available,
      frameCount: container.structures.length,
      series,
      parsed: {
        spaces: parse('0 5 10 15', 4),
        mixed: parse('0, 5;10\n15 # comment\n# 99', 4),
        short: parse('1 2 3', 4),
        shortStructures: parse('1 2', 3, 'structure'),
        bad: parse('1 2 x 4', 4),
        empty: parse('   ', 4),
      },
      title: [customAxisTitle('Pressure', 'GPa'), customAxisTitle('Pressure', ''), customAxisTitle('', 'K')],
    };
  }, { outcar: OUTCAR });

  H.check('windows unavailable on a single-frame structure, available on the trajectory',
    pure.beforeAvail === false && pure.afterAvail === true && pure.plotsAvail === true,
    JSON.stringify([pure.beforeAvail, pure.afterAvail, pure.plotsAvail]));
  H.check('trajectory has 4 frames', pure.frameCount === 4, String(pure.frameCount));
  const s = pure.series;
  H.check('a series follows the cell: 4.0 4.1 4.2 4.2', seq(s?.a, [4.0, 4.1, 4.2, 4.2]), JSON.stringify(s?.a));
  H.check('c series follows the cell: 4.0 4.1 4.4 4.4', seq(s?.c, [4.0, 4.1, 4.4, 4.4]), JSON.stringify(s?.c));
  H.check('γ is 90° until the sheared frame',
    s && near(s.gamma[0], 90) && near(s.gamma[2], 90) && near(s.gamma[3], GAMMA_SHEARED, 1e-6)
      && near(s.alpha[3], 90) && near(s.beta[3], 90),
    JSON.stringify([s?.gamma, GAMMA_SHEARED]));
  H.check('volume of the sheared frame equals the unsheared (shear preserves volume)',
    s && near(s.volume[3], 4.2 * 4.2 * 4.4) && near(s.volume[0], 64), JSON.stringify(s?.volume));
  H.check('per-frame energy, max force and pressure (trace/3) are read too',
    seq(s?.energy, [-10, -11, -12, -13]) && seq(s?.maxForce, [0.1, 0.2, 0.3, 0.4]) && seq(s?.pressure, [10, 20, 30, 40]),
    JSON.stringify([s?.energy, s?.maxForce, s?.pressure]));
  const p = pure.parsed;
  H.check('parser: whitespace-separated values', JSON.stringify(p.spaces) === '[0,5,10,15]', JSON.stringify(p.spaces));
  H.check('parser: commas, semicolons, newlines and # comments', JSON.stringify(p.mixed) === '[0,5,10,15]', JSON.stringify(p.mixed));
  H.check('parser: wrong count is refused with the counts named',
    typeof p.short === 'string' && /4 frames, got 3 values/.test(p.short), String(p.short));
  H.check('parser: the noun follows the source',
    typeof p.shortStructures === 'string' && /3 structures, got 2 values/.test(p.shortStructures), String(p.shortStructures));
  H.check('parser: a non-number is named', typeof p.bad === 'string' && /"x"/.test(p.bad), String(p.bad));
  H.check('parser: empty input is refused', typeof p.empty === 'string' && /No x values/.test(p.empty), String(p.empty));
  H.check('axis title composes label and unit',
    pure.title[0] === 'Pressure (GPa)' && pure.title[1] === 'Pressure' && pure.title[2] === 'x (K)', JSON.stringify(pure.title));

  // ---- 2. the controls build; "Show plots" opens + draws the plots -------------
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('latticeAnalysis').expand();
  });
  await page.waitForTimeout(600);
  const builtOnly = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const body = document.getElementById('cvPanelBody-latticeAnalysis');
    return {
      plotsClosed: getPanel('latticePlots').closed,
      tableRows: body?.querySelectorAll('#laTableBody tr').length ?? -1,
      buttonsMini: [...body.querySelectorAll('button.la-btn')].every((b) => b.classList.contains('btn-mini')),
      nButtons: body.querySelectorAll('button.la-btn').length,
    };
  });
  H.check('expanding the controls fills the table but leaves the plots window closed',
    builtOnly.plotsClosed === true && builtOnly.tableRows === 6, JSON.stringify(builtOnly));
  H.check('every button in the window is an app .btn-mini',
    builtOnly.buttonsMini && builtOnly.nButtons >= 6, JSON.stringify(builtOnly));
  await H.clickById(page, 'laShowPlotsBtn');
  const drawn = await H.waitFor(page, async () => {
    const el = document.getElementById('lattice-abc-plot');
    return !!(el && el.data && el.data.length >= 3);
  }, { timeout: 15000, interval: 300 });
  H.check('a/b/c chart drawn after "Show plots"', !!drawn);

  const ui = await page.evaluate(async () => {
    const angles = document.getElementById('lattice-angles-plot');
    const alpha = document.getElementById('lattice-alpha-plot');
    const dataTraces = (el) => (el?.data ?? []).filter((t) => t.mode === 'lines+markers');
    const body = document.getElementById('cvPanelBody-latticeAnalysis');
    return {
      anglesNames: dataTraces(angles).map((t) => t.name),
      alphaNames: dataTraces(alpha).map((t) => t.name),
      alphaLegend: alpha?.layout?.showlegend,
      cardCount: document.querySelectorAll('#cvPanelBody-latticePlots .split-item').length,
      tableRows: body?.querySelectorAll('#laTableBody tr').length ?? -1,
      formHidden: body?.querySelector('#laCustomAxis')?.hidden,
    };
  });
  const first = await readAbc();
  H.check('plots window opened by the button', first.plotsOpen);
  H.check('five plot cards', ui.cardCount === 5, String(ui.cardCount));
  H.check('a/b/c card carries the three length traces', JSON.stringify(first.names) === '["a","b","c"]', JSON.stringify(first.names));
  H.check('points carry the frame index as customdata, frame number as x, frame labels for hover',
    JSON.stringify(first.custom) === '[0,1,2,3]' && JSON.stringify(first.x) === '[1,2,3,4]' && first.xTitle === 'Frame'
      && JSON.stringify(first.text) === '["frame 1","frame 2","frame 3","frame 4"]',
    JSON.stringify([first.custom, first.x, first.xTitle, first.text]));
  H.check('the shown frame (the last one, after the load) is ringed on each series + guided',
    first.rings === 3 && JSON.stringify(first.ringX) === '[4]' && first.shapeX === 4,
    JSON.stringify([first.rings, first.ringX, first.shapeX]));
  H.check('angles card carries α β γ, the α card just α without a legend',
    JSON.stringify(ui.anglesNames) === '["α","β","γ"]' && JSON.stringify(ui.alphaNames) === '["α"]' && ui.alphaLegend === false,
    JSON.stringify([ui.anglesNames, ui.alphaNames, ui.alphaLegend]));
  H.check('controls show the trajectory source and a 6-row parameter table',
    ui.tableRows === 6 && first.sourceName === 'OUTCAR_cell' && /4 frames/.test(first.sourceMeta) && /x axis: frame/.test(first.sourceMeta)
      && first.sourceValue === 'trajectory',
    JSON.stringify([ui.tableRows, first.sourceName, first.sourceMeta, first.sourceValue]));
  H.check('custom-axis form starts folded', ui.formHidden === true, String(ui.formHidden));
  H.check('Sort by offers the frame properties, Filename greyed for a trajectory',
    JSON.stringify(first.disabledSort) === '["name"]' && first.sortValue === 'order', JSON.stringify([first.disabledSort, first.sortValue]));

  // ---- 3. sort by a per-frame property ---------------------------------------
  await H.setSelect(page, 'laSortBy', 'pressure');
  await page.waitForTimeout(300);
  const byPressure = await readAbc();
  H.check('Sort by pressure makes pressure the x axis',
    byPressure.xTitle === 'Pressure (GPa)' && JSON.stringify(byPressure.x) === '[10,20,30,40]'
      && JSON.stringify(byPressure.custom) === '[0,1,2,3]' && JSON.stringify(byPressure.ringX) === '[40]'
      && /x axis: pressure/.test(byPressure.sourceMeta),
    JSON.stringify([byPressure.xTitle, byPressure.x, byPressure.ringX, byPressure.sourceMeta]));
  await H.setSelect(page, 'laSortBy', 'energy');
  await page.waitForTimeout(300);
  const byEnergy = await readAbc();
  H.check('Sort by energy orders the points ascending in energy (frame 4 first)',
    byEnergy.xTitle === 'Energy (eV)' && JSON.stringify(byEnergy.x) === '[-13,-12,-11,-10]'
      && JSON.stringify(byEnergy.custom) === '[3,2,1,0]' && seq(byEnergy.y, [4.2, 4.2, 4.1, 4.0]),
    JSON.stringify([byEnergy.xTitle, byEnergy.x, byEnergy.custom, byEnergy.y]));
  await H.setSelect(page, 'laSortBy', 'order');

  // ---- 3b. copyable table, CSV, resizable cards -------------------------------
  const table = await page.evaluate(async () => {
    const { latticeCsv, latticeTableText, latticeSeriesFromContainer } = await import('./lattice/latticeSeries.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const series = await latticeSeriesFromContainer(container);
    const csv = latticeCsv({
      labels: ['frame 1', 'frame 2', 'frame 3', 'frame 4'], steps: [0, 1, 2, 3], series,
      customAxis: { values: [0, 5, 10, 15], label: 'Pressure', unit: 'GPa' },
    });
    const tsv = latticeTableText(series, 2);
    // Clipboard: stub writeText so the click paths can be observed headless.
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } },
    });
    const body = document.getElementById('cvPanelBody-latticeAnalysis');
    const cell = body.querySelector('#laTableBody tr:nth-child(3) td:nth-child(2)'); // c, shown
    cell.click();
    await new Promise((r) => setTimeout(r, 50));
    const selectable = getComputedStyle(cell).userSelect === 'text';
    const clickCopied = copied.length; // must stay 0
    body.querySelector('#laCopyTableBtn').click();
    await new Promise((r) => setTimeout(r, 50));
    const copyStatus = body.querySelector('#laStatus').textContent;
    // CSV export: capture the anchor download instead of saving a file.
    let download = null;
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { download = this.download; };
    body.querySelector('#laExportCsvBtn').click();
    await new Promise((r) => setTimeout(r, 50));
    HTMLAnchorElement.prototype.click = origClick;
    return {
      csvLines: csv.trim().split('\n'), tsv, selectable, clickCopied, copied, download, copyStatus, status: body.querySelector('#laStatus').textContent,
    };
  });
  const csvRow3 = table.csvLines[3]?.split(',') ?? [];
  const csvNums = csvRow3.slice(2).map(Number);
  H.check('latticeCsv: header names every column with its unit, one row per point',
    table.csvLines.length === 5
      && table.csvLines[0] === 'point,frame,energy (eV),max force (eV/Å),pressure (GPa),volume (Å³),Pressure (GPa),a (Å),b (Å),c (Å),alpha (deg),beta (deg),gamma (deg)'
      && csvRow3[0] === 'frame 3' && csvRow3[1] === '3'
      && seq(csvNums, [-12, 0.3, 30, 4.2 * 4.2 * 4.4, 10, 4.2, 4.2, 4.4, 90, 90, 90], 1e-9),
    JSON.stringify(table.csvLines));
  H.check('latticeTableText: tab-separated with header, shown column = frame 3',
    table.tsv.split('\n')[0] === '\tShown\tMin\tMax\tUnit' && table.tsv.split('\n')[3] === 'c\t4.4000\t4.0000\t4.4000\tÅ',
    JSON.stringify(table.tsv));
  H.check('table cells are selectable text (a click copies nothing); Copy table copies the TSV',
    table.selectable && table.clickCopied === 0 && table.copied[0]?.startsWith('\tShown\tMin\tMax\tUnit')
      && /Table copied/.test(table.copyStatus),
    JSON.stringify([table.selectable, table.clickCopied, table.copied, table.copyStatus]));
  H.check('Export CSV downloads lattice_<name>.csv',
    table.download === 'lattice_OUTCAR_cell.csv' && /Exported 4 points/.test(table.status), JSON.stringify([table.download, table.status]));
  // Resize: a real mouse drag on the a/b/c chart's native resize corner.
  const plotBox = await page.evaluate(() => {
    const r = document.getElementById('lattice-abc-plot').getBoundingClientRect();
    return { right: r.right, bottom: r.bottom, height: r.height };
  });
  await page.mouse.move(plotBox.right - 4, plotBox.bottom - 4);
  await page.mouse.down();
  await page.mouse.move(plotBox.right - 4, plotBox.bottom + 30, { steps: 5 });
  await page.mouse.move(plotBox.right - 4, plotBox.bottom + 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(600); // observer + debounced pref write
  const resized = await page.evaluate(async () => {
    const { plotHeight } = await import('./ui/LatticePlotsPanel.js');
    return {
      height: document.getElementById('lattice-abc-plot').getBoundingClientRect().height,
      inline: plotHeight('lattice-abc-plot'),
      pref: JSON.parse(localStorage.getItem('panelPrefs') || '{}').latticePlotHeights,
    };
  });
  H.check('dragging the chart\'s resize corner makes it taller and the height is remembered',
    resized.height > plotBox.height + 40 && resized.inline !== null
      && resized.pref && Math.abs(resized.pref['lattice-abc-plot'] - resized.inline) < 1.5,
    JSON.stringify([plotBox.height, resized]));

  // ---- 4. custom x axis --------------------------------------------------------
  const setAxis = async (values, label, unit) => {
    await page.evaluate(({ values, label, unit }) => {
      const body = document.getElementById('cvPanelBody-latticeAnalysis');
      body.querySelector('#laAxisValues').value = values;
      body.querySelector('#laAxisLabel').value = label;
      body.querySelector('#laAxisUnit').value = unit;
      body.querySelector('#laAxisApplyBtn').click();
    }, { values, label, unit });
    await page.waitForTimeout(400);
    return readAbc();
  };

  await H.clickById(page, 'laCustomAxisBtn');
  const unfolded = await page.evaluate(() => {
    const body = document.getElementById('cvPanelBody-latticeAnalysis');
    return {
      hidden: body.querySelector('#laCustomAxis').hidden,
      pressed: body.querySelector('#laCustomAxisBtn').getAttribute('aria-expanded'),
    };
  });
  H.check('"Custom x axis" unfolds the form', unfolded.hidden === false && unfolded.pressed === 'true', JSON.stringify(unfolded));

  const applied = await setAxis('0 5 10 15', 'Pressure', 'GPa');
  H.check('Apply re-titles the x axis with label and unit',
    applied.xTitle === 'Pressure (GPa)' && !applied.isError && /Pressure \(GPa\)/.test(applied.status) && /custom x axis: Pressure \(GPa\)/.test(applied.sourceMeta),
    JSON.stringify([applied.xTitle, applied.status, applied.sourceMeta]));
  H.check('points sit at the custom x values, still tagged with their frame',
    JSON.stringify(applied.x) === '[0,5,10,15]' && JSON.stringify(applied.custom) === '[0,1,2,3]' && JSON.stringify(applied.stored) === '[0,5,10,15]',
    JSON.stringify([applied.x, applied.custom, applied.stored]));

  const shuffled = await setAxis('10 0 5 15', 'P', 'kbar');
  H.check('a non-monotonic axis is drawn sorted by x, frames following their values',
    JSON.stringify(shuffled.x) === '[0,5,10,15]' && JSON.stringify(shuffled.custom) === '[1,2,0,3]'
      && shuffled.xTitle === 'P (kbar)' && near(shuffled.y[2], 4.0) && near(shuffled.y[0], 4.1),
    JSON.stringify([shuffled.x, shuffled.custom, shuffled.y]));

  const refused = await setAxis('1 2 3', 'P', 'kbar');
  H.check('a wrong value count is refused and the axis kept',
    refused.isError && /4 frames, got 3 values/.test(refused.status) && refused.xTitle === 'P (kbar)'
      && JSON.stringify(refused.stored) === '[10,0,5,15]',
    JSON.stringify([refused.status, refused.xTitle, refused.stored]));

  await setAxis('0 5 10 15', 'Pressure', 'GPa');

  // ---- 5. click a point -> that frame shows, ring follows ---------------------
  const clickPoint = async (plotId, pointIndex) => {
    const sel = await page.evaluate(async ({ plotId, pointIndex }) => {
      const { fileBrowser } = await import('./state/store.js');
      const el = document.getElementById(plotId);
      const emitOk = typeof el.emit === 'function';
      if (emitOk) el.emit('plotly_click', { points: [{ customdata: pointIndex }] });
      await new Promise((r) => setTimeout(r, 600));
      const lat = fileBrowser.selectedStructure.lattice;
      return {
        emitOk,
        rowIndex: fileBrowser.selectedRowIndex,
        step: fileBrowser.selectedRow?.querySelector('input[type="number"]')?.value ?? null,
        rowName: fileBrowser.selectedRow?.querySelector('.name-inner')?.textContent ?? null,
        a: Math.hypot(...lat[0]), c: Math.hypot(...lat[2]),
      };
    }, { plotId, pointIndex });
    return { ...sel, ...(await readAbc()) };
  };

  const third = await clickPoint('lattice-abc-plot', 2);
  H.check('clicking the third point shows frame 3 (a=4.2, c=4.4)',
    third.emitOk && third.step === '3' && third.rowName === 'OUTCAR_cell' && near(third.a, 4.2) && near(third.c, 4.4),
    JSON.stringify([third.step, third.rowName, third.a, third.c]));
  H.check('the ring and guide move to that frame\'s x (10 GPa), the table shows its a',
    JSON.stringify(third.ringX) === '[10]' && third.shapeX === 10 && third.shownCell === '4.2000',
    JSON.stringify([third.ringX, third.shapeX, third.shownCell]));
  const gammaClick = await clickPoint('lattice-gamma-plot', 0);
  H.check('a click on the γ card selects too (frame 1, a=4.0)',
    gammaClick.step === '1' && near(gammaClick.a, 4.0) && JSON.stringify(gammaClick.ringX) === '[0]',
    JSON.stringify([gammaClick.step, gammaClick.a, gammaClick.ringX]));

  // ---- 6. leaving the trajectory closes the plots; coming back reopens -------
  const away = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const { selectStructure } = await import('./ui/FileBrowswerPanel.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    // The trajectory is the selected (last-loaded) row; the app's own startup
    // structure and the harness's YBCO sit above it, both single-frame.
    const trajRow = fileBrowser.selectedRowIndex;
    const singleRow = structureShip.container.findIndex((c) => c.structures.length === 1);
    selectStructure(singleRow);
    await new Promise((r) => setTimeout(r, 500));
    const gone = { plotsClosed: getPanel('latticePlots').closed, avail: getPanel('latticeAnalysis').available };
    selectStructure(trajRow, 1);
    await new Promise((r) => setTimeout(r, 800));
    return { ...gone, trajRow };
  });
  const back = await readAbc();
  H.check('single-frame selection closes the plots window and greys the controls',
    away.plotsClosed === true && away.avail === false, JSON.stringify(away));
  H.check('re-selecting the trajectory reopens the plots with the remembered custom axis',
    back.plotsOpen && back.avail && back.xTitle === 'Pressure (GPa)' && JSON.stringify(back.x) === '[0,5,10,15]'
      && JSON.stringify(back.ringX) === '[5]',
    JSON.stringify([back.plotsOpen, back.avail, back.xTitle, back.x, back.ringX]));

  // ---- 7. checked structures as the points ------------------------------------
  const setChecked = async (checkedRows) => {
    await page.evaluate((checkedRows) => {
      document.querySelectorAll('#objectTable tbody tr').forEach((row, i) => {
        const cb = row.querySelector('input[type="checkbox"]');
        const want = checkedRows.includes(i);
        if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    }, checkedRows);
    await page.waitForTimeout(400);
  };
  const rowInfo = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    const names = [...document.querySelectorAll('#objectTable tbody tr .name-inner')].map((el) => el.textContent);
    return { names, frames: structureShip.container.map((c) => c.structures.length) };
  });
  const allRows = rowInfo.names.map((_, i) => i);
  const trajRow = away.trajRow;

  // Tick every row (the trajectory row shows frame 2 after the re-select
  // above) and switch the source.
  await setChecked(allRows);
  const stillTraj = await readAbc();
  H.check('ticking rows alone keeps the trajectory source (auto prefers it)',
    stillTraj.sourceValue === 'trajectory' && JSON.stringify(stillTraj.x) === '[0,5,10,15]', JSON.stringify([stillTraj.sourceValue, stillTraj.x]));
  await H.setSelect(page, 'laSource', 'selected');
  await page.waitForTimeout(600);
  const checked = await readAbc();
  const expectLabels = rowInfo.names.map((n, i) => (rowInfo.frames[i] > 1 ? `${n} · frame 2` : n));
  H.check('Checked structures: one point per ticked row, in table order, names on a categorical x',
    checked.sourceValue === 'selected' && JSON.stringify(checked.x) === JSON.stringify(expectLabels)
      && JSON.stringify(checked.custom) === JSON.stringify(allRows) && checked.xTitle === 'Structure'
      && checked.sourceName === `${allRows.length} checked structures` && /shown frame/.test(checked.sourceMeta),
    JSON.stringify([checked.sourceValue, checked.x, checked.custom, checked.xTitle, checked.sourceName, checked.sourceMeta]));
  H.check('the trajectory row contributes its SHOWN frame (frame 2: a=4.1)',
    near(checked.y[trajRow], 4.1), JSON.stringify(checked.y));
  H.check('the selected row is the ringed point',
    JSON.stringify(checked.ringX) === JSON.stringify([expectLabels[trajRow]]), JSON.stringify(checked.ringX));
  H.check('Filename is offered for checked structures; pressure only the OUTCAR frame carries is still offered',
    !checked.disabledSort.includes('name') && !checked.disabledSort.includes('pressure') && !checked.disabledSort.includes('volume'),
    JSON.stringify(checked.disabledSort));

  await H.setSelect(page, 'laSortBy', 'volume');
  await page.waitForTimeout(300);
  const byVolume = await readAbc();
  const ascending = Array.isArray(byVolume.x) && byVolume.x.every((v, i) => i === 0 || v >= byVolume.x[i - 1]);
  H.check('Sort by volume: numeric x, ascending, every point kept',
    byVolume.xTitle === 'Volume (Å³)' && ascending && byVolume.x.length === allRows.length && near(byVolume.x[byVolume.custom.indexOf(trajRow)], 4.1 ** 3),
    JSON.stringify([byVolume.xTitle, byVolume.x, byVolume.custom]));
  await H.setSelect(page, 'laSortBy', 'name');
  await page.waitForTimeout(300);
  const byName = await readAbc();
  const sortedLabels = [...expectLabels].sort((u, v) => u.localeCompare(v, undefined, { numeric: true, sensitivity: 'base' }));
  H.check('Sort by filename orders the categorical x alphabetically',
    JSON.stringify(byName.x) === JSON.stringify(sortedLabels) && byName.xTitle === 'Structure', JSON.stringify([byName.x, sortedLabels]));
  await H.setSelect(page, 'laSortBy', 'pressure');
  await page.waitForTimeout(300);
  const byPressureSel = await readAbc();
  H.check('Sort by a property only some points carry keeps just those points',
    JSON.stringify(byPressureSel.x) === '[20]' && JSON.stringify(byPressureSel.custom) === JSON.stringify([trajRow]),
    JSON.stringify([byPressureSel.x, byPressureSel.custom]));
  await H.setSelect(page, 'laSortBy', 'order');

  // The custom axis of this source is its own, counted in structures.
  const refusedSel = await setAxis('1 2', 'Pressure', 'GPa');
  H.check('custom axis for checked structures counts structures',
    refusedSel.isError && new RegExp(`${allRows.length} structures, got 2 values`).test(refusedSel.status), refusedSel.status);
  const appliedSel = await setAxis(allRows.map((i) => 100 - 10 * i).join(' '), 'Pressure', 'GPa');
  H.check('custom axis applies to the checked structures, sorted by value',
    appliedSel.xTitle === 'Pressure (GPa)' && JSON.stringify(appliedSel.custom) === JSON.stringify([...allRows].reverse()),
    JSON.stringify([appliedSel.xTitle, appliedSel.x, appliedSel.custom]));
  await page.evaluate(() => document.getElementById('laAxisClearBtn').click());
  await page.waitForTimeout(300);

  // A step-box edit on a checked trajectory row moves that row's point.
  await page.evaluate((trajRow) => {
    const row = document.querySelectorAll('#objectTable tbody tr')[trajRow];
    const input = row.querySelector('input[type="number"]');
    input.value = '4';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, trajRow);
  await page.waitForTimeout(600);
  const stepped = await readAbc();
  H.check('editing a checked row\'s step box moves its point to that frame (frame 4: a=4.2)',
    near(stepped.y[trajRow], 4.2) && stepped.text[trajRow] === `${rowInfo.names[trajRow]} · frame 4`,
    JSON.stringify([stepped.y, stepped.text]));

  // Clicking a point selects its row.
  const otherRow = allRows.find((i) => i !== trajRow);
  const rowClick = await clickPoint('lattice-abc-plot', otherRow);
  H.check('clicking a checked-structure point selects that row and rings it',
    rowClick.rowIndex === otherRow && rowClick.sourceValue === 'selected'
      && JSON.stringify(rowClick.ringX) === JSON.stringify([rowInfo.names[otherRow]]),
    JSON.stringify([rowClick.rowIndex, otherRow, rowClick.ringX]));

  // Two rows checked with a single-frame row selected: the checked source
  // alone keeps the windows available; unticking all drops them.
  await setChecked(allRows.filter((i) => i !== trajRow));
  const two = await readAbc();
  H.check('two checked single-frame rows keep the windows available without a trajectory',
    two.avail && two.plotsOpen && two.custom.length === allRows.length - 1, JSON.stringify([two.avail, two.plotsOpen, two.custom]));
  await setChecked([]);
  const none = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    return { avail: getPanel('latticeAnalysis').available, plotsClosed: getPanel('latticePlots').closed };
  });
  H.check('unticking every row with no trajectory selected closes the plots and greys the controls',
    none.avail === false && none.plotsClosed === true, JSON.stringify(none));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
