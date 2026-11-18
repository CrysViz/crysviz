// The Selection Inspector's mini view draws a disordered site the way the main
// view does — one colour per species, a camera-facing pie sized by occupancy
// (render/WedgeAtoms.js applySingleMeshWedge) — instead of its single
// representative colour. Checked by colouring a site's three species pure
// red, green and blue and counting each in the inspector's canvas.
'use strict';
const path = require('path');
const { PNG } = require('pngjs');
const fs = require('fs');
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  const picked = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const cv = await import('./core/crystal-viewer.js');
    const s = fileBrowser.selectedStructure;
    const w = s.periodic.visibleWrapped;
    const inst = w.elements.findIndex((e) => e === 'Cu');
    const src = w.srcIndex?.[inst] ?? inst;
    s.atoms[src].species = [
      { element: 'Cu', occupancy: 0.5, color: 0xff0000 },
      { element: 'Zn', occupancy: 0.3, color: 0x00ff00 },
      { element: 'Ni', occupancy: 0.2, color: 0x0000ff },
    ];
    cv.updateVisualization({ reRenderAtoms: true, reRenderComposition: true });
    return { inst, src };
  });
  await page.waitForTimeout(800);
  await page.evaluate(async ({ inst }) => {
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    selectAtomsByInstances([inst]);
    setStructurePanelOpen(true);
  }, picked);
  await page.waitForTimeout(500);
  await H.clickById(page, 'selectionInspectBtn');
  await page.waitForTimeout(1500);

  const clip = await page.evaluate(() => {
    const c = document.querySelector('#siViewport .pi-mini-canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  H.check('the Selection Inspector opens with its mini view', !!clip && clip.width > 50, JSON.stringify(clip));
  if (clip) {
    const file = path.join(__dirname, '..', 'artifacts', 'inspectorwedges.png');
    await page.screenshot({ path: file, clip });
    const png = PNG.sync.read(fs.readFileSync(file));
    const n = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < png.data.length; i += 4) {
      const ch = [png.data[i], png.data[i + 1], png.data[i + 2]];
      const top = ch.indexOf(Math.max(...ch));
      const rest = Math.max(...ch.filter((_, k) => k !== top), 8);
      // A clearly dominant channel on a bright pixel: the grey panel never
      // qualifies, while the lit side of pure green (tone-mapped towards a
      // pale green) still counts as green.
      if (ch[top] > 90 && ch[top] > 1.25 * rest) n['rgb'[top]]++;
    }
    H.check('the disordered site shows all three species colours (red, green, blue)',
      n.r > 200 && n.g > 100 && n.b > 60, JSON.stringify(n));
  }

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
