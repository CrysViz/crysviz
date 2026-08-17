// Cmd/Ctrl-clicking a row's copy icon ("ftd icon copy") duplicates the
// current step and inserts the new row right after the source row — but
// selection used to always jump to selectLastAddedRow() (the last row in the
// table), not the newly-inserted copy, whenever the source row wasn't
// already last.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'first');
  await H.loadDefaultStructure(page, 'defaultPOSCAR2', 'middle');
  await H.loadDefaultStructure(page, 'defaultPOSCAR3', 'last');

  const before = await page.evaluate(() =>
    [...document.querySelectorAll('#objectTable tbody tr .name-inner')].map((n) => n.textContent));
  // The app auto-loads a default "Si" row on startup, so "middle" (the row
  // we'll copy) is the second-to-last, not the last.
  H.check('"middle" row is loaded and is not last', before.includes('middle') && before[before.length - 1] !== 'middle',
    JSON.stringify(before));

  // Ctrl/Cmd-click the COPY icon on the "middle" row, not the last one.
  const result = await page.evaluate(() => {
    const rows = document.querySelectorAll('#objectTable tbody tr');
    const middleRow = [...rows].find((r) => r.querySelector('.name-inner')?.textContent === 'middle');
    const middleIndex = [...rows].indexOf(middleRow);
    const rowCountBefore = rows.length;
    const copyIcon = middleRow.querySelector('.ftd.icon.copy');
    copyIcon.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, metaKey: true }));

    const rowsAfter = document.querySelectorAll('#objectTable tbody tr');
    const selected = document.querySelector('#objectTable tbody tr.selected');
    const selectedIndex = [...rowsAfter].indexOf(selected);
    return {
      rowCountBefore,
      rowCountAfter: rowsAfter.length,
      middleIndex,
      selectedIndex,
      selectedName: selected?.querySelector('.name-inner')?.textContent,
      middleRowName: middleRow.querySelector('.name-inner')?.textContent,
      lastRowName: rowsAfter[rowsAfter.length - 1]?.querySelector('.name-inner')?.textContent,
      insertedRightAfterMiddle: rowsAfter[middleIndex + 1] === selected,
    };
  });

  H.check('copy inserted exactly one new row', result.rowCountAfter === result.rowCountBefore + 1, JSON.stringify(result));
  H.check('the newly-copied row (right after "middle") is selected, not the last row',
    result.insertedRightAfterMiddle && result.selectedIndex === result.middleIndex + 1, JSON.stringify(result));
  H.check('the selected row is a copy of "middle", not of the last row',
    result.selectedName === `copy_1_${result.middleRowName}` && result.selectedName !== result.lastRowName, JSON.stringify(result));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
