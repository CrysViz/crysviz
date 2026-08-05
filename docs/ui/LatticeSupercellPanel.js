import { applyLatticeTransformation } from './LatticeTransformModule.js';

import { makeSectionHeadline } from './panels/sectionHeadline.js';
import { general, fileBrowser } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { createSupercell } from './SuperCellModule.js';
import { resetView, recenterCamera } from './WindowAndSceneControls.js';
import { fracToCart, cartToFrac } from '../render/index.js';
import { createBondLengthControls } from './BondLengthPanel.js';
import { structureHasFractionalOccupancy } from './DisorderWarningBanner.js';
import { createNewStructureFromAtoms, createTrajectoryFromFrames } from './addToStructureModule/CommitAtoms.js';
import { buildOrderedStructure, planOrdering, listMultiplierOptions } from '../atomistic/order_structure.js';
import { Atom, Structure } from '../model/index.js';

// Grow the current structure's cell by the requested vacuum (Å) along each
// lattice vector, keeping the atoms' Cartesian positions fixed - a standard
// slab-with-vacuum construction (vacuum is added on one side only; atoms do
// not recenter, so their fractional coordinates compress toward the origin
// side of whichever vector(s) grew).
//
// _vacuumApplied is an in-memory (not saved/exported) bookkeeping field on
// the structure - the running total added per axis, plus the lattice as it
// was before any vacuum was ever applied to this structure - so the panel
// can show a running counter and Reset can undo the whole thing in one step
// (restoring baseLattice; atoms' Cartesian positions never changed, so their
// fractional coordinates just get recomputed against it).
function applyVacuumToStructure(vacX, vacY, vacZ) {
  const s = fileBrowser.selectedStructure;
  if (!s) {
    console.warn('Add vacuum: no structure selected.');
    return;
  }
  if (!vacX && !vacY && !vacZ) return;

  if (!s._vacuumApplied) {
    s._vacuumApplied = { x: 0, y: 0, z: 0, baseLattice: s.lattice.map(row => row.slice()) };
  }
  s._vacuumApplied.x += vacX;
  s._vacuumApplied.y += vacY;
  s._vacuumApplied.z += vacZ;

  const lattice = s.lattice;
  const vac = [vacX, vacY, vacZ];

  // Cartesian positions to preserve.
  const carts = fracToCart(s.atoms.map(a => a.position), lattice);

  // Scale each lattice vector's length by its added vacuum.
  const newLattice = lattice.map((row, i) => {
    const len = Math.hypot(row[0], row[1], row[2]);
    const k = (len > 0 && vac[i]) ? (len + vac[i]) / len : 1;
    return [row[0] * k, row[1] * k, row[2] * k];
  });

  s.atoms.forEach((atom, idx) => {
    atom.position = cartToFrac(carts[idx], newLattice);
  });

  s.lattice = newLattice;
  s.periodic = { wrapped: null, hash: null }; // force periodic-wrap recompute

  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
  // Vacuum is added on one side only (see the comment above), so the cell's
  // Cartesian center genuinely shifts — recenter on it, but keep whatever
  // direction/distance the camera was already at rather than snapping to a
  // canonical view the way resetView() would.
  recenterCamera();
}

// Undoes every vacuum addition made so far on this structure in one step.
function resetVacuumForStructure(s) {
  if (!s || !s._vacuumApplied) return;
  const carts = fracToCart(s.atoms.map(a => a.position), s.lattice);
  s.lattice = s._vacuumApplied.baseLattice.map(row => row.slice());
  s.atoms.forEach((atom, idx) => {
    atom.position = cartToFrac(carts[idx], s.lattice);
  });
  s.periodic = { wrapped: null, hash: null };
  delete s._vacuumApplied;

  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
  recenterCamera();
}

/** eV/atom, formatted for the sample list (sign-free — rank and Δ carry the
 *  comparison, this is just the value). */
function formatEnergyPerAtom(value) {
  return Number.isFinite(value) ? `${value.toFixed(5)} eV/atom` : '—';
}

