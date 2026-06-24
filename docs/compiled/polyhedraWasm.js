/**
 * computePolyhedra – WASM-backed implementation of the polyhedra compute core.
 *
 * The JS caller (render/PolyhedraModule.js) prepares the cheap, display-coupled
 * inputs (visible centre images, visible image keys, seed visibility, the bond
 * cutoff lookup) and this module marshals them into flat typed arrays, calls the
 * Rust `compute_polyhedra`, and unpacks the accepted polyhedra back into the
 * plain objects the `Polyhedron` model constructor expects.
 *
 * The wasm module is shared with periodicWrapped; its wasm-bindgen `init` guard
 * is idempotent, so initialising here is a no-op if LatticeModule already did it.
 */

import init, { compute_polyhedra } from './periodic_wasm.js';
import { electronegativity } from '../defaults/electronegativity_defaults.js';
import { atomicRadii } from '../defaults/radii_defaults.js';

// Initialise once at import (idempotent — returns the existing instance if the
// periodic path already initialised the module).
await init(new URL('./periodic_wasm_bg.wasm', import.meta.url));

/**
 * @param {{
 *   positions: number[][],
 *   elements: string[],
 *   lattice: number[][],
 *   maxCutoff: number,
 *   useChemicalFilter: boolean,
 *   detectCages: boolean,
 *   displayCenters: Array<{cart: {x:number,y:number,z:number}, src:number, shift:[number,number,number]}>,
 *   visibleImageKeys: Set<string>,
 *   seedVisible: Uint8Array,
 *   getBondCutoff: (a:string, b:string) => number,
 * }} prep
 * @returns {{polyhedra: Array<Object>, timing: {setup:number,centered:number,cages:number,cagePool:number,cageBand:number,cageNloop:number,accept:number}}}
 *          `polyhedra`: plain objects ready for `new Polyhedron(...)`.
 */
export function computePolyhedraWasm(prep) {
  const {
    positions, elements, lattice, maxCutoff,
    useChemicalFilter, detectCages,
    displayCenters, visibleImageKeys, seedVisible, getBondCutoff,
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

  // Visible image keys "<src>:<dx>,<dy>,<dz>" → flat [src,dx,dy,dz,...].
  const keyVals = [];
  for (const k of visibleImageKeys) {
    const colon = k.indexOf(':');
    const src = Number(k.slice(0, colon));
    const parts = k.slice(colon + 1).split(',');
    keyVals.push(src, Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  const visibleKeys = Int32Array.from(keyVals);

  const result = compute_polyhedra(
    fracFlat, elemIdx, latticeFlat, cutoffMatrix, nElem,
    electroneg, radii, maxCutoff, !!useChemicalFilter, !!detectCages,
    centerSrc, centerShift, centerCart, visibleKeys, seedVisible,
  );

  const count = result.count();
  const kinds = result.kinds();
  const colorElemArr = result.color_elem();
  const centerSrcArr = result.center_src();
  const vertCounts = result.vert_counts();
  const verts = result.vertices();
  const vsrcs = result.vertex_srcs();
  const timing = {
    setup: result.setup_ms(),
    centered: result.centered_ms(),
    cages: result.cages_ms(),
    cagePool: result.cage_pool_ms(),
    cageBand: result.cage_band_ms(),
    cageNloop: result.cage_nloop_ms(),
    accept: result.accept_ms(),
  };
  result.free();

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
  return { polyhedra: out, timing };
}
