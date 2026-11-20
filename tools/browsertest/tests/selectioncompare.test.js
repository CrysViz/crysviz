// Comparing two structures in the Selection Inspector
// (ui/AnalysisPanels/SelectionInspector.js + render/StructureMatchModule.js):
// with a second structure ticked in the Files list and Comparison on, each
// bond length and angle of the selection also shows its value in that
// structure — when the two are the same structure closely enough — with a
// legend whose names and colours are editable, and the view exports through
// the main image dialog (PNG and SVG, legend included).
//
// The matcher is checked on its own first (in the page, pure data): a copy
// that is shuffled, shifted to another origin and 1.2 % larger must match by
// nearest atom, and its lengths must come out exactly 1.012× with the angles
// unchanged; a different composition, a cell too far off and an atom moved
// too far must not match.
'use strict';
const H = require('../harness');

async function compareState(page) {
  return page.evaluate(async () => {
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    return getSelectionInspectorState()?.compare ?? null;
  });
}

/** POSCAR text of the active structure, transformed. */
async function variantPoscar(page, { name, scale = 1, shift = [0, 0, 0], shuffle = false, dropLast = false, moveFirst = 0 }) {
  return page.evaluate((o) => {
    return import('./state/store.js').then(({ fileBrowser }) => {
      const s = fileBrowser.selectedStructure;
      const L = s.lattice.map((r) => r.map((v) => v * o.scale));
      let atoms = s.atoms.map((a, i) => ({ e: s.elements[i], f: a.position.map((v, k) => v + o.shift[k]) }));
      if (o.moveFirst) {
        // Move atom 0 along a by moveFirst Å.
        const len = Math.hypot(...L[0]);
        atoms[0].f[0] += o.moveFirst / len;
      }
      if (o.dropLast) atoms = atoms.slice(0, -1);
      if (o.shuffle) {
        // Reverse within each element, and list the elements in reverse order.
        const order = [...new Set(atoms.map((a) => a.e))].reverse();
        atoms = order.flatMap((e) => atoms.filter((a) => a.e === e).reverse());
      }
      const runs = [];
      atoms.forEach((a) => { if (!runs.length || runs[runs.length - 1][0] !== a.e) runs.push([a.e, 0]); runs[runs.length - 1][1]++; });
      return [o.name, '1.0', ...L.map((r) => r.map((v) => v.toFixed(10)).join(' ')),
        runs.map((r) => r[0]).join(' '), runs.map((r) => r[1]).join(' '), 'Direct',
        ...atoms.map((a) => a.f.map((v) => (((v % 1) + 1) % 1).toFixed(10)).join(' ')), ''].join('\n');
    });
  }, { name, scale, shift, shuffle, dropLast, moveFirst });
}

async function loadText(page, text, fileName) {
  await page.evaluate(async ({ text, fileName }) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, fileName);
  }, { text, fileName });
  await page.waitForTimeout(800);
}

/** Select the row named `inspect`, and tick `compare` (a name, a list of
 *  names, or nothing) in the Files list — with real change events, and with
 *  the Comparison window's mode left off: the inspector's Compare needs only
 *  the tick. */
