// Standalone, reusable canvas time-series plot component.
//
// Renders trajectory data (live MD runs, relaxations, loaded OUTCAR/extxyz
// trajectories) into a caller-supplied host element and hands back a small
// imperative API. It does NOT register a panel.
//
// Layout: a proper dual-axis chart. Up to two quantity "groups" are shown at
// once, each with its own y-axis, nice tick labels and colour:
//   - temperature group (blue)  -> left axis by default
//   - energy group      (orange)
//   - force group       (green)
// The first present group takes the left axis, the second the right axis, so
// MD (temperature + energy) and OUTCAR (energy + mean force) both read cleanly
// without one quantity being flattened onto another's scale. Potential/kinetic
// energy are reported in the stats line but not drawn (they would swamp the
// total-energy scale).

// Series metadata: colour, dash pattern, autoscale group, legend label and
// whether the series is drawn (`plot`). Series not listed fall back to a
// generic style on their own scale.
const SERIES_SPEC = {
  temperatureK:       { color: '#53c7ff', dash: [],     group: 'temperature', label: 'Temperature (K)', plot: true },
  targetTemperatureK: { color: '#95efff', dash: [6, 4], group: 'temperature', label: 'Target T (K)',    plot: true },
  etotEv:             { color: '#ffb347', dash: [],     group: 'energy',      label: 'Total Energy (eV)', plot: true },
  epotEv:             { color: '#ffb347', dash: [3, 3], group: 'energy',      label: 'Potential Energy (eV)', plot: false },
  ekinEv:             { color: '#ffb347', dash: [2, 5], group: 'energy',      label: 'Kinetic Energy (eV)',   plot: false },
  meanForce:          { color: '#7CFC9B', dash: [],     group: 'force',       label: 'Mean |Force| (eV/Å)',   plot: true },
  pressure:           { color: '#c39bff', dash: [],     group: 'pressure',    label: 'Pressure (tr σ)',       plot: true },
};

// Per-group axis presentation. Titles are short symbols (units live in the
// legend) so up to three axis labels fit without colliding.
const GROUP_META = {
  temperature: { color: '#53c7ff', title: 'T' },
  energy:      { color: '#ffb347', title: 'E' },
  force:       { color: '#7CFC9B', title: '|F|' },
  pressure:    { color: '#c39bff', title: 'P' },
};

const PAD_L = 54;   // room for left-axis tick labels
const PAD_R = 58;   // room for right-axis tick labels
const PAD_T = 16;   // room for the axis titles
const PAD_B = 26;   // room for x (frame) tick labels
const CSS_H = 210;  // canvas height in CSS pixels

