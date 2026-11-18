// Bonds during fast trajectory / MD playback, in step with the atoms.
//
// Between full rebuilds the fast path (FastFrameModule.js) moves every atom
// instance in place. Bonds used to follow as Bond objects: only the pairs
// found at the last rebuild existed, so a bond that FORMED in between appeared
// only at the next rebuild — late, and on large structures that rebuild was a
// stall of seconds. Here the bond set is a neighbour list with a margin (the
// Verlet-list idea from MD codes):
//
//  - real bonds: the bonds of the last rebuild, already styled in groups
//    .bondsMesh (colours, opacity, picking tables untouched);
//  - candidates: every other pair within cutoff + BOND_SKIN, built and styled
//    by the same code as real bonds (createModeColoredBonds /
//    applyBondStyleOverrides) into a second mesh, groups.bondsCandidateMesh.
//
// Every frame each pair is drawn exactly when its CURRENT length is within its
// cutoff (and above the minimum), so bonds form and break in the same frame as
// the atom motion that causes it. Correct while no atom has moved more than
// BOND_SKIN / 2 since the candidate list was computed: the list is refreshed in
// a worker (workers/computeWorker.js `bondPairs`) once atoms have moved
// CANDIDATE_REFRESH_DISPLACEMENT, and synchronously only if the result is not
// back by BOND_SKIN / 2. The full rebuild — new image set, new Bond objects,
// new mesh — is no longer needed for bonds during playback.
//
// Geometry is written from typed arrays with exactly Bond.updateEndpoints'
// clipped-bond math; the Bond objects themselves are brought up to date lazily
// (markBondObjectsStale), when something reads structure.bonds.

import * as THREE from '../external/three/three.module.js';
import { app, groups, general } from '../state/store.js';
import { writeBondPairMatricesFrom, writeHiddenBondHalf } from './bondMatrix.js';
import { BOND_RECORD as R, bondClipOffset } from '../model/Bond.js';
import {
  createBondsMesh, disposeBondCandidatesMesh, bondElementTables, createModeColoredBonds,
  applyBondStyleOverrides, BOND_MIN_DIST_SQ, isPointCutByPlanes,
} from './BondsFracUpdateModule.js';
import { computeBondPairsWasm } from '../compiled/bondsWasm.js';
import { getFocusOpacityForInstance } from './FocusRegionModule.js';
import { peekAtoms } from '../model/materializeFrame.js';
import { colorBin } from './ColorMapBins.js';
import { syncBondModelColors } from './FrameColorsModule.js';
import * as workerPool from '../workers/workerPool.js';
import { count as traceCount } from '../debug/debugTrace.js';

/** Margin (Å) beyond each pair's cutoff that the candidate list covers. */
export const BOND_SKIN = 1.0;
/** Request a fresh candidate list once any atom moved this far (Å). */
export const CANDIDATE_REFRESH_DISPLACEMENT = 0.3;
/** Past this (Å) the list may miss a forming bond: refresh synchronously. */
export const CANDIDATE_LIMIT_DISPLACEMENT = BOND_SKIN / 2;
/** Up to this many drawn instances the pair search is cheap enough to run inline. */
const SYNC_SEARCH_MAX_INSTANCES = 30000;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const _color = new THREE.Color();

/**
 * Typed per-pair arrays for one bond set.
 * @param {number} n
 */
function emptySet(n) {
  return {
    n,
    slot: new Int32Array(n),
    i: new Int32Array(n),
    j: new Int32Array(n),
    // Rendered radii of the two end atoms, and the clip offsets they give at
    // the bond radius `clipRadius` (bondClipOffset; syncClip). The offsets
    // depend on the bond radius, which the slider may change mid-play: they
    // are worked out again once per change, not every frame.
    atomR1: new Float64Array(n),
    atomR2: new Float64Array(n),
    r1: new Float64Array(n),
    r2: new Float64Array(n),
    clipRadius: NaN,
    radiusScale: new Float64Array(n),
    cutoffSq: new Float64Array(n),
    minCutoffSq: new Float64Array(n),
    srcI: new Int32Array(n),
    srcJ: new Int32Array(n),
    pairType: new Int32Array(n),
    // Bit h set: half h has a user/category colour, kept through colour maps.
    fixed: new Uint8Array(n),
  };
}

