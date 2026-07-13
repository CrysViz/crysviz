// Keeps floating panels and split-view panes mutually exclusive as two
// separate groups: opening any histogram's floating panel closes every open
// histogram split view (and vice versa), but multiple panels (e.g. Bond
// Length + Coordination Number) can stay open together, and likewise
// multiple split views (they already coexist as tabs via SplitView.js).
// BondLengthHistogram.js / CoordinationHistogram.js call
// activatePanelDisplay(closeSelf) / activateSplitDisplay(closeSelf) right
// before they open, passing their own close function as an identity token,
// and deactivate*(closeSelf) whenever they close (by any path).

const openPanelClosers = new Set();
const openSplitClosers = new Set();

export function activatePanelDisplay(closeFn) {
  if (openSplitClosers.size) {
    for (const close of [...openSplitClosers]) close();
  }
  openPanelClosers.add(closeFn);
}

export function deactivatePanelDisplay(closeFn) {
  openPanelClosers.delete(closeFn);
}

export function activateSplitDisplay(closeFn) {
  if (openPanelClosers.size) {
    for (const close of [...openPanelClosers]) close();
  }
  openSplitClosers.add(closeFn);
}

export function deactivateSplitDisplay(closeFn) {
  openSplitClosers.delete(closeFn);
}
