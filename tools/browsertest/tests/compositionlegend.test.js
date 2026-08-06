// Composition Display legend (ui/CompositionLegendPanel.js): the ❖ button in
// the Structure Info header opens a floating legend window whose sphere
// swatches are painted by the app's own atom-material pipeline, and whose
// disordered-site rows mirror wedgeDataForAtom's slots (colours + fractions).
// Collisions this guards: the panel registry (a new lazily-registered window),
// the WedgeAtoms slots contract, and the crysviz:atoms-changed refresh path
// shared with the structure editors.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  H.check('the composition header offers the legend button',
    await page.evaluate(() => !!document.getElementById('compositionLegendButton')));

  await page.evaluate(() => document.getElementById('compositionLegendButton').click());
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.cv-panel')]
      .find((p) => p.textContent.includes('Composition Display'));
    if (!panel) return null;
    return {
      floating: panel.className.includes('cv-floating'),
      rows: [...panel.querySelectorAll('.comp-legend-row')].map((r) => ({
        label: r.querySelector('.comp-legend-label')?.textContent ?? '',
        // Fraction of non-transparent pixels — a blank canvas means the GL
        // swatch renderer silently broke.
        drawn: (() => {
          const c = r.querySelector('canvas');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
          return n / (d.length / 4);
        })(),
      })),
    };
  });
  H.check('the legend opens as a floating window', !!state && state.floating, JSON.stringify(state));
  // Assert the names, not the count (composition can legitimately grow).
  for (const el of ['Ba', 'Y', 'Cu', 'O']) {
    H.check(`the legend lists ${el}`,
      state.rows.some((r) => r.label.startsWith(`${el} `)), JSON.stringify(state.rows.map((r) => r.label)));
  }
  H.check('every swatch actually drew a sphere',
    state.rows.length > 0 && state.rows.every((r) => r.drawn > 0.2),
    JSON.stringify(state.rows));

  // A disordered site must show up as one row with its species fractions —
  // driven through the same event the structure editors broadcast.
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const cv = await import('./core/crystal-viewer.js');
    const s = fileBrowser.selectedStructure;
    const ba = s.atoms.findIndex((a, i) => s.elements[i] === 'Ba');
    s.atoms[ba].species = [
      { element: 'Ba', occupancy: 0.5, color: null },
      { element: 'K', occupancy: 0.4, color: null },
    ];
    cv.updateVisualization({ reRenderAtoms: true, reRenderComposition: true });
    document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
  });
  await page.waitForTimeout(1200);

  const disordered = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.cv-panel')]
      .find((p) => p.textContent.includes('Composition Display'));
    return [...panel.querySelectorAll('.comp-legend-row')].map((r) => ({
      label: r.querySelector('.comp-legend-label')?.textContent ?? '',
      sub: r.querySelector('.comp-legend-sub')?.textContent ?? null,
    }));
  });
  const site = disordered.find((r) => r.label.includes('Ba') && r.label.includes('K'));
  H.check('a disordered site gets its own row', !!site, JSON.stringify(disordered));
  H.check('the row spells out the occupancy fractions, vacancy included',
    !!site?.sub && site.sub.includes('Ba 50%') && site.sub.includes('K 40%') && site.sub.includes('Va 10%'),
    site?.sub ?? '');

  // ---- editable text -------------------------------------------------------
  // Edits are per-row overrides and must survive the refresh events that
  // rebuild the rows.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.comp-legend-row')]
      .find((r) => r.querySelector('.comp-legend-label')?.textContent === 'O Atom');
    const label = row.querySelector('.comp-legend-label');
    label.focus();
    label.textContent = 'Oxygen (site O1)';
    label.blur();
    document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
  });
  await page.waitForTimeout(400);
  const edited = await page.evaluate(() =>
    [...document.querySelectorAll('.comp-legend-label')].map((l) => l.textContent));
  H.check('an edited label sticks across a legend refresh',
    edited.includes('Oxygen (site O1)') && !edited.includes('O Atom'), JSON.stringify(edited));

  // ---- resizable box: contents scale with the width ------------------------
  const scaled = await page.evaluate(async () => {
    const body = document.querySelector('.comp-legend-body');
    const before = document.querySelector('.comp-legend-swatch').getBoundingClientRect().width;
    body.style.width = '420px'; // what the CSS resize handle would write
    await new Promise((r) => setTimeout(r, 400)); // ResizeObserver + rAF
    return {
      before,
      after: document.querySelector('.comp-legend-swatch').getBoundingClientRect().width,
      scaleVar: getComputedStyle(body).getPropertyValue('--legend-scale').trim(),
    };
  });
  H.check('resizing the box scales the swatches',
    scaled.after > scaled.before * 1.5, JSON.stringify(scaled));

  // ---- transparent mode ----------------------------------------------------
  const transparent = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.cv-panel')]
      .find((p) => p.textContent.includes('Composition Display'));
    panel.querySelector('.cv-panel-menu-btn, [title="Window menu"]')
      ?.click?.();
    const item = [...document.querySelectorAll('.cv-panel-menu button')]
      .find((b) => b.textContent.includes('Transparent background'));
    if (!item) return { found: false, menu: [...document.querySelectorAll('.cv-panel-menu button')].map((b) => b.textContent) };
    item.click();
    const body = panel.querySelector('.cv-panel-body');
    const cs = getComputedStyle(body);
    return {
      found: true,
      classOn: panel.className.includes('comp-legend-transparent'),
      barCollapsed: panel.className.includes('cv-bar-collapsed'),
      bg: cs.backgroundColor,
      shadow: cs.boxShadow,
    };
  });
  H.check('the ≡ menu offers Transparent background and it strips the chrome',
    transparent.found && transparent.classOn
    && /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(transparent.bg)
    && transparent.shadow === 'none'
    && transparent.barCollapsed,
    JSON.stringify(transparent));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
