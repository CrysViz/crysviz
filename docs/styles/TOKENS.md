# Token audit (Wave 1)

Source data: every colour literal (`#hex`, `rgb()`, `rgba()`), every
`font-size`/`font-family`/`z-index` in `docs/styles/*.css` (17 files, 7925
lines), plus `z-index` set from `docs/**/*.js` outside `docs/external/` and
`docs/compiled/`. Counts below are call-site counts (declarations), not
distinct files. This file records *why* each token in
`themes/default/theme.css` has the value it has — Wave 2 substitutes literals
for these tokens; it should not need to re-derive the clustering.

## Type

### Font stacks

| token | value | replaces | call sites |
|---|---|---|---|
| `--font-ui` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` | the `body` base stack (`styles.css:6`) that everything else inherits; also the bare `sans-serif` at `styles.css:1919` and `BackendSwitchPanel.js`'s inline `sans-serif` | 1 authoritative + 2 bare duplicates |
| `--font-mono` | `'Fira Code', 'SFMono-Regular', ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace` | the fullest of 4 competing mono stacks (`styles.css:1172,1302,1487`); the shorter ones (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` ×2, `ui-monospace, "SF Mono", Menlo, monospace` ×2, bare `monospace` ×3) are the same intent with fewer fallbacks | 3 exact + 7 near-duplicates |
| `--font-display` | `Georgia, 'Times New Roman', serif` | the one serif use at `styles.css:642` | 1 |

`font-family: inherit` (`formControls.css:11`) needs no token — it already
defers to the stack above it.

### Size ladder

Every rung is `calc(<px> * var(--cv-font-scale, 1))` so
`ui/FontScaleModule.js`'s scale control keeps working. 247 `font-size`
declarations, 30 distinct raw values (before counting the `calc(...)`
declarations that already exist and duplicate several rungs below).

| token | value | dominant cluster | call sites |
|---|---|---|---|
| `--fs-xs` | `calc(10px * var(--cv-font-scale, 1))` | 9px, 9.5px, 10px, 10.5px | 18 |
| `--fs-sm` | `calc(11px * var(--cv-font-scale, 1))` | 11px, 11.5px | 45 |
| `--fs-base` | `calc(12px * var(--cv-font-scale, 1))` | 12px, 12.5px — single most common size in the app | 65 |
| `--fs-md` | `calc(13px * var(--cv-font-scale, 1))` | 13px | 29 |
| `--fs-lg` | `calc(14px * var(--cv-font-scale, 1))` | 14px, 15px | 37 |
| `--fs-xl` | `calc(16px * var(--cv-font-scale, 1))` | 16px | 14 |
| `--fs-hero` | `calc(64px * var(--cv-font-scale, 1))` | the single 64px outlier (`styles.css`, splash/big number) | 1 |

**Not cleanly clustered:** 17px (2), 18px (3), 20px (3), 24px (1) — 9 call
sites sit between `--fs-xl` (16) and `--fs-hero` (64) with no natural rung.
Wave 2 will have to pick per-site whether they round down to `--fs-xl` or
stay literal; forcing a rung here would invent a value the audit doesn't
support. Root-relative sizes (`1rem`, `1em`, `1.25rem`, `1.3rem`, `1.6rem`,
`0.85em`, `0.92em`, `3em` — 13 call sites total) aren't included in the ladder
either: their pixel size depends on the inherited context, so each needs a
human look in Wave 2 rather than a blind snap.

### Weight & line-height

| token | value | replaces | call sites |
|---|---|---|---|
| `--fw-normal` | `400` | `font-weight: 400` / `normal` | 6 |
| `--fw-medium` | `500` | `font-weight: 500` — the dominant weight in the app | 38 |
| `--fw-bold` | `600` | `font-weight: 600` — more common than literal `700`/`bold` (600 is what this codebase actually uses for emphasis) | 27 |
| `--lh-tight` | `1` | `line-height: 1` | 18 |
| `--lh-normal` | `1.4` | the 1.3–1.5 reading-line-height cluster (1.4×6, 1.5×4, 1.3×3, 1.35×2, 1.45×1) | 16 |

