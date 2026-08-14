// Floating windows auto-dock at the compact/1024px breakpoint. Measure, View,
// and Structure are deliberately excluded because their own compact behavior
// is independent of the dock state.
'use strict';
const H = require('../harness');

const TARGETS = ['backend', 'forces'];
const EXEMPTS = ['view', 'measure', 'info'];

async function panelState(page, ids = [...TARGETS, ...EXEMPTS]) {
  return page.evaluate(async (ids) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    return Object.fromEntries(ids.map((id) => {
      const p = getPanel(id);
      const r = p?.el?.getBoundingClientRect();
      return [id, {
        dock: p?.dock ?? null,
        autoDocked: !!p?.autoDocked,
        floatPos: p?.floatPos ? { ...p.floatPos } : null,
        rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null,
        inMain: !!document.querySelector(`#dock > .cv-panel[data-panel-id="${id}"]`),
        floating: !!p?.el?.classList.contains('cv-floating'),
      }];
    }));
  }, ids);
}

async function choosePosition(page, id, label) {
  await page.evaluate((id) => {
    const panel = document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
    panel.scrollIntoView({ block: 'center' });
    panel.querySelector('.cv-panel-menu-btn').click();
  }, id);
  await page.evaluate((label) => {
    [...document.querySelectorAll('.cv-panel-menu-item')]
      .find((item) => item.textContent === label)?.click();
  }, label);
  await page.waitForTimeout(300);
}

