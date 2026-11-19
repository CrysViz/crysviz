// Cel shading, screen-space outlines (CelOutlinePass.js) and force and spin
// arrows:
// the outlines are painted over the finished frame from a depth pass of the
// outlined meshes only, so an atom's silhouette BEHIND an arrow used to be
// drawn across the arrow. Arrows now render into an occluder depth target
// (CEL_OCCLUDER_LAYER) and a line is dropped wherever an arrow is the visible
// surface.
//
// Geometry-independent pixel check: the arrows' visible pixels are where the
// frame changes when the arrows are hidden (outlines off); with "Outline
// arrows" off almost none of them may be outline-black in the outlined frame,
// with it on (the default) the arrows carry a line of their own. In 3D-hull
// mode the arrows get NO outline at all: no hull shell (thin, unevenly
// scaled and running through atoms, theirs showed hairline or missing lines,
// spikes and shells poking through atoms) and no line either (lines around
// them clash with the atoms' and bonds' rings).
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');
const fs = require('fs');

const XYZ = [
  '4', 'Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3:forces:R:3',
  'Na 1.0 1.0 1.0   3.0 3.0 -2.0',
  'Cl 3.5 3.5 -0.5   0.0 0.0 0.0',
  'Na 3.0 1.0 3.0   -2.5 2.5 2.5',
  'Cl 1.5 3.0 4.5   0.0 0.0 0.0',
].join('\n');

// Mn3Ir with the triangular T1 order, tiled n x n x n: spin arrows of 2.6 muB
// lying in the (111) planes, crossing the neighbouring atoms.
function mn3irMcif(n) {
  const a = 3.785;
  const base = [['Ir', [0, 0, 0], null], ['Mn', [0, 0.5, 0.5], [-2, 1, 1]], ['Mn', [0.5, 0, 0.5], [1, -2, 1]], ['Mn', [0.5, 0.5, 0], [1, 1, -2]]];
  const sites = [];
  const moments = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    base.forEach(([el, f, v], b) => {
      const label = `${el}${b}_${i}${j}${k}`;
      sites.push(`${label} ${el} ${((f[0] + i) / n).toFixed(5)} ${((f[1] + j) / n).toFixed(5)} ${((f[2] + k) / n).toFixed(5)}`);
      if (v) {
        const len = Math.hypot(...v);
        moments.push(`${label} ${v.map((c) => (c / len * 2.6).toFixed(4)).join(' ')}`);
      }
    });
  }
  return ['data_Mn3Ir', '_space_group_magn.name_BNS  "P1"',
    `_cell_length_a ${n * a}`, `_cell_length_b ${n * a}`, `_cell_length_c ${n * a}`,
    '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
    'loop_', '_space_group_symop_magn_operation.id', '_space_group_symop_magn_operation.xyz', '1 x,y,z,+1',
    'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
    ...sites,
    'loop_', '_atom_site_moment.label', '_atom_site_moment.crystalaxis_x', '_atom_site_moment.crystalaxis_y', '_atom_site_moment.crystalaxis_z',
    ...moments, ''].join('\n');
}

const read = (file) => PNG.sync.read(fs.readFileSync(file));
const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

async function setOutlineWidth(page, v) {
  await page.evaluate((v) => {
    const el = document.getElementById('celOutlineWidth');
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  await page.waitForTimeout(700);
}

/** Visible arrow pixels (where hiding the arrows changes the outline-free
 *  frame, shrunk by a pixel) and how many of them the outlined frame paints
 *  outline-black. */
function blackOnArrows(outlined, plain, noArrows) {
  const { width: w, height: h } = plain;
  const arrow = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const diff = Math.abs(plain.data[i] - noArrows.data[i]) + Math.abs(plain.data[i + 1] - noArrows.data[i + 1])
        + Math.abs(plain.data[i + 2] - noArrows.data[i + 2]);
      arrow[y * w + x] = diff > 60 ? 1 : 0;
    }
  }
  let arrowPx = 0;
  let black = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (!(arrow[k] && arrow[k - 1] && arrow[k + 1] && arrow[k - w] && arrow[k + w])) continue;
      arrowPx++;
      if (lum(outlined.data, k * 4) < 60) black++;
    }
  }
  return { arrowPx, black, frac: arrowPx ? black / arrowPx : 1 };
}

/** The 2-pixel ring just outside the visible arrows (any surface, the
 *  background included) and how much of it the outlined frame paints black:
 *  in 3D-hull mode the arrows' line lies there, outside them, like a hull. */