Outliers not tokenised: `font-weight: 700/800/300/200/1000` and the literal
`bold` keyword (12 call sites total) — too sparse to be a real cluster, and
`700`/`800` look like intentional one-off emphasis, not an ad-hoc miss.

## Space

| token | value |
|---|---|
| `--sp-1` | `4px` |
| `--sp-2` | `6px` |
| `--sp-3` | `8px` |
| `--sp-4` | `12px` |
| `--sp-5` | `16px` |
| `--sp-6` | `24px` |

Matches the plan's suggested default — the audit confirms all six are
independently common `margin`/`padding` values (4px: 44, 6px: 41, 8px: 24,
12px: 32, 16px: 4 explicit + implied via `--ui-padding: 20px` neighbors,
24px: present). `10px` (41 call sites) and `5px` (26 call sites) are also
heavily used but sit between rungs; Wave 2 snaps them to the nearer
neighbour (`--sp-3`/`--sp-4` and `--sp-1`/`--sp-2` respectively) rather than
adding two more rungs for values that are themselves just off-grid uses of
the same intent.

## Colour

Existing tokens (`--surface-bg`, `--panel-bg`, `--panel-fg`, `--muted-fg`,
`--panel-border`, `--group-bg`, `--menu-bg`, `--popup-bg`, `--popup-border`,
`--input-bg`, `--danger`, `--scene-bg`, `--lattice-color`, the accent
classes) are unchanged — see below for verification. ~545 colour literals
total; the two big families are white-on-dark greys (foreground/borders) and
black scrims (overlays).

| token | value | replaces | call sites |
|---|---|---|---|
| `--fg-1` | `#ffffff` | `#fff`/`#ffffff` primary text — already the literal value of `--panel-fg`; this token exists for non-panel contexts that repeat the literal instead of referencing `--panel-fg` | 67 |
| `--fg-2` | `rgba(255, 255, 255, 0.6)` | secondary/de-emphasised text cluster (0.55×6, 0.6×5, 0.65×3, 0.64×1, 0.68×1) | 16 |
| `--fg-3` | `rgba(255, 255, 255, 0.4)` | dim/disabled text cluster (0.4×7, 0.35×5, 0.38×1, 0.45×2) | 15 |
| `--line-1` | `rgba(255, 255, 255, 0.1)` | the single most common border/divider value in the app — already equal to `--panel-border`'s literal | 46 |
| `--line-2` | `rgba(255, 255, 255, 0.2)` | the next border tier up (0.2×13, 0.18×6, 0.25×1) | 20 |
| `--overlay` | `rgba(0, 0, 0, 0.5)` | modal/backdrop scrims — the dominant black-overlay value (0.5×9); the family ranges 0.15–0.9 across ~35 call sites for different backdrop strengths, but 0.5 is the mode and the safest single representative | 9 (of ~35 in the wider black-overlay family) |
| `--warn` | `#FFBF00` | amber warning literals (`#FFBF00`×3, plus `#ffc107`, `#ffcf4f`, `rgba(255,193,7,*)`×2 — same hue family) | 3 exact + 4 near-duplicates |
| `--ok` | `#2e9c6e` | green success literals (`#2e9c6e`×5 is the mode; `#81c784`×4, `#7ee2a8`×4, `#37b07d`×2, plus a long tail of one-off greens) | 5 exact + ~15 near-duplicates |
| `--info` | `#00bcd4` | cyan/info literals (`#00bcd4`×7 is the mode; `#4fc3f7`×2, `#6fb6ff`×2, plus one-offs) | 7 exact + ~8 near-duplicates |

**Correction to the three rows above.** Treating the lighter greens/blues/ambers
as near-duplicates of the mode was wrong, and the substitution was reverted at
those call sites. `#81c784`, `#7ee2a8`, `#4fc3f7`, `#6fb6ff` and `#ffcf4f` are
not the same colour as `--ok`/`--info`/`--warn` at a different rounding — they
are the *light-on-dark* members of each family, used for link and heading text
on dark panels (About panel, comparison headings, space-group links, anneal
badge). Folding them into the darker mode measurably dropped text contrast.
They now live as `--ok-bright` / `--info-bright` / `--warn-bright`, plus
`--ok-bright-rgb` for the anneal badge, which tints its fill and border from
the same hue as its text.