async function dragPanelTo(page, id, left, top) {
  const start = await page.evaluate((id) => {
    const el = document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
    const bar = el.querySelector('.cv-panel-titlebar');
    const er = el.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    return { left: er.left, top: er.top, x: br.left + br.width / 2, y: br.top + br.height / 2 };
  }, id);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 6, start.y + 6);
  await page.mouse.move(start.x + 6 + left - start.left, start.y + 6 + top - start.top, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function reorderToBottom(page, id) {
  const point = await page.evaluate((id) => {
    const el = document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
    const bar = el.querySelector('.cv-panel-titlebar').getBoundingClientRect();
    const dock = document.getElementById('dock').getBoundingClientRect();
    return { x: bar.left + bar.width / 2, y: bar.top + bar.height / 2, endY: dock.bottom - 4 };
  }, id);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 6, point.y + 6);
  await page.mouse.move(point.x + 6, point.endY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Keep the test deterministic even if the browser test runner reuses a
  // context with a layout from a preceding test.
  await page.evaluate(() => localStorage.removeItem('panelLayout'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);

  // Use the real Position menu to make three ordinary docked windows float.
  for (const id of TARGETS) await choosePosition(page, id, 'Float');
  // Put one inherent position inside the dock-displacement region while the
  // dock is hidden; showing it again derives a displacement without changing
  // the remembered floatPos.
  await page.evaluate(() => document.getElementById('mobileMenuToggle').click());
  await page.waitForTimeout(150);
  await dragPanelTo(page, 'backend', 40, 120);
  await page.evaluate(() => document.getElementById('mobileMenuToggle').click());
  await page.waitForTimeout(150);
  await dragPanelTo(page, 'forces', 1100, 260);
  const before = await panelState(page);
  const savedPositions = Object.fromEntries(TARGETS.map((id) => [id, before[id].floatPos]));
  const savedPositionBytes = Object.fromEntries(TARGETS.map((id) =>
    [id, JSON.stringify(before[id].floatPos)]));
  H.check('control windows are floating at remembered positions',
    TARGETS.every((id) => before[id].dock === false && before[id].floatPos), JSON.stringify(before));

  // Leave a Position menu open while crossing so the real media callback has
  // to close it before the new compact menu is built.
  await page.evaluate(() => document.querySelector('.cv-panel[data-panel-id="info"] .cv-panel-menu-btn').click());
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(600);
  let small = await panelState(page);
  H.check('below 1024: every ordinary floating window enters the Main dock',
    TARGETS.every((id) => small[id].dock === 'left' && small[id].inMain && small[id].autoDocked),
    JSON.stringify(small));
  H.check('below 1024: exempt windows remain floating',
    EXEMPTS.every((id) => small[id].dock === false && small[id].floating && !small[id].autoDocked),
    JSON.stringify(small));
  const autoOrder = await page.evaluate(() =>
    [...document.querySelectorAll('#dock > .cv-panel')].map((el) => el.dataset.panelId));
  H.check('auto-dock produces one stable Main-dock order',
    TARGETS.every((id) => autoOrder.includes(id)), JSON.stringify(autoOrder));

  // The media listener closed the stale menu through PanelWindow._closeMenu;
  // reopening now must build against the compact state.
  H.check('media change closes stale Position menus through their cleanup path',
    await page.evaluate(() => !document.querySelector('.cv-panel-menu')));

  // The dock is off-canvas while compact, but its menu remains the same DOM
  // chrome. Only Float is gated: Default stays, falling back to a dock for a
  // float-by-default window (exercised below).
  await page.evaluate(() => document.querySelector('.cv-panel[data-panel-id="info"] .cv-panel-menu-btn').click());
  const mobileMenu = await page.evaluate(() =>
    [...document.querySelectorAll('.cv-panel-menu-item')].map((item) => item.textContent));
  H.check('compact Position menu drops Float but keeps Default',
    !mobileMenu.includes('Float') && mobileMenu.includes('Default'), JSON.stringify(mobileMenu));
  await page.keyboard.press('Escape');
  const refusedState = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const panel = getPanel('backend');
    const bytes = JSON.stringify(panel.floatPos);
    panel.hooks.positionPanel(panel, 'float');
    return { autoDocked: panel.autoDocked, bytes, after: JSON.stringify(panel.floatPos), dock: panel.dock };
  });
  H.check('refused compact float/default actions preserve restoration state',
    refusedState.autoDocked && refusedState.bytes === refusedState.after && refusedState.dock === 'left',
    JSON.stringify(refusedState));

  H.check('compact reconciliation preserves floatPos byte-for-byte',
    TARGETS.every((id) => JSON.stringify(small[id].floatPos) === savedPositionBytes[id]),
    JSON.stringify({ savedPositionBytes, small }));

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(700);
  let large = await panelState(page);
  H.check('growing above 1024 restores the same floating coordinates',
    TARGETS.every((id) => large[id].dock === false && large[id].floating
      && JSON.stringify(large[id].floatPos) === savedPositionBytes[id]
      && (savedPositions[id].top === undefined
        ? Math.abs(900 - large[id].rect.bottom - savedPositions[id].bottom) <= 2
        : Math.abs(large[id].rect.top - savedPositions[id].top) <= 2)),
  JSON.stringify({ savedPositions, large }));
  H.check('restoration derives dock displacement and viewport-edge clamping without rewriting floatPos',
    large.backend.rect.left > savedPositions.backend.left
      && Math.abs(large.forces.rect.right - (1400 - savedPositions.forces.right)) <= 2
      && TARGETS.every((id) => JSON.stringify(large[id].floatPos) === savedPositionBytes[id]),
  JSON.stringify({ savedPositions, large }));
  H.check('restored floating menu exposes Float again', await page.evaluate(async () => {
    document.querySelector('.cv-panel[data-panel-id="backend"] .cv-panel-menu-btn').click();
    const labels = [...document.querySelectorAll('.cv-panel-menu-item')].map((item) => item.textContent);
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('backend').closeMenu();
    return labels.includes('Float');
  }));

  // Abort a live floating drag at the breakpoint. The pointer's temporary CSS
  // movement must not become the remembered floatPos or leave drag state on a
  // panel that has just been reparented.
  const dragPre = await page.evaluate(() => {
    const panel = document.querySelector('.cv-panel[data-panel-id="backend"]');
    const bar = panel.querySelector('.cv-panel-titlebar').getBoundingClientRect();
    const p = panel.dataset.panelId;
    return { x: bar.left + bar.width / 2, y: bar.top + bar.height / 2, p };
  });
  const dragPreBytes = await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    return JSON.stringify(getPanel(id).floatPos);
  }, dragPre.p);
  await page.mouse.move(dragPre.x, dragPre.y);
  await page.mouse.down();
  await page.mouse.move(dragPre.x + 12, dragPre.y + 12);
  await page.waitForTimeout(50);
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(600);
  await page.mouse.up();
  const aborted = await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const panel = getPanel(id);
    return {
      dock: panel.dock,
      floatPos: JSON.stringify(panel.floatPos),
      moving: panel._moving,
      dragging: panel.el.classList.contains('cv-drag-moving'),
    };
  }, dragPre.p);
  H.check('mid-drag breakpoint cancellation keeps pre-drag geometry and clears residue',
    aborted.dock === 'left' && aborted.floatPos === dragPreBytes
      && !aborted.moving && !aborted.dragging, JSON.stringify({ dragPreBytes, aborted }));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(700);
  const afterAbortRestore = await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const panel = getPanel(id);
    const r = panel.el.getBoundingClientRect();
    return { dock: panel.dock, pos: JSON.stringify(panel.floatPos), left: r.left, top: r.top };
  }, dragPre.p);
  H.check('cancelled drag restores at the original floating position',
    afterAbortRestore.dock === false && afterAbortRestore.pos === dragPreBytes,
  JSON.stringify({ dragPreBytes, afterAbortRestore }));

  // Repeating the same media transition must not accumulate or reshuffle
  // slots. This also exercises the resize-drag end state twice.
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(600);
  const autoOrderAgain = await page.evaluate(() =>
    [...document.querySelectorAll('#dock > .cv-panel')].map((el) => el.dataset.panelId));
  H.check('repeated breakpoint crossing keeps the same dock order',
    JSON.stringify(autoOrderAgain) === JSON.stringify(autoOrder), JSON.stringify(autoOrderAgain));

  // Re-enter compact, then make a real Main-dock drag. Its marker clears, so
  // it remains docked after the next expansion while the untouched panel floats.
  await page.evaluate(() => document.getElementById('mobileMenuToggle').click());
  await page.evaluate(() => { document.getElementById('ui').scrollTop = 0; });
  await page.waitForTimeout(200);
  await reorderToBottom(page, 'backend');
  small = await panelState(page);
  H.check('Main-dock reorder clears only the moved window marker',
    !small.backend.autoDocked && small.forces.autoDocked, JSON.stringify(small));

  // Open a genuinely new floating-definition window while compact. It goes to
  // the Main dock without an auto-restore marker or fabricated float position.
  const newRegistration = await page.evaluate(async () => {
    const { registerPanel, getPanel } = await import('./ui/panels/PanelManager.js');
    const { PanelWindow } = await import('./ui/panels/PanelWindow.js');
    const originalMarkFloating = PanelWindow.prototype.markFloating;
    let floatingCalls = 0;
    PanelWindow.prototype.markFloating = function (...args) {
      floatingCalls += 1;
      return originalMarkFloating.apply(this, args);
    };
    try {
      registerPanel({
        id: 'mobileNewWindow', title: 'Mobile New Window', lifecycle: 'persistent', persist: false,
        buildContent() {}, defaults: { dock: false, collapsed: true, barCollapsed: false },
      });
    } finally {
      PanelWindow.prototype.markFloating = originalMarkFloating;
    }
    const panel = getPanel('mobileNewWindow');
    return { floatingCalls, dock: panel.dock, autoDocked: panel.autoDocked, floatPos: panel.floatPos };
  });
  await page.waitForTimeout(300);
  const newState = await panelState(page, ['mobileNewWindow']);
  H.check('registration while compact never reports a floating transition',
    newRegistration.floatingCalls === 0 && newRegistration.dock === 'left',
  JSON.stringify(newRegistration));
  H.check('new window opened while compact starts in Main dock without auto state',
    newState.mobileNewWindow.dock === 'left' && newState.mobileNewWindow.inMain
      && !newState.mobileNewWindow.autoDocked && newState.mobileNewWindow.floatPos === null,
  JSON.stringify(newState.mobileNewWindow));

  // Default on a float-by-default window while compact: floating is refused,
  // so it applies the same Main-dock fallback instead of doing nothing.
  const compactDefault = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const panel = getPanel('mobileNewWindow');
    panel.hooks.positionPanel(panel, 'default');
    return {
      dock: panel.dock,
      floating: panel.el.classList.contains('cv-floating'),
      inMain: !!document.querySelector('#dock > .cv-panel[data-panel-id="mobileNewWindow"]'),
    };
  });
  H.check('compact Default docks a float-by-default window instead of floating it',
    compactDefault.dock === 'left' && compactDefault.inMain && !compactDefault.floating,
  JSON.stringify(compactDefault));

  // Closed hide-mode panel: expansion must update its stored placement even
  // while its DOM is detached, then reopening on the large screen floats it.
  const closedDef = {
    id: 'mobileClosedWindow', title: 'Mobile Closed Window', lifecycle: 'persistent',
    persist: false, closable: true, closeMode: 'hide',
    defaults: { dock: false, anchor: { left: 180, top: 180 }, collapsed: true },
  };
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);
  const closedBefore = await page.evaluate(async (def) => {
    const { registerPanel, getPanel } = await import('./ui/panels/PanelManager.js');
    const panel = registerPanel({ ...def, buildContent() {} });
    return { pos: JSON.stringify(panel.floatPos), dock: panel.dock };
  }, closedDef);
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    const { closePanel } = await import('./ui/panels/PanelManager.js');
    closePanel('mobileClosedWindow');
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);
  const closedAfter = await page.evaluate(async () => {
    const { getPanel, openPanel } = await import('./ui/panels/PanelManager.js');
    const panel = getPanel('mobileClosedWindow');
    const stored = { dock: panel.dock, autoDocked: panel.autoDocked, pos: JSON.stringify(panel.floatPos) };
    openPanel('mobileClosedWindow');
    const rect = panel.el.getBoundingClientRect();
    return { ...stored, openDock: panel.dock, left: rect.left, top: rect.top };
  });
  H.check('closed auto-docked panels restore stored floating placement on expansion',
    closedAfter.dock === false && !closedAfter.autoDocked && closedAfter.pos === closedBefore.pos
      && closedAfter.openDock === false,
  JSON.stringify({ closedBefore, closedAfter }));

  // Transient panels retain the in-session marker while removed and reconcile
  // immediately when re-registered on a large screen.
  const transientDef = {
    id: 'mobileTransientWindow', title: 'Mobile Transient Window', lifecycle: 'persistent',
    persist: false, defaults: { dock: false, anchor: { left: 240, top: 210 }, collapsed: true },
  };
  await page.evaluate(async (def) => {
    const { registerPanel } = await import('./ui/panels/PanelManager.js');
    registerPanel({ ...def, buildContent() {} });
  }, transientDef);
  const transientBefore = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    return JSON.stringify(getPanel('mobileTransientWindow').floatPos);
  });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    const { removePanel } = await import('./ui/panels/PanelManager.js');
    removePanel('mobileTransientWindow');
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);
  const transientAfter = await page.evaluate(async (def) => {
    const { registerPanel, getPanel } = await import('./ui/panels/PanelManager.js');
    const panel = registerPanel({ ...def, buildContent() {} });
    return { dock: panel.dock, autoDocked: panel.autoDocked, pos: JSON.stringify(panel.floatPos) };
  }, transientDef);
  H.check('removed auto-docked transient panels restore at re-registration',
    transientAfter.dock === false && !transientAfter.autoDocked && transientAfter.pos === transientBefore,
  JSON.stringify({ transientBefore, transientAfter }));

  // Reset UI must discard the removed transient cache, not just registered
  // panels and the persisted snapshot.
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    const { removePanel, resetAllPanels } = await import('./ui/panels/PanelManager.js');
    removePanel('mobileTransientWindow');
    resetAllPanels();
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);
  const transientAfterReset = await page.evaluate(async (def) => {
    const { registerPanel } = await import('./ui/panels/PanelManager.js');
    const panel = registerPanel({ ...def, buildContent() {} });
    return { dock: panel.dock, autoDocked: panel.autoDocked, pos: JSON.stringify(panel.floatPos) };
  }, transientDef);
  H.check('Reset UI clears removed transient auto-dock state',
    transientAfterReset.dock === false && !transientAfterReset.autoDocked
      && transientAfterReset.pos === JSON.stringify(transientDef.defaults.anchor),
  JSON.stringify({ transientAfterReset, defaultPos: transientDef.defaults.anchor }));

  // A stale auto-docked entry must not disturb a custom Main-dock order while
  // the remaining panels are still registering on a large screen.
  const customLayout = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('panelLayout') || '{}');
    const customOrder = [...(data.dockOrder || [])].reverse();
    const forcesIndex = customOrder.indexOf('forces');
    if (forcesIndex >= 0) customOrder.splice(forcesIndex, 1);
    customOrder.splice(Math.min(2, customOrder.length), 0, 'forces');
    data.dockOrder = customOrder;
    data.panels = data.panels || {};
    data.panels.forces = {
      ...(data.panels.forces || {}),
      dock: 'left',
      closed: false,
      autoDocked: true,
      pos: { right: 80, top: 260 },
    };
    localStorage.setItem('panelLayout', JSON.stringify(data));
    return { expectedDockOrder: customOrder.filter((id) => id !== 'forces') };
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  const customAfterReload = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const panel = getPanel('forces');
    return {
      dockOrder: [...document.querySelectorAll('#dock > .cv-panel')]
        .map((el) => el.dataset.panelId),
      forces: { dock: panel.dock, autoDocked: panel.autoDocked, floating: panel.el.classList.contains('cv-floating') },
    };
  });
  H.check('large reload preserves custom Main-dock order while stale entry floats',
    JSON.stringify(customAfterReload.dockOrder) === JSON.stringify(customLayout.expectedDockOrder)
      && customAfterReload.forces.dock === false
      && !customAfterReload.forces.autoDocked && customAfterReload.forces.floating,
  JSON.stringify({ customLayout, customAfterReload }));

  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  small = await panelState(page);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('panelLayout') || '{}'));
  H.check('reload while compact preserves autoDocked flags',
    persisted.panels?.forces?.autoDocked === true
      && persisted.panels?.backend?.autoDocked === false,
  JSON.stringify({ backend: persisted.panels?.backend, forces: persisted.panels?.forces }));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(700);
  large = await panelState(page);
  H.check('after reload expansion restores untouched auto window only',
    large.forces.dock === false && large.forces.floating
      && large.backend.dock === 'left' && large.backend.inMain,
  JSON.stringify(large));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
