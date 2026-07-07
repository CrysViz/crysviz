import * as THREE from '../external/three/three.module.js';

import { groups, general } from '../state/store.js';
import { periodicWrapped, updateLattice } from './LatticeModule.js';
import { updateForces } from './ForceModule.js';
import { getActiveCutPlanes, isBondCutByPlanes, hideSingleBond } from './BondsFracUpdateModule.js';
import { requestRender } from './AnimateModule.js';

// ── Render fast path for MD / relax frames ────────────────────────────────────
//
// Generalizes MDStreamPanel's proven fastUpdatePositions to the full CrysViz
// pipeline (atoms + bonds + images), fixing the atom/bond desync (bonds were
// rendered from stale bond.center* between rebuilds) without paying the per-step
// cost of rebuildBonds / rebuildAtoms / the JSON structure hash.
//
// The topology (periodic-image set + bond pairs) is only valid between full
// rebuilds. A compatibility check bails (returns false) the moment it changes —
// e.g. an atom crossing a cell face changes the periodic-image count/order — and
// the caller falls back to the full updateVisualization rebuild for that frame,
// which re-establishes topology so the fast path resumes next frame.

// Module-scope scratch objects — three.js setMatrixAt copies the matrix, so reuse
// is safe and avoids per-bond allocation.
const _dummy = new THREE.Object3D();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

let _prevCellKey = null;

// Full bond-topology (and polyhedra) refresh cadence for the MD/relax hot loops:
// every Nth viewer update takes the full rebuild path. Shared by relaxer.js and
// MD.js so the two loops can't drift apart.
export const BOND_TOPOLOGY_STRIDE = 20;

function cellKey(lattice) {
  return lattice.flat().map(v => v.toFixed(4)).join(',');
}

/**
 * Attempt a fast in-place viewer update for the given structure. Returns true if
 * the fast path applied, false if topology is incompatible (caller must fall back
 * to a full updateVisualization rebuild). No mesh writes happen until every
 * compatibility check passes, so a false return never leaves a partial update.
 */
export function applyFrameFast(structure) {
  if (!structure) return false;

  const atomsMesh = groups.atomsMesh;
  if (!atomsMesh) return false;

  const periodic = structure.periodic;
  if (!periodic || !periodic.wrapped) return false;

  // "Complete Polyhedra" appends extra atoms to the wrapped set (beyond baseCount)
  // and grows atomsMesh; the direct recompute here won't reproduce them, so bail
  // and let the full pipeline handle that mode. Visible polyhedra must track the
  // moving atoms every frame (updatePolyhedra), which only the full path does.
  if (general.completePolyhedra || general.showPolyhedra) return false;

  // Recompute the wrapping directly. Replicate exactly the options object
  // runPeriodicWrapped builds ({ ...general, showPBCBonds }).
  const showPBCBonds = general.showBonds && general.showPBCBonds;
  const frac = structure.atoms.map(a => a.position);
  const elements = [...structure.elements];
  const lattice = structure.lattice;
  const wrapped = periodicWrapped({ ...general, showPBCBonds }, frac, elements, lattice);

  // ---- Compatibility check (before touching any mesh) ----
  const n = wrapped.elements.length;
  if (n !== atomsMesh.count) return false;

  const meshElems = atomsMesh.userData?.elementNames;
  if (!meshElems || meshElems.length !== n) return false;

  const prevSrc = periodic.wrapped.srcIndex;
  const newSrc = wrapped.srcIndex;
  if (!prevSrc || !newSrc || prevSrc.length !== n) return false;

  for (let i = 0; i < n; i++) {
    // Per-index element identity vs the mesh's build-time mapping, and per-index
    // srcIndex identity vs the previous wrapping — together these guarantee the
    // instance -> atom mapping (and bond.indices) are still valid.
    if (wrapped.elements[i] !== meshElems[i]) return false;
    if (prevSrc[i] !== newSrc[i]) return false;
  }

  // Bonds may legitimately be off — then skip the bond update, don't fail. If they
  // are on but the mesh is missing, topology needs a rebuild -> fall back.
  const bondsOn = !!general.showBonds;
  const bondsMesh = groups.bondsMesh;
  if (bondsOn && !bondsMesh) return false;

  // ---- Atoms: translation-only instanceMatrix writes (offsets 12/13/14) ----
  const cart = wrapped.cart;
  const arr = atomsMesh.instanceMatrix.array;
  for (let i = 0; i < n; i++) {
    const off = i * 16;
    const c = cart[i];
    arr[off + 12] = c[0];
    arr[off + 13] = c[1];
    arr[off + 14] = c[2];
  }
  atomsMesh.instanceMatrix.needsUpdate = true;

  // ---- Bonds: keep topology (pairs), refresh endpoints from fresh wrapped.cart ----
  if (bondsOn && bondsMesh && Array.isArray(structure.bonds)) {
    const activeCutPlanes = getActiveCutPlanes();
    const bonds = structure.bonds;
    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b];
      // renderBonds tagged each rendered bond with its stable instance slot. Bonds
      // without a slot were not rendered at the last rebuild and cannot appear
      // without a topology rebuild (handled by the stride/fallback), so skip them.
      const idx = bond.renderIndex;
      if (!Number.isInteger(idx) || idx < 0) continue;

      bond.updateEndpoints(cart[bond.indices[0]], cart[bond.indices[1]]);

      // Respect active cut planes exactly like updateBonds; also hide a bond that
      // collapsed below the visible-length threshold this frame (keeps its slot),
      // or stretched past its element-pair cutoff (broken bond — would otherwise
      // render as an ever-longer cylinder until the next topology rebuild).
      const broken = bond.cutoffSq > 0 && bond.dist * bond.dist > bond.cutoffSq;
      if (!bond.center1 || !bond.center2 || broken || isBondCutByPlanes(bond, activeCutPlanes)) {
        hideSingleBond(idx);
        continue;
      }

      _dir.copy(bond.dir).normalize();

      _dummy.position.copy(bond.center1);
      _dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
      _dummy.quaternion.setFromUnitVectors(_up, _dir);
      _dummy.updateMatrix();
      bondsMesh.setMatrixAt(idx * 2, _dummy.matrix);

      _dummy.position.copy(bond.center2);
      _dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
      _dummy.quaternion.setFromUnitVectors(_up, _dir);
      _dummy.updateMatrix();
      bondsMesh.setMatrixAt(idx * 2 + 1, _dummy.matrix);
    }
    bondsMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- Commit the new wrapping. Sentinel hash so the next full pipeline pass
  // (runPeriodicWrapped) recomputes rather than trusting this fast-frame cache. ----
  wrapped.baseCount = n;
  periodic.wrapped = wrapped;
  periodic.hash = 'fastframe';

  // ---- Lattice: only rebuild the cell box when the cell actually changes ----
  const ck = cellKey(lattice);
  if (ck !== _prevCellKey) {
    _prevCellKey = ck;
    updateLattice();
  }

  // ---- Forces overlay: only when the toggle is on ----
  if (general.forcesActive) {
    updateForces();
  }

  requestRender();
  return true;
}
