import { updateVisualization } from '../core/crystal-viewer.js';
import { general, structureShip, fileBrowser } from '../state/store.js';
import { createBondLengthControls } from './BondLengthPanel.js';
import { updateSpins, removeSpins } from '../render/index.js';
import { updateForces, removeForces } from '../render/index.js';
import { syncPlanesForSelectedStructure } from './PlanesPanel.js';
import { createTrajectoryPlot } from './TrajectoryPlot.js';
import { openPanel, refreshPanelAvailability } from './panels/PanelManager.js';
import { stressMean } from '../atomistic/relaxer.js';
// Mean force magnitude over a frame's per-atom force vectors (eV/Å). Kept local
// so the panel does not depend on the Forces-panel/histogram machinery.
function meanForceMagnitude(structure) {
  const forces = structure?.forces;
  if (!forces?.length) return NaN;
  let sum = 0;
  let n = 0;
  for (const f of forces) {
    const v = f?.vector;
    if (!v || v.length < 3) continue;
    sum += Math.hypot(v[0], v[1], v[2]);
    n += 1;
  }
  return n ? sum / n : NaN;
}

let trajectoryPlayerElements = {};
let currentFrame = 0;
let playing = false;
let frameStep = 1;
let autoPlayInterval = null;

// --- Trajectory plot (unified MD Monitor) --------------------------------
// One plot singleton, lazily built into whatever "Trajectory" panel body is
// currently mounted. It is torn down by removeTrajectoryPlayer() and rebuilt
// on demand (by addTrajectoryPlayer() or the live-MD bridge below), so it
// survives panel collapse/expand cycles without leaking DOM/listeners.
let trajPlot = null;
let trajPlotHostEl = null;
// True while a live MD/relax run is actively streaming steps into the plot;
// makes hasPlottableData() report true even before any frame has energy.
let liveActive = false;

// True if the container has anything worth plotting: per-frame energy on any
// structure, per-frame forces on any structure, or an active live-MD feed.
function hasPlottableData(container) {
  if (liveActive) return true;
  if (!container?.structures?.length) return false;
  return container.structures.some(
    (s) => Number.isFinite(s?.energy) || (s?.forces && s.forces.length > 0)
  );
}

function setPlotVisible(visible) {
  if (trajPlotHostEl) trajPlotHostEl.style.display = visible ? '' : 'none';
}

// Show the "Compute step stats" button only for a loaded trajectory that has
// per-frame energy and/or forces to crunch, and never during a live MD/relax
// feed (that already streams its own series).
function updateComputeStepStatsBtnVisibility(container) {
  // The "Compute step stats" action now lives inside the plot's own toolbar
  // (see TrajectoryPlot.js). Show it only for a loaded trajectory that has
  // per-frame energy and/or forces to crunch, and never during a live MD/relax
  // feed (that already streams its own series) or once a series exists (a click
  // would wipe it).
  if (!trajPlot) return;
  const alreadyPlotted = !!(container?.plotSeries && Object.keys(container.plotSeries).length);
  const hasData = !!container?.structures?.some(
    (s) => Number.isFinite(s?.energy) || (s?.forces && s.forces.length > 0)
  );
  trajPlot.setComputeStatsAvailable(!liveActive && hasData && !alreadyPlotted);
}

// Frames per chunk when bulk-computing step stats for a large trajectory, and
// the frame-count threshold above which we chunk at all (keeps small
// trajectories snappy with a plain synchronous loop).
const COMPUTE_STATS_CHUNK = 500;
const COMPUTE_STATS_CHUNK_THRESHOLD = 2000;