function fmt(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

// "Nice number" rounding for axis ticks (Heckbert).
function niceNum(range, round) {
  if (!(range > 0)) return 1;
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nf;
  if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

// Build a padded, tick-aligned scale for [min, max]. Handles the flat case
// (a near-constant series still gets a readable, centred axis).
function niceScale(min, max, maxTicks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (max - min < 1e-9) {
    const c = (min + max) / 2 || 0;
    const pad = Math.abs(c) * 0.01 || 0.5;
    min = c - pad; max = c + pad;
  }
  const range = niceNum(max - min, false);
  const step = niceNum(range / Math.max(1, maxTicks - 1), true);
  const nmin = Math.floor(min / step) * step;
  const nmax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = nmin; v <= nmax + step * 0.5; v += step) ticks.push(v);
  return { min: nmin, max: nmax, step, ticks };
}

// Decimal places for a tick label given the step size.
function tickDecimals(step) {
  if (!(step > 0)) return 2;
  if (step >= 10) return 0;
  if (step >= 1) return 1;
  if (step >= 0.1) return 2;
  if (step >= 0.01) return 3;
  return 4;
}

/**
 * Create a standalone trajectory time-series plot.
 *
 * @param {HTMLElement} hostEl
 * @param {object} [options]
 * @param {number} [options.maxPts=5000] - ring-buffer cap per streamed series.
 * @returns {{update, setSeries, clear, setCursor, onSeek, getEl, remove}}
 */
export function createTrajectoryPlot(hostEl, options = {}) {
  const maxPts = Number.isFinite(options.maxPts) ? options.maxPts : 5000;

  // --- DOM scaffolding ----------------------------------------------------
  const root = document.createElement('div');
  root.className = 'trajPlot';

  const canvas = document.createElement('canvas');
  canvas.className = 'trajPlotCanvas';
  // Width/height are driven by CSS (.trajPlot is resizable; the canvas flexes to
  // fill it). draw() reads the resulting clientWidth/clientHeight each frame.
  canvas.style.display = 'block';
  canvas.style.border = '1px solid #3a3a3a';
  canvas.style.borderRadius = '6px';
  canvas.style.background = '#0d0d0d';
  root.appendChild(canvas);

  const legend = document.createElement('div');
  legend.className = 'trajPlotLegend';
  root.appendChild(legend);

  const statsEl = document.createElement('div');
  statsEl.className = 'trajPlotStats';
  root.appendChild(statsEl);

  hostEl.appendChild(root);

  const ctx = canvas.getContext('2d');

  // --- series storage -----------------------------------------------------
  /** @type {Map<string, number[]>} */
  const series = new Map();
  const seriesOrder = [];

  function ensureSeries(name) {
    if (!series.has(name)) { series.set(name, []); seriesOrder.push(name); }
    return series.get(name);
  }
  function specFor(name) {
    return SERIES_SPEC[name] || { color: '#cccccc', dash: [], group: name, label: name, plot: true };
  }

  function rebuildLegend() {
    legend.innerHTML = '';
    for (const name of seriesOrder) {
      const arr = series.get(name);
      if (!arr || !arr.some(Number.isFinite)) continue;
      const spec = specFor(name);
      if (spec.plot === false) continue;
      const span = document.createElement('span');
      span.className = 'trajPlotLegendItem';
      const swatch = document.createElement('span');
      swatch.className = 'trajPlotSwatch';
      swatch.style.background = spec.color;
      if (spec.dash.length) swatch.style.opacity = '0.85';
      span.appendChild(swatch);
      span.appendChild(document.createTextNode(spec.label));
      legend.appendChild(span);
    }
  }

  // --- cursor + seek ------------------------------------------------------
  let cursorIndex = null;
  let seekCb = null;

  function seriesLength() {
    let n = 0;
    for (const arr of series.values()) n = Math.max(n, arr.length);
    return n;
  }

  // Which groups currently have plottable data, in a stable priority order.
  function presentGroups() {
    const order = ['temperature', 'energy', 'force', 'pressure'];
    const present = [];
    for (const g of order) {
      let has = false;
      for (const name of seriesOrder) {
        const spec = specFor(name);
        if (spec.group !== g || spec.plot === false) continue;
        const arr = series.get(name);
        if (arr && arr.some(Number.isFinite)) { has = true; break; }
      }
      if (has) present.push(g);
    }
    return present;
  }

  function groupMinMax(group) {
    let mn = Infinity; let mx = -Infinity;
    for (const name of seriesOrder) {
      const spec = specFor(name);
      if (spec.group !== group || spec.plot === false) continue;
      const arr = series.get(name);
      if (!arr) continue;
      for (const v of arr) if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    return { mn, mx };
  }

  // --- geometry helpers (CSS-px coordinate space) -------------------------
  let plotL = PAD_L; let plotR = 0; let plotT = PAD_T; let plotB = 0;

  function mapX(i, n) {
    if (n <= 1) return plotL;
    return plotL + (i / (n - 1)) * (plotR - plotL);
  }
  function invMapX(px, n) {
    if (n <= 1) return 0;
    const frac = (px - plotL) / Math.max(1, plotR - plotL);
    return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
  }
  function mapY(v, scale) {
    const den = Math.max(1e-12, scale.max - scale.min);
    return plotB - ((v - scale.min) / den) * (plotB - plotT);
  }

  function drawSeriesLine(name, scale, n) {
    const arr = series.get(name);
    if (!arr || !arr.some(Number.isFinite)) return;
    const spec = specFor(name);
    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = spec.color;
    if (spec.dash.length) ctx.setLineDash(spec.dash);
    let started = false;
    for (let i = 0; i < n; i += 1) {
      const v = arr[i];
      if (!Number.isFinite(v)) { started = false; continue; }
      const x = mapX(i, n);
      const y = mapY(v, scale);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
    if (spec.dash.length) ctx.setLineDash([]);
  }

  function draw() {
    // Size the backing store to the element's rendered size (the .trajPlot box
    // is user-resizable) and the device pixel ratio.
    const cssW = Math.max(260, Math.floor(canvas.clientWidth || 340));
    const cssH = Math.max(150, Math.floor(canvas.clientHeight || CSS_H));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW; const H = cssH;
    plotL = PAD_L; plotR = W - PAD_R; plotT = PAD_T; plotB = H - PAD_B;

    ctx.clearRect(0, 0, W, H);

    const n = seriesLength();
    const groups = presentGroups();
    // Up to three y-axes: one on the left, up to two stacked on the right. The
    // second right axis (e.g. pressure alongside temperature + energy) reserves
    // extra right margin so its tick labels don't collide with the first.
    const axes = groups.slice(0, 3);
    const RIGHT2_GAP = 46;
    const need2ndRight = axes.length >= 3;
    plotR = W - PAD_R - (need2ndRight ? RIGHT2_GAP : 0);

    const leftG = axes[0] || null;
    const right1G = axes[1] || null;
    const right2G = axes[2] || null;

    const scales = {};
    for (const g of groups) {
      const { mn, mx } = groupMinMax(g);
      scales[g] = niceScale(mn, mx, 5);
    }

    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';

    // --- left axis: horizontal gridlines + tick labels ---
    if (leftG) {
      const sc = scales[leftG];
      const col = GROUP_META[leftG].color;
      ctx.textAlign = 'right';
      for (const t of sc.ticks) {
        if (t < sc.min - 1e-9 || t > sc.max + 1e-9) continue;
        const y = mapY(t, sc);
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plotL, y);
        ctx.lineTo(plotR, y);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.fillText(t.toFixed(tickDecimals(sc.step)), plotL - 6, y);
      }
    }

    // --- right axis/axes: tick labels only (no gridlines), in the group colour ---
    function drawRightAxis(group, axisX, labelX) {
      if (!group) return;
      const sc = scales[group];
      const col = GROUP_META[group].color;
      ctx.textAlign = 'left';
      for (const t of sc.ticks) {
        if (t < sc.min - 1e-9 || t > sc.max + 1e-9) continue;
        const y = mapY(t, sc);
        ctx.fillStyle = col;
        ctx.fillText(t.toFixed(tickDecimals(sc.step)), labelX, y);
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(axisX, y);
        ctx.lineTo(axisX + 3, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    drawRightAxis(right1G, plotR, plotR + 6);
    drawRightAxis(right2G, plotR + RIGHT2_GAP, plotR + RIGHT2_GAP + 6);
    if (right2G) {
      // Faint vertical anchor for the outer axis so its labels don't float.
      ctx.strokeStyle = GROUP_META[right2G].color;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.moveTo(plotR + RIGHT2_GAP, plotT);
      ctx.lineTo(plotR + RIGHT2_GAP, plotB);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // --- x (frame) ticks ---
    if (n >= 2) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#888';
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      const xTicks = Math.min(6, n);
      for (let k = 0; k < xTicks; k += 1) {
        const i = Math.round((k / (xTicks - 1)) * (n - 1));
        const x = mapX(i, n);
        ctx.beginPath();
        ctx.moveTo(x, plotT);
        ctx.lineTo(x, plotB);
        ctx.stroke();
        ctx.fillText(String(i + 1), x, plotB + 12);
      }
    }

    // --- plot border ---
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(plotL, plotT, plotR - plotL, plotB - plotT);

    // --- axis titles ---
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    if (leftG) {
      ctx.fillStyle = GROUP_META[leftG].color;
      ctx.fillText(GROUP_META[leftG].title, plotL - 2, plotT - 5);
    }
    if (right1G) {
      ctx.fillStyle = GROUP_META[right1G].color;
      ctx.fillText(GROUP_META[right1G].title, plotR + 6, plotT - 5);
    }
    if (right2G) {
      ctx.fillStyle = GROUP_META[right2G].color;
      ctx.fillText(GROUP_META[right2G].title, plotR + RIGHT2_GAP + 6, plotT - 5);
    }
    ctx.textBaseline = 'middle';

    if (n < 2) return;

    // --- clip to plot area, draw series ---
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, plotT, plotR - plotL, plotB - plotT);
    ctx.clip();
    for (const g of axes) {
      const sc = scales[g];
      for (const name of seriesOrder) {
        const spec = specFor(name);
        if (spec.group !== g || spec.plot === false) continue;
        drawSeriesLine(name, sc, n);
      }
    }
    // cursor line
    if (Number.isFinite(cursorIndex)) {
      const idx = Math.max(0, Math.min(n - 1, cursorIndex));
      const x = mapX(idx, n);
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, plotT);
      ctx.lineTo(x, plotB);
      ctx.stroke();
    }
    ctx.restore();

    // cursor frame label (outside clip, above the line)
    if (Number.isFinite(cursorIndex)) {
      const idx = Math.max(0, Math.min(n - 1, cursorIndex));
      const x = mapX(idx, n);
      const label = `${idx + 1}`;
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 8;
      const bx = Math.max(plotL, Math.min(plotR - tw, x - tw / 2));
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(bx, plotT + 2, tw, 13);
      ctx.fillStyle = '#111';
      ctx.fillText(label, bx + tw / 2, plotT + 9);
    }
  }

  // --- seek (click / pointer drag) ---------------------------------------
  function pointerToFrame(evt) {
    const n = seriesLength();
    if (n < 1) return null;
    const rect = canvas.getBoundingClientRect();
    const px = evt.clientX - rect.left; // CSS px, same space as draw()
    return invMapX(px, n);
  }
  function fireSeek(evt) {
    const frame = pointerToFrame(evt);
    if (frame === null) return;
    if (typeof seekCb === 'function') seekCb(frame);
  }
  let dragging = false;
  const onPointerDown = (e) => { dragging = true; fireSeek(e); };
  const onPointerMove = (e) => { if (dragging) fireSeek(e); };
  const onPointerUp = () => { dragging = false; };
  const onClick = (e) => fireSeek(e);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  // Redraw when the panel/host resizes (responsive width).
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
  }

  // --- stats line ---------------------------------------------------------
  function updateStatsLine(point) {
    const { step, temperatureK, targetTemperatureK, etotEv, epotEv, ekinEv, meanForce, pressure } = point;
    const parts = [];
    if (step !== undefined) parts.push(`step=${step}`);
    if (Number.isFinite(temperatureK)) parts.push(`T=${fmt(temperatureK, 1)} K`);
    if (Number.isFinite(targetTemperatureK)) parts.push(`Ttarget=${fmt(targetTemperatureK, 1)} K`);
    if (Number.isFinite(etotEv)) parts.push(`Etot=${fmt(etotEv, 4)} eV`);
    if (Number.isFinite(epotEv)) parts.push(`Epot=${fmt(epotEv, 4)} eV`);
    if (Number.isFinite(ekinEv)) parts.push(`Ekin=${fmt(ekinEv, 4)} eV`);
    if (Number.isFinite(meanForce)) parts.push(`Fmean=${fmt(meanForce, 4)} eV/Å`);
    if (Number.isFinite(pressure)) parts.push(`P=${fmt(pressure, 3)}`);
    statsEl.textContent = parts.join('  |  ');
  }

  // --- public API ---------------------------------------------------------
  const KNOWN = ['temperatureK', 'targetTemperatureK', 'etotEv', 'epotEv', 'ekinEv', 'meanForce', 'pressure'];

  const api = {
    update(point = {}) {
      for (const field of KNOWN) {
        if (!(field in point)) continue;
        if (SERIES_SPEC[field] && SERIES_SPEC[field].plot === false) continue; // stats-only
        const arr = ensureSeries(field);
        const v = point[field];
        arr.push(Number.isFinite(v) ? v : NaN);
        if (arr.length > maxPts) arr.shift();
      }
      for (const key of Object.keys(point)) {
        if (key === 'step' || KNOWN.includes(key)) continue;
        const arr = ensureSeries(key);
        const v = point[key];
        arr.push(Number.isFinite(v) ? v : NaN);
        if (arr.length > maxPts) arr.shift();
      }
      rebuildLegend();
      draw();
      updateStatsLine(point);
    },

    setSeries(seriesObj = {}) {
      series.clear();
      seriesOrder.length = 0;
      for (const [name, arr] of Object.entries(seriesObj)) {
        if (SERIES_SPEC[name] && SERIES_SPEC[name].plot === false) continue;
        series.set(name, Array.isArray(arr) ? arr.slice() : []);
        seriesOrder.push(name);
      }
      rebuildLegend();
      draw();
      statsEl.textContent = '';
    },

    clear() {
      series.clear();
      seriesOrder.length = 0;
      cursorIndex = null;
      rebuildLegend();
      draw();
      statsEl.textContent = '';
    },

    setCursor(frameIndex) {
      cursorIndex = Number.isFinite(frameIndex) ? frameIndex : null;
      draw();
    },

    onSeek(cb) { seekCb = cb; },

    getEl() { return root; },

    remove() {
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (ro) ro.disconnect();
      root.remove();
    },
  };

  draw();
  return api;
}
