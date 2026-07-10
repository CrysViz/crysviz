// Plain-click on a row's copy icon opens the "Copy All/Current/Range Steps"
// popup; confirming it (any of the three options) inserts the new row right
// after the source row, then used to always select selectLastAddedRow() (the
// last row in the table) instead of the row it just created.
'use strict';
const H = require('../harness');

async function copyViaPopup(page, option) {
  return page.evaluate((option) => {
    const rows = document.querySelectorAll('#objectTable tbody tr');
    const middleRow = [...rows].find((r) => r.querySelector('.name-inner')?.textContent === 'middle');
    const middleIndex = [...rows].indexOf(middleRow);
    const rowCountBefore = rows.length;
    const copyIcon = middleRow.querySelector('.ftd.icon.copy');
    // Plain click (no ctrl/meta) opens the popup.
    copyIcon.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const popup = [...document.querySelectorAll('div')].find((d) =>
      d.querySelector('select') && [...d.querySelectorAll('button')].some((b) => b.textContent === 'Copy'));
    const select = popup.querySelector('select');
    select.value = option;
    select.dispatchEvent(new Event('change'));
    const confirmBtn = [...popup.querySelectorAll('button')].find((b) => b.textContent === 'Copy');
    confirmBtn.click();

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
  }, option);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'first');
  await H.loadDefaultStructure(page, 'defaultPOSCAR2', 'middle');
  await H.loadDefaultStructure(page, 'defaultPOSCAR3', 'last');

  for (const option of ['all', 'current']) {
    const result = await copyViaPopup(page, option);
    H.check(`popup "${option}": inserted exactly one new row`,
      result.rowCountAfter === result.rowCountBefore + 1, JSON.stringify(result));
    H.check(`popup "${option}": the newly-copied row (right after "middle") is selected, not the last row`,
      result.insertedRightAfterMiddle && result.selectedIndex === result.middleIndex + 1, JSON.stringify(result));
    H.check(`popup "${option}": the selected row is a copy of "middle", not of the last row`,
      result.selectedName === result.middleRowName && result.selectedName !== result.lastRowName, JSON.stringify(result));
  }

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
