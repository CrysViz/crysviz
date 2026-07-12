// Energy Landscape window: an addon is now just a regular panel window
// (registered in docs/ui/panels/defaultPanels.js, id 'landscape') that
// DEFAULTS to the wide right dock (docs/ui/panels/RightDock.js) and starts
// closed — opened via openPanel/the Features toggle. This covers the
// window/right-dock wiring only, not the heatmap content itself.
'use strict';
const H = require('../harness');

async function openPanel(page, id) {
  await page.evaluate(async (id) => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel(id);
  }, id);
  await page.waitForTimeout(300);
}

async function closePanel(page, id) {
  await page.evaluate(async (id) => {
    const { closePanel } = await import('./ui/panels/PanelManager.js');
    closePanel(id);
  }, id);
  await page.waitForTimeout(300);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page);

  // ---- Energy Landscape window is registered, closed by default ----------
  const panelState = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const p = getPanel('landscape');
    return {
      present: !!p,
      title: p?.def.title || '',
      closed: !!p?.closed,
      dock: p?.dock ?? null,
      inDom: !!document.querySelector('.cv-panel[data-panel-id="landscape"]'),
    };
  });
  H.check('Energy Landscape window registered', panelState.present);
  H.check('window titled "Energy Landscape"', /Energy Landscape/.test(panelState.title),
    panelState.title);
  H.check('starts closed (detached) with a right-dock default',
    panelState.closed && panelState.dock === 'right' && !panelState.inDom,
    JSON.stringify(panelState));

  // ---- opening the window docks it right and yields scene width ----------
  const viewW0 = await page.evaluate(() => document.getElementById('view').clientWidth);
  await openPanel(page, 'landscape');
  const opened = await page.evaluate(() => {
    const el = document.querySelector('#splitPaneBody > .cv-panel[data-panel-id="landscape"]');
    return {
      active: document.getElementById('viewArea').classList.contains('split-active'),
      hidden: document.getElementById('splitPane').hidden,
      docked: !!el,
      front: !!el && el.classList.contains('cv-front'),
      tab: [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
        .some((t) => /Energy Landscape/.test(t.textContent)),
      hostPopulated: (el?.querySelector('.landscape-host')?.children.length || 0) > 0,
      viewW: document.getElementById('view').clientWidth,
    };
  });
  H.check('openPanel docks the window into #splitPane', opened.active && !opened.hidden
    && opened.docked && opened.front, JSON.stringify(opened));
  H.check('its tab shows in the header strip', opened.tab);
  H.check('landscape content rendered into the window body', opened.hostPopulated);
  H.check('3D view yields width to the right dock', opened.viewW < viewW0 - 100,
    `view ${viewW0} -> ${opened.viewW}`);

  // ---- closing the window frees the dock again ----------------------------
  await closePanel(page, 'landscape');
  const closed = await page.evaluate(() => ({
    active: document.getElementById('viewArea').classList.contains('split-active'),
    hidden: document.getElementById('splitPane').hidden,
    inDom: !!document.querySelector('.cv-panel[data-panel-id="landscape"]'),
    viewW: document.getElementById('view').clientWidth,
  }));
  H.check('closePanel hides #splitPane', !closed.active && closed.hidden);
  H.check('window detached (closed) but still registered', !closed.inDom);
  H.check('close restores full-width view', closed.viewW >= viewW0 - 4,
    `view ${closed.viewW} vs ${viewW0}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
