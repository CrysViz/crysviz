# CrysViz Addons

An **addon** is a self-contained tool that lives in a left-dock panel and opens
its own view in the shared right-side **split pane** next to the 3D scene. From
there it can read the structure shown in the main viewer and drive its atoms
live.

There is no separate "addon framework" to learn: an addon is just a normal
panel wired onto the generic split-view plumbing
(`docs/ui/panels/SplitView.js`), exactly like the built-in EOS-fitting and
Energy-Landscape tools. If you can write a panel, you can write an addon.

---

## How it fits together

```
 left dock panel  ──expand──►  your split-view "owner"  ──►  right split pane
 (registerPanel)               (openSplitView)               (#splitPaneBody)
        │                                                          │
   buildContent(body)                                       render(container)
   onExpand()  ─────────────────────────────────────────────►  your UI
   onCollapse() ────────────────────────────────────────────►  (closed)
                                                                  │
                                            AddonAPI  ◄───────────┘
                                    (read / drive the structure & atoms)
```

Two small pieces you write, one you reuse:

| Piece | File | Role |
|-------|------|------|
| **Owner module** | `docs/ui/<Name>SplitView.js` | Builds your UI; opens/closes the split pane. |
| **Registration** | one block in `docs/ui/panels/defaultPanels.js` | Adds the left-dock panel + wires expand→open. |
| **Structure API** | `docs/ui/AddonAPI.js` (reuse) | Read the structure, move atoms, load structures, react to theme. |

Multiple addons can be open at once — each keeps its own content and gets a tab
in the pane header (the active one is highlighted; the others stay live in the
background, so switching tabs never loses state).

---

## Step 1 — write the owner module

Create `docs/ui/<Name>SplitView.js`. Copy `docs/ui/DummySplitPanel.js` for the
minimal shape, or `docs/ui/LandscapeSplitView.js` / `docs/ui/EOSSplitView.js`
for fuller, real examples. It must export four functions the registration will
call: two to open/close the pane, two to build/tear down the dock panel.

```js
import { openSplitView, closeSplitView } from './panels/SplitView.js';
import { createAddonAPI } from './AddonAPI.js';

let api = null;  // structure/theme/file-browser glue, created when the pane opens

// Build your content INTO the container you are handed. This runs once when the
// pane opens for this owner; switching tabs only shows/hides it, so any state
// you keep here survives.
function render(container) {
  api = createAddonAPI();

  container.innerHTML = `
    <div class="split-item">
      <h4>My Addon</h4>
      <div class="split-item-body" id="myAddonBody">…</div>
      <div class="split-item-actions">
        <button type="button" class="split-item-action-btn" data-split-action="doThing">Do thing</button>
      </div>
    </div>`;

  const structure = api.getStructure();      // may be null if nothing is loaded
  // …wire up your controls, read atoms, etc.
}

// Optional callbacks (see SplitView.js for the full owner contract):
function onAction(action /*, itemId, btnEl */) {
  if (action === 'doThing') { /* … */ }      // fires for your data-split-action buttons
}
function onResize() { /* the pane changed size — re-fit canvases/plots here */ }
function onClose() { api?.dispose(); /* drop the API's subscriptions */ }

const owner = {
  title: 'My Addon',   // shown in the header tab
  render,
  onAction,            // optional
  onResize,            // optional
  onClose,             // optional
};

export function openMyAddonSplitView()  { openSplitView(owner); }
export function closeMyAddonSplitView() { closeSplitView(owner); }

// The left-dock panel body: a short description is enough — expanding the panel
// opens the split view. Put quick controls here if you want them docked.
export function addMyAddonPanel(targetId = 'cvPanelBody-myAddon') {
  const el = document.getElementById(targetId);
  if (el) el.innerHTML = `<div class="control-group"><p>Expand to open My Addon on the right.</p></div>`;
}
export function removeMyAddonPanel() { /* usually nothing to tear down */ }
```

### The split pane content contract

- Wrap each block in a `.split-item`; use `.split-item-body` for the main area
  and `.split-item-actions` for its buttons. These classes are styled by
  `docs/styles/SplitView.css`.
- Any button with `data-split-action="x"` inside the pane routes to your
  `onAction('x', itemId, btnEl)`. Two actions are handled for you:
  `data-split-action="expand"` blows a `.split-item` up to fullscreen and
  `data-split-action="close"` restores it (you get `onExpandChange(itemId, expanded)`
  if you need to react — e.g. re-draw a plot at the new size).
- Feature-specific CSS goes in your own stylesheet (add a `<link>` in
  `docs/index.html`) or is injected by your module; keep it off the shared file.

---

## Step 2 — register the panel

Add one block inside `registerDefaultPanels()` in
`docs/ui/panels/defaultPanels.js`, next to the `'eos'` / `'landscape'` entries,
and import your four functions at the top of that file:

