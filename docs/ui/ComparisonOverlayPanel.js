// Unified "Comparison" panel window: hosts the classic single-structure
// Comparison mode and the Multi-Structure Overlay mode as two tabs of the
// same panel, rather than two separate dock windows — they're mutually
// exclusive (ui/FileBrowswerPanel.js's syncOverlayFromCheckboxes), so
// presenting them as tabs of one panel reads clearer than two panels that
// silently fight over the same file-browser checkboxes.

import { createTabSwitcher } from './TabSwitcher.js';
import { addCompPanel, removeCompPanel } from './ComparisonPanel.js';
import { addOverlayPanel, removeOverlayPanel } from './OverlayPanel.js';

const TAB_IDS = ['comparison', 'overlay'];

// Persists across rebuilds (structure/checkbox changes rebuild this panel
// from scratch) so the user's chosen tab doesn't reset to "Comparison" every
// time they check a row.
let activeTabId = 'comparison';

// The two tab bodies, kept so the panel's own teardown can tear both down
// regardless of which one was ever rendered (tabs render lazily).
let comparisonBody = null;
let overlayBody = null;

export function addComparisonOverlayPanel(container) {
  if (!container) return;
  container.innerHTML = '';
  comparisonBody = null;
  overlayBody = null;

  // Snapshot BEFORE building the switcher: createTabSwitcher activates its own
  // default tab (the first one) as part of construction, which fires that
  // tab's onActivate and would otherwise clobber activeTabId with 'comparison'
  // before we get to read it below.
  const restoreTabId = TAB_IDS.includes(activeTabId) ? activeTabId : 'comparison';

  const { setActive } = createTabSwitcher(container, [
    {
      id: 'comparison',
      label: 'Comparison',
      render: (body) => { comparisonBody = body; addCompPanel(body); },
      onActivate: () => { activeTabId = 'comparison'; },
    },
    {
      id: 'overlay',
      label: 'Overlay',
      render: (body) => { overlayBody = body; addOverlayPanel(body); },
      onActivate: () => { activeTabId = 'overlay'; },
    },
  ]);

  setActive(restoreTabId);
}

export function removeComparisonOverlayPanel() {
  removeCompPanel(comparisonBody);
  removeOverlayPanel(overlayBody);
  comparisonBody = null;
  overlayBody = null;
}
