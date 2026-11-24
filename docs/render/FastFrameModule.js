
import { groups, general } from '../state/store.js';
import { updateLattice } from './LatticeModule.js';
import { deriveVisibleWrapped } from './AtomsFracUpdateModule.js';
import { applyFocusRegions } from './FocusRegionModule.js';
import { updateForces } from './ForceModule.js';
import { getActiveCutPlanes } from './BondsFracUpdateModule.js';
import { writePlaybackBonds, markBondObjectsStale } from './PlaybackBondsModule.js';
import { prepareFrameColors } from './FrameColorsModule.js';
import { requestRender } from './AnimateModule.js';
import { pendingFramePositions } from '../model/materializeFrame.js';
import { updateGroundPlane } from './GroundPlaneModule.js';
import { updateAsuAtomHighlight, refreshAsymmetricUnitIfStale } from './AsymmetricUnitModule.js';
import { fastUpdatePolyhedra } from './PolyhedraFrameModule.js';

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

let _prevCell = null;

// Why the last attempt fell back. The fast path is silent by design (a bail is
// legitimate), but a run that never takes it is a performance cliff worth
// seeing — the MD profile prints this.
let _lastBailReason = null;

export function lastFastFrameBail() {
  return _lastBailReason;
}

/**
 * Is a colour mode active whose colours change from frame to frame? Atoms
 * coloured by force magnitude, or bonds coloured by length (bonds that merely
 * follow force-coloured atoms are covered by the first). applyFrameFast
 * recolours the instances for them every frame (FrameColorsModule.js).
 * @returns {boolean}
 */
export function isFrameDependentColorMode() {
  return general.atomsColor === 'force' || general.bondsColor === 'length';
}

function bail(reason) {
  _lastBailReason = reason;
  return false;
}

// Full bond-topology (and polyhedra) refresh cadence for the MD/relax hot loops:
// every Nth viewer update takes the full rebuild path. Shared by relaxer.js and
// MD.js so the two loops can't drift apart.
export const BOND_TOPOLOGY_STRIDE = 20;

// Trajectory playback of a large structure does not rebuild on that fixed
// stride: one full rebuild (image set, a Bond per pair, a new mesh) costs
// hundreds of milliseconds to seconds there, and every 20th frame turned
// playback into a stutter. Bonds no longer need it — they form and break per
// frame from a candidate list refreshed in the background
// (PlaybackBondsModule.js). What a rebuild still refreshes is the set of
// periodic images drawn at the cell faces, which only drifts once atoms have
// moved a good part of a bond length: rebuild then, at
// PLAYBACK_TOPOLOGY_DISPLACEMENT. Below the size threshold the stride is kept
// (cheap there, and keeps the images exact).
export const PLAYBACK_TOPOLOGY_MIN_ATOMS = 5000;
export const PLAYBACK_TOPOLOGY_DISPLACEMENT = 2.0;

/** Largest atom displacement (Å) since `structure`'s topology was built, as
 *  of its last fast frame. Kept on the wrapping itself, so a rebuild (a new
 *  wrapping) starts again from 0. */
export function fastFrameDisplacement(structure) {
  return structure?.periodic?.wrapped?.maxDisplacement ?? 0;
}

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
function accumulateWrapFix(wrapped, src, lattice) {
  const natoms = src.count;
  const col = src.col, atoms = src.atoms;
  let prev = wrapped.prevAtomFrac;
  let fix = wrapped.wrapFix;
  if (!prev || prev.length !== natoms * 3) {
    wrapped.maxDisplacement = 0;
    fix = new Int16Array(natoms * 3);
    wrapped.wrapFix = fix;
    const built = wrapped.buildAtomFrac;
    if (built && built.length === natoms * 3) {
      // First fast frame after a rebuild: start from the positions the
      // wrapping was built from, so the step from there to this frame is
      // tracked like any other — an atom that crossed a face in between is
      // counted (starting from this frame instead drew it a cell away, and
      // its bonds, stretched across the cell, were hidden as broken). Those
      // positions are also the reference for the refresh displacement.
      prev = Float64Array.from(built);
      wrapped.prevAtomFrac = prev;
      wrapped.baseAtomFrac = built;
    } else {
      // A wrapping without its build positions: this frame is the baseline.
      prev = new Float64Array(natoms * 3);
      if (col) {
        prev.set(col.subarray(0, natoms * 3));
      } else {
        for (let j = 0; j < natoms; j++) {
          const p = atoms[j].position;
          prev[j * 3] = p[0];
          prev[j * 3 + 1] = p[1];
          prev[j * 3 + 2] = p[2];
        }
      }
      wrapped.prevAtomFrac = prev;
      wrapped.baseAtomFrac = Float64Array.from(prev);
      return fix;
    }
  }
  const base = wrapped.baseAtomFrac;
  // Second reference: where the playback candidate bond list was computed
  // (render/PlaybackBondsModule.js), which refreshes it as the atoms move.
  const candRef = wrapped.candRefFrac && wrapped.candRefFrac.length === natoms * 3 ? wrapped.candRefFrac : null;
  const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = lattice;
  let maxSq = 0;
  let candSq = 0;

  for (let j = 0; j < natoms; j++) {
    const o = j * 3;
    const p = col ? null : atoms[j].position;
    for (let k = 0; k < 3; k++) {
      const now = col ? col[o + k] : p[k];
      const delta = now - prev[o + k];
      // Only a wrap can move an atom by more than half a cell in one frame; a
      // real displacement that large would mean the run has already blown up.
      if (delta > 0.5) fix[o + k] -= 1;
      else if (delta < -0.5) fix[o + k] += 1;
      prev[o + k] = now;
    }
    if (base) {
      // Unwrapped (fix applied) displacement from the base, in Å.
      const d0 = prev[o] + fix[o] - base[o];
      const d1 = prev[o + 1] + fix[o + 1] - base[o + 1];
      const d2 = prev[o + 2] + fix[o + 2] - base[o + 2];
      const x = d0 * ax + d1 * bx + d2 * cx;
      const y = d0 * ay + d1 * by + d2 * cy;
      const z = d0 * az + d1 * bz + d2 * cz;
      const sq = x * x + y * y + z * z;
      if (sq > maxSq) maxSq = sq;
    }
    if (candRef) {
      const d0 = prev[o] + fix[o] - candRef[o];
      const d1 = prev[o + 1] + fix[o + 1] - candRef[o + 1];
      const d2 = prev[o + 2] + fix[o + 2] - candRef[o + 2];
      const x = d0 * ax + d1 * bx + d2 * cx;
      const y = d0 * ay + d1 * by + d2 * cy;
      const z = d0 * az + d1 * bz + d2 * cz;
      const sq = x * x + y * y + z * z;
      if (sq > candSq) candSq = sq;
    }
  }
  wrapped.maxDisplacement = Math.sqrt(maxSq);
  if (candRef) wrapped.candDisplacement = Math.sqrt(candSq);
  return fix;
}

