// --- QE input (.pw.in) parser: lattice + positions (fractional), species ---
// Supported: ibrav=0 with explicit CELL_PARAMETERS, ATOMIC_POSITIONS
// Units handled: angstrom, bohr, alat (needs celldm(1) or A)

// USAGE: const parsed = parsePWSCF(pwInText);

export function parsePWSCF(content) {
  if (!content || typeof content !== 'string') throw new Error('PWSCF: content must be string');
  const lines = content.split(/\r?\n/);

  const comment = (findTitle(lines) || 'PWscf Structure');

  // Read SYSTEM namelist for celldm(1) or A
  const sys = parseSystemNamelist(lines);
  const alatBohr = sys.celldm1 ?? (sys.A ? sys.A / BOHR_TO_ANG : undefined); // in Bohr

  // CELL_PARAMETERS
  const cell = parseCellParametersIn(lines, alatBohr);
  if (!cell) throw new Error('PWSCF: missing or invalid CELL_PARAMETERS');
  const lattice = cell; // already in Å

  // ATOMIC_SPECIES (unique element labels)
  const uniqueElements = parseAtomicSpecies(lines);
  // ATOMIC_POSITIONS
  const { elements, positionsFrac } = parseAtomicPositionsIn(lines, lattice, alatBohr);

  return {
    comment,
    lattice,
    elements,
    positions: positionsFrac.map(p => p.map(normalize01)),
    uniqueElements
  };
}

/* ---------------- helpers (PW input) ---------------- */

const BOHR_TO_ANG = 0.529177210903; // Å per Bohr

function findTitle(lines) {
  const start = findNamelistStart(lines, '&CONTROL');
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const s = lines[i];
    if (/^\s*\//.test(s)) break;
    const m = s.match(/\btitle\s*=\s*'"['"]/i);
    if (m) return m[1].trim();
  }
  return null;
}

function parseSystemNamelist(lines) {
  const out = {};
  const start = findNamelistStart(lines, '&SYSTEM');
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i++) {
    const s = lines[i];
    if (/^\s*\//.test(s)) break;
    let m = s.match(/\bcelldm\s*\(\s*1\s*\)\s*=\s*([-\d.+EeDd]+)/i);
    if (m) out.celldm1 = parseFortranFloat(m[1]); // Bohr
    m = s.match(/\bA\s*=\s*([-\d.+EeDd]+)/i);
    if (m) out.A = parseFortranFloat(m[1]); // Å
  }
  return out;
}

function parseCellParametersIn(lines, alatBohr) {
  // Find last CELL_PARAMETERS block
  let idx = -1, unit = 'bohr';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*CELL_PARAMETERS\s*(?:\(\s*([A-Za-z]+)\s*\))?/i);
    if (m) { idx = i; unit = (m[1] || 'bohr').toLowerCase(); }
  }
  if (idx < 0) return null;

  const M = [];
  for (let r = 1; r <= 3; r++) {
    const n = (lines[idx + r] || '').trim().split(/\s+/).slice(0, 3).map(parseFortranFloat);
    if (n.length < 3 || !n.every(Number.isFinite)) return null;
    M.push(n);
  }

  let scale = 1.0;
  if (unit === 'angstrom' || unit === 'ang') scale = 1.0;
  else if (unit === 'bohr') scale = BOHR_TO_ANG;
  else if (unit === 'alat') {
    if (!Number.isFinite(alatBohr)) {
      throw new Error('PWSCF: CELL_PARAMETERS(alat) requires celldm(1) or A in &SYSTEM');
    }
    scale = alatBohr * BOHR_TO_ANG;
  } else {
    // be lenient: default to Bohr if unknown
    scale = BOHR_TO_ANG;
  }

  return M.map(row => row.map(v => v * scale));
}

function parseAtomicSpecies(lines) {
  const idx = lines.findIndex(l => /^\s*ATOMIC_SPECIES\b/i.test(l));
  if (idx < 0) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const s = lines[i];
    if (!s.trim()) break;
    if (/^[A-Z]/i.test(s) === false) break;
    // expected: "Fe  55.845 Fe.upf"
    const tok = s.trim().split(/\s+/);
    if (tok.length < 1) break;
    const sym = tok[0];
    if (/^[A-Za-z][a-z]?$/.test(sym) && !out.includes(sym)) out.push(sym);
    // stop when we hit another card header
    if (/^\s*(ATOMIC_POSITIONS|K_POINTS|CELL_PARAMETERS|&|!)/i.test(lines[i + 1] || '')) break;
  }
  return out;
}

