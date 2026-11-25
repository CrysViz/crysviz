// A floating color bar's legend text can be dragged on its own, away from the
// bar and its tick numbers (ui/ColorBarWidget.js legendOffset). Exercised on
// the crystal-plane field legend: a drag moves only the legend and does not
// open the editor, a click still edits it, the offset survives a rebuild of
// the bar and (stored with the plane) a reload, the long-press menu's
// "Reset Legend Position" puts it back, a docked bar's legend does not move,
// and the PNG export draws the legend where it was dragged.
'use strict';
const H = require('../harness');

const PREFS_KEY = 'crysviz.structurePrefs.v1';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await page.evaluate((k) => localStorage.removeItem(k), PREFS_KEY);

  const expandPanel = async (id) => {
    await page.evaluate(async (id) => {
      const { getPanel } = await import('./ui/panels/PanelManager.js');
      getPanel(id).expand();
    }, id);
    await page.waitForTimeout(300);
  };

  const attachField = () => page.evaluate(async () => {
    const { Field, FieldContainer } = await import('./model/index.js');
    const { fileBrowser } = await import('./state/store.js');
    const { fieldBrowser } = await import('./ui/FieldPanel.js');
    const structure = fileBrowser.selectedStructure;
    const n = 10;
    const values = new Float32Array(n ** 3).map((_, i) => (i % 17) / 17);
    const field = new Field({
      nx: n, ny: n, nz: n, voxel: structure.lattice.map((row) => row.map((x) => x / n)), values,
      label: 'TestBlob', isoValue: 0.5, minValue: 0, maxValue: 1, absMinValue: 0, absMaxValue: 1,
    });
    structure.volumetricFields = new FieldContainer({ fileName: 'blob.cube', source: 'Cube', fields: [field] });
    fieldBrowser.setCatalog(structure.volumetricFields.catalog);
    await new Promise((r) => setTimeout(r, 300));
  });

  // The plane bar's instance, its rects and settings.
  const bar = () => page.evaluate(async () => {
    const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
    const b = listActiveColorBars().find((x) => x.instance.getElement().closest('#planesColorBarContainer')
      || x.instance.getElement().id === 'planeColorBarFloating');
    if (!b) return null;
    const el = b.instance.getElement();
    const legend = el.querySelector('.cv-colorbar-legend');
    const r = (e) => { const q = e.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; };
    return {
      floating: b.instance.isFloating(),
      wrapper: r(el), bar: r(el.querySelector('.cv-colorbar-bar-handle')), legend: r(legend),
      editing: legend.classList.contains('cv-colorbar-legend-editing'),
      offset: b.instance.getSettings().legendOffset,
    };
  });

  const floatBar = () => page.evaluate(async () => {
    const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
    const b = listActiveColorBars().find((x) => x.instance.getElement().closest('#planesColorBarContainer'));
    const view = document.getElementById('view').getBoundingClientRect();
    b.instance.floatAt(view.left + 200, view.top + 150);
    await new Promise((r) => setTimeout(r, 200));
  });

  const drag = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  };

  // ---- a field plane with its legend floating over the scene ---------------
  await attachField();
  await expandPanel('planes');
  await H.clickById(page, 'addPlaneBtn');
  await H.setSelect(page, 'planesFieldSelect', 'TestBlob');
  await page.waitForTimeout(300);

  // Docked: a drag on the legend does not move it.
  const docked = await bar();
  await drag(docked.legend, 0, 40);
  const dockedAfter = await bar();
  H.check('a docked bar\'s legend does not move', !dockedAfter.floating && dockedAfter.offset === null
    && Math.abs(dockedAfter.legend.y - docked.legend.y) < 1, JSON.stringify({ docked, dockedAfter }));
  await page.keyboard.press('Escape');

  await floatBar();
  const before = await bar();
  await drag(before.legend, 30, 60);
  const after = await bar();
  H.check('dragging a floating bar\'s legend moves only the legend',
    after.floating && Math.abs(after.legend.x - before.legend.x - 30) < 2 && Math.abs(after.legend.y - before.legend.y - 60) < 2
    && Math.abs(after.bar.x - before.bar.x) < 1 && Math.abs(after.bar.y - before.bar.y) < 1,
    JSON.stringify({ before, after }));
  H.check('the drag does not open the legend editor, and the offset is reported',
    !after.editing && after.offset?.x === 30 && after.offset?.y === 60, JSON.stringify(after));

  await page.mouse.click(after.legend.x, after.legend.y);
  const clicked = await bar();
  H.check('a plain click on the legend still edits it', clicked.editing, JSON.stringify(clicked));
  await page.keyboard.press('Escape');

  // Rebuilding the bar (colormap switch) keeps it.
  await H.setSelect(page, 'planesColormapSelect', 'viridis');
  await page.waitForTimeout(300);
  const rebuilt = await bar();
  H.check('a rebuilt bar keeps the moved legend', rebuilt.floating && rebuilt.offset?.x === 30
    && rebuilt.offset?.y === 60 && Math.abs((rebuilt.legend.y - rebuilt.bar.y) - (after.legend.y - after.bar.y)) < 2,
    JSON.stringify({ rebuilt, after }));

  // The PNG export draws it there too.
  const exported = await page.evaluate(async () => {
    const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
    const { drawFloatingColorBars } = await import('./render/ImageExportModule.js');
    const view = document.getElementById('view').getBoundingClientRect();
    const texts = [];
    const painter = new Proxy({}, {
      get: (_, name) => (...args) => {
        if (name === 'richText') texts.push({ x: args[1], y: args[2] });
        if (name === 'measureText') return { width: 10, inkAscent: 5, inkDescent: 1 };
        return undefined;
      },
    });
    const crop = { x0: 0, y0: 0, x1: 1, y1: 1 }; // the whole view, at screen size
    drawFloatingColorBars(painter, view.width, view.height, crop, view);
    const b = listActiveColorBars().find((x) => x.instance.isFloating());
    const s = b.instance.getSettings();
    const barRect = b.instance.getBarRect();
    return { legend: texts[0], barBottom: barRect.bottom - view.top, barCx: barRect.left + barRect.width / 2 - view.left, offset: s.legendOffset };
  }).catch((e) => ({ error: String(e) }));
  H.check('the PNG export draws the legend at its dragged place',
    exported.legend && Math.abs(exported.legend.x - exported.barCx - 30) < 2
    && exported.legend.y - exported.barBottom > 60, JSON.stringify(exported));

  // Stored with the plane, back after a reload.
  await page.evaluate(async () => (await import('./state/structurePrefs.js')).flushPendingStructurePrefSaves());
  const stored = await page.evaluate((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}'))
    .flatMap((r) => r.planes ?? []).map((p) => p.legendOffset ?? null), PREFS_KEY);
  H.check('the offset is stored with the plane', JSON.stringify(stored) === JSON.stringify([{ x: 30, y: 60 }]),
    JSON.stringify(stored));

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  await attachField();
  await expandPanel('planes');
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#planesTableBody tr')).click());
  await page.waitForTimeout(300);
  await floatBar();
  const reloaded = await bar();
  H.check('after a reload the plane\'s legend comes back moved', reloaded.offset?.x === 30 && reloaded.offset?.y === 60
    && Math.abs((reloaded.legend.y - reloaded.bar.y) - (after.legend.y - after.bar.y)) < 2, JSON.stringify(reloaded));

  // Reset from the long-press menu.
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.cv-colorbar-menu-item')]
      .find((b) => b.textContent === 'Reset Legend Position' && b.closest('#planeColorBarFloating'));
    item.click();
  });
  await page.waitForTimeout(200);
  const reset = await bar();
  H.check('"Reset Legend Position" puts the legend back beside the ticks', reset.offset === null
    && Math.abs((reset.legend.y - reset.bar.y) - (before.legend.y - before.bar.y)) < 2, JSON.stringify({ reset, before }));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
