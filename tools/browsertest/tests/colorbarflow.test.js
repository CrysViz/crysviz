// Force and spin colour bars end to end, with small values (a relaxed
// structure's forces, weak induced moments):
// - the bar starts at the Auto Range when the structure loads (forces under
//   0.05 eV/Å used to open at 0 .. 2);
// - Min/Max and tick labels are readable: no 0.000x, no duplicates, nothing
//   overlapping (ticks used to read "0, 0.01, 0.01" and "0.00040.0006");
// - Log Scale with a min of 0 starts below the data (was a fixed 0.01);
// - force arrow length is |F| × Global Scaling and Auto Range leaves it
//   alone (it used to be mapped onto the colour range); spins likewise;
// - spin ranges cover only the moments drawn (≥ 0.05 μB);
// - Global Scaling reaches ×100 (log slider);
// - image export prints the same Min/Max and ticks as the floating bar on
//   screen (it printed every computed tick, some under the Min/Max text);
// - editing the legend on a light scene with dark chrome is legible (dark
//   text on the dark field before).
'use strict';
const H = require('../harness');

const FORCES = [
  '5', 'Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3:forces:R:3',
  'Na 1 1 1   0.0001 0 0',
  'Cl 4 1 1   0 0.002 0',
  'Na 1 4 1   0 0 0.0084',
  'Cl 4 4 1   0.003 0 0',
  'Na 1 1 4   0 0 0',
].join('\n');

const SPINS = [
  'data_m', '_space_group_magn.name_BNS  "P1"',
  '_cell_length_a 8', '_cell_length_b 8', '_cell_length_c 8',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
  'loop_', '_space_group_symop_magn_operation.id', '_space_group_symop_magn_operation.xyz', '1 x,y,z,+1',
  'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Fe1 Fe 0.1 0.1 0.1', 'Fe2 Fe 0.5 0.1 0.1', 'Fe3 Fe 0.1 0.5 0.1', 'Fe4 Fe 0.5 0.5 0.1', 'Fe5 Fe 0.5 0.5 0.5',
  'loop_', '_atom_site_moment.label', '_atom_site_moment.crystalaxis_x', '_atom_site_moment.crystalaxis_y', '_atom_site_moment.crystalaxis_z',
  // Fe5's 0.0003 μB is under the 0.05 μB draw threshold: no arrow, and it must not stretch the bar.
  'Fe1 0 0 0.06', 'Fe2 0 0 0.2', 'Fe3 0 0 0.9', 'Fe4 0 0 4', 'Fe5 0 0 0.0003', '',
].join('\n');

const KINDS = [
  {
    kind: 'force', file: 'small.xyz', text: FORCES, show: 'showForcesToggle', panel: 'forces', floatId: 'forceColorBarFloating',
    map: 'forceColorMapSelect', log: 'forceLogScaleCheckbox', minKey: 'forceMin', maxKey: 'forceMax',
    shaft: 'forcesShaftMesh', mags: [0.0001, 0.002, 0.0084, 0.003],
    linear: { min: 0, max: 0.011, minText: '0', maxText: '0.011' },
    logSwitch: { min: 0.00005, minText: '5e-5' },
    logAuto: { min: 0.00005, max: 0.02, minText: '5e-5', maxText: '0.02' },
  },
  {
    kind: 'spin', file: 'small.mcif', text: SPINS, show: 'showSpinsToggle', panel: 'spins', floatId: 'spinColorBarFloating',
    map: 'spinColorMapSelect', log: 'spinLogScaleCheckbox', minKey: 'spinMin', maxKey: 'spinMax',
    shaft: 'spinShaftMesh', mags: [0.06, 0.2, 0.9, 4],
    linear: { min: 0, max: 4.8, minText: '0', maxText: '4.8' },
    logSwitch: { min: 0.02, minText: '0.02' },
    logAuto: { min: 0.02, max: 10, minText: '0.02', maxText: '10' },
  },
];

/** The bar as drawn: values, field texts, tick labels, and any overlap
 *  between labels and fields (on screen rects). */
const readBar = (page, k, sel) => page.evaluate(async ({ k, sel }) => {
  const { general } = await import('./state/store.js');
  const root = document.querySelector(sel);
  const fields = [...root.querySelectorAll('.cv-colorbar-value-input')];
  const labels = [...root.querySelectorAll('.cv-colorbar-tick-label')];
  const rects = [...fields, ...labels].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]; const b = rects[j];
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps++;
    }
  }
  const clipped = fields.filter((f) => f.scrollWidth > f.clientWidth + 1).length;
  return {
    min: general[k.minKey], max: general[k.maxKey],
    minText: fields[0]?.value, maxText: fields[1]?.value,
    ticks: labels.map((l) => l.textContent.trim()), overlaps, clipped,
  };
}, { k, sel });

