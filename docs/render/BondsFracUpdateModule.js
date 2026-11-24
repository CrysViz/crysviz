import * as THREE from '../external/three/three.module.js';

import {bondLengths, coordinationNumbers, app, groups,fileBrowser, general, highlightHover} from '../state/store.js';
import {getDefaultBondCutoff} from '../defaults/radii_defaults.js'
import {getBondVisSettings} from '../defaults/color_texture_defaults.js'
import {Bond} from '../model/index.js';
import { bondDefaultColor } from '../model/Bond.js';
import { getCutPlaneMaskSign } from '../model/Plane.js';
import { CUT_PLANE_TOLERANCE } from './cutPlaneTolerance.js';
import {createStyledMaterial, addCelOutline, syncCelHullOpacitySuppression,
  acquirePersistentMaterial, isPersistentMaterial} from './MaterialStyles.js'
import { getAtomImageStyle, hasAtomImageStyles } from './AtomsFracUpdateModule.js'
import {CEL_OUTLINE_LAYER} from './CelOutlinePass.js'
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import { requestRender } from './AnimateModule.js';
import { getFocusOpacityForInstance } from './FocusRegionModule.js';
import { refreshAsuHighlight } from './asuHighlightHook.js';
import { showBusyProgress, hideBusyProgress } from './TracerProgressModule.js';
import { colorMapTable, colorBin } from './ColorMapBins.js';




//import {bondLengthToColor} from '../ui/ColorPanel.js'
import {refreshBondLengthHistogram, isBondLengthHistogramOpen} from '../ui/AnalysisPanels/BondLengthHistogram.js'
import {refreshCoordinationHistogram, isCoordinationHistogramOpen} from '../ui/AnalysisPanels/CoordinationHistogram.js'
import { hasCifErrors, distanceSu } from '../model/cifErrors.js'
import { writeBondMatrices, writeHiddenBondHalf } from './bondMatrix.js';
import { peekAtoms, pendingFramePositions } from '../model/materializeFrame.js';
import { heldBondKeys, toleranceFactorSq, sourceFracReader, instancePairKey } from './BondBreakTolerance.js';
import {computeBondPairsWasm} from '../compiled/bondsWasm.js'
//import {getBondCutoff} from './BondsModule.js'
//

// Module-scope scratch colour reused by the per-bond colour writer (setXYZ
// copies its input). Matrices are written directly (render/bondMatrix.js).
const _bondColor = new THREE.Color();
export function initBondsLengths(){
  if (!fileBrowser.selectedStructure) {
    console.warn("Could not init bonds!")
    return;

  }
  let elements = [...fileBrowser.selectedStructure.elements];
  const uniqueElements = [...new Set(elements)]; // there is a object variable for this!
  const pairs = [];

  // Generate all unique pairs
  for (let i = 0; i < uniqueElements.length; i++) {
    for (let j = i; j < uniqueElements.length; j++) {
      const pair = uniqueElements[i] < uniqueElements[j]
        ? `${uniqueElements[i]}-${uniqueElements[j]}`
        : `${uniqueElements[j]}-${uniqueElements[i]}`;
      pairs.push(pair);

      if (!general.bondLengths[pair]) {
        // "Va" isn't a real element - getElementRadius falls back to a
        // generic default for it, same as any other unrecognized symbol,
        // which would otherwise auto-bond a vacancy to its neighbours by
        // default. Default that pair's cutoff to 0 (no bond) instead; the
        // Bond Length panel can still raise it by hand for whoever actually
        // wants to visualize distance-to-nearest-vacancy.
        const isVacancyPair = uniqueElements[i] === 'Va' || uniqueElements[j] === 'Va';
        const defaultValue = isVacancyPair ? 0.0 : getDefaultBondCutoff(uniqueElements[i], uniqueElements[j]);
        general.bondLengths[pair] = { min: 0.0, max: defaultValue };
        general.defaultBondLengths[pair] = { min: 0.0, max: defaultValue }; // Store default
      }

      // Initialize bond visibility if not set
      if (general.bondVisibility[pair] === undefined) {
        general.bondVisibility[pair] = true;
      }
    }
  }
}

/** Drop the playback candidate bonds (render/PlaybackBondsModule.js), if any. */
export function disposeBondCandidatesMesh() {
  const mesh = groups.bondsCandidateMesh;
  if (!mesh) return;
  mesh.geometry.dispose();
  if (!isPersistentMaterial(mesh.material)) mesh.material.dispose();
  mesh.parent?.remove(mesh);
  groups.bondsCandidateMesh = null;
}

export function disposeBondsMesh(clearBondData = false) {
  // Candidates belong to the bond topology being replaced.
  disposeBondCandidatesMesh();
  if (groups.bondsMesh) {
    // A pipeline-owned transparent-instance overlay (userData.transparentOverlay)
    // goes down with the mesh — same handling as rebuildAtoms.
    const overlay = groups.bondsMesh.userData.transparentOverlay;
    if (overlay) {
      overlay.parent?.remove(overlay);
      if (overlay.geometry !== groups.bondsMesh.geometry) overlay.geometry.dispose();
      if (!isPersistentMaterial(overlay.material)) overlay.material.dispose();
    }
    groups.bondsMesh.geometry.dispose();
    // The main bonds material survives rebuilds (MaterialStyles.acquirePersistentMaterial).
    if (!isPersistentMaterial(groups.bondsMesh.material)) groups.bondsMesh.material.dispose();
    app.scene.remove(groups.bondsMesh);
    groups.bondsMesh = null;
  }
  if (clearBondData && fileBrowser.selectedStructure) {
    fileBrowser.selectedStructure.bonds = [];
    fileBrowser.selectedStructure.bondMapping = {};
    fileBrowser.selectedStructure.bondObjectMapping = {};
    fileBrowser.selectedStructure.bondhalfToAtom = {};
  }
  for (const key in bondLengths) delete bondLengths[key];
  for (const key in coordinationNumbers) delete coordinationNumbers[key];
  refreshBondLengthHistogram({});
  refreshCoordinationHistogram({});
}


export function rebuildBonds(opacity=1.0) {
  initBondsLengths() // this needs to be called once in general. Otherwise the sliders do nothing
  if (!general.showBonds) {
    disposeBondsMesh(true);
    return;
  }
  disposeBondsMesh(true);
  // Timings only under general.mdProfile: console.time/log on every full
  // trajectory or MD frame was measurable work and console noise.
  const t0 = general.mdProfile ? performance.now() : 0;
  buildBondObjects(fileBrowser.selectedStructure)
  const t1 = general.mdProfile ? performance.now() : 0;
  renderBonds();
  const t2 = general.mdProfile ? performance.now() : 0;
  updateBonds(opacity);
  if (general.mdProfile) {
    console.log(`[bonds] ${fileBrowser.selectedStructure.bonds.length} bonds: build ${(t1 - t0).toFixed(1)} ms, `
      + `render ${(t2 - t1).toFixed(1)} ms, update ${(performance.now() - t2).toFixed(1)} ms`);
  }
  if (groups.bondsMesh) {
    groups.bondsMesh.visible = !!general.showBonds;
  }
  // instanceIds are only assigned in renderBonds() above, so the histogram
  // data (which carries them for click-to-highlight) is populated here, not
  // inside buildBondObjects().
  //
  // Skipped entirely when neither histogram window is open: this walks every
  // bond building per-pair arrays, and during MD it runs on every bond-topology
  // rebuild. A window nobody is looking at should cost nothing — the panels
  // call refreshBondHistogramData() themselves when they open.
  refreshBondHistogramData();
}

