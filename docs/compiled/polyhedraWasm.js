/**
 * computePolyhedra – WASM-backed implementation of the polyhedra compute core.
 *
 * The JS caller (render/PolyhedraModule.js) prepares the cheap, display-coupled
 * inputs (visible centre images, centre image keys, seed visibility, cut-plane
 * metadata, the bond cutoff lookup); `marshalPolyhedraInputs` packs them into
 * flat typed arrays.
 * `computePolyhedraWasm` runs the whole thing serially; the worker pool instead
 * sends those same inputs to workers (which call `compute_candidates`) and then
 * calls `callAcceptCandidates` here on the main thread to finish.
 *
 * The wasm module is shared with periodicWrapped; its wasm-bindgen `init` guard
 * is idempotent, so initialising here is a no-op if LatticeModule already did it.
 */

import init, { compute_polyhedra, accept_candidates } from './periodic_wasm.js';
import { electronegativity } from '../defaults/electronegativity_defaults.js';
import { atomicRadii } from '../defaults/radii_defaults.js';

// Initialise once at import (idempotent — returns the existing instance if the
// periodic path already initialised the module).
await init(new URL('./periodic_wasm_bg.wasm', import.meta.url));

/**
 * Marshal the display-coupled `prep` into flat typed-array WASM inputs. Shared by the
 * serial path and the worker pool (which posts `inputs` to each worker).
 *
 * @param {{
 *   positions: number[][], elements: string[], lattice: number[][], maxCutoff: number,
 *   useChemicalFilter: boolean, detectCages: boolean,
 *   displayCenters: Array<{cart:{x:number,y:number,z:number}, src:number, shift:[number,number,number]}>,
 *   centerImageKeys: Set<string>, seedVisible: Uint8Array, cutPlaneImmune: Uint8Array,
 *   cutPlaneData: number[][], getBondCutoff:(a:string,b:string)=>number,
 * }} prep
 * @returns {{idxToElem: string[], inputs: Object}}
 */
