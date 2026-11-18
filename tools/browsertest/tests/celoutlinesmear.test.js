// Cel shading, screen-space outlines: lines are solid, not smudges.
//
// The edge pass faded a line in over 1x..2x its depth threshold, so where a
// depth gap grows slowly — a force arrow running alongside a bond, entering
// an atom, a bond passing just behind an atom — the line came out as a long
// grey smudge, and an arrow's own outline broke off where it touched other
// objects. Now the ramp is short (1x..1.25x) and arrows get a line wherever
// they border something else (CelOutlinePass.js).
//
// Pixel checks against an outline-free frame: every pixel the pass changed
// should be line-black, not a darkened blend of the colour underneath; and
// the ring of atom/bond pixels around each arrow should be line.
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');
const fs = require('fs');

// C/N chain along x with long forces tilted out of the view plane: each
// shaft crosses its bond in depth, from just behind it to just in front, so
// every depth gap between them occurs somewhere along it — including the
// near-threshold ones that used to fade in as a smudge.
const XYZ = [
  '8', 'Lattice="14 0 0 0 14 0 0 0 14" Properties=species:S:1:pos:R:3:forces:R:3',
  'C 3.0 7.0 7.0    1.2  0.15  0.25',
  'N 4.4 7.0 7.0    1.1 -0.15 -0.25',
  'C 5.8 7.0 7.0    1.2  0.10  0.20',
  'N 7.2 7.0 7.0   -1.2  0.15  0.25',
  'C 8.6 7.0 7.0   -1.1 -0.10 -0.20',
  'N 10.0 7.0 7.0  -1.2  0.10  0.25',
  // Two bonds of the middle C tilted away from / toward the viewer: the
  // atom's edge crosses them at a slowly growing depth gap.
  'N 6.5 6.3 6.0    0.0  0.0  0.0',
  'N 5.2 7.8 7.9    0.0  0.0  0.0',
].join('\n');

const read = (file) => PNG.sync.read(fs.readFileSync(file));
const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Of the pixels the outline changed, the share that is smudge: darkened by
 *  more than 40 levels but not line-black, with no line-black pixel next to
 *  it. (A line's one-pixel antialiased rim always touches the line; a
 *  smudge is a band of grey away from it.) */
function partial(outlined, plain) {
  const { width: w, height: h } = plain;
  const black = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) black[k] = lum(outlined.data, k * 4) <= 70 ? 1 : 0;
  let changed = 0;
  let blend = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      const lo = lum(outlined.data, k * 4);
      const lp = lum(plain.data, k * 4);
      if (lp - lo < 40) continue;
      changed++;
      if (black[k]) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1; dx++) if (black[k + dy * w + dx]) { touches = true; break; }
      if (!touches) blend++;
    }
  }
  return { changed, blend, frac: changed ? blend / changed : 1 };
}

/** Arrow pixels: where hiding the arrows changes the outline-free frame. */
function arrowMask(plain, noArrows) {
  const { width: w, height: h } = plain;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    const d = Math.abs(plain.data[j] - noArrows.data[j]) + Math.abs(plain.data[j + 1] - noArrows.data[j + 1])
      + Math.abs(plain.data[j + 2] - noArrows.data[j + 2]);
    m[i] = d > 60 ? 1 : 0;
  }
  return m;
}

/** Where an arrow borders an atom or bond (not the background): the share of
 *  the 2-pixel ring around the arrow, on those objects, that is outlined —
 *  the ring pixel itself black (the arrow's line, where the arrow is in
 *  front), or an arrow pixel next to it black (the object's contour over
 *  the arrow, where the object is in front: an atom's hull ring, or the
 *  contour drawn on the arrow where an atom cuts it off). A line that
 *  breaks off or fades where the arrow touches them leaves this low. */