// Build { etotEv, meanForce } series from data already present in each frame
// (OUTCAR-parsed energy/forces) — no MLIP/model run. meanForce is the mean of
// per-atom |F| computed locally (see meanForceMagnitude).
let computingStats = false;
function computeStepStats(container) {
  if (computingStats) return;
  const structures = container?.structures ?? [];
  if (!structures.length) return;
  computingStats = true;
  // Hide the in-plot action while the compute runs (and it stays hidden after,
  // since a series will now exist — see updateComputeStepStatsBtnVisibility).
  if (trajPlot) trajPlot.setComputeStatsAvailable(false);

  const etotEv = new Array(structures.length);
  const meanForce = new Array(structures.length);
  const pressure = new Array(structures.length);
  let hasEnergy = false;
  let hasForce = false;
  let hasPressure = false;

  function processRange(start, end) {
    for (let i = start; i < end; i++) {
      const s = structures[i];
      const e = Number.isFinite(s?.energy) ? s.energy : NaN;
      etotEv[i] = e;
      if (Number.isFinite(e)) hasEnergy = true;

      const mean = meanForceMagnitude(s);
      meanForce[i] = Number.isFinite(mean) ? mean : NaN;
      if (Number.isFinite(mean)) hasForce = true;

      // Pressure = mean of the frame's stress-tensor diagonal (NaN when absent).
      const p = stressMean(s?.stress?.tensor);
      pressure[i] = Number.isFinite(p) ? p : NaN;
      if (Number.isFinite(p)) hasPressure = true;
    }
  }

  function finish() {
    // Merge into any existing series rather than replacing it, so a live MD
    // run's temperature/energy survive when mean force is added.
    const seriesObj = container.plotSeries ? { ...container.plotSeries } : {};
    if (hasEnergy && !Array.isArray(seriesObj.etotEv)) seriesObj.etotEv = etotEv;
    if (hasForce) seriesObj.meanForce = meanForce;
    if (hasPressure) seriesObj.pressure = pressure;

    if (Object.keys(seriesObj).length) {
      // Persist on the container so the plot redraws after a panel rebuild.
      container.plotSeries = seriesObj;
      const plot = ensurePlot();
      if (plot) {
        plot.setSeries(seriesObj);
        setPlotVisible(true);
        plot.setCursor(currentFrame);
      }
    }

    computingStats = false;
  }

  if (structures.length > COMPUTE_STATS_CHUNK_THRESHOLD) {
    let idx = 0;
    const step = () => {
      const end = Math.min(idx + COMPUTE_STATS_CHUNK, structures.length);
      processRange(idx, end);
      idx = end;
      if (idx < structures.length) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
  } else {
    processRange(0, structures.length);
    finish();
  }
}

// Build (once) the plot instance inside the currently-mounted panel body.
// No-ops (returns null) if the panel body isn't in the DOM yet — callers
// (feedLiveStep in particular) must tolerate that and just skip the update;
// the plot catches up next time it's called after the panel body appears.
function ensurePlot() {
  if (trajPlot) return trajPlot;
  const panelBody = trajectoryPlayerElements.panelBody;
  if (!panelBody) return null;

  trajPlotHostEl = panelBody.querySelector('#trajPlotHost');
  if (!trajPlotHostEl) {
    trajPlotHostEl = document.createElement('div');
    trajPlotHostEl.id = 'trajPlotHost';
    panelBody.appendChild(trajPlotHostEl);
  }
  trajPlotHostEl.style.display = 'none';

  trajPlot = createTrajectoryPlot(trajPlotHostEl, { maxPts: 5000 });
  trajPlot.onSeek((f) => {
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    if (!container?.structures?.length) return;
    playing = false;
    if (trajectoryPlayerElements.playPauseBtn) trajectoryPlayerElements.playPauseBtn.textContent = '▶';
    currentFrame = Math.max(0, Math.min(container.structures.length - 1, f));
    updateFrame(currentFrame, container);
  });
  // "Compute step stats" lives in the plot's own toolbar now; run it against
  // whichever container is selected at click time.
  trajPlot.onComputeStats(() => {
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    if (container) computeStepStats(container);
  });
  return trajPlot;
}

// Populate/refresh the plot region from file-loaded data (replay case, not
// live MD). Called once on panel build. Leaves the region hidden when there
// is nothing to show, or when data is forces-only (Phase 3 adds a "compute
// mean force" button for that case — we don't compute it here).
function refreshPlotFromContainer(container) {
  const plot = ensurePlot();
  if (!plot) return;
  if (liveActive) {
    // A live run owns the series; just make sure the region is visible.
    setPlotVisible(true);
    return;
  }
  // Preferred source: a full series persisted on the container (live MD stores
  // temperature/target/energy here; "Compute step stats" stores energy/force).
  // This is what makes replay survive a panel rebuild — the in-memory plot is
  // gone, but the container still carries everything needed to redraw it.
  const persisted = seriesFromContainer(container);
  if (persisted) {
    plot.setSeries(persisted);
    setPlotVisible(true);
    plot.setCursor(currentFrame);
    return;
  }
  if (!hasPlottableData(container)) {
    setPlotVisible(false);
    return;
  }
  const hasEnergy = container.structures.some((s) => Number.isFinite(s?.energy));
  if (hasEnergy) {
    const etotEv = container.structures.map((s) => (Number.isFinite(s?.energy) ? s.energy : NaN));
    plot.setSeries({ etotEv });
    setPlotVisible(true);
    plot.setCursor(currentFrame);
  } else {
    // Forces-only data: nothing to auto-populate yet.
    setPlotVisible(false);
  }
}

// Return the container's persisted plot series if it has any finite data,
// else null. Shared by replay (refreshPlotFromContainer) and set by live MD
// (mdContainer.plotSeries) / computeStepStats.
function seriesFromContainer(container) {
  const ps = container?.plotSeries;
  if (!ps) return null;
  const out = {};
  let any = false;
  for (const [name, arr] of Object.entries(ps)) {
    if (Array.isArray(arr) && arr.some(Number.isFinite)) { out[name] = arr; any = true; }
  }
  return any ? out : null;
}

// --- Live-MD bridge (module-level, usable before the panel DOM exists) ---

/** Make sure the Trajectory panel is open/expanded so the plot is visible
 * during a live run. Reuses the existing PanelManager openPanel() API (same
 * one the Features window uses); safe no-op if the panel isn't registered. */
export function ensureTrajectoryPanelForLive() {
  // Mark the run active BEFORE opening so the panel's available() (which ORs in
  // isLivePlotActive) is true even though the MD container starts with a single
  // seed frame — otherwise the panel would stay in its "not available" state and
  // never pop up for live feedback until enough frames had accrued.
  liveActive = true;
  try {
    refreshPanelAvailability();
    openPanel('trajectory');
  } catch {
    // PanelManager not ready / panel not registered — plot still works once
    // the user opens the panel manually; feedLiveStep() stays robust either way.
  }
}

/** True while a live MD/relax run is streaming into the plot. Consulted by the
 * Trajectory panel's available() so it pops up immediately for live feedback. */
export function isLivePlotActive() {
  return liveActive;
}

/** Feed one live MD/relax step into the plot. Safe to call even if the panel
 * body isn't built yet (ensurePlot() just no-ops until it is; call
 * ensureTrajectoryPanelForLive() first so it typically is). */
export function feedLiveStep(point) {
  liveActive = true;
  updateComputeStepStatsBtnVisibility(structureShip.container[fileBrowser.selectedRowIndex]);
  const plot = ensurePlot();
  if (!plot) return;
  setPlotVisible(true);
  plot.update(point);
}

/** Reset the live plot state at the start of a new run. */
export function resetLivePlot() {
  liveActive = false;
  if (trajPlot) trajPlot.clear();
  setPlotVisible(false);
  updateComputeStepStatsBtnVisibility(structureShip.container[fileBrowser.selectedRowIndex]);
}

/** End the live feed (run finished/stopped/failed). Hands the plot back to the
 * container's persisted series so replay survives later panel rebuilds. */
export function endLiveFeed() {
  liveActive = false;
  updateComputeStepStatsBtnVisibility(structureShip.container[fileBrowser.selectedRowIndex]);
}

// --- Update scene from a specific frame ---
function updateStructureFromFrame(frame, container) {
  if (!container || frame < 0 || frame >= container.structures.length) return;

  fileBrowser.selectedStructure = container.structures[frame];
  fileBrowser.stepInput = frame;
  syncPlanesForSelectedStructure();

  createBondLengthControls();

  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });

  // Forces and spins must be updated AFTER updateVisualization so periodic.wrapped is ready
  const structure = fileBrowser.selectedStructure;

  if (general.forcesActive && structure.forces?.length > 0) {
    updateForces(general.forceScale ?? 1.0);
  } else {
    removeForces();
  }

  if (general.spinsActive && structure.spins?.length > 0) {
    updateSpins(general.spinScale ?? 1.0);
  } else {
    removeSpins();
  }
}