/** Copy bond `b` (a model/Bond with indices, atomR1/atomR2, radius) into set slot k. */
function fillFromBond(set, k, b, slot, tables) {
  const i = b.indexA, j = b.indexB;
  const t = tables.atomElemIdx[i] * tables.nu + tables.atomElemIdx[j];
  set.slot[k] = slot;
  set.i[k] = i;
  set.j[k] = j;
  set.atomR1[k] = b.atomR1;
  set.atomR2[k] = b.atomR2;
  // Category / user radius scales are baked into bond.radius at build; keep
  // the scale so a bond-radius slider move during playback still applies.
  set.radiusScale[k] = general.bondRadius > 0 && b.radius != null ? b.radius / general.bondRadius : 1;
  set.cutoffSq[k] = b.cutoffSq || tables.cutoffSqFlat[t];
  set.minCutoffSq[k] = tables.minCutoffSqFlat[t];
  set.srcI[k] = b.srcA;
  set.srcJ[k] = b.srcB;
  set.pairType[k] = t;
  set.fixed[k] = (b.userColor?.[0] != null ? 1 : 0) | (b.userColor?.[1] != null ? 2 : 0);
}

const pairKey = (n, i, j) => (i < j ? i * n + j : j * n + i);

/** Bring the set's clip offsets up to the global bond radius `radius`. */
function syncClip(set, radius) {
  if (set.clipRadius === radius) return;
  for (let k = 0; k < set.n; k++) {
    const bondRadius = radius * set.radiusScale[k];
    set.r1[k] = bondClipOffset(set.atomR1[k], bondRadius);
    set.r2[k] = bondClipOffset(set.atomR2[k], bondRadius);
  }
  set.clipRadius = radius;
}

// One bond's geometry, handed to the matrix writer in place (loose double
// arguments are boxed — a heap object each — when the callee is not inlined).
const rec = new Float64Array(R.STRIDE);

/**
 * Write one set's matrices for the current instance positions — and, with a
 * frame-dependent colour map (ctx.colors, FrameColorsModule.js), the colours
 * of the halves drawn. Returns the number of pairs drawn.
 */
function writeSet(set, matrices, cart, ctx, colorsOut = null) {
  const { planes, atoms, immune, radius } = ctx;
  const fc = colorsOut ? ctx.colors : null;
  syncClip(set, radius);
  let shown = 0;
  for (let k = 0; k < set.n; k++) {
    const slot = set.slot[k];
    const p1 = cart[set.i[k]], p2 = cart[set.j[k]];
    const x1 = p1[0], y1 = p1[1], z1 = p1[2];
    const x2 = p2[0], y2 = p2[1], z2 = p2[2];
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const distSq = dx * dx + dy * dy + dz * dz;
    const cut = set.cutoffSq[k];
    if ((cut > 0 && distSq > cut) || distSq < set.minCutoffSq[k] || distSq < BOND_MIN_DIST_SQ) {
      writeHiddenBondHalf(matrices, slot * 2);
      writeHiddenBondHalf(matrices, slot * 2 + 1);
      continue;
    }
    // Bond.updateEndpoints' clipped geometry.
    const dist = Math.sqrt(distSq);
    const r1 = set.r1[k], r2 = set.r2[k];
    const visibleLen = Math.max(dist - (r1 + r2), 0);
    if (!(visibleLen > 1e-3)) {
      writeHiddenBondHalf(matrices, slot * 2);
      writeHiddenBondHalf(matrices, slot * 2 + 1);
      continue;
    }
    if (planes.length && !immune[set.pairType[k]]) {
      const cutA = !atoms?.[set.srcI[k]]?.cutPlaneImmune && isPointCutByPlanes([x1, y1, z1], planes);
      const cutB = !atoms?.[set.srcJ[k]]?.cutPlaneImmune && isPointCutByPlanes([x2, y2, z2], planes);
      if (cutA || cutB) {
        writeHiddenBondHalf(matrices, slot * 2);
        writeHiddenBondHalf(matrices, slot * 2 + 1);
        continue;
      }
    }
    const halfLen = visibleLen * 0.5;
    const inv = dist > 1e-9 ? 1 / dist : 0;
    const ux = dx * inv, uy = dy * inv, uz = dz * inv;
    const a1 = r1 + halfLen / 2;
    const a2 = -r2 - halfLen / 2;
    rec[R.C1X] = x1 + ux * a1; rec[R.C1Y] = y1 + uy * a1; rec[R.C1Z] = z1 + uz * a1;
    rec[R.C2X] = x2 + ux * a2; rec[R.C2Y] = y2 + uy * a2; rec[R.C2Z] = z2 + uz * a2;
    rec[R.DX] = dx; rec[R.DY] = dy; rec[R.DZ] = dz;
    rec[R.RADIUS] = radius * set.radiusScale[k];
    rec[R.HLEN] = halfLen;
    writeBondPairMatricesFrom(matrices, slot * 2, rec, 0);
    if (fc) writePairColors(colorsOut, slot, set, k, fc, dist);
    shown++;
  }
  return shown;
}

