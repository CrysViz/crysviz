// OUTCAR parser for: last structure + magnetization (collinear & noncollinear)
// Exports: parseOUTCAR(content)
//
// Output shape (mirrors your parsePOSCAR style):
// {
//   comment: 'OUTCAR Structure',
//   lattice: [[...],[...],[...]],        // 3x3 in Å
//   elements: ['Fe','Fe','O',...],       // expanded per atom
//   positions: [[f1,f2,f3], ...],        // fractional in [0,1)
//   uniqueElements: ['Fe','O',...],      // species order as in POTCAR
//   magnetization: {
//     mode: 'collinear' | 'noncollinear',
//     perAtom: number[] | {mx,my,mz,m}[],
//     total: number | {mx,my,mz,m}
//   }
// }

export function parseOUTCAR(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('OUTCAR: content must be a non-empty string');
  }

  const lines = content.split(/\r?\n/);

  // ---- Species & counts -----------------------------------------------------

  // ions per type =  n1 n2 ...
  const ionsPerType = findLastIonsPerType(lines);

  // uniqueElements from VRHFIN (fallback to TITEL / POTCAR)
  let uniqueElements = findUniqueElements(lines);
  if (uniqueElements.length && ionsPerType.length && uniqueElements.length !== ionsPerType.length) {
    // Try to reconcile common mismatch scenarios
    uniqueElements = uniqueElements.slice(0, ionsPerType.length);
  }
  if (!uniqueElements.length && ionsPerType.length) {
    // As a last resort, create placeholder labels
    uniqueElements = Array.from({ length: ionsPerType.length }, (_, i) => `X${i + 1}`);
  }

  // Expand elements per atom
  const elements = expandElements(uniqueElements, ionsPerType);

  const totalAtoms = ionsPerType.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(totalAtoms) || totalAtoms <= 0) {
    throw new Error('OUTCAR: could not determine total number of atoms (ions per type missing?)');
  }

  // ---- Lattice (last "direct lattice vectors") -----------------------------

  const lattice = findLastDirectLattice(lines);
  if (!lattice) {
    throw new Error('OUTCAR: could not find "direct lattice vectors" block');
  }

  // ---- Positions (last ionic step) -----------------------------------------

  const positionsCartesian = findLastPositionsCartesian(lines, totalAtoms);
  if (!positionsCartesian || positionsCartesian.length !== totalAtoms) {
    throw new Error('OUTCAR: could not parse last POSITION block or atom count mismatch');
  }

  // Convert to fractional, normalize to [0,1)
  const latticeInvT = invert3x3(transpose3x3(lattice)); // (L^T)^{-1}
  const positions = positionsCartesian
    .map(v => cartToFractional(v, latticeInvT))
    .map(p => p.map(normalizeFractional));

  // ---- Magnetization --------------------------------------------------------
 
  
  const magnetization = parseMagnetizationVectors(lines, totalAtoms);


  const structureDataOUT = {
    comment: 'OUTCAR Structure',
    lattice,
    elements,
    positions,
    uniqueElements,
  };

  return {structure: structureDataOUT, spin: magnetization}
   
}

/* ----------------------- Parsing helpers ---------------------------------- */

function findLastIonsPerType(lines) {
  const re = /ions\s+per\s+type\s*=\s*(.+)$/i;
  let counts = [];
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      const nums = (m[1] || '')
        .trim()
        .split(/\s+/)
        .map(x => parseInt(x, 10))
        .filter(Number.isFinite);
      if (nums.length) counts = nums;
    }
  }
  return counts;
}

function findUniqueElements(lines) {
  // Preferred: VRHFIN = Fe: ...
  // Fallbacks: TITEL  = PAW_PBE Fe 06Sep2000
  //           POTCAR: PAW_PBE Fe 06Sep2000
  const found = [];

  const pushSymbol = (sym) => {
    if (sym && /^[A-Z][a-z]?$/.test(sym) && !found.includes(sym)) found.push(sym);
  };

  for (const line of lines) {
    let m = line.match(/\bVRHFIN\s*=\s*([A-Za-z][a-z]?)/);
    if (m) { pushSymbol(capitalize(m[1])); continue; }

    m = line.match(/\bTITEL\s*=\s*\S+\s+([A-Za-z][a-z]?)(?:\s|$)/);
    if (m) { pushSymbol(capitalize(m[1])); continue; }

    if (/POTCAR:/i.test(line)) {
      // Try to find an element-like token on the line
      const tokens = line.replace(/^.*?POTCAR:/i, '').trim().split(/\s+/);
      const el = tokens.find(t => /^[A-Z][a-z]?$/.test(t));
      if (el) pushSymbol(el);
    }
  }

  return found;
}

