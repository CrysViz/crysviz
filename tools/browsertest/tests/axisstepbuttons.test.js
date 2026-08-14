'use strict';
const H = require('../harness');

function directionDistance(a, b) {
  return Math.hypot(...a.map((value, index) => value - b[index]));
}

async function axisPoint(page, axis = 'x') {
  return page.evaluate((axis) => {
    const rect = document.getElementById(`view${axis.toUpperCase()}`).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, axis);
}

async function longPressAxis(page, axis = 'x') {
  const point = await axisPoint(page, axis);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

async function openViewMenu(page) {
  await page.evaluate(() => {
    document.querySelector('.cv-panel[data-panel-id="view"] .cv-panel-menu-btn').click();
  });
}

async function menuState(page) {
  return page.evaluate(() => ({
    headers: [...document.querySelectorAll('.cv-panel-menu-header')].map((el) => el.textContent),
    items: [...document.querySelectorAll('.cv-panel-menu-item')].map((el) => ({
      label: el.textContent,
      checked: el.classList.contains('checked'),
    })),
  }));
}

async function chooseMenuItem(page, label) {
  await page.evaluate((label) => {
    [...document.querySelectorAll('.cv-panel-menu-item')]
      .find((item) => item.textContent === label)?.click();
  }, label);
}

async function stepButtonState(page) {
  return page.evaluate(() => {
    const stacks = [...document.querySelectorAll('#cameraTools .camera-axis-stack')];
    const xUp = document.getElementById('xUp');
    return {
      stackCount: stacks.length,
      revealedCount: stacks.filter((stack) => stack.classList.contains('camera-axis-revealed')).length,
      xUpVisibility: xUp ? getComputedStyle(xUp).visibility : null,
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  let state = await stepButtonState(page);
  H.check('default step buttons are hidden',
    state.stackCount === 6 && state.revealedCount === 0 && state.xUpVisibility === 'hidden',
    JSON.stringify(state));

  const beforeLongPress = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.camera.position.clone().sub(app.controls.target).normalize().toArray();
  });
  await longPressAxis(page);
  const afterLongPress = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.camera.position.clone().sub(app.controls.target).normalize().toArray();
  });
  state = await stepButtonState(page);
  H.check('default long press reveals the axis step buttons', state.revealedCount === 1,
    JSON.stringify(state));
  H.check('long press suppresses the axis snap click',
    directionDistance(beforeLongPress, afterLongPress) < 1e-6 && Math.abs(afterLongPress[0]) < 0.999,
    JSON.stringify({ beforeLongPress, afterLongPress }));

  await openViewMenu(page);
  let menu = await menuState(page);
  const longPressItem = menu.items.find((item) => item.label === 'Long press');
  H.check('View menu contains Stepwise buttons options',
    menu.headers.includes('Stepwise buttons')
      && ['On', 'Off', 'Long press'].every((label) => menu.items.some((item) => item.label === label)),
    JSON.stringify(menu));
  H.check('Long press is checked by default', longPressItem?.checked === true, JSON.stringify(menu));

  await chooseMenuItem(page, 'Off');
  state = await stepButtonState(page);
  H.check('Off hides the step buttons', state.revealedCount === 0 && state.xUpVisibility === 'hidden',
    JSON.stringify(state));
  await longPressAxis(page);
  const afterOffPress = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.camera.position.clone().sub(app.controls.target).normalize().toArray();
  });
  state = await stepButtonState(page);
  H.check('Off disables long-press revealing', state.revealedCount === 0, JSON.stringify(state));
  H.check('Off preserves the normal axis snap action',
    afterOffPress[0] > 0.999 && Math.abs(afterOffPress[1]) < 1e-6 && Math.abs(afterOffPress[2]) < 1e-6,
    JSON.stringify(afterOffPress));

  await openViewMenu(page);
  await chooseMenuItem(page, 'On');
  state = await stepButtonState(page);
  H.check('On immediately reveals all six step-button stacks',
    state.stackCount === 6 && state.revealedCount === 6 && state.xUpVisibility === 'visible',
    JSON.stringify(state));

  await openViewMenu(page);
  await chooseMenuItem(page, 'Long press');
  state = await stepButtonState(page);
  H.check('switching to Long press clears persistent reveals',
    state.revealedCount === 0 && state.xUpVisibility === 'hidden', JSON.stringify(state));
  await openViewMenu(page);
  await chooseMenuItem(page, 'On');

  await page.reload({ waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  await H.loadDefaultStructure(page);
  state = await stepButtonState(page);
  H.check('On persists across reload',
    state.stackCount === 6 && state.revealedCount === 6 && state.xUpVisibility === 'visible',
    JSON.stringify(state));
  await openViewMenu(page);
  menu = await menuState(page);
  H.check('persisted menu state checks On',
    menu.items.find((item) => item.label === 'On')?.checked === true,
    JSON.stringify(menu));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