/** Drawn atoms (periodic images included) from which a full atoms + bonds
 *  rebuild takes noticeable time — about 0.3 s at 2·10^4, seconds at 2·10^5.
 *  There the busy strip (TracerProgressModule.js) runs during rebuilds, a
 *  settle keeps the playback topology (FastFrameModule.js) and the heavy
 *  display toggles lock during playback (ui/HeavyRebuild.js). */
export const LARGE_REBUILD_ATOMS = 20000;

// Debounced bond-geometry refresh: anything that changes RENDERED atom radii
// (the global Atom Size slider, per-species/per-atom/per-copy Size edits)
// invalidates the clipped bond lengths (Bond.r1/r2 bake the radii in).
// Cheap live feedback stays with the caller; the heavier rebuild runs once
// the edits settle — on a large structure with the busy strip running from
// the edit until it is done.
let bondRebuildTimer = null;
let bondRebuildBusy = false;
export function scheduleBondRebuild(delayMs = 200) {
  if (bondRebuildTimer) clearTimeout(bondRebuildTimer);
  if (!bondRebuildBusy && (groups.atomsMesh?.count ?? 0) >= LARGE_REBUILD_ATOMS) {
    bondRebuildBusy = true;
    showBusyProgress();
  }
  bondRebuildTimer = setTimeout(() => {
    bondRebuildTimer = null;
    try {
      rebuildBonds(general.mainOpacity ?? 1);
      // The in-wedge rings are sized off the atoms, so they follow too.
      refreshAsuHighlight();
    } finally {
      if (bondRebuildBusy) {
        bondRebuildBusy = false;
        hideBusyProgress();
      }
    }
    // Rendering is on demand, and this runs from a timer — after the input
    // event whose catch-all listener already painted its frame. Without this
    // the rebuilt bonds stay undrawn until something else (a camera move)
    // invalidates the frame.
    requestRender();
  }, delayMs);
}

export function getBondCutoff(elem1, elem2) {
  const pair = elem1 < elem2 ? `${elem1}-${elem2}` : `${elem2}-${elem1}`;
  const isVisible = general.bondVisibility[pair] !== false;
  if (!isVisible) return 0.0;
  return general.bondLengths[pair]?.max || 0.0;
}

// The configured pair cutoff by bond LENGTH settings only — ignores the
// per-pair visibility checkbox (and the global Show Bonds toggle, which never
// enters here). Used by the polyhedra compute: polyhedra follow the configured
// bond distances regardless of whether the bonds are drawn.
export function getBondLengthCutoff(elem1, elem2) {
  const pair = elem1 < elem2 ? `${elem1}-${elem2}` : `${elem2}-${elem1}`;
  return general.bondLengths[pair]?.max || 0.0;
}

export function getBondMinCutoff(elem1, elem2) {
  const pair = elem1 < elem2 ? `${elem1}-${elem2}` : `${elem2}-${elem1}`;
  const isVisible = general.bondVisibility[pair] !== false;
  if (!isVisible) return 0.0;
  return general.bondLengths[pair]?.min || 0.0;
}

export function getActiveCutPlanes() {
  return (general.atomCutPlanes || []).filter((plane) => plane?.enabled);
}

function normalizeCutPlaneNormal(x = 1, y = 0, z = 0) {
  const nx = Number(x) || 0;
  const ny = Number(y) || 0;
  const nz = Number(z) || 0;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-8) {
    return [1, 0, 0];
  }
  return [nx / length, ny / length, nz / length];
}

export function isPointCutByPlanes(position, cutPlanes) {
  if (!Array.isArray(position) || position.length < 3) return false;

  return cutPlanes.some((plane) => {
    const [nx, ny, nz] = normalizeCutPlaneNormal(plane.x, plane.y, plane.z);
    const maskSign = getCutPlaneMaskSign(plane.side);
    const planeSide = ((position[0] * nx) + (position[1] * ny) + (position[2] * nz) - (Number(plane.r) || 0)) * maskSign;
    return planeSide > CUT_PLANE_TOLERANCE;
  });
}

export function isBondCutByPlanes(bond, cutPlanes) {
  if (!cutPlanes.length || !bond?.srcIndices || !bond.hasEndpoints) return false;

  // Per-pair cut immunity (Bonds tab header toggle).
  const [e1, e2] = bond.elements;
  if (general.bondCutImmunity?.[e1 < e2 ? `${e1}-${e2}` : `${e2}-${e1}`]) return false;

  const atoms = fileBrowser.selectedStructure?.atoms;
  if (!atoms) return false;

  const atomA = atoms[bond.srcIndices[0]];
  const atomB = atoms[bond.srcIndices[1]];

  const firstCut = !atomA?.cutPlaneImmune && isPointCutByPlanes([bond.ex1, bond.ey1, bond.ez1], cutPlanes);
  const secondCut = !atomB?.cutPlaneImmune && isPointCutByPlanes([bond.ex2, bond.ey2, bond.ez2], cutPlanes);

  return firstCut || secondCut;
}

// Canonical persistent key for a bond within a fixed wrapped set: the sorted
// wrapped-index pair. bond.uuid is NOT usable (random suffix, changes per rebuild).
export function bondKey(indices) {
  return indices[0] <= indices[1] ? `${indices[0]}_${indices[1]}` : `${indices[1]}_${indices[0]}`;
}

/**
 * Group key identifying all periodic-image copies of one physical bond: the
 * sorted source-atom pair plus the (canonicalized, quantized) fractional bond
 * vector. Copies are whole-bond integer-lattice translations, so the vector is
 * invariant across copies (to fp noise, far below the 1e-3 quantum). Used by
 * the Bonds tab when "Link periodic copies" is on.
 * @param {any} structure
 * @param {any} bond
 * @returns {string}
 */
export function bondGroupKey(structure, bond) {
  const frac = structure?.periodic?.visibleWrapped?.frac;
  const fi = frac?.[bond.indices[0]];
  const fj = frac?.[bond.indices[1]];
  if (!fi || !fj) return `nofrac:${bondKey(bond.indices)}`; // degrades to per-copy
  let [sa, sb] = bond.srcIndices;
  let v = [fj[0] - fi[0], fj[1] - fi[1], fj[2] - fi[2]];
  let flip = false;
  if (sa > sb) {
    const t = sa; sa = sb; sb = t;
    flip = true;
  } else if (sa === sb) {
    // Self-image bond: canonicalize the vector's sign.
    for (const c of v) {
      if (Math.abs(c) > 1e-6) { flip = c < 0; break; }
    }
  }
  if (flip) v = [-v[0], -v[1], -v[2]];
  const q = v.map((x) => Math.round(x * 1000) || 0); // `|| 0` normalizes -0
  return `${sa}_${sb}:${q.join(',')}`;
}

// Bond ids: unique per bond and per build, NOT registered in the global usedIDs
// set. Nothing looks a bond up by id (pairs are keyed by srcIndex/shift, see
// bondPairKey; picking goes through bondObjectMapping) — they only fill the
// instanceUUID attribute — and registering then releasing one per bond on
// every rebuild was a quarter of the bond rebuild at tens of thousands of
// bonds. Same scheme as materializeFrame's atom ids: a random base per build
// plus the index (and a counter, so two builds in one millisecond differ).
let bondBuildCounter = 0;
function bondIdBase() {
  bondBuildCounter = (bondBuildCounter + 1) % 1296;
  return Math.random().toString(36).slice(2, 7).padEnd(5, '0') + bondBuildCounter.toString(36);
}

/** Pairs closer than this (Å, squared) are never bonds (coincident sites). */
export const BOND_MIN_DIST_SQ = 0.005 * 0.005;