/** The frame colour of a drawn pair's two halves (each unless fixed): its
 *  length's map bin, or each end's atom colour. */
function writePairColors(out, slot, set, k, fc, dist) {
  const fixed = set.fixed[k];
  for (let h = 0; h < 2; h++) {
    if (fixed & (1 << h)) continue;
    let rgb, at;
    if (fc.mode === 'length') {
      rgb = fc.table.rgb;
      at = colorBin(dist, fc.min, fc.max, fc.table.n, fc.log) * 3;
    } else {
      rgb = fc.rgb;
      at = (h ? set.srcJ[k] : set.srcI[k]) * 3;
    }
    const o = (slot * 2 + h) * 3;
    out[o] = rgb[at]; out[o + 1] = rgb[at + 1]; out[o + 2] = rgb[at + 2];
  }
}

/**
 * The bond-length range when none is set (BondMin >= BondMax): the drawn
 * pairs' lengths, stored like the bond builder's auto range. False when
 * nothing is drawn.
 */
function resolveLengthRange(state, cart) {
  if (general.BondMin < general.BondMax) return true;
  let lo = Infinity, hi = -Infinity;
  for (const set of [state.real, state.cand]) {
    if (!set) continue;
    for (let k = 0; k < set.n; k++) {
      const p1 = cart[set.i[k]], p2 = cart[set.j[k]];
      const dx = p2[0] - p1[0], dy = p2[1] - p1[1], dz = p2[2] - p1[2];
      const distSq = dx * dx + dy * dy + dz * dz;
      const cut = set.cutoffSq[k];
      if ((cut > 0 && distSq > cut) || distSq < set.minCutoffSq[k] || distSq < BOND_MIN_DIST_SQ) continue;
      const d = Math.sqrt(distSq);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
  }
  if (!(lo <= hi)) return false;
  general.BondMin = lo;
  general.BondMax = lo === hi ? lo + 1 : hi;
  return true;
}

/** Per-element-pair cut-plane immunity for this frame (Bonds tab toggle). */
function immunityTable(tables) {
  const { uniqueElems, nu } = tables;
  const out = new Uint8Array(nu * nu);
  const flags = general.bondCutImmunity;
  if (!flags) return out;
  for (let a = 0; a < nu; a++) {
    for (let b = 0; b < nu; b++) {
      const e1 = uniqueElems[a], e2 = uniqueElems[b];
      out[a * nu + b] = flags[e1 < e2 ? `${e1}-${e2}` : `${e2}-${e1}`] ? 1 : 0;
    }
  }
  return out;
}

/**
 * The playback bond state for this structure's current topology: built on
 * the first fast frame after a (bond) rebuild, kept on the wrapping.
 */
function ensureState(structure, wrapped, bondsMesh) {
  const existing = wrapped.playbackBonds;
  if (existing && existing.mesh === bondsMesh && existing.buildId === general.bondsBuildCounter) return existing;
  disposeBondCandidatesMesh();
  const tables = bondElementTables(wrapped.elements);
  const bonds = peekBonds(structure) || [];
  const slotted = bonds.filter((b) => Number.isInteger(b.renderIndex) && b.renderIndex >= 0
    && b.indexA >= 0 && b.atomR1 != null && b.atomR2 != null);
  const real = emptySet(slotted.length);
  const n = wrapped.cart.length;
  const realKeys = new Set();
  slotted.forEach((b, k) => {
    fillFromBond(real, k, b, b.renderIndex, tables);
    realKeys.add(pairKey(n, b.indexA, b.indexB));
  });
  const state = {
    mesh: bondsMesh,
    buildId: general.bondsBuildCounter,
    tables,
    real,
    realKeys,
    cand: null,
    candBonds: [],
    token: 0,
    pending: false,
    refreshes: 0,
    frameColors: null,
    // Search inline when cheap (no latency at all), else in a worker (the real
    // bonds are exact meanwhile; a bond forming before the list arrives shows
    // a frame or two late on a huge structure).
    inline: n <= SYNC_SEARCH_MAX_INSTANCES || !workerPool.available(),
  };
  wrapped.playbackBonds = state;
  refreshCandidates(state, structure, wrapped, state.inline);
  return state;
}

/** Pair-search inputs with every cutoff widened by BOND_SKIN. */
function searchPayload(tables, cart) {
  const n = cart.length;
  const cartFlat = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = cart[i];
    cartFlat[3 * i] = p[0]; cartFlat[3 * i + 1] = p[1]; cartFlat[3 * i + 2] = p[2];
  }
  const elemIdx = new Uint32Array(tables.atomElemIdx);
  const cutoffSqFlat = new Float64Array(tables.cutoffSqFlat.length);
  for (let k = 0; k < cutoffSqFlat.length; k++) {
    const c = Math.sqrt(tables.cutoffSqFlat[k]);
    cutoffSqFlat[k] = c > 0.01 ? (c + BOND_SKIN) * (c + BOND_SKIN) : tables.cutoffSqFlat[k];
  }
  return {
    cartFlat, elemIdx, cutoffSqFlat,
    minCutoffSqFlat: Float64Array.from(tables.minCutoffSqFlat),
    nElem: tables.nu, minDistSq: BOND_MIN_DIST_SQ, maxCutoff: tables.maxCutoff + BOND_SKIN,
  };
}

