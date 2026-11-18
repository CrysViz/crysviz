// Cel shading, 3D-hull outlines, with force arrows: the arrows are not part
// of the atoms' and bonds' outlines and get none of their own in this mode.
//
// An inverted hull is the mesh's back faces pushed out by the hull width,
// so the black ring around a sphere bulges BEHIND its silhouette. An arrow
// that emerges from the atom tilted away from the viewer sat just behind
// that ring, and the ring was drawn across the arrow as a thin black arc
// (and across a cone's base as a notch). Every hull fragment now writes the
// depth of the mesh's silhouette, so the ring is flat, and a shell skips the
// pixels where a visible arrow is in front of that depth (MaterialStyles.js):
// an arrow behind the silhouette gets the whole ring across it, like a
// contour, one in front keeps all its pixels. Lines of the arrows' own
// (drawn by the screen-space pass in an earlier round) ended in knobs on
// whatever was in front of the arrow and clashed with the rings; there are
// none now.
//
// Pixel checks against outline-free frames: the ring crosses an arrow
// behind its atom whole, at the contour, and never one in front; nothing of
// the arrows' lands on the bond crossing in front of a shaft; the arrows
// carry no line of their own.
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');
const fs = require('fs');

// Viewed from +z (x to the right, y up). Atom 1's arrow tilts 45° away
// from the viewer at its cone end: the cone emerges from the sphere just
// behind its silhouette, where the hull ring bulges. Atom 2's tilts towards
// the viewer. Atom 3's arrow stands in the view plane; the C–C bond above it
// crosses the shaft 1.6 Å in front. Atom 4's long arrow runs 1.5 Å behind
// the lone atom 5, whose ring must stay over it.
const ATOMS = {
  tiltAway: [2.8, 8.0, 6.0], tiltToward: [4.8, 8.0, 6.0], shaft: [6.9, 5.2, 6.0],
  bondA: [6.2, 6.1, 7.6], bondB: [7.6, 6.1, 7.6], behind: [9.0, 8.6, 4.0], front: [9.0, 7.2, 5.5],
};
const XYZ = [
  '7', 'Lattice="12 0 0 0 12 0 0 0 12" Properties=species:S:1:pos:R:3:forces:R:3',
  `C ${ATOMS.tiltAway.join(' ')}    0.0 -1.0 -1.0`,
  `C ${ATOMS.tiltToward.join(' ')}  0.0 -1.0  1.0`,
  `C ${ATOMS.shaft.join(' ')}       0.0  2.6  0.0`,
  `C ${ATOMS.bondA.join(' ')}       0.0  0.0  0.0`,
  `C ${ATOMS.bondB.join(' ')}       0.0  0.0  0.0`,
  `C ${ATOMS.behind.join(' ')}      0.0 -4.8  0.0`,
  `C ${ATOMS.front.join(' ')}       0.0  0.0  0.0`,
].join('\n');

const read = (file) => PNG.sync.read(fs.readFileSync(file));
const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Pixels where two outline-free frames differ (something shown in `a` only). */
function diffMask(a, b, erode = 0) {
  const { width: w, height: h } = a;
  let m = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const i = k * 4;
    m[k] = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 60 ? 1 : 0;
  }
  for (let e = 0; e < erode; e++) {
    const n = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      n[k] = m[k] && m[k - 1] && m[k + 1] && m[k - w] && m[k + w] ? 1 : 0;
    }
    m = n;
  }
  return m;
}

/** How many of the mask's pixels the frame paints outline-black. */
function blackIn(frame, mask) {
  let px = 0;
  let black = 0;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    px++;
    if (lum(frame.data, k * 4) < 60) black++;
  }
  return { px, black, frac: px ? black / px : 0 };
}