The rule this establishes: **a state colour used as foreground is a different
token from the same state used as a fill.** Cluster by role, not by hue
distance — two colours being close in RGB does not make them interchangeable
when one of them has to stay legible against a dark background.

**Not cleanly clustered:** the black-overlay family (`rgba(0,0,0,*)`) spans
alpha 0.15 to 0.9 with no single dominant tier the way white borders do —
different call sites genuinely want different scrim strengths (a subtle
shadow vs. a modal backdrop). `--overlay` covers the modal-backdrop use;
Wave 2 will still need judgment for the lighter shadow uses in that family
rather than a mechanical substitution.

## Controls

| token | value | rationale |
|---|---|---|
| `--control-h` | `34px` | mode of button/input heights across `calcButton`, `.atomistic-input-sm`, `.planes-*-input` (30px, 32px, 34px all in use; 34px is the most repeated literal) |
| `--control-h-touch` | `44px` | fixed per plan; also already the literal value used at `backendPanel.css:579` (`.atomistic-button-row .calcButton`) and the 44×44 icon button at `styles.css:2543-2544` — not invented, just named |
| `--radius-sm` | `6px` | most common radius below the existing `--radius: 8px` (6px×25, vs. 4px×19, 3px×13) |
| `--radius-md` | `10px` | most common radius above `--radius: 8px` (10px×27, vs. 12px×15) |

`--radius` (8px, 45 call sites, already the single most common radius in the
app) is unchanged.

## Depth (z-index)

Grepped `z-index` in `docs/styles/*.css` and `zIndex`/`z-index` set from JS
under `docs/` (excluding `docs/external/` and `docs/compiled/`). The app's
actual numbers are inconsistent — this ladder groups them by role, not by
mechanically preserving every literal, because several existing values
contradict each other (see "known inversions" below). Values are spaced
1000 apart for headroom; nothing here changes an existing rule's number —
Wave 2 does the substitution.

| token | value | layer | observed values mapped here |
|---|---|---|---|
| `--z-canvas` | `0` | WebGL scene | no explicit `z-index` anywhere — the canvas paints first; token exists so nothing can accidentally sort under it |
| `--z-panel` | `1` | base panel chrome + local intra-component sibling ordering (slider thumbs, sticky table cells, colorbar resize frame/handle, drag handles) | 1, 2, 3, 4, 5, 10, 20, 100 |
| `--z-dock` | `1200` | RightDock (pane/splitter/toggle/edge-shadow), floating `.cv-panel` windows, the mobile slide-in menu and its scrim | 900, 1200, 1300, 1301, 1302, 1350, 1400, 1500 |
| `--z-popup` | `2000` | small floating overlays anchored to a panel: background-color dot, dropdown menus, gizmo box/tooltip, restore-popover, info-modal, file-browser inline menu, draggable measurement widget | 20, 100, 999, 1000, 1001, 1100 |
| `--z-menu` | `3000` | body-portaled context/dropdown menus | 3200 (`.cv-panel-menu`, `panelWindow.css`) |
| `--z-modal` | `4000` | blocking dialogs and full-screen alert banners | 1999, 2000, 3000, 3100 |
| `--z-tooltip` | `5000` | always-on-top ephemeral feedback: colour-picker popover, load-progress toasts, file-browser popup+overlay, press-and-hold popup, backend-switch banner | 9999, 10000, 99999 |

**Known inversions — not fixed here, flagged for Wave 2:** the app currently
renders two things *above* where this ladder would put them:

- `.cv-panel-menu` (`panelWindow.css:252`, `z-index: 3200`) — a context menu
  — currently outranks the app's own blocking modals (`3000`–`3100`). The
  file's own comment says it's deliberately "above floating windows and the
  fullscreen-item overlay," but it also ends up above `#confirmModal`. Under
  the plan's mandated order (`dock < popup < menu < modal < tooltip`) this
  is `--z-menu`, which is correctly below `--z-modal` — meaning adopting the
  token in Wave 2 will change this one stacking relationship. Flagging
  rather than silently preserving a value that contradicts the requested
  ladder order.
