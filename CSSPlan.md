# CSS consolidation plan

Goal: all styling lives in `docs/styles/` (component rules) and
`docs/themes/*/theme.css` (design tokens), so fonts, colours and spacing are
consistent, and so the responsive rules are defined once instead of being
re-invented per panel.

## Where we are

Measured on the current tree:

| | count |
|---|---|
| `docs/styles/*.css` | 17 files, 7 925 lines |
| `docs/themes/*/theme.css` | 3 files; `default` defines 46 tokens, `dark`/`twilight` override 2 each |
| colour literals in `styles/*.css` (hex / `rgb(a)`) | ~545 |
| `font-size` declarations | 247, across **30 distinct values** |
| `font-family` stacks | 8 distinct |
| `@media` blocks | 12, spread over 5 files, 6 unrelated breakpoints |
| JS files that build CSS (`cssText`, `createElement('style')`) | 44 |
| JS files with `style="…"` inside HTML template strings | 17 |

The theme layer already exists and works (`ui/ThemeManager.js` +
`themes/themes.json`, base then override). What it lacks is vocabulary: it has
surfaces, layout geometry and scene colours, but **no typography, spacing,
z-index, state-colour or breakpoint tokens**. That is why every panel re-picks
its own `11px`/`12px`/`#ccc`.

## Target architecture

```
themes/default/theme.css   token vocabulary  — the ONLY place colour/font
                           literals are allowed to appear
themes/<id>/theme.css      overrides of those tokens
styles/responsive.css      every @media rule in the app, one breakpoint ladder
styles/<component>.css     component rules, tokens only
```

Two invariants, both machine-checkable (see Wave 5):

1. **No colour literal and no `font-family` literal outside `themes/`.**
2. **No `@media` outside `styles/responsive.css`.**

### Token vocabulary to add (Wave 1)

- **Type**: `--font-ui`, `--font-mono`, `--font-display`; size ladder
  `--fs-xs … --fs-xl` (snapped from the 30 existing values to ~7 steps);
  `--fw-normal/-medium/-bold`; `--lh-tight/-normal`.
  Every size token is defined as `calc(<px> * var(--cv-font-scale, 1))` so the
  existing user font-scale control (`ui/FontScaleModule.js`) keeps working.
- **Space**: `--sp-1 … --sp-6` (4/6/8/12/16/24px), replacing ad-hoc margins.
- **Colour**: keep the existing surface/accent tokens; add the greys that the
  545 literals actually cluster into (`--fg-1/-2/-3`, `--line-1/-2`,
  `--overlay`), plus state colours `--danger` (exists), `--warn`, `--ok`,
  `--info`.
- **Controls**: `--control-h`, `--control-h-touch` (≥44px), `--input-bg`
  (exists), `--radius-sm/-md` (`--radius` exists).
- **Depth**: `--z-canvas/-panel/-dock/-popup/-menu/-modal/-tooltip`, replacing
  the hand-picked `z-index` numbers.

**Depth is deferred, not done.** Wave 2 inventoried every `z-index` in the tree
and the flat ladder cannot absorb what is actually there. The dock alone runs a
five-level internal stack (`.cv-panel.cv-floating` 1200, `.split-pane` 1300,
`.split-handle` 1301, `#sideDockDropHint` 1302, `.split-pane-overlay` 1350,
expanded items 1400 `!important`), so `--z-dock` needs sub-rungs
(`--z-dock`, `--z-dock-handle`, `--z-dock-scrim`, `--z-dock-expanded`). Two
genuine inversions also exist in the shipped code: `.cv-panel-menu` (3200)
renders above the app's own modals (3000/3100), and popup-role elements
(999–1100) sit below dock-role elements (1200+). Adopting a ladder silently
changes what renders on top, so **no wave touches `z-index` until the intended
ordering is decided explicitly.** Wave 2 left every value untouched.

Backend accent classes (`.theme-standard`, `.theme-symmetry`, …) currently sit
in `styles/styles.css`; they are token definitions and move to
`themes/default/theme.css` next to the rest.

### Breakpoint ladder (Wave 4)

Fixed set, used everywhere, nothing else:

| name | condition | intent |
|---|---|---|
| compact | `max-width: 1024px` | tablet / narrow desktop — dock collapses |
| mobile | `max-width: 720px` | panel becomes a full-width sheet |
| tiny | `max-width: 420px` | single-column controls |
| short | `max-height: 480px` | landscape phone — chrome shrinks |
| coarse | `pointer: coarse` | touch targets to `--control-h-touch` |

Existing one-off breakpoints (1320, 640, 390, `orientation: landscape`) fold
into the nearest rung.

Mobile fixes that the ladder makes expressible, and that are currently missing:
`--ui-width` is a hard 380px at every size; `100vh` is used where `100dvh` is
needed (mobile URL bar); no `env(safe-area-inset-*)`; no coarse-pointer target
sizing; `MobileMenu.js` is not wired to a breakpoint.

## Waves