async function setComparison(page, inspect, compare) {
  await page.evaluate(async ({ inspect, compare }) => {
    const rows = [...document.querySelectorAll('#objectTable tbody tr')];
    const name = (r) => r.querySelector('.name-inner')?.textContent;
    const fb = await import('./ui/FileBrowswerPanel.js');
    const { general, fileBrowser } = await import('./state/store.js');
    const target = rows.findIndex((r) => name(r) === inspect);
    if (fileBrowser.selectedRow !== rows[target]) {
      fb.selectStructure(target, 0);
      await new Promise((r) => setTimeout(r, 800));
    }
    general.compareModeOn = false;
    const want = new Set([compare ?? []].flat());
    for (const r of rows) {
      const box = r.querySelector('input[type="checkbox"]');
      if (box && box.checked !== want.has(name(r))) {
        box.checked = want.has(name(r));
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }, { inspect, compare });
  await page.waitForTimeout(1200);
}

/** The inspector's Compare button, and pressing it to the wanted state. */
async function compareButton(page) {
  return page.evaluate(async () => (await import('./ui/AnalysisPanels/SelectionInspector.js')).getSelectionInspectorState()?.compareButton);
}
async function setCompare(page, on) {
  const b = await compareButton(page);
  if (b && !b.disabled && b.pressed !== on) {
    await page.click('#siCompareBtn');
    await page.waitForTimeout(600);
  }
}

/** Press Save in the image dialog with the download stubbed; returns the
 *  file name, type, pixel size (PNG), colour counts (PNG) or text (SVG). */
async function saveAndRead(page, { countColor = null } = {}) {
  return page.evaluate(async (countColor) => {
    const orig = HTMLAnchorElement.prototype.click;
    let name = null, href = null;
    HTMLAnchorElement.prototype.click = function stub() { name = this.download; href = this.href; };
    try {
      document.getElementById('pngSaveBtn').click();
      for (let i = 0; i < 600 && !name; i++) await new Promise((r) => setTimeout(r, 100));
      if (!name) return null;
      const blob = await (await fetch(href)).blob();
      const out = { name, type: blob.type, modalClosed: document.getElementById('pngExportModal').hidden };
      if (blob.type === 'image/png') {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let colored = 0, opaque = 0, match = 0;
        const [r0, g0, b0] = countColor ? [1, 3, 5].map((k) => parseInt(countColor.slice(k, k + 2), 16)) : [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 0) opaque++;
          if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 40) colored++;
          if (countColor && Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) < 60 && d[i + 3] > 200) match++;
        }
        const corner = [...d.slice(0, 4)]; // the top-left pixel: the background
        Object.assign(out, { width: c.width, height: c.height, opaque, colored, match, pixels: c.width * c.height, corner });
      } else {
        out.text = await blob.text();
      }
      return out;
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  }, countColor);
}