- Several `--z-popup`-role elements (999–1100) currently sit *below*
  `--z-dock`-role elements (1200+) even though popups are meant to float
  above docked chrome. In practice they don't seem to overlap on screen
  (e.g. the background-picker dot vs. the right dock), so this hasn't been
  visibly broken, but a literal-for-literal read of the current numbers
  would put popup below dock, not above it. The token ladder follows the
  plan's prescribed name order instead; Wave 2 should sanity-check any site
  where a popup and the dock can actually overlap.

## Wave 2.5 — second token pass

Wave 2's four agents each independently hit the same wall: the Wave 1 palette
was derived almost entirely from `styles.css`'s white-alpha idiom, so it had
no name for what the smaller panels (TrajectoryPanel, ForcePanel, the file
browser, EOSPanel, the Planes table) actually paint with — flat opaque greys,
not alphas over `--panel-bg`. This pass adds tokens only; nothing in
`styles/*.css` was touched (that's Wave 3's job, split across two sibling
agents working in parallel — leaving the stylesheets alone avoids colliding
with that work).

### Opaque grey ramps

Two distinct families, clustered from the actual call sites (not by
lightness alone — a couple of values that *look* like they belong by number
turned out to be a different property entirely on inspection, see below).

**`--chrome-*`** — dark widget chrome (backgrounds/borders), darkest → lightest:

| token | value | dominant use | near-duplicates folded in |
|---|---|---|---|
| `--chrome-1` | `rgba(25, 25, 25, 0.8)` | widget bg (backendPanel, toggle_styles ×2, controlPanel) | `#161618`, `rgba(20,20,20,0.85)`, `rgba(20,20,20,0.9)` |
| `--chrome-2` | `#2c2c2e` | TrajectoryPanel bg (6 sites, dominant) | `#303030` |
| `--chrome-3` | `#3a3a3c` | TrajectoryPanel bg/border (9 sites, dominant) | `#3a3a3a` |
| `--chrome-4` | `#4a4a4c` | TrajectoryPanel hover border (3 sites) | `#454547` (active-state bg), `#444` (see below) |
| `--chrome-5` | `#555` | ForcePanel bg (2 sites) | `#5a5a5a` |
| `--chrome-6` | `#777` | ForcePanel border (3 sites) | — |

`#444` (`styles.css:134`) was listed in the plan under "off-white text," but
its one call site is `border: 1px solid #444` — a border, not text, and at
lightness 68 it sits 6 units from `--chrome-4` (74) and 10 from `--chrome-3`
(58). Reclassified into the chrome ramp by what it's actually used for, per
the plan's own instruction to cluster from call sites rather than bucket by
number.

A second, bluish-tinted trio exists only in the Planes panel's sticky/selected
table column (`controlPanel.css`) — genuinely a different hue (navy-tinted,
not neutral), so it's kept apart rather than rounded into `--chrome-*`:

| token | value | use |
|---|---|---|
| `--chrome-tint-1` | `rgba(14, 18, 24, 0.96)` | `.planes-td-del-sticky` / `.planes-th-del-sticky` bg |
| `--chrome-tint-2` | `rgba(15, 18, 30, 0.9)` | `.planes-d-slider`/`.planes-slider` thumb border ring (×4) |
| `--chrome-tint-3` | `rgba(22, 33, 56, 0.98)` | `.planes-row-selected .planes-td-del-sticky` bg |

**`--ink-*`** — off-white text/border, darkest → lightest:

| token | value | dominant use | near-duplicates folded in |
|---|---|---|---|
| `--ink-1` | `#888` | disabled/dim text (TrajectoryPanel, ForcePanel) | `#7a7a7a`, `#7f7f7f` |
| `--ink-2` | `#999` | info-button border+glyph | — |
| `--ink-3` | `#ccc` | mode of the whole family (10 sites: borders, text, toggle-track bg) | `#b8b8b8` |
| `--ink-4` | `#ddd` | text/border (5 sites) | `#dcdcdc` |
| `--ink-5` | `#e8e8e8` | TrajectoryPanel label text (3 sites) | — |
| `--ink-6` | `#f5f5f5` | near-white text (4 sites) | — |

