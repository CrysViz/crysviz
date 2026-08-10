// Composition Display legend (ui/CompositionLegendWidget.js): the ❖ button in
// the Structure Info header puts a floating legend on the scene, whose sphere
// swatches are painted by the app's own atom-material pipeline and whose
// disordered-site rows mirror wedgeDataForAtom's slots (colours + fractions).
// Collisions this guards: the colour-bar drag machinery it now shares with
// ui/ColorBarWidget.js (moving it, resizing it, putting it away), the
// WedgeAtoms slots contract, and the crysviz:atoms-changed refresh path shared
// with the structure editors.
'use strict';
const H = require('../harness');

const WIDGET = '.comp-legend-widget.cv-colorbar-floating';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  H.check('the composition header offers the legend button',
    await page.evaluate(() => !!document.getElementById('compositionLegendButton')));

  await page.evaluate(() => document.getElementById('compositionLegendButton').click());
  await page.waitForTimeout(1200);

  const state = await page.evaluate((sel) => {
    const widget = document.querySelector(sel);
    if (!widget) return null;
    const r = widget.getBoundingClientRect();
    const view = document.getElementById('view').getBoundingClientRect();
    return {
      overScene: r.left >= view.left && r.right <= view.right && r.top >= view.top && r.bottom <= view.bottom,
      rows: [...widget.querySelectorAll('.comp-legend-row')].map((row) => ({
        label: row.querySelector('.comp-legend-label')?.textContent ?? '',
        // Fraction of non-transparent pixels — a blank canvas means the GL
        // swatch renderer silently broke.
        drawn: (() => {
          const c = row.querySelector('canvas');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
          return n / (d.length / 4);
        })(),
      })),
    };
  }, WIDGET);
  H.check('the legend lands on the scene as a floating widget',
    !!state && state.overScene, JSON.stringify(state && { overScene: state.overScene }));
  // Assert the names, not the count (composition can legitimately grow).
  for (const el of ['Ba', 'Y', 'Cu', 'O']) {
    H.check(`the legend lists ${el}`,
      state.rows.some((r) => r.label === el), JSON.stringify(state.rows.map((r) => r.label)));
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

  const disordered = await page.evaluate((sel) =>
    [...document.querySelectorAll(`${sel} .comp-legend-row`)].map((r) => ({
      label: r.querySelector('.comp-legend-label')?.textContent ?? '',
      sub: r.querySelector('.comp-legend-sub')?.textContent ?? null,
    })), WIDGET);
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
      .find((r) => r.querySelector('.comp-legend-label')?.textContent === 'O');
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
    edited.includes('Oxygen (site O1)') && !edited.includes('O'), JSON.stringify(edited));

  // ---- it moves ------------------------------------------------------------
  // The whole point of the widget form: a real pointer drag from the body
  // (an extra drag handle beside the ⦀ grip) repositions it over the scene.
  const before = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  }, WIDGET);
  // Grab the body's padding corner — anywhere inside a label would put the
  // caret there instead (the labels are contenteditable).
  const grab = await page.evaluate(() => {
    const r = document.querySelector('.comp-legend-body').getBoundingClientRect();
    return { x: r.left + 4, y: r.top + 4 };
  });
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 90, grab.y + 70, { steps: 8 });
  await page.mouse.move(grab.x + 180, grab.y + 140, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  }, WIDGET);
  H.check('dragging the legend moves it across the scene',
    !!after && Math.abs(after.x - before.x) > 100 && Math.abs(after.y - before.y) > 80,
    JSON.stringify({ before, after }));

  // ---- resize: grows rightwards, scales the contents, never crops -----------
  // The legend is parked on the right half of the view by the drag above, so
  // its drag anchor is a RIGHT-edge offset — the case where re-deriving the
  // position mid-resize used to grow the box leftwards, out from under the
  // cursor.
  const scaled = await page.evaluate((sel) => ({
    swatch: document.querySelector('.comp-legend-swatch').getBoundingClientRect().width,
    left: Math.round(document.querySelector(sel).getBoundingClientRect().left),
    handle: (() => {
      const r = document.querySelector('.cv-colorbar-resize-handle').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })(),
  }), WIDGET);
  // Horizontally only: the box grows taller with the rows, and a wider drag
  // than this pushes the handle off the bottom of a 900px viewport, where the
  // next gesture can't reach it.
  await page.mouse.move(scaled.handle.x, scaled.handle.y);
  await page.mouse.down();
  await page.mouse.move(scaled.handle.x + 80, scaled.handle.y, { steps: 8 });
  await page.mouse.move(scaled.handle.x + 160, scaled.handle.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const resized = await page.evaluate((sel) => {
    const body = document.querySelector('.comp-legend-body');
    const list = document.querySelector('.comp-legend-list');
    return {
      swatch: document.querySelector('.comp-legend-swatch').getBoundingClientRect().width,
      left: Math.round(document.querySelector(sel).getBoundingClientRect().left),
      scaleVar: getComputedStyle(body).getPropertyValue('--legend-scale').trim(),
      overflowX: list.scrollWidth - body.clientWidth,
      overflowY: list.scrollHeight - body.clientHeight,
    };
  }, WIDGET);
  H.check('dragging the handle scales the swatches',
    resized.swatch > scaled.swatch * 1.3, JSON.stringify({ before: scaled.swatch, ...resized }));
  H.check('and grows rightwards — the left edge stays put',
    Math.abs(resized.left - scaled.left) <= 1, JSON.stringify({ before: scaled.left, after: resized.left }));

  // Dragged all the way in, the box must still fit its own rows: the scale
  // clamp stops tracking the width below MIN_WIDTH, so anything narrower
  // crops the labels instead of shrinking them.
  const handleIn = await page.evaluate(() => {
    const r = document.querySelector('.cv-colorbar-resize-handle').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(handleIn.x, handleIn.y);
  await page.mouse.down();
  await page.mouse.move(handleIn.x - 400, handleIn.y, { steps: 10 });
  await page.mouse.move(handleIn.x - 800, handleIn.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const shrunk = await page.evaluate((sel) => {
    const body = document.querySelector('.comp-legend-body');
    const list = document.querySelector('.comp-legend-list');
    return {
      width: body.clientWidth,
      left: Math.round(document.querySelector(sel).getBoundingClientRect().left),
      overflowX: Math.round(list.scrollWidth - body.clientWidth),
      overflowY: Math.round(list.scrollHeight - body.clientHeight),
    };
  }, WIDGET);
  H.check('shrunk to its minimum the legend still shows every row whole',
    shrunk.width < 200 && shrunk.overflowX <= 0 && shrunk.overflowY <= 0,
    JSON.stringify(shrunk));

  // ---- transparent mode ----------------------------------------------------
  const transparentPoint = await page.evaluate((sel) => {
    const body = document.querySelector(sel).querySelector('.comp-legend-body').getBoundingClientRect();
    return { x: body.left + 5, y: body.top + 5 };
  }, WIDGET);
  await page.mouse.move(transparentPoint.x, transparentPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const transparentFound = await page.locator(`${WIDGET} .cv-colorbar-menu-open`).count() > 0;
  const transparentItem = page.locator(`${WIDGET} .cv-colorbar-menu-item`, { hasText: 'Transparent background' });
  const transparentItemFound = await transparentItem.count() > 0;
  if (transparentItemFound) await transparentItem.click();
  await page.mouse.up();
  const transparent = await page.evaluate(([sel, found, itemFound]) => {
    const widget = document.querySelector(sel);
    const cs = getComputedStyle(widget.querySelector('.comp-legend-body'));
    return { found: found && itemFound, classOn: widget.className.includes('comp-legend-transparent'),
      bg: cs.backgroundColor, shadow: cs.boxShadow };
  }, [WIDGET, transparentFound, transparentItemFound]);
  H.check('a long press opens Transparent background and it strips the surface',
    transparent.found && transparent.classOn
    && /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(transparent.bg)
    && transparent.shadow === 'none',
    JSON.stringify(transparent));

  // ---- transparent text tracks the scene background ------------------------
  // With no surface of its own the legend reads against the scene, so its text
  // follows the same contrast colour the floating colour bars use. The PNG
  // export copies these computed colours, so a white-background figure used to
  // come out with the swatches drawn and the labels invisible.
  const contrast = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const label = document.querySelector('.comp-legend-label');
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    general.currentLatticeColor = '#000000'; // what a white background picks
    await settle();
    const onLight = getComputedStyle(label).color;
    general.currentLatticeColor = '#ffffff'; // and a black one
    await settle();
    return { onLight, onDark: getComputedStyle(label).color };
  });
  H.check('legend text takes the scene-contrast colour, both ways',
    contrast.onLight === 'rgb(0, 0, 0)' && contrast.onDark === 'rgb(255, 255, 255)',
    JSON.stringify(contrast));

  // ---- the button is a toggle ----------------------------------------------
  await page.evaluate(() => document.getElementById('compositionLegendButton').click());
  await page.waitForTimeout(500);
  H.check('❖ again puts the legend away',
    await page.evaluate((sel) => !document.querySelector(sel), WIDGET));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