/**
 * Recompute the candidate list from the wrapping's current positions.
 * Remembers those positions as the reference the next refresh is measured
 * from (wrapped.candRefFrac, maintained by FastFrameModule.js).
 */
function refreshCandidates(state, structure, wrapped, sync) {
  if (state.tables.maxCutoff <= 0.01) return;
  const token = ++state.token;
  // Reference: the unwrapped source positions right now.
  const prev = wrapped.prevAtomFrac, fix = wrapped.wrapFix;
  if (prev && fix && prev.length === fix.length) {
    const ref = new Float64Array(prev.length);
    for (let k = 0; k < ref.length; k++) ref[k] = prev[k] + fix[k];
    wrapped.candRefFrac = ref;
  } else {
    wrapped.candRefFrac = null;
  }
  wrapped.candDisplacement = 0;
  const payload = searchPayload(state.tables, wrapped.cart);
  const apply = ({ i, j }) => {
    if (token !== state.token || wrapped.playbackBonds !== state) return;
    state.pending = false;
    applyCandidates(state, structure, wrapped, i, j);
  };
  if (sync) {
    apply(computeBondPairsWasm(payload));
    return;
  }
  state.pending = true;
  workerPool.run('bondPairs', payload, [payload.cartFlat.buffer]).then(apply, (error) => {
    if (token !== state.token) return;
    console.warn('Playback bonds: background pair search failed, searching inline:', error);
    state.pending = false;
    refreshCandidates(state, structure, wrapped, true);
  });
}