// Order Structure's build/compare state. Module-level, NOT a local variable
// inside addOrderStructureSection(container): the Cell & Supercell panel is
// a 'lifecycle: rebuild' panel (see defaultPanels.js's 'cell' entry) that
// tears down and rebuilds its whole body on every structure selection - and
// showCandidate() below causes exactly that selection change the first time
// it creates the preview row (also true of Keep All's new trajectory row,
// and Discard's row deletion). A function-local variable would be wiped out
// mid-build the instant the first sample got previewed.
//
// { builtSamples: Array<{seed, built:{atoms,elements,lattice}, energyPerAtom:
//   number|null}>, energiesComputed: boolean, previewStructure: any,
//   previewRow: HTMLElement, shownSeed: number } | null
let orderSession = null;
let orderBusy = false;

// The section's current container, updated at the top of every
// addOrderStructureSection() call. osEl() reads through THIS rather than
// document.getElementById: addLatticeAndSupercellPanel builds this section's
// content before appending it to the live DOM (it assembles the whole
// Supercell/Vacuum/Order Structure/Transform group off-document, then
// appends it once at the end), so getElementById would find nothing during
// that first render - and after a rebuild, this reference is what stays
// correct for handlers that keep running past the point a reentrant rebuild
// (see showOrderCandidate) replaced the container this handler started with.
let orderContainer = null;

// Persisted across rebuilds for the same reason orderSession is: the sample-
// count <input> is rebuilt from its HTML `value="1"` default every time this
// section's DOM is torn down and recreated, so without this the user's
// choice would silently reset to 1 the moment a build's first preview
// triggered a rebuild.
let lastSampleCount = 1;

function osEl(id) {
  return orderContainer?.querySelector(`#${id}`) ?? null;
}

// Populate the supercell-size <select> from the CURRENT structure - called
// both when this section mounts and again right before Build reads it, since
// the structure's disorder can change (an occupancy edit elsewhere) without
// this panel rebuilding to pick it up.
function refreshOrderSizeOptions() {
  const sizeSelect = osEl('osSizeSelect');
  if (!sizeSelect) return;
  const structure = fileBrowser.selectedStructure;
  if (!structure) { sizeSelect.innerHTML = ''; return; }
  const plan = planOrdering(structure);
  const options = listMultiplierOptions(structure);
  sizeSelect.innerHTML = options.map((o) =>
    `<option value="${o.multiplier}"${o.multiplier === (plan.multiplier ?? 1) ? ' selected' : ''}>`
    + `${o.shape.join('x')} (${o.atomCount} atoms)${o.exact ? '' : ' — approximate'}</option>`
  ).join('');
}

function setOrderBusy(v) {
  orderBusy = v;
  ['osBuildBtn', 'osMajorityBtn', 'osSizeSelect', 'osCompareBtn', 'osUseBtn', 'osKeepAllBtn', 'osDiscardBtn']
    .forEach((id) => { const el = osEl(id); if (el) el.disabled = v; });
}

function setOrderStatus(text) {
  const el = osEl('osStatus');
  if (el) el.textContent = text;
}

/** Redraw the sample list + results-actions visibility from orderSession —
 *  the single source of truth for what this section shows, called both right
 *  after addOrderStructureSection() builds fresh DOM (covers a plain mount
 *  AND a rebuild mid-session) and after any action that changes orderSession
 *  without itself triggering a rebuild (a row click's in-place preview swap,
 *  Compare Energy's results). */
function renderOrderList() {
  const listEl = osEl('osList');
  const resultsActions = osEl('osResultsActions');
  if (!listEl || !resultsActions) return;
  if (!orderSession?.builtSamples) {
    listEl.hidden = true;
    resultsActions.hidden = true;
    listEl.innerHTML = '';
    return;
  }
  const { builtSamples, energiesComputed, shownSeed } = orderSession;
  listEl.hidden = false;
  resultsActions.hidden = false;
  const bestEnergy = energiesComputed ? builtSamples[0].energyPerAtom : null;
  listEl.innerHTML = builtSamples.map((s, i) => {
    const energyText = energiesComputed ? formatEnergyPerAtom(s.energyPerAtom) : `${s.built.atoms.length} atoms`;
    const deltaText = !energiesComputed ? '' : (i === 0 ? 'lowest' : `+${(s.energyPerAtom - bestEnergy).toFixed(5)} eV/atom`);
    const classes = ['order-structure-row'];
    if (energiesComputed && i === 0) classes.push('best');
    if (s.seed === shownSeed) classes.push('showing');
    return `
      <div class="${classes.join(' ')}" data-seed="${s.seed}" title="Click to look at this decoration in the 3D view.">
        <span class="order-structure-rank">#${i + 1}</span>
        <span class="order-structure-energy">${energyText}</span>
        <span class="order-structure-delta">${deltaText}</span>
      </div>
    `;
  }).join('');
}

