// Energy-landscape rendering machinery, ported (adapted) from the standalone
// playground's viewer.js. Everything here is dataset-scoped and pure DOM/canvas
// (no three.js): a landscape JSON `D` plus a computed ranges object `R` in, a
// spectral heatmap + colorbar + crosshair/min overlay out. The controller
// (landscape.js) wires these into tiles and owns selection/linking.
//
// JSON schema (one loaded file = one row of per-model heatmap tiles):
//   lattice:      [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]   Å, row vectors
//   fixed_atoms:  [[el, fx, fy, fz], ...]               atoms held still
//   moved_atoms:  [{ el, group }, ...]                  atoms displaced by the grid
//   element_info: { El: { color:'#rrggbb', radius }, ... }
//   bond_cutoffs: { 'A-B': cutoffÅ, ... }               (unused here; viewer bonds)
//   x_vals/y_vals:[...] length nc / nr                  displacement axis samples
//   grid_shape:   [nr, nc]
//   positions:    [ [ [fx,fy,fz], ... moved_atoms ], ... ]   length nr*nc, row-major
//   energies:     { model: [ e0, e1, ... ] }            length nr*nc, row-major
// A cell is "unphysical" where distance_loss > 0 (atoms overlapping); those are
// excluded from the physical energy minimum and range.

// All known models, in canonical display order with human labels. `dist` marks
// the distance-cost pseudo-model (plain value, not eV/atom).
export const MODEL_INFO = {
  DFT_energy:         { label: 'DFT',           dist: false },
  dft:                { label: 'DFT',           dist: false },
  mace_matpes_0:      { label: 'MACE MatPES',   dist: false },
  orb:                { label: 'ORB',           dist: false },
  mace_medium:        { label: 'MACE Medium',   dist: false },
  mace_mpa_0_medium:  { label: 'MACE MPA',      dist: false },
  mace_ob2_medium:    { label: 'MACE OB2',      dist: false },
  mace_ob3_medium:    { label: 'MACE OB3',      dist: false },
  mace_omat_0_medium: { label: 'MACE OMAT',     dist: false },
  chgnet:             { label: 'CHGNet',        dist: false },
  sevennet:           { label: 'SevenNet',      dist: false },
  distance_loss:      { label: 'Distance Cost', dist: true  },
};

// The model highlighted in the info text / tile chrome (finds a different
// minimum from the others in the reference dataset).
export const HIGHLIGHT_MODEL = 'mace_matpes_0';

/** Models actually present in a dataset, in MODEL_INFO order. */
export function modelOrderFor(D) {
  return Object.keys(MODEL_INFO).filter((m) => m in (D.energies || {}));
}

/** Total atoms in the crystal a dataset describes (for eV/atom badges). */
export function nAtomsOf(D) {
  return (D.fixed_atoms?.length || 0) + (D.moved_atoms?.length || 0);
}

// ── Colormap: Spectral_r ─────────────────────────────────────────────────────
const SPECTRAL_STOPS = [
  [0.369, 0.310, 0.635], [0.196, 0.533, 0.741], [0.400, 0.761, 0.647],
  [0.671, 0.867, 0.643], [0.902, 0.961, 0.596], [1.000, 1.000, 0.749],
  [0.996, 0.878, 0.545], [0.992, 0.682, 0.380], [0.957, 0.427, 0.263],
  [0.835, 0.243, 0.310], [0.619, 0.004, 0.259],
];
export function spectralR(t) {
  t = Math.max(0, Math.min(1, t));
  const n = SPECTRAL_STOPS.length - 1;
  const i = Math.floor(t * n);
  const f = t * n - i;
  const a = SPECTRAL_STOPS[Math.min(i, n)];
  const b = SPECTRAL_STOPS[Math.min(i + 1, n)];
  return [
    Math.round((a[0] + f * (b[0] - a[0])) * 255),
    Math.round((a[1] + f * (b[1] - a[1])) * 255),
    Math.round((a[2] + f * (b[2] - a[2])) * 255),
  ];
}

// ── Ranges (percentile-based, linear scale) ──────────────────────────────────
export function isUnphys(D, r, c) {
  const [, nc] = D.grid_shape;
  const v = D.energies.distance_loss?.[r * nc + c];
  return v !== null && v !== undefined && v > 0;
}

/**
 * Per-model color ranges. Energy models are shifted to ΔE relative to their own
 * physical minimum (emin, eV/atom) and, matching the standalone, capped at
 * 0 eV/atom absolute for contrast. distance_loss uses a 99th-percentile hi.
 */
