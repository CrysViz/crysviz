/**
 * Data-parallel polyhedra compute over a pool of Web Workers.
 *
 * Candidate generation is independent per display-centre (centered path) and per seed
 * atom (cage path), so we partition both ranges across `navigator.hardwareConcurrency`
 * module workers — each with its own WASM instance — collect their candidates, merge in
 * serial order (all centred, then all cage, in worker order), and run the single serial
 * acceptance pass on the main thread. Merging this way reproduces the serial insertion
 * order exactly, so results are identical to the single-threaded path.
 *
 * SharedArrayBuffer is unavailable on GitHub Pages (no COOP/COEP), so the inputs are
 * structure-cloned (copied) to each worker; the copy is O(workers × atoms) and fine here.
 */

import { marshalPolyhedraInputs, callAcceptCandidates } from '../compiled/polyhedraWasm.js';
import { runOnAll, available, size } from '../workers/workerPool.js';

/** True if Web Workers (and thus the parallel path) are usable in this environment. */
export function parallelAvailable() {
  return available() && size() > 0;
}

/** Partition [0,total) into `k` contiguous ranges [start,end). */
function partition(total, k) {
  const ranges = [];
  const base = Math.floor(total / k);
  const extra = total % k;
  let start = 0;
  for (let i = 0; i < k; i++) {
    const len = base + (i < extra ? 1 : 0);
    ranges.push([start, start + len]);
    start += len;
  }
  return ranges;
}

/**
 * Concatenate worker candidate results into one flat candidate set in serial order:
 * every worker's centred candidates (in worker order) first, then every worker's cage
 * candidates (in worker order). Per-candidate and per-vertex arrays are kept in sync.
 */
function mergeCandidates(results) {
  // Build the ordered segment list: centred segment of each result, then cage segment.
  const centred = [];
  const cage = [];
  for (const r of results) {
    const count = r.vertCounts.length;
    const nC = r.nCentered;
    let vsplit = 0;
    for (let i = 0; i < nC; i++) vsplit += r.vertCounts[i];
    const vtot = r.vertexSrcs.length;
    centred.push({ r, c0: 0, c1: nC, v0: 0, v1: vsplit });
    cage.push({ r, c0: nC, c1: count, v0: vsplit, v1: vtot });
  }
  const order = centred.concat(cage);

  let totC = 0, totV = 0;
  for (const s of order) { totC += s.c1 - s.c0; totV += s.v1 - s.v0; }

  const out = {
    isCage: new Uint8Array(totC),
    colorElem: new Uint32Array(totC),
    centerSrc: new Int32Array(totC),
    centerShift: new Int32Array(3 * totC),
    refPoint: new Float64Array(3 * totC),
    vertCounts: new Uint32Array(totC),
    vertices: new Float64Array(3 * totV),
    vertexSrcs: new Uint32Array(totV),
    vertexShifts: new Int32Array(3 * totV),
  };

  let ci = 0, vi = 0;
  for (const s of order) {
    const r = s.r;
    for (let c = s.c0; c < s.c1; c++) {
      out.isCage[ci] = r.isCage[c];
      out.colorElem[ci] = r.colorElem[c];
      out.centerSrc[ci] = r.centerSrc[c];
      out.centerShift[3 * ci] = r.centerShift[3 * c];
      out.centerShift[3 * ci + 1] = r.centerShift[3 * c + 1];
      out.centerShift[3 * ci + 2] = r.centerShift[3 * c + 2];
      out.refPoint[3 * ci] = r.refPoint[3 * c];
      out.refPoint[3 * ci + 1] = r.refPoint[3 * c + 1];
      out.refPoint[3 * ci + 2] = r.refPoint[3 * c + 2];
      out.vertCounts[ci] = r.vertCounts[c];
      ci++;
    }
    for (let v = s.v0; v < s.v1; v++) {
      out.vertices[3 * vi] = r.vertices[3 * v];
      out.vertices[3 * vi + 1] = r.vertices[3 * v + 1];
      out.vertices[3 * vi + 2] = r.vertices[3 * v + 2];
      out.vertexSrcs[vi] = r.vertexSrcs[v];
      out.vertexShifts[3 * vi] = r.vertexShifts[3 * v];
      out.vertexShifts[3 * vi + 1] = r.vertexShifts[3 * v + 1];
      out.vertexShifts[3 * vi + 2] = r.vertexShifts[3 * v + 2];
      vi++;
    }
  }
  return out;
}

/**
 * Parallel computePolyhedra. Returns the same `Polyhedron`-ready objects as the serial
 * path. Rejects on worker error so the caller can fall back to serial.
 * @param {Object} prep  the display-coupled prep from PolyhedraModule
 * @returns {Promise<Array<Object>>}
 */
export async function computePolyhedraParallel(prep) {
  const _t0 = performance.now();
  const { idxToElem, inputs } = marshalPolyhedraInputs(prep);
  const n = size();
  const _tMarshal = performance.now();

  const centerRanges = partition(inputs.nCenters, n);
  const seedRanges = partition(inputs.nAtoms, n);
  const payloads = [];
  for (let i = 0; i < n; i++) {
    payloads.push({
      inputs,
      cs: centerRanges[i][0], ce: centerRanges[i][1],
      ss: seedRanges[i][0], se: seedRanges[i][1],
    });
  }

  const results = await runOnAll('polyhedraCandidates', payloads);

  const _tDispatch = performance.now();
  const merged = mergeCandidates(results);
  const _tMerge = performance.now();
  const polyhedra = callAcceptCandidates(merged, idxToElem);
  const _tAccept = performance.now();

  const ms = (x) => x.toFixed(1);
  console.log(
    `[polyhedra] parallel workers=${n} ` +
    `marshal=${ms(_tMarshal - _t0)} dispatch+compute=${ms(_tDispatch - _tMarshal)} ` +
    `merge=${ms(_tMerge - _tDispatch)} accept=${ms(_tAccept - _tMerge)}`
  );
  return polyhedra;
}