// Render `sample`'s geometry into the one reusable preview row, creating it
// on first use. Creating it selects a new file-browser row, which triggers
// the Cell & Supercell panel's own rebuild — the freshly rebuilt instance's
// initial renderOrderList() call picks up orderSession (already updated
// below, before that happens) and redraws correctly; nothing after this call
// in the caller may rely on any DOM reference captured before it ran.
function showOrderCandidate(sample) {
  orderSession.shownSeed = sample.seed;
  if (!orderSession.previewStructure) {
    createNewStructureFromAtoms(
      sample.built.atoms.map((atom, i) => ({
        element: sample.built.elements[i],
        x: atom.position[0], y: atom.position[1], z: atom.position[2],
        color: null,
      })),
      { lattice: sample.built.lattice, fileName: 'ordered_structure' }
    );
    orderSession.previewStructure = fileBrowser.selectedStructure;
    orderSession.previewRow = fileBrowser.selectedRow;
  } else {
    // No structure switch here (same row, same object, mutated in place) —
    // no rebuild will happen, so draw the result ourselves.
    orderSession.previewStructure.atoms = sample.built.atoms;
    orderSession.previewStructure.elements = sample.built.elements;
    orderSession.previewStructure.uniqueElements = [...new Set(sample.built.elements)];
    orderSession.previewStructure.lattice = sample.built.lattice;
    orderSession.previewStructure.periodic = { wrapped: null, hash: null };
    createBondLengthControls();
    updateVisualization({
      reRenderAtoms: true, reRenderBonds: true, reRenderLattice: true, reRenderComposition: 'open',
    });
    renderOrderList();
  }
}

// Drop the in-progress preview row (if one exists) via its own delete
// button — that owns every bit of bookkeeping it touches (structureShip.
// container, combine/overlay state, reselecting the previous row) — and end
// the session. previewRow is captured before nulling orderSession so the
// delete click (which may itself trigger a rebuild) sees a clean session.
function resetOrderSession() {
  const row = orderSession?.previewRow;
  orderSession = null;
  if (row) {
    row.querySelector('.delete')?.click();
    recenterCamera();
  }
  renderOrderList();
}

/**
 * "Order Structure" section content — builds an ordered (one definite species
 * per site) approximation of a disordered structure, needed before MD/
 * relaxation or polyhedra can be used on it. Lives here (not a separate
 * floating dialog) so every step — method, sample count, supercell size,
 * build, energy comparison, and the final pick — stays in the one panel the
 * user is already looking at.
 *
 * Flow for Random:
 *   Build Samples  -> N independent decorations (geometry only, no potential
 *                      needed yet); the first is shown live in the 3D view.
 *   (click a row)  -> swap that same preview to look at any other sample.
 *   Compare Energy -> single-point energy for every built sample with
 *                      whatever potential is selected in the Atomistic panel
 *                      (NEP/PET-MAD; ASE can't run headless — see
 *                      ensureCalculatorRunner); results re-sort best first.
 *   Use Shown      -> keep whichever sample is currently previewed as the
 *                      final structure (one new file-browser row).
 *   Keep All       -> every built sample becomes one frame of a new
 *                      trajectory row (best first if energies were
 *                      computed), browsable via the normal Trajectory panel
 *                      — available with or without having compared energy.
 *   Discard        -> drop everything built so far, no new row.
 *
 * Majority has nothing to compare (there is exactly one majority
 * decoration), so it stays a single immediate action.
 */
