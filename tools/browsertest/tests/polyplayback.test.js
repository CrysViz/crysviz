// Polyhedra on the MD / trajectory fast path (render/PolyhedraFrameModule.js)
// and polyhedra coloured by a per-polyhedron property, updated every frame.
//
// Playback with polyhedra on used to fall back to the full path on every
// frame (FastFrameModule bailed: "polyhedra visible") — a polyhedra search
// and a mesh rebuild per frame. Now a fast frame moves the polyhedra kept
// from the last full rebuild. Checks:
//  (a) a jittered SrTiO3 trajectory with polyhedra on takes the fast path,
//      every drawn corner follows its atom (table and GPU buffer), and the
//      full search runs on the topology stride only (every 20th frame);
//  (b) colouring by distortion index gives different colours to a regular
//      and a stretched octahedron, and follows the next frame;
//  (c) the colour bar appears with a property and goes with 'style';
//  (d) tilt about c with the automatic axes alternates in sign on a tilted
//      perovskite in a √2×√2 cell (the cell axes read ~45° instead);
//  (e) 'style' restores the category colours;
//  (f) the MD / relaxation update (positions written to the atoms, then
//      applyFrameFast) moves the polyhedra and recolours them;
//  (g) the Colour section: menu and bar use the registry's names, the
//      Matrix frame takes two rows (the third is computed), editing it fits
//      the range again, and the docked bar re-clears its tick labels from
//      the Min/Max fields when its window narrows.
'use strict';
const H = require('../harness');

const AP = 3.905;

/** Extended-XYZ trajectory of SrTiO3 n×n×n, jittered per frame. */
function trajectory(n, frames) {
  const basis = [['Sr', [0, 0, 0]], ['Ti', [0.5, 0.5, 0.5]], ['O', [0.5, 0.5, 0]], ['O', [0.5, 0, 0.5]], ['O', [0, 0.5, 0.5]]];
  const sites = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    for (const [el, f] of basis) sites.push([el, (f[0] + i) * AP, (f[1] + j) * AP, (f[2] + k) * AP]);
  }
  const L = n * AP;
  const out = [];
  for (let t = 0; t < frames; t++) {
    out.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
    sites.forEach(([el, x, y, z], s) => {
      const w = (k) => 0.05 * Math.sin(0.9 * t + 1.7 * s + 2.1 * k);
      const wrap = (v) => ((v % L) + L) % L;
      out.push(`${el} ${wrap(x + w(0)).toFixed(5)} ${wrap(y + w(1)).toFixed(5)} ${wrap(z + w(2)).toFixed(5)}`);
    });
  }
  return out.join('\n');
}

/**
 * SrTiO3 with a⁰a⁰c⁻ octahedral rotations (±phi about c, sign (−1)^(i+j+k))
 * in a 2√2×2√2×2 cell whose axes are at 45° to the pseudo-cubic ones.
 */
function tiltedPoscar(phiDeg) {
  const d = AP / 2 * Math.tan(phiDeg * Math.PI / 180);
  const A = [2 * AP, 2 * AP, 0], B = [-2 * AP, 2 * AP, 0], C = [0, 0, 2 * AP];
  // fractional = cart · inverse(L); L rows A, B, C (orthogonal here)
  const toFrac = (p) => [
    (p[0] * A[0] + p[1] * A[1]) / (A[0] * A[0] + A[1] * A[1]),
    (p[0] * B[0] + p[1] * B[1]) / (B[0] * B[0] + B[1] * B[1]),
    p[2] / C[2],
  ];
  const by = { Sr: [], Ti: [], O: [] };
  const seen = new Set();
  const add = (el, cart) => {
    const f = toFrac(cart).map((x) => { const w = ((x % 1) + 1) % 1; return w > 1 - 1e-6 ? 0 : w; });
    const key = f.map((x) => x.toFixed(4)).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    by[el].push(f);
  };
  for (let i = -4; i < 4; i++) for (let j = 0; j < 8; j++) for (let k = 0; k < 2; k++) {
    const s = (i + j + k) % 2 === 0 ? 1 : -1;
    add('Sr', [i * AP, j * AP, k * AP]);
    add('Ti', [(i + 0.5) * AP, (j + 0.5) * AP, (k + 0.5) * AP]);
    // equatorial O on +x of Ti(i,j,k) moves along +y by s·d, on +y along −x
    add('O', [(i + 1) * AP, (j + 0.5) * AP + s * d, (k + 0.5) * AP]);
    add('O', [(i + 0.5) * AP - s * d, (j + 1) * AP, (k + 0.5) * AP]);
    add('O', [(i + 0.5) * AP, (j + 0.5) * AP, (k + 1) * AP]);
  }
  return ['SrTiO3 a0a0c- sqrt2 cell', '1.0', A.join(' '), B.join(' '), C.join(' '), 'Sr Ti O',
    `${by.Sr.length} ${by.Ti.length} ${by.O.length}`, 'Direct',
    ...['Sr', 'Ti', 'O'].flatMap((el) => by[el].map((p) => p.map((x) => x.toFixed(8)).join(' ')))].join('\n');
}