const close = (a, b, eps) => Math.abs(a - b) <= eps;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  // An export failure surfaces as an alert() from the dialog.
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.dismiss().catch(() => {}); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // ---- The matcher on its own --------------------------------------------
  const shifted = await variantPoscar(page, { name: 'YBCO shifted', scale: 1.012, shift: [0.13, 0.27, 0.41], shuffle: true });
  const unit = await page.evaluate(async (shiftedText) => {
    const { matchStructures } = await import('./render/StructureMatchModule.js');
    const { fileBrowser } = await import('./state/store.js');
    const A = fileBrowser.selectedStructure;
    // Parse the POSCAR text minimally (this test wrote it).
    const parse = (t) => {
      const l = t.split('\n');
      const lattice = [2, 3, 4].map((i) => l[i].trim().split(/\s+/).map(Number));
      const els = l[5].trim().split(/\s+/), counts = l[6].trim().split(/\s+/).map(Number);
      const elements = els.flatMap((e, i) => Array(counts[i]).fill(e));
      const atoms = elements.map((_, i) => ({ position: l[8 + i].trim().split(/\s+/).map(Number) }));
      return { lattice, elements, atoms };
    };
    const B = parse(shiftedText);
    const m = matchStructures(A, B);
    const copy = (fn) => { const s = parse(shiftedText); fn(s); return s; };
    const fewer = copy((s) => { s.atoms.pop(); s.elements.pop(); });
    const bigger = copy((s) => { s.lattice = s.lattice.map((r) => r.map((v) => v * 1.3)); });
    // In file order, one atom moved 1.5 Å along a: the others overlay
    // exactly, so the report names that atom and its full displacement.
    const lenA = Math.hypot(...A.lattice[0]);
    const moved = {
      lattice: A.lattice, elements: A.elements,
      atoms: A.atoms.map((a, i) => ({ position: i === 2 ? [a.position[0] + 1.5 / lenA, a.position[1], a.position[2]] : a.position })),
    };
    // Shuffled, with one atom pushed onto another's spot: no one-to-one map.
    const clash = copy((s) => { s.atoms[0].position = s.atoms[0].position.map((v) => v + 0.25); });
    return {
      ok: m.ok, method: m.method, max: m.max, tol: m.tol, movedName: `${A.elements[2]}3`,
      fewer: matchStructures(A, fewer), bigger: matchStructures(A, bigger), moved: matchStructures(A, moved),
      clash: matchStructures(A, clash),
    };
  }, shifted);
  H.check('a shuffled, shifted, 1.2 % larger copy matches by nearest atom with no displacement',
    unit.ok && unit.method === 'nearest atom' && unit.max < 1e-6 && unit.tol > 0.3 && unit.tol <= 1,
    JSON.stringify({ ok: unit.ok, method: unit.method, max: unit.max, tol: unit.tol }));
  H.check('a different composition does not match, and says why',
    !unit.fewer.ok && /composition/.test(unit.fewer.reason), unit.fewer.reason);
  H.check('a cell 30 % larger does not match, and says why',
    !unit.bigger.ok && /cells differ/.test(unit.bigger.reason), unit.bigger.reason);
  H.check('an atom moved far does not match, and the reason names it with its whole displacement',
    !unit.moved.ok && unit.moved.reason.startsWith(`atoms moved too far (${unit.movedName} by 1.50 Å`), unit.moved.reason);
  H.check('no one-to-one atom map does not match, and says so',
    !unit.clash.ok && /no one-to-one atom match|atoms moved too far/.test(unit.clash.reason), unit.clash.reason);

  // ---- In the inspector ---------------------------------------------------
  // One atom moved 1.6 Å along a: generated while YBCO is still the active one.
  const moved = await variantPoscar(page, { name: 'YBCO moved', moveFirst: 1.6 });
  await loadText(page, shifted, 'YBCO-shifted.vasp');
  await loadText(page, moved, 'YBCO-moved.vasp');
  await setComparison(page, 'YBCO', null);

  // A Cu and the O atoms bonded to it.
  const pick = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { getBondCutoff, getBondMinCutoff } = await import('./render/BondsFracUpdateModule.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const d = (i, j) => Math.hypot(...[0, 1, 2].map((k) => w.cart[i][k] - w.cart[j][k]));
    const bonded = (i, j) => d(i, j) <= getBondCutoff(w.elements[i], w.elements[j]) && d(i, j) >= getBondMinCutoff(w.elements[i], w.elements[j]) && d(i, j) > 0.1;
    let best = null;
    for (let c = 0; c < w.cart.length; c++) {
      if (w.elements[c] !== 'Cu') continue;
      const os = w.cart.map((_, i) => i).filter((i) => w.elements[i] === 'O' && bonded(c, i));
      if (!best || os.length > best.os.length) best = { c, os };
    }
    return best;
  });
  H.check('found a Cu with bonded O', pick?.os.length >= 3, JSON.stringify(pick));
  await page.evaluate(async ({ c, os }) => {
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    selectAtomsByInstances([c, ...os]);
    (await import('./ui/AnalysisPanels/SelectionInspector.js')).openSelectionInspector();
  }, pick);
  await page.waitForTimeout(1500);

  let cmp = await compareState(page);
  const legendHidden = await page.evaluate(() => document.getElementById('siLegend').hidden);
  let btn = await compareButton(page);
  H.check('without a ticked structure: Compare greyed out, saying what to do; no comparison, no legend',
    cmp === null && legendHidden && btn.disabled && !btn.pressed && /Tick another structure in the Files list/.test(btn.note),
    JSON.stringify({ cmp, legendHidden, btn }));

  await setComparison(page, 'YBCO', 'YBCO-shifted.vasp');
  btn = await compareButton(page);
  cmp = await compareState(page);
  const panelMode = await page.evaluate(async () => (await import('./state/store.js')).general.compareModeOn);
  H.check('ticking the copy (Comparison window off) makes Compare available, naming the structure; nothing compared until pressed',
    !btn.disabled && !btn.pressed && /with YBCO-shifted/.test(btn.note) && cmp === null && panelMode === false,
    JSON.stringify({ btn, cmp, panelMode }));
  await setComparison(page, 'YBCO', ['YBCO-shifted.vasp', 'YBCO-moved.vasp']);
  btn = await compareButton(page);
  H.check('two structures ticked: Compare greyed out, saying to tick only one', btn.disabled && /2 structures are ticked/.test(btn.note),
    JSON.stringify(btn));
  await setComparison(page, 'YBCO', 'YBCO-shifted.vasp');
  await setCompare(page, true);
  cmp = await compareState(page);
  H.check('ticking the copy compares with it: status says how it matched',
    cmp?.ok && cmp.legendShown && /Compared with YBCO-shifted(\.vasp)?: same structure \(atoms matched by nearest atom; RMS 0\.000 Å/.test(cmp.status)
      && /cell 1\.2 %/.test(cmp.status),
    JSON.stringify(cmp && { ok: cmp.ok, status: cmp.status, legend: cmp.legendShown }));
  H.check('every length shows the copy\'s value: exactly 1.012× (isotropic scale)',
    cmp.lengths.length >= 3 && cmp.lengths.every(([l, l2]) => close(l2, l * 1.012, 1e-6)),
    JSON.stringify(cmp.lengths));
  H.check('every angle shows the copy\'s value: unchanged',
    cmp.angles.length >= 3 && cmp.angles.every(([a, a2]) => close(a, a2, 1e-6)),
    JSON.stringify(cmp.angles));
  H.check('the legend names the two structures', cmp.names[0] === 'YBCO' && /^YBCO-shifted/.test(cmp.names[1]),
    JSON.stringify(cmp.names));
  const legendLook = await page.evaluate(() => {
    const pill = document.querySelector('#siLegend .si-legend-pill');
    const names = [...(pill?.querySelectorAll('.si-legend-name') ?? [])];
    const compareSwatch = document.querySelector('#siColors [data-color-key="valueB"]');
    return { pill: !!pill, names: names.length, keys: document.querySelectorAll('#siLegend .si-legend-key').length,
      compareSwatch: !!compareSwatch && !compareSwatch.hidden };
  });
  H.check('the legend is a label: one pill with the two names; the Colours row offers "Compared" while comparing',
    legendLook.pill && legendLook.names === 2 && legendLook.keys === 0 && legendLook.compareSwatch, JSON.stringify(legendLook));

  // Legend: rename; recolour from the Colours row (the app's own colour
  // picker — ui/SwatchColorPicker.js); the legend follows the label colours.
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('siLegendNameA', 'Experiment');
    set('siLegendNameB', 'DFT');
  });
  const pickers = [];
  for (const [selector, hex] of [['[data-color-key="valueB"]', '#ff00ff'], ['[data-color-key="lengthBg"]', '#ffffff'],
    ['[data-color-key="angleBg"]', '#ffffff'], ['[data-color-key="valueA"]', '#000000'], ['[data-color-key="arc"]', '#9a9a9a'],
    ['[data-color-key="background"]', '#fdf6e3']]) {
    await page.click(selector);
    await page.waitForTimeout(150);
    pickers.push(await page.evaluate((hex) => {
      const panel = document.querySelector('.swatch-color-picker');
      const field = panel?.querySelectorAll('.cv-colorpicker-input-field')[1];
      if (!field) return false;
      field.value = hex;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Close')?.click();
      return !document.querySelector('.swatch-color-picker');
    }, hex));
  }
  H.check('the colour swatches open the app\'s colour picker', pickers.every(Boolean), JSON.stringify(pickers));
  await page.waitForTimeout(400);
  cmp = await compareState(page);
  const legendColors = await page.evaluate(() => ({
    pill: getComputedStyle(document.getElementById('siLegendPill')).backgroundColor,
    a: getComputedStyle(document.getElementById('siLegendNameA')).color,
    b: getComputedStyle(document.getElementById('siLegendNameB')).color,
  }));
  H.check('legend names are editable', cmp.names[0] === 'Experiment' && cmp.names[1] === 'DFT', JSON.stringify(cmp.names));
  H.check('every label colour can be chosen, and the legend follows: the pill in the length-label colour, each name in its value colour',
    Object.entries({ valueA: '#000000', valueB: '#ff00ff', lengthBg: '#ffffff', angleBg: '#ffffff', arc: '#9a9a9a' })
      .every(([k, v]) => String(cmp.colors[k]).toLowerCase() === v)
      && legendColors.a === 'rgb(0, 0, 0)' && legendColors.b === 'rgb(255, 0, 255)' && /255, 255, 255, 0.92/.test(legendColors.pill),
    JSON.stringify({ colors: cmp.colors, legendColors }));
  const viewBg = await page.evaluate(() => getComputedStyle(document.getElementById('siViewport')).backgroundColor);
  H.check('the Background colour shows in the inspector view itself', viewBg === 'rgb(253, 246, 227)', viewBg);
  const swatches = await page.evaluate(() => [...document.querySelectorAll('#siColors .pi-color-swatch')].map((el) => getComputedStyle(el).backgroundColor));
  H.check('the toolbar swatches show the chosen colours',
    JSON.stringify(swatches) === JSON.stringify(['rgb(0, 0, 0)', 'rgb(255, 0, 255)', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)', 'rgb(154, 154, 154)']),
    JSON.stringify(swatches));
  // Each control row lines up: everything in it shares one vertical centre.
  const rows = await page.evaluate(() => ['#siNeighbourRow', '.pi-toolbar', '#siColors', '#siLegend', '#siLegendPill'].map((sel) => {
    const row = document.querySelector(`#siViewport, .cv-panel[data-panel-id="selectionInspector"]`) && document.querySelector(sel);
    const centres = [...row.children].filter((c) => c.getBoundingClientRect().height > 0)
      .map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; });
    return { sel, spread: Math.max(...centres) - Math.min(...centres) };
  }));
  H.check('every control row is aligned (children share one vertical centre within 1.5 px)',
    rows.every((r) => r.spread <= 1.5), JSON.stringify(rows));
  // Stepping/refreshing keeps a custom name while the pair stays the same.
  await page.evaluate(() => document.dispatchEvent(new Event('crysviz:comparison-changed')));
  await page.waitForTimeout(300);
  cmp = await compareState(page);
  H.check('the edited names survive a refresh', cmp.names[0] === 'Experiment' && cmp.names[1] === 'DFT', JSON.stringify(cmp.names));

  // ---- Moving the legend ------------------------------------------------------
  // The colour bars' interface (ui/ColorBarDrag.js): the ⦀ grip, or the
  // legend's background, with a mouse or a finger; kept 4 px inside the view.
  const legendBox = () => page.evaluate(() => {
    const l = document.getElementById('siLegend').getBoundingClientRect();
    const v = document.getElementById('siViewport').getBoundingClientRect();
    return { right: v.right - l.right, bottom: v.bottom - l.bottom, left: l.left - v.left, top: l.top - v.top };
  });
  const grip = await page.evaluate(() => {
    const g = document.querySelector('#siLegend .cv-colorbar-grip');
    const r = g?.getBoundingClientRect();
    const v = document.getElementById('siViewport').getBoundingClientRect();
    return g && { text: g.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2, vr: v.right, vb: v.bottom };
  });
  H.check('the legend has the colour bars\' ⦀ grip', grip?.text === '⦀', JSON.stringify(grip));
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 200, grip.y + 200, { steps: 5 });
  await page.mouse.move(grip.vr + 50, grip.vb + 50, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const dragged = await legendBox();
  cmp = await compareState(page);
  H.check('dragging the grip moves the legend, and it stays inside the view (bottom-right corner)',
    close(dragged.right, 4, 1) && close(dragged.bottom, 4, 1) && dragged.left > 0 && dragged.top > 0
      && cmp.legendPos?.edgeX === 'right' && cmp.legendPos?.edgeY === 'bottom',
    JSON.stringify({ dragged, pos: cmp.legendPos }));
  await page.evaluate(() => document.dispatchEvent(new Event('crysviz:comparison-changed')));
  await page.waitForTimeout(300);
  const kept = await legendBox();
  H.check('it stays where it was put when the view refreshes', close(kept.right, 4, 1) && close(kept.bottom, 4, 1), JSON.stringify(kept));
  // A finger on the legend's background (pointerType touch) drags it too.
  const touched = await page.evaluate(async () => {
    const legendEl = document.getElementById('siLegend');
    const pill = legendEl.querySelector('.si-legend-pill').getBoundingClientRect();
    const x0 = pill.left + 2, y0 = pill.top + pill.height / 2; // the pill's own padding, left of the names
    const target = document.elementFromPoint(x0, y0);
    const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === 'pointerup' ? 0 : 1,
    }));
    fire(target, 'pointerdown', x0, y0);
    for (let k = 1; k <= 6; k++) fire(legendEl, 'pointermove', x0 - 30 * k, y0 - 30 * k);
    fire(legendEl, 'pointerup', x0 - 180, y0 - 180);
    await new Promise((r) => setTimeout(r, 100));
    return { on: target === legendEl || legendEl.contains(target) ? target.className : `outside: ${target?.className}` };
  });
  const afterTouch = await legendBox();
  H.check('a touch drag on the legend\'s background moves it too',
    afterTouch.right > kept.right + 100 && afterTouch.bottom > kept.bottom + 100, JSON.stringify({ touched, afterTouch, kept }));
  // A tap on a name still edits it (not a drag).
  await page.click('#siLegendNameA');
  const focused = await page.evaluate(() => document.activeElement?.id);
  H.check('a click on a legend name still edits it', focused === 'siLegendNameA', focused);
  await page.evaluate(() => document.activeElement?.blur());
  // Back to the bottom-right corner for the export check below.
  const grip2 = await page.evaluate(() => { const r = document.querySelector('#siLegend .cv-colorbar-grip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(grip2.x, grip2.y);
  await page.mouse.down();
  await page.mouse.move(grip.vr + 50, grip.vb + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  // ---- Export through the main image dialog --------------------------------
  const camBefore = await page.evaluate(async () => (await import('./ui/AnalysisPanels/SelectionInspector.js')).getSelectionInspectorState().camera);
  await H.clickById(page, 'siExport');
  await page.waitForTimeout(400);
  const dlg = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && !el.hidden && !el.closest('[hidden]'); };
    const vp = document.getElementById('siViewport').getBoundingClientRect();
    return {
      open: !document.getElementById('pngExportModal').hidden,
      region: vis('pngDownloadBtn'), structureOnly: vis('pngStructureOnly'),
      aspect: document.getElementById('pngAspect').value,
      w: +document.getElementById('pngWidth').value, h: +document.getElementById('pngHeight').value,
      viewRatio: vp.width / vp.height,
    };
  });
  H.check('Export image… opens the main image dialog, without its main-view-only options',
    dlg.open && !dlg.region && !dlg.structureOnly, JSON.stringify(dlg));
  if (dlg.aspect === 'view') {
    H.check('"Current view" is the inspector view\'s shape', close(dlg.w / dlg.h, dlg.viewRatio, 0.02), JSON.stringify(dlg));
  }
  await page.evaluate(() => {
    const f = document.getElementById('imgFormat');
    f.value = 'png'; f.dispatchEvent(new Event('change', { bubbles: true }));
    const a = document.getElementById('pngAspect');
    a.value = 'view'; a.dispatchEvent(new Event('change', { bubbles: true }));
    const w = document.getElementById('pngWidth');
    w.value = '1800'; w.dispatchEvent(new Event('input', { bubbles: true })); w.dispatchEvent(new Event('change', { bubbles: true }));
    const t = document.getElementById('pngTransparent');
    if (t.checked) t.click();
  });
  const wanted = await page.evaluate(() => ({ w: +document.getElementById('pngWidth').value, h: +document.getElementById('pngHeight').value }));
  const png = await saveAndRead(page, { countColor: '#ff00ff' });
  if (!png) console.log('alerts:', alerts);
  H.check('PNG: saved as <structure>-selection.png at the chosen size',
    png?.name === 'YBCO-selection.png' && png.type === 'image/png' && png.width === wanted.w && png.height === wanted.h && png.modalClosed,
    JSON.stringify(png && { name: png.name, w: png.width, h: png.height, wanted }));
  H.check('PNG: the structure is in it (not blank) and the compared values are in the chosen colour',
    png.opaque === png.pixels && png.colored > png.pixels * 0.01 && png.match > 200,
    JSON.stringify(png && { colored: png.colored, match: png.match, pixels: png.pixels }));
  H.check('PNG: on the view\'s own Background (the chosen cream, not the main view\'s), opaque',
    png.corner.join(',') === '253,246,227,255', JSON.stringify(png.corner));

  await H.clickById(page, 'siExport');
  await page.waitForTimeout(300);
  const svgRow = await page.evaluate(() => {
    const f = document.getElementById('imgFormat');
    f.value = 'svg'; f.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('svgStructureRow').hidden;
  });
  H.check('SVG: no "vector shapes" choice for the inspector view (embedded image only)', svgRow === true);
  const svg = await saveAndRead(page);
  const legendText = /<text [^>]*x="([\d.]+)" y="([\d.]+)"[^>]*>Experiment</.exec(svg?.text ?? '');
  const svgSize = /<svg[^>]* width="([\d.]+)" height="([\d.]+)"/.exec(svg?.text ?? '');
  H.check('SVG: the legend sits where it was dragged (bottom right)',
    legendText && svgSize && +legendText[1] > +svgSize[1] * 0.5 && +legendText[2] > +svgSize[2] * 0.8,
    JSON.stringify({ text: legendText?.slice(1), size: svgSize?.slice(1) }));
  H.check('SVG: saved as <structure>-selection.svg with the view embedded and the legend as text',
    svg?.name === 'YBCO-selection.svg' && /<image/.test(svg.text) && /layer-legend/.test(svg.text)
      && />Experiment</.test(svg.text) && />DFT</.test(svg.text),
    JSON.stringify(svg && { name: svg.name, len: svg.text.length, legend: /layer-legend/.test(svg.text) }));
  await page.evaluate(() => {
    const f = document.getElementById('imgFormat');
    f.value = 'png'; f.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await page.waitForTimeout(600);
  const after = await page.evaluate(async () => {
    const s = (await import('./ui/AnalysisPanels/SelectionInspector.js')).getSelectionInspectorState();
    return { camera: s.camera, labels: s.labels.length, visible: s.labels.filter((l) => l.visible).length };
  });
  H.check('after the export the inspector view is back as it was (same camera, labels drawn)',
    after.camera.every((v, i) => close(v, camBefore[i], 1e-9)) && after.labels > 0 && after.visible > 0,
    JSON.stringify({ after, camBefore }));

  // The main view's dialog is unchanged afterwards.
  await H.clickById(page, 'saveImageButton');
  await page.waitForTimeout(300);
  const mainDlg = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && !el.hidden && !el.closest('[hidden]'); };
    return { region: vis('pngDownloadBtn'), structureOnly: vis('pngStructureOnly') };
  });
  H.check('the main view\'s image dialog still offers its own options', mainDlg.region && mainDlg.structureOnly, JSON.stringify(mainDlg));
  await page.evaluate(() => document.getElementById('pngCancelBtn').click());

  // ---- Compare off again ---------------------------------------------------
  await setCompare(page, false);
  cmp = await compareState(page);
  const legendOff = await page.evaluate(() => document.getElementById('siLegend').hidden);
  btn = await compareButton(page);
  H.check('pressing Compare again stops comparing: single values, no legend', cmp === null && legendOff && !btn.pressed && !btn.disabled,
    JSON.stringify({ cmp, legendOff, btn }));
  await setCompare(page, true);

  // ---- Not the same structure ----------------------------------------------
  await setComparison(page, 'YBCO', 'YBCO-moved.vasp');
  cmp = await compareState(page);
  H.check('a structure with an atom moved 1.6 Å is not compared: the status says which atom, no legend, single values',
    cmp && !cmp.ok && /Not compared with YBCO-moved(\.vasp)?: atoms moved too far \(\w+\d+ by 1\.60 Å/.test(cmp.status)
      && !cmp.legendShown && cmp.lengths.every(([, l2]) => l2 == null),
    JSON.stringify(cmp && { ok: cmp.ok, status: cmp.status, legend: cmp.legendShown }));
  const names2 = cmp.names;
  H.check('a different pair starts from the file names again', /^YBCO-moved/.test(names2[1]), JSON.stringify(names2));

  await setComparison(page, 'YBCO', null);
  cmp = await compareState(page);
  const swatchAfter = await page.evaluate(() => !document.querySelector('#siColors [data-color-key="valueB"]').hidden);
  btn = await compareButton(page);
  H.check('unticking ends the comparison (and the Compared swatch goes); Compare greyed out again', cmp === null && !swatchAfter && btn.disabled);

  // ---- The selection belongs to its structure --------------------------------
  // Switching rows in the Files list: the other structure starts with its own
  // (empty) selection — the same atom numbers are other atoms there — and the
  // first gets its own back.
  const selectedIn = () => page.evaluate(async () => (await import('./ui/SelectAndHighlightModule.js')).getSelectedAtoms()
    .map((a) => `${a.element}${a.sourceIndex}`).sort().join(' '));
  const before = await selectedIn();
  const clickRow = async (rowName) => {
    const pt = await page.evaluate((rowName) => {
      const nameEl = [...document.querySelectorAll('#objectTable tbody tr')].find((x) => x.querySelector('.name-inner')?.textContent === rowName)
        .querySelector('.name-inner');
      nameEl.scrollIntoView({ block: 'center' }); // the Files list may have scrolled it under its summary
      const r = nameEl.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, rowName);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(1500);
    return page.evaluate(async () => (await import('./state/store.js')).fileBrowser.selectedRow?.querySelector('.name-inner')?.textContent);
  };
  const activeOther = await clickRow('YBCO-moved.vasp');
  const inOther = await selectedIn();
  const st2 = await page.evaluate(async () => (await import('./ui/AnalysisPanels/SelectionInspector.js')).getSelectionInspectorState());
  const activeBack = await clickRow('YBCO');
  const back = await selectedIn();
  H.check('switching structures: the other one starts without the selection (inspector empty); switching back restores it',
    activeOther === 'YBCO-moved.vasp' && activeBack === 'YBCO' && before.length > 0 && inOther === '' && st2.atoms === 0 && back === before,
    JSON.stringify({ activeOther, before, inOther, inspectorAtoms: st2.atoms, activeBack, back }));

  H.check('no alerts', alerts.length === 0, alerts.join('\n'));
  H.check('no page errors', errors.filter((e) => !/TUNNEL/.test(e)).length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