function addOrderStructureSection(container) {
  orderContainer = container;
  // A live session whose preview row is no longer the current selection
  // means the user navigated to something else — end it, but leave whatever
  // structure/row resulted exactly as it is (same outcome as Use Shown)
  // rather than silently deleting it. Guarded on previewRow already being
  // set: showOrderCandidate()'s createNewStructureFromAtoms() call for the
  // FIRST sample re-enters this function (see its own comment) before it has
  // had a chance to assign previewRow — nulling the session out from under
  // that in-progress call would crash it (previewRow still null at that
  // point is "a build is actively creating its first preview", not "the user
  // navigated away").
  if (orderSession?.previewRow && orderSession.previewRow !== fileBrowser.selectedRow) {
    orderSession = null;
  }

  container.innerHTML = `
    <p style="font-size: 11px; color: rgba(255,255,255,0.6); margin: 0 0 8px 0; line-height: 1.4;">
      Builds a new file with one definite species per site, approximating this structure's disorder — required before running MD/relaxation or showing polyhedra on a structure with fractionally occupied sites. The original is left untouched.
    </p>
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">
      <label for="osSampleCount" style="font-size: 11px; color: rgba(255,255,255,0.7);">Random samples</label>
      <input type="number" id="osSampleCount" min="1" max="30" step="1" value="${lastSampleCount}"
        title="How many independent random decorations to build and compare."
        style="width: 48px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box; text-align: center;">
      <label for="osSizeSelect" style="font-size: 11px; color: rgba(255,255,255,0.7);">Size</label>
      <select id="osSizeSelect" style="flex: 1; min-width: 90px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box; font-size: 11px;"></select>
    </div>
    <div style="display: flex; gap: 8px; margin-bottom: 8px;">
      <button id="osBuildBtn" class="btn-mini highlight" style="padding: 5px 10px; flex: 1;">Build Random Samples</button>
      <button id="osMajorityBtn" class="btn-mini" style="padding: 5px 10px;"
        title="Every site takes its most-occupied species. Faster, but destroys stoichiometry — a 50/50 Fe/Ni alloy becomes pure Fe.">Use Majority</button>
    </div>
    <div id="osStatus" style="font-size: 11px; color: rgba(255,255,255,0.6); margin-bottom: 6px; line-height: 1.4;"></div>
    <div id="osList" class="order-structure-list" hidden></div>
    <div id="osResultsActions" style="display: flex; gap: 6px; flex-wrap: wrap;" hidden>
      <button id="osCompareBtn" class="btn-mini highlight" style="padding: 5px 8px; flex: 1;">Compare Energy</button>
      <button id="osUseBtn" class="btn-mini" style="padding: 5px 8px; flex: 1;">Use Shown</button>
      <button id="osKeepAllBtn" class="btn-mini" style="padding: 5px 8px; flex: 1;">Keep All</button>
      <button id="osDiscardBtn" class="reset-btn" style="padding: 5px 8px;">Discard</button>
    </div>
  `;

  const sampleCountInput = container.querySelector('#osSampleCount');
  const sizeSelect = container.querySelector('#osSizeSelect');
  const buildBtn = container.querySelector('#osBuildBtn');
  const majorityBtn = container.querySelector('#osMajorityBtn');
  const listEl = container.querySelector('#osList');
  const compareBtn = container.querySelector('#osCompareBtn');
  const useBtn = container.querySelector('#osUseBtn');
  const keepAllBtn = container.querySelector('#osKeepAllBtn');
  const discardBtn = container.querySelector('#osDiscardBtn');

  sampleCountInput.addEventListener('input', () => {
    const n = Math.max(1, Math.round(Number(sampleCountInput.value)) || 1);
    lastSampleCount = n;
  });

  refreshOrderSizeOptions();
  setOrderBusy(orderBusy); // re-apply the current busy state to these fresh buttons
  renderOrderList(); // reflect whatever orderSession already holds (fresh mount or mid-session rebuild)

  buildBtn.addEventListener('click', async () => {
    if (orderBusy) return;
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;
    if (!structureHasFractionalOccupancy(structure)) {
      alert('This structure has no fractionally occupied sites — there is nothing to order.');
      return;
    }
    // The structure's disorder can have changed since this section last
    // mounted (an occupancy edit elsewhere doesn't rebuild this panel) —
    // re-read the size options fresh right before using one, rather than
    // trusting whatever was on screen from an earlier structure state.
    refreshOrderSizeOptions();
    const sampleCount = Math.max(1, Math.round(Number(sampleCountInput.value)) || 1);
    const multiplier = Number(sizeSelect.value) || 1;

    setOrderBusy(true);
    resetOrderSession(); // clear out any leftover row/state from a previous build
    setOrderStatus(`Building ${sampleCount} sample${sampleCount === 1 ? '' : 's'}…`);
    try {
      const built = [];
      for (let i = 0; i < sampleCount; i += 1) {
        const seed = i + 1;
        const b = buildOrderedStructure(structure, { method: 'random', seed, multiplier });
        built.push({ seed, built: b, energyPerAtom: null });
      }
      orderSession = { builtSamples: built, energiesComputed: false, previewStructure: null, previewRow: null, shownSeed: null };
      showOrderCandidate(built[0]);
      setOrderStatus(`${sampleCount} sample${sampleCount === 1 ? '' : 's'} built (${built[0].built.atoms.length} atoms each) — showing #1 in the 3D view. `
        + `${sampleCount > 1 ? 'Click a row to look at another, or ' : ''}Compare Energy to rank them.`);
    } finally {
      setOrderBusy(false);
    }
  });

  majorityBtn.addEventListener('click', () => {
    if (orderBusy) return;
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;
    if (!structureHasFractionalOccupancy(structure)) {
      alert('This structure has no fractionally occupied sites — there is nothing to order.');
      return;
    }
    const result = buildOrderedStructure(structure, { method: 'majority', seed: 1 });
    createNewStructureFromAtoms(
      result.atoms.map((atom, i) => ({
        element: result.elements[i],
        x: atom.position[0], y: atom.position[1], z: atom.position[2],
        color: null,
      })),
      { lattice: result.lattice, fileName: 'majority_structure' }
    );
    alert(result.report);
  });

  listEl.addEventListener('click', (e) => {
    if (orderBusy || !orderSession?.builtSamples) return;
    const row = e.target.closest('.order-structure-row');
    if (!row) return;
    const sample = orderSession.builtSamples.find((s) => String(s.seed) === row.dataset.seed);
    if (!sample || sample.seed === orderSession.shownSeed) return;
    showOrderCandidate(sample);
  });

  compareBtn.addEventListener('click', async () => {
    if (orderBusy || !orderSession?.builtSamples?.length) return;
    setOrderBusy(true);
    try {
      const { ensureCalculatorRunner } = await import('./BackendPanel/AtomisticPanels.js');
      const { buildNEPStructure } = await import('../atomistic/relaxer.js');
      const { runner } = await ensureCalculatorRunner((msg) => { setOrderStatus(msg); });
      const samples = orderSession.builtSamples;
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i];
        setOrderStatus(`Computing energy ${i + 1} / ${samples.length} (seed ${sample.seed})…`);
        const nepStruct = buildNEPStructure(runner, sample.built);
        // Sequential, not Promise.all: the wasm/gguf runner is a single
        // instance, not safely reentrant across concurrent compute() calls.
        const out = await runner.compute(nepStruct);
        sample.energyPerAtom = Number.isFinite(out.energy_per_atom)
          ? Number(out.energy_per_atom)
          : Number(out.total_energy) / sample.built.atoms.length;
      }
      samples.sort((a, b) => a.energyPerAtom - b.energyPerAtom);
      orderSession.energiesComputed = true;
      renderOrderList();
      showOrderCandidate(samples[0]); // land on the best one now that ranking is known
      setOrderStatus(`${samples.length} energ${samples.length === 1 ? 'y' : 'ies'} computed, lowest first — showing #1. Click a row to look at another.`);
    } catch (error) {
      setOrderStatus(`Could not compute energies: ${error.message || String(error)}`);
    } finally {
      setOrderBusy(false);
    }
  });

  useBtn.addEventListener('click', () => {
    if (orderBusy || !orderSession?.previewRow) return;
    // previewRow already IS the shown candidate's exact geometry — nothing
    // further to build. Just end the session so the next Build starts clean
    // instead of reusing/discarding this now-kept row.
    orderSession = null;
    renderOrderList();
    setOrderStatus('Kept as the new structure.');
  });

  keepAllBtn.addEventListener('click', () => {
    if (orderBusy || !orderSession?.builtSamples?.length) return;
    setOrderBusy(true);
    try {
      const samples = orderSession.builtSamples;
      const frames = samples.map((s) => {
        const elements = s.built.elements;
        const frame = new Structure({
          elements,
          uniqueElements: [...new Set(elements)],
          lattice: s.built.lattice.map((row) => [...row]),
          atoms: s.built.atoms.map((atom, i) => new Atom({
            position: [...atom.position],
            element: elements[i],
            uuid: atom.uuid,
          })),
          periodic: { hash: 'None', wrapped: null },
        });
        // Per-frame total energy (like an MD/relax trajectory) if this sample
        // was compared — the Trajectory panel picks it up automatically via
        // its own "Compute step stats" action.
        if (Number.isFinite(s.energyPerAtom)) frame.energy = s.energyPerAtom * s.built.atoms.length;
        return frame;
      });
      const hadEnergy = Number.isFinite(samples[0].energyPerAtom);
      const count = frames.length;
      // The in-progress preview row (if any) duplicates one of these frames,
      // now folded into the trajectory — drop it first so this doesn't leave
      // two rows behind.
      resetOrderSession();
      createTrajectoryFromFrames(frames, 'ordered_structures');
      setOrderStatus(`Kept all ${count} samples as one trajectory${hadEnergy ? ', sorted best (lowest energy) first' : ''}.`);
    } finally {
      setOrderBusy(false);
    }
  });

  discardBtn.addEventListener('click', () => {
    if (orderBusy) return;
    resetOrderSession();
    setOrderStatus('');
  });
}