export function computeRanges(D) {
  const [nr, nc] = D.grid_shape;
  const nAtoms = nAtomsOf(D) || 1;
  const R = {};
  for (const model of modelOrderFor(D)) {
    const isDist = MODEL_INFO[model].dist;
    if (isDist) {
      const vals = [];
      for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
        const v = D.energies[model]?.[r * nc + c];
        if (v !== null && v !== undefined && isFinite(v)) vals.push(v);
      }
      vals.sort((a, b) => a - b);
      R[model] = { lo: 0, hi: vals[Math.floor(vals.length * 0.99)] || 1, gamma: 1.0 };
    } else {
      let emin = Infinity;
      for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
        if (isUnphys(D, r, c)) continue;
        const v = D.energies[model]?.[r * nc + c];
        if (v !== null && v !== undefined && isFinite(v)) emin = Math.min(emin, v / nAtoms);
      }
      if (!isFinite(emin)) emin = 0;
      // hi = -emin -> colorbar tops out at 0 eV/atom (absolute).
      R[model] = { emin, lo: 0, hi: -emin, gamma: 1.0 };
    }
  }
  return R;
}

export function mapColor(D, R, v, model) {
  if (v === null || v === undefined) return [15, 15, 20];
  const nAtoms = nAtomsOf(D) || 1;
  const isDist = MODEL_INFO[model].dist;
  const { lo, hi, gamma, emin } = R[model];
  const vn = isDist ? v : (v / nAtoms - emin);
  const tLin = Math.max(0, Math.min(1, (vn - lo) / (hi - lo || 1)));
  const t = Math.pow(tLin, gamma ?? 1.0);
  return spectralR(t);
}

export function getEnergy(D, r, c, model) {
  const [, nc] = D.grid_shape;
  const v = D.energies[model]?.[r * nc + c];
  return (v === null || v === undefined) ? null : v;
}

/** Physical minimum cell of a model (unphysical cells excluded for energies). */
export function findMin(D, model) {
  const [nr, nc] = D.grid_shape;
  const isDist = MODEL_INFO[model].dist;
  let minV = Infinity, minR = 0, minC = 0;
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
    if (!isDist && isUnphys(D, r, c)) continue;
    const v = D.energies[model]?.[r * nc + c];
    if (v !== null && v !== undefined && isFinite(v) && v < minV) {
      minV = v; minR = r; minC = c;
    }
  }
  return { row: minR, col: minC, val: minV };
}

