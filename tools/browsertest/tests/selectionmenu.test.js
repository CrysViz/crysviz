// Files window ▸ the ≡ selection menu in the structure-table header (the old
// "combine trajectories" ⚓ button, now a burger menu):
//
//   - clicking ≡ opens a dropdown with the window-menu chrome (.cv-panel-menu),
//     portaled to <body>
//   - items, in order: Deselect, Select all, a separator, Make Trajectory
//   - with nothing checked: Deselect and Make Trajectory are disabled
//   - "Select all" checks every row; then Deselect is enabled and Make
//     Trajectory (≥2 rows checked) is enabled too
//   - "Deselect" unchecks every row
//   - the menu closes on an outside click and on Escape
//   - "Make Trajectory" opens the name prompt, and confirming appends one
//     combined trajectory row
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  // Two separate structures → two rows to select/combine.
  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  await H.loadDefaultStructure(page, 'defaultPOSCAR5', 'Si');

  const menuBtn = () => page.$('#combineTrajectoriesButton');

  const readMenu = () => page.evaluate(() => {
    const menu = document.querySelector('.cv-panel-menu');
    if (!menu) return { open: false };
    const items = [...menu.querySelectorAll('.cv-panel-menu-item')];
    return {
      open: true,
      portaledToBody: menu.parentElement === document.body,
      labels: items.map((b) => b.textContent),
      disabled: items.map((b) => b.disabled),
      hasSep: !!menu.querySelector('.cv-panel-menu-sep'),
      // The separator sits between "Select all" and "Make Trajectory".
      sepBeforeMake: (() => {
        const kids = [...menu.children];
        const sep = menu.querySelector('.cv-panel-menu-sep');
        const make = [...menu.querySelectorAll('.cv-panel-menu-item')]
          .find((b) => b.textContent === 'Make Trajectory');
        return sep && make && kids.indexOf(sep) === kids.indexOf(make) - 1;
      })(),
    };
  });

  const rowState = () => page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#objectTable tbody input[type="checkbox"]')];
    return {
      nRows: boxes.length,
      nChecked: boxes.filter((b) => b.checked).length,
    };
  });

  const clickItem = (label) => page.evaluate((label) => {
    const btn = [...document.querySelectorAll('.cv-panel-menu .cv-panel-menu-item')]
      .find((b) => b.textContent === label);
    btn?.click();
  }, label);

  // ---- 1. the header button is a ≡ burger, always enabled ---------------------
  const btn = await menuBtn();
  const btnInfo = await page.evaluate((b) => ({
    glyph: b.textContent,
    disabled: b.disabled,
  }), btn);
  H.check('header button shows ≡ and is never disabled',
    btnInfo.glyph === '☰' && btnInfo.disabled === false, JSON.stringify(btnInfo));

  // ---- 2. opening it: chrome, order, disabled state with nothing checked ------
  await btn.click();
  let m = await readMenu();
  H.check('≡ opens a .cv-panel-menu dropdown portaled to <body>',
    m.open && m.portaledToBody, JSON.stringify(m));
  H.check('items are Deselect, Select all, <sep>, Make Trajectory',
    JSON.stringify(m.labels) === JSON.stringify(['Deselect', 'Select all', 'Make Trajectory'])
      && m.hasSep && m.sepBeforeMake, JSON.stringify(m));
  H.check('with nothing checked: Deselect and Make Trajectory disabled, Select all enabled',
    m.disabled[0] === true && m.disabled[1] === false && m.disabled[2] === true, JSON.stringify(m));

  // ---- 2b. clicking the ≡ button again closes the menu ------------------------
  await btn.click();
  H.check('a second click on ≡ closes the menu (toggle)', !(await readMenu()).open, '');
  await btn.click(); // reopen for the next step
  H.check('a third click reopens it', (await readMenu()).open, '');

  // ---- 3. Select all → every row checked, items enable ------------------------
  await clickItem('Select all');
  let r = await rowState();
  H.check('Select all checks every row',
    r.nRows >= 2 && r.nChecked === r.nRows, JSON.stringify(r));
  H.check('menu closed after choosing an item',
    !(await readMenu()).open, '');

  await btn.click();
  m = await readMenu();
  H.check('with all checked: Deselect and Make Trajectory now enabled',
    m.disabled[0] === false && m.disabled[2] === false, JSON.stringify(m));

  // ---- 4. Escape closes the menu ----------------------------------------------
  await page.keyboard.press('Escape');
  H.check('Escape closes the menu', !(await readMenu()).open, '');

  // ---- 5. Deselect → every row unchecked --------------------------------------
  await btn.click();
  await clickItem('Deselect');
  r = await rowState();
  H.check('Deselect unchecks every row', r.nChecked === 0, JSON.stringify(r));

  // ---- 6. outside click closes the menu ---------------------------------------
  await btn.click();
  H.check('menu open before outside click', (await readMenu()).open, '');
  await page.mouse.click(5, 5);
  H.check('outside click closes the menu', !(await readMenu()).open, '');

  // ---- 7. Make Trajectory → name prompt → one combined row appended -----------
  const rowsBefore = (await rowState()).nRows;
  await btn.click();
  await clickItem('Select all');       // need ≥2 checked to enable Make Trajectory
  await btn.click();
  await clickItem('Make Trajectory');
  await page.waitForSelector('.combine-name-popup-overlay', { timeout: 5000 });
  H.check('Make Trajectory opens the combine-name prompt',
    await page.$('.combine-name-input') !== null, '');
  await page.click('.combine-name-popup-overlay .cv-fb-popup-btn:last-child'); // Combine
  await page.waitForTimeout(1500);
  const rowsAfter = (await rowState()).nRows;
  H.check('confirming appends one combined trajectory row',
    rowsAfter === rowsBefore + 1, `before=${rowsBefore} after=${rowsAfter}`);

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})();