async function loadText(page, text, name) {
  await page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, name);
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 400));
  }, { text, name });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // ---------------------------------------------------------------- (a)
  await loadText(page, trajectory(3, 24), 'sto_traj.xyz');
  const a = await page.evaluate(async () => {
    const { structureShip, fileBrowser, general } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const P = await import('./render/PolyhedraModule.js');
    const F = await import('./render/PolyhedraFrameModule.js');
    const { lastFastFrameBail } = await import('./render/FastFrameModule.js');
    const trace = await import('./debug/debugTrace.js');
    // showTrajectoryFrame returns nothing: which path a frame took is read
    // from the player's trace counters.
    const play = (f) => {
      const c0 = trace.counters();
      showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
      const c1 = trace.counters();
      return (c1.playbackFast || 0) > (c0.playbackFast || 0) ? 'fast' : ((c1.playbackFull || 0) > (c0.playbackFull || 0) ? 'full' : 'none');
    };
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    general.showPolyhedra = true;
    showTrajectoryFrame(0, c, { full: true });
    await settle(300);
    await P.updatePolyhedra();
    const out = { frames: [], polys: P.polyhedraDrawnCount() };
    const stats0 = F.polyhedraFastFrameStats();
    for (let f = 1; f < 23; f++) {
      const serialBefore = P.polyhedraTable()?.serial;
      const res = play(f);
      const table = P.polyhedraTable();
      const s = fileBrowser.selectedStructure;
      const L = s.lattice;
      // positions of this frame, fractional
      const ph = c.store?.getFramePhysics?.(f);
      const frac = (src) => {
        if (ph?.positions) return [ph.positions[3 * src], ph.positions[3 * src + 1], ph.positions[3 * src + 2]];
        return s.atoms[src].position;
      };
      let worst = 0, gpuWorst = 0;
      if (res === 'fast' && table?.topo) {
        const xyz = table.vertXYZ, vsrc = table.topo.vertSrc;
        for (let v = 0; v < vsrc.length; v++) {
          // corner = some periodic image of its atom: fractional distance to
          // the nearest image, converted to Å (cubic cell)
          const fr = frac(vsrc[v]);
          let d2 = 0;
          for (let k = 0; k < 3; k++) {
            const fv = xyz[3 * v + k] / L[k][k];
            const dd = fv - fr[k] - Math.round(fv - fr[k]);
            d2 += (dd * L[k][k]) ** 2;
          }
          worst = Math.max(worst, Math.sqrt(d2));
        }
        // every drawn triangle corner is one of its polyhedron's corners
        for (let i = 0; i < table.n; i++) {
          const vs = table.vertStart[i], cn = table.cn[i];
          for (let t = table.faceStart[i]; t < table.faceStart[i] + table.faceCount[i]; t++) {
            for (let k = 0; k < 3; k++) {
              const o = t * 9 + 3 * k;
              let best = Infinity;
              for (let q = 0; q < cn; q++) {
                const p = 3 * (vs + q);
                best = Math.min(best, Math.hypot(table.positions[o] - xyz[p], table.positions[o + 1] - xyz[p + 1], table.positions[o + 2] - xyz[p + 2]));
              }
              gpuWorst = Math.max(gpuWorst, best);
            }
          }
        }
      }
      out.frames.push({ f, res, bail: lastFastFrameBail(), worst, gpuWorst, rebuilt: table?.serial !== serialBefore });
      await settle(res === 'full' ? 400 : 20);
      if (res === 'full') await P.updatePolyhedra();
    }
    const stats1 = F.polyhedraFastFrameStats();
    out.polyFast = stats1.fastFrames - stats0.fastFrames;
    out.lastMs = stats1.lastMs;
    return out;
  });
  const fast = a.frames.filter((x) => x.res === 'fast');
  const full = a.frames.filter((x) => x.res === 'full').map((x) => x.f);
  console.log(`  ${a.polys} polyhedra; fast frames ${fast.length}/${a.frames.length}, full at ${full.join(',')}; polyhedra part ${a.lastMs.toFixed(2)} ms`);
  H.check('(a) playback with polyhedra on takes the fast path', fast.length >= 18 && a.polys > 0,
    JSON.stringify(a.frames.filter((x) => x.res !== 'fast')));
  H.check('(a) the polyhedra moved on every fast frame', a.polyFast === fast.length, `${a.polyFast} vs ${fast.length}`);
  H.check('(a) the full search runs on the topology stride only (frame 20)',
    full.length === 1 && full[0] === 20, JSON.stringify(full));
  const worst = Math.max(...fast.map((x) => x.worst));
  const gpuWorst = Math.max(...fast.map((x) => x.gpuWorst));
  H.check('(a) every corner sits on an image of its atom in the frame shown', worst < 1e-6, String(worst));
  H.check('(a) the drawn triangles use those corners', gpuWorst < 1e-4, String(gpuWorst));

  // ---------------------------------------------------------------- (b), (c), (e)
  const b = await page.evaluate(async () => {
    const { structureShip, fileBrowser, general } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const P = await import('./render/PolyhedraModule.js');
    const F = await import('./render/PolyhedraFrameModule.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const CC = await import('./ui/PolyhedraColorControls.js');
    const trace = await import('./debug/debugTrace.js');
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const c = structureShip.container[structureShip.container.length - 1];
    openPanel('polyhedra');
    await settle(300);
    const select = document.getElementById('polyhedraColorBy');
    const styleColors = () => P.polyhedraInfo().map((p) => p.color);
    const before = styleColors();
    const barBefore = !!CC.polyhedraColorBar();
    // stretch one octahedron: push the two apical O of the first Ti row apart
    const s = fileBrowser.selectedStructure;
    const table0 = P.polyhedraTable();
    const target = 0;
    const set = (value) => { select.value = value; select.dispatchEvent(new Event('change')); };
    set('bld');
    await settle(100);
    const barOn = !!CC.polyhedraColorBar();
    const barEl = document.querySelector('#polyhedraColorSection .cv-colorbar-wrapper, .cv-colorbar-floating');
    const values0 = Array.from(F.polyhedraPropertyValues() ?? []);
    const colors0 = styleColors();
    // next frame: move one corner atom of polyhedron `target` outwards by 0.3 Å
    const vsrc = table0.topo.vertSrc[table0.vertStart[target]];
    const ph = c.store?.getFramePhysics?.(3);
    const frame = 3;
    // edit the frame's positions so the stretch appears on the next fast frame
    let edited = false;
    if (ph?.positions) {
      const L = s.lattice;
      const ci = table0.centerIndex[target];
      const dir = [0, 1, 2].map((k) => {
        let d = ph.positions[3 * vsrc + k] - ph.positions[3 * ci + k];
        d -= Math.round(d);
        return d;
      });
      const len = Math.hypot(...dir.map((d, k) => d * L[k][k]));
      for (let k = 0; k < 3; k++) ph.positions[3 * vsrc + k] += dir[k] * 0.3 / len;
      edited = true;
    }
    const fast0 = trace.counters().playbackFast || 0;
    showTrajectoryFrame(frame, c, { full: false, playback: { forceFull: false }, recenter: false });
    const res = (trace.counters().playbackFast || 0) > fast0 ? 'fast' : 'full';
    const values1 = Array.from(F.polyhedraPropertyValues() ?? []);
    const colors1 = styleColors();
    // rows sharing the moved O: their distortion jumped
    const changed = values1.filter((v, i) => Math.abs(v - values0[i]) > 0.01).length;
    const maxRow = values1.indexOf(Math.max(...values1));
    const minRow = values1.indexOf(Math.min(...values1));
    set('style');
    await settle(100);
    const after = styleColors();
    const barOff = !CC.polyhedraColorBar();
    return {
      barBefore, barOn, barEl: !!barEl, barOff, edited, res, changed,
      spread0: Math.max(...values0) - Math.min(...values0),
      maxV: values1[maxRow], minV: values1[minRow],
      colorMax: colors1[maxRow], colorMin: colors1[minRow],
      recoloured: colors1.some((col, i) => col !== colors0[i]),
      styleDiffers: colors0.some((col, i) => col !== before[i]),
      restored: after.length === before.length && after.every((col, i) => col === before[i]),
      diff: after.map((col, i) => (col === before[i] ? null : `${i}:${before[i]}->${col}`)).filter(Boolean).slice(0, 6),
      range: [general.polyhedraColorMin, general.polyhedraColorMax],
    };
  });
  console.log(`  distortion: max ${b.maxV?.toFixed(4)} (${b.colorMax}), min ${b.minV?.toFixed(4)} (${b.colorMin}), ${b.changed} rows changed on the next frame`);
  H.check('(b) the next frame was a fast frame with the stretched octahedron', b.edited && b.res === 'fast', JSON.stringify(b));
  H.check('(b) colour by distortion: stretched and regular octahedra get different colours',
    b.maxV > 0.02 && b.minV < 0.02 && b.colorMax !== b.colorMin, JSON.stringify(b));
  H.check('(b) the colours follow the next frame', b.changed > 0 && b.recoloured, JSON.stringify(b));
  H.check('(c) the colour bar appears with a property and goes with Style',
    !b.barBefore && b.barOn && b.barEl && b.barOff, JSON.stringify(b));
  H.check('(e) Style restores the category colours', b.styleDiffers && b.restored, JSON.stringify(b));

  // ---------------------------------------------------------------- (d)
  await loadText(page, tiltedPoscar(8), 'sto_tilted.vasp');
  const d = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const P = await import('./render/PolyhedraModule.js');
    const F = await import('./render/PolyhedraFrameModule.js');
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    general.showPolyhedra = true;
    await P.updatePolyhedra();
    await settle(200);
    const table = P.polyhedraTable();
    const AP = 3.905;
    const rowsTi = [];
    for (let i = 0; i < table.n; i++) if (table.cn[i] === 6 && table.faceCount[i]) rowsTi.push(i);
    const signOf = (i) => {
      // centre → pseudo-cubic site (i,j,k): Ti at (i+½, j+½, k+½)·AP
      const c = [0, 1, 2].map((k) => Math.round(table.center[3 * i + k] / AP - 0.5));
      return (((c[0] + c[1] + c[2]) % 2) + 2) % 2 === 0 ? 1 : -1;
    };
    const run = (frame) => {
      general.polyhedraTiltFrame = frame;
      general.polyhedraColor = 'tiltC';
      general.polyhedraColorMin = null;
      general.polyhedraColorMax = null;
      P.updatePolyhedraColors();
      return Array.from(F.polyhedraPropertyValues());
    };
    const auto = run('auto');
    const info = F.polyhedraTiltFrameInfo();
    const cellRot = (() => { general.polyhedraColor = 'rotation'; general.polyhedraTiltFrame = 'cell'; P.updatePolyhedraColors(); return Array.from(F.polyhedraPropertyValues()); })();
    const colors = P.polyhedraInfo().filter((p) => p.cn === 6).map((p) => p.color);
    general.polyhedraColor = 'style';
    general.polyhedraTiltFrame = 'auto';
    P.updatePolyhedraColors();
    const s0 = signOf(rowsTi[0]) * Math.sign(auto[rowsTi[0]]);
    return {
      n: rowsTi.length,
      alternate: rowsTi.every((i) => Math.sign(auto[i]) * signOf(i) === s0),
      magnitudes: rowsTi.map((i) => Math.abs(auto[i])),
      cellRot: rowsTi.map((i) => cellRot[i]),
      info,
      atoms: fileBrowser.selectedStructure.atoms.length,
    };
  });
  const mags = d.magnitudes;
  console.log(`  tilted cell: ${d.atoms} atoms, ${d.n} octahedra, |tiltC| ${Math.min(...mags).toFixed(2)}–${Math.max(...mags).toFixed(2)}°, axes ${JSON.stringify(d.info.map((x) => x.axes))}`);
  H.check('(d) tilt about c in the automatic axes alternates in sign between neighbours',
    d.n >= 16 && d.alternate && mags.every((m) => Math.abs(m - 8) < 0.5), JSON.stringify(d));
  H.check('(d) the automatic axes are the pseudo-cubic ones (45° from a, b; along c)',
    d.info.length === 1 && d.info[0].axes.filter((x) => Math.abs(x.angle - 45) < 1).length === 2
      && d.info[0].axes.some((x) => x.axis === 'c' && x.angle < 1)
      && new Set(d.info[0].axes.map((x) => x.axis)).size === 3, JSON.stringify(d.info));
  H.check('(d) the cell axes see the 45° setting instead', d.cellRot.every((v) => v > 30), JSON.stringify(d.cellRot));

  // ---------------------------------------------------------------- (f)
  // The MD / relaxation viewer update: atom positions written directly
  // (no deferred frame column), then applyFrameFast, as atomistic/MD.js does
  // between its topology refreshes — with tilt colouring on.
  const f = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const P = await import('./render/PolyhedraModule.js');
    const F = await import('./render/PolyhedraFrameModule.js');
    const { applyFrameFast, lastFastFrameBail } = await import('./render/FastFrameModule.js');
    const s = fileBrowser.selectedStructure;
    general.polyhedraColor = 'tiltC';
    general.polyhedraColorMin = null;
    general.polyhedraColorMax = null;
    P.updatePolyhedraColors();
    const before = Array.from(F.polyhedraPropertyValues());
    const n0 = F.polyhedraFastFrameStats().fastFrames;
    const pos0 = s.atoms.map((a) => [...a.position]);
    const out = { applied: 0, worst: 0 };
    for (let step = 1; step <= 3; step++) {
      s.atoms.forEach((a, i) => {
        a.position = pos0[i].map((x, k) => { const v = x + 0.002 * step * Math.sin(1.3 * i + 2.1 * k); return ((v % 1) + 1) % 1; });
      });
      if (applyFrameFast(s)) out.applied++;
      else out.bail = lastFastFrameBail();
    }
    const table = P.polyhedraTable();
    const L = s.lattice;
    const inv = (() => { // L rows orthogonal in this cell: frac_k = (x·L_k)/|L_k|²
      return (x, k) => (x[0] * L[k][0] + x[1] * L[k][1] + x[2] * L[k][2]) / (L[k][0] ** 2 + L[k][1] ** 2 + L[k][2] ** 2);
    })();
    for (let v = 0; v < table.topo.vertSrc.length; v++) {
      const p = [table.vertXYZ[3 * v], table.vertXYZ[3 * v + 1], table.vertXYZ[3 * v + 2]];
      const fr = s.atoms[table.topo.vertSrc[v]].position;
      let d2 = 0;
      const dfrac = [0, 1, 2].map((k) => { const d = inv(p, k) - fr[k]; return d - Math.round(d); });
      for (let c = 0; c < 3; c++) {
        const x = dfrac[0] * L[0][c] + dfrac[1] * L[1][c] + dfrac[2] * L[2][c];
        d2 += x * x;
      }
      out.worst = Math.max(out.worst, Math.sqrt(d2));
    }
    const after = Array.from(F.polyhedraPropertyValues());
    out.moved = F.polyhedraFastFrameStats().fastFrames - n0;
    out.valuesChanged = after.some((v, i) => Number.isFinite(v) && Math.abs(v - before[i]) > 1e-3);
    general.polyhedraColor = 'style';
    P.updatePolyhedraColors();
    return out;
  });
  H.check('(f) MD-style updates (positions written to the atoms) move the polyhedra and their tilt colours',
    f.applied === 3 && f.moved === 3 && f.worst < 1e-6 && f.valuesChanged, JSON.stringify(f));

  // ---------------------------------------------------------------- (g)
  const g = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const { getPolyhedraProperty } = await import('./model/polyhedraProperties.js');
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    openPanel('polyhedra');
    for (let i = 0; i < 25 && !document.getElementById('polyhedraColorBy'); i++) await settle(200);
    const sel = document.getElementById('polyhedraColorBy');
    const set = (el, value) => { el.value = value; el.dispatchEvent(new Event('change')); };
    const out = {};
    out.menuMatches = [...sel.options].filter((o) => o.value !== 'style')
      .every((o) => o.textContent === getPolyhedraProperty(o.value)?.label && o.title === getPolyhedraProperty(o.value)?.description);
    set(sel, 'rotation');
    await settle(200);
    out.legend = document.querySelector('#polyhedraColorSection .cv-colorbar-legend')?.textContent?.trim();
    set(sel, 'tiltC');
    set(document.getElementById('polyhedraTiltFrame'), 'matrix');
    await settle(200);
    out.inputs = document.querySelectorAll('#polyhedraTiltMatrix input').length;
    out.axis3 = document.getElementById('polyhedraTiltMatrixAxis3')?.textContent;
    // A typed range, then a matrix edit: the range is fitted again.
    general.polyhedraColorMin = -100;
    general.polyhedraColorMax = 100;
    const m00 = document.getElementById('polyhedraTiltMatrix_0_0');
    set(m00, '0.5');
    await settle(200);
    out.refit = [general.polyhedraColorMin, general.polyhedraColorMax];
    // Parallel rows: a note says so.
    set(document.getElementById('polyhedraTiltMatrix_0_1'), '1');
    set(document.getElementById('polyhedraTiltMatrix_0_0'), '0');
    await settle(100);
    out.parallelNote = document.querySelector('.cv-polyhedra-matrix-note')?.textContent;
    set(document.getElementById('polyhedraTiltMatrix_0_1'), '0');
    set(document.getElementById('polyhedraTiltMatrix_0_0'), '1');
    set(document.getElementById('polyhedraTiltFrame'), 'auto');
    await settle(200);
    // Narrow the docked window: no tick label under the Min/Max fields.
    const panel = document.querySelector('.cv-panel[data-panel-id="polyhedra"]');
    const overlaps = () => {
      const boxes = [...document.querySelectorAll('#polyhedraColorSection .cv-colorbar-value-input')].map((e) => e.getBoundingClientRect());
      return [...document.querySelectorAll('#polyhedraColorSection .cv-colorbar-tick-label')].map((e) => e.getBoundingClientRect())
        .filter((t) => boxes.some((b) => t.left < b.right && b.left < t.right && t.top < b.bottom && b.top < t.bottom)).length;
    };
    out.widths = [];
    for (const w of [300, 260, 420]) {
      panel.style.width = `${w}px`;
      await settle(300);
      out.widths.push({ w, ticks: document.querySelectorAll('#polyhedraColorSection .cv-colorbar-tick-label').length, overlaps: overlaps() });
    }
    panel.style.width = '';
    set(sel, 'style');
    return out;
  });
  H.check('(g) the Colour by menu uses the registry labels and descriptions', g.menuMatches, JSON.stringify(g));
  H.check('(g) the bar title is the registry label', g.legend === 'Total rotation (°)', String(g.legend));
  H.check('(g) Matrix: two rows typed, axis 3 shown as computed', g.inputs === 6 && /axis 1 × axis 2/.test(g.axis3 ?? ''), JSON.stringify(g));
  H.check('(g) editing the matrix fits the colour range again', Number.isFinite(g.refit[0]) && g.refit[1] < 100, JSON.stringify(g.refit));
  H.check('(g) parallel rows are reported', /parallel/.test(g.parallelNote ?? ''), String(g.parallelNote));
  H.check('(g) a narrowed docked bar keeps its tick labels clear of Min/Max',
    g.widths.every((x) => x.overlaps === 0) && g.widths.some((x) => x.ticks > 0), JSON.stringify(g.widths));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