// --- Update UI and scene ---
// opts.render=false updates only the label/slider/cursor without re-rendering
// the 3D viewer — used while a live MD/relax run owns the scene, or for a
// single-frame container where there is nothing to scrub.
function updateFrame(frame, container, opts = {}) {
  if (!container) return;
  const numFrames = container.structures.length;

  const ind = trajectoryPlayerElements.frameIndicator;
  const cur = ind && ind.querySelector('.tfCur');
  const tot = ind && ind.querySelector('.tfTot');
  if (cur && tot) { cur.textContent = frame + 1; tot.textContent = numFrames; }
  else if (ind) ind.textContent = `${frame + 1} / ${numFrames}`;
  if (trajectoryPlayerElements.frameSlider) trajectoryPlayerElements.frameSlider.value = frame;

  if (opts.render !== false) updateStructureFromFrame(frame, container);

  if (trajPlot) trajPlot.setCursor(frame);
}

// --- Auto-play control ---
function startAutoPlay(container, intervalMs = 200) {
  if (!container || container.structures.length <= 1) return;
  if (autoPlayInterval) clearInterval(autoPlayInterval);

  autoPlayInterval = setInterval(() => {
    if (!playing) return;

    currentFrame += frameStep;
    if (currentFrame >= container.structures.length) currentFrame = 0;

    updateFrame(currentFrame, container);
  }, intervalMs);
}