function expandElements(uniqueElements, ionsPerType) {
  const elements = [];
  for (let i = 0; i < ionsPerType.length; i++) {
    const el = uniqueElements[i] || `X${i + 1}`;
    const n = ionsPerType[i] || 0;
    for (let k = 0; k < n; k++) elements.push(el);
  }
  return elements;
}

function findLastDirectLattice(lines) {
  // Find last block titled "direct lattice vectors"
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*direct\s+lattice\s+vectors/i.test(lines[i])) lastIdx = i;
  }
  if (lastIdx < 0) return null;

  // Usually the next 3 lines each start with 3 floats (then extra info)
  const mat = [];
  for (let r = 1; r <= 3; r++) {
    const line = lines[lastIdx + r] || '';
    const nums = line.trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
    if (nums.length < 3) return null;
    mat.push(nums.slice(0, 3));
  }
  return mat;
}

function findLastPositionsCartesian(lines, natoms) {
  // Prefer the canonical header with forces
  const headers = [
    /POSITION\s+TOTAL-FORCE/i,
    /position of ions in cartesian coordinates/i, // older format
    /^\s*POSITION\b/i
  ];

  // Find last header index
  let startIdx = -1, headerType = -1;
  for (let i = 0; i < lines.length; i++) {
    for (let t = 0; t < headers.length; t++) {
      if (headers[t].test(lines[i])) { startIdx = i; headerType = t; }
    }
  }
  if (startIdx < 0) return null;

  // Data begins 1–2 lines after depending on format (skip header & column line if present)
  let i = startIdx + 1;

  // Some VASP versions insert a blank or a ruler line; skip non-data until we see a numeric line
  const positions = [];
  for (; i < lines.length; i++) {
    if (/^\s*(\-{3,}|={3,})\s*$/.test(lines[i])) continue;          // ruler
    if (!lines[i].trim()) continue;                                 // blank

    // Peek: if next non-empty line is clearly numeric, break here
    const nums = lines[i].trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
    if (nums.length >= 3) break;
  }

  // Now collect natoms lines, stop earlier if "total drift" encountered
  let read = 0;
  for (; i < lines.length && read < natoms; i++) {
    const raw = lines[i];
    if (!raw.trim()) break;
    if (/total\s+drift/i.test(raw)) break;

    const tokens = raw.trim().split(/\s+/);
    const nums = tokens.map(parseFloat).filter(Number.isFinite);
    if (nums.length < 3) break;

    positions.push(nums.slice(0, 3));
    read++;
  }
  return positions;
}

/* ----------------------- Magnetization parsing ---------------------------- */

/* ---------------- Magnetization parsing → Array<{ atomIndex, vector, scalingFactor, color }> --- */

// Main entry: returns array of vector objects with defaults
function parseMagnetizationVectors(lines, natoms, {
  defaultColor = 'teal',
  defaultScaling = 1
} = {}) {
  const idxX = findLastIndex(lines, /^\s*magnetization\s*\(x\)/i);
  const idxY = findLastIndex(lines, /^\s*magnetization\s*\(y\)/i);
  const idxZ = findLastIndex(lines, /^\s*magnetization\s*\(z\)/i);

  // If no magnetization table at all → zeros
  if (idxX < 0 && idxY < 0 && idxZ < 0) {
    return Array.from({ length: natoms }, (_, i) => makeVectorObj(i, [0, 0, 0], defaultColor, defaultScaling));
  }

  const blockX = idxX >= 0 ? parseMagBlock(lines, idxX, natoms) : null;
  const blockY = idxY >= 0 ? parseMagBlock(lines, idxY, natoms) : null;
  const blockZ = idxZ >= 0 ? parseMagBlock(lines, idxZ, natoms) : null;

  // Noncollinear if we have X, Y, Z per-atom arrays of correct length
  const hasXYZ =
    blockX && blockX.perAtom.length === natoms &&
    blockY && blockY.perAtom.length === natoms &&
    blockZ && blockZ.perAtom.length === natoms;

  const out = new Array(natoms);

  if (hasXYZ) {
    for (let i = 0; i < natoms; i++) {
      const mx = numOr0(blockX.perAtom[i]);
      const my = numOr0(blockY.perAtom[i]);
      const mz = numOr0(blockZ.perAtom[i]);
      out[i] = makeVectorObj(i, [mx, my, mz], defaultColor, defaultScaling);
    }
    return out;
  }

  // Collinear case: use X as scalar, pack into [m, 0, 0]
  if (blockX) {
    for (let i = 0; i < natoms; i++) {
      const m = numOr0(blockX.perAtom[i]);
      out[i] = makeVectorObj(i, [m, 0, 0], defaultColor, defaultScaling);
    }
    return out;
  }

  // Fallback (shouldn't happen): zeros
  for (let i = 0; i < natoms; i++) {
    console.warn("Fallback for spin vectors! This should not happen")
    out[i] = makeVectorObj(i, [0, 0, 0], defaultColor, defaultScaling);
  }
  return out;
}