/** "Add Vacuum" section content — grows the cell along X/Y/Z (Å), independent
 *  of the Supercell/Transformation sections above/below it. Lives here (Cell &
 *  Supercell) rather than the add-atoms popup: it modifies the cell, not the
 *  atom list, so it fits this panel's job much better. */
function addVacuumSection(container) {
  // X/Y/Z share one horizontal row, each input flex-growing to split the full
  // width evenly (the panel is far wider than three 56px boxes need), with the
  // Apply button centered on the line below.
  container.innerHTML = `
    <div style="margin-bottom: 10px;">
      <div style="display: flex; gap: 12px; margin-bottom: 10px;">
        <div style="display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0;">
          <label style="white-space: nowrap;">X (Å):</label>
          <input type="number" id="vacX" class="coord-input" value="0" step="0.1" style="flex: 1; min-width: 0; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
        </div>
        <div style="display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0;">
          <label style="white-space: nowrap;">Y (Å):</label>
          <input type="number" id="vacY" class="coord-input" value="0" step="0.1" style="flex: 1; min-width: 0; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
        </div>
        <div style="display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0;">
          <label style="white-space: nowrap;">Z (Å):</label>
          <input type="number" id="vacZ" class="coord-input" value="0" step="0.1" style="flex: 1; min-width: 0; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
        </div>
      </div>

      <div style="display: flex; justify-content: center;">
        <button id="applyVacuum" class="btn-mini highlight" style="padding: 5px 14px; background: var(--bg-color); color: white; cursor: pointer;">Apply Vacuum</button>
      </div>
    </div>
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11px; color: rgba(255,255,255,0.7); border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px;">
      <span id="vacuumAppliedText"></span>
      <button id="resetVacuum" class="btn-mini" style="padding: 3px 10px; font-size: 11px;">Reset Vacuum</button>
    </div>
  `;

  const statusText = container.querySelector('#vacuumAppliedText');
  const resetBtn = container.querySelector('#resetVacuum');

  function refreshVacuumStatus() {
    const state = fileBrowser.selectedStructure?._vacuumApplied;
    const applied = state && (state.x || state.y || state.z);
    if (applied) {
      statusText.textContent = `Vacuum applied: X=${state.x.toFixed(2)} Å, Y=${state.y.toFixed(2)} Å, Z=${state.z.toFixed(2)} Å`;
    } else {
      statusText.textContent = 'No vacuum applied yet.';
    }
    resetBtn.disabled = !applied;
    resetBtn.style.opacity = applied ? '1' : '0.4';
    resetBtn.style.cursor = applied ? 'pointer' : 'default';
  }
  refreshVacuumStatus();

  container.querySelector('#applyVacuum').addEventListener('click', () => {
    const vacX = parseFloat(container.querySelector('#vacX').value) || 0;
    const vacY = parseFloat(container.querySelector('#vacY').value) || 0;
    const vacZ = parseFloat(container.querySelector('#vacZ').value) || 0;
    applyVacuumToStructure(vacX, vacY, vacZ);
    refreshVacuumStatus();
  });

  resetBtn.addEventListener('click', () => {
    resetVacuumForStructure(fileBrowser.selectedStructure);
    refreshVacuumStatus();
  });
}