/** The 2-pixel ring just outside the arrows and how much of it is black. */
function ringAround(frame, arrow, w, h) {
  let ring = 0;
  let black = 0;
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const k = y * w + x;
    if (arrow[k]) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (arrow[k + dy * w + dx]) { near = true; break; }
    if (!near) continue;
    ring++;
    if (lum(frame.data, k * 4) < 60) black++;
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

async function setToggle(page, id, on) {
  await page.evaluate(({ id, on }) => {
    const t = document.getElementById(id);
    if (t.checked !== on) t.click();
  }, { id, on });
  await page.waitForTimeout(800);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'hull.xyz'), XYZ);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const t = document.getElementById('showLattice'); if (t && t.checked) t.click(); });
  await page.evaluate(async () => { const { general } = await import('./state/store.js'); general.forceColorMap = 'none'; });
  await H.clickById(page, 'showForcesToggle');
  await page.waitForTimeout(500);
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(400);
  await H.setSelect(page, 'renderStyleMenu', 'cel');
  await page.waitForTimeout(700);
  await H.setSelect(page, 'celOutlineModeMenu', 'hull');
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    (await import('./ui/WindowAndSceneControls.js')).setViewDirection([0, 0, 1], { refit: true });
    const { app } = await import('./state/store.js');
    app.camera.zoom *= 1.6;
    app.camera.updateProjectionMatrix();
  });
  await page.waitForTimeout(700);

  // Frames: hull outlines on, none; and without the arrows / the bonds for
  // the masks.
  await setSlider(page, 'celHullWidth', 0.05);
  const hull = read(await H.shotCanvas(page, 'celhull_on'));
  await setSlider(page, 'celHullWidth', 0);
  const plain = read(await H.shotCanvas(page, 'celhull_plain'));
  await H.clickById(page, 'showForcesToggle');
  await page.waitForTimeout(500);
  const noArrows = read(await H.shotCanvas(page, 'celhull_noarrows'));
  await setToggle(page, 'showBonds', false);
  const noBonds = read(await H.shotCanvas(page, 'celhull_nobonds'));
  await setToggle(page, 'showBonds', true);
  await H.clickById(page, 'showForcesToggle');
  await page.waitForTimeout(500);
  const { width: w, height: h } = plain;

  const arrows = diffMask(plain, noArrows);
  // Screen boxes (screenshot pixels) around the atoms of interest.
  const geom = await page.evaluate(async ({ atoms, clip }) => {
    const THREE = await import('./external/three/three.module.js');
    const { app } = await import('./state/store.js');
    const r = document.getElementById('view').getBoundingClientRect();
    const px = (v) => { const q = new THREE.Vector3(...v).project(app.camera); return [(q.x + 1) / 2 * r.width + r.left - clip.x, (1 - q.y) / 2 * r.height + r.top - clip.y]; };
    const out = {};
    for (const [k, v] of Object.entries(atoms)) out[k] = px(v);
    out.bondMid = px([(atoms.bondA[0] + atoms.bondB[0]) / 2, atoms.bondA[1], atoms.bondA[2]]);
    const a = px([0, 0, 0]); const b = px([0, 1, 0]);
    out.pxPerA = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return out;
  }, { atoms: ATOMS, clip: H.CANVAS_CLIP });
  const box = (c, rA) => { const r = rA * geom.pxPerA; return { x0: c[0] - r, x1: c[0] + r, y0: c[1] - r, y1: c[1] + r }; };
  const inBox = (mask, b) => { const m = new Uint8Array(mask.length); for (let y = Math.max(0, Math.floor(b.y0)); y < Math.min(h, b.y1); y++) for (let x = Math.max(0, Math.floor(b.x0)); x < Math.min(w, b.x1); x++) m[y * w + x] = mask[y * w + x]; return m; };
  // Down atom 1's column from its centre: its pixels, then the cone (behind
  // the silhouette's depth, tilted away): the ring must cross the cone whole,
  // right at the contour — one black run of the hull width starting at the
  // first cone pixel — and nothing else until the cone's own tip line.
  const ringW = Math.round(0.05 * geom.pxPerA);
  /** Black runs down a column from the first arrow pixel below (x, y). */
  const runsBelow = (c, span) => {
    const col = Math.round(c[0]);
    let y0 = Math.round(c[1]);
    while (y0 < h && !arrows[y0 * w + col]) y0++;
    const runs = [];
    for (let yy = y0, run = null; yy < y0 + span; yy++) {
      const black = lum(hull.data, (yy * w + col) * 4) < 60;
      if (black && !run) runs.push(run = { at: yy - y0, len: 1 });
      else if (black) run.len++;
      else run = null;
    }
    return { y0, col, runs };
  };
  const away = runsBelow(geom.tiltAway, 40);
  H.check('there is a cone to judge', away.y0 < h - 60 && away.y0 > geom.tiltAway[1] + 10, JSON.stringify({ away, geom }));
  H.check('3D hull: the ring crosses an arrow emerging behind its atom whole, at the contour (was a thin arc away from it, with a sliver of arrow between)',
    away.runs.length === 1 && away.runs[0].at <= 1 && away.runs[0].len >= ringW - 1 && away.runs[0].len <= ringW + 2, JSON.stringify({ away, ringW }));
  // Atom 2's cone comes towards the viewer: in front of its atom, it gets
  // no ring (the arrow line goes round it, over the atom).
  const toward = runsBelow(geom.tiltToward, 40);
  H.check('3D hull: no ring over an arrow in front of its atom', toward.runs.length === 0, JSON.stringify(toward));
  const ring = ringAround(hull, arrows, w, h);
  // Only the atoms' rings touch the 2-pixel ring around the arrows.
  H.check('3D hull: the arrows carry no line of their own', ring.ring > 500 && ring.frac < 0.25, JSON.stringify(ring));

  // The bond in front of atom 3's shaft stays clean (its own hull ring lies
  // outside its silhouette).
  const bonds = inBox(diffMask(noArrows, noBonds, 1), box(geom.bondMid, 1.2));
  const onBond = blackIn(hull, bonds);
  H.check('3D hull: nothing lands on a bond crossing in front of a shaft (no knobs)', onBond.px > 300 && onBond.black <= 2, JSON.stringify(onBond));

  // Atom 5's ring over atom 4's arrow 1.5 Å behind it: walking down atom
  // 5's column, the first arrow pixels below its silhouette are under the
  // ring (hull width 0.05 Å) and must be black; further down the arrow shows.
  const col = Math.round(geom.front[0]);
  let y = Math.round(geom.front[1]);
  while (y < h && !arrows[y * w + col]) y++;
  let ringBlack = 0;
  for (let yy = y; yy < y + ringW; yy++) if (lum(hull.data, (yy * w + col) * 4) < 60) ringBlack++;
  let belowArrow = 0;
  for (let yy = y + ringW + 3; yy < y + ringW + 8; yy++) if (arrows[yy * w + col] && lum(hull.data, (yy * w + col) * 4) >= 60) belowArrow++;
  H.check('3D hull: the ring stays over an arrow that is well behind the atom',
    ringW >= 3 && ringBlack >= ringW - 1 && belowArrow >= 3, JSON.stringify({ ringW, ringBlack, belowArrow, y, col }));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
