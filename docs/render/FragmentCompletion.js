// "Complete Rings & Fragments" — the atoms that fragments (finite bonded groups:
// dimers, molecules, molecular ions) and small rings cut by a cell face need
// from the neighbouring cells. JS twin of
// docs/compiled/periodic_wasm_src/src/fragments.rs, which carries the full
// rationale; the two must agree, since either serves depending on
// general.useWasmPeriodic.
//
// In short: build the bond graph of the primary atoms under periodic boundary
// conditions, split it into connected components while recording the cell
// shift that puts each component back together, then
//   - draw every finite component (fragment) whole for each copy that has a
//     displayed atom;
//   - in components that bond to a translated copy of themselves (chains,
//     layers, frameworks), draw whole the smallest rings of up to maxRing atoms
//     through each bond that leaves the displayed set. Only atoms with at most
//     four fragment bonds take part, so close-packed structures are left alone.

const MAX_RING_DEGREE = 4;
const MAX_RINGS_PER_BOND = 8;
const MIN_BOND_D2 = 0.005 * 0.005;
const MAX_RING_LIMIT = 12;

// Packed (atom, cell shift) key, same layout as fragments.rs: 10 bits per shift
// component above the atom index. The atom part is multiplied, not shifted, so
// it stays exact past 2^31.
function imageKey(src, sx, sy, sz) {
  return src * 1073741824 + ((((sx + 512) & 1023) << 20) | (((sy + 512) & 1023) << 10) | ((sz + 512) & 1023));
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Periodic bond graph, CSR: the bonds of atom i are start[i]..start[i+1], each
 * to atom nbr[k] translated by (sx[k], sy[k], sz[k]) cells.
 * @param {number[][]} frac primary fractional coordinates, as given
 * @param {Uint32Array} elemIdx
 * @param {number[][]} lattice rows a, b, c
 * @param {Float64Array} table nElem × nElem cutoffs (0 = no bond)
 * @param {number} nElem
 */
function buildGraph(frac, elemIdx, lattice, table, nElem) {
  const n = frac.length;
  const start = new Int32Array(n + 1);
  const nbr = [], sx = [], sy = [], sz = [];
  const graph = { start, nbr, sx, sy, sz };
  let maxCut = 0;
  for (let k = 0; k < table.length; k++) if (table[k] > maxCut) maxCut = table[k];
  const [a, b, c] = lattice;
  const bc = cross(b, c), ca = cross(c, a), ab = cross(a, b);
  const vol = Math.abs(a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2]);
  if (n === 0 || maxCut <= 0.01 || vol <= 1e-9) return graph;

  // Perpendicular widths, so no image within the cutoff is missed in a skewed
  // or thin cell.
  const widths = [bc, ca, ab].map(v => vol / Math.max(Math.hypot(v[0], v[1], v[2]), 1e-9));
  const reach = widths.map(w => Math.max(1, Math.ceil(maxCut / w)));
  const dims = widths.map(w => Math.max(1, Math.floor(w / maxCut)));
  const maxBins = Math.max(8 * n, 512);
  const total = dims[0] * dims[1] * dims[2];
  if (total > maxBins) {
    const f = Math.cbrt(total / maxBins);
    for (let k = 0; k < 3; k++) dims[k] = Math.max(1, Math.floor(dims[k] / f));
  }
  const halo = [0, 1, 2].map(k => Math.floor(maxCut / (widths[k] / dims[k])) + 1);

  // Periodic cell list over wrapped fractional coordinates.
  const binOf = (f, g) => {
    const b0 = Math.floor((f - Math.floor(f)) * g);
    return b0 >= g ? g - 1 : (b0 < 0 ? 0 : b0);
  };
  const bins = Array.from({ length: dims[0] * dims[1] * dims[2] }, () => []);
  for (let j = 0; j < n; j++) {
    const f = frac[j];
    bins[(binOf(f[0], dims[0]) * dims[1] + binOf(f[1], dims[1])) * dims[2] + binOf(f[2], dims[2])].push(j);
  }
  const axisBins = (bin, h, g) => {
    if (2 * h + 1 >= g) return Array.from({ length: g }, (_, k) => k);
    const out = [];
    for (let d = -h; d <= h; d++) out.push(((bin + d) % g + g) % g);
    return out;
  };

  const cart = frac.map(f => [
    a[0] * f[0] + b[0] * f[1] + c[0] * f[2],
    a[1] * f[0] + b[1] * f[1] + c[1] * f[2],
    a[2] * f[0] + b[2] * f[1] + c[2] * f[2],
  ]);
  const stamp = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const fi = frac[i], pi = cart[i], ei = elemIdx[i];
    const xs = axisBins(binOf(fi[0], dims[0]), halo[0], dims[0]);
    const ys = axisBins(binOf(fi[1], dims[1]), halo[1], dims[1]);
    const zs = axisBins(binOf(fi[2], dims[2]), halo[2], dims[2]);
    for (const bx of xs) for (const by of ys) for (const bz of zs) {
      for (const j of bins[(bx * dims[1] + by) * dims[2] + bz]) {
        if (stamp[j] === i) continue;
        stamp[j] = i;
        const ej = elemIdx[j];
        const ct = (ei < nElem && ej < nElem) ? table[ei * nElem + ej] : 0;
        if (ct <= 0.01) continue;
        const ct2 = ct * ct;
        const fj = frac[j], pj = cart[j];
        const c0 = Math.round(fi[0] - fj[0]), c1 = Math.round(fi[1] - fj[1]), c2 = Math.round(fi[2] - fj[2]);
        for (let dx = c0 - reach[0]; dx <= c0 + reach[0]; dx++)
          for (let dy = c1 - reach[1]; dy <= c1 + reach[1]; dy++)
            for (let dz = c2 - reach[2]; dz <= c2 + reach[2]; dz++) {
              if (j === i && dx === 0 && dy === 0 && dz === 0) continue;
              const qx = pj[0] + a[0] * dx + b[0] * dy + c[0] * dz - pi[0];
              const qy = pj[1] + a[1] * dx + b[1] * dy + c[1] * dz - pi[1];
              const qz = pj[2] + a[2] * dx + b[2] * dy + c[2] * dz - pi[2];
              const d2 = qx * qx + qy * qy + qz * qz;
              if (d2 <= ct2 && d2 >= MIN_BOND_D2) {
                nbr.push(j); sx.push(dx); sy.push(dy); sz.push(dz);
              }
            }
      }
    }
    start[i + 1] = nbr.length;
  }
  return graph;
}

