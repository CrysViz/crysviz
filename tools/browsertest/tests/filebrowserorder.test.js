// Files window structure list (ui/FileBrowswerPanel.js): drag a row to
// reorder (the containers follow, the selection keeps its row, the drop
// selects nothing), the name column takes the spare width, and the list's
// bottom bar sets how tall it grows before it scrolls (remembered).
'use strict';
const H = require('../harness');

const LONG = 'a_rather_long_structure_name_that_should_not_be_cut_short.vasp';

const STATE = async () => {
  const { structureShip, fileBrowser } = await import('./state/store.js');
  const rows = [...document.querySelectorAll('#objectTable tbody tr')];
  return {
    rows: rows.map((r) => r.querySelector('.name-inner').textContent),
    containers: structureShip.container.map((c) => c.__testTag ?? null),
    selectedName: fileBrowser.selectedRow?.querySelector('.name-inner').textContent ?? null,
    selectedIndex: fileBrowser.selectedRowIndex,
    selectedDataIndex: fileBrowser.selectedRow?.dataset.index ?? null,
    selectedRowPos: rows.indexOf(fileBrowser.selectedRow),
  };
};

async function rowCenter(page, i) {
  return page.evaluate((i) => {
    const r = document.querySelectorAll('#objectTable tbody tr')[i].querySelector('.name-cell').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, i);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  await H.loadDefaultStructure(page, 'defaultPOSCAR5', LONG);
  await H.loadDefaultStructure(page, 'defaultPOSCAR2', 'third');
  // Tag every container with its row's name, to check they stay paired.
  await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    const rows = [...document.querySelectorAll('#objectTable tbody tr')];
    structureShip.container.forEach((c, i) => { c.__testTag = rows[i].querySelector('.name-inner').textContent; });
  });
  const start = await page.evaluate(STATE);
  H.check('four rows, paired with their containers', start.rows.length === 4
    && JSON.stringify(start.rows) === JSON.stringify(start.containers), JSON.stringify(start));

  // ---- name column takes the spare width --------------------------------
  const widths = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#objectTable tbody tr')[2].children];
    const inner = cells[1].querySelector('.name-inner');
    return { name: cells[1].getBoundingClientRect().width, others: cells.filter((_, i) => i !== 1).map((c) => Math.round(c.getBoundingClientRect().width)),
      table: document.getElementById('objectTable').getBoundingClientRect().width,
      list: document.getElementById('structureTablePanel').clientWidth,
      truncated: inner.scrollWidth > inner.clientWidth };
  });
  H.check('the name column is the widest by far', widths.others.every((w) => widths.name > 2 * w), JSON.stringify(widths));
  H.check('the table fits the window (long name ellipsised, not widening it)', widths.table <= widths.list + 1, JSON.stringify(widths));

  // ---- drag the last row to the top ---------------------------------------
  // Select row 1 first: the selection must keep its row through the move.
  await page.mouse.click((await rowCenter(page, 1)).x, (await rowCenter(page, 1)).y);
  await page.waitForTimeout(300);
  const from = await rowCenter(page, 3);
  const to = await rowCenter(page, 0);
  await page.evaluate(() => {
    window.__rowClicks = 0;
    document.querySelector('#objectTable tbody').addEventListener('click', () => { window.__rowClicks++; });
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 6);
  await page.mouse.move(to.x, to.y - 10, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(STATE);
  H.check('the dragged row is now first', after.rows[0] === start.rows[3]
    && JSON.stringify(after.rows.slice(1)) === JSON.stringify(start.rows.slice(0, 3)), JSON.stringify(after.rows));
  H.check('the containers moved with the rows', JSON.stringify(after.rows) === JSON.stringify(after.containers),
    JSON.stringify(after));
  H.check('the selection kept its row, with its index updated', after.selectedName === start.rows[1]
    && after.selectedIndex === after.selectedRowPos && after.selectedDataIndex === String(after.selectedRowPos),
  JSON.stringify(after));
  H.check('the drop clicked no row', await page.evaluate(() => window.__rowClicks) === 0);

  // A plain click still selects, and the right container is shown.
  const c0 = await rowCenter(page, 0);
  await page.mouse.click(c0.x, c0.y);
  await page.waitForTimeout(300);
  const shown = await page.evaluate(async () => {
    const { fileBrowser, structureShip } = await import('./state/store.js');
    return { name: fileBrowser.selectedRow.querySelector('.name-inner').textContent,
      tag: structureShip.container[fileBrowser.selectedRowIndex].__testTag };
  });
  H.check('clicking the moved row selects it and its own structure', shown.name === start.rows[3] && shown.tag === start.rows[3],
    JSON.stringify(shown));

  // ---- list height: drag the bottom bar --------------------------------------
  const before = await page.evaluate(() => document.getElementById('structureTablePanel').getBoundingClientRect().height);
  const bar = await page.evaluate(() => {
    const r = document.querySelector('#structureTablePanel .cv-fb-list-resize').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.down();
  await page.mouse.move(bar.x, bar.y - 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const shrunk = await page.evaluate(() => ({
    h: document.getElementById('structureTablePanel').getBoundingClientRect().height,
    scrolls: document.getElementById('structureTablePanel').scrollHeight > document.getElementById('structureTablePanel').clientHeight,
    pref: JSON.parse(localStorage.getItem('panelPrefs') || '{}').fileListMaxHeight,
  }));
  H.check('dragging the bar up shrinks the list, which then scrolls', shrunk.h < before - 40 && shrunk.scrolls,
    JSON.stringify({ before, ...shrunk }));
  H.check('the height is remembered', Math.abs(shrunk.pref - shrunk.h) <= 2, JSON.stringify(shrunk));

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(4000);
  const reloaded = await page.evaluate(() => getComputedStyle(document.getElementById('structureTablePanel')).maxHeight);
  H.check('the remembered height applies after a reload', Math.abs(parseFloat(reloaded) - shrunk.pref) <= 1, reloaded);

  const bar2 = await page.evaluate(() => {
    const r = document.querySelector('#structureTablePanel .cv-fb-list-resize').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.dblclick(bar2.x, bar2.y);
  await page.waitForTimeout(200);
  const reset = await page.evaluate(() => ({
    max: getComputedStyle(document.getElementById('structureTablePanel')).maxHeight,
    pref: JSON.parse(localStorage.getItem('panelPrefs') || '{}').fileListMaxHeight,
  }));
  H.check('double-click restores the default height', reset.max === '240px' && reset.pref === 0, JSON.stringify(reset));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
