// Single listener for the 'crysviz:polyhedra-rebuilt' event (fired by
// render/PolyhedraModule.js after every polyhedra recompute) that runs the
// pure data analyses in render/PolyhedraAnalysisModule.js once and fans the
// result out to whichever of the Polyhedra*Histogram.js panels are currently
// open — mirrors how BondsFracUpdateModule.js pushes fresh data to
// refreshBondLengthHistogram/refreshCoordinationHistogram after rebuildBonds,
// just event-driven instead of a direct call (polyhedra compute is async and
// owned by a different module). PolyhedronInspector.js's single-polyhedron
// detail is selection-driven instead (crysviz:polyhedron-selection-changed,
// see SelectAndHighlightModule.js) and isn't fanned out from here.

import { fileBrowser } from '../../state/store.js';
import {
  computePolyhedraTypeGroups, computePolyhedraConnectivity, computePolyhedraVolumes,
} from '../../render/PolyhedraAnalysisModule.js';

const listeners = new Set();

/** @param {(data: {typeGroups: any[], connectivity: any[], volumes: any[]}) => void} cb */
export function subscribePolyhedraAnalysis(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function recompute() {
  const structure = fileBrowser.selectedStructure;
  const data = structure?.polyhedra?.polyhedra?.length
    ? {
      typeGroups: computePolyhedraTypeGroups(structure),
      connectivity: computePolyhedraConnectivity(structure),
      volumes: computePolyhedraVolumes(structure),
    }
    : { typeGroups: [], connectivity: [], volumes: [] };
  for (const cb of listeners) cb(data);
}

document.addEventListener('crysviz:polyhedra-rebuilt', recompute);