const readable = (bar) => bar.ticks.length > 0 && new Set(bar.ticks).size === bar.ticks.length
  && bar.ticks.every((t) => !/0\.000/.test(t)) && !/0\.000/.test(bar.minText) && !/0\.000/.test(bar.maxText)
  && bar.overlaps === 0 && bar.clipped === 0;

/** Half lengths of the arrows' shaft instances (one per arrow, first half). */
const shaftLengths = (page, key) => page.evaluate(async (key) => {
  const THREE = await import('./external/three/three.module.js');
  const { groups } = await import('./state/store.js');
  const mesh = groups[key];
  if (!mesh) return null;
  const m = new THREE.Matrix4(); const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
  const out = [];
  for (let i = 0; i < mesh.count; i += 2) { mesh.getMatrixAt(i, m); m.decompose(p, q, s); out.push(s.y); }
  return out;
}, key);

const pressAutoRange = (page, panel) => page.evaluate(async (panel) => {
  const body = document.getElementById(`cvPanelBody-${panel}`);
  [...body.querySelectorAll('.cv-auto-range-btn')].find((b) => b.textContent.trim() === 'Auto Range').click();
  await new Promise((r) => setTimeout(r, 400));
}, panel);

const setLog = async (page, id, on) => {
  await page.evaluate(({ id, on }) => { const b = document.getElementById(id); if (b.checked !== on) b.click(); }, { id, on });
  await page.waitForTimeout(400);
};

/** Export the floating bars with a painter that records what it draws,
 *  keeping this kind's bar (its export group). */
