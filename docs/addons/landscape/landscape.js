// Energy Landscape addon — the interactive port of the standalone playground
// (~/work/Papers/landscape_paper/site/cu2o8s4_linked.html + viewer.js) rebuilt
// as a CrysViz addon. Instead of the standalone's private three.js viewer, a
// selected grid point drives the MAIN CrysViz viewer through the addon API:
// setFracPositions() per interaction tick, commitPositions() when the gesture
// ends. Loading a JSON that doesn't match the active structure loads a
// reference structure built from the JSON (POSCAR) into the file browser.
//
// One loaded JSON = one row of per-model heatmap tiles. Two JSONs that describe
// the same crystal with a shared displacement coordinate become the linked
// two-row experience: row (a) moves one atom in two directions (single group),
// row (b) moves two atoms along a shared axis (two groups g0/g1). The rows share
// one coordinate (row-of-a ↔ col-of-b); displacing the other DOF of either row
// greys the other out with a desync banner and a Re-sync affordance, exactly as
// the standalone did. Two JSONs that are not linkable render as independent rows.
//
// Rendering machinery (spectral colormap, ranges, heatmap/colorbar/overlay,
// picking, badges) lives in heatmap.js.

import {
  MODEL_INFO, HIGHLIGHT_MODEL, modelOrderFor,
  computeRanges, findMin, renderHeatmap, renderColorbar, renderOverlay,
  canvasToRowCol, badgeText, isUnphys,
} from './heatmap.js';