// Connected components; unwrap shift per atom; extended = bonds to a translated
// copy of itself.
function components(g) {
  const n = g.start.length - 1;
  const comp = new Int32Array(n).fill(-1);
  const ux = new Int32Array(n), uy = new Int32Array(n), uz = new Int32Array(n);
  const extended = [];
  const cstart = [0];
  const members = [];
  for (let r = 0; r < n; r++) {
    if (comp[r] !== -1) continue;
    const id = extended.length;
    let ext = false;
    comp[r] = id;
    let q = members.length;
    members.push(r);
    while (q < members.length) {
      const i = members[q++];
      for (let k = g.start[i]; k < g.start[i + 1]; k++) {
        const j = g.nbr[k];
        const wx = ux[i] + g.sx[k], wy = uy[i] + g.sy[k], wz = uz[i] + g.sz[k];
        if (comp[j] === -1) {
          comp[j] = id; ux[j] = wx; uy[j] = wy; uz[j] = wz;
          members.push(j);
        } else if (ux[j] !== wx || uy[j] !== wy || uz[j] !== wz) {
          ext = true;
        }
      }
    }
    extended.push(ext);
    cstart.push(members.length);
  }
  return { comp, ux, uy, uz, extended, cstart, members };
}

// Smallest rings (≤ maxRing atoms) through bond k of atom i, as
// [atom, sx, sy, sz] lists relative to atom i's image.
function smallestRings(g, i, k, maxRing) {
  const degree = (x) => g.start[x + 1] - g.start[x];
  const j = g.nbr[k];
  if (degree(j) > MAX_RING_DEGREE) return [];
  const target = imageKey(i, 0, 0, 0);
  const nodes = [[j, g.sx[k], g.sy[k], g.sz[k]]];
  const parents = [[]];
  const depthOf = [0];
  const index = new Map([[imageKey(j, g.sx[k], g.sy[k], g.sz[k]), 0]]);
  let layer = [0];
  let hit = -1;
  for (let depth = 1; depth < maxRing; depth++) {
    const next = [];
    for (const ni of layer) {
      const [at, ax, ay, az] = nodes[ni];
      for (let e = g.start[at]; e < g.start[at + 1]; e++) {
        const bt = g.nbr[e];
        const bx = ax + g.sx[e], by = ay + g.sy[e], bz = az + g.sz[e];
        const key = imageKey(bt, bx, by, bz);
        if (depth === 1 && key === target) continue; // the bond itself
        if (key !== target && degree(bt) > MAX_RING_DEGREE) continue;
        const id = index.get(key);
        if (id === undefined) {
          const nid = nodes.length;
          nodes.push([bt, bx, by, bz]);
          parents.push([ni]);
          depthOf.push(depth);
          index.set(key, nid);
          next.push(nid);
          if (key === target) hit = nid;
        } else if (depthOf[id] === depth) {
          parents[id].push(ni);
        }
      }
    }
    if (hit >= 0 || next.length === 0) break;
    layer = next;
  }

  const rings = [];
  if (hit < 0) return rings;
  const path = [hit];
  const walk = (node) => {
    if (rings.length >= MAX_RINGS_PER_BOND) return;
    if (node === 0) { rings.push(path.map(p => nodes[p])); return; }
    for (const p of parents[node]) { path.push(p); walk(p); path.pop(); }
  };
  walk(hit);
  return rings;
}