/**
 * Per-element-pair bond cutoff tables over the elements of a wrapped set.
 * @param {string[]} wrappedElements
 * @returns {{uniqueElems: string[], atomElemIdx: Int32Array, nu: number,
 *   cutoffSqFlat: Float64Array, minCutoffSqFlat: Float64Array, maxCutoff: number}}
 */
export function bondElementTables(wrappedElements) {
  const n = wrappedElements.length;
  // Map atoms -> small element index, and build flat symmetric cutoff^2 / minCutoff^2
  // matrices over the unique elements present in the wrapped set (flat so the same arrays
  // serve the WASM pair finder and the JS fallback).
  const uniqueElems = [...new Set(wrappedElements)];
  const elemIndexOf = new Map(uniqueElems.map((e, k) => [e, k]));
  const nu = uniqueElems.length;
  const cutoffSqFlat = new Float64Array(nu * nu);
  const minCutoffSqFlat = new Float64Array(nu * nu);
  let maxCutoff = 0;
  for (let a = 0; a < nu; a++) {
    for (let b = 0; b < nu; b++) {
      const c = getBondCutoff(uniqueElems[a], uniqueElems[b]);
      const mc = getBondMinCutoff(uniqueElems[a], uniqueElems[b]);
      cutoffSqFlat[a * nu + b] = c * c;
      minCutoffSqFlat[a * nu + b] = mc * mc;
      if (c > maxCutoff) maxCutoff = c;
      if (b >= a && c <= 0.01) {
        console.log("Bond Cutoff too small for", uniqueElems[a], uniqueElems[b], c);
      }
    }
  }
  const atomElemIdx = new Int32Array(n);
  for (let i = 0; i < n; i++) atomElemIdx[i] = elemIndexOf.get(wrappedElements[i]);
  return { uniqueElems, atomElemIdx, nu, cutoffSqFlat, minCutoffSqFlat, maxCutoff };
}

export function buildBondObjects(structure){
  const _t0 = performance.now();
  structure.bonds = [];
  structure.bondMapping = {};
  structure.bondObjectMapping = {};
  // Per-bond user styles (structure.bondUserStyles) intentionally survive rebuilds;
  // the mesh and any bond selection do not.
  structure.bondUserStyles ??= {};
  structure.bondCategoryStyles ??= {};
  general.bondsBuildCounter = (general.bondsBuildCounter || 0) + 1;
  highlightHover.currentlyHighlightedBond = null;

  const wrapped = structure.periodic.visibleWrapped;
  const wrappedCart = wrapped.cart;

  // First pass: create all bonds.
  //
  // This is the hot path for large structures: it is O(N^2) over the wrapped
  // atom set. To keep the inner loop cheap we (1) precompute the per-element-pair
  // cutoffs once (they don't depend on position), keyed by a small integer
  // element index so the inner loop avoids string building and Map/object
  // lookups; (2) compare *squared* distances so the rejected majority of pairs
  // never pay a sqrt; and (3) only allocate (the Bond, which recomputes the real
  // distance from positions) for pairs that actually bond. Previously each pair
  // allocated two THREE.Vector3, called distanceTo (sqrt), and rebuilt the cutoff
  // strings — and pairs with cutoff <= 0.01 hit a per-pair console.log.
  const n = wrappedCart.length;
  const wrappedElements = wrapped.elements;
  const minDistSq = BOND_MIN_DIST_SQ;

  const { uniqueElems, atomElemIdx, nu, cutoffSqFlat, minCutoffSqFlat, maxCutoff } = bondElementTables(wrappedElements);

  // Bond breaking tolerance (render/BondBreakTolerance.js): during playback a
  // bond drawn in the last frame is kept up to cutoff × (1 + tol), so the
  // search runs with the widened cutoffs and the pairs beyond the strict
  // cutoff are kept only when they were drawn (filtered below). Without a
  // memory (fresh load, tolerance 0) the search is the strict one.
  const held = heldBondKeys(structure);
  const holdSq = held ? toleranceFactorSq() : 1;
  const searchCutoffSqFlat = held ? cutoffSqFlat.map((c) => c * holdSq) : cutoffSqFlat;
  const searchMaxCutoff = held ? maxCutoff * Math.sqrt(holdSq) : maxCutoff;

  const _tSetup = performance.now();

  // ---- Find bonding pairs (i<j): WASM cell list (O(n)) with JS O(n²) fallback ----
  let pairI = null, pairJ = null;
  let bondPath = 'js';
  if (general.useWasmBonds && maxCutoff > 0.01) {
    try {
      const cartFlat = new Float64Array(3 * n);
      for (let i = 0; i < n; i++) {
        cartFlat[3 * i] = wrappedCart[i][0];
        cartFlat[3 * i + 1] = wrappedCart[i][1];
        cartFlat[3 * i + 2] = wrappedCart[i][2];
      }
      const elemIdxU32 = new Uint32Array(n);
      for (let i = 0; i < n; i++) elemIdxU32[i] = atomElemIdx[i];
      const { i: pi, j: pj } = computeBondPairsWasm({
        cartFlat, elemIdx: elemIdxU32, cutoffSqFlat: searchCutoffSqFlat, minCutoffSqFlat,
        nElem: nu, minDistSq, maxCutoff: searchMaxCutoff,
      });
      pairI = pi; pairJ = pj;
      bondPath = 'wasm';
    } catch (err) {
      console.warn('[buildBondObjects] WASM bonds failed; falling back to JS:', err);
      pairI = null;
    }
  }
  if (!pairI) {
    const ii = [], jj = [];
    for (let i = 0; i < n; i++) {
      const pi = wrappedCart[i];
      const xi = pi[0], yi = pi[1], zi = pi[2];
      const ai = atomElemIdx[i];
      const cutBase = ai * nu;
      for (let j = i + 1; j < n; j++) {
        const bj = atomElemIdx[j];
        const cutSq = searchCutoffSqFlat[cutBase + bj];
        if (cutSq <= 0.0001) continue;
        const pj = wrappedCart[j];
        const dx = xi - pj[0], dy = yi - pj[1], dz = zi - pj[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > cutSq || distSq < minDistSq || distSq < minCutoffSqFlat[cutBase + bj]) continue;
        ii.push(i); jj.push(j);
      }
    }
    pairI = ii; pairJ = jj;
  }

  if (held) ({ pairI, pairJ } = keepHeldPairs(structure, wrapped, pairI, pairJ, held, atomElemIdx, nu, cutoffSqFlat));

  const _tPairs = performance.now();

  // ---- Build Bond objects from the pairs (colour / id logic; O(bonds)) ----
  structure.bonds = createModeColoredBonds(structure, wrapped, pairI, pairJ,
    { uniqueElems, atomElemIdx, nu, cutoffSqFlat });

  const _ms = (x) => x.toFixed(1);
  console.log(
    `[bonds] n=${n} pairs=${pairI.length} path=${bondPath} | ` +
    `setup=${_ms(_tSetup - _t0)} find=${_ms(_tPairs - _tSetup)} build=${_ms(performance.now() - _tPairs)} ` +
    `total=${_ms(performance.now() - _t0)}ms`
  );

  // Second pass: handle length-based coloring if in length mode
  if (general.bondsColor === "length" && structure.bonds.length > 0) {
    // Calculate min/max bond lengths if not already set
    let minLength = general.BondMin;
    let maxLength = general.BondMax;

    if (minLength >= maxLength) {
      // Auto-calculate range from actual bond lengths
      minLength = Infinity;
      maxLength = -Infinity;
      structure.bonds.forEach(bond => {
        if (bond.dist < minLength) minLength = bond.dist;
        if (bond.dist > maxLength) maxLength = bond.dist;
      });
      // Ensure we don't have division by zero
      if (minLength === maxLength) {
        maxLength = minLength + 1;
      }
      general.BondMin = minLength;
      general.BondMax = maxLength;
    }

    // Apply color mapping based on bond lengths — the Colors panel's binning
    // (ColorMapBins.js, log scale included) and the playback fast path's.
    const table = colorMapTable(general.bondsColorMap || "heatmap");
    if (table.n > 0) {
      const useLog = general.bondColorScale === "log";
      structure.bonds.forEach(bond => {
        const color = table.hex[colorBin(bond.dist, minLength, maxLength, table.n, useLog)];
        bond.color = [color, color];
      });
    }
  }

  applyBondStyleOverrides(structure, structure.bonds);
}

