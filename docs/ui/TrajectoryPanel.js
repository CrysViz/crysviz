import { updateVisualization } from '../core/crystal-viewer.js';
import { general, structureShip, fileBrowser } from '../state/store.js';
import { createBondLengthControls } from './BondLengthPanel.js';
import { updateSpins, removeSpins } from '../render/index.js';
import { updateForces, removeForces } from '../render/index.js';
import { syncPlanesForSelectedStructure } from './PlanesPanel.js';
import { refreshDocking } from './ThemeManager.js';

let trajectoryPlayerElements = {};
let currentFrame = 0;
let playing = false;
let frameStep = 1;
let autoPlayInterval = null;

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

  if (general.spinForceState === "Forces" && structure.forces?.length > 0) {
    updateForces(general.forceScale ?? 1.0);
  } else {
    removeForces();
  }

  if (general.spinForceState === "Spins" && structure.spins?.length > 0) {
    updateSpins(general.spinScale ?? 1.0);
  } else {
    removeSpins();
  }
}

// --- Update UI and scene ---
function updateFrame(frame, container) {
  if (!container) return;
  const numFrames = container.structures.length;

  trajectoryPlayerElements.frameIndicator.textContent = `Frame: ${frame + 1}/${numFrames}`;
  if (trajectoryPlayerElements.frameSlider) trajectoryPlayerElements.frameSlider.value = frame;

  updateStructureFromFrame(frame, container);
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
export function addTrajectoryPlayer() {
  if (trajectoryPlayerElements.trajControlPanel) return;
  removeTrajectoryPlayer();

  const trajControlPanel = document.createElement('div');
  trajControlPanel.id = 'TrajControlPanel';
  trajControlPanel.style.display = 'inline'; // visible
  trajControlPanel.innerHTML = `
    <div class="panelHeader" id="panelHeader">
      Trajectory Controls <span id="foldToggle">▼</span>
    </div>
    <div class="panelBody" id="panelBody">
      <div class="controlsRow">
        <button id="stepBackBtn" className="control-button">⏮️</button>
        <button id="playPauseBtn" className="control-button">▶️</button>
        <button id="stepFwdBtn" className="control-button">⏭️</button>
      </div>
      <div style="display:flex; flex-direction:column; align-items:center; width:100%;">
        <label style="font-size:12px; margin-bottom:4px;">Speed:</label>
        <select id="speedSelect">
          <option value="500">0.5s</option>
          <option value="200" selected>0.2s</option>
          <option value="100">0.1s</option>
          <option value="50">0.05s</option>
        </select>
      </div>
      <div style="display:flex; flex-direction:column; align-items:center; width:100%;">
        <label style="font-size:12px; margin-bottom:4px;">Frame Step:</label>
        <input type="number" id="frameStepInput" min="1" value="1" />
      </div>
      <input type="range" id="frameSlider" min="0" max="0" value="0" style="width:100%" />
      <div id="frameIndicator">Frame: 0</div>
    </div>
  `;
  document.body.appendChild(trajControlPanel);
  refreshDocking(); // dock into #ui if a docked theme is active

  trajectoryPlayerElements = {
    trajControlPanel,
    panelHeader: trajControlPanel.querySelector('#panelHeader'),
    panelBody: trajControlPanel.querySelector('#panelBody'),
    playPauseBtn: trajControlPanel.querySelector('#playPauseBtn'),
    stepBackBtn: trajControlPanel.querySelector('#stepBackBtn'),
    stepFwdBtn: trajControlPanel.querySelector('#stepFwdBtn'),
    speedSelect: trajControlPanel.querySelector('#speedSelect'),
    frameStepInput: trajControlPanel.querySelector('#frameStepInput'),
    frameSlider: trajControlPanel.querySelector('#frameSlider'),
    frameIndicator: trajControlPanel.querySelector('#frameIndicator'),
    foldToggle: trajControlPanel.querySelector('#foldToggle')
  };

  const container = structureShip.container[fileBrowser.selectedRowIndex];
  if (!container || container.structures.length === 0) return;

  trajectoryPlayerElements.frameSlider.max = container.structures.length - 1;
  updateFrame(currentFrame, container);

  // Disable play button if only 1 frame
  if (container.structures.length <= 1) {
    trajectoryPlayerElements.playPauseBtn.disabled = true;
  }

  // --- Button & slider events ---
  trajectoryPlayerElements.playPauseBtn.onclick = () => {
    playing = !playing;
    trajectoryPlayerElements.playPauseBtn.textContent = playing ? '⏸️' : '▶️';
    if (playing) startAutoPlay(container, parseInt(trajectoryPlayerElements.speedSelect.value));
    else stopAutoPlay();
  };

  trajectoryPlayerElements.stepBackBtn.onclick = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶️';
    currentFrame = Math.max(0, currentFrame - frameStep);
    updateFrame(currentFrame, container);
  };

  trajectoryPlayerElements.stepFwdBtn.onclick = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶️';
    currentFrame = Math.min(container.structures.length - 1, currentFrame + frameStep);
    updateFrame(currentFrame, container);
  };

  trajectoryPlayerElements.frameSlider.oninput = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶️';
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

  // --- Dragging ---
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  trajectoryPlayerElements.panelHeader.addEventListener('mousedown', (e) => {
    if (e.target === trajectoryPlayerElements.foldToggle) return;
    isDragging = true;
    dragOffsetX = e.clientX - trajControlPanel.offsetLeft;
    dragOffsetY = e.clientY - trajControlPanel.offsetTop;
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      trajControlPanel.style.left = e.clientX - dragOffsetX + 'px';
      trajControlPanel.style.top = e.clientY - dragOffsetY + 'px';
    }
  });

  document.addEventListener('mouseup', () => { isDragging = false; });

  // --- Fold toggle ---
  trajectoryPlayerElements.foldToggle.addEventListener('click', () => {
    if (trajectoryPlayerElements.panelBody.style.display === 'none') {
      trajectoryPlayerElements.panelBody.style.display = 'flex';
      trajectoryPlayerElements.foldToggle.textContent = '▼';
    } else {
      trajectoryPlayerElements.panelBody.style.display = 'none';
      trajectoryPlayerElements.foldToggle.textContent = '▲';
    }
  });
}

// --- Remove panel ---
export function removeTrajectoryPlayer() {
  stopAutoPlay();
  if (!trajectoryPlayerElements.trajControlPanel) return;
  trajectoryPlayerElements.trajControlPanel.remove();
  trajectoryPlayerElements = {};
}