function arrowContactLine(outlined, plain, noArrows) {
  const { width: w, height: h } = plain;
  const arrow = arrowMask(plain, noArrows);
  let ring = 0;
  let black = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const k = y * w + x;
      if (arrow[k]) continue;
      let near = false;
      let arrowBlack = false;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const j = k + dy * w + dx;
        if (!arrow[j]) continue;
        near = true;
        if (lum(outlined.data, j * 4) < 60) arrowBlack = true;
      }
      if (!near || lum(noArrows.data, k * 4) > 240) continue; // background
      ring++;
      if (arrowBlack || lum(outlined.data, k * 4) < 60) black++;
    }
  }
  return { ring, black, frac: ring ? black / ring : 0 };
}

async function setSlider(page, id, v) {
  await page.evaluate(({ id, v }) => {
    const el = document.getElementById(id);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, v });
  await page.waitForTimeout(700);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'chain.xyz'), XYZ);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const t = document.getElementById('showLattice'); if (t && t.checked) t.click(); });
  await H.clickById(page, 'showForcesToggle');
  await page.waitForTimeout(500);
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(400);
  await H.setSelect(page, 'renderStyleMenu', 'cel');
  await page.waitForTimeout(700);
  await H.setSelect(page, 'celOutlineModeMenu', 'screen');
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    (await import('./ui/WindowAndSceneControls.js')).setViewDirection([0, -0.25, 1], { refit: true });
    const { app } = await import('./state/store.js');
    app.camera.zoom *= 1.6;
    app.camera.updateProjectionMatrix();
  });
  await page.waitForTimeout(700);

  await setSlider(page, 'celOutlineWidth', 0.71); // 0.025 Å
  const sOut = read(await H.shotCanvas(page, 'celsmear_screen'));
  await setSlider(page, 'celOutlineWidth', 0);
  const sPlain = read(await H.shotCanvas(page, 'celsmear_screen_plain'));
  await H.clickById(page, 'showForcesToggle');
  await page.waitForTimeout(500);
  const sNoArrows = read(await H.shotCanvas(page, 'celsmear_screen_noarrows'));
  await H.clickById(page, 'showForcesToggle');
  await page.waitForTimeout(500);
  const screen = partial(sOut, sPlain);
  H.check('screen space: there are lines to judge', screen.changed > 2000, JSON.stringify(screen));
  H.check('screen space: lines are solid, no grey smudges (under 2% of the changed pixels)', screen.frac < 0.02, JSON.stringify(screen));
  // Close-up of one atom with its bonds and arrow (your typical deep zoom):
  // a fade in depth units stretches over many pixels here.
  await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app } = await import('./state/store.js');
    const shift = new THREE.Vector3(5.8, 7.0, 7.0).sub(app.controls.target);
    const dir = new THREE.Vector3(); app.camera.getWorldDirection(dir);
    shift.sub(dir.clone().multiplyScalar(shift.dot(dir)));
    app.controls.target.add(shift); app.camera.position.add(shift); app.controls.update?.();
    app.camera.zoom *= 6; app.camera.updateProjectionMatrix();
  });
  await setSlider(page, 'celOutlineWidth', 0.71); // 0.025 Å
  const zOut = read(await H.shotCanvas(page, 'celsmear_zoom'));
  await setSlider(page, 'celOutlineWidth', 0);
  const zPlain = read(await H.shotCanvas(page, 'celsmear_zoom_plain'));
  const zoomed = partial(zOut, zPlain);
  H.check('screen space, close up: still no smudges (under 2%)', zoomed.changed > 2000 && zoomed.frac < 0.02, JSON.stringify(zoomed));
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.camera.zoom /= 6; app.camera.updateProjectionMatrix();
  });
  await setSlider(page, 'celOutlineWidth', 0.71); // 0.025 Å

  const contact = arrowContactLine(sOut, sPlain, sNoArrows);
  H.check('screen space: arrows are outlined where they touch atoms and bonds (most of the ring around them is line)',
    contact.ring > 300 && contact.frac > 0.6, JSON.stringify(contact));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
