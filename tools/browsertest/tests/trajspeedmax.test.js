// Trajectory player controls and the experimental flag.
//  - The Render dropdown (Auto / Full) is offered to everyone, not only in
//    ?debug; debug merely decorates the Auto label with the detected motion
//    kind.
//  - Speed "max" (one frame per animation frame) is experimental: absent by
//    default, present when the page is opened with ?experimental
//    (debug/experimentalMode.js). Faster modes in development live on another
//    branch and are not part of this one.
'use strict';
const H = require('../harness');

const TRAJ = [
  '2', 'Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3',
  'Na 0 0 0', 'Cl 2 0 0',
  '2', 'Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3',
  'Na 0.05 0 0', 'Cl 2.05 0 0',
].join('\n');

const URL = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

const inspect = (page) => page.evaluate(async (traj) => {
  const cv = await import('./core/crystal-viewer.js');
  const { openPanel } = await import('./ui/panels/PanelManager.js');
  const { isDebugMode } = await import('./debug/debugMode.js');
  const { isExperimentalMode } = await import('./debug/experimentalMode.js');
  await cv.loadStructure(traj, 'speed.xyz');
  openPanel('trajectory');
  await new Promise((r) => setTimeout(r, 300));
  const render = document.getElementById('renderModeOpt');
  const renderSelect = document.getElementById('renderModeSelect');
  const speed = document.getElementById('speedSelect');
  return {
    debug: isDebugMode(),
    experimental: isExperimentalMode(),
    renderShown: !!render && !render.hidden && getComputedStyle(render).display !== 'none',
    renderOptions: [...renderSelect.options].map((o) => o.value),
    autoLabel: renderSelect.querySelector('option[value="auto"]')?.textContent,
    speedOptions: [...speed.options].map((o) => o.value),
    speedSelected: speed.value,
  };
}, TRAJ);

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const plain = await inspect(page);
  H.check('plain URL: neither debug nor experimental', plain.debug === false && plain.experimental === false, JSON.stringify(plain));
  H.check('Render dropdown is shown for everyone, with Auto and Full',
    plain.renderShown && JSON.stringify(plain.renderOptions) === '["auto","full"]' && plain.autoLabel === 'Auto',
    JSON.stringify(plain));
  H.check('Speed "max" is absent by default; 0.05 s stays the default',
    !plain.speedOptions.includes('0') && plain.speedSelected === '50', JSON.stringify(plain));

  // Same app, opened with ?experimental (the flag is read once at module load,
  // so this is a fresh navigation, not a toggle).
  await page.goto(`${URL}?experimental`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  const exp = await inspect(page);
  H.check('?experimental: flag on', exp.experimental === true, JSON.stringify(exp));
  H.check('?experimental: Speed "max" is offered', exp.speedOptions.includes('0'), JSON.stringify(exp));
  H.check('?experimental: Render dropdown unchanged (Auto and Full)',
    exp.renderShown && JSON.stringify(exp.renderOptions) === '["auto","full"]', JSON.stringify(exp));

  // Plotly comes from a CDN; without egress that fetch fails with
  // ERR_TUNNEL_CONNECTION_FAILED, which is the sandbox, not the panel.
  const real = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED/.test(e));
  H.check('no page errors', real.length === 0, real[0] || '');
  await H.finish(browser);
})().catch(H.crash);