**Left out:** `#c8c8c8` (`formControls.css:15`) cannot be tokenised — it's the
fill colour of an inline SVG `<path>` baked into a `background-image:
url("data:image/svg+xml,...")` string, not a CSS colour literal. `var()`
doesn't resolve inside a data URI. Re-theming this native-`<select>` chevron
would mean turning it into a `--icon-*`-style custom property (like the
measure-tool icons already do) instead of an inline data URI — a real change,
out of scope for a token-only pass. It's 4 units from `--ink-3` if a future
pass wants to just accept the literal.

### Wash / tint scale

`rgba(255, 255, 255, X)` for hover tints, card backgrounds and subtle input
fills is the single most-repeated un-tokenised value in the whole audit.
Counted every occurrence in `docs/styles/*.css`:

| alpha | count | role |
|---|---|---|
| 0.08 | 20 | dominant — card/tile background, hover tint |
| 0.15 | 16 | almost entirely `border`, not fills (sits just under `--line-2`'s 0.2) |
| 0.05 | 14 | subtle fill / faint border |
| 0.12 | 6 | stronger hover/active fill |
| everything else (0.02, 0.025, 0.03, 0.04, 0.06, 0.07, 0.09, 0.10, 0.14, 0.16) | 1-8 each | long tail, no real cluster |

Picked all four dominant alphas rather than three — 0.12 has fewer sites than
the others but is a clean, distinct step and drops nothing else out.
`--wash-4` (0.15) is mostly a border value, but it repeats the exact
white-alpha idiom this scale exists to name, so it stays in `--wash-*` rather
than being shoehorned into the `--line-1`/`--line-2` pair (which are named
for their border role specifically, at 0.1 and 0.2 — 0.15 sits between them
without being either).

### Shadow tokens

Deliberately not `--overlay` (0.5 black scrim) — a drop shadow and a
full-screen backdrop must move independently once a light theme exists.

Chose **both** a bare colour and composite shapes, because neither alone
covers the real call sites:

- `--shadow-rgb: 0 0 0` — bare channel triple, same pattern as
  `--danger-rgb` etc. below. Needed because black-at-an-alpha is also used
  for things that aren't shadows (e.g. `rgba(0,0,0,0.2)` as a textarea/input
  background in `styles.css` — a fill, not a shadow), and because not every
  `box-shadow` call site's blur/spread matches one of the four named shapes.
- `--shadow-sm/-md/-lg/-glow` — whole `box-shadow` values, chosen only where
  the shape *and* colour repeat, so adopting them is a straight duplicate
  removal rather than a normalization:

| token | value | call sites |
|---|---|---|
| `--shadow-sm` | `0 2px 6px rgba(0, 0, 0, 0.2)` | `styles_file_browswer.css` `.error-panel` (0.1 variant at `.panel` is a near-dupe, not exact) |
| `--shadow-md` | `0 4px 12px rgba(0, 0, 0, 0.3)` | `info_button_styles.css`, `toggle_styles.css` — exact duplicate ×2 (styles.css:282 is a 0.4 near-dupe of the same shape) |
| `--shadow-lg` | `0 4px 16px rgba(0, 0, 0, 0.4)` | `styles.css` `.cv-crop-toolbar` (single site, but the natural "big" rung) |
| `--shadow-glow` | `0 0 4px 2px rgba(0, 0, 0, 0.3)` | `styles.css` ×3, `panelWindow.css` ×1 exact; `.popup`/`.floating-comp-panel` at 0.2 are near-dupes — the most-repeated shadow *shape* in the app (6 sites total) |

Not covered: `panelWindow.css` `0 2px 10px rgba(0,0,0,0.4)` and `styles.css`
`.cv-crop-rect`'s `0 0 0 1px rgba(0,0,0,0.4)` (a focus-ring shape, not a drop
shadow) — one call site each, no shape to cluster with. `--shadow-rgb` covers
their colour if a call site wants to keep its own geometry.

