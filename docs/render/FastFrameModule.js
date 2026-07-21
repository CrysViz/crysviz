import * as THREE from '../external/three/three.module.js';

import { groups, general } from '../state/store.js';
import { updateLattice } from './LatticeModule.js';
import { deriveVisibleWrapped } from './AtomsFracUpdateModule.js';
import { updateForces } from './ForceModule.js';
import { getActiveCutPlanes, isBondCutByPlanes, hideSingleBond } from './BondsFracUpdateModule.js';
import { requestRender } from './AnimateModule.js';
import { updateGroundPlane } from './GroundPlaneModule.js';

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

let _prevCell = null;

// Why the last attempt fell back. The fast path is silent by design (a bail is
// legitimate), but a run that never takes it is a performance cliff worth
// seeing — the MD profile prints this.
let _lastBailReason = null;

export function lastFastFrameBail() {
  return _lastBailReason;
}

function bail(reason) {
  _lastBailReason = reason;
  return false;
}

// Full bond-topology (and polyhedra) refresh cadence for the MD/relax hot loops:
// every Nth viewer update takes the full rebuild path. Shared by relaxer.js and
// MD.js so the two loops can't drift apart.
export const BOND_TOPOLOGY_STRIDE = 20;

// Has the cell moved enough to be worth rebuilding the box geometry? Under a
// barostat it changes every single step, by ~1e-5 relative — rebuilding and
// re-uploading the line geometry that often cost ~240 ms/step of paint on the
// 1300-atom NPT benchmark, for a box edge shifting by less than a thousandth of
// an Angstrom. A relative threshold keeps the box visually locked to the cell
// (it still updates ~every 10 steps while the volume drifts) at a fraction of
// the cost. Exact equality is not usable here: floats from the barostat scaling
// never repeat.
const CELL_REBUILD_REL_TOL = 1e-3;

function cellChangedEnough(lattice, previous) {
  if (!previous) return true;
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 3; k++) {
      const now = lattice[i][k];
      const before = previous[i][k];
      const scale = Math.max(1e-6, Math.abs(before), Math.abs(now));
      if (Math.abs(now - before) / scale > CELL_REBUILD_REL_TOL) return true;
    }
  }
  return false;
}

/**
 * Track atoms crossing a cell face.
 *
 * MD wraps positions into [0,1) every step, so an atom leaving through one face
 * reappears at the other as a jump of ~1 in fractional coordinates. The image
 * shifts recorded at the last rebuild are relative to where the atom was THEN,
 * so after such a jump every one of that atom's periodic images is drawn a
 * whole cell away from where it belongs — which is what the occasional stray
 * atom floating outside the box during MD was.
 *
 * The set of images cannot be corrected without a rebuild, but their positions
 * can: accumulate a per-atom integer counter of how many cells it has wrapped
 * through, and add it back. Every instance then moves continuously with its
 * source, and the frozen set stays geometrically consistent until the next full
 * rebuild resets everything.
 */
function accumulateWrapFix(wrapped, atoms) {
  const natoms = atoms.length;
  let prev = wrapped.prevAtomFrac;
  let fix = wrapped.wrapFix;
  if (!prev || prev.length !== natoms * 3) {
    // First fast frame after a rebuild: the wrapping and the atoms agree, so
    // there is nothing to correct yet — just record the baseline.
    prev = new Float64Array(natoms * 3);
    fix = new Int16Array(natoms * 3);
    for (let j = 0; j < natoms; j++) {
      const p = atoms[j].position;
      prev[j * 3] = p[0];
      prev[j * 3 + 1] = p[1];
      prev[j * 3 + 2] = p[2];
    }
    wrapped.prevAtomFrac = prev;
    wrapped.wrapFix = fix;
    return fix;
  }

  for (let j = 0; j < natoms; j++) {
    const p = atoms[j].position;
    const o = j * 3;
    for (let k = 0; k < 3; k++) {
      const now = p[k];
      const delta = now - prev[o + k];
      // Only a wrap can move an atom by more than half a cell in one frame; a
      // real displacement that large would mean the run has already blown up.
      if (delta > 0.5) fix[o + k] -= 1;
      else if (delta < -0.5) fix[o + k] += 1;
      prev[o + k] = now;
    }
  }
  return fix;
}

