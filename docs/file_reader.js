
import { parsePOSCAR } from './crystal-viewer.js';

function loadCIF(content, isDefault = false) {
  try {
    structureData = parsePOSCAR(content);
    setStatus(`Loaded: ${structureData.elements.length} atoms`);

    document.getElementById('structureControls').style.display = 'block';
    document.getElementById('bondControlsGroup').style.display = 'block';

    createBondLengthControls();
    updateVisualization();
    resetView();

    renderComposition();
    clearMeasure();
    resetView();

  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  }
}


function parseCIF(content) {
  // --- Config (tweak as needed) ---
  const OCC_THRESHOLD = 0.5;   // skip atoms with occupancy < this threshold
  const DEDUP_TOL     = 1e-5;  // tolerance for de-duplication in fractional coords
  const WRAP_TO_UNIT  = true;  // wrap fractional coordinates into [0,1)

  // --- Helpers ---
  function stripUncertainty(s) { return String(s).replace(/\([^)]+\)/g, ''); }
  function num(s) {
    const x = parseFloat(stripUncertainty(s));
    if (Number.isNaN(x)) throw new Error("Failed to parse number: " + s);
    return x;
  }
  function deg2rad(d){ return d * Math.PI / 180; }
  function buildLatticeVectors(a, b, c, alphaDeg, betaDeg, gammaDeg) {
    const alpha = deg2rad(alphaDeg), beta = deg2rad(betaDeg), gamma = deg2rad(gammaDeg);
    const cosA = Math.cos(alpha), cosB = Math.cos(beta), cosG = Math.cos(gamma);
    const sinG = Math.sin(gamma);
    const ax = a, ay = 0, az = 0;
    const bx = b * cosG, by = b * sinG, bz = 0;
    const cx = c * cosB;
    const cy = c * (cosA - cosB * cosG) / (sinG || 1e-15);
    const cz = Math.sqrt(Math.max(0, c*c - cx*cx - cy*cy));
    return [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ];
  }
  function guessElementFromLabel(label) {
    const m = String(label).trim().match(/^([A-Z][a-z]?)/);
    return m ? m[1] : String(label).trim();
  }
  function splitCifRow(line) {
    const tokens = [];
    let cur = '';
    let inSQ = false, inDQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inSQ) {
        if (ch === "'" ) { inSQ = false; tokens.push(cur); cur=''; }
        else cur += ch;
      } else if (inDQ) {
        if (ch === '"' ) { inDQ = false; tokens.push(cur); cur=''; }
        else cur += ch;
      } else {
        if (ch === "'") inSQ = true;
        else if (ch === '"') inDQ = true;
        else if (/\s/.test(ch)) { if (cur !== '') { tokens.push(cur); cur=''; } }
        else cur += ch;
      }
    }
    if (cur !== '') tokens.push(cur);
    return tokens;
  }
  function parseLoops(lines) {
    const loops = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*loop_/i.test(lines[i])) continue;
      let j = i + 1;
      const headers = [];
      for (; j < lines.length; j++) {
        const t = lines[j].trim();
        if (/^_/.test(t)) headers.push(t.split(/\s+/)[0]);
        else break;
      }
      const rows = [];
      for (; j < lines.length; j++) {
        const L = lines[j];
        if (/^\s*$/.test(L)) break;
        if (/^\s*loop_/i.test(L)) break;
        if (/^\s*_/.test(L)) break;
        const toks = splitCifRow(L.trim());
        if (toks.length > 0) rows.push(toks);
      }
      if (headers.length && rows.length) loops.push({ headers, rows });
    }
    return loops;
  }
  function normalizeFrac(frac) {
    return frac.map(v => {
      let w = v % 1;
      if (w < 0) w += 1;
      return w;
    });
  }
  function det3(m){
    return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
         - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
         + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  }
  function inv3(m){
    const d = det3(m) || 1e-30;
    return [
      [
        (m[1][1]*m[2][2]-m[1][2]*m[2][1])/d,
        (m[0][2]*m[2][1]-m[0][1]*m[2][2])/d,
        (m[0][1]*m[1][2]-m[0][2]*m[1][1])/d
      ],
      [
        (m[1][2]*m[2][0]-m[1][0]*m[2][2])/d,
        (m[0][0]*m[2][2]-m[0][2]*m[2][0])/d,
        (m[0][2]*m[1][0]-m[0][0]*m[1][2])/d
      ],
      [
        (m[1][0]*m[2][1]-m[1][1]*m[2][0])/d,
        (m[0][1]*m[2][0]-m[0][0]*m[2][1])/d,
        (m[0][0]*m[1][1]-m[0][1]*m[1][0])/d
      ]
    ];
  }
  function matVec(m, v){ return [
    m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
    m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
    m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2],
  ]; }

  // --- Symmetry operations (parser avoids eval) ---
  function parseRational(str) {
    const s = String(str).trim();
    if (/^[+-]?\d+\/\d+$/.test(s)) {
      const [p, q] = s.split('/').map(Number);
      return p / q;
    }
    return parseFloat(s);
  }
  function parseSymComponent(comp) {
    // Returns linear map: f = cx*x + cy*y + cz*z + c0
    let s = String(comp).trim();
    s = s.replace(/['"]/g, '').replace(/\s+/g, '');
    s = s.replace(/\u2212/g, '-'); // unicode minus protection
    s = s.replace(/-/g, '+-');
    const parts = s.split('+').filter(Boolean);
    let cx = 0, cy = 0, cz = 0, c0 = 0;
    for (const part of parts) {
      if (/^[+-]?x$/.test(part)) { cx += (part[0] === '-' ? -1 : 1); continue; }
      if (/^[+-]?y$/.test(part)) { cy += (part[0] === '-' ? -1 : 1); continue; }
      if (/^[+-]?z$/.test(part)) { cz += (part[0] === '-' ? -1 : 1); continue; }
      if (/^[+-]?\d+(?:\/\d+)?(?:\.\d+)?$/.test(part)) {
        const val = parseRational(part);
        if (!Number.isNaN(val)) c0 += val;
        continue;
      }
      const m = part.match(/^([+-]?\d+(?:\/\d+)?)(x|y|z)$/);
      if (m) {
        const val = parseRational(m[1]);
        if (m[2] === 'x') cx += val;
        else if (m[2] === 'y') cy += val;
        else cz += val;
        continue;
      }
      // Unknown token — ignore (CIF symops are typically simple linear terms)
      // console.warn('Unrecognized symop term:', part, 'in component', comp);
    }
    c0 = ((c0 % 1) + 1) % 1;
    return { cx, cy, cz, c0 };
  }
  function makeSymOp(expr) {
    const parts = String(expr).trim().replace(/['"]/g, '').split(/\s*,\s*/);
    const [px, py, pz] = [0,1,2].map(i => parseSymComponent(parts[i] || 'x,y,z'.split(',')[i]));
    return function(frac) {
      const x = frac[0], y = frac[1], z = frac[2];
      return [
        px.cx*x + px.cy*y + px.cz*z + px.c0,
        py.cx*x + py.cy*y + py.cz*z + py.c0,
        pz.cx*x + pz.cy*y + pz.cz*z + pz.c0
      ];
    };
  }
  function parseSymOpsFromLoops(loops) {
    const candidates = [
      '_space_group_symop_operation_xyz',
      '_symmetry_equiv_pos_as_xyz'
    ];
    for (const loop of loops) {
      for (const cand of candidates) {
        const idx = loop.headers.findIndex(h => h.toLowerCase() === cand.toLowerCase());
        if (idx !== -1) {
          const ops = [];
          for (const row of loop.rows) {
            const val = row[idx] ?? row[row.length - 1];
            if (val) ops.push(makeSymOp(val));
          }
          if (ops.length) return ops;
        }
      }
    }
    return []; // none found
  }

  // --- Main parsing ---
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const loops = parseLoops(lines);

  // Cell parameters
  const getTag = (tag) => {
    const re = new RegExp('^\\s*' + tag + '\\s+(.+)$', 'i');
    for (const line of lines) {
      const m = line.match(re);
      if (m) return m[1].trim();
    }
    return null;
  };
  const a = num(getTag('_cell_length_a') || 'NaN');
  const b = num(getTag('_cell_length_b') || 'NaN');
  const c = num(getTag('_cell_length_c') || 'NaN');
  const alpha = num(getTag('_cell_angle_alpha') || '90');
  const beta  = num(getTag('_cell_angle_beta')  || '90');
  const gamma = num(getTag('_cell_angle_gamma') || '90');

  // Lattice vectors (rows: a, b, c)
  const lattice = buildLatticeVectors(a, b, c, alpha, beta, gamma);

  // Find atom loop
  let header = [];
  let rows = [];
  for (const loop of loops) {
    const hasFrac = loop.headers.some(h => /_atom_site_fract_x/i.test(h));
    const hasCart = loop.headers.some(h => /_atom_site_Cartn_x/i.test(h));
    if (!(hasFrac || hasCart)) continue;
    header = loop.headers;
    rows = loop.rows;
    break;
  }
  if (!header.length || !rows.length) {
    throw new Error("No _atom_site_ loop with fractional or Cartesian coordinates found.");
  }

  // Column indices
  const idx = (cands) => {
    for (const n of cands) {
      const k = header.findIndex(h => h.toLowerCase() === n.toLowerCase());
      if (k !== -1) return k;
    }
    return -1;
  };
  const ix = idx(['_atom_site_fract_x', '_atom_site_Cartn_x']);
  const iy = idx(['_atom_site_fract_y', '_atom_site_Cartn_y']);
  const iz = idx(['_atom_site_fract_z', '_atom_site_Cartn_z']);
  if (ix === -1 || iy === -1 || iz === -1) {
    throw new Error("Atom site loop missing x/y/z columns.");
  }
  const itype = idx(['_atom_site_type_symbol', '_atom_site_label', '_atom_site_type']);
  const ilabel = idx(['_atom_site_label', '_atom_site_type_symbol', '_atom_site_type']);
  const iocc   = idx(['_atom_site_occupancy']);

  // Build conversion matrices
  const M = [
    [lattice[0][0], lattice[1][0], lattice[2][0]],
    [lattice[0][1], lattice[1][1], lattice[2][1]],
    [lattice[0][2], lattice[1][2], lattice[2][2]],
  ];
  const Minv = inv3(M);
  const fracMode = header[ix].toLowerCase().includes('fract_');

  // Asymmetric unit atoms with occupancy filter
  const asymAtoms = [];
  for (const r of rows) {
    const x = num(r[ix]), y = num(r[iy]), z = num(r[iz]);
    const occ = (iocc !== -1) ? num(r[iocc]) : 1.0;
    if (!(occ >= OCC_THRESHOLD)) continue;

    let el = 'X';
    if (itype !== -1) el = r[itype];
    else if (ilabel !== -1) el = guessElementFromLabel(r[ilabel]);

    let f = fracMode ? [x, y, z] : matVec(Minv, [x, y, z]);
    if (WRAP_TO_UNIT) f = normalizeFrac(f);
    asymAtoms.push({ el, f });
  }

  // Symmetry expansion
  let symOps = parseSymOpsFromLoops(loops);
  if (!symOps.length) symOps = [f => f]; // identity if none

  const expanded = [];
  for (const a0 of asymAtoms) {
    for (const op of symOps) {
      let f2 = op(a0.f);
      if (WRAP_TO_UNIT) f2 = normalizeFrac(f2);
      expanded.push({ el: a0.el, f: f2 });
    }
  }

  // De-duplicate (by element + fractional coords within tolerance)
  const scale = 1 / Math.max(1e-12, DEDUP_TOL);
  const keyFrac = (f) => f.map(v => Math.round((((v % 1)+1)%1) * scale)).join(',');
  const seen = new Set();
  const unique = [];
  for (const a of expanded) {
    const k = a.el + ':' + keyFrac(a.f);
    if (!seen.has(k)) { seen.add(k); unique.push(a); }
  }

  // Output arrays
  const positions = unique.map(a => a.f);
  const elements  = unique.map(a => a.el);

  // Unique element line (order of first appearance)
  const uniqOrder = [];
  for (const el of elements) {
    if (!uniqOrder.includes(el)) uniqOrder.push(el);
  }
  const elementLine = uniqOrder.join(' ');

  return {
    lattice,        // [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]  (Å)
    elements,       // ["C","C","O",...], length == positions.length
    positions,      // [[fx,fy,fz], ...], fractional in [0,1)
    uniqueElements: elementLine // "C O ..."
  };
}



