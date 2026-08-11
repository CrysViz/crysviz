// Minimal reference example of a side-dock-by-default window (registered in
// ui/panels/defaultPanels.js as 'splitDemo', closed by default — open it with
// openPanel('splitDemo') from the console or a test). One ordinary window
// body holding a .split-item content card with action buttons, including the
// generic ⛶ fullscreen expand the EOS plots use. Kept deliberately trivial so
// the wiring (not the feature) is what stands out.

import { expandSplitItem, closeExpandedSplitItem } from './panels/SideDock.js';

const state = { count: 0 };

function updateDisplays() {
  const body = document.getElementById('cvPanelBody-splitDemo');
  if (!body) return;
  for (const el of body.querySelectorAll('.dummy-count-value')) {
    el.textContent = String(state.count);
  }
}

export function addDummySplitPanel(target = 'cvPanelBody-splitDemo') {
  const container = document.getElementById(target);
  if (!container) return;

  container.innerHTML = `
    <div class="control-group">
      <p>Trivial demo window: it defaults to the side dock, but can be
      dragged out to float or into the left bar like any window. The counter
      lives in module state, so it survives closing and reopening.</p>
      <div class="dummy-docked-row">
        <span>Count: <strong class="dummy-count-value">${state.count}</strong></span>
        <button type="button" class="btn-mini" data-split-action="increment">+1</button>
      </div>
    </div>
    <div class="split-item dummy-counter-item">
      <h4>Shared Counter</h4>
      <div class="split-item-body dummy-counter-display dummy-count-value">${state.count}</div>
      <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
      <div class="split-item-actions">
        <button type="button" class="split-item-action-btn" data-split-action="reset">Reset</button>
        <button type="button" class="split-item-action-btn" data-split-action="increment">+1</button>
        <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
      </div>
    </div>
  `;

  // One delegated listener for all [data-split-action] buttons — the same
  // idiom the EOS window uses, so actions keep working when the window is
  // side-docked, floating or main-docked.
  container.addEventListener('click', (ev) => {
    const btn = /** @type {HTMLElement} */ (ev.target).closest('[data-split-action]');
    if (!btn) return;
    const action = /** @type {HTMLElement} */ (btn).dataset.splitAction;
    if (action === 'increment') state.count += 1;
    else if (action === 'reset') state.count = 0;
    else if (action === 'expand') expandSplitItem(btn.closest('.split-item'));
    else if (action === 'close') closeExpandedSplitItem();
    updateDisplays();
  });
}

export function removeDummySplitPanel() {
  // Counter state intentionally persists across rebuilds, same as EOSPanel's
  // fit data — there is nothing panel-specific to tear down here.
}