// Parses one magnetization component block starting at startIdx.
// Robust across VASP variants: picks the LAST numeric on each ion line as the per-atom value.
function parseMagBlock(lines, startIdx, natoms) {
  const perAtom = new Array(natoms);
  let total = null;

  let i = startIdx + 2;
  if (i < lines.length && /#\s*of\s*ion/i.test(lines[i])) i++; // skip header row if present
  let read = 0;

  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) break;
    if (/^\s*magnetization\s*\(/i.test(raw)) break; // next component
    
    if (/^\s*(-{3,}|={3,})\s*$/.test(raw)) continue;

    const tokens = raw.trim().split(/\s+/);
    if (!tokens.length) continue;

    const head = tokens[0].toLowerCase();
    const numbers = tokens.map(parseFloat).filter(Number.isFinite);

    if (head === 'tot') {
      if (numbers.length) total = numbers[numbers.length - 1]; // last numeric on tot line
      break;
    }

    if (/^\d+$/.test(head)) {
      const idx = parseInt(head, 10) - 1; // ion index is 1-based in OUTCAR
      if (idx >= 0 && idx < natoms) {
        perAtom[idx] = numbers.length ? numbers[numbers.length - 1] : 0;
        read++;
      }
      continue;
    }

    if (read > 0) break; // stop on unrelated content after starting
  }

  for (let k = 0; k < natoms; k++) if (!Number.isFinite(perAtom[k])) perAtom[k] = 0;

  return { perAtom, total };
}

function findLastIndex(lines, regex) {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) last = i;
  }
  return last;
}

function makeVectorObj(atomIndex, vec, color = 'teal', scalingFactor = 1) {
  return {
    atomIndex,
    scalingFactor,
    color,
    vector: [numOr0(vec[0]), numOr0(vec[1]), numOr0(vec[2])]
  };
}

function numOr0(x) {
  return Number.isFinite(x) ? x : 0;
}


/* ----------------------- Math & utils ------------------------------------- */

// Matches your POSCAR conversion logic: f = (L^T)^(-1) * c
function cartToFractional(cart, invLT) {
  return multiplyMatVec(invLT, cart);
}

function normalizeFractional(x) {
  // Normalize into [0,1)
  const y = x - Math.floor(x);
  return (y >= 1) ? y - 1 : (y < 0 ? y + 1 : y);
}

function transpose3x3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

function invert3x3(m) {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i]
  ] = m;

  const A =   (e*i - f*h);
  const B = - (d*i - f*g);
  const C =   (d*h - e*g);
  const D = - (b*i - c*h);
  const E =   (a*i - c*g);
  const F = - (a*h - b*g);
  const G =   (b*f - c*e);
  const H = - (a*f - c*d);
  const I =   (a*e - b*d);

  const det = a*A + b*B + c*C;
  if (Math.abs(det) < 1e-20) throw new Error('Matrix not invertible (det ~ 0)');

  const invDet = 1.0 / det;
  return [
    [A*invDet, D*invDet, G*invDet],
    [B*invDet, E*invDet, H*invDet],
    [C*invDet, F*invDet, I*invDet]
  ];
}

function multiplyMatVec(m, v) {
  return [
    m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
    m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
    m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2],
  ];
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}