/** Turn a pair list into the styled candidate set and its mesh. */
function applyCandidates(state, structure, wrapped, pairI, pairJ) {
  state.refreshes++;
  traceCount('playbackBondCandidates');
  const n = wrapped.cart.length;
  const ci = [], cj = [];
  for (let k = 0; k < pairI.length; k++) {
    if (!state.realKeys.has(pairKey(n, pairI[k], pairJ[k]))) { ci.push(pairI[k]); cj.push(pairJ[k]); }
  }
  const t = state.tables;
  const bonds = createModeColoredBonds(structure, wrapped, ci, cj,
    { uniqueElems: t.uniqueElems, atomElemIdx: t.atomElemIdx, nu: t.nu, cutoffSqFlat: t.cutoffSqFlat });
  applyBondStyleOverrides(structure, bonds);
  const usable = bonds.filter((b) => b.atomR1 != null && b.atomR2 != null);
  const set = emptySet(usable.length);
  usable.forEach((b, k) => fillFromBond(set, k, b, k, t));
  state.cand = set;
  state.candBonds = usable;

  disposeBondCandidatesMesh();
  if (!usable.length) return;
  const mesh = createBondsMesh(usable.length, { persistent: true });
  const colors = mesh.instanceColor.array;
  const opacity = mesh.geometry.attributes.instanceOpacity.array;
  const elementIndex = mesh.geometry.attributes.instanceElementIndex.array;
  const atoms = peekAtoms(structure);
  // updateSingleBond's colour rule: an atom's own colour wins over the mode
  // colour in "elements" mode, unless the bond carries a user/category colour.
  const overwriteAtomColor = general.bondsColor !== 'elements' && general.bondsColor != null;
  usable.forEach((b, k) => {
    const focus = Math.min(getFocusOpacityForInstance(b.indexA, structure),
      getFocusOpacityForInstance(b.indexB, structure));
    for (let h = 0; h < 2; h++) {
      const half = k * 2 + h;
      const atom = atoms?.[h ? b.srcB : b.srcA];
      const keep = overwriteAtomColor || b.userColor?.[h] != null || atom?.userColor == null;
      _color.set(keep ? b.color[h] : atom.userColor);
      colors[half * 3] = _color.r; colors[half * 3 + 1] = _color.g; colors[half * 3 + 2] = _color.b;
      opacity[half] = clamp01(b.alpha ?? 1) * focus;
      elementIndex[half] = half;
      writeHiddenBondHalf(mesh.instanceMatrix.array, half);
    }
  });
  mesh.geometry.setAttribute('instanceUUID',
    new THREE.InstancedBufferAttribute(new Float32Array(usable.length * 8), 4));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.needsUpdate = true;
  mesh.userData.playbackCandidates = true;
  mesh.visible = !!general.showBonds;
  app.scene.add(mesh);
  groups.bondsCandidateMesh = mesh;
  // Draw them for the positions on screen now, not one frame late.
  const ctx = frameContext(state, structure);
  writeSet(set, mesh.instanceMatrix.array, wrapped.cart, ctx, ctx.colors ? colors : null);
  mesh.instanceMatrix.needsUpdate = true;
}

function frameContext(state, structure, planes = null) {
  const fc = state.frameColors;
  return {
    planes: planes ?? [],
    atoms: peekAtoms(structure),
    immune: immunityTable(state.tables),
    radius: general.bondRadius,
    colors: fc && (fc.mode !== 'length' || general.BondMin < general.BondMax)
      ? { ...fc, min: general.BondMin, max: general.BondMax } : null,
  };
}

/**
 * Draw this frame's bonds for the instance positions in wrapped.cart: real
 * bonds into groups.bondsMesh, candidates into groups.bondsCandidateMesh, each
 * shown exactly while within its cutoff. Refreshes the candidate list as the
 * atoms move. The Bond objects are left for markBondObjectsStale.
 * @param {any} structure
 * @param {any} wrapped
 * @param {any} bondsMesh
 * @param {any[]} cutPlanes active cut planes
 * @param {any} [frameColors] this frame's colour map for the bonds
 *   (FrameColorsModule.js prepareFrameColors), or null to keep their colours
 * @returns {{real: number, candidates: number}} pairs drawn
 */