// ── Heatmap canvas (drawn at native nc×nr, CSS-scaled up smoothly) ────────────
// Rows whose y_val is null are interpolated from the nearest valid rows above /
// below so gaps don't read as hard bands.
export function renderHeatmap(hmCanvas, D, R, model) {
  const [nr, nc] = D.grid_shape;
  hmCanvas.width = nc; hmCanvas.height = nr;
  const ctx = hmCanvas.getContext('2d');
  const img = ctx.createImageData(nc, nr);
  const px = img.data;

  const rowColors = new Array(nr);
  for (let r = 0; r < nr; r++) {
    if (D.y_vals[r] === null) { rowColors[r] = null; continue; }
    rowColors[r] = new Array(nc);
    for (let c = 0; c < nc; c++)
      rowColors[r][c] = mapColor(D, R, D.energies[model]?.[r * nc + c], model);
  }
  for (let r = 0; r < nr; r++) {
    if (rowColors[r] !== null) continue;
    let ra = r - 1; while (ra >= 0 && rowColors[ra] === null) ra--;
    let rb = r + 1; while (rb < nr && rowColors[rb] === null) rb++;
    if (ra < 0 && rb >= nr) { rowColors[r] = Array.from({ length: nc }, () => [15, 15, 20]); continue; }
    if (ra < 0) { rowColors[r] = rowColors[rb]; continue; }
    if (rb >= nr) { rowColors[r] = rowColors[ra]; continue; }
    const t = (r - ra) / (rb - ra);
    rowColors[r] = rowColors[ra].map(([r1, g1, b1], c) => {
      const [r2, g2, b2] = rowColors[rb][c];
      return [Math.round(r1 + (r2 - r1) * t), Math.round(g1 + (g2 - g1) * t), Math.round(b1 + (b2 - b1) * t)];
    });
  }
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
    const i = ((nr - 1 - r) * nc + c) * 4;
    const [rr, gg, bb] = rowColors[r][c];
    px[i] = rr; px[i + 1] = gg; px[i + 2] = bb; px[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function renderColorbar(cbCanvas, R, model) {
  const ctx = cbCanvas.getContext('2d');
  const w = cbCanvas.width = cbCanvas.offsetWidth || 120;
  cbCanvas.height = cbCanvas.offsetHeight || 6;
  const h = cbCanvas.height;
  const { gamma } = R[model];
  for (let i = 0; i < w; i++) {
    const t = Math.pow(i / w, gamma ?? 1.0);
    const [r, g, b] = spectralR(t);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(i, 0, 1, h);
  }
}

// ── Overlay: min marker (⊕) + selection crosshair ────────────────────────────
// `cur` is the selected {row, col} (or {row:null}); minPt is the model minimum.
// When `invalid` the tile is dimmed with a message but the min marker stays so
// the user can navigate back; the moving crosshair is suppressed.
export function renderOverlay(D, ovCanvas, ovCtx, minPt, cur, model, opts = {}) {
  const [nr, nc] = D.grid_shape;
  const w = ovCanvas.offsetWidth, h = ovCanvas.offsetHeight;
  if (!w || !h) return;
  if (ovCanvas.width !== w || ovCanvas.height !== h) { ovCanvas.width = w; ovCanvas.height = h; }
  ovCtx.clearRect(0, 0, w, h);

  const invalid = !!opts.invalid;
  if (invalid) {
    ovCtx.fillStyle = 'rgba(0,0,0,0.38)';
    ovCtx.fillRect(0, 0, w, h);
    ovCtx.textAlign = 'center';
    ovCtx.fillStyle = 'rgba(255,200,60,0.92)';
    ovCtx.font = "bold 11px 'CrysViz Sans', sans-serif";
    ovCtx.fillText(opts.invalidLabel ?? 'displaced', w / 2, h / 2 - 9);
    ovCtx.fillStyle = 'rgba(220,220,220,0.72)';
    ovCtx.font = "9px 'CrysViz Sans', sans-serif";
    ovCtx.fillText(opts.invalidSub ?? '', w / 2, h / 2 + 7);
    ovCtx.textAlign = 'left';
  }

  const sx = w / nc, sy = h / nr;
  const toXY = (r, c) => ({ x: (c + 0.5) * sx, y: ((nr - 1 - r) + 0.5) * sy });

  if (minPt) {
    const { x: mx, y: my } = toXY(minPt.row, minPt.col);
    const hot = model === HIGHLIGHT_MODEL;
    ovCtx.beginPath(); ovCtx.arc(mx, my, hot ? 6 : 5, 0, Math.PI * 2);
    ovCtx.strokeStyle = hot ? 'rgba(255,160,0,0.95)' : 'rgba(0,0,0,0.8)';
    ovCtx.lineWidth = hot ? 2.5 : 2; ovCtx.stroke();
    ovCtx.beginPath();
    ovCtx.moveTo(mx - 8, my); ovCtx.lineTo(mx + 8, my);
    ovCtx.moveTo(mx, my - 8); ovCtx.lineTo(mx, my + 8);
    ovCtx.strokeStyle = hot ? 'rgba(255,160,0,0.85)' : 'rgba(0,0,0,0.7)';
    ovCtx.lineWidth = hot ? 2 : 1.5; ovCtx.stroke();
  }

  if (invalid || !cur || cur.row === null || cur.row === undefined) return;
  const { x: cx, y: cy } = toXY(cur.row, cur.col);
  ovCtx.save();
  ovCtx.setLineDash([3, 3]);
  ovCtx.strokeStyle = 'rgba(255,255,255,0.45)'; ovCtx.lineWidth = 1;
  ovCtx.beginPath(); ovCtx.moveTo(cx, 0); ovCtx.lineTo(cx, h); ovCtx.stroke();
  ovCtx.beginPath(); ovCtx.moveTo(0, cy); ovCtx.lineTo(w, cy); ovCtx.stroke();
  ovCtx.restore();
  ovCtx.beginPath(); ovCtx.arc(cx, cy, 4, 0, Math.PI * 2);
  ovCtx.strokeStyle = 'white'; ovCtx.lineWidth = 2; ovCtx.stroke();
}

/** Map a pointer event on the overlay canvas to a grid {row, col}. */
export function canvasToRowCol(e, canvas, gridShape) {
  const [nr, nc] = gridShape;
  const rect = canvas.getBoundingClientRect();
  const rx = (e.clientX - rect.left) / rect.width;
  const ry = (e.clientY - rect.top) / rect.height;
  return {
    row: Math.max(0, Math.min(nr - 1, (nr - 1) - Math.floor(ry * nr))),
    col: Math.max(0, Math.min(nc - 1, Math.floor(rx * nc))),
  };
}

/** Badge text for a cell (or the model minimum when nothing is selected). */
export function badgeText(D, model, cur, minPt) {
  const nAtoms = nAtomsOf(D) || 1;
  const info = MODEL_INFO[model];
  if (!cur || cur.row === null || cur.row === undefined) {
    return info.dist ? `min:${minPt.val.toFixed(2)}` : `min:${(minPt.val / nAtoms).toFixed(3)} eV/at`;
  }
  const v = getEnergy(D, cur.row, cur.col, model);
  if (v === null) return '—';
  return info.dist ? v.toFixed(3) : `${(v / nAtoms).toFixed(3)} eV/at`;
}