// ── Injected, namespaced styles (removed on destroy; theme-token based) ───────
const STYLE_ID = 'lsc-addon-styles';
const STYLE_TEXT = `
.lsc-root { display:flex; flex-direction:column; gap:14px; }
.lsc-empty {
  border:1px dashed var(--panel-border); border-radius:var(--radius);
  padding:18px; color:var(--muted-fg); font-size:13px; line-height:1.7;
}
.lsc-empty b { color:var(--panel-fg); }
.lsc-empty code {
  font-family:ui-monospace,monospace; font-size:11px;
  background:var(--group-bg); padding:1px 4px; border-radius:4px;
}
.lsc-dragover { outline:2px dashed var(--highlight-color); outline-offset:-6px; }
.lsc-load-btn {
  display:inline-flex; align-items:center; gap:6px; cursor:pointer;
  font-size:calc(12px * var(--cv-font-scale,1)); padding:4px 10px;
  border:1px solid var(--panel-border); border-radius:6px;
  background:var(--bg-color); color:var(--panel-fg); white-space:nowrap;
}
.lsc-load-btn:hover { background:var(--hover-color); }
.lsc-load-btn input { display:none; }
.lsc-row { display:flex; flex-direction:column; gap:5px; }
.lsc-row-label { font-size:11px; color:var(--muted-fg); padding:0 2px; line-height:1.5; }
.lsc-row-label b { color:var(--panel-fg); }
.lsc-gridwrap { position:relative; }
.lsc-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:12px; }
.lsc-tile {
  border:1px solid var(--panel-border); border-radius:var(--radius);
  background:var(--group-bg); padding:12px; display:flex; flex-direction:column; gap:7px;
}
.lsc-tile-hot { border-color:rgba(255,180,0,0.7); box-shadow:0 0 0 2px rgba(255,180,0,0.18); }
.lsc-tile-hdr { display:flex; align-items:center; justify-content:space-between; gap:4px; }
.lsc-model-name { font-size:11px; font-weight:600; color:var(--panel-fg); }
.lsc-tile-hot .lsc-model-name { color:rgba(255,200,60,0.95); }
.lsc-badge {
  font-size:10px; font-family:ui-monospace,monospace; color:var(--muted-fg);
  opacity:0.85; white-space:nowrap;
}
.lsc-canvas-wrap { position:relative; width:100%; aspect-ratio:1; }
.lsc-hm, .lsc-ov { position:absolute; inset:0; width:100%; height:100%; border-radius:4px; }
.lsc-hm { image-rendering:auto; }
.lsc-ov { cursor:crosshair; touch-action:none; }
.lsc-tile-foot { display:flex; align-items:center; gap:5px; }
.lsc-cb-lo, .lsc-cb-hi { font-size:9px; font-family:ui-monospace,monospace; color:var(--muted-fg); opacity:0.8; }
/* min-width:0 overrides the flex default (min-width:auto), which — once
   renderColorbar() sets the canvas's width attribute (its intrinsic size)
   — would otherwise floor the item at that size forever: a flex item can't
   shrink below its own intrinsic content size unless min-width is reset. */
.lsc-cb { flex:1; min-width:0; height:6px; border-radius:3px; }
.lsc-resync-overlay {
  position:absolute; inset:0; display:none; align-items:center; justify-content:center;
  pointer-events:none; z-index:5;
}
.lsc-resync-overlay.lsc-visible { display:flex; }
.lsc-resync-btn {
  pointer-events:auto; padding:7px 16px; font-size:12px; cursor:pointer;
  background:var(--menu-bg); border:1px solid var(--highlight-color);
  border-radius:8px; color:var(--panel-fg); backdrop-filter:blur(6px);
}
.lsc-resync-btn:hover { background:var(--hover-color); }
.lsc-info {
  border:1px solid var(--panel-border); border-radius:var(--radius);
  background:var(--group-bg); padding:11px 14px;
  font-size:12px; line-height:1.65; color:var(--muted-fg);
}
.lsc-info p { margin:0 0 8px; }
.lsc-info p:last-child { margin:0; }
.lsc-info b { color:var(--panel-fg); }
.lsc-sync {
  margin-top:9px; padding:8px 11px; border-radius:6px; font-size:12px;
  line-height:1.55; border:1px solid transparent;
}
.lsc-sync.lsc-synced { background:rgba(129,199,132,0.10); border-color:rgba(129,199,132,0.32); color:#9ed4a0; }
.lsc-sync.lsc-displaced { background:rgba(255,183,77,0.10); border-color:rgba(255,183,77,0.36); color:#ffc870; }
.lsc-sync .lsc-hint { margin-top:5px; color:var(--muted-fg); opacity:0.8; font-size:11px; }
.lsc-tip {
  position:fixed; z-index:2000; display:none; pointer-events:none;
  background:var(--menu-bg); border:1px solid var(--panel-border); border-radius:6px;
  padding:5px 8px; font-size:11px; line-height:1.4; color:var(--panel-fg);
  font-family:ui-monospace,monospace; box-shadow:0 4px 12px rgba(0,0,0,0.35);
}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}
function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

// ── Small math helpers ────────────────────────────────────────────────────────
const wrap01 = (x) => ((x % 1) + 1) % 1;

// Minimum-image fractional distance² between two [x,y,z] (periodic in [0,1)).
function fracDist2(a, b) {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    let d = a[k] - b[k];
    d -= Math.round(d);
    s += d * d;
  }
  return s;
}

/**
 * Map each canonical JSON atom (element + base fractional position) to a
 * structure atom index. Greedy nearest same-element match under periodic
 * boundaries — robust to POSCAR element-grouping reordering and to driving an
 * already-loaded structure whose atom order differs. Returns null if any
 * canonical atom can't be matched (element counts disagree).
 */
function buildAtomMap(structure, canonEls, canonBase) {
  const atoms = structure?.atoms;
  // Element identity lives in the parallel structure.elements array (Atom
  // instances do not carry an .element property).
  const els = structure?.elements;
  if (!atoms || !els || atoms.length < canonEls.length) return null;
  const used = new Array(atoms.length).fill(false);
  const map = new Array(canonEls.length).fill(-1);
  for (let j = 0; j < canonEls.length; j++) {
    const el = canonEls[j];
    const p = [wrap01(canonBase[j][0]), wrap01(canonBase[j][1]), wrap01(canonBase[j][2])];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < atoms.length; i++) {
      if (used[i] || els[i] !== el) continue;
      const q = atoms[i].position;
      const d = fracDist2(p, [wrap01(q[0]), wrap01(q[1]), wrap01(q[2])]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    used[best] = true;
    map[j] = best;
  }
  return map;
}

/** Element-count signature ("Cu2O8S4"-ish, sorted) for a quick match test. */
function elemSignature(els) {
  const counts = new Map();
  for (const e of els) counts.set(e, (counts.get(e) || 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([e, n]) => `${e}${n}`).join('');
}

/** Build POSCAR text (Direct) from a lattice + element/coord canonical list. */
function toPOSCAR(name, lattice, canonEls, canonCoords) {
  const order = [];
  const groups = new Map();
  canonEls.forEach((el, i) => {
    if (!groups.has(el)) { groups.set(el, []); order.push(el); }
    groups.get(el).push(canonCoords[i]);
  });
  const num = (v) => (Number.isFinite(v) ? v : 0).toFixed(10);
  const lines = [
    name,
    '1.0',
    ...lattice.map((r) => `  ${num(r[0])} ${num(r[1])} ${num(r[2])}`),
    '  ' + order.join(' '),
    '  ' + order.map((el) => groups.get(el).length).join(' '),
    'Direct',
  ];
  for (const el of order) {
    for (const c of groups.get(el)) {
      lines.push(`  ${num(wrap01(c[0]))} ${num(wrap01(c[1]))} ${num(wrap01(c[2]))}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ── Linkage detection ─────────────────────────────────────────────────────────
// The standalone's linked pair: one dataset moves a single group (g0) in two
// directions (row=z, col=x) — this is row (a); the other moves g0 along its col
// (shared z) and a second group (g1) along its row — this is row (b). They share
// the g0 z coordinate: row-of-(a) ↔ col-of-(b). Linkable when the crystals match
// (same lattice, same element signature, same total atom count) and the group
// structure is single-group vs g0+g1.
function groupsOf(D) {
  const set = new Set(D.moved_atoms.map((a) => a.group));
  return set;
}
function latticeClose(la, lb) {
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) {
    if (Math.abs(la[i][k] - lb[i][k]) > 1e-6) return false;
  }
  return true;
}
function detectLink(D1, D2) {
  if (!latticeClose(D1.lattice, D2.lattice)) return null;
  const sig = (D) => elemSignature([...D.fixed_atoms.map((a) => a[0]), ...D.moved_atoms.map((a) => a.el)]);
  if (sig(D1) !== sig(D2)) return null;
  const g1 = groupsOf(D1), g2 = groupsOf(D2);
  const isA = (g) => g.size === 1 && g.has('g0');
  const isB = (g) => g.has('g0') && g.has('g1');
  if (isA(g1) && isB(g2)) return { A: D1, B: D2 };
  if (isA(g2) && isB(g1)) return { A: D2, B: D1 };
  return null;
}