/**
 * Atoms to add for "Complete Rings & Fragments".
 * @param {number[][]} frac primary fractional coordinates, as given
 * @param {Uint32Array} elemIdx element index per atom (into the table)
 * @param {number[][]} lattice rows a, b, c
 * @param {Float64Array} table nElem × nElem cutoffs of the bonds that define fragments
 * @param {number} nElem
 * @param {number[]} seedSrc displayed images: source atom …
 * @param {number[][]} seedShift … and its integer cell shift
 * @param {number} maxRing largest ring completed in extended networks (0 = none)
 * @returns {{src: number[], shift: number[][]}} images to add, none repeating a seed
 */
export function completeFragments(frac, elemIdx, lattice, table, nElem, seedSrc, seedShift, maxRing) {
  const out = { src: [], shift: [] };
  const g = buildGraph(frac, elemIdx, lattice, table, nElem);
  if (g.nbr.length === 0) return out;
  const cc = components(g);

  const base = new Set();
  for (let s = 0; s < seedSrc.length; s++) {
    const t = seedShift[s];
    base.add(imageKey(seedSrc[s], t[0], t[1], t[2]));
  }
  const shown = new Set(base);
  const emit = (m, x, y, z) => {
    const key = imageKey(m, x, y, z);
    if (shown.has(key)) return;
    shown.add(key);
    out.src.push(m);
    out.shift.push([x, y, z]);
  };

  // Finite fragments: one whole copy per (component, frame shift) with a seed.
  const placed = new Set();
  for (let s = 0; s < seedSrc.length; s++) {
    const i = seedSrc[s];
    const c = cc.comp[i];
    if (cc.extended[c] || cc.cstart[c + 1] - cc.cstart[c] < 2) continue;
    const t = seedShift[s];
    const ox = t[0] - cc.ux[i], oy = t[1] - cc.uy[i], oz = t[2] - cc.uz[i];
    const key = imageKey(c, ox, oy, oz);
    if (placed.has(key)) continue;
    placed.add(key);
    for (let q = cc.cstart[c]; q < cc.cstart[c + 1]; q++) {
      const m = cc.members[q];
      emit(m, ox + cc.ux[m], oy + cc.uy[m], oz + cc.uz[m]);
    }
  }

  // Rings in extended components, through bonds leaving the seed set.
  const ringMax = Math.min(maxRing | 0, MAX_RING_LIMIT);
  if (ringMax >= 3) {
    const memo = new Map();
    for (let s = 0; s < seedSrc.length; s++) {
      const i = seedSrc[s];
      if (!cc.extended[cc.comp[i]] || g.start[i + 1] - g.start[i] > MAX_RING_DEGREE) continue;
      const t = seedShift[s];
      for (let k = g.start[i]; k < g.start[i + 1]; k++) {
        if (base.has(imageKey(g.nbr[k], t[0] + g.sx[k], t[1] + g.sy[k], t[2] + g.sz[k]))) continue;
        let rings = memo.get(k);
        if (!rings) { rings = smallestRings(g, i, k, ringMax); memo.set(k, rings); }
        for (const ring of rings) {
          for (const [m, rx, ry, rz] of ring) emit(m, t[0] + rx, t[1] + ry, t[2] + rz);
        }
      }
    }
  }
  return out;
}