export function addLatticeAndSupercellPanel(target = "cvPanelBody-cell") {
  const targetPanel = document.getElementById(target);
  if (!targetPanel) {
    console.warn(`target container "${target}" not found.`);
    return;
  }

  // Remove old panel if it exists
  const oldPanel = document.getElementById("latticeAndSupercellGroup");
  if (oldPanel) oldPanel.remove();

  // --- Outer wrapper: a plain spacing container. Each section below is its own
  // .panel-section card (border + padding), so an extra frame here would just
  // double-border the whole group. ---
  const group = document.createElement("div");
  group.id = "latticeAndSupercellGroup";
  group.style.cssText = `padding: 2px;`;

  // --- Supercell section ---
  const supercellPanel = document.createElement("div");
  supercellPanel.id = "supercellPanel";
  supercellPanel.className = "panel-section";

  const supercellContent = document.createElement("div");
  supercellContent.id = "supercellContent";

  // --- Supercell Input Row ---
  let supercell = fileBrowser.selectedStructure;

  if (!supercell) fileBrowser.selectedStructure = { nx: 1, ny: 1, nz: 1 };

  const supercellInputRow = document.createElement("div");
  supercellInputRow.style.cssText = `
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
    justify-content: center;
  `;

  const supercellInputs = {};
  ["nx", "ny", "nz"].forEach((axis) => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value = general.currentSupercell ? general.currentSupercell[axis] : 1;
    input.style.cssText = `
      width: 50px;
      text-align: center;
      border: none;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.1);
      color: white;
      font-family: monospace;
      padding: 3px;
    `;
    supercellInputs[axis] = input;
    supercellInputRow.appendChild(input);
  });
  supercellContent.appendChild(supercellInputRow);

  // --- Supercell Buttons Row ---
  const supercellBtnRow = document.createElement("div");
  supercellBtnRow.style.cssText = `
    display: flex;
    gap: 8px;
    justify-content: center;
  `;

  const supercellApplyBtn = document.createElement("button");
  supercellApplyBtn.textContent = "Apply";
  supercellApplyBtn.className = "btn-mini highlight";
  supercellApplyBtn.style.cssText = `
    height: 32px;
    padding: 0 10px;
    font-size: 11px;
    margin-right: 4px;
    min-width: 80px;
  `;

  const supercellResetBtn = document.createElement("button");
  supercellResetBtn.textContent = "Reset";
  supercellResetBtn.className = "reset-btn";
  supercellResetBtn.style.cssText = `
    height: 32px;
    padding: 0 10px;
    font-size: 11px;
    margin-right: 4px;
    min-width: 80px;
  `;

  supercellBtnRow.appendChild(supercellApplyBtn);
  supercellBtnRow.appendChild(supercellResetBtn);
  supercellContent.appendChild(supercellBtnRow);

  supercellPanel.appendChild(makeSectionHeadline("Supercell"));
  supercellPanel.appendChild(supercellContent);

  // --- Vacuum section ---
  const vacuumPanel = document.createElement("div");
  vacuumPanel.id = "vacuumPanel";
  vacuumPanel.className = "panel-section";

  const vacuumContent = document.createElement("div");
  vacuumContent.id = "vacuumContent";

  vacuumPanel.appendChild(makeSectionHeadline("Vacuum"));
  vacuumPanel.appendChild(vacuumContent);
  addVacuumSection(vacuumContent);

  // --- Order Structure section ---
  const orderPanel = document.createElement("div");
  orderPanel.id = "orderStructurePanel";
  orderPanel.className = "panel-section";

  const orderContent = document.createElement("div");
  orderContent.id = "orderStructureContent";

  orderPanel.appendChild(makeSectionHeadline("Order Structure"));
  orderPanel.appendChild(orderContent);
  addOrderStructureSection(orderContent);

  // --- Transformation section ---
  const transformPanel = document.createElement("div");
  transformPanel.id = "transformPanel";
  transformPanel.className = "panel-section";

  const transformContent = document.createElement("div");
  transformContent.id = "transformContent";


  // --- Transformation Matrix Input ---