Each wave is independently shippable and ends with a browser-test run
(`tools/browsertest/run-all.sh`, 107 tests, ~10-15 min). `make checks` runs
after any wave that touches JS.

**Wave 1 — token foundation.** One agent. Cluster the existing literals, add
the vocabulary above to `themes/default/theme.css`, mirror what diverges into
`dark`/`twilight`, move the accent classes out of `styles.css`. Additive only:
no existing rule changes, so no visual diff.

**Wave 2 — token adoption in CSS.** Four agents in parallel, balanced by line
count:

- A — `styles.css` (2 908)
- B — `controlPanel.css`, `backendPanel.css` (1 645)
- C — `toggle_styles.css`, `sideDock.css`, `panelWindow.css` (1 751)
- D — the remaining 11 small files (~1 620)

Each replaces literals with tokens and snaps font sizes to the ladder. Snapping
is the only intended visual change; anything else is a bug.

**Wave 2.5 — second token pass.** One agent. Wave 2 revealed that the Wave 1
palette was derived almost entirely from `styles.css`'s white-alpha idiom, and
so has no name for what the rest of the app actually uses. All four agents
independently reported the same gaps. Add and adopt:

- **Opaque grey ramps.** A dark widget-chrome family (`#161618`, `#2c2c2e`,
  `#3a3a3c`, `#454547`, `#4a4a4c`, `#555`, `#777`) and an off-white text family
  (`#f5f5f5`, `#e8e8e8`, `#ddd`, `#ccc`, `#b8b8b8`, `#999`, `#888`). These are
  what the smaller panels use; until they are tokens, those panels cannot be
  re-themed at all.
- **Wash/tint scale.** `rgba(255,255,255,0.02 … 0.16)` — hover tints and card
  backgrounds, the single most-repeated un-tokenised value in the audit.
- **Shadow tokens.** `rgba(0,0,0,0.1/0.2/0.3/0.4)`, deliberately distinct from
  `--overlay` (a scrim and a drop shadow are not the same thing, and a light
  theme needs to move them independently).
- **Alpha-bearing state colours.** `--danger` / `--warn` exist only at one
  alpha; the code needs `rgba(240,132,18,0.14/0.18/1)` and equivalents.
- **More radius rungs.** `3px`, `4px`, `5px`, `9px`, `12px`, `24px` are all in
  use with no token.
- **A `--sp` rung for `10px`**, or a deliberate decision to migrate those ~60
  sites to `--sp-3` (8px) / `--sp-4` (12px). `10px` and `15px` are the two
  dominant off-grid values and they are not going away on their own.

Also fold in the two pre-existing CSS bugs Wave 2 found but correctly left
alone: `color: "red"` (quoted, so the declaration is invalid and dead) in
`styles_file_browswer.css`, and a missing colon in
`border 1px solid var(--hover-color)` in `info_button_styles.css`.

**Wave 3 — JS → CSS extraction.** Four agents, grouped by owning panel so no
two agents touch the same stylesheet:

- A — `ui/addToStructureModule/*` → new `styles/addStructure.css`
- B — `ui/BondLengthPanel.js`, `ui/BackgroundPicker.js`, `ui/AnalysisPanels/*`
- C — `ui/SpinPanel.js`, `ui/ForcePanel.js`, `ui/ColorBarWidget.js`,
  `ui/CustomUserSettingsPanel.js`, `ui/OverlayPanel.js`
- D — `ui/LatticeSupercellPanel.js`, `ui/PeriodicTableSelect*.js`,
  `ui/ComparisonPanel.js`, `ui/LatticeComparisonPanel.js`,
  `ui/PolyhedraListPanel.js`, `ui/PlanesPanel.js`, `ui/CutPlanePanel.js`,
  `ui/FieldPanel.js`, `ui/BackendPanel/*`, `render/TracerProgressModule.js`,
  `addons/landscape/landscape.js`

The rule for what moves: **a constant belongs in CSS; a value computed from
data or state stays in JS.** Positions from drag handlers, species colours,
canvas sizing and measured offsets stay. Everything around them becomes a
class. Show/hide becomes a class toggle where the element already has one.

**Wave 4 — responsive.** One agent for the ladder + `responsive.css`
consolidation, a second for the mobile fixes listed above. Verified by hand in
a narrow viewport as well as by tests.

**Wave 5 — enforcement.** `tools/ci/css_guard.sh`, wired into `make checks`:
fails on a colour or `font-family` literal outside `themes/`, on `@media`
outside `responsive.css`, and on new `cssText` / `createElement('style')` under
`docs/`. Plus one browser test asserting that switching theme changes computed
panel colours and that the mobile breakpoint reflows the panel — the two things
the whole refactor exists to make possible.

## Constraints for every agent

- `graphify update .` after changing code.
- No `/** @type {any} */`, `: any`, `@ts-ignore`, `eslint-disable`.
- Comments record why, not what.
- Never delete a rule because it looks unused — panels are built at runtime and
  half the selectors never appear in a template string.
- Report any rule that could not be tokenised rather than inventing a token.