/**
 * Of the pairs found with the widened cutoffs, keep every pair within its
 * strict cutoff and, beyond it, those the bond breaking tolerance holds: drawn
 * in the last playback frame (`held`, render/BondBreakTolerance.js). The
 * search already bounded them by cutoff × (1 + tol).
 */
function keepHeldPairs(structure, wrapped, pairI, pairJ, held, atomElemIdx, nu, cutoffSqFlat) {
  const col = pendingFramePositions(structure);
  const atoms = col ? null : peekAtoms(structure);
  const nSrc = col ? col.length / 3 : (atoms?.length ?? 0);
  const pos = sourceFracReader(col, atoms);
  const cart = wrapped.cart;
  const ii = [], jj = [];
  for (let k = 0; k < pairI.length; k++) {
    const i = pairI[k], j = pairJ[k];
    const pi = cart[i], pj = cart[j];
    const dx = pi[0] - pj[0], dy = pi[1] - pj[1], dz = pi[2] - pj[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > cutoffSqFlat[atomElemIdx[i] * nu + atomElemIdx[j]]
        && !held.has(instancePairKey(nSrc, wrapped, pos, i, j))) continue;
    ii.push(i); jj.push(j);
  }
  return { pairI: ii, pairJ: jj };
}

/**
 * Bond objects for the given wrapped-instance pairs, coloured by the current
 * bond colour mode (white / solid / element or atom colours; "length" gets the
 * element default here — buildBondObjects maps lengths afterwards). Shared by
 * buildBondObjects and the playback candidate bonds (PlaybackBondsModule.js),
 * so a bond that forms during playback looks exactly like one a rebuild makes.
 * @param {any} structure
 * @param {any} wrapped the visible wrapping the pair indices refer to
 * @param {ArrayLike<number>} pairI @param {ArrayLike<number>} pairJ
 * @param {{uniqueElems: string[], atomElemIdx: Int32Array, nu: number, cutoffSqFlat: Float64Array}} ctx
 * @returns {any[]}
 */
export function createModeColoredBonds(structure, wrapped, pairI, pairJ, ctx) {
  const { uniqueElems, atomElemIdx, nu, cutoffSqFlat } = ctx;
  const wrappedCart = wrapped.cart;
  const wrappedSrcIndex = wrapped.srcIndex;
  const out = [];
  if (!pairI.length) return out;
  // Colours and radius scales only (positions come from the wrapping): no need
  // to apply a deferred trajectory frame switch first (model/materializeFrame.js).
  const atoms = peekAtoms(fileBrowser.selectedStructure);
  const ownAtoms = peekAtoms(structure);
  // The clipped bond geometry must meet each endpoint at its RENDERED radius:
  // per-copy Size overrides win over the source atom's radiusScale. (No
  // per-copy styles at all is the usual case: skip the lookup per bond end.)
  const anyImageStyles = hasAtomImageStyles(structure);
  const endpointScale = (imageIndex, srcIndex) =>
    (anyImageStyles ? getAtomImageStyle(structure, imageIndex)?.radiusScale : undefined)
      ?? ownAtoms?.[srcIndex]?.getRadiusScale?.() ?? 1;
  const idBase = bondIdBase();
  // Each atom's representative colour once, not once per bond end.
  const repColors = new Map();
  const repColor = (src) => {
    let c = repColors.get(src);
    if (c === undefined) { c = atoms[src].getRepresentativeColor(); repColors.set(src, c); }
    return c;
  };
  // Per element pair, shared by its bonds (never written in place): the
  // elements, default colours and id prefix. With the scratch arrays the
  // constructor only reads, a bond allocates little beyond itself — at 10^5
  // bonds the garbage collector was most of a rebuild.
  const pairInfo = new Array(nu * nu);
  const noUserColor = [null, null];
  const noPositions = [];
  const coords = new Float64Array(6);
  const radiusScales = [1, 1];
  // One options object for every bond: the constructor reads it, keeps none of it.
  const opts = {
    elements: null, positions: noPositions, coords, defaultColor: null, userColor: noUserColor,
    uuidPrefix: '', uuidIndex: 0, indexA: 0, indexB: 0, srcA: 0, srcB: 0, radiusScales,
  };
  for (let k = 0; k < pairI.length; k++) {
    const i = pairI[k], j = pairJ[k];
    const pi = wrappedCart[i], pj = wrappedCart[j];
    const t = atomElemIdx[i] * nu + atomElemIdx[j];
    let info = pairInfo[t];
    if (!info) {
      const ei = uniqueElems[atomElemIdx[i]];
      const ej = uniqueElems[atomElemIdx[j]];
      info = pairInfo[t] = { elements: [ei, ej], defaultColor: bondDefaultColor(ei, ej), uuidPrefix: `${ei}-${ej}-${idBase}b` };
    }
    coords[0] = pi[0]; coords[1] = pi[1]; coords[2] = pi[2];
    coords[3] = pj[0]; coords[4] = pj[1]; coords[5] = pj[2];
    const si = wrappedSrcIndex[i], sj = wrappedSrcIndex[j];
    radiusScales[0] = endpointScale(i, si);
    radiusScales[1] = endpointScale(j, sj);
    opts.elements = info.elements;
    opts.defaultColor = info.defaultColor;
    opts.uuidPrefix = info.uuidPrefix;
    opts.uuidIndex = k;
    opts.indexA = i;
    opts.indexB = j;
    opts.srcA = si;
    opts.srcB = sj;
    const bond = new Bond(opts);
    // Element-pair cutoff (squared) so the fast frame path can hide a bond that
    // stretches past breaking without re-running pair finding.
    bond.cutoffSq = cutoffSqFlat[t];

    // Set bond colors based on current color mode
    if (general.bondsColor === "white") {
      bond.color = ["#ffffff", "#ffffff"];
    } else if (general.bondsColor === "solid") {
      bond.color = [general.solidBondColor || "#ffffff", general.solidBondColor || "#ffffff"];
    } else if (general.bondsColor === "length") {
      // Temporary color, will be updated in second pass (a copy: the
      // defaults are shared, bond.color is edited in place)
      bond.color = [bond.defaultColor[0], bond.defaultColor[1]];
    } else {
      // Default to element colors or atom colors. getRepresentativeColor(),
      // not the plain .color field: for a disordered endpoint that resolves
      // to whatever the representative species' OWN colour is (falling back
      // to the element default), so a per-species colour edit is visible on
      // the bond too, not only on the wedge sphere.
      if (atoms && si < atoms.length && sj < atoms.length) {
        bond.color = [repColor(si), repColor(sj)];
      } else {
        bond.color = [bond.defaultColor[0], bond.defaultColor[1]];
      }
    }

    out.push(bond);
  }

  return out;
}

/**
 * Category styles (Bonds-tab header dot), then persisted per-bond user styles
 * (structure.bondUserStyles), onto freshly built bonds — after all mode
 * colouring, so individual overrides win. Shared with the playback candidate
 * bonds (PlaybackBondsModule.js).
 * @param {any} structure @param {any[]} bonds
 */