/** Rewrite wrapped.frac/.cart in place from the atoms' current positions. */
function updateWrappedFromSources(wrapped, structure, shifts, lattice) {
  const { srcIndex, frac, cart } = wrapped;
  const atoms = structure.atoms;
  const [ax, ay, az] = lattice[0];
  const [bx, by, bz] = lattice[1];
  const [cx, cy, cz] = lattice[2];
  const fix = accumulateWrapFix(wrapped, atoms);

  for (let i = 0; i < srcIndex.length; i++) {
    const src = srcIndex[i];
    const p = atoms[src].position;
    const o = i * 3;
    const s = src * 3;
    const f0 = p[0] + shifts[o] + fix[s];
    const f1 = p[1] + shifts[o + 1] + fix[s + 1];
    const f2 = p[2] + shifts[o + 2] + fix[s + 2];
    const fi = frac[i];
    fi[0] = f0;
    fi[1] = f1;
    fi[2] = f2;
    const ci = cart[i];
    ci[0] = f0 * ax + f1 * bx + f2 * cx;
    ci[1] = f0 * ay + f1 * by + f2 * cy;
    ci[2] = f0 * az + f1 * bz + f2 * cz;
  }
}

/**
 * Attempt a fast in-place viewer update for the given structure. Returns true if
 * the fast path applied, false if topology is incompatible (caller must fall back
 * to a full updateVisualization rebuild). No mesh writes happen until every
 * compatibility check passes, so a false return never leaves a partial update.
 */
export function applyFrameFast(structure) {
  if (!structure) return bail('no structure');

  const atomsMesh = groups.atomsMesh;
  if (!atomsMesh) return bail('no atomsMesh');

  const periodic = structure.periodic;
  if (!periodic || !periodic.wrapped) return bail('no periodic.wrapped');

  // "Complete Polyhedra" appends extra atoms to the wrapped set (beyond baseCount)
  // and grows atomsMesh; the direct recompute here won't reproduce them, so bail
  // and let the full pipeline handle that mode. Visible polyhedra must track the
  // moving atoms every frame (updatePolyhedra), which only the full path does.
  if (general.completePolyhedra || general.showPolyhedra) return bail('polyhedra visible');

  const lattice = structure.lattice;
  const wrapped = periodic.wrapped;

  // ---- Compatibility check (before touching any mesh) ----
  const n = wrapped.elements.length;
  if (n !== atomsMesh.count) return bail(`wrapped count ${n} != mesh count ${atomsMesh.count}`);

  const meshElems = atomsMesh.userData?.elementNames;
  if (!meshElems || meshElems.length !== n) return bail('mesh elementNames missing/stale');

  const srcIndex = wrapped.srcIndex;
  if (!srcIndex || srcIndex.length !== n) return bail('srcIndex missing/length changed');

  for (let i = 0; i < n; i++) {
    // Per-index element identity vs the mesh's build-time mapping: guarantees
    // the instance -> atom mapping (and bond.indices) are still valid.
    if (wrapped.elements[i] !== meshElems[i]) return bail('element order changed');
  }

  // Recorded by runPeriodicWrapped when this wrapping was built (it is the only
  // place where the wrapping and the atom coordinates are guaranteed to line
  // up). Absent means the wrapping came from somewhere else — fall back.
  const shifts = wrapped.imageShifts;
  if (!shifts || shifts.length !== n * 3) return bail('no recorded image shifts');

  // Bonds may legitimately be off — then skip the bond update, don't fail. If they
  // are on but the mesh is missing, topology needs a rebuild -> fall back. Checked
  // before the wrapping is rewritten below, so a bail leaves nothing half-updated.
  const bondsOn = !!general.showBonds;
  const bondsMesh = groups.bondsMesh;
  if (bondsOn && !bondsMesh) return bail('bonds on but no bondsMesh');

  // ---- Move every instance from its source atom + its frozen lattice shift ----
  // Re-deriving the wrapping with periodicWrapped() here is what used to make
  // this path pointless: the ghost set is built by a bond search, so a single
  // atom drifting off a cell face changes the instance count and the whole
  // frame fell back to a full rebuild. Measured on a 1300-atom MD run: 1 fast
  // frame out of 60. Every image is a source atom plus an integer lattice
  // translation, though, and that translation cannot change while the set is
  // frozen — so the positions can be reconstructed exactly, in O(N), with no
  // search at all. The set itself is refreshed by the caller's periodic full
  // rebuild (BOND_TOPOLOGY_STRIDE).
  updateWrappedFromSources(wrapped, structure, shifts, lattice);

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
  // Compatibility check above already bails to the full rebuild path the
  // moment any atom is hidden (mesh instance count would no longer match
  // the full recompute's n), so this is always the cheap same-reference
  // path here — but it must still run each frame to keep .visibleWrapped's
  // positions from going stale relative to the cart update just committed.
  deriveVisibleWrapped(structure);

  // ---- Lattice: only rebuild the cell box when the cell actually changes ----
  if (cellChangedEnough(lattice, _prevCell)) {
    _prevCell = lattice.map((row) => [...row]);
    updateLattice();
  }

  // ---- Forces overlay: only when the toggle is on ----
  if (general.forcesActive) {
    updateForces();
  }

  // MD/relax playback moves atoms and bypasses updateVisualization — reposition
  // the ground disc so it tracks the structure bottom each frame (O(1) when off).
  updateGroundPlane();

  requestRender();
  return true;
}
