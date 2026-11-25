// Bond Length and Force histograms grouped by Wyckoff site, as stacked bars,
// with CIF errors (ui/AnalysisPanels/BondLengthHistogram.js, ForceHistogram.js,
// histogramPlotly.js, histogramColors.js, wyckoffSites.js):
//
// - "Group by Wyckoff" is greyed out until the structure is in Wyckoff mode,
//   then splits the element pairs into site pairs whose counts add back up to
//   the element pairs' — and switching Wyckoff mode off falls back.
// - The charts are stacked histograms on a numeric axis, with bin-edge lines;
//   a site pair is drawn in a shade of its element pair's colour, and an
//   element pair with one site pair keeps the plain palette colour.
// - Clicking a site pair's segment highlights exactly its bonds in 3D (with
//   distance labels when "Show distances" is on) and outlines that segment in
//   the combined chart and in the pair's own card; clicking again clears.
// - A compact card's tick labels stay horizontal and clear of its axis title
//   (they used to turn vertical and run into it).
// - The Force Histogram groups by site the same way and highlights atoms.
// - α-quartz read with its CIF errors: the hover list and the distance labels
//   carry each Si–O length's s.u., 1.6047(17) Å; "Show CIF Errors" off drops it.
'use strict';
const H = require('../harness');

const ALL = 'bondLengthHistogramPlot__All_Pairs';

// α-quartz, P3₂21 (as in ciferrors.test.js): Si–O 1.6047(17) and 1.6135(12) Å.
const QUARTZ_CIF = [
  'data_quartz',
  "_symmetry_space_group_name_H-M   'P 32 2 1'",
  '_space_group_IT_number   154',
  '_cell_length_a   4.9160(1)',
  '_cell_length_b   4.9160(1)',
  '_cell_length_c   5.4054(1)',
  '_cell_angle_alpha   90',
  '_cell_angle_beta    90',
  '_cell_angle_gamma   120',
  'loop_',
  '_space_group_symop_operation_xyz',
  '  x,y,z', '  -y,x-y,z+2/3', '  -x+y,-x,z+1/3', '  y,x,-z', '  x-y,-y,-z+1/3', '  -x,-x+y,-z+2/3',
  'loop_',
  '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Si1 Si 0.4697(1) 0 0.66667',
  'O1 O 0.4135(3) 0.2669(3) 0.7858(2)',
  '',
].join('\n');

function setToggle(page, selector, on) {
  return page.evaluate(({ selector, on }) => {
    const box = /** @type {HTMLInputElement} */ (document.querySelector(selector));
    if (box.checked !== on) { box.checked = on; box.dispatchEvent(new Event('change')); }
  }, { selector, on });
}

/** Card keys and bond counts, combined card first. */
function cards(page) {
  return page.evaluate(() => [...document.querySelectorAll('.blh-pair-card')].map((c) => ({
    key: c.dataset.pair,
    count: parseInt(c.querySelector('.blh-pair-count').textContent, 10),
    collapsed: c.classList.contains('collapsed'),
  })));
}

function expandCard(page, key) {
  return page.evaluate((key) => {
    const card = [...document.querySelectorAll('.blh-pair-card')].find((c) => c.dataset.pair === key);
    if (card?.classList.contains('collapsed')) /** @type {HTMLElement} */ (card.querySelector('.blh-collapse-toggle')).click();
    return !!card;
  }, key);
}

