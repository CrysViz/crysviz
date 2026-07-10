// Energy Landscape panel: the old right-side "Addons" pane framework
// (docs/ui/addons/*) has been removed in favor of the shared SplitView
// workflow — an addon is now just a docked left panel (registered in
// docs/ui/panels/defaultPanels.js, id 'landscape') whose onExpand/onCollapse
// open/close the one shared right-side split pane (docs/ui/panels/SplitView.js,
// #splitPane/#splitPaneBody) via docs/ui/LandscapeSplitView.js. This covers
// the panel/split-view wiring only, not the heatmap content itself.
'use strict';
const H = require('../harness');

async function expandPanel(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel(id).expand();
  }, id);
  await page.waitForTimeout(300);
}

async function collapsePanel(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel(id).collapse();
  }, id);
  await page.waitForTimeout(300);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page);

  // ---- Energy Landscape dock panel is registered -------------------------
  const panelState = await page.evaluate(() => {
    const el = document.querySelector('.cv-panel[data-panel-id="landscape"]');
    return { present: !!el, title: el?.querySelector('.cv-panel-title')?.textContent || '' };
  });
  H.check('Energy Landscape panel docked', panelState.present);
  H.check('panel titled "Energy Landscape"', /Energy Landscape/.test(panelState.title),
    panelState.title);

  // ---- expanding the panel opens the shared split pane -------------------
  const viewW0 = await page.evaluate(() => document.getElementById('view').clientWidth);
  await expandPanel(page, 'landscape');
  const opened = await page.evaluate(() => ({
    active: document.getElementById('viewArea').classList.contains('split-active'),
    hidden: document.getElementById('splitPane').hidden,
    title: document.getElementById('splitPaneTitle').textContent,
    hasBody: document.getElementById('splitPaneBody').children.length > 0,
    viewW: document.getElementById('view').clientWidth,
  }));
  H.check('expand opens #splitPane', opened.active && !opened.hidden);
  H.check('split pane titled "Energy Landscape"', opened.title === 'Energy Landscape', opened.title);
  H.check('split pane body populated', opened.hasBody);
  H.check('3D view yields width to the split pane', opened.viewW < viewW0 - 100,
    `view ${viewW0} -> ${opened.viewW}`);

  // ---- collapsing the panel closes the split pane again ------------------
  await collapsePanel(page, 'landscape');
  const closed = await page.evaluate(() => ({
    active: document.getElementById('viewArea').classList.contains('split-active'),
    hidden: document.getElementById('splitPane').hidden,
    viewW: document.getElementById('view').clientWidth,
  }));
  H.check('collapse closes #splitPane', !closed.active && closed.hidden);
  H.check('close restores full-width view', closed.viewW >= viewW0 - 4,
    `view ${closed.viewW} vs ${viewW0}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