const exportTexts = (page, id) => page.evaluate(async (id) => {
  const { drawFloatingColorBars } = await import('./render/ImageExportModule.js');
  const view = document.getElementById('view').getBoundingClientRect();
  const texts = [];
  let group = null;
  let bar = null;
  const painter = {
    gradientRect: (x, y, w, h) => { if (group === `layer-colorbar-${id}`) bar = { x, y, w, h }; },
    measureText: (t, { fontPx }) => ({ width: t.length * fontPx * 0.6, inkAscent: fontPx * 0.7, inkDescent: fontPx * 0.2 }),
    text: (t, x, y, o) => { if (group === `layer-colorbar-${id}`) texts.push({ t, x, y, align: o.align }); },
    richText: () => {},
    beginGroup: (_name, gid) => { group = gid; },
    endGroup: () => { group = null; },
  };
  // The crop is the whole view, at 2x.
  drawFloatingColorBars(painter, view.width * 2, view.height * 2, { x0: 0, y0: 0, x1: 1, y1: 1 }, view);
  return { texts, bar };
}, id);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }
  await page.evaluate(async () => (await import('./ui/ThemeManager.js')).applyTheme('default', 'light'));
  await page.waitForTimeout(500);

  for (const k of KINDS) {
    const K = k.kind;
    await page.evaluate(async ({ text, file }) => (await import('./core/crystal-viewer.js')).loadStructure(text, file), k);
    await page.waitForTimeout(1200);
    await page.evaluate((id) => { const t = document.getElementById(id); if (!t.checked) t.click(); }, k.show);
    await page.waitForTimeout(600);
    await page.evaluate(async (p) => (await import('./ui/panels/PanelManager.js')).openPanel(p), k.panel);
    await page.waitForTimeout(600);
    await setLog(page, k.log, false);
    await H.setSelect(page, k.map, 'viridis');
    await page.waitForTimeout(500);
    const docked = `#cvPanelBody-${k.panel} .cv-colorbar-wrapper`;

    // 1. First range = Auto Range.
    const first = await readBar(page, k, docked);
    H.check(`${K}: the bar starts at the Auto Range (${k.linear.min} .. ${k.linear.max})`,
      first.min === k.linear.min && first.max === k.linear.max && first.minText === k.linear.minText
      && first.maxText === k.linear.maxText, JSON.stringify(first));
    H.check(`${K}: linear ticks readable (round, distinct, no 0.000x, nothing overlapping or cut off)`,
      readable(first), JSON.stringify(first));

    // 2. Lengths don't follow the range.
    const len0 = await shaftLengths(page, k.shaft);
    await setLog(page, k.log, true);
    const toLog = await readBar(page, k, docked);
    H.check(`${K}: Log Scale on with min 0 starts below the data (${k.logSwitch.minText}, was 0.01)`,
      toLog.min === k.logSwitch.min && toLog.minText === k.logSwitch.minText && readable(toLog), JSON.stringify(toLog));
    await pressAutoRange(page, k.panel);
    const logAuto = await readBar(page, k, docked);
    H.check(`${K}: log Auto Range ${k.logAuto.minText} .. ${k.logAuto.maxText}, readable ticks`,
      logAuto.min === k.logAuto.min && logAuto.max === k.logAuto.max && logAuto.minText === k.logAuto.minText
      && logAuto.maxText === k.logAuto.maxText && readable(logAuto), JSON.stringify(logAuto));
    const len1 = await shaftLengths(page, k.shaft);
    H.check(`${K}: Log Scale and Auto Range leave the arrow lengths alone`,
      len0?.length > 0 && len0.length === len1?.length && len0.every((l, i) => Math.abs(l - len1[i]) < 1e-9),
      JSON.stringify({ len0, len1 }));

    // 3. Floating bar: same checks on screen, and the export prints the same text.
    await page.evaluate(async (id) => {
      const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
      listActiveColorBars().find((b) => b.id === id).instance.floatAtAnchor({ edgeX: 'left', offsetX: 300, edgeY: 'top', offsetY: 260 });
    }, k.kind);
    await page.waitForTimeout(700);
    const floating = await readBar(page, k, `#${k.floatId}`);
    H.check(`${K}: floating bar readable`, readable(floating), JSON.stringify(floating));
    const ex = await exportTexts(page, k.kind);
    const want = [floating.minText, floating.maxText, ...floating.ticks].sort();
    const got = (ex.texts || []).map((t) => t.t).sort();
    H.check(`${K}: export prints the bar's own Min/Max and ticks`, JSON.stringify(got) === JSON.stringify(want),
      JSON.stringify({ got, want }));
    const minT = ex.texts?.find((t) => t.t === floating.minText);
    const maxT = ex.texts?.find((t) => t.t === floating.maxText);
    H.check(`${K}: export centres Min/Max on the bar ends, like the fields on screen`,
      !!ex.bar && minT?.align === 'center' && Math.abs(minT.x - ex.bar.x) < 0.5
      && maxT?.align === 'center' && Math.abs(maxT.x - (ex.bar.x + ex.bar.w)) < 0.5, JSON.stringify({ minT, maxT, bar: ex.bar }));

    // 4. Legend editing on the light scene (Default light: dark chrome).
    const legend = await page.evaluate(async (fid) => {
      const el = document.querySelector(`#${fid} .cv-colorbar-legend`);
      el.click();
      await new Promise((r) => setTimeout(r, 200));
      const cs = getComputedStyle(el);
      const out = { editing: el.classList.contains('cv-colorbar-legend-editing'), color: cs.color, bg: cs.backgroundColor };
      el.blur();
      return out;
    }, k.floatId);
    const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [l1, l2] = [lum(rgb(legend.color)), lum(rgb(legend.bg))].sort((a, b) => b - a);
    const contrast = (l1 + 0.05) / (l2 + 0.05);
    H.check(`${K}: legend being edited is legible on the light scene (contrast ≥ 4.5)`,
      legend.editing && contrast >= 4.5, JSON.stringify({ ...legend, contrast: +contrast.toFixed(2) }));

    // Move it out of the way of the next kind's bar.
    await page.evaluate(async (id) => {
      const { listActiveColorBars } = await import('./ui/ColorBarRegistry.js');
      listActiveColorBars().find((b) => b.id === id)?.instance.floatAtAnchor({ edgeX: 'left', offsetX: 300, edgeY: 'top', offsetY: 40 });
    }, k.kind);
    await page.evaluate(async (p) => (await import('./ui/panels/PanelManager.js')).closePanel(p), k.panel);
    await page.waitForTimeout(300);

    // 5. Length proportional to the value.
    if (K === 'force') {
      await page.evaluate(async (p) => (await import('./ui/panels/PanelManager.js')).openPanel(p), k.panel);
      await page.waitForTimeout(500);
      await H.setSlider(page, 'forceScaleSlider', 2); // log10(100)
      await page.waitForTimeout(500);
      const scale = await page.evaluate(async () => (await import('./state/store.js')).general.forceScale);
      const lens = await shaftLengths(page, k.shaft);
      // Shaft half length per arrow is |F| × scale / 2, in force order (the zero force has no arrow).
      const want2 = k.mags.map((m) => (m * 100) / 2);
      H.check('force: Global Scaling reaches ×100 and arrow length is |F| × scale',
        scale === 100 && lens?.length === want2.length && lens.every((l, i) => Math.abs(l - want2[i]) < 1e-6),
        JSON.stringify({ scale, lens, want: want2 }));
      await page.evaluate(async (p) => (await import('./ui/panels/PanelManager.js')).closePanel(p), k.panel);
    } else {
      const lens = await shaftLengths(page, k.shaft);
      H.check('spin: arrow lengths are proportional to the moments',
        lens?.length === k.mags.length && lens.every((l, i) => Math.abs(l / lens[3] - k.mags[i] / k.mags[3]) < 1e-6),
        JSON.stringify(lens));
    }
  }

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
