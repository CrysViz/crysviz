// The Download menu's "Extended XYZ (all frames)" and the host's
// export_structure extxyz are one path (SavePanel.js extxyzExport): the button
// downloads every frame of the row on show, and the file is the same text the
// command returns.
'use strict';
const fs = require('fs');
const H = require('../harness');

const frame = (z) => `2
Lattice="5 0 0 0 5 0 0 0 5" Properties=species:S:1:pos:R:3 pbc="T T T"
H 1.0 1.0 1.0
H 1.0 1.0 ${z}
`;
const TRAJ = frame(1.70) + frame(1.74) + frame(1.80);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async (text) => (await import('./core/crystal-viewer.js')).loadStructure(text, 'h2.extxyz'), TRAJ);
  await page.waitForTimeout(1500);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('saveExtxyzButton')).click()),
  ]);
  const name = download.suggestedFilename();
  const text = fs.readFileSync(await download.path(), 'utf8');
  const host = await page.evaluate(() => window.crysvizHost.dispatch({ command: 'export_structure', args: { format: 'extxyz' } }));

  const blocks = text.trim().split('\n').filter((line) => line.startsWith('Lattice='));
  H.check('the Download menu has Extended XYZ', /\.extxyz$/.test(name), name);
  // Each frame's own geometry: the second H at z = 1.70, 1.74, 1.80 Å.
  const zs = text.trim().split('\n').filter((line) => line.startsWith('H ')).filter((_, i) => i % 2 === 1)
    .map((line) => Number(line.split(/\s+/)[3]).toFixed(2));
  H.check('it writes every frame of the row (3), each with its own positions',
    blocks.length === 3 && zs.join() === '1.70,1.74,1.80', JSON.stringify({ blocks: blocks.length, zs }));
  H.check('the file is what export_structure extxyz returns', host.ok && host.result.frames === 3 && host.result.text === text,
    JSON.stringify({ ok: host.ok, frames: host.result?.frames, same: host.result?.text === text }));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