export function applyBondStyleOverrides(structure, bonds) {
  // Category styles (Bonds-tab header dot) — applied after mode coloring and
  // BEFORE the per-copy bondUserStyles pass below, so individual overrides win.
  const categoryStyles = structure.bondCategoryStyles ?? {};
  if (Object.keys(categoryStyles).length) {
    for (const bond of bonds) {
      const [e1, e2] = bond.elements;
      const cs = categoryStyles[e1 < e2 ? `${e1}-${e2}` : `${e2}-${e1}`];
      if (!cs) continue;
      if (cs.color) {
        bond.color = [cs.color, cs.color];
        bond.userColor = [cs.color, cs.color]; // survives updateSingleBond repaints
      }
      if (cs.alpha != null) bond.alpha = cs.alpha;
      if (cs.radiusScale != null) bond.setRadius(general.bondRadius * cs.radiusScale);
    }
  }

  // Re-apply persisted per-bond user styles. Must run after ALL mode coloring
  // (including the length second pass above) so user colors win over any mode.
  // Note the asymmetry with atom recoloring: the per-atom color editor tints
  // attached bond halves via bond.userColor without persisting; per-bond styles
  // set here persist in structure.bondUserStyles and take precedence.
  const userStyles = structure.bondUserStyles ?? {};
  // Nearly always empty: skip building a key string per bond.
  if (!Object.keys(userStyles).length) return;
  for (const bond of bonds) {
    const saved = userStyles[bondKey(bond.indices)];
    if (saved && saved.elements[0] === bond.elements[0] && saved.elements[1] === bond.elements[1]) {
      if (saved.color) {
        bond.color = [saved.color, saved.color]; // one color for both halves
        bond.userColor = [saved.color, saved.color];
      }
      if (saved.alpha != null) bond.alpha = saved.alpha;
      if (saved.radiusScale != null) bond.setRadius(general.bondRadius * saved.radiusScale);
    }
  }

}

/**
 * Group key for populateBondHistogramData's dedup, below — deliberately NOT
 * the shared bondGroupKey() export (used elsewhere for the Bonds tab's "Link
 * periodic copies" display; out of scope here). It differs in exactly one
 * respect: bondGroupKey() canonicalizes a self-image bond's (srcA === srcB)
 * vector sign, so an atom's neighbor in the +x direction and its neighbor in
 * -x collapse to the same group — a fine simplification for showing one
 * representative row of a bond "type", but wrong for coordination number,
 * where +x and -x are two distinct neighbors (e.g. a simple-cubic atom's 6
 * nearest periodic images must not fold down to 3). This keeps every other
 * bond (srcA !== srcB) canonicalized exactly like bondGroupKey() — the same
 * physical bond found via (A,B) or (B,A) still merges — it just skips that
 * one extra canonicalization step for the self-image case.
 */
function histogramBondGroupKey(structure, bond) {
  const frac = structure?.periodic?.visibleWrapped?.frac;
  const fi = frac?.[bond.indices[0]];
  const fj = frac?.[bond.indices[1]];
  if (!fi || !fj) return `nofrac:${bondKey(bond.indices)}`;
  let [sa, sb] = bond.srcIndices;
  let v = [fj[0] - fi[0], fj[1] - fi[1], fj[2] - fi[2]];
  if (sa > sb) {
    [sa, sb] = [sb, sa];
    v = [-v[0], -v[1], -v[2]];
  }
  const q = v.map((x) => Math.round(x * 1000) || 0);
  return `${sa}_${sb}:${q.join(',')}`;
}

/**
 * Populate the bondLengths/coordinationNumbers histogram data. Must run
 * AFTER renderBonds() (bond.instanceIds is assigned there) — the click-to-
 * highlight histograms need real render instance ids, not just distances.
 * Bonds filtered out of the render (visibleLen too small) keep instanceIds
 * undefined and are simply left out of the highlight set for their bin.
 *
 * structure.bonds legitimately contains more than one Bond per PHYSICAL
 * neighbor relationship whenever a ghost atom is rendered nearby (every
 * rendered atom, ghost or real, needs its own correct set of bond
 * cylinders) — that's correct for rendering, but these histograms describe
 * the crystal's neighbor structure, not the render instance count, so
 * bonds are deduplicated here by histogramBondGroupKey() (see above) — a
 * "is this a lattice-translate of that bond" grouping like the Bonds tab's
 * "Link periodic copies" already uses — before tallying either histogram.
 * Only this function's own bookkeeping changes; structure.bonds itself (and
 * everything the renderer does with it) is untouched.
 */
/**
 * Recompute the bond-length / coordination histogram data from the current
 * structure and push it to whichever of those windows is open. A no-op when
 * both are closed. Exported so a panel can fill itself in on open, when the
 * data it skipped computing is finally wanted.
 */
export function refreshBondHistogramData() {
  if (!isBondLengthHistogramOpen() && !isCoordinationHistogramOpen()) return;
  if (!fileBrowser.selectedStructure) return;
  populateBondHistogramData(fileBrowser.selectedStructure);
  refreshBondLengthHistogram(bondLengths);
  refreshCoordinationHistogram(coordinationNumbers);
}

/** Live bond lookup by render instance id (one of bond.instanceIds), via the
 *  same bondObjectMapping renderBonds() builds for the Bonds tab rows and the
 *  colour-edit code. Used by bondDistanceLabels.js to read a bond's CURRENT
 *  positions/dist at click time — the histogram only stores instance ids, not
 *  positions, so this is the one place that resolves them back to a live bond. */
export function getBondByInstanceId(instanceId) {
  const structure = fileBrowser.selectedStructure;
  const mapping = structure?.bondObjectMapping?.[instanceId];
  if (!mapping) return null;
  return structure.bonds?.[mapping[0]] ?? null;
}

/** Standard uncertainty (Å) of a bond's length from the CIF's errors, or null
 *  when the structure has no read errors or an atom has moved off its CIF
 *  site (model/cifErrors.js). The two ends are the copies the bond joins, so a
 *  bond to a periodic image propagates through the right lattice translation.
 *  Used by the Bond Length Histogram's hover list and its distance labels. */
export function bondLengthSu(structure, bond) {
  if (!hasCifErrors(structure)) return null;
  const frac = structure.periodic?.visibleWrapped?.frac;
  const fa = frac?.[bond.indices?.[0]];
  const fb = frac?.[bond.indices?.[1]];
  if (!fa || !fb || !bond.srcIndices) return null;
  return distanceSu(structure,
    { atomIndex: bond.srcIndices[0], frac: [...fa] },
    { atomIndex: bond.srcIndices[1], frac: [...fb] });
}