export function marshalPolyhedraInputs(prep) {
  const {
    positions, elements, lattice, maxCutoff,
    useChemicalFilter, detectCages,
    displayCenters, centerImageKeys, seedVisible, cutPlaneImmune, cutPlaneData, getBondCutoff,
  } = prep;

  const nAtoms = elements.length;

  // Distinct element species → contiguous indices.
  const elemToIdx = new Map();
  for (const el of elements) if (!elemToIdx.has(el)) elemToIdx.set(el, elemToIdx.size);
  const nElem = elemToIdx.size;
  const idxToElem = new Array(nElem);
  for (const [sym, idx] of elemToIdx) idxToElem[idx] = sym;

  const elemIdx = new Uint32Array(nAtoms);
  for (let i = 0; i < nAtoms; i++) elemIdx[i] = elemToIdx.get(elements[i]) ?? 0;

  const fracFlat = new Float64Array(3 * nAtoms);
  for (let i = 0; i < nAtoms; i++) {
    fracFlat[3 * i] = positions[i][0];
    fracFlat[3 * i + 1] = positions[i][1];
    fracFlat[3 * i + 2] = positions[i][2];
  }

  // Row-major lattice (rows a,b,c). The Rust side reads rows directly and does
  // a*fx + b*fy + c*fz, so — unlike periodicWrapped — we do NOT transpose here.
  const latticeFlat = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let cc = 0; cc < 3; cc++) latticeFlat[r * 3 + cc] = lattice[r][cc];
  }

  // Symmetric bond-cutoff matrix over the distinct species (respects the same
  // visibility/length rules as the JS path, since it goes through getBondCutoff).
  const cutoffMatrix = new Float64Array(nElem * nElem);
  const electroneg = new Float64Array(nElem);
  const radii = new Float64Array(nElem);
  for (let i = 0; i < nElem; i++) {
    electroneg[i] = electronegativity[idxToElem[i]] || 0;
    radii[i] = atomicRadii[idxToElem[i]] || 1.0;
    for (let j = 0; j < nElem; j++) {
      cutoffMatrix[i * nElem + j] = getBondCutoff(idxToElem[i], idxToElem[j]) || 0;
    }
  }

  // Visible centre images.
  const nC = displayCenters.length;
  const centerSrc = new Uint32Array(nC);
  const centerShift = new Int32Array(3 * nC);
  const centerCart = new Float64Array(3 * nC);
  for (let i = 0; i < nC; i++) {
    const dc = displayCenters[i];
    centerSrc[i] = dc.src;
    centerShift[3 * i] = dc.shift[0];
    centerShift[3 * i + 1] = dc.shift[1];
    centerShift[3 * i + 2] = dc.shift[2];
    centerCart[3 * i] = dc.cart.x;
    centerCart[3 * i + 1] = dc.cart.y;
    centerCart[3 * i + 2] = dc.cart.z;
  }

  // Centre image keys "<src>:<dx>,<dy>,<dz>" → flat [src,dx,dy,dz,...].
  const keyVals = [];
  for (const k of centerImageKeys) {
    const colon = k.indexOf(':');
    const src = Number(k.slice(0, colon));
    const parts = k.slice(colon + 1).split(',');
    keyVals.push(src, Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  const centerKeys = Int32Array.from(keyVals);

  const cutPlanesFlat = new Float64Array(5 * cutPlaneData.length);
  for (let i = 0; i < cutPlaneData.length; i++) {
    const plane = cutPlaneData[i];
    cutPlanesFlat[5 * i] = plane[0];
    cutPlanesFlat[5 * i + 1] = plane[1];
    cutPlanesFlat[5 * i + 2] = plane[2];
    cutPlanesFlat[5 * i + 3] = plane[3];
    cutPlanesFlat[5 * i + 4] = plane[4];
  }

  return {
    idxToElem,
    inputs: {
      fracFlat, elemIdx, latticeFlat, cutoffMatrix, nElem,
      electroneg, radii, maxCutoff: +maxCutoff,
      useChemicalFilter: !!useChemicalFilter, detectCages: !!detectCages,
      centerSrc, centerShift, centerCart, centerKeys, seedVisible,
      cutPlaneImmune, cutPlanesFlat, cutPlaneCount: cutPlaneData.length,
      nCenters: nC, nAtoms,
    },
  };
}

/**
 * Turn a WASM `PolyhedraResult` into the plain objects `new Polyhedron(...)` expects.
 * Does not free `result` — the caller owns it.
 * @param {any} result
 * @param {string[]} idxToElem
 * @returns {Array<Object>}
 */
function unpackAccepted(result, idxToElem) {
  const count = result.count();
  const kinds = result.kinds();
  const colorElemArr = result.color_elem();
  const centerSrcArr = result.center_src();
  const vertCounts = result.vert_counts();
  const verts = result.vertices();
  const vsrcs = result.vertex_srcs();

  const out = [];
  let vOff = 0, sOff = 0;
  for (let i = 0; i < count; i++) {
    const n = vertCounts[i];
    const vertices = new Array(n);
    const vertexSrcList = new Array(n);
    for (let k = 0; k < n; k++) {
      vertices[k] = [verts[3 * (vOff + k)], verts[3 * (vOff + k) + 1], verts[3 * (vOff + k) + 2]];
      vertexSrcList[k] = vsrcs[sOff + k];
    }
    vOff += n;
    sOff += n;
    const isCage = kinds[i] === 1;
    const colorElem = idxToElem[colorElemArr[i]];
    out.push({
      name: `${colorElem}${isCage ? '-cage' : ''}-CN${n}`,
      type: isCage ? 'cage' : 'centered',
      centerIndex: isCage ? null : (centerSrcArr[i] >= 0 ? centerSrcArr[i] : null),
      centerElement: isCage ? null : colorElem,
      colorElem,
      vertices,
      vertexSrcList,
    });
  }
  return out;
}

/**
 * Serial path: marshal, run the full Rust `compute_polyhedra`, unpack.
 * @returns {{polyhedra: Array<Object>, timing: Object}}
 */
export function computePolyhedraWasm(prep) {
  const { idxToElem, inputs: I } = marshalPolyhedraInputs(prep);
  const result = compute_polyhedra(
    I.fracFlat, I.elemIdx, I.latticeFlat, I.cutoffMatrix, I.nElem,
    I.electroneg, I.radii, I.maxCutoff, I.useChemicalFilter, I.detectCages,
    I.centerSrc, I.centerShift, I.centerCart, I.centerKeys, I.seedVisible,
    I.cutPlaneImmune, I.cutPlanesFlat, I.cutPlaneCount,
  );
  const timing = {
    setup: result.setup_ms(),
    centered: result.centered_ms(),
    cages: result.cages_ms(),
    cagePool: result.cage_pool_ms(),
    cageBand: result.cage_band_ms(),
    cageNloop: result.cage_nloop_ms(),
    accept: result.accept_ms(),
    bandsBuilt: result.bands_built(),
    bandsSkipped: result.bands_skipped(),
  };
  const polyhedra = unpackAccepted(result, idxToElem);
  result.free();
  return { polyhedra, timing };
}

/**
 * Parallel path, part 2 (main thread): accept the merged candidate arrays.
 * @param {{isCage:Uint8Array, colorElem:Uint32Array, centerSrc:Int32Array,
 *   centerShift:Int32Array, refPoint:Float64Array, vertCounts:Uint32Array,
 *   vertices:Float64Array, vertexSrcs:Uint32Array, vertexShifts:Int32Array}} merged
 * @param {string[]} idxToElem
 * @returns {Array<Object>}
 */
export function callAcceptCandidates(merged, idxToElem) {
  const result = accept_candidates(
    merged.isCage, merged.colorElem, merged.centerSrc, merged.centerShift, merged.refPoint,
    merged.vertCounts, merged.vertices, merged.vertexSrcs, merged.vertexShifts,
  );
  const polyhedra = unpackAccepted(result, idxToElem);
  result.free();
  return polyhedra;
}