function parseAtomicPositionsIn(lines, latticeAng, alatBohr) {
  // Find last ATOMIC_POSITIONS block
  let idx = -1, unit = 'bohr';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*ATOMIC_POSITIONS\s*(?:\(\s*([A-Za-z_]+)\s*\))?/i);
    if (m) { idx = i; unit = (m[1] || 'bohr').toLowerCase(); }
  }
  if (idx < 0) throw new Error('PWSCF: missing ATOMIC_POSITIONS');

  const elements = [];
  const posRaw = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const s = lines[i];
    if (!s.trim()) break;
    if (/^\s*[A-Za-z]/.test(s) === false) break;
    const tok = s.trim().split(/\s+/);
    if (tok.length < 4) break;
    const el = tok[0];
    const xyz = tok.slice(1, 4).map(parseFortranFloat);
    if (xyz.some(x => !Number.isFinite(x))) break;
    elements.push(el);
    posRaw.push(xyz);
    // stop at next card
    if (/^\s*(K_POINTS|CELL_PARAMETERS|ATOMIC_FORCES|&|!)/i.test(lines[i + 1] || '')) break;
  }

  let cartAng = null;
  if (unit.startsWith('crystal')) {
    // fractional already
    const frac = posRaw.map(v => v.map(Number));
    return { elements, positionsFrac: frac };
  } else if (unit === 'angstrom' || unit === 'ang') {
    cartAng = posRaw;
  } else if (unit === 'bohr') {
    cartAng = posRaw.map(v => v.map(x => x * BOHR_TO_ANG));
  } else if (unit === 'alat') {
    if (!Number.isFinite(alatBohr)) {
      throw new Error('PWSCF: ATOMIC_POSITIONS(alat) requires celldm(1) or A in &SYSTEM');
    }
    const scale = alatBohr * BOHR_TO_ANG;
    cartAng = posRaw.map(v => v.map(x => x * scale));
  } else {
    // default to Bohr if unknown
    cartAng = posRaw.map(v => v.map(x => x * BOHR_TO_ANG));
  }

  const invLT = invert33(transpose33(latticeAng));
  const positionsFrac = cartAng.map(c => mulMatVec(invLT, c));
  return { elements, positionsFrac };
}

function findNamelistStart(lines, name) {
  for (let i = 0; i < lines.length; i++) if (new RegExp(`^\\s*${name}\\b`, 'i').test(lines[i])) return i;
  return -1;
}

function parseFortranFloat(s) {
  return parseFloat(String(s).replace(/d/gi, 'e'));
}

/* --- small linear algebra --- */
function transpose33(m) { return [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]]; }
function invert33(m) {
  const [[a,b,c],[d,e,f],[g,h,i]] = m;
  const A=e*i-f*h, B=-(d*i-f*g), C=d*h-e*g;
  const D=-(b*i-c*h), E=a*i-c*g, F=-(a*h-b*g);
  const G=b*f-c*e, H=-(a*f-c*d), I=a*e-b*d;
  const det=a*A+b*B+c*C; if (Math.abs(det) < 1e-20) throw new Error('Singular cell');
  const inv=1/det;
  return [[A*inv,D*inv,G*inv],[B*inv,E*inv,H*inv],[C*inv,F*inv,I*inv]];
}
function mulMatVec(m,v){ return [m[0][0]*v[0]+m[0][1]*v[1]+m[0][2]*v[2], m[1][0]*v[0]+m[1][1]*v[1]+m[1][2]*v[2], m[2][0]*v[0]+m[2][1]*v[1]+m[2][2]*v[2]]; }
function normalize01(x){ const y=x-Math.floor(x); return y>=1?y-1:(y<0?y+1:y); }




// --- QE output (.pw.out) parser: last cell + last positions + per-atom magnetization vectors ---