`rgba(255, 255, 255, 0.95)` (the one light-background use, `.error-panel` in
`styles_file_browswer.css`) became `--overlay-light`, next to `--overlay` in
the Foregrounds & lines section rather than the shadow block — it's a
background fill, not a shadow, but shares `--overlay`'s "must move
independently in a light theme" reasoning.

### Alpha-bearing state colours

`--danger-rgb`/`--warn-rgb`/`--ok-rgb`/`--info-rgb` added as bare `R G B`
triples next to the existing fixed-alpha tokens (which are unchanged — other
stylesheets already reference them). A call site composes its own alpha:
`rgb(var(--danger-rgb) / 0.18)`. This covers every alpha the danger family
actually uses (`rgba(240,132,18,0.12/0.14/0.18/0.25/0.4/0.7/1)` across
`styles.css:838-840,2459` and `backendPanel.css:120,131,144,151`) without
minting a token per alpha.

### Radius rungs

`--radius-3/-4/-5/-9/-12/-24` — named by literal pixel value, not another
tier of `xs`/`sm`/`lg` adjectives. `--radius-sm`(6)/`--radius`(8)/
`--radius-md`(10) are a real small/base/medium story; 3/4/5/9/12/24 are a
dense, non-semantic packing of specific pixel values from unrelated
components (audit: 3px×15, 4px×21, 5px×3, 9px×2, 12px×17, 24px×3) — an
adjective name would invent a distinction the data doesn't support. All six
were added despite three of them (5px, 9px, 24px) having only 2-3 call sites
each, because the plan named all six explicitly and, unlike the grey ramps,
there's no natural "fold into a neighbour" story: 5px is 1px from
`--radius-sm` but so is 9px from both `--radius` and `--radius-md`, and
folding one but not the other would be arbitrary.

### The 10px / 15px question

**Recommendation: add a rung for 10px, migrate 15px to `--sp-5`.** The two
don't behave the same way, so one answer doesn't fit both:

- **10px** (~60+ sites) sits exactly equidistant between `--sp-3` (8px) and
  `--sp-4` (12px) — 2px either direction. There's no "nearer neighbour" to
  snap to, which is exactly why Wave 1's original "snap it" plan didn't hold
  up in practice: every one of those 60+ sites needs its own directional
  judgment call with nothing to base it on. Added `--sp-3-5: 10px`.
- **15px** (~20 sites) is 1px from `--sp-5` (16px) — imperceptible at these
  sizes, a safe, low-judgment snap. No rung added; adopters should migrate
  these sites to `--sp-5` directly.

No migration performed here — this is a recommendation for the adopting
agents, per the plan's instruction that shifting ~80 layout values is a
visible change and needs to be its own reviewable step.

### Depth — the literal, order-preserving ladder

Wave 1's flat `--z-canvas/-panel/-dock/-popup/-menu/-modal/-tooltip` ladder
is a *target* grouping — its own comment says the numbers aren't a copy of
what's on screen today, and adopting it as-is would resolve two real
stacking inversions as a side effect. That ladder is untouched here (per the
"don't change an existing token's value" constraint) and still exists for
whenever those inversions get fixed on purpose.

This second ladder is the opposite: every value below is the *exact* current
literal, so swapping one in for its raw number is a pure refactor with zero
visual change — including the `.cv-panel-menu` inversion, which is
preserved, not fixed. Only values that participate in the app-wide stack
(100 and up) got a token; `-2`/`-1`/`1`/`2`/`3`/`5`/`10`/`20` are local
stacking within one component (sticky table cells, slider thumbs, colorbar
resize frame/handle, drag-vs-idle panel state) and stay literal — tokenising
them would imply a global relationship none of them have.

**Naming collision, flagged:** the plan's step 2 asked for the dock's five
internal levels as `--z-dock`, `--z-dock-handle`, `--z-dock-hint`,
`--z-dock-scrim`, `--z-dock-expanded`. But `--z-dock` already exists (Wave 1,
value `1200`, matching `.cv-panel.cv-floating` exactly) and rightDock.css's
own base pane level (`.split-pane`/`.split-pane-tabs`) is `1300`, not `1200`
— reusing the name `--z-dock` for the pane level would silently overwrite
the existing token's value, which the constraints explicitly forbid. Resolved
by naming the pane level `--z-dock-pane` (1300) instead, and reusing the
existing `--z-dock` (1200) as-is for `.cv-panel.cv-floating`, which it
already matches exactly. The other four dock names are unambiguous by role
and used as given.

