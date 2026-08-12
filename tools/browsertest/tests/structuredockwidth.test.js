// The Structure window ('info') keeps a fixed 300px body while FLOATING (so
// tab switches don't shrink-wrap/resize it) but must follow the dock's width
// like every other panel when docked — the width lives in
// styles/structureInfoPanel.css as .si-panel-body with docked overrides, not
// as an inline style (which used to pin 300px in both docks too).
'use strict';
const H = require('../harness');

const PANEL = 'info';

async function moveTo(page, id, mode) {
  await page.evaluate(async ({ id, mode }) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const p = getPanel(id);
    p.hooks.positionPanel(p, mode);
  }, { id, mode });
}

async function widths(page, id) {
  return page.evaluate((id) => {
    const el = document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
    const body = el.querySelector('.cv-panel-body');
    const dock = document.getElementById('dock');
    const pane = document.getElementById('splitPaneBody');
    const sibling = [...document.querySelectorAll('#dock .cv-panel')]
      .find((s) => s !== el);
    return {
      floating: el.classList.contains('cv-floating'),
      // The CSS width (content-box: excludes the body's padding/border) —
      // what .si-panel-body's fixed 300px actually pins while floating.
      cssWidth: parseFloat(getComputedStyle(body).width),
      body: body.getBoundingClientRect().width,
      panel: el.getBoundingClientRect().width,
      dock: dock ? dock.getBoundingClientRect().width : 0,
      pane: pane ? pane.getBoundingClientRect().width : 0,
      sibling: sibling ? sibling.getBoundingClientRect().width : 0,
    };
  }, id);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Floating (the default): the fixed no-shrink-wrap width still applies.
  let w = await widths(page, PANEL);
  H.check('floating: Structure body keeps its fixed 300px width',
    w.floating && Math.abs(w.cssWidth - 300) < 2, JSON.stringify(w));

  // Main dock: the body must follow the dock column like its neighbours.
  await moveTo(page, PANEL, 'left');
  w = await widths(page, PANEL);
  H.check('main dock: Structure window matches its docked neighbours',
    !w.floating && w.sibling > 0 && Math.abs(w.panel - w.sibling) < 2,
    JSON.stringify(w));
  H.check('main dock: Structure body is no longer pinned to 300px',
    Math.abs(w.body - w.panel) < 2, JSON.stringify(w));

  // Side dock (the wide right pane): the body must fill the pane.
  await moveTo(page, PANEL, 'right');
  w = await widths(page, PANEL);
  H.check('side dock: Structure body fills the pane width',
    w.pane > 320 && Math.abs(w.body - w.pane) < 8, JSON.stringify(w));

  // Back to floating: the fixed width returns (no sticky dock styling).
  await moveTo(page, PANEL, 'float');
  w = await widths(page, PANEL);
  H.check('re-floated: the fixed 300px width is back',
    w.floating && Math.abs(w.cssWidth - 300) < 2, JSON.stringify(w));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
