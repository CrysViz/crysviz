// A rebuild-lifecycle panel that is right-docked and then goes unavailable
// (its structure lacks the feature) must close out of the dock, and — crucially
// — reopen AND rebuild its content when the feature returns, without a UI reset.
// Regression: refreshActivePanels reopened via openPanel()->expand() while the
// panel was still flagged unavailable, so expand() bailed and the tab came back
// empty (or never fully); refreshPanelAvailability wasn't dock-aware at all.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(400);

  const res = await page.evaluate(async () => {
    const PM = await import('./ui/panels/PanelManager.js');

    let featureOn = true;
    let builds = 0;
    PM.registerPanel({
      id: 'availProbe',
      title: 'Avail Probe',
      lifecycle: 'rebuild',
      available() { return featureOn; },
      buildContent(body) { builds += 1; body.innerHTML = '<div class="probe-content">hi</div>'; },
      defaults: { dock: 'left', order: 999, collapsed: true },
    });

    const panel = PM.getPanel('availProbe');
    // Move to the right dock and open it (front tab, expanded -> content built).
    panel.dock = 'right';
    PM.openPanel('availProbe');
    await new Promise((r) => setTimeout(r, 50));

    const opened = {
      closed: panel.closed, available: panel.available,
      expanded: panel.isExpanded(), built: panel.built,
      hasContent: !!panel.el.querySelector('.probe-content'),
    };

    // Feature disappears (switch to a structure without it) -> full re-sync.
    featureOn = false;
    PM.refreshActivePanels();
    await new Promise((r) => setTimeout(r, 50));
    const gone = {
      closed: panel.closed, available: panel.available,
      closedForUnavailable: panel._closedForUnavailable,
    };

    // Feature returns (switch back) -> must reopen and rebuild, no reset.
    featureOn = true;
    PM.refreshActivePanels();
    await new Promise((r) => setTimeout(r, 50));
    const back = {
      closed: panel.closed, available: panel.available,
      expanded: panel.isExpanded(), built: panel.built,
      hasContent: !!panel.el.querySelector('.probe-content'),
    };

    // Same round-trip but via the grey-only refresh path used by URL-load,
    // live-plot start, and overlay sync — it must be dock-aware too.
    featureOn = false;
    PM.refreshPanelAvailability();
    await new Promise((r) => setTimeout(r, 30));
    const goneGrey = { closed: panel.closed, available: panel.available };
    featureOn = true;
    PM.refreshPanelAvailability();
    await new Promise((r) => setTimeout(r, 30));
    const backGrey = {
      closed: panel.closed, available: panel.available,
      hasContent: !!panel.el.querySelector('.probe-content'),
    };

    PM.removePanel('availProbe');
    return { opened, gone, back, goneGrey, backGrey };
  });

  const r = res;
  H.check('opens right-docked with built content', r.opened.built && r.opened.hasContent && !r.opened.closed, JSON.stringify(r.opened));
  H.check('closes out of the dock when feature disappears', r.gone.closed && r.gone.closedForUnavailable, JSON.stringify(r.gone));
  H.check('reopens when feature returns (refreshActivePanels)', !r.back.closed && r.back.available, JSON.stringify(r.back));
  H.check('rebuilds content on reopen (not an empty tab)', r.back.hasContent && r.back.built, JSON.stringify(r.back));
  H.check('grey-only refresh is dock-aware: closes when unavailable', r.goneGrey.closed, JSON.stringify(r.goneGrey));
  H.check('grey-only refresh reopens+rebuilds when available', !r.backGrey.closed && r.backGrey.hasContent, JSON.stringify(r.backGrey));
  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