function populateBondHistogramData(structure) {
  for (const key in bondLengths) delete bondLengths[key];
  for (const key in coordinationNumbers) delete coordinationNumbers[key];

  const cnByAtom = new Array(structure.atoms.length).fill(0);
  const seenGroups = new Map(); // histogramBondGroupKey -> that group's bondLengths entry

  for (const bond of structure.bonds) {
    const groupKey = histogramBondGroupKey(structure, bond);
    const existing = seenGroups.get(groupKey);

    if (existing) {
      // Same physical bond, rendered again for a different ghost pairing —
      // fold its render instance into the existing entry so a histogram bar
      // click still highlights every rendered copy, not just the first found.
      if (bond.instanceIds?.length) existing.instanceIds.push(...bond.instanceIds);
      continue;
    }

    const [a, b] = bond.elements[0].localeCompare(bond.elements[1]) <= 0
      ? [bond.elements[0], bond.elements[1]]
      : [bond.elements[1], bond.elements[0]];
    const pairKey = `${a}-${b}`;
    if (!bondLengths[pairKey]) bondLengths[pairKey] = [];
    // srcIndices lets the Bond Length Histogram label a bin's actual bonds
    // (hover list, distance labels) without re-deriving them from instanceIds.
    const entry = {
      dist: bond.dist,
      su: bondLengthSu(structure, bond), // null without read CIF errors
      instanceIds: bond.instanceIds ? [...bond.instanceIds] : [],
      srcIndices: [...bond.srcIndices],
    };
    bondLengths[pairKey].push(entry);
    seenGroups.set(groupKey, entry);

    // bond.indices is in the WRAPPED (periodic-image) index space used for
    // pair-finding/cut-plane masking — bond.srcIndices is the one that maps
    // back to structure.atoms, which is what coordination number needs. A
    // small/high-symmetry cell can bond an atom to its OWN periodic image
    // (both srcIndices the same atom) — that is one neighbor relationship
    // from that atom's perspective, so it counts once, not twice.
    const [srcA, srcB] = bond.srcIndices;
    cnByAtom[srcA]++;
    if (srcB !== srcA) cnByAtom[srcB]++;
  }

  structure.atoms.forEach((atom, i) => {
    if (atom.hidden) return;
    const el = structure.elements[i];
    if (!coordinationNumbers[el]) coordinationNumbers[el] = [];
    coordinationNumbers[el].push({ cn: cnByAtom[i], atomIndex: i });
  });
}
// Material for the bond InstancedMeshes and (in the WBOIT pipeline) their
// transparent-instance overlay pass. Carries the same generic uAlphaPass
// capability as createAtomsMaterial (0 = draw all — the default every
// pipeline except WBOIT leaves untouched, 1 = opaque instances only,
// 2 = transparent instances only); pipelines drive it via setAlphaPass
// (render/MaterialStyles.js).
export function createBondsMaterial() {
  const bondVisSettings = getBondVisSettings()
  const material = createStyledMaterial({
    ...bondVisSettings,
    transparent: false,
    opacity: 1.0,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute vec4 instanceUUID;
      varying vec4 vInstanceUUID;
      attribute vec3 instanceEmissive;
      attribute float instanceEmissiveIntensity;
      attribute float instanceElementIndex;
      attribute float instanceOpacity;
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying float vInstanceElementIndex;
      varying float vInstanceOpacity;
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
        #include <begin_vertex>
        vInstanceEmissive = instanceEmissive;
        vInstanceEmissiveIntensity = instanceEmissiveIntensity;
        vInstanceUUID = instanceUUID;
        vInstanceElementIndex = instanceElementIndex;
        vInstanceOpacity = instanceOpacity;
      `
    );

    shader.fragmentShader = `
      uniform int uAlphaPass;
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying vec4 vInstanceUUID;
      varying float vInstanceElementIndex;
      varying float vInstanceOpacity;
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `
      vec4 diffuseColor = vec4( diffuse, opacity * vInstanceOpacity );
      if (uAlphaPass == 1 && diffuseColor.a < 0.999) discard;
      if (uAlphaPass == 2 && diffuseColor.a >= 0.999) discard;
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
        totalEmissiveRadiance += vInstanceEmissive * vInstanceEmissiveIntensity;
      `
    );

    shader.uniforms.uAlphaPass = { value: material.userData.alphaPass ?? 0 };
    material.userData.shader = shader;
  };
  return material;
}

// Shared bonds InstancedMesh setup (geometry + material + emissive/UUID shader +
// per-half instance attributes), 2 halves per bond. Identical for the main and
// comparison ("second") bond meshes; the caller fills the instances in its own
// loop and stores the mesh at groups[...]. Returns the InstancedMesh.
export function createBondsMesh(bondCount, { persistent = false, zeroed = false } = {}) {
  // Geometry: unit cylinder along +Y
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);

  // Material: copy atom material logic. The MAIN bonds mesh reuses one
  // material across rebuilds (no shader recompile per frame); the overlay
  // structures' bond meshes keep their own, since each carries its own
  // opacity/transparency state.
  const material = persistent
    ? acquirePersistentMaterial('bonds', JSON.stringify([general.renderStyle, getBondVisSettings()]), createBondsMaterial)
    : createBondsMaterial();

  // Instanced mesh: 2 halves per bond. `zeroed`: the caller writes every
  // slot itself (or wants unwritten ones hidden), so skip three.js's
  // identity fill — one setMatrixAt per instance, a quarter of a second at
  // 10^5 bonds — and start from a zero (collapsed) buffer.
  let mesh;
  if (zeroed) {
    mesh = new THREE.InstancedMesh(geometry, material, 0);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(bondCount * 2 * 16), 16);
    mesh.count = bondCount * 2;
  } else {
    mesh = new THREE.InstancedMesh(geometry, material, bondCount * 2);
  }

  // rebuildBonds() always disposes and recreates this mesh, so its lazily
  // auto-computed per-instance bounding sphere (three.js InstancedMesh) would
  // normally stay correct. But updateBonds()/updateSingleBondPosition() and
  // FastFrameModule.js's applyFrameFast() both reposition instances on this
  // SAME mesh afterwards (cut-plane changes, live position edits, fast
  // trajectory stepping) without invalidating that cached sphere — same
  // latent cull bug as the spin/force arrows (SpinModule.js/ForceModule.js).
  mesh.frustumCulled = false;

  // Instance colors
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2*3), 3, false);

  // Emissive attributes
  mesh.geometry.setAttribute(
    'instanceEmissive',
    new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2*3), 3)
  );
  mesh.geometry.setAttribute(
    'instanceEmissiveIntensity',
    new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2), 1)
  );

  // Element index per half (optional, can be 0 for all)
  mesh.geometry.setAttribute(
    'instanceElementIndex',
    new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2), 1)
  );

  // Per-half opacity, default fully opaque. Initialized to 1 (not 0) because
  // the comparison bonds mesh shares this setup but never writes the attribute.
  mesh.geometry.setAttribute(
    'instanceOpacity',
    new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2).fill(1), 1)
  );

  // Participate in the screen-space cel outline pass (culled bonds are
  // zero-scaled, so they contribute no depth).
  mesh.layers.enable(CEL_OUTLINE_LAYER);

  // Hull mode: culled bonds are zero-scaled, which the hull follows via the
  // shared instanceMatrix. The opacity-discard variant drops the hull on
  // transparent bond halves (transparent objects get no outlines).
  if (general.renderStyle === 'cel' && general.celOutlineMode === 'hull') addCelOutline(mesh, { opacityDiscard: true });

  return mesh;
}

/**
 * bondObjectMapping for a bonds mesh: half h (0/1) of instance slot i maps to
 * [bondsIndexOf[i], h], an index into the unfiltered structure.bonds. Read
 * like the plain object it replaces (mapping[id], `id in mapping`,
 * Object.keys), but each [bond, half] pair is made on lookup: a stored pair
 * per half was 10^6 small arrays at 10^5 bonds, kept for the rare colour edit
 * or pick that reads one.
 * @param {Int32Array} bondsIndexOf
 */