/**
 * Where the fast path reads source positions: the shown frame's fractional
 * position column while its per-atom physics is still deferred (a trajectory
 * frame switch, model/materializeFrame.js deferFramePhysics) — so playback
 * never materialises Atom positions — else the atoms themselves (MD/relax
 * live updates write them directly).
 * @param {any} structure
 */
function positionSource(structure) {
  const col = pendingFramePositions(structure);
  if (col) return { col, atoms: null, count: col.length / 3 };
  const atoms = structure.atoms;
  return { col: null, atoms, count: atoms.length };
}

/** Rewrite wrapped.frac/.cart in place from the atoms' current positions. */
function updateWrappedFromSources(wrapped, structure, shifts, lattice) {
  const { srcIndex, frac, cart } = wrapped;
  const source = positionSource(structure);
  const { col, atoms } = source;
  const [ax, ay, az] = lattice[0];
  const [bx, by, bz] = lattice[1];
  const [cx, cy, cz] = lattice[2];
  const fix = accumulateWrapFix(wrapped, source, lattice);

  for (let i = 0; i < srcIndex.length; i++) {
    const src = srcIndex[i];
    const o = i * 3;
    const s = src * 3;
    let p0, p1, p2;
    if (col) {
      p0 = col[s]; p1 = col[s + 1]; p2 = col[s + 2];
    } else {
      const p = atoms[src].position;
      p0 = p[0]; p1 = p[1]; p2 = p[2];
    }
    const f0 = p0 + shifts[o] + fix[s];
    const f1 = p1 + shifts[o + 1] + fix[s + 1];
    const f2 = p2 + shifts[o + 2] + fix[s + 2];
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
  // and let the full pipeline handle that mode. Visible polyhedra move with the
  // atoms below (render/PolyhedraFrameModule.js) — except under a cut plane,
  // which decides which polyhedra exist at all: that set is the search's.
  if (general.completePolyhedra) return bail('complete polyhedra');
  const polyhedraOn = !!general.showPolyhedra;
  if (polyhedraOn && getActiveCutPlanes().length) return bail('polyhedra under a cut plane');

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

  // ---- Polyhedra: the last check that can fail (a hull that no longer
  // closes), so it runs before any atom or bond is written; on success the
  // polyhedra and their property colours are already up to date. ----
  if (polyhedraOn) {
    const polyResult = fastUpdatePolyhedra(structure);
    if (polyResult !== true) return bail(polyResult);
  }

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

  // ---- Frame-dependent colour maps (atoms by force, bonds by length or
  // following force-coloured atoms): only the colours change, so recolour the
  // instances here, exactly as a full rebuild would (FrameColorsModule.js). ----
  const frameColors = isFrameDependentColorMode() ? prepareFrameColors(structure, wrapped, atomsMesh) : null;

  // ---- Bonds: in step with the atoms, from the instance positions just written.
  // Every pair of the last rebuild plus every candidate within cutoff + skin is
  // drawn exactly while its current length is within its cutoff, so bonds form
  // and break in the frame the atoms move (render/PlaybackBondsModule.js). The
  // Bond objects are synced lazily, when something reads structure.bonds.
  if (bondsOn && bondsMesh) {
    writePlaybackBonds(structure, wrapped, bondsMesh, getActiveCutPlanes(), frameColors);
    markBondObjectsStale(structure, wrapped);
  } else if (groups.bondsCandidateMesh) {
    groups.bondsCandidateMesh.visible = false;
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
  // Focus opacities depend on positions only through an enabled region; with
  // none, every instance keeps the opacity its last full rebuild wrote (and
  // fresh force/spin arrows derive their own), so the O(atoms + bonds) pass
  // is skipped — it was a fifth of the fast frame at 20k atoms.
  if (structure.focusRegions?.some((region) => region && region.enabled !== false)) applyFocusRegions(structure);

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

  // Same reason: which atoms fall inside the asymmetric-unit wedge changes as
  // they move. The wedge itself only changes if the cell does.
  refreshAsymmetricUnitIfStale();
  updateAsuAtomHighlight();

  requestRender();
  return true;
}
