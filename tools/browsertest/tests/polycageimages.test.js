// A cage centred on the cell boundary (α-boron's B12 on the corners, Si46's
// Si20 on the corners and Si24 on the faces, fcc C60) is drawn at every
// periodic image the display shows, like an atom there — not once, wherever
// its centre landed in the cell. With Show Periodic Images off, one copy each.
// Both paths (WASM, JS) must agree.
'use strict';
const H = require('../harness');
const fix = require('../fixtures/polyhedra_golden.json');

// name -> [cages with periodic images, cages without]
const CASES = {
  aflow152_B: [8, 1],          // α-B12: one icosahedron, centred on the corner
  aflow217_Si: [21, 8],        // Si46: Si20 at 1 + 8 corners, Si24 at 6 face sites × 2
  hand_C60_fullerite: [14, 4], // fcc: 8 corners + 6 face centres
  aflow066_UB12: [3, 3],       // all inside the primitive cell: unchanged
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  for (const [name, [withImages, without]] of Object.entries(CASES)) {
    const s = fix.structures.find((x) => x.name === name);
    const got = await page.evaluate(async ({ poscar, name }) => {
      const cv = await import('./core/crystal-viewer.js');
      const { fileBrowser, general } = await import('./state/store.js');
      const pm = await import('./render/PolyhedraModule.js');
      await cv.loadStructure(poscar, `${name}.vasp`);
      if (!general.showPolyhedra) document.getElementById('showPolyhedra')?.click();
      const out = {};
      for (const periodic of [true, false]) {
        const toggle = document.getElementById('showPeriodic');
        if (toggle.checked !== periodic) toggle.click(); // the real control
        await new Promise((r) => setTimeout(r, 300));
        for (const wasm of [true, false]) {
          general.useWasmPolyhedra = wasm;
          const st = fileBrowser.selectedStructure;
          st.polyhedra = null;
          pm.updatePolyhedra();
          const t0 = performance.now();
          while (!st.polyhedra?.polyhedra && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
          out[`${periodic ? 'images' : 'noImages'}_${wasm ? 'wasm' : 'js'}`] = (st.polyhedra?.polyhedra ?? []).filter((p) => p.type !== 'centered').length;
        }
      }
      const toggle = document.getElementById('showPeriodic');
      if (!toggle.checked) toggle.click();
      general.useWasmPolyhedra = true;
      return out;
    }, { poscar: s.poscar, name });
    H.check(`${name}: ${withImages} cages with periodic images (WASM and JS)`,
      got.images_wasm === withImages && got.images_js === withImages, JSON.stringify(got));
    H.check(`${name}: ${without} without`,
      got.noImages_wasm === without && got.noImages_js === without, JSON.stringify(got));
  }
  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