function stopAutoPlay() {
  if (autoPlayInterval) {
    clearInterval(autoPlayInterval);
    autoPlayInterval = null;
  }
}

// --- Main function to add panel ---
// Builds the trajectory controls into the given container (the unified
// "Trajectory" panel window's body); the window provides the title bar,
// dragging and collapse.
export function addTrajectoryPlayer(target = 'cvPanelBody-trajectory') {
  if (trajectoryPlayerElements.trajControlPanel) return;
  removeTrajectoryPlayer();

  const targetPanel = document.getElementById(target);
  if (!targetPanel) return;

  const trajControlPanel = document.createElement('div');
  trajControlPanel.id = 'TrajControlPanel';
  trajControlPanel.innerHTML = `
    <div class="panelBody" id="panelBody">
      <div class="trajTransport">
        <button id="stepBackBtn" class="trajBtn" type="button" title="Previous frame">⏮</button>
        <button id="playPauseBtn" class="trajBtn" type="button" title="Play / pause">▶</button>
        <button id="stepFwdBtn" class="trajBtn" type="button" title="Next frame">⏭</button>
        <input type="range" id="frameSlider" class="trajSlider" min="0" max="0" value="0" />
        <span id="frameIndicator" class="trajFrameLabel" title="Current frame"><span class="tfCur">0</span><span class="tfSep">/</span><span class="tfTot">0</span></span>
      </div>
      <div class="trajOptions">
        <label class="trajOpt">Speed
          <select id="speedSelect">
            <option value="500">0.5s</option>
            <option value="200">0.2s</option>
            <option value="100">0.1s</option>
            <option value="50" selected>0.05s</option>
          </select>
        </label>
        <label class="trajOpt">Step
          <input type="number" id="frameStepInput" min="1" value="1" />
        </label>
      </div>
      <div id="trajPlotHost" style="display:none;"></div>
    </div>
  `;
  targetPanel.appendChild(trajControlPanel);

  trajectoryPlayerElements = {
    trajControlPanel,
    panelBody: trajControlPanel.querySelector('#panelBody'),
    playPauseBtn: trajControlPanel.querySelector('#playPauseBtn'),
    stepBackBtn: trajControlPanel.querySelector('#stepBackBtn'),
    stepFwdBtn: trajControlPanel.querySelector('#stepFwdBtn'),
    speedSelect: trajControlPanel.querySelector('#speedSelect'),
    frameStepInput: trajControlPanel.querySelector('#frameStepInput'),
    frameSlider: trajControlPanel.querySelector('#frameSlider'),
    frameIndicator: trajControlPanel.querySelector('#frameIndicator'),
  };

  const container = structureShip.container[fileBrowser.selectedRowIndex];
  if (!container || container.structures.length === 0) return;

  trajectoryPlayerElements.frameSlider.max = container.structures.length - 1;
  // Clamp a frame index carried over from a previous (longer) trajectory.
  currentFrame = Math.min(currentFrame, Math.max(0, container.structures.length - 1));
  // Don't re-render the scene on build while a live run owns it, or for a
  // single-frame container (avoids a redundant re-render of the source structure).
  const renderOnBuild = !liveActive && container.structures.length > 1;
  updateFrame(currentFrame, container, { render: renderOnBuild });
  refreshPlotFromContainer(container);
  updateComputeStepStatsBtnVisibility(container);

  // Disable play button if only 1 frame
  if (container.structures.length <= 1) {
    trajectoryPlayerElements.playPauseBtn.disabled = true;
  }

  // --- Button & slider events ---
  trajectoryPlayerElements.playPauseBtn.onclick = () => {
    playing = !playing;
    trajectoryPlayerElements.playPauseBtn.textContent = playing ? '⏸' : '▶';
    if (playing) startAutoPlay(container, parseInt(trajectoryPlayerElements.speedSelect.value));
    else stopAutoPlay();
  };

  trajectoryPlayerElements.stepBackBtn.onclick = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶';
    currentFrame = Math.max(0, currentFrame - frameStep);
    updateFrame(currentFrame, container);
  };

  trajectoryPlayerElements.stepFwdBtn.onclick = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶';
    currentFrame = Math.min(container.structures.length - 1, currentFrame + frameStep);
    updateFrame(currentFrame, container);
  };

  trajectoryPlayerElements.frameSlider.oninput = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶';
    currentFrame = parseInt(trajectoryPlayerElements.frameSlider.value);
    updateFrame(currentFrame, container);
  };

  trajectoryPlayerElements.speedSelect.onchange = () => {
    if (playing) {
      stopAutoPlay();
      startAutoPlay(container, parseInt(trajectoryPlayerElements.speedSelect.value));
    }
  };

  trajectoryPlayerElements.frameStepInput.onchange = () => {
    const val = parseInt(trajectoryPlayerElements.frameStepInput.value);
    frameStep = val > 0 ? val : 1;
  };
}

// --- Remove panel ---
export function removeTrajectoryPlayer() {
  stopAutoPlay();
  if (trajPlot) {
    trajPlot.remove();
    trajPlot = null;
  }
  trajPlotHostEl = null;
  if (!trajectoryPlayerElements.trajControlPanel) return;
  trajectoryPlayerElements.trajControlPanel.remove();
  trajectoryPlayerElements = {};
}

