import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.164/build/three.module.js';
import {updateVisualization} from '../crystal-viewer.js'
import {createBondLengthControls} from './BondLengthPanel.js'
import {fileBrowser,structureShip} from '../store.js';

let trajectoryPlayerElements = {};

export function addTrajectoryPlayer() {
  if (trajectoryPlayerElements.controlPanel) return;
     removeTrajectoryPlayer()
  
  console.warn("Trying to set up trajectory player");
  const trajControlPanel = document.createElement('div');
  trajControlPanel.id = 'TrajControlPanel';
  trajControlPanel.innerHTML = `
    <div class="panelHeader" id="panelHeader">Frame Controls <span id="foldToggle">▼</span></div>
    <div class="panelBody" id="panelBody">
      <div class="controlsRow">
        <button id="stepBackBtn">⏮️ </button>
        <button id="playPauseBtn">▶️</button>
        <button id="stepFwdBtn">⏭️</button>
      </div>
      <div style="display:flex; flex-direction:column; align-items:center; width:100%;">
        <label style="font-size: 12px; margin-bottom:4px;">Speed:</label>
        <select id="speedSelect">
          <option value="1">1x</option>
          <option value="0.5">0.5x</option>
          <option value="0.25">0.25x</option>
          <option value="2">2x</option>
        </select>
      </div>
      <div style="display:flex; flex-direction:column; align-items:center; width:100%;">
        <label style="font-size: 12px; margin-bottom:4px;">Frame Step:</label>
        <input type="number" id="frameStepInput" min="1" value="1" />
      </div>
      <input type="range" id="frameSlider" min="0" max="0" value="0" style="width: 100%" />
      <div id="frameIndicator">Frame: 0</div>
    </div>
  `;
  document.body.appendChild(trajControlPanel);

  trajectoryPlayerElements = {
    trajControlPanel,
    panelHeader:    trajControlPanel.querySelector('#panelHeader'),
    panelBody:      trajControlPanel.querySelector('#panelBody'),
    playPauseBtn:   trajControlPanel.querySelector('#playPauseBtn'),
    stepBackBtn:    trajControlPanel.querySelector('#stepBackBtn'),
    stepFwdBtn:     trajControlPanel.querySelector('#stepFwdBtn'),
    speedSelect:    trajControlPanel.querySelector('#speedSelect'),
    frameStepInput: trajControlPanel.querySelector('#frameStepInput'),
    frameSlider:    trajControlPanel.querySelector('#frameSlider'),
    frameIndicator: trajControlPanel.querySelector('#frameIndicator'),
    foldToggle:     trajControlPanel.querySelector('#foldToggle')
  };

  let currentFrame = 0;
  let playing = false;
  let playbackSpeed = 1;
  let frameStep = 1;

  function updateFrame(currentFrame) {
    //&updateStructureddFromRowAndStep(strucIndex); // this is already from me !!
    fileBrowser.stepInput.value = currentFrame;
  }

  // Show current frame immediately
  updateFrame();

  function animatePlayer() {
    const container = structureShip.container[fileBrowser.selectedRow]
    if (!container || currentFrame < 0 || currentFrame >= container.structures.length) return;
      
    requestAnimationFrame(animatePlayer);
    if (playing) {
      currentFrame += playbackSpeed * frameStep;
      if (currentFrame >= container.structures.length) currentFrame = 0;
      trajectoryPlayerElements.frameSlider.value = Math.floor(currentFrame);
      updateFrame(currentFrame);
    }
  }
  animatePlayer();

  trajectoryPlayerElements.playPauseBtn.onclick = () => {
    playing = !playing;
    trajectoryPlayerElements.playPauseBtn.textContent = playing ? '⏸️' : '▶️';
  };

  trajectoryPlayerElements.stepBackBtn.onclick = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶️';
    currentFrame = Math.max(0, currentFrame - frameStep);
    trajectoryPlayerElements.frameSlider.value = currentFrame;
    updateFrame();
  };

  trajectoryPlayerElements.stepFwdBtn.onclick = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶️';
    currentFrame = Math.min( - 1, currentFrame + frameStep);
    trajectoryPlayerElements.frameSlider.value = currentFrame;
    updateFrame(currentFrame);
  };

  trajectoryPlayerElements.frameSlider.oninput = () => {
    playing = false;
    trajectoryPlayerElements.playPauseBtn.textContent = '▶️';
    currentFrame = parseInt(trajectoryPlayerElements.frameSlider.value);
    updateFrame();
  };

  trajectoryPlayerElements.speedSelect.onchange = () => {
    playbackSpeed = parseFloat(trajectoryPlayerElements.speedSelect.value);
    if (playbackSpeed < 0.01) playbackSpeed = 0.01;
  };

  trajectoryPlayerElements.frameStepInput.onchange = () => {
    const val = parseInt(trajectoryPlayerElements.frameStepInput.value);
    frameStep = val > 0 ? val : 1;
  };

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

  trajectoryPlayerElements.foldToggle.addEventListener('click', () => {
    if (trajectoryPlayerElements.panelBody.style.display === 'none') {
      trajectoryPlayerElements.panelBody.style.display = 'flex';
      trajectoryPlayerElements.foldToggle.textContent = '▼';
    } else {
      trajectoryPlayerElements.panelBody.style.display = 'none';
      trajectoryPlayerElements.foldToggle.textContent = '▲';
    }
  });
};
export function removeTrajectoryPlayer() {
  if (!trajectoryPlayerElements.trajControlPanel) return;
  trajectoryPlayerElements.trajControlPanel.remove();
  trajectoryPlayerElements = {};
}