Full mapping, in stacking order (lowest to highest):

| value | token | selector(s) |
|---|---|---|
| 100 | `--z-inline-alert` | `.error-panel` (`styles_file_browswer.css`) |
| 900 | `--z-mobile-scrim` | `#mobileOverlay` |
| 999 | `--z-anchor` | `.background-dot`, `.popup`, `.info-panel-overlay` |
| 1000 | `--z-overlay-widget` | `#status`, `#axesGizmo`, `#axesLegend`, `.restore-popover`, `.theme-menu`, `.info-panel` |
| 1001 | `--z-gizmo-controls` | `.cv-gizmo-controls` |
| 1100 | `--z-comp-panel` | `.floating-comp-panel` |
| 1200 | `--z-dock` (existing, unchanged) | `.cv-panel.cv-floating` |
| 1300 | `--z-dock-pane` | `.split-pane`, `.split-pane-tabs` |
| 1301 | `--z-dock-handle` | `.split-handle` |
| 1302 | `--z-dock-hint` | `#rightDockDropHint` |
| 1350 | `--z-dock-scrim` | `.split-pane-overlay` |
| 1400 | `--z-dock-expanded` | `.split-item.expanded` `!important`, `#viewArea.split-item-expanded .split-pane`, `.cv-panel.cv-floating.cv-has-expanded-item` `!important`, `.trajPlot.expanded` `!important` |
| 1500 | `--z-mobile-panel` | `#ui.panel-open` (mobile) |
| 2000 | `--z-chrome` | `#aboutOverlay`, `.cv-drag-select-rect`, `#mobileMenuToggle` |
| 3000 | `--z-dialog` | `#pasteTextModal`, `#pngExportModal`, `#raytraceWarningModal`, `#shortcutsHelpModal`, `.cv-crop-overlay` |
| 3100 | `--z-confirm` | `#shortcutsResetConfirmModal`, `#confirmModal` |
| 3200 | `--z-context-menu` | `.cv-panel-menu` — the known inversion; preserved as-is |

Not tokenised (local, stays literal): `.shortcuts-help-trigger`/`.theme-switch`/
`.cv-panel.cv-dragging` 10; `.download-menu` 20; controlPanel.css sticky
cells/sliders 2/3; toggle_styles.css colorbar layers 1/2/3/5;
`.split-item-close-btn` 1; `.blh-range-bg`/`.blh-range-fill` -2/-1.

### Two bugs fixed (plan step 3)

- `styles_file_browswer.css`: `input[type="number"]:invalid { color: "red"; }`
  — the quotes make `"red"` an invalid `<color>`, so the whole declaration
  was dropped and invalid numeric input rendered in the default text colour.
  Same file already uses `var(--danger)` for its `.error-panel`, so that's
  the fix: `color: var(--danger);` — consistent with how the rest of the app
  marks an error state, not literal red.
- `info_button_styles.css`: `.info-panel-close:hover { ... border 1px solid
  var(--hover-color) }` — missing colon after `border` drops the whole
  declaration, so the hover state had no border change. Added the colon.

## Accent classes (`.theme-standard` / `.theme-symmetry`)

Checked both files: **no duplication was found.** `.theme-standard` and
`.theme-symmetry` only ever existed in `themes/default/theme.css`;
`styles/styles.css` only has a stale comment (line 15) that also references
`.theme-ase` and `.theme-locked-ase`, neither of which has a rule anywhere
in the tree (`docs/ui/BackendPanel/BackendTheme.js` only toggles
`theme-standard`/`theme-symmetry`). Nothing was moved or deleted from
`styles.css` — there was nothing to move. `theme.css`'s own header comment
was updated to stop claiming these are "owned by" `styles.css`, since they
never were.