const transformMatrixContainer = document.createElement("div");
transformMatrixContainer.style.cssText = `
  margin-bottom: 8px;
`;

const transformTable = document.createElement("table");
transformTable.style.cssText = `
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
`;
const transformTbody = document.createElement("tbody");

// Create 3x4 matrix (3x3 for P, 1x3 for p)
for (let i = 0; i < 3; i++) {
  const tr = document.createElement("tr");
  for (let j = 0; j < 4; j++) {
    const td = document.createElement("td");
    td.style.cssText = `
      padding: 2px;
      ${j === 3 ? 'border-left: 1px solid rgba(255, 255, 255, 0.3);' : ''}
    `;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "TransformInput";
    input.step = "0.1";
    input.style.cssText = `
      width: 60px;
      text-align: center;
      font-family: monospace;
      padding: 2px;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: white;
    `;
    input.id = `transform_${i}_${j}`;

    // Set default values: identity matrix for P, zero for p
    if (j < 3) {
      input.value = i === j ? "1" : "0";
    } else {
      input.value = "0.0";
    }

    td.appendChild(input);
    tr.appendChild(td);
  }
  transformTbody.appendChild(tr);
}
transformTable.appendChild(transformTbody);
transformMatrixContainer.appendChild(transformTable);
transformContent.appendChild(transformMatrixContainer);



  // --- Transformation Buttons Row ---
  const transformBtnRow = document.createElement("div");
  transformBtnRow.style.cssText = `
    display: flex;
    gap: 8px;
    justify-content: center;
  `;

  const transformApplyBtn = document.createElement("button");
  transformApplyBtn.textContent = "Apply";
  transformApplyBtn.className = "btn-mini highlight";
  transformApplyBtn.style.cssText = `
    height: 32px;
    padding: 0 10px;
    font-size: 11px;
    margin-right: 4px;
    min-width: 80px;
  `;

  const transformResetBtn = document.createElement("button");
  transformResetBtn.textContent = "Reset";
  transformResetBtn.className = "reset-btn";
  transformResetBtn.style.cssText = `
    height: 32px;
    padding: 0 10px;
    font-size: 11px;
    margin-right: 4px;
    min-width: 80px;
  `;

  transformBtnRow.appendChild(transformApplyBtn);
  transformBtnRow.appendChild(transformResetBtn);
  transformContent.appendChild(transformBtnRow);

  transformPanel.appendChild(makeSectionHeadline("Lattice Transformation"));
  transformPanel.appendChild(transformContent);


  // --- Event Handlers ---

  supercellApplyBtn.onclick = () => {
    const newA = Math.max(1, parseInt(supercellInputs.nx.value));
    const newB = Math.max(1, parseInt(supercellInputs.ny.value));
    const newC = Math.max(1, parseInt(supercellInputs.nz.value));

    // Note: do NOT reset atoms/lattice/elements from `.original` here.
    // createSupercell() derives the base unit cell from the live (user-modified)
    // structure and re-tiles it to the requested factors, so modifications
    // (colour, opacity, moved atoms, …) are preserved across supercell changes.
    createSupercell(newA, newB, newC);
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: true,
    });
    resetView();
  };

  supercellResetBtn.onclick = () => {
    createSupercell(1, 1, 1);
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: true,
    });
    resetView();
  };