export function parsePWSCFOUT(content) {
  if (!content || typeof content !== 'string') throw new Error('PWSCFOUT: content must be string');
  const lines = content.split(/\r?\n/);

  // 1) CELL (Å)
  let lattice = parseCellFromOut(lines);
  if (!lattice) throw new Error('PWSCFOUT: could not find last CELL_PARAMETERS or crystal axes');
  // 2) ATOMIC_POSITIONS -> fractional
  const at = parseAtomicPositionsOut(lines, lattice);
  const elements = at.elements;
  const positions = at.positionsFrac.map(p => p.map(normalize01));
  const uniqueElements = Array.from(new Set(elements));

  // 3) Magnetization vectors per atom (array of {atomIndex, vector, scalingFactor, color})
  const magnetization = parseQEMagnetizationVectors(lines, elements.length);

  return {
    comment: 'PWscf Structure',
    lattice,
    elements,
    positions,
    uniqueElements,
    magnetization
  };
}

/* ---------------- helpers (PW output) ---------------- */

function parseCellFromOut(lines) {
  // Try last CELL_PARAMETERS (...) first
  let idx = -1, unit = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*CELL_PARAMETERS\s*\(\s*([A-Za-z]+)\s*\)/i);
    if (m) { idx = i; unit = m[1].toLowerCase(); }
  }
  if (idx >= 0) {
    const M = [];
    for (let r = 1; r <= 3; r++) {
      const row = (lines[idx + r] || '').trim().split(/\s+/).slice(0,3).map(parseFortranFloat);
      if (row.length < 3 || !row.every(Number.isFinite)) return null;
      M.push(row);
    }
    let scale = 1.0;
    if (unit === 'angstrom' || unit === 'ang') scale = 1.0;
    else if (unit === 'bohr') scale = BOHR_TO_ANG;
    else if (unit === 'alat') {
      // find last "lattice parameter (alat) = X a.u."
      const alatBohr = findLastAlatBohr(lines);
      if (!Number.isFinite(alatBohr)) return null;
      scale = alatBohr * BOHR_TO_ANG;
    } else scale = 1.0;
    return M.map(r => r.map(v => v * scale));
  }

  // Fallback: "crystal axes: (cart. coord. in units of alat|a_0)" with a(1)=...
  let j = -1; let usesAlat = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*crystal axes:\s*\(cart\.\s*coord\.\s*in\s*units\s*of\s*(?:alat|a_0)\)/i.test(lines[i])) {
      j = i; usesAlat = /alat|a_0/i.test(lines[i]);
    }
  }
  if (j < 0) return null;
  const M = [];
  for (let r = 1; r <= 3; r++) {
    const m = (lines[j + r] || '').match(/\(\s*([-\d.+EeDd]+)\s+([-\d.+EeDd]+)\s+([-\d.+EeDd]+)\s*\)/);
    if (!m) return null;
    M.push([parseFortranFloat(m[1]), parseFortranFloat(m[2]), parseFortranFloat(m[3])]);
  }
  // scale: "units of alat (a.u.)" or "a_0 (Bohr)"
  const alatBohr = findLastAlatBohr(lines);
  if (!Number.isFinite(alatBohr)) return null;
  const scale = alatBohr * BOHR_TO_ANG;
  return M.map(r => r.map(v => v * scale));
}

function findLastAlatBohr(lines) {
  let val = NaN;
  for (const s of lines) {
    let m = s.match(/lattice parameter\s*\(alat\)\s*=\s*([-\d.+EeDd]+)/i);
    if (m) val = parseFortranFloat(m[1]); // in Bohr (a.u.)
  }
  // Alternative older style: celldm(1)=
  if (!Number.isFinite(val)) {
    for (const s of lines) {
      const m = s.match(/\bcelldm\s*\(\s*1\s*\)\s*=\s*([-\d.+EeDd]+)/i);
      if (m) val = parseFortranFloat(m[1]);
    }
  }
  return val;
}