function blackAroundArrows(outlined, plain, noArrows) {
  const { width: w, height: h } = plain;
  const arrow = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const i = k * 4;
    arrow[k] = Math.abs(plain.data[i] - noArrows.data[i]) + Math.abs(plain.data[i + 1] - noArrows.data[i + 1])
      + Math.abs(plain.data[i + 2] - noArrows.data[i + 2]) > 60 ? 1 : 0;
  }
  let ring = 0;
  let black = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const k = y * w + x;
      if (arrow[k]) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (arrow[k + dy * w + dx]) { near = true; break; }
      if (!near) continue;
      ring++;
      if (lum(outlined.data, k * 4) < 60) black++;
    }
  }
  return { ring, black, frac: ring ? black / ring : 0 };
}

async function setToggle(page, id, on) {
  await page.evaluate(({ id, on }) => {
    const t = document.getElementById(id);
    if (t.checked !== on) t.click();
  }, { id, on });
  await page.waitForTimeout(900);
}

async function setForces(page, on) {
  await page.evaluate((on) => {
    const t = document.getElementById('showForcesToggle');
    if (t.checked !== on) t.click();
  }, on);
  await page.waitForTimeout(900);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }

  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'forces.xyz'), XYZ);
  await page.waitForTimeout(1500);
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(400);
  await H.setSelect(page, 'renderStyleMenu', 'cel');
  await page.waitForTimeout(800);
  await H.setSelect(page, 'celOutlineModeMenu', 'screen');
  await page.waitForTimeout(600);
  // The Visual window stays open (in the sidebar): it holds the outline width slider.
  await setForces(page, true);
  await page.evaluate(async () => {
    (await import('./ui/panels/PanelManager.js')).openPanel('forces');
    await new Promise((r) => setTimeout(r, 400));
    const el = document.getElementById('forceScaleSlider');
    el.value = String(Math.log10(0.6)); // log slider: x0.6 gives ~2.8 A arrows for these ~4.7 eV/A forces
    el.dispatchEvent(new Event('input', { bubbles: true }));
    (await import('./ui/panels/PanelManager.js')).closePanel('forces');
    // A view where the arrows cross the atoms' silhouettes.
    (await import('./ui/WindowAndSceneControls.js')).setViewDirection([0.35, 1, 0.25], { refit: true });
  });
  await page.waitForTimeout(900);

  const forceLayers = () => page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const { CEL_OCCLUDER_LAYER, CEL_OUTLINE_LAYER } = await import('./render/CelOutlinePass.js');
    const m = (o) => o?.layers?.mask ?? 0;
    const meshes = [groups.forcesShaftMesh, groups.forcesTipMesh];
    return {
      occluders: typeof CEL_OCCLUDER_LAYER === 'number' && CEL_OCCLUDER_LAYER !== CEL_OUTLINE_LAYER
        && meshes.every((o) => o && (m(o) & (1 << CEL_OCCLUDER_LAYER))),
      outlined: meshes.every((o) => o && (m(o) & (1 << CEL_OUTLINE_LAYER))),
    };
  });
  const byDefault = await forceLayers();
  H.check('by default the force arrows are outlined and hide the lines behind them',
    byDefault.occluders && byDefault.outlined, JSON.stringify(byDefault));
  await setToggle(page, 'celOutlineArrowsToggle', false);
  const switchedOff = await forceLayers();
  H.check('"Outline arrows" off: no outline of their own, still hiding the lines behind them',
    switchedOff.occluders && !switchedOff.outlined, JSON.stringify(switchedOff));

  await setOutlineWidth(page, 1);
  const outlined = read(await H.shotCanvas(page, 'celarrows_outlined'));
  // The arrows' own line at the default width (slider 0.5 = 0.025 Å; at the
  // maximum, 0.1 Å, thin arrows turn mostly black, which is what the switch is for).
  await setToggle(page, 'celOutlineArrowsToggle', true);
  await setOutlineWidth(page, 0.5);
  const outlinedOwn = read(await H.shotCanvas(page, 'celarrows_outlined_own'));
  await setOutlineWidth(page, 0);
  const plain = read(await H.shotCanvas(page, 'celarrows_plain'));
  await setForces(page, false);
  const noArrows = read(await H.shotCanvas(page, 'celarrows_noarrows'));

  const forces = blackOnArrows(outlined, plain, noArrows);
  H.check('forces: the arrows are on screen (enough visible arrow pixels to judge)', forces.arrowPx > 500, JSON.stringify(forces));
  H.check('forces, "Outline arrows" off: no outline is painted over a visible arrow', forces.frac < 0.01, JSON.stringify(forces));
  const own = blackOnArrows(outlinedOwn, plain, noArrows);
  H.check('forces, "Outline arrows" on (default width): the arrows carry their own line, their colour still shows',
    own.frac > 0.03 && own.frac < 0.5, JSON.stringify(own));

  // --- spins: Mn3Ir T1, a 2x2x2 cell, bonds off so the arrows cross atoms ---------
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'Mn3Ir_T1.mcif'), mn3irMcif(2));
  await page.waitForTimeout(1500);
  await setToggle(page, 'showBonds', false);
  await setToggle(page, 'showSpinsToggle', true);
  await page.evaluate(async () => {
    (await import('./ui/panels/PanelManager.js')).openPanel('spins');
    await new Promise((r) => setTimeout(r, 400));
    const len = document.getElementById('spinLengthSlider');
    len.value = '0.8';
    len.dispatchEvent(new Event('input', { bubbles: true }));
    (await import('./ui/WindowAndSceneControls.js')).setViewDirection([1, 0.8, 1.45], { refit: true });
  });
  await page.waitForTimeout(900);
  const spinLayers = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const { CEL_OCCLUDER_LAYER } = await import('./render/CelOutlinePass.js');
    const meshes = [groups.spinShaftMesh, groups.spinTipMesh];
    return { found: meshes.every(Boolean), occluders: meshes.every((o) => o && (o.layers.mask & (1 << CEL_OCCLUDER_LAYER))) };
  });
  H.check('spin arrows hide the outlines behind them', spinLayers.found && spinLayers.occluders, JSON.stringify(spinLayers));
  await setToggle(page, 'celOutlineArrowsToggle', false);
  await setOutlineWidth(page, 1);
  const sOutlined = read(await H.shotCanvas(page, 'celspins_outlined'));
  await setOutlineWidth(page, 0);
  const sPlain = read(await H.shotCanvas(page, 'celspins_plain'));
  await setToggle(page, 'showSpinsToggle', false);
  const sNoArrows = read(await H.shotCanvas(page, 'celspins_noarrows'));
  const spins = blackOnArrows(sOutlined, sPlain, sNoArrows);
  H.check('spins: the arrows are on screen (enough visible arrow pixels to judge)', spins.arrowPx > 500, JSON.stringify(spins));
  H.check('spins, "Outline arrows" off: no outline is painted over a visible arrow', spins.frac < 0.01, JSON.stringify(spins));

  // --- 3D hull mode: no outline on the arrows at all ---------------------------
  const setHullWidth = (v) => page.evaluate((v) => {
    const el = document.getElementById('celHullWidth');
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v).then(() => page.waitForTimeout(700));
  await setToggle(page, 'showSpinsToggle', true);
  await setToggle(page, 'celOutlineArrowsToggle', true);
  await H.setSelect(page, 'celOutlineModeMenu', 'hull');
  await page.waitForTimeout(800);
  const hulls = () => page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    return [groups.spinShaftMesh, groups.spinTipMesh].map((m) => !!m?.userData?.celOutline);
  });
  H.check('3D hull: the arrows get no hull shell', (await hulls()).every((v) => !v), JSON.stringify(await hulls()));
  H.check('3D hull: the "Outline arrows" switch is a screen-space control (hidden here)',
    await page.evaluate(() => document.getElementById('celOutlineArrowsToggle').closest('[hidden]') !== null
      || getComputedStyle(document.getElementById('celOutlineArrowsToggle')).display === 'none'));
  await setHullWidth(0.025);
  const hOwn = read(await H.shotCanvas(page, 'celspins_hull_own'));
  await setHullWidth(0);
  const hPlain = read(await H.shotCanvas(page, 'celspins_hull_plain'));
  await setToggle(page, 'showSpinsToggle', false);
  const hNoArrows = read(await H.shotCanvas(page, 'celspins_hull_noarrows'));
  await setToggle(page, 'showSpinsToggle', true);
  await setHullWidth(0.025);
  const hullRing = blackAroundArrows(hOwn, hPlain, hNoArrows);
  const hullOnArrow = blackOnArrows(hOwn, hPlain, hNoArrows);
  // Only the atoms' rings touch the 2-pixel ring around the arrows (a dense
  // scene: a sixth of it or so); with a line of their own it was over 40%.
  H.check('3D hull: no line of the arrows\' own around them (only the atoms\' rings touch them)',
    hullRing.ring > 500 && hullRing.frac < 0.3, JSON.stringify(hullRing));
  H.check('3D hull: nothing is painted over the arrows except the rings of atoms in front of them (under 10% of their pixels)',
    hullOnArrow.frac < 0.10, JSON.stringify(hullOnArrow));
  await H.setSelect(page, 'renderStyleMenu', 'metallic');
  await page.waitForTimeout(800);
  await H.setSelect(page, 'renderStyleMenu', 'cel');
  await page.waitForTimeout(800);
  H.check('and after leaving and re-entering cel shading still no arrow hulls', (await hulls()).every((v) => !v));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