```js
import { addMyAddonPanel, removeMyAddonPanel,
         openMyAddonSplitView, closeMyAddonSplitView } from '../MyAddonSplitView.js';

registerPanel({
  id: 'myAddon',
  title: 'My Addon',
  lifecycle: 'rebuild',
  available() { return true; },              // gate on state if you like
  buildContent(body) { addMyAddonPanel(body.id); },
  onDestroyContent() { removeMyAddonPanel(); },
  onExpand()   { openMyAddonSplitView(); },  // dock panel expanded → open pane
  onCollapse() { closeMyAddonSplitView(); }, // dock panel collapsed → release pane
  defaults: { docked: true, order: 95, collapsed: true },
});
```

That's the whole wiring. Expanding the dock panel opens your split view;
collapsing it closes yours (other open addons stay put).

---

## Step 3 — read and drive the structure & atoms

Get the API with `createAddonAPI({ registerStructureChange })` inside your
`render()` (see above). Everything below is a method on that object
(`docs/ui/AddonAPI.js` is the source of truth).

### Reading the structure

```js
const structure = api.getStructure();  // the active (primary) structure, or null
```

A structure exposes:

- `structure.atoms` — array of atoms; **positions are fractional**:
  `structure.atoms[i].position === [x, y, z]` in lattice coordinates.
- `structure.elements` — a **parallel** array of element symbols.
  ⚠️ An `Atom` has **no `.element` property** — read the symbol as
  `structure.elements[i]`, index-matched to `structure.atoms[i]`.
- `structure.lattice` — the 3×3 cell; `structure.periodic` — periodicity flags.

### Moving atoms live (the fast path)

Two calls, mirroring how the MD stream and the relaxer update the viewer:

```js
// On every interaction tick (drag, slider input) — cheap in-place update of
// atoms + bonds, no topology rebuild. `frac` is one [x,y,z] triple per atom,
// in structure.atoms order. Returns false if it had to bail (topology changed).
api.setFracPositions(frac);

// Once, when the interaction ENDS (pointer up / slider release) — re-wraps
// periodic images and does a full rebuild so bond topology (and polyhedra)
// match the final positions.
api.commitPositions();
```

Pattern: call `setFracPositions` continuously while the user is dragging, then
`commitPositions` once on release. Do **not** call `commitPositions` on every
tick — it's the expensive full rebuild.

### Loading a whole structure

```js
// Parse text (POSCAR / CIF / XYZ / …) and add it to the file browser, selected.
// `format` helps the sniffer pick a parser via the filename. Async.
const container = await api.loadStructure(text, 'poscar', 'my_structure');
```

Use this when your addon carries its own reference structure (the
energy-landscape addon builds a POSCAR from its JSON and loads it when the
active structure doesn't match).

### Interacting with the file browser

Beyond loading, an addon can list what's already loaded and select an existing
structure/frame — the same as the user clicking a row:

```js
// Every loaded row: { index, name, frames }. `frames` > 1 means a trajectory.
const rows = api.getStructures();

// Select a loaded structure by row index + 0-based frame. Drives the browser
// highlight and the 3D view, and fires onStructureChange. Returns false if out
// of range.
api.selectStructure(rowIndex, frame);
```

This is the primitive for **"click something in my addon → show that
structure"**. For example, an EOS E–V plot whose points came from a loaded
trajectory (one row, one frame per volume) can, on point click, do:

```js
// pointIndex is the E–V point the user clicked; eosRow is the file-browser row
// the EOS data was read from.
api.selectStructure(eosRow, pointIndex);
```

and the main viewer jumps to that volume's structure.

### Reacting to changes

```js
// Fires whenever the active structure changes — user row click, step change,
// your own selectStructure(), or a load. Returns an unsubscribe fn; api.dispose()
// also drops it. (Wire it once in render(); it is live, not a stub.)
api.onStructureChange((structure) => { /* re-highlight the matching point, etc. */ });

// Theme switched (light/dark). Returns an unsubscribe fn. Use getTheme() for
// the current { name, isDark, token('--some-css-var') } to restyle canvases.
const stop = api.onThemeChange((theme) => { /* recolor */ });
```

**Clean up:** call `api.dispose()` in your owner's `onClose` (see the template)
to drop all subscriptions this API handed out — otherwise a structure/theme
change would fire into your torn-down addon.

Full API surface: `getStructure`, `getStructures`, `selectStructure`,
`setFracPositions`, `commitPositions`, `loadStructure`, `onStructureChange`,
`getTheme`, `onThemeChange`, `dispose`.

---

## Reference examples

| Addon | Files | Shows |
|-------|-------|-------|
| **Split View Demo** | `docs/ui/DummySplitPanel.js` | Minimal owner + dock panel + `onAction`. |
| **EOS Fitting** | `docs/ui/EOSSplitView.js`, `docs/ui/EOSPanel.js`, `docs/eos/eosPlots.js` | Two plot items, `onResize`, `onExpandChange`, fullscreen. |
| **Energy Landscape** | `docs/ui/LandscapeSplitView.js`, `docs/addons/landscape/{landscape,heatmap}.js` | Canvas heatmaps, file loading, live atom driving via the API. |
```
