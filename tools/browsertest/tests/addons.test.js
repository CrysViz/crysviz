// Energy Landscape windows: an addon is now a CONTROLS window in the left
// dock (docs/ui/LandscapePanel.js, id 'landscape', hosting the addon's 📂
// loader) plus a PLOTS window ('landscapePlots') that defaults to the wide
// right dock (docs/ui/panels/RightDock.js), starts closed, and opens by
// itself when a landscape JSON is loaded. This covers the window/right-dock
// wiring only, not the heatmap content itself.
'use strict';
const H = require('../harness');

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

  // ---- controls window docked left, loader hosted in it -------------------
  const controls = await page.evaluate(() => {
    const el = document.querySelector('#dock .cv-panel[data-panel-id="landscape"]');
    return {
      present: !!el,
      title: el?.querySelector('.cv-panel-title')?.textContent || '',
      hasLoader: !!el?.querySelector('#landscapeControlsHost .lsc-load-btn'),
    };
  });
  H.check('Energy Landscape controls window docked left', controls.present);
  H.check('controls window titled "Energy Landscape"', /Energy Landscape/.test(controls.title),
    controls.title);
  H.check('addon loader (📂) hosted in the controls window', controls.hasLoader);

  // ---- plots window registered, closed by default --------------------------
  const plotsState = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const p = getPanel('landscapePlots');
    return {
      present: !!p,
      closed: !!p?.closed,
      dock: p?.dock ?? null,
      inDom: !!document.querySelector('.cv-panel[data-panel-id="landscapePlots"]'),
    };
  });
  H.check('plots window registered, closed, right-dock default',
    plotsState.present && plotsState.closed && plotsState.dock === 'right' && !plotsState.inDom,
    JSON.stringify(plotsState));

  // ---- loading a JSON opens the plots window and yields scene width -------
  const viewW0 = await page.evaluate(() => document.getElementById('view').clientWidth);
  await page.evaluate(() => {
    const host = document.getElementById('landscapeControlsHost');
    const dt = new DataTransfer();
    dt.items.add(new File(['{"stub":1}'], 'scan.json', { type: 'application/json' }));
    host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(500);
  const opened = await page.evaluate(() => {
    const el = document.querySelector('#splitPaneBody > .cv-panel[data-panel-id="landscapePlots"]');
    return {
      active: document.getElementById('viewArea').classList.contains('split-active'),
      hidden: document.getElementById('splitPane').hidden,
      docked: !!el,
      front: !!el && el.classList.contains('cv-front'),
      tab: [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
        .some((t) => /Landscape Plots/.test(t.textContent)),
      hostPopulated: (el?.querySelector('.landscape-host')?.children.length || 0) > 0,
      viewW: document.getElementById('view').clientWidth,
    };
  });
  H.check('loading a JSON opens the plots window in #splitPane',
    opened.active && !opened.hidden && opened.docked && opened.front, JSON.stringify(opened));
  H.check('its tab shows in the header strip', opened.tab);
  H.check('landscape content rendered into the plots window body', opened.hostPopulated);
  H.check('3D view yields width to the right dock', opened.viewW < viewW0 - 100,
    `view ${viewW0} -> ${opened.viewW}`);

  // ---- closing the plots window frees the dock again -----------------------
  await closePanel(page, 'landscapePlots');
  const closed = await page.evaluate(() => ({
    active: document.getElementById('viewArea').classList.contains('split-active'),
    hidden: document.getElementById('splitPane').hidden,
    inDom: !!document.querySelector('.cv-panel[data-panel-id="landscapePlots"]'),
    viewW: document.getElementById('view').clientWidth,
  }));
  H.check('closePanel hides #splitPane', !closed.active && closed.hidden);
  H.check('plots window detached (closed) but still registered', !closed.inDom);
  H.check('close restores full-width view', closed.viewW >= viewW0 - 4,
    `view ${closed.viewW} vs ${viewW0}`);

  // The stub JSON is deliberately not a valid dataset — the addon's caught
  // "failed to load JSON" console.error is the expected outcome (the window
  // opening to show the error box is exactly what we asserted).
  const unexpected = errors.filter((e) => !/Landscape: failed to load JSON/.test(e));
  H.check('no page errors', unexpected.length === 0, unexpected[0] || '');
  await H.finish(browser);
})().catch(H.crash);