function plotIdFor(key) {
  return `bondLengthHistogramPlot__${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** Click series `name`'s first non-empty bar in plot `plotId`, the way a
 *  Plotly click reaches the handler. */
function clickBar(page, plotId, name) {
  return page.evaluate(({ plotId, name }) => {
    const el = /** @type {any} */ (document.getElementById(plotId));
    const trace = el.data.find((t) => t.name === name);
    const k = trace.customdata.findIndex((c) => c?.length);
    el.emit('plotly_click', { points: [{ data: trace, pointIndex: k, customdata: trace.customdata[k] }] });
    return { k, ids: trace.customdata[k].length };
  }, { plotId, name });
}

async function highlightState(page) {
  return page.evaluate(async () => {
    const { app, highlightHover } = await import('./state/store.js');
    return {
      bonds: (highlightHover.currentlyHighlightedBondInstances ?? []).length,
      atoms: (highlightHover.currentlyHighlightedAtomInstances ?? []).length,
      labels: app.scene.children.filter((o) => o.isCSS2DObject && o.element.classList.contains('bond-distance-label'))
        .map((o) => o.element.textContent),
    };
  });
}

/** Outline widths of series `name` in plot `plotId` (2.5 marks the selected bar). */
function outline(page, plotId, name) {
  return page.evaluate(({ plotId, name }) => {
    const el = /** @type {any} */ (document.getElementById(plotId));
    const w = el?.data?.find((t) => t.name === name)?.marker?.line?.width;
    return Array.isArray(w) ? w.indexOf(2.5) : -1;
  }, { plotId, name });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  await page.evaluate(async () => {
    const { addBondLengthHistogramPanel } = await import('./ui/AnalysisPanels/BondLengthHistogram.js');
    addBondLengthHistogramPanel();
  });
  await page.waitForTimeout(800);

  // --- Outside Wyckoff mode the toggle is greyed out --------------------------
  const off = await page.evaluate(() => {
    const box = /** @type {HTMLInputElement} */ (document.querySelector('.blh-wyckoff-toggle'));
    return { disabled: box.disabled, checked: box.checked, title: document.querySelector('.blh-wyckoff-row').getAttribute('title') };
  });
  H.check('"Group by Wyckoff" is greyed out outside Wyckoff mode: "Activate Wyckoff mode to use this feature"',
    off.disabled && !off.checked && /^Activate Wyckoff mode to use this feature/.test(off.title || ''), JSON.stringify(off));
  const elementCards = await cards(page);

  // --- Wyckoff mode: grouping by site pair ---------------------------------------
  await page.evaluate(async () => {
    const sym = await import('./ui/SymmetryEditModule.js');
    const { fileBrowser } = await import('./state/store.js');
    await sym.activateWyckoffMode(fileBrowser.selectedStructure);
  });
  await page.waitForTimeout(500);
  const enabled = await page.evaluate(() => !/** @type {HTMLInputElement} */ (document.querySelector('.blh-wyckoff-toggle')).disabled);
  H.check('Wyckoff mode on enables the toggle (the window hears about it while open)', enabled);
  await setToggle(page, '.blh-wyckoff-toggle', true);
  await setToggle(page, '.blh-distances-toggle', true);
  await page.waitForTimeout(500);
  const siteCards = await cards(page);
  const siteKeys = siteCards.slice(1).map((c) => c.key);
  // Every site pair "Xn (..) – Ym (..)" belongs to the element pair of its two sites.
  const elementOf = (site) => site.match(/^[A-Z][a-z]?/)[0];
  const sums = {};
  for (const c of siteCards.slice(1)) {
    const [a, b] = c.key.split(' – ').map(elementOf).sort((p, q) => p.localeCompare(q));
    sums[`${a}-${b}`] = (sums[`${a}-${b}`] ?? 0) + c.count;
  }
  const matches = elementCards.slice(1).every((c) => sums[c.key] === c.count)
    && Object.keys(sums).length === elementCards.length - 1;
  H.check('one card per Wyckoff site pair, e.g. "Cu1 (2q) – O2 (2s)"',
    siteKeys.length > elementCards.length - 1 && siteKeys.every((k) => /^[A-Z][a-z]?\d+ \(\d+[a-z]\) – [A-Z][a-z]?\d+ \(\d+[a-z]\)$/.test(k)),
    siteKeys.join(' | '));
  H.check('site-pair counts add up to the element-pair counts', matches,
    `${JSON.stringify(sums)} vs ${JSON.stringify(elementCards.map((c) => [c.key, c.count]))}`);
  H.check('the combined card still counts every bond', siteCards[0].count === elementCards[0].count,
    `${siteCards[0].count} vs ${elementCards[0].count}`);

  // --- Stacked, numeric, coloured by element pair ----------------------------------
  await expandCard(page, 'All Pairs');
  const cuO = siteKeys.find((k) => /^Cu1 .* – O2 /.test(k));
  await expandCard(page, cuO);
  await H.waitFor(page, () => !!(/** @type {any} */ (document.getElementById('bondLengthHistogramPlot__All_Pairs')))?.data?.length);
  await page.waitForTimeout(800);
  const chart = await page.evaluate((id) => {
    const el = /** @type {any} */ (document.getElementById(id));
    return {
      barmode: el.layout.barmode,
      xtype: el.layout.xaxis.type,
      edges: (el.layout.shapes ?? []).length,
      traces: el.data.map((t) => ({ name: t.name, group: t.legendgroup, color: t.marker.color })),
    };
  }, ALL);
  H.check('the combined chart is a stacked histogram on a numeric axis with bin-edge lines',
    chart.barmode === 'stack' && chart.xtype === 'linear' && chart.edges > 3, JSON.stringify({ ...chart, traces: chart.traces.length }));
  const families = {};
  for (const t of chart.traces) (families[t.group] ??= []).push(t.color);
  const cuOColors = families['Cu-O'] ?? [];
  const singles = Object.entries(families).filter(([, c]) => c.length === 1).map(([g, c]) => [g, c[0]]);
  const pairOrder = elementCards.slice(1).map((c) => c.key);
  const expected = await page.evaluate(async (pairs) => {
    const { paletteColor } = await import('./ui/AnalysisPanels/histogramColors.js');
    return Object.fromEntries(pairs.map((p, i) => [p, paletteColor(i, pairs.length)]));
  }, pairOrder);
  H.check('site pairs of one element pair are distinct shades, grouped under it in the legend',
    cuOColors.length >= 2 && new Set(cuOColors).size === cuOColors.length, JSON.stringify(families));
  H.check('an element pair with a single site pair keeps its element pair\'s plain colour (spread over the map)',
    singles.length > 0 && singles.every(([g, c]) => c === expected[g]), `${JSON.stringify(singles)} vs ${JSON.stringify(expected)}`);

  // --- Light/dark is per chart: each card's own 🌓, no window-wide switch ----------------
  const paper = (id) => page.evaluate((id) => (/** @type {any} */ (document.getElementById(id)))._fullLayout.paper_bgcolor, id);
  await page.evaluate((key) => {
    const card = [...document.querySelectorAll('.blh-pair-card')].find((c) => c.dataset.pair === key);
    /** @type {HTMLElement} */ (card.querySelector('[data-split-action="theme"]')).click();
  }, cuO);
  await page.waitForTimeout(800);
  const themed = { card: await paper(plotIdFor(cuO)), all: await paper(ALL),
    globalBtn: await page.evaluate(() => !!document.querySelector('.blh-theme-btn')) };
  await page.evaluate((key) => {
    const card = [...document.querySelectorAll('.blh-pair-card')].find((c) => c.dataset.pair === key);
    /** @type {HTMLElement} */ (card.querySelector('[data-split-action="theme"]')).click();
  }, cuO);
  await page.waitForTimeout(800);
  H.check('a card\'s own 🌓 switches only that chart to light (and back); no window-wide switch',
    themed.card === '#ffffff' && themed.all !== '#ffffff' && !themed.globalBtn && (await paper(plotIdFor(cuO))) !== '#ffffff',
    JSON.stringify(themed));

  // --- Click a site pair: highlight, labels, outline; click again clears -------------
  const click = await clickBar(page, ALL, cuO);
  await page.waitForTimeout(800);
  const lit = await highlightState(page);
  H.check('clicking a site pair\'s segment highlights exactly its bonds in 3D',
    click.ids > 0 && lit.bonds === click.ids, `${JSON.stringify(click)} lit=${lit.bonds}`);
  H.check('"Show distances" labels the highlighted bonds', lit.labels.length > 0 && lit.labels.every((t) => /^\d\.\d{3} Å$/.test(t)),
    JSON.stringify(lit.labels));
  const outAll = await outline(page, ALL, cuO);
  const outCard = await outline(page, plotIdFor(cuO), cuO);
  H.check('the clicked segment is outlined in the combined chart and in its own card',
    outAll === click.k && outCard >= 0, `all=${outAll} card=${outCard} k=${click.k}`);
  await clickBar(page, plotIdFor(cuO), cuO);
  await page.waitForTimeout(800);
  const cleared = await highlightState(page);
  H.check('clicking the same bar again (in the pair\'s own card) clears highlight, labels and outline',
    cleared.bonds === 0 && cleared.labels.length === 0 && (await outline(page, ALL, cuO)) === -1, JSON.stringify(cleared));

  // --- Cleared from elsewhere (a click on empty space in 3D): outline and labels go ----
  await clickBar(page, ALL, cuO);
  await page.waitForTimeout(600);
  const relit = await highlightState(page);
  await page.evaluate(async () => (await import('./ui/SelectAndHighlightModule.js')).clearAllHighlights());
  await page.waitForTimeout(800);
  const elsewhere = await highlightState(page);
  H.check('clearing the highlight elsewhere drops the outline and the distance labels',
    relit.bonds > 0 && relit.labels.length > 0 && elsewhere.bonds === 0 && elsewhere.labels.length === 0
      && (await outline(page, ALL, cuO)) === -1 && (await outline(page, plotIdFor(cuO), cuO)) === -1,
    `before=${JSON.stringify(relit)} after=${JSON.stringify(elsewhere)}`);
  const reclick = await clickBar(page, ALL, cuO);
  await page.waitForTimeout(600);
  H.check('…and the next click on that bar highlights it again (not a stale toggle-off)',
    (await highlightState(page)).bonds === reclick.ids && (await outline(page, ALL, cuO)) === reclick.k);
  await clickBar(page, ALL, cuO); // clear for what follows
  await page.waitForTimeout(400);

  // --- A compact card's tick labels are horizontal and clear of the axis title -------
  const ticks = await page.evaluate((id) => {
    const el = document.getElementById(id);
    const plotBox = el.getBoundingClientRect();
    const title = el.querySelector('.g-xtitle text')?.getBoundingClientRect();
    const texts = [...el.querySelectorAll('.xtick text')].filter((t) => t.getBoundingClientRect().width);
    const labels = texts.map((t) => t.getBoundingClientRect());
    const vertical = texts.some((t) => /rotate\((?!0[,)])/.test(t.getAttribute('transform') || ''));
    const overlapTitle = labels.some((r) => title && r.bottom > title.top + 0.5 && r.right > title.left && r.left < title.right);
    const overlapEach = labels.some((r, i) => labels.slice(i + 1).some((q) => r.right > q.left + 0.5 && q.right > r.left + 0.5));
    const inside = labels.every((r) => r.bottom <= plotBox.bottom + 0.5) && (!title || title.bottom <= plotBox.bottom + 0.5);
    return { n: labels.length, overlapTitle, overlapEach, vertical, inside, tickBottom: Math.max(...labels.map((r) => r.bottom)), titleTop: title?.top, titleH: title?.height, tickH: labels[0]?.height, plotH: plotBox.height, margin: (/** @type {any} */ (el))._fullLayout?.margin?.b };
  }, plotIdFor(cuO));
  H.check('a compact card\'s tick labels are horizontal, apart, clear of the title and inside the card',
    ticks.n >= 3 && !ticks.overlapTitle && !ticks.overlapEach && !ticks.vertical && ticks.inside, JSON.stringify(ticks));

  // --- Force Histogram grouped by site -----------------------------------------------
  await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { Force } = await import('./model/index.js');
    const { updateForces } = await import('./render/index.js');
    const { wyckoffSites } = await import('./ui/AnalysisPanels/wyckoffSites.js');
    const s = fileBrowser.selectedStructure;
    const sites = wyckoffSites(s);
    // Equal |F| within a site, as a Wyckoff lock's symmetrised forces have.
    s.forces = s.atoms.map((_, i) => new Force({ vector: [0.1 + 0.2 * sites.ranks[i], 0, 0] }));
    general.forcesActive = true;
    updateForces();
    const { addForceHistogramPanel } = await import('./ui/AnalysisPanels/ForceHistogram.js');
    addForceHistogramPanel();
  });
  await H.waitFor(page, () => !!(/** @type {any} */ (document.getElementById('forceHistogramPlot')))?.data?.length);
  await setToggle(page, '.fh-wyckoff-toggle', true);
  await page.waitForTimeout(800);
  const force = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { wyckoffSites } = await import('./ui/AnalysisPanels/wyckoffSites.js');
    const el = /** @type {any} */ (document.getElementById('forceHistogramPlot'));
    const sites = [...new Set(wyckoffSites(fileBrowser.selectedStructure).labels)];
    return { names: el.data.map((t) => t.name), sites, barmode: el.layout.barmode, groups: [...new Set(el.data.map((t) => t.legendgroup))] };
  });
  H.check('the Force Histogram makes one stacked series per Wyckoff site, grouped by element',
    force.barmode === 'stack' && force.names.length === force.sites.length && force.sites.every((s) => force.names.includes(s))
      && force.groups.every(Boolean), JSON.stringify(force));
  const o2 = force.names.find((n) => /^O2 /.test(n));
  const fclick = await clickBar(page, 'forceHistogramPlot', o2);
  await page.waitForTimeout(500);
  const flit = await highlightState(page);
  H.check('clicking a site\'s segment highlights that site\'s atoms', fclick.ids > 0 && flit.atoms >= fclick.ids,
    `${JSON.stringify(fclick)} lit=${flit.atoms}`);
  H.check('…and outlines the segment', (await outline(page, 'forceHistogramPlot', o2)) === fclick.k);
  await page.evaluate(async () => (await import('./ui/SelectAndHighlightModule.js')).clearAllHighlights());
  await page.waitForTimeout(600);
  H.check('clearing the atom highlight elsewhere drops the force bar\'s outline',
    (await highlightState(page)).atoms === 0 && (await outline(page, 'forceHistogramPlot', o2)) === -1);

  // --- Wyckoff mode off: the toggle greys out, element pairs come back -----------------
  await page.evaluate(async () => {
    const sym = await import('./ui/SymmetryEditModule.js');
    sym.deactivateWyckoffMode();
  });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    disabled: /** @type {HTMLInputElement} */ (document.querySelector('.blh-wyckoff-toggle')).disabled,
    keys: [...document.querySelectorAll('.blh-pair-card')].map((c) => c.dataset.pair),
    forceNames: (/** @type {any} */ (document.getElementById('forceHistogramPlot'))).data.map((t) => t.name),
  }));
  H.check('Wyckoff mode off: toggle disabled, element-pair cards and element series again',
    after.disabled && after.keys.join('|') === elementCards.map((c) => c.key).join('|')
      && after.forceNames.every((n) => /^[A-Z][a-z]?$/.test(n)), JSON.stringify(after));

  // --- α-quartz with its CIF errors -------------------------------------------------
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    window.__cifLoad = cv.loadStructure(text, 'quartz.cif');
  }, QUARTZ_CIF);
  await page.waitForFunction(() => { const m = document.getElementById('cifSymmetryModal'); return !!m && !m.hidden; },
    null, { timeout: 30000, polling: 250 });
  await page.evaluate(() => {
    // Ticked whatever the remembered default is.
    const read = /** @type {HTMLInputElement} */ (document.getElementById('cifSymmetryModalErrors'));
    if (!read.checked) read.click();
    [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')].find((b) => /Keep symmetry/.test(b.textContent || '')).click();
  });
  await page.evaluate(async () => { await window.__cifLoad; });
  await page.waitForTimeout(1500);
  const qCards = await cards(page);
  // Sites sort by element as the Wyckoff tab does, so O comes first ("O-Si").
  const siO = qCards.find((c) => /^O1 \(\d+[a-z]\) – Si1 \(\d+[a-z]\)$/.test(c.key))?.key;
  H.check('quartz (kept in its symmetry) groups straight away: the toggle stays on', !!siO, JSON.stringify(qCards.map((c) => c.key)));
  await expandCard(page, 'All Pairs');
  await page.waitForTimeout(1000);
  const hover = () => page.evaluate((id) => {
    const el = /** @type {any} */ (document.getElementById(id));
    return el.data.flatMap((t) => t.hovertext.filter((h) => /bond/.test(h) && !/0 bonds/.test(h)));
  }, ALL);
  const withErr = await hover();
  H.check('the hover list writes Si–O lengths with their s.u. (1.6047(17) and 1.6135(12) Å)',
    withErr.some((h) => /1\.6047\(17\) Å/.test(h)) && withErr.some((h) => /1\.6135\(12\) Å/.test(h)), withErr.join(' || ').slice(0, 400));
  const qclick = await clickBar(page, ALL, siO);
  await page.waitForTimeout(800);
  const qlit = await highlightState(page);
  H.check('the distance labels carry the s.u. too', qclick.ids > 0 && qlit.labels.length > 0
    && qlit.labels.every((t) => /^1\.6(047\(17\)|135\(12\)) Å$/.test(t)), JSON.stringify(qlit.labels));
  await page.evaluate(async () => (await import('./ui/CifErrorsDisplay.js')).setCifErrorsShown(false));
  await page.waitForTimeout(1000);
  const noErr = await hover();
  const qlit2 = await highlightState(page);
  H.check('"Show CIF Errors" off: plain three-decimal lengths in the hover list and the labels',
    noErr.length > 0 && noErr.every((h) => !/\d\(\d+\) Å/.test(h)) && noErr.some((h) => /1\.605 Å/.test(h))
      && qlit2.labels.length > 0 && qlit2.labels.every((t) => /^1\.6\d\d Å$/.test(t)), `${noErr[0]} | ${JSON.stringify(qlit2.labels)}`);
  await page.evaluate(async () => (await import('./ui/CifErrorsDisplay.js')).setCifErrorsShown(true));

  // --- Two species take the two ends of the colour map ---------------------------------
  await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { Force } = await import('./model/index.js');
    const { updateForces } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    s.forces = s.atoms.map((_, i) => new Force({ vector: [0.2 + 0.1 * (i % 3), 0, 0] }));
    general.forcesActive = true;
    updateForces();
  });
  await setToggle(page, '.fh-wyckoff-toggle', false);
  await page.waitForTimeout(800);
  const two = await page.evaluate(async () => {
    const { HISTOGRAM_COLORS } = await import('./ui/AnalysisPanels/histogramColors.js');
    const el = /** @type {any} */ (document.getElementById('forceHistogramPlot'));
    return { colors: el.data.map((t) => t.marker.color), names: el.data.map((t) => t.name), ends: [HISTOGRAM_COLORS[0], HISTOGRAM_COLORS[7]] };
  });
  H.check('two species (Si, O) take the two ends of the colour map, not two neighbouring navies',
    two.names.length === 2 && two.colors[0] === two.ends[0] && two.colors[1] === two.ends[1], JSON.stringify(two));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