transformApplyBtn.onclick = () => {
  const matrix = [];
  for (let i = 0; i < 3; i++) {
    const row = [];
    for (let j = 0; j < 4; j++) {
      const val = parseFloat(document.getElementById(`transform_${i}_${j}`).value);
      row.push(isFinite(val) ? val : 0);
    }
    matrix.push(row);
  }
  console.log("Applying transformation:", matrix);
  applyLatticeTransformation(matrix);
};

transformResetBtn.onclick = () => {
  // Reset matrix UI to identity
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      const input = document.getElementById(`transform_${i}_${j}`);
      if (j < 3) {
        input.value = i === j ? "1" : "0";
      } else {
        input.value = "0.00000";
      }
    }
  }
  // Restore lattice and atom positions to original
  if (fileBrowser.selectedStructure.original) {
    // Restore lattice
    fileBrowser.selectedStructure.lattice = fileBrowser.selectedStructure.original.lattice.map(row => [...row]);
    // Restore only positions
    const atoms = fileBrowser.selectedStructure.atoms;
    const originalAtoms = fileBrowser.selectedStructure.original.atoms;
    for (let i = 0; i < atoms.length; i++) {
      atoms[i].position = [...originalAtoms[i].position];
    }
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: true,
      reRenderOther: false,
    });
    resetView();
    console.log("Transformation reset to original.");
  }
};

  // --- Build Structure ---
  group.appendChild(supercellPanel);
  group.appendChild(vacuumPanel);
  group.appendChild(orderPanel);
  group.appendChild(transformPanel);
  targetPanel.appendChild(group);

}

export function removeLatticeAndSupercellPanel() {
  const panel = document.getElementById('latticeAndSupercellGroup');
  if (panel) {
    panel.remove();
    console.log("Lattice & Supercell panel removed.");
  } else {
    console.warn("Lattice & Supercell panel does not exist.");
  }
}


