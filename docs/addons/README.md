# CrysViz Addons

An addon is a **SplitView feature**: a self-contained tool that opens in the
shared right-side split pane next to the 3D view (`docs/ui/panels/SplitView.js`)
and can read and drive the structure shown in the main viewer.

## Writing an addon

1. Create `docs/ui/<Name>SplitView.js` — copy `docs/ui/DummySplitPanel.js`
   (or `docs/ui/EOSSplitView.js` / `docs/ui/LandscapeSplitView.js` for a
   fuller reference) as the template. It owns the docked-panel description
   and the render/resize/close plumbing that hands off to
   `openSplitView`/`closeSplitView`.
2. Register it in `docs/ui/panels/defaultPanels.js` (`registerDefaultPanels`):
   add a `registerPanel({...})` block with `buildContent`/`onDestroyContent`
   for the left-dock panel and `onExpand`/`onCollapse` to open/close the split
   view. See the existing `'eos'`, `'splitDemo'`, and `'landscape'` entries
   for the exact shape.
3. Any structure/theme glue your addon needs (reading the active structure,
   driving fractional positions via the fast in-place path, loading a new
   structure, subscribing to structure/theme changes) lives in
   `docs/ui/AddonAPI.js` (`createAddonAPI`) — reuse it rather than importing
   app internals directly.

The energy-landscape addon (`docs/addons/landscape/`) is the current
non-trivial example: `landscape.js` is the controller, `heatmap.js` the canvas
rendering machinery, driven through `docs/ui/LandscapeSplitView.js`.