export function writePlaybackBonds(structure, wrapped, bondsMesh, cutPlanes, frameColors = null) {
  const state = ensureState(structure, wrapped, bondsMesh);
  state.frameColors = frameColors;
  if (frameColors?.mode === 'length' && !resolveLengthRange(state, wrapped.cart)) state.frameColors = null;
  const ctx = frameContext(state, structure, cutPlanes);
  const recolor = (mesh) => (ctx.colors && mesh.instanceColor ? mesh.instanceColor.array : null);
  const real = writeSet(state.real, bondsMesh.instanceMatrix.array, wrapped.cart, ctx, recolor(bondsMesh));
  bondsMesh.instanceMatrix.needsUpdate = true;
  if (recolor(bondsMesh)) bondsMesh.instanceColor.needsUpdate = true;
  let candidates = 0;
  const candMesh = groups.bondsCandidateMesh;
  if (state.cand && candMesh) {
    candMesh.visible = !!general.showBonds;
    candidates = writeSet(state.cand, candMesh.instanceMatrix.array, wrapped.cart, ctx, recolor(candMesh));
    candMesh.instanceMatrix.needsUpdate = true;
    if (recolor(candMesh)) candMesh.instanceColor.needsUpdate = true;
  }
  const moved = wrapped.candDisplacement ?? 0;
  if (moved >= CANDIDATE_LIMIT_DISPLACEMENT) {
    refreshCandidates(state, structure, wrapped, true);
  } else if (moved >= CANDIDATE_REFRESH_DISPLACEMENT && !state.pending) {
    refreshCandidates(state, structure, wrapped, state.inline);
  }
  return { real, candidates };
}

/** Diagnostics for tests and the Debug window. */
export function playbackBondStats(structure) {
  const s = structure?.periodic?.wrapped?.playbackBonds;
  if (!s) return null;
  return { real: s.real.n, candidates: s.cand?.n ?? 0, refreshes: s.refreshes, pending: s.pending };
}

// ── Lazy Bond objects ────────────────────────────────────────────────────────
//
// The fast path no longer moves each Bond's endpoints (Vector3s, positions,
// centres) every frame — a third of a fast frame at 10^5 bonds, for objects
// nothing reads during playback. structure.bonds becomes an accessor that
// brings them up to date (Bond.updateEndpoints from the current instance
// positions, exactly what the fast path used to do per frame) the first time
// something reads it.

const BOND_BACKING = Symbol('bondsBacking');
const BONDS_STALE = Symbol('bondsStaleFor');

function installBondAccessor(structure) {
  if (structure[BOND_BACKING]) return;
  const backing = { bonds: structure.bonds };
  structure[BOND_BACKING] = backing;
  Object.defineProperty(structure, 'bonds', {
    configurable: true,
    enumerable: true,
    get() {
      if (this[BONDS_STALE]) syncBondObjects(this);
      return backing.bonds;
    },
    set(value) {
      this[BONDS_STALE] = null;
      backing.bonds = value;
    },
  });
}

function syncBondObjects(structure) {
  const wrapped = structure[BONDS_STALE];
  structure[BONDS_STALE] = null;
  const cart = wrapped?.cart;
  const bonds = structure[BOND_BACKING].bonds;
  if (!cart || !Array.isArray(bonds)) return;
  for (const bond of bonds) {
    if (!bond) continue;
    const a = cart[bond.indexA], b = cart[bond.indexB];
    if (!a || !b) continue;
    bond.updateEndpoints(a, b);
  }
  syncBondModelColors(structure, bonds);
}

/**
 * Mark the structure's Bond objects as behind the instance positions of
 * `wrapped` (they are synced on the next read of structure.bonds).
 */
export function markBondObjectsStale(structure, wrapped) {
  installBondAccessor(structure);
  structure[BONDS_STALE] = wrapped;
}

/** The bonds array without syncing stale Bond objects. */
export function peekBonds(structure) {
  return structure?.[BOND_BACKING]?.bonds ?? structure?.bonds;
}