function parseAtomicPositionsOut(lines, latticeAng) {
  // Find last ATOMIC_POSITIONS (...)
  let idx = -1, unit = 'bohr';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*ATOMIC_POSITIONS\s*\(\s*([A-Za-z_]+)\s*\)/i);
    if (m) { idx = i; unit = m[1].toLowerCase(); }
  }
  if (idx < 0) throw new Error('PWSCFOUT: missing ATOMIC_POSITIONS');
  const elems = [];
  const vals = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const s = lines[i];
    if (!s.trim()) break;
    if (/^\s*[A-Za-z]/.test(s) === false) break;
    const tok = s.trim().split(/\s+/);
    if (tok.length < 4) break;
    elems.push(tok[0]);
    vals.push(tok.slice(1,4).map(parseFortranFloat));
    if (/^\s*(K_POINTS|CELL_PARAMETERS|!|End|JOB DONE)/i.test(lines[i + 1] || '')) break;
  }

  if (unit.startsWith('crystal')) {
    return { elements: elems, positionsFrac: vals };
  } else {
    let cartAng = vals;
    if (unit === 'angstrom' || unit === 'ang') {
      cartAng = vals;
    } else if (unit === 'bohr') {
      cartAng = vals.map(v => v.map(x => x * BOHR_TO_ANG));
    } else if (unit === 'alat') {
      const alatBohr = findLastAlatBohr(lines);
      if (!Number.isFinite(alatBohr)) throw new Error('PWSCFOUT: ATOMIC_POSITIONS(alat) but no alat found');
      const scale = alatBohr * BOHR_TO_ANG;
      cartAng = vals.map(v => v.map(x => x * scale));
    }
    const invLT = invert33(transpose33(latticeAng));
    const frac = cartAng.map(c => mulMatVec(invLT, c));
    return { elements: elems, positionsFrac: frac };
  }
}

/* --------- Magnetization parsing (vectors per atom) --------- */

// Returns Array<{ atomIndex, vector:[mx,my,mz], scalingFactor:1, color:'black' }>
function parseQEMagnetizationVectors(lines, natoms) {
  // Pattern A: noncollinear per-atom vector blocks
  //   atom number   n   ...
  //   magnetization :   mx   my   mz
  const vecs = new Array(natoms);
  let foundVec = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*atom\s+number\s+(\d+)\b/i);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    if (!(idx >= 0 && idx < natoms)) continue;

    // search forward a few lines for "magnetization :"
    for (let k = 1; k <= 6 && i + k < lines.length; k++) {
      const mm = lines[i + k].match(/^\s*magnetization\s*:\s*([-\d.+EeDd]+)\s+([-\d.+EeDd]+)\s+([-\d.+EeDd]+)/i);
      if (mm) {
        const mx = parseFortranFloat(mm[1]);
        const my = parseFortranFloat(mm[2]);
        const mz = parseFortranFloat(mm[3]);
        vecs[idx] = makeVecObj(idx, [mx, my, mz]);
        foundVec = true;
        break;
      }
    }
  }

  if (foundVec) {
    // Fill any missing sites with [0,0,0]
    for (let i = 0; i < natoms; i++) if (!vecs[i]) vecs[i] = makeVecObj(i, [0,0,0]);
    return vecs;
  }

  // Pattern B: collinear "magnetization" scalar on atom lines
  // e.g. "atom    5 type 1  charge ... magnetization  1.876  m(abs) ..."
  const scal = new Array(natoms); let seenAny = false;
  const re = /^\s*atom\s+(\d+)\b.*?\bmagnetization\b\s*([-\d.+EeDd]+)/i;
  for (const s of lines) {
    const m = s.match(re);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      const val = parseFortranFloat(m[2]);
      if (idx >= 0 && idx < natoms) { scal[idx] = val; seenAny = true; }
    }
  }
  if (seenAny) {
    for (let i = 0; i < natoms; i++) vecs[i] = makeVecObj(i, [num0(scal[i]), 0, 0]);
    return vecs;
  }

  // Fallback: return zeros if no magnetization printed (unpolarized cases)
  const zeros = new Array(natoms);
  for (let i = 0; i < natoms; i++) zeros[i] = makeVecObj(i, [0,0,0]);
  return zeros;
}

function makeVecObj(atomIndex, vec) {
  return { atomIndex, scalingFactor: 1, color: 'black', vector: [num0(vec[0]), num0(vec[1]), num0(vec[2])] };
}

function num0(x) { return Number.isFinite(x) ? x : 0; }
