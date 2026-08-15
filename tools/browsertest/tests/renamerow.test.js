// Renaming a file-browser row (double-click its name) must reach everything
// that reads the name later: the label, the row object the copy action
// reads, and the container's fileName that derived rows (relax_/md_/eos_/
// sym_/copy_) are named after — a copy made after the rename carries the
// new name.
'use strict';
const H = require('../harness');

const rowByName = (name) => [...document.querySelectorAll('#objectTable tbody tr')]
  .find((r) => r.querySelector('.name-inner')?.textContent === name);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page, 'defaultPOSCAR2', 'orig');

  // Double-click -> input; Escape leaves the name alone.
  const cancelled = await page.evaluate(async (finder) => {
    const rowByName = new Function(`return ${finder}`)();
    const row = rowByName('orig');
    row.querySelector('.name-cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = row.querySelector('.cv-fb-rename');
    const opened = !!input && document.activeElement === input;
    input.value = 'nope';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { opened, name: row.querySelector('.name-inner').textContent, inputGone: !row.querySelector('.cv-fb-rename') };
  }, rowByName.toString());
  H.check('double-click opens the rename input; Escape cancels', cancelled.opened && cancelled.name === 'orig' && cancelled.inputGone,
    JSON.stringify(cancelled));

  // Enter commits: label, container.fileName, and a later copy's name.
  const renamed = await page.evaluate(async (finder) => {
    const rowByName = new Function(`return ${finder}`)();
    const { structureShip } = await import('./state/store.js');
    const row = rowByName('orig');
    row.querySelector('.name-cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = row.querySelector('.cv-fb-rename');
    input.value = '  bulk Si  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const idx = [...row.parentElement.children].indexOf(row);
    row.querySelector('.ftd.icon.copy').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    const copyRow = row.nextElementSibling;
    const copyIdx = [...row.parentElement.children].indexOf(copyRow);
    return {
      label: row.querySelector('.name-inner').textContent,
      fileName: structureShip.container[idx]?.fileName,
      copyLabel: copyRow?.querySelector('.name-inner')?.textContent,
      copyFileName: structureShip.container[copyIdx]?.fileName,
      copyIsContainer: !!structureShip.container[copyIdx]?.structures && 'plotSeries' in structureShip.container[copyIdx],
    };
  }, rowByName.toString());
  H.check('Enter commits the trimmed name to the label and the container',
    renamed.label === 'bulk Si' && renamed.fileName === 'bulk Si', JSON.stringify(renamed));
  H.check('a copy made after the rename is copy_1_<new name>, as a real container',
    renamed.copyLabel === 'copy_1_bulk Si' && renamed.copyFileName === 'copy_1_bulk Si' && renamed.copyIsContainer,
    JSON.stringify(renamed));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
