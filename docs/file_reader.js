
import { parsePOSCAR } from './crystal-viewer.js';

function loadCIF(content, isDefault = false) {
  try {
    structureData = parseCIF(content);
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
export { loadCIF };  
};

function parseCIF(content) {
  // --- Utilities -------------------------------------------------------------

  const toRad = (deg) => (deg * Math.PI) / 180.0;
  const clamp01 = (v) => {
    // wrap into [0,1)
    const u = v - Math.floor(v);
    // deal with near-1 due to floating noise
    return u >= 1 - 1e-10 ? 0 : (u < 0 ? u + 1 : u);
  };
  const roundN = (x, n = 8) => Math.round(x * Math.pow(10, n)) / Math.pow(10, n);
  const numOrNull = (s) => {
    if (s == null) return null;
    const cleaned = String(s).trim()
      .replace(/^[\'\"]|[\'\"]$/g, '')      // strip quotes
      .replace(/\([^\)]*\)/g, '')           // strip uncertainties: 1.234(5)
      .replace(/^\s+|\s+$/g, '');
    if (!cleaned) return null;
    const v = Number(cleaned);
    return Number.isFinite(v) ? v : null;
  };
  const stripQuotes = (s) => String(s || '').trim().replace(/^[\'\"]|[\'\"]$/g, '');

  // Invert 3x3 (same layout as your POSCAR code)
  const invert3x3 = (m) => {
    const [a,b,c] = m;
    const A = a[0], B = a[1], C = a[2];
    const D = b[0], E = b[1], F = b[2];
    const G = c[0], H = c[1], I = c[2];
    const det = A*(E*I - F*H) - B*(D*I - F*G) + C*(D*H - E*G);
    const invDet = 1.0 / det;
    return [
      [(E*I - F*H)*invDet, (C*H - B*I)*invDet, (B*F - C*E)*invDet],
      [(F*G - D*I)*invDet, (A*I - C*G)*invDet, (C*D - A*F)*invDet],
      [(D*H - E*G)*invDet, (B*G - A*H)*invDet, (A*E - B*D)*invDet],
    ];
  };
  const matVec = (m, v) => ([
    m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
    m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
    m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2],
  ]);

  // Build lattice from a,b,c and alpha,beta,gamma (degrees)
  const cellToMatrix = (a, b, c, alphaDeg, betaDeg, gammaDeg) => {
    const alpha = toRad(alphaDeg);
    const beta  = toRad(betaDeg);
    const gamma = toRad(gammaDeg);

    const ax = a, ay = 0, az = 0;
    const bx = b * Math.cos(gamma);
    const by = b * Math.sin(gamma);
    const bz = 0;
    const cx = c * Math.cos(beta);
    const cy = c * (Math.cos(alpha) - Math.cos(beta)*Math.cos(gamma)) / Math.sin(gamma);
    const cz2 = c*c - cx*cx - cy*cy;
    const cz = Math.sqrt(Math.max(0, cz2));
    return [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ];
  };

  // Tokenize respecting quotes; return array of tokens from a line
  const tokenizeCIFLine = (line) => {
    const re = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\S+/g;
    const out = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      out.push(m[0]);
    }
    return out;
  };

  // Parse loops generically: returns an array of { headers: [...], rows: [[...], ...] }
  const parseLoops = (txt) => {
    const lines = txt.split(/\r?\n/);
    const loops = [];
    let i = 0;
    while (i < lines.length) {
      let line = lines[i].trim();
      if (!line || line.startsWith('#')) { i++; continue; }
      if (line.toLowerCase() === 'loop_') {
        i++;
        // collect headers
        const headers = [];
        while (i < lines.length) {
          const l = lines[i].trim();
          if (l.startsWith('_')) {
            headers.push(l.split(/\s+/)[0]); // header key
            i++;
          } else {
            break;
          }
        }
        // collect rows
        const rows = [];
        let buffer = [];
        const need = headers.length;
        const isTerminator = (s) => {
          const t = s.trim();
          return t.toLowerCase() === 'loop_' || t.startsWith('_') || t.toLowerCase().startsWith('data_');
        };
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) { i++; continue; }
          if (isTerminator(l)) break;
          const toks = tokenizeCIFLine(l);
          // accumulate tokens until multiples of headers.length
          for (const tk of toks) buffer.push(tk);
          while (buffer.length >= need && need > 0) {
            rows.push(buffer.slice(0, need));
            buffer = buffer.slice(need);
          }
          i++;
        }
        loops.push({ headers, rows });
        continue;
      }
      i++;
    }
    return loops;
  };

  // Extract numeric tag value outside loops
  const extractNumberTag = (txt, tagRe) => {
    const re = new RegExp(`${tagRe.source}\\s+(.+)`, tagRe.flags);
    const m = txt.match(re);
    if (!m) return null;
    const token = tokenizeCIFLine(m[1] || '')[0];
    return numOrNull(token);
  };

  // Extract string tag value outside loops
  const extractStringTag = (txt, tagRe) => {
    const re = new RegExp(`${tagRe.source}\\s+(.+)`, tagRe.flags);
    const m = txt.match(re);
    if (!m) return null;
    const token = tokenizeCIFLine(m[1] || '')[0];
    return stripQuotes(token);
  };

  // Guess element from label (e.g., "Si1", "C3A", "O_1")
  const guessElementFromLabel = (label) => {
    const s = stripQuotes(label || '');
    const m = s.match(/^([A-Z][a-z]?)/);
    if (!m) return s || 'X';
    return m[1];
  };

  // Normalize element symbol (e.g., 'si' -> 'Si')
  const normElem = (sym) => {
    const s = stripQuotes(sym || '').trim();
    if (!s) return 'X';
    return s[0].toUpperCase() + (s.slice(1).toLowerCase());
  };

  // Parse symmetry operations from loops into array of 'x,y,z' expressions
  const extractSymOps = (loops) => {
    let ops = [];
    for (const lp of loops) {
      const h = lp.headers.map(h => h.toLowerCase());
      let col = h.indexOf('_space_group_symop_operation_xyz');
      if (col === -1) col = h.indexOf('_symmetry_equiv_pos_as_xyz');
      if (col !== -1) {
        for (const row of lp.rows) {
          const val = stripQuotes(row[col] || '').trim();
          if (val) ops.push(val.toLowerCase());
        }
      }
    }
    // Fallback to identity
    if (ops.length === 0) ops = ['x,y,z'];
    return ops;
  };

  // Evaluate a symmetry expression "expr" on (x,y,z)
  // Supports patterns like: x,y,z ; -x+1/2 ; x+1/2 ; y+z? (rare) – but we assume terms are ±x, ±y, ±z and fractional offsets.
  const evalSymExpr = (expr, xyz) => {
    const clean = expr.replace(/\s+/g, '').toLowerCase();
    const parts = clean.split(',');
    if (parts.length !== 3) throw new Error(`Bad symmetry op: ${expr}`);
    const evalOne = (e) => {
      // transform " -x+1/4-y " into tokens by replacing '-' with '+-'
      const terms = e.replace(/-/g, '+-').split('+').filter(Boolean);
      let val = 0;
      for (let t of terms) {
        if (t === 'x') { val += xyz[0]; continue; }
        if (t === 'y') { val += xyz[1]; continue; }
        if (t === 'z') { val += xyz[2]; continue; }
        if (t === '-x') { val -= xyz[0]; continue; }
        if (t === '-y') { val -= xyz[1]; continue; }
        if (t === '-z') { val -= xyz[2]; continue; }
        // fraction or decimal constant
        const frac = t.match(/^([+-]?\d+)\s*\/\s*(\d+)$/);
        if (frac) {
          val += (parseInt(frac[1],10) / parseInt(frac[2],10));
          continue;
        }
        const num = Number(t);
        if (Number.isFinite(num)) { val += num; continue; }
        // Sometimes you might see like "+y" already handled; anything else is out of scope
        throw new Error(`Unsupported symmetry term: "${t}" in "${expr}"`);
      }
      return clamp01(val);
    };
    return [evalOne(parts[0]), evalOne(parts[1]), evalOne(parts[2])];
  };

  // Deduplicate fractional positions within tolerance
  const dedupPositions = (positions, elements, tol = 1e-6) => {
    const seen = new Map(); // key -> index
    const outPos = [];
    const outElm = [];
    const keyOf = (p, e) => {
      // include element to keep species-separated uniqueness
      const k = `${e}|${roundN(p[0], 6)},${roundN(p[1], 6)},${roundN(p[2], 6)}`;
      return k;
    };
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const e = elements[i];
      const k = keyOf(p, e);
      if (!seen.has(k)) {
        seen.set(k, outPos.length);
        outPos.push(p);
        outElm.push(e);
      }
    }
    return { positions: outPos, elements: outElm };
  };

  // --- Extract meta and cell -------------------------------------------------

  const txt = content; // keep as is for regex tags
  const dataBlock = (txt.match(/^\s*data_([^\s]+)/mi) || [null, null])[1];
  const chemName  = extractStringTag(txt, /_chemical_name_common/i) ||
                    extractStringTag(txt, /_chemical_name_systematic/i) ||
                    extractStringTag(txt, /_chemical_formula_sum/i);
  const comment = chemName || dataBlock || 'CIF structure';

  // Cell parameters
  const a = extractNumberTag(txt, /_cell_length_a/i);
  const b = extractNumberTag(txt, /_cell_length_b/i);
  const c = extractNumberTag(txt, /_cell_length_c/i);
  const alpha = extractNumberTag(txt, /_cell_angle_alpha/i);
  const beta  = extractNumberTag(txt, /_cell_angle_beta/i);
  const gamma = extractNumberTag(txt, /_cell_angle_gamma/i);

  if ([a,b,c,alpha,beta,gamma].some(v => v == null || !Number.isFinite(v))) {
    throw new Error('Missing or invalid cell parameters in CIF (a,b,c,alpha,beta,gamma).');
  }

  const lattice = cellToMatrix(a, b, c, alpha, beta, gamma);
  const invLat = invert3x3(lattice);

  // --- Parse loops for atom sites & symmetry --------------------------------

  const loops = parseLoops(txt);
  const symOps = extractSymOps(loops);

  // Find atom_site loop (prefer fractional)
  let atomLoop = null;
  let idxX = -1, idxY = -1, idxZ = -1, idxCX = -1, idxCY = -1, idxCZ = -1;
  let idxType = -1, idxLabel = -1, idxOcc = -1;

  for (const lp of loops) {
    const h = lp.headers.map(h => h.toLowerCase());
    const fx = h.indexOf('_atom_site_fract_x');
    const fy = h.indexOf('_atom_site_fract_y');
    const fz = h.indexOf('_atom_site_fract_z');
    const cx = h.indexOf('_atom_site_cartn_x');
    const cy = h.indexOf('_atom_site_cartn_y');
    const cz = h.indexOf('_atom_site_cartn_z');
    if ((fx !== -1 && fy !== -1 && fz !== -1) || (cx !== -1 && cy !== -1 && cz !== -1)) {
      atomLoop = lp;
      idxX = fx; idxY = fy; idxZ = fz;
      idxCX = cx; idxCY = cy; idxCZ = cz;
      idxType = h.indexOf('_atom_site_type_symbol');
      idxLabel = h.indexOf('_atom_site_label');
      idxOcc = h.indexOf('_atom_site_occupancy');
      break;
    }
  }

  if (!atomLoop) {
    throw new Error('No _atom_site loop with fractional or Cartesian coordinates found in CIF.');
  }

  // Read asymmetric unit
  const asymElements = [];
  const asymPositionsFrac = [];

  for (const row of atomLoop.rows) {
    // element symbol
    let elem = 'X';
    if (idxType !== -1) {
      elem = normElem(row[idxType]);
    } else if (idxLabel !== -1) {
      elem = normElem(guessElementFromLabel(row[idxLabel]));
    }

    // occupancy (optional)
    let occ = 1.0;
    if (idxOcc !== -1) {
      const o = numOrNull(row[idxOcc]);
      if (Number.isFinite(o)) occ = o;
    }
    if (!(occ > 0)) continue; // skip non-occupied

    // coordinates
    let fx, fy, fz;
    if (idxX !== -1 && idxY !== -1 && idxZ !== -1) {
      fx = numOrNull(row[idxX]); fy = numOrNull(row[idxY]); fz = numOrNull(row[idxZ]);
      if ([fx,fy,fz].some(v => v == null)) continue;
    } else {
      // Cartesian -> fractional
      const cx = numOrNull(row[idxCX]);
      const cy = numOrNull(row[idxCY]);
      const cz = numOrNull(row[idxCZ]);
      if ([cx,cy,cz].some(v => v == null)) continue;
      const frac = matVec(invert3x3(lattice), [cx,cy,cz]);
      fx = frac[0]; fy = frac[1]; fz = frac[2];
    }

    asymElements.push(elem);
    asymPositionsFrac.push([clamp01(fx), clamp01(fy), clamp01(fz)]);
  }

  // Expand by symmetry
  const expandedPositions = [];
  const expandedElements  = [];
  for (let i = 0; i < asymPositionsFrac.length; i++) {
    const p = asymPositionsFrac[i];
    const e = asymElements[i];
    for (const op of symOps) {
      try {
        const q = evalSymExpr(op, p);
        expandedPositions.push(q);
        expandedElements.push(e);
      } catch (_err) {
        // If a rare/unsupported symmetry term occurs, skip that op for this atom
        // (most CIFs use ±x,±y,±z with fractional shifts)
      }
    }
  }

  // Deduplicate symmetry-generated duplicates within tolerance
  const { positions, elements } = dedupPositions(expandedPositions, expandedElements, 1e-6);

  // Compute uniqueElements in order of first appearance
  const uniqueElements = [];
  const seenElem = new Set();
  for (const e of elements) {
    if (!seenElem.has(e)) { seenElem.add(e); uniqueElements.push(e); }
  }

  return {
    comment,
    lattice,          // 3x3 Cartesian lattice vectors (Å)
    elements,         // per-atom element symbols, aligned with positions
    positions,        // fractional coordinates in [0,1)
    uniqueElements,   // unique species in first-seen order
  };
}