function bondHalfTable(bondsIndexOf) {
  const halves = bondsIndexOf.length * 2;
  const halfOf = (key) => {
    if (typeof key !== 'string') return -1;
    const id = Number(key);
    return Number.isInteger(id) && id >= 0 && id < halves && String(id) === key ? id : -1;
  };
  const pair = (id) => [bondsIndexOf[id >> 1], id & 1];
  return new Proxy({}, {
    get: (target, key) => {
      const id = halfOf(key);
      return id >= 0 ? pair(id) : Reflect.get(target, key);
    },
    has: (target, key) => halfOf(key) >= 0 || Reflect.has(target, key),
    ownKeys: (target) => [...Array.from({ length: halves }, (_, id) => String(id)), ...Reflect.ownKeys(target)],
    getOwnPropertyDescriptor: (target, key) => {
      const id = halfOf(key);
      return id >= 0
        ? { value: pair(id), writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

export function renderBonds() {
  const structure = fileBrowser.selectedStructure;
  const bonds = fileBrowser.selectedStructure.bonds;
  const validBonds = bonds.filter(b => b.visibleLen > 1e-3);
 // console.warn("bonds",bonds,"validBonds",validBonds)
  const bondCount = validBonds.length;
 // console.log("Rendering", bondCount, "bonds");

  // Every slot is written by updateBonds right after (matrix or hidden).
  const mesh = createBondsMesh(bondCount, { persistent: true, zeroed: true });

  // instanceUUID: kept for attribute-layout parity with the atoms mesh, but
  // nothing reads it for bonds (picking goes through bondObjectMapping), so
  // it is no longer filled — packing an id string per half was a tenth of a
  // second per rebuild at 10^5 bonds.
  const uuidAttr = new Float32Array(bondCount*2*4);

  // Per-instance matrices, colours and emissive are written by updateBonds() — which
  // runs immediately after this in rebuildBonds(), with the precise quaternion alignment
  // and cut-plane culling, and would overwrite anything set here. So renderBonds only
  // does the work updateBonds does NOT: create the mesh, build the picking/lookup tables,
  // and fill the UUID attribute. This removes a full redundant matrix/colour pass over
  // every bond (the dominant cost on large structures).
  // bondObjectMapping must hold indices into the UNFILTERED structure.bonds array
  // (all consumers do structure.bonds[mapping[0]]), while the instance index i
  // runs over validBonds only.
  const bondsIndexOf = new Int32Array(bondCount);
  for (let k = 0, v = 0; k < bonds.length; k++) {
    if (bonds[k].visibleLen > 1e-3) bondsIndexOf[v++] = k;
  }

  // bondMapping lists (instance -> its bond halves) are sized up front: a
  // list grown by push starts at 17 slots, and most hold a handful.
  let maxKey = -1;
  for (const bond of validBonds) {
    if (!bond.hasCenters) continue;
    if (bond.indexA > maxKey) maxKey = bond.indexA;
    if (bond.indexB > maxKey) maxKey = bond.indexB;
  }
  const halvesPerKey = new Int32Array(maxKey + 1);
  for (const bond of validBonds) {
    if (!bond.hasCenters) continue;
    halvesPerKey[bond.indexA]++;
    halvesPerKey[bond.indexB]++;
  }
  const filled = new Int32Array(maxKey + 1).fill(-1); // -1: a list this pass did not create
  const addHalf = (key, half) => {
    let list = structure.bondMapping[key];
    if (!list) {
      list = structure.bondMapping[key] = new Array(halvesPerKey[key]);
      filled[key] = 0;
    }
    if (filled[key] >= 0) list[filled[key]++] = half;
    else list.push(half);
  };

  validBonds.forEach((bond, i) => {
    if (!bond.hasCenters) return;

    // Stable instance-index tag for the render fast path (applyFrameFast). Filtering
    // structure.bonds by the live visibleLen across frames is unsafe because
    // updateEndpoints mutates visibleLen; this fixed index (assigned once per
    // rebuild) is the authoritative bond -> instance-slot mapping the fast path uses.
    // It also gives bond.instanceIds, the reverse map bond -> its two
    // half-cylinder instance ids (the Bonds tab rows and the highlight code;
    // built on first read). Filtered-out bonds keep it undefined.
    bond.setRenderIndex(i);

    if (!structure.bondhalfToAtom) structure.bondhalfToAtom = {};
    structure.bondhalfToAtom[i * 2] = bond.srcA;
    structure.bondhalfToAtom[i * 2 + 1] = bond.srcB;
    addHalf(bond.indexA, i * 2);
    addHalf(bond.indexB, i * 2 + 1);
  });

  // Lookup table from bond half to its bond (colour changes, picking).
  structure.bondObjectMapping = bondHalfTable(bondsIndexOf);

  // Assign UUID attribute
  mesh.geometry.setAttribute('instanceUUID', new THREE.InstancedBufferAttribute(uuidAttr, 4));

  // Mark buffers as dynamic
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.needsUpdate = true;

  mesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  mesh.geometry.attributes.instanceElementIndex.needsUpdate = true;

  // Add to scene
  app.scene.add(mesh);
  groups.bondsMesh = mesh;
}

const _parsedBondColors = new Map();
function parsedBondColor(color) {
  let rgb = _parsedBondColors.get(color);
  if (!rgb) {
    if (_parsedBondColors.size > 4096) _parsedBondColors.clear();
    _bondColor.set(color);
    rgb = [_bondColor.r, _bondColor.g, _bondColor.b];
    _parsedBondColors.set(color, rgb);
  }
  return rgb;
}

// change the color of a bond "half  cylinder" with index bondMeshIndex to color "color" (hex)
export function updateSingleBondColor(bondMeshIndex, color, overwriteAtom = false) {
  const mesh = groups.bondsMesh;
  const structure = fileBrowser.selectedStructure;

  // Ensure bondhalfToAtom and atoms exist; good check but not really necessary to improve performance
  //if (!structure.bondhalfToAtom || !structure.atoms) {
  //  console.warn("bondhalfToAtom or atoms not initialized.");
  //  return;
   // }
  //

  const atomIndex = structure.bondhalfToAtom[bondMeshIndex];
  const atom = structure.atoms[atomIndex];

  // Determine the color to use
  let targetColor = overwriteAtom || atom.userColor == null ? color : atom.userColor;

  //console.log(bondMeshIndex,atom.userColor, overwriteAtom, targetColor)

  // Update bond half color. Parsed colours are cached by value: a rebuild
  // repaints every half with one of a handful of colours, and parsing the
  // string each time was a fifth of updateBonds at 10^5 bonds.
  const rgb = parsedBondColor(targetColor);
  mesh.instanceColor.setXYZ(bondMeshIndex, rgb[0], rgb[1], rgb[2]);
  mesh.instanceColor.needsUpdate = true;

}

/**
 * Re-derive and repaint the colour of every bond half touching any of the
 * given atoms, from their current getRepresentativeColor() — no topology
 * recompute, no dispose, no debounce, so it is cheap enough to call on every
 * pointer-move while dragging in a colour picker.
 *
 * This exists because scheduleBondRebuild() is the wrong tool for a colour-
 * only change: it is a full dispose-and-rebuild of the bond mesh (recomputing
 * every pair from distance cutoffs), debounced 200ms specifically so a burst
 * of unrelated edits collapses into one rebuild. A picker drag fires on every
 * mousemove, which kept RESETTING that debounce before it ever ran — so bond
 * colours never updated while actually dragging, only some time after
 * letting go, which read as "not really live."
 *
 * Only meaningful in "elements" (the default) bond-colour mode, where a
 * bond's colour is atom-derived at all; white/solid/length bonds are
 * deliberately independent of atom colour and are left untouched.
 *
 * @param {number[]} atomIndices
 */
export function refreshBondColorsForAtoms(atomIndices) {
  const structure = fileBrowser.selectedStructure;
  const mesh = groups.bondsMesh;
  if (!mesh || !structure?.bonds?.length) return;
  if (general.bondsColor && general.bondsColor !== "elements") return;

  const changed = new Set(atomIndices);
  let touched = false;
  structure.bonds.forEach((bond, i) => {
    if (!changed.has(bond.srcIndices[0]) && !changed.has(bond.srcIndices[1])) return;
    const a = structure.atoms[bond.srcIndices[0]];
    const b = structure.atoms[bond.srcIndices[1]];
    if (!a || !b) return;
    bond.color = [a.getRepresentativeColor(), b.getRepresentativeColor()];
    updateSingleBondColor(i * 2, bond.color[0]);
    updateSingleBondColor(i * 2 + 1, bond.color[1]);
    touched = true;
  });
  if (touched) requestRender();
}


export function updateSingleBondOpacity(bondMeshIndex, opacity = 1.0) {
  const mesh = groups.bondsMesh;
  if (!mesh) return;
  const normalizedOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
  mesh.geometry.attributes.instanceOpacity.setX(bondMeshIndex, normalizedOpacity);
  mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
  syncBondMaterialTransparency(general.mainOpacity);
}

function syncBondMaterialTransparency(baseOpacity = 1.0) {
  const mesh = groups.bondsMesh;
  if (!mesh?.material) return;
  const hasTransparentInstances = fileBrowser.selectedStructure?.bonds?.some((bond) =>
    (bond.alpha ?? 1) < 0.999) ?? false;
  const hasFocusTransparency = (fileBrowser.selectedStructure?.focusRegions ?? [])
    .some((region) => region.enabled !== false && region.center?.length);
  const needsTransparency = baseOpacity < 0.999 || hasTransparentInstances || hasFocusTransparency;
  applyTransparency(mesh.material, {
    kind: 'bonds', opacity: baseOpacity, needsTransparency, perInstanceOpacity: true, mesh,
  });
  syncCelHullOpacitySuppression(mesh, baseOpacity);
}

export function updateSingleBondPosition(index, bond) {
  writeBondMatrices(groups.bondsMesh.instanceMatrix.array, index, bond);
}

/**
 * Live bond-width change for ONE bond: re-clip the Bond (its length depends on
 * the radius — a wider cylinder meets the atom sphere further out) and repaint
 * both half-cylinder instances. Use this instead of a bare `bond.radius = …` +
 * updateSingleBondDiameter, which would leave the old length in place.
 *
 * A bond whose visibility flips (it now fits entirely inside its atoms, or was
 * unrendered and now clears them) has no valid instance slot to move into, so
 * the debounced full rebuild picks it up.
 */
export function applyBondRadius(bond, radius) {
  bond.setRadius(radius);
  const mesh = groups.bondsMesh;
  const idx = bond.renderIndex;
  const visible = bond.visibleLen > 1e-3 && bond.center1 && bond.center2;
  // renderIndex is -1 for a bond that is not drawn.
  if (!mesh || !Number.isInteger(idx) || idx < 0) {
    if (visible && general.showBonds) scheduleBondRebuild();
    return;
  }
  if (!visible) {
    hideSingleBond(idx);
    scheduleBondRebuild();
  } else {
    // A zero-scaled instance is hidden on purpose (cut plane, broken bond in
    // the fast frame path) — do not resurrect it.
    const m = mesh.instanceMatrix.array, o = idx * 2 * 16;
    if (m[o] === 0 && m[o + 1] === 0 && m[o + 2] === 0) return; // x column = 0 scale
    updateSingleBondPosition(idx, bond);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export function updateSingleBondDiameter(instanceIndex, newRadius) {
  const mesh = groups.bondsMesh;
  const dummy = new THREE.Object3D();

  // Get the current matrix for the instance
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(instanceIndex, matrix);

  // Decompose the matrix to extract position, rotation, and scale
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);

  // Update only the x and z components of the scale (diameter)
  scale.set(newRadius, scale.y, newRadius);

  // Recompose the matrix with the updated scale
  dummy.position.copy(position);
  dummy.quaternion.copy(rotation);
  dummy.scale.copy(scale);
  dummy.updateMatrix();

  // Set the updated matrix back to the instance
  mesh.setMatrixAt(instanceIndex, dummy.matrix);

  // Flag the mesh for update
  mesh.instanceMatrix.needsUpdate = true;
}




export function updateSingleBond(index, bond, overwriteAtom=false){
  const mesh = groups.bondsMesh;
  writeBondMatrices(mesh.instanceMatrix.array, index, bond);

  // ---- first half ----

  // A per-bond user color must survive repaints even when the atom has a
  // userColor (bond userColor > atom userColor > mode color).
  updateSingleBondColor(index*2, bond.color[0], overwriteAtom || bond.userColor?.[0] != null)

  mesh.geometry.attributes.instanceEmissive.setXYZ(index*2, 0,0,0);
  mesh.geometry.attributes.instanceEmissiveIntensity.setX(index*2, 0);
  // Carries the half's own instance id so the shader can look up that
  // endpoint's species in the wedge texture (was an unused constant 0).
  mesh.geometry.attributes.instanceElementIndex.setX(index*2, index*2);
  const focusOpacity = Math.min(
    getFocusOpacityForInstance(bond.indexA),
    getFocusOpacityForInstance(bond.indexB),
  );
  mesh.geometry.attributes.instanceOpacity.setX(index*2,
    Math.max(0, Math.min(1, bond.alpha ?? 1)) * focusOpacity);

  // ---- second half ----
  updateSingleBondColor(index*2+1, bond.color[1], overwriteAtom || bond.userColor?.[1] != null)

  mesh.geometry.attributes.instanceEmissive.setXYZ(index*2 + 1, 0,0,0);
  mesh.geometry.attributes.instanceEmissiveIntensity.setX(index*2 + 1, 0);
  mesh.geometry.attributes.instanceElementIndex.setX(index*2 + 1, index*2 + 1);
  mesh.geometry.attributes.instanceOpacity.setX(index*2 + 1,
    Math.max(0, Math.min(1, bond.alpha ?? 1)) * focusOpacity);
}

export function hideSingleBond(index) {
  const mesh = groups.bondsMesh;
  if (!mesh) return;
  writeHiddenBondHalf(mesh.instanceMatrix.array, index * 2);
  writeHiddenBondHalf(mesh.instanceMatrix.array, index * 2 + 1);
}

export async function updateBonds(opacity=1.0) {
  const mesh = groups.bondsMesh;
  if (!mesh) return;
  mesh.visible = !!general.showBonds;
  if (!general.showBonds) return;

  const bonds = fileBrowser.selectedStructure.bonds.filter(b => b.visibleLen > 1e-3);
  const activeCutPlanes = getActiveCutPlanes();

  // updateSingleBond's own default lets an atom's userColor win over bond.color
  // (right for "elements" mode, where bond.color IS meant to track the atom) —
  // but in white/solid/length mode bond.color is intentionally NOT atom-derived,
  // so an atom's custom color must not leak onto its bonds there. Mirrors
  // ui/ColorPanel.js's bondsFollowAtomColors() gate for the same reason.
  const overwriteAtomColor = general.bondsColor !== "elements" && general.bondsColor != null;

  bonds.forEach((bond, i) => {
    if (isBondCutByPlanes(bond, activeCutPlanes)) {
      hideSingleBond(i);
      return;
    }
    updateSingleBond(i, bond, overwriteAtomColor);
  });
  mesh.material.opacity = opacity;
  // Transparency also accounts for per-bond alpha overrides (instanceOpacity).
  syncBondMaterialTransparency(opacity);

  // mark all attributes as needing update
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  mesh.geometry.attributes.instanceElementIndex.needsUpdate = true;
  mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
  // NOTE: material.needsUpdate is intentionally NOT set here — this loop only writes
  // per-instance matrices/colours/attributes. syncBondMaterialTransparency()
  // flags the material only when the transparency mode actually changes.
}
