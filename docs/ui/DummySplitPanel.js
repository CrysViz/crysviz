// Minimal example of a second feature using the generic split view
// (docs/ui/panels/SplitView.js) — the same pane EOSPanel.js/EOSSplitView.js
// use for the EOS fit plots, here holding nothing more than a click counter.
// Kept deliberately trivial so the wiring (not the feature) is what stands out.

import { openSplitView, closeSplitView } from './panels/SplitView.js';

const state = { count: 0 };

function updateSplitDisplay() {
  const el = document.getElementById('splitPaneBody')?.querySelector('#dummyCounterValue');
  if (el) el.textContent = String(state.count);
}

function updateDockedDisplay() {
  const el = document.getElementById('cvPanelBody-splitDemo')?.querySelector('#dummyDockedValue');
  if (el) el.textContent = String(state.count);
}

function renderSplitContent(body) {
  body.innerHTML = `
    <div class="split-item dummy-counter-item">
      <h4>Shared Counter</h4>
      <div class="split-item-body dummy-counter-display" id="dummyCounterValue">${state.count}</div>
      <div class="split-item-actions">
        <button type="button" class="split-item-action-btn" data-split-action="reset">Reset</button>
        <button type="button" class="split-item-action-btn" data-split-action="increment">+1</button>
      </div>
    </div>
  `;
}

function handleAction(action) {
  if (action === 'increment') state.count += 1;
  else if (action === 'reset') state.count = 0;
  updateSplitDisplay();
  updateDockedDisplay();
}

const owner = {
  title: 'Split View Demo',
  panelId: 'splitDemo', // lets the split-view tab's ✕ collapse this dock panel
  render: renderSplitContent,
  onAction: handleAction,
};

export function openDummySplitView() {
  openSplitView(owner);
}

export function closeDummySplitView() {
  closeSplitView(owner);
}

export function addDummySplitPanel(target = 'cvPanelBody-splitDemo') {
  const container = document.getElementById(target);
  if (!container) return;

  container.innerHTML = `
    <div class="control-group">
      <p>Trivial demo of the shared split-view pane: expand this panel to open
      it on the right, then increment the counter from either side.</p>
      <div class="dummy-docked-row">
        <span>Count: <strong id="dummyDockedValue">${state.count}</strong></span>
        <button type="button" id="dummyIncrementBtn" class="btn-mini">+1</button>
      </div>
    </div>
  `;

  container.querySelector('#dummyIncrementBtn').addEventListener('click', () => {
    state.count += 1;
    updateDockedDisplay();
    updateSplitDisplay();
  });
}

export function removeDummySplitPanel() {
  // Counter state intentionally persists across rebuilds, same as EOSPanel's
  // fit data — there is nothing panel-specific to tear down here.
}