// ── Controller ────────────────────────────────────────────────────────────────
/**
 * opts (all optional):
 *   controlsHost: element hosting the loader UI (the 📂 button + a drop
 *     target) instead of `container` — used by the split controls/plots
 *     window pair (ui/LandscapePanel.js), where the loader lives in the
 *     main-dock controls window and `container` is the plots window's body.
 *   onContent(): a load attempt started (files chosen/dropped) — the caller
 *     opens/reveals the plots window so the result (or the error box) is
 *     visible.
 */
export function createLandscape(container, api, opts = {}) {
  injectStyles();
  const controlsHost = opts.controlsHost || null;

  const state = {
    mode: 'empty',        // 'empty' | 'linked' | 'independent'
    rows: [],             // per-row render state
    // linked state:
    A: null, B: null, RA: null, RB: null,
    cA: { row: 0, col: 0 }, cB: { row: 0, col: 0 },
    refRowB: 0, refColA: 0, refColB: 0,
    linkTiles: { A: {}, B: {} },
    canon: null,          // { els, base, lattice, name, sig }
    atomMap: null,        // canonical index -> structure atom index
    mappedSig: null,      // signature the atomMap was built against
    lastSelect: null,     // 'A' | 'B'
    tileGrids: [],         // [{ grid, rows, cols }, ...] — every .lsc-grid currently on screen
  };

  const tooltip = document.createElement('div');
  tooltip.className = 'lsc-tip';
  document.body.appendChild(tooltip);

  // ---- toolbar: file input (multi-select), hosted in the controls window
  // when one is provided (opts.controlsHost), else prepended at the top of
  // the addon's container. Attached outside `root` either way so it survives
  // showEmpty()/buildLinkedDOM()/setupIndependent(), all of which do a
  // root.replaceChildren(). -------------------------------------------------
  const loadLabel = document.createElement('label');
  loadLabel.className = 'lsc-load-btn';
  loadLabel.textContent = '📂 Load landscape JSON';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.multiple = true;
  loadLabel.appendChild(fileInput);
  (controlsHost || container).appendChild(loadLabel);
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) loadFiles([...fileInput.files]);
    fileInput.value = '';
  });

  const root = document.createElement('div');
  root.className = 'lsc-root';
  container.appendChild(root);

  // ---- drag & drop onto the plots body (and the controls window, if split:
  // the plots window may be closed until a first load, so the controls side
  // must accept the drop too) -----------------------------------------------
  const dropZones = controlsHost ? [container, controlsHost] : [container];
  const dropHandlers = dropZones.map((zone) => {
    const onDragOver = (e) => { e.preventDefault(); zone.classList.add('lsc-dragover'); };
    const onDragLeave = (e) => { if (e.target === zone) zone.classList.remove('lsc-dragover'); };
    const onDrop = (e) => {
      e.preventDefault();
      zone.classList.remove('lsc-dragover');
      const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.json$/i.test(f.name));
      if (files.length) loadFiles(files);
    };
    zone.addEventListener('dragover', onDragOver);
    zone.addEventListener('dragleave', onDragLeave);
    zone.addEventListener('drop', onDrop);
    return { zone, onDragOver, onDragLeave, onDrop };
  });

  // ---- resize: re-size tiles to the available space, then re-fit overlays
  // + colorbars off the result -----------------------------------------
  let resizeRaf = 0;
  const ro = new ResizeObserver(() => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; applyTileSizing(); refitAll(); });
  });
  ro.observe(container);

  const unsubTheme = api.onThemeChange(() => refitAll());

  // ---- empty state -------------------------------------------------------
  function showEmpty() {
    state.mode = 'empty';
    state.tileGrids = [];
    root.replaceChildren();
    const box = document.createElement('div');
    box.className = 'lsc-empty';
    box.innerHTML =
      '<p><b>Energy Landscape</b> — load one or two landscape JSON files ' +
      '(via the Load button in the Energy Landscape window, or by dropping ' +
      'them onto it or here).</p>' +
      '<p>Each file renders one row of per-model energy heatmaps. Two files that ' +
      'describe the same crystal with a shared displacement coordinate become the ' +
      'linked two-row view; clicking or dragging a tile displaces the atoms live in ' +
      'the main 3D viewer.</p>' +
      '<p>Expected keys: <code>lattice</code>, <code>fixed_atoms</code>, ' +
      '<code>moved_atoms</code>, <code>grid_shape</code>, <code>x_vals</code>, ' +
      '<code>y_vals</code>, <code>positions</code>, <code>energies</code>.</p>';
    root.appendChild(box);
  }
  showEmpty();

  // ---- load / parse ------------------------------------------------------
  async function loadFiles(files) {
    // Something is about to show (rows, or the error box) — let the host
    // reveal the plots window before we render into it, so sizes measure.
    opts.onContent?.();
    try {
      const parsed = [];
      for (const f of files.slice(0, 2)) {
        const text = await f.text();
        const D = JSON.parse(text);
        D._name = f.name.replace(/\.json$/i, '');
        parsed.push(D);
      }
      if (!parsed.length) return;
      if (parsed.length === 2) {
        const link = detectLink(parsed[0], parsed[1]);
        if (link) { setupLinked(link.A, link.B); return; }
        setupIndependent(parsed);
        return;
      }
      setupIndependent(parsed);
    } catch (err) {
      console.error('Landscape: failed to load JSON', err);
      state.mode = 'empty';
      root.replaceChildren();
      const box = document.createElement('div');
      box.className = 'lsc-empty';
      box.innerHTML = `<p style="color:var(--danger)">Could not read landscape JSON: ${err.message}</p>`;
      root.appendChild(box);
    }
  }

  // ── Reference structure: ensure the main viewer holds a structure this
  // dataset can drive, and (re)build the canonical→structure atom map. ──────
  async function ensureStructure(canon) {
    let structure = api.getStructure();
    const active = structure ? elemSignature(structure.elements || []) : null;
    if (active !== canon.sig) {
      const poscar = toPOSCAR(`${canon.name}_landscape`, canon.lattice, canon.els, canon.base);
      await api.loadStructure(poscar, 'poscar', `${canon.name}_landscape`);
      structure = api.getStructure();
      api.recenterCamera();
    }
    const map = buildAtomMap(structure, canon.els, canon.base);
    state.atomMap = map;
    state.mappedSig = structure ? elemSignature(structure.elements || []) : null;
    return map;
  }

  // Rebuild the atom map if the active structure changed underneath us.
  function refreshMapIfNeeded(canon) {
    const structure = api.getStructure();
    const sig = structure ? elemSignature(structure.elements || []) : null;
    if (sig !== state.mappedSig || !state.atomMap) {
      state.atomMap = buildAtomMap(structure, canon.els, canon.base);
      state.mappedSig = sig;
    }
    return state.atomMap;
  }

  // Push canonical current fractional coords into the main viewer. `live`
  // controls the fast path; a non-live (gesture-end) call always commits.
  function drive(canon, currentFrac, live) {
    const map = refreshMapIfNeeded(canon);
    const structure = api.getStructure();
    if (!map || !structure) return;
    const out = structure.atoms.map((a) => a.position.slice());
    for (let j = 0; j < map.length; j++) out[map[j]] = currentFrac[j].slice();
    if (live) {
      if (!api.setFracPositions(out)) api.commitPositions();
    } else {
      api.setFracPositions(out);
      api.commitPositions();
    }
  }

  // ============================ LINKED MODE ==============================
  function setupLinked(A, B) {
    state.mode = 'linked';
    state.A = A; state.B = B;
    state.RA = computeRanges(A);
    state.RB = computeRanges(B);

    // References: start B at its highlight-model minimum (S at reference row).
    const startModelB = (HIGHLIGHT_MODEL in B.energies) ? HIGHLIGHT_MODEL : modelOrderFor(B)[0];
    const startMinB = findMin(B, startModelB);
    state.refRowB = startMinB.row;
    state.refColB = startMinB.col;

    // Row (a) reference O_x column: minimize the highlight model along A's col at
    // the shared O_z row (= B's reference col). Row (b) valid only when cA.col === refColA.
    const startModelA = (HIGHLIGHT_MODEL in A.energies) ? HIGHLIGHT_MODEL : modelOrderFor(A)[0];
    const [, ncA] = A.grid_shape;
    const ozRow = state.refColB;
    let bestCol = 0, bestVal = Infinity;
    for (let c = 0; c < ncA; c++) {
      if (isUnphys(A, ozRow, c)) continue;
      const v = A.energies[startModelA]?.[ozRow * ncA + c];
      if (v !== null && v !== undefined && isFinite(v) && v < bestVal) { bestVal = v; bestCol = c; }
    }
    state.refColA = bestCol;

    state.cB = { row: state.refRowB, col: state.refColB };
    state.cA = { row: state.refColB, col: state.refColA };

    // Canonical structure = B decomposition (fixed + moved) at B's reference.
    const [, ncB] = B.grid_shape;
    const refPosB = B.positions[state.refRowB * ncB + state.refColB];
    const els = [...B.fixed_atoms.map((a) => a[0]), ...B.moved_atoms.map((a) => a.el)];
    const base = [
      ...B.fixed_atoms.map((a) => [a[1], a[2], a[3]]),
      ...refPosB.map((p) => p.slice()),
    ];
    state.canon = { els, base, lattice: B.lattice, name: B._name || 'linked', sig: elemSignature(els) };

    buildLinkedDOM();
    ensureStructure(state.canon).then(() => driveLinked(false));
  }

  function buildLinkedDOM() {
    root.replaceChildren();
    const { A, B } = state;
    state.linkTiles = { A: {}, B: {} };
    state.tileGrids = [];

    const rowA = buildRowSection(
      A, state.RA, state.linkTiles.A,
      'Row (a)', 'atom moved in two directions (x vs z); the second atom held fixed',
      (r, c, live) => selectA(r, c, live), true);
    const rowB = buildRowSection(
      B, state.RB, state.linkTiles.B,
      'Row (b)', 'two atoms moved along a shared axis (z vs z)',
      (r, c, live) => selectB(r, c, live), true);

    // Re-sync affordance: click either button returns both DOFs to reference.
    const doResync = () => { selectB(state.refRowB, state.cB.col, false); selectA(state.cA.row, state.refColA, false); };
    rowA.overlay.querySelector('button').addEventListener('click', doResync);
    rowB.overlay.querySelector('button').addEventListener('click', doResync);

    const info = document.createElement('div');
    info.className = 'lsc-info';
    info.innerHTML =
      '<p><b>What you are looking at:</b> two energy maps for the same crystal. ' +
      'Each shows how the energy changes as atoms are displaced. <b>Row (a)</b> moves ' +
      'one atom in two directions with the second held still; <b>Row (b)</b> moves two ' +
      'atoms along a shared axis. The highlighted model (⊕ marker) can find a different ' +
      'minimum from the others.</p>' +
      '<p>The rows are linked: they share one coordinate. When both are in sync they ' +
      'describe the same physical structure. Move the independent degree of freedom of ' +
      'either row and the other greys out — it no longer applies.</p>' +
      '<div class="lsc-sync lsc-synced" id="lsc-sync"></div>';
    root.append(rowA.section, rowB.section, info);
    state.syncEl = info.querySelector('#lsc-sync');

    // refitAll() (not just renderLinkedOverlays()) — applyTileSizing() just
    // changed every tile's pixel size, and the colorbars' own raster buffers
    // (set from their old offsetWidth when each tile first built) need a
    // redraw at the new size or they render stretched/blurry.
    requestAnimationFrame(() => { applyTileSizing(); refitAll(); });
  }

  function selectA(r, c, live) {
    const [nr, nc] = state.A.grid_shape;
    r = ((r % nr) + nr) % nr; c = ((c % nc) + nc) % nc;
    state.cA.row = r; state.cA.col = c;
    state.cB.col = r;                 // shared coordinate: row-of-(a) ↔ col-of-(b)
    state.lastSelect = 'A';
    renderLinkedOverlays();
    driveLinked(live);
  }
  function selectB(r, c, live) {
    const [nr, nc] = state.B.grid_shape;
    r = ((r % nr) + nr) % nr; c = ((c % nc) + nc) % nc;
    state.cB.row = r; state.cB.col = c;
    state.cA.row = c;                 // shared coordinate: col-of-(b) ↔ row-of-(a)
    state.lastSelect = 'B';
    renderLinkedOverlays();
    driveLinked(live);
  }

  // Unified current structure: g0 atoms follow row (a) (their live x/z), g1
  // atoms follow row (b) (their live z); fixed atoms stay at reference.
  function driveLinked(live) {
    const { A, B, canon } = state;
    const [, ncA] = A.grid_shape;
    const [, ncB] = B.grid_shape;
    const posA = A.positions[state.cA.row * ncA + state.cA.col]; // 6 g0 (O)
    const posB = B.positions[state.cB.row * ncB + state.cB.col]; // g0 + g1
    const nFixed = B.fixed_atoms.length;
    const cur = canon.base.map((p) => p.slice());
    // moved atoms occupy canon indices [nFixed .. end], in B.moved order.
    for (let i = 0; i < B.moved_atoms.length; i++) {
      const g = B.moved_atoms[i].group;
      if (g === 'g0' && i < posA.length) cur[nFixed + i] = posA[i].slice();
      else cur[nFixed + i] = posB[i].slice();
    }
    drive(canon, cur, live);
  }

  function renderLinkedOverlays() {
    const invalidA = state.cB.row !== state.refRowB; // independent DOF of (b) displaced
    const invalidB = state.cA.col !== state.refColA; // independent DOF of (a) displaced
    for (const m of modelOrderFor(state.A)) {
      const t = state.linkTiles.A[m]; if (!t) continue;
      renderOverlay(state.A, t.ovCanvas, t.ovCtx, t.minPt, state.cA, m, {
        invalid: invalidA, invalidLabel: 'row (b) DOF displaced', invalidSub: 'row (a) held that atom fixed',
      });
      t.badge.textContent = badgeText(state.A, m, state.cA, t.minPt);
    }
    for (const m of modelOrderFor(state.B)) {
      const t = state.linkTiles.B[m]; if (!t) continue;
      renderOverlay(state.B, t.ovCanvas, t.ovCtx, t.minPt, state.cB, m, {
        invalid: invalidB, invalidLabel: 'row (a) DOF displaced', invalidSub: 'row (b) held that atom fixed',
      });
      t.badge.textContent = badgeText(state.B, m, state.cB, t.minPt);
    }
    updateSync(invalidA, invalidB);
  }

  function updateSync(invalidA, invalidB) {
    state.rowOverlayA?.classList.toggle('lsc-visible', invalidA);
    state.rowOverlayB?.classList.toggle('lsc-visible', invalidB);
    const el = state.syncEl; if (!el) return;
    if (!invalidA && !invalidB) {
      el.className = 'lsc-sync lsc-synced';
      el.innerHTML = '✓ <b>Synced.</b> Both rows show the same physical structure. ' +
        'Moving the shared coordinate updates both rows at once.';
    } else if (invalidA && !invalidB) {
      el.className = 'lsc-sync lsc-displaced';
      el.innerHTML = '⚠ <b>Row (b) degree of freedom displaced.</b> Row (a) was computed with that ' +
        'atom fixed, so it no longer reflects the current structure.' +
        '<div class="lsc-hint">Re-sync: click near the ⊕ marker in row (b), or use the Re-sync button.</div>';
    } else if (!invalidA && invalidB) {
      el.className = 'lsc-sync lsc-displaced';
      el.innerHTML = '⚠ <b>Row (a) degree of freedom displaced.</b> Row (b) was computed with that ' +
        'atom fixed, so it no longer reflects the current structure.' +
        '<div class="lsc-hint">Re-sync: click near the ⊕ marker in row (a), or use the Re-sync button.</div>';
    } else {
      el.className = 'lsc-sync lsc-displaced';
      el.innerHTML = '⚠ <b>Both degrees of freedom displaced.</b> Neither row is consistent with the other.' +
        '<div class="lsc-hint">Navigate each row back to its ⊕ marker, or use the Re-sync button.</div>';
    }
  }

  // ========================= INDEPENDENT MODE ============================
  // One or two self-contained rows; each drives the viewer from its own dataset
  // (its own reference structure + atom map, ensured on first interaction).
  function setupIndependent(datasets) {
    state.mode = 'independent';
    state.rows = [];
    state.tileGrids = [];
    root.replaceChildren();

    for (const D of datasets) {
      const R = computeRanges(D);
      const tiles = {};
      const startModel = (HIGHLIGHT_MODEL in D.energies) ? HIGHLIGHT_MODEL : modelOrderFor(D)[0];
      const startMin = findMin(D, startModel);

      const [, nc] = D.grid_shape;
      const refPos = D.positions[startMin.row * nc + startMin.col];
      const els = [...D.fixed_atoms.map((a) => a[0]), ...D.moved_atoms.map((a) => a.el)];
      const base = [
        ...D.fixed_atoms.map((a) => [a[1], a[2], a[3]]),
        ...refPos.map((p) => p.slice()),
      ];
      const canon = { els, base, lattice: D.lattice, name: D._name || 'landscape', sig: elemSignature(els) };
      const rowState = { D, R, tiles, cur: { row: startMin.row, col: startMin.col }, canon };

      const section = buildRowSection(
        D, R, tiles, D._name || 'Landscape',
        `${D.moved_atoms.length} atoms displaced`,
        (r, c, live) => selectIndep(rowState, r, c, live), false).section;
      root.appendChild(section);
      state.rows.push(rowState);
    }

    const info = document.createElement('div');
    info.className = 'lsc-info';
    info.innerHTML = datasets.length === 2
      ? '<p>Two landscapes loaded that are <b>not linkable</b> (different crystal or ' +
        'displacement scheme), so each row is shown independently. Interacting with a ' +
        'row drives the main viewer from that row\'s own reference structure.</p>'
      : '<p>Click or drag a tile to displace the atoms live in the main 3D viewer. ' +
        'The ⊕ marker is each model\'s energy minimum.</p>';
    root.appendChild(info);

    // Drive the first row's reference immediately so the viewer matches.
    ensureStructure(state.rows[0].canon).then(() => {
      driveIndep(state.rows[0], false);
    });
    requestAnimationFrame(() => { applyTileSizing(); refitAll(); });
  }

  function selectIndep(rowState, r, c, live) {
    const [nr, nc] = rowState.D.grid_shape;
    r = ((r % nr) + nr) % nr; c = ((c % nc) + nc) % nc;
    rowState.cur = { row: r, col: c };
    renderIndepOverlays();
    // Ensure this row's structure is the active one, then drive.
    if (state.mappedSig !== rowState.canon.sig) {
      ensureStructure(rowState.canon).then(() => driveIndep(rowState, live));
    } else {
      driveIndep(rowState, live);
    }
  }

  function driveIndep(rowState, live) {
    const { D, canon, cur } = rowState;
    const [, nc] = D.grid_shape;
    const pos = D.positions[cur.row * nc + cur.col];
    const nFixed = D.fixed_atoms.length;
    const frac = canon.base.map((p) => p.slice());
    for (let i = 0; i < D.moved_atoms.length; i++) frac[nFixed + i] = pos[i].slice();
    drive(canon, frac, live);
  }

  function renderIndepOverlays() {
    for (const row of state.rows) {
      for (const m of modelOrderFor(row.D)) {
        const t = row.tiles[m]; if (!t) continue;
        renderOverlay(row.D, t.ovCanvas, t.ovCtx, t.minPt, row.cur, m, {});
        t.badge.textContent = badgeText(row.D, m, row.cur, t.minPt);
      }
    }
  }

  // ── Shared tile/row builder ────────────────────────────────────────────
  function buildRowSection(D, R, tiles, labelBold, labelRest, selectFn, isLinked) {
    const section = document.createElement('div');
    section.className = 'lsc-row';

    const label = document.createElement('div');
    label.className = 'lsc-row-label';
    label.innerHTML = `<b>${labelBold}</b>: ${labelRest}`;
    section.appendChild(label);

    const wrap = document.createElement('div');
    wrap.className = 'lsc-gridwrap';
    const grid = document.createElement('div');
    grid.className = 'lsc-grid';
    wrap.appendChild(grid);
    const [rows, cols] = D.grid_shape;
    state.tileGrids.push({ grid, rows, cols });

    let overlay = null;
    if (isLinked) {
      overlay = document.createElement('div');
      overlay.className = 'lsc-resync-overlay';
      const btn = document.createElement('button');
      btn.className = 'lsc-resync-btn';
      btn.textContent = '↩ Re-sync';
      overlay.appendChild(btn);
      wrap.appendChild(overlay);
      if (labelBold.includes('(a)')) state.rowOverlayA = overlay;
      else state.rowOverlayB = overlay;
    }
    section.appendChild(wrap);

    for (const model of modelOrderFor(D)) {
      const info = MODEL_INFO[model];
      const minPt = findMin(D, model);
      const { lo, hi, emin } = R[model];

      const tile = document.createElement('div');
      tile.className = 'lsc-tile' + (model === HIGHLIGHT_MODEL ? ' lsc-tile-hot' : '');

      const hdr = document.createElement('div'); hdr.className = 'lsc-tile-hdr';
      const nm = document.createElement('span'); nm.className = 'lsc-model-name'; nm.textContent = info.label;
      const badge = document.createElement('span'); badge.className = 'lsc-badge';
      badge.textContent = badgeText(D, model, null, minPt);
      hdr.append(nm, badge); tile.appendChild(hdr);

      const cw = document.createElement('div'); cw.className = 'lsc-canvas-wrap';
      cw.style.aspectRatio = `${D.grid_shape[1]} / ${D.grid_shape[0]}`;
      const hmCanvas = document.createElement('canvas'); hmCanvas.className = 'lsc-hm';
      const ovCanvas = document.createElement('canvas'); ovCanvas.className = 'lsc-ov';
      cw.append(hmCanvas, ovCanvas); tile.appendChild(cw);

      const foot = document.createElement('div'); foot.className = 'lsc-tile-foot';
      const cbLo = document.createElement('span'); cbLo.className = 'lsc-cb-lo';
      cbLo.textContent = info.dist ? lo.toFixed(1) : (lo + (emin ?? 0)).toFixed(2);
      const cbBar = document.createElement('canvas'); cbBar.className = 'lsc-cb';
      const cbHi = document.createElement('span'); cbHi.className = 'lsc-cb-hi';
      cbHi.textContent = info.dist ? hi.toFixed(1) : (hi + (emin ?? 0)).toFixed(2);
      foot.append(cbLo, cbBar, cbHi); tile.appendChild(foot);

      grid.appendChild(tile);
      renderHeatmap(hmCanvas, D, R, model);
      requestAnimationFrame(() => renderColorbar(cbBar, R, model));

      tiles[model] = { hmCanvas, ovCanvas, ovCtx: ovCanvas.getContext('2d'), minPt, cbBar, badge };
      wirePointer(ovCanvas, D, selectFn);
    }

    return { section, overlay };
  }

  // Pointer: click + drag to select (live per tick), commit on release. Hover
  // shows a value tooltip.
  function wirePointer(ovCanvas, D, selectFn) {
    let dragging = false;
    ovCanvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { ovCanvas.setPointerCapture(e.pointerId); } catch { /* synthetic/stale pointer */ }
      const { row, col } = canvasToRowCol(e, ovCanvas, D.grid_shape);
      selectFn(row, col, true);
    });
    ovCanvas.addEventListener('pointermove', (e) => {
      const { row, col } = canvasToRowCol(e, ovCanvas, D.grid_shape);
      if (dragging) { selectFn(row, col, true); return; }
      // hover tooltip
      const [, nc] = D.grid_shape;
      const v = D.energies; // any model; use first present for the cell readout
      const model = modelOrderFor(D)[0];
      const raw = v[model]?.[row * nc + col];
      if (raw === null || raw === undefined) { tooltip.style.display = 'none'; return; }
      const x1 = D.x_vals[col], y2 = D.y_vals[row];
      tooltip.innerHTML = `x=${x1?.toFixed(4) ?? '—'} y=${y2?.toFixed(4) ?? '—'}`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${e.clientX + 12}px`;
      tooltip.style.top = `${e.clientY - 8}px`;
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { ovCanvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      const { row, col } = canvasToRowCol(e, ovCanvas, D.grid_shape);
      selectFn(row, col, false); // gesture end -> full commit
    };
    ovCanvas.addEventListener('pointerup', end);
    ovCanvas.addEventListener('pointercancel', end);
    ovCanvas.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });
  }

  // ── Adaptive tile sizing ─────────────────────────────────────────────────
  // Each tile keeps its dataset's own grid aspect ratio ("square" cells —
  // width/height following grid_shape, not literally 1:1), but the SIZE is
  // driven by the available space in BOTH axes, not just by how wide the
  // pane happens to be: dragging the split view taller (e.g. while docked to
  // the bottom, see docs/ui/panels/SideDock.js) grows the tiles, a shorter
  // pane shrinks them. A row also isn't forced to stay a single line — in a
  // narrow ("portrait") pane a full-width row of N tiles would be squeezed
  // tiny, so the layout tries every column count from N (one row) down to 1
  // (fully stacked) and keeps whichever yields the biggest tile, wrapping
  // into fewer, taller columns once that's a better use of the space than a
  // single cramped row. Applied via an explicit pixel grid-template-columns,
  // overriding the CSS default (repeat(auto-fit,minmax(118px,1fr)), which is
  // purely width-driven and ignores the pane's height entirely).
  const MIN_TILE_PX = 64;

  function applyTileSizing() {
    const grids = state.tileGrids;
    if (!grids.length) return;

    const containerStyle = getComputedStyle(container);
    const containerPad = parseFloat(containerStyle.paddingTop) + parseFloat(containerStyle.paddingBottom);
    const containerGap = (parseFloat(containerStyle.rowGap) || 0) * Math.max(0, container.children.length - 1);
    const availableHeight = container.clientHeight - containerPad - containerGap;

    // Everything currently on screen that ISN'T a tile grid (the load
    // button, row labels, inter-row gaps, the info panel) — measured live
    // off the real DOM rather than assumed, so this has no hardcoded
    // knowledge of the surrounding chrome and stays correct if it changes.
    let contentHeight = 0;
    for (const child of container.children) contentHeight += child.getBoundingClientRect().height;
    const gridsHeight = grids.reduce((sum, g) => sum + g.grid.getBoundingClientRect().height, 0);
    const chromeHeight = contentHeight - gridsHeight;

    const perGridHeight = Math.max(MIN_TILE_PX, (availableHeight - chromeHeight) / grids.length);

    for (const g of grids) {
      const n = g.grid.children.length;
      if (!n) continue;
      const gap = parseFloat(getComputedStyle(g.grid).columnGap) || 0;
      const gridWidth = g.grid.clientWidth;
      const aspect = g.cols / g.rows; // canvas width/height at "square" (data-shaped) sizing

      // Per-tile chrome (header + footer + padding) around the canvas
      // itself, needed to convert a row-height budget into a canvas size —
      // measured live off whatever's currently on screen.
      const sampleTile = g.grid.children[0];
      const sampleCanvas = sampleTile.querySelector('.lsc-canvas-wrap');
      const tileChrome = sampleCanvas
        ? sampleTile.getBoundingClientRect().height - sampleCanvas.getBoundingClientRect().height
        : 0;

      let best = { cols: n, size: MIN_TILE_PX };
      for (let cols = n; cols >= 1; cols--) {
        const rows = Math.ceil(n / cols);
        const widthPerTile = (gridWidth - gap * (cols - 1)) / cols;
        const heightPerRow = (perGridHeight - gap * (rows - 1)) / rows;
        const size = Math.min(widthPerTile, (heightPerRow - tileChrome) * aspect);
        if (size > best.size) best = { cols, size };
      }

      g.grid.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.max(MIN_TILE_PX, best.size)}px)`;
    }
  }

  // ── Re-fit overlays + colorbars after a size / theme change ────────────
  function refitAll() {
    if (state.mode === 'linked') {
      renderLinkedOverlays();
      for (const m of modelOrderFor(state.A)) if (state.linkTiles.A[m]) renderColorbar(state.linkTiles.A[m].cbBar, state.RA, m);
      for (const m of modelOrderFor(state.B)) if (state.linkTiles.B[m]) renderColorbar(state.linkTiles.B[m].cbBar, state.RB, m);
    } else if (state.mode === 'independent') {
      renderIndepOverlays();
      for (const row of state.rows) {
        for (const m of modelOrderFor(row.D)) if (row.tiles[m]) renderColorbar(row.tiles[m].cbBar, row.R, m);
      }
    }
  }

  // ── Public: structure switched underneath the addon ────────────────────
  function onStructureChange() {
    // Drop the cached map; it's rebuilt lazily against the new active structure
    // on the next drive (with the same canonical reference base coords).
    state.mappedSig = null;
    state.atomMap = null;
  }

  // ── Public: teardown ───────────────────────────────────────────────────
  function destroy() {
    ro.disconnect();
    if (unsubTheme) unsubTheme();
    for (const { zone, onDragOver, onDragLeave, onDrop } of dropHandlers) {
      zone.removeEventListener('dragover', onDragOver);
      zone.removeEventListener('dragleave', onDragLeave);
      zone.removeEventListener('drop', onDrop);
    }
    loadLabel.remove();
    tooltip.remove();
    removeStyles();
  }

  return { onStructureChange, destroy };
}
