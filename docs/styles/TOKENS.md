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

**Known inversions:**

- **Fixed.** `.cv-panel-menu` (`panelWindow.css:252`, was `z-index: 3200`) —
  a context menu — outranked the app's own blocking modals (`3000`–`3100`).
  Checked whether any flow can open it while a modal is up first: every
  modal (`#pasteTextModal`, `#pngExportModal`, `#confirmModal`,
  `#shortcutsResetConfirmModal`, `#aboutOverlay`) is a full-viewport
  `position: fixed; inset: 0` backdrop, so it already covers every panel's
  ≡ button while shown — the menu can't be triggered underneath it. Also
  checked `PanelWindow._menuSections()`: only the Position/Close sections
  exist app-wide (no `def.menuSections` currently opens a modal), so the
  menu itself never triggers one either. `--z-context-menu` moved to `2500`
  — above everything it still needs to outrank (`--z-chrome` at 2000) and
  below the modal band (`--z-dialog` at 3000). Only consumer, so the token's
  value changed in place rather than adding a new name.
- **Fixed.** `.info-panel-overlay`/`.info-panel` (`info_button_styles.css`,
  were `--z-anchor`/999 and `--z-overlay-widget`/1000) — this one *is* a
  real overlap, not just a numbers-on-paper mismatch: `ui/panels/
  PanelWindow.js`'s ⓘ button (any floating panel's titlebar) and
  `ui/panels/RightDock.js`'s ⓘ button both call `showInfoPanel()`, so the
  overlay+card can be opened from inside a `--z-dock`-role element (1200)
  while that element stays open and on top — the "modal" rendered behind
  the panel that opened it. Moved to `--z-chrome`/`--z-info-panel` (2000/
  2001), the same role #aboutOverlay/#aboutModal already occupy for the
  identical full-scrim-plus-centered-card shape.
- **Checked, not fixed — no overlap found.** The remaining `--z-popup`-role
  elements (999–1100: `.background-dot`, `.popup`, `#LatticeComparisonPopUp`,
  `.theme-menu`, `.restore-popover`, `#axesGizmo`/`#axesLegend`) sit below
  `--z-dock`-role elements (1200+). Checked each for a real trigger path:
  `.background-dot` explicitly offsets itself clear of the right dock via
  `--split-reserve` (position-based avoidance, not z-index); `.popup` and
  `#LatticeComparisonPopUp` have no `classList`/`className` call anywhere
  in `docs/ui/**/*.js` — dead CSS, nothing to overlap; `.theme-menu` opens
  from the static left `#ui` panel, which isn't `--z-dock`-role; `#axesGizmo`
  /`#axesLegend`/`.restore-popover` are scene-chrome anchored to their own
  reserved corners, not opened from inside a dock/floating element. None of
  these have the info-panel's "triggered from inside the very layer it
  needs to outrank" property, so left as literal-preserving.

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
| 999 | `--z-anchor` | `.background-dot`, `.popup` |
| 1000 | `--z-overlay-widget` | `#status`, `#axesGizmo`, `#axesLegend`, `.restore-popover`, `.theme-menu` |
| 1001 | `--z-gizmo-controls` | `.cv-gizmo-controls` |
| 1100 | `--z-comp-panel` | `.floating-comp-panel` |
| 1200 | `--z-dock` (existing, unchanged) | `.cv-panel.cv-floating` |
| 1300 | `--z-dock-pane` | `.split-pane`, `.split-pane-tabs` |
| 1301 | `--z-dock-handle` | `.split-handle` |
| 1302 | `--z-dock-hint` | `#rightDockDropHint` |
| 1350 | `--z-dock-scrim` | `.split-pane-overlay` |
| 1400 | `--z-dock-expanded` | `.split-item.expanded` `!important`, `#viewArea.split-item-expanded .split-pane`, `.cv-panel.cv-floating.cv-has-expanded-item` `!important`, `.trajPlot.expanded` `!important` |
| 1500 | `--z-mobile-panel` | `#ui.panel-open` (mobile) |
| 2000 | `--z-chrome` | `#aboutOverlay`, `.cv-drag-select-rect`, `#mobileMenuToggle`, `.info-panel-overlay` (moved here, was 999 — see "Known inversions" below) |
| 2001 | `--z-info-panel` (`calc(--z-chrome + 1)`) | `.info-panel` (moved here, was 1000) |
| 2500 | `--z-context-menu` | `.cv-panel-menu` (moved here, was 3200 — the known inversion, now fixed; see below) |
| 3000 | `--z-dialog` | `#pasteTextModal`, `#pngExportModal`, `#raytraceWarningModal`, `#shortcutsHelpModal`, `.cv-crop-overlay` |
| 3100 | `--z-confirm` | `#shortcutsResetConfirmModal`, `#confirmModal` |

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

## Wave 2.6 — fourth token pass (missing middle rungs)

`tools/ci/css_guard.sh` still reports 280 colour-literal violations after
Wave 2.5. Re-running it and re-clustering its output (not the Wave 1/2.5
estimates, which had drifted) showed the 280 aren't scattered one-offs —
they're four ramps whose *ends* got tokens in earlier waves but whose
*middles* never did, because the original palette was sampled from
`styles.css`'s own idiom, which happens to only use the ends. Wave 2.6 adds
rungs only; **the violation count is unchanged at 280** — nothing was
adopted, by design, so the two sibling adoption agents don't collide with
this pass. All new tokens live in `themes/default/theme.css` next to the
ramp they extend; none of `dark/theme.css` or `twilight/theme.css` override
any of `--fg-*`/`--wash-*`/`--overlay*`/`--chrome-*`/`--info-bright` family,
confirming this UI chrome is meant to stay dark in every theme — no theme
override was needed.

### Foreground (text) ramp: `--fg-85` / `--fg-75` / `--fg-50`

`color: rgba(255,255,255,X)` audited across `docs/styles/*.css`: 72 sites,
14 distinct alphas, none matching `--fg-1`(1.0)/`--fg-2`(0.6)/`--fg-3`(0.4).
Two dense clusters fall inside the 1.0–0.6 gap, one inside the 0.6–0.4 gap:

| token | value | absorbs (alpha × count) | sites |
|---|---|---|---|
| `--fg-85` | `rgba(255,255,255,0.85)` | .96×1, .92×2, .9×5, .88×4, .86×1, .85×5, .82×7 | 25 |
| `--fg-75` | `rgba(255,255,255,0.75)` | .8×13, .78×2, .75×4, .72×2, .7×11 | 32 |
| `--fg-50` | `rgba(255,255,255,0.5)` | .5×13 | 13 |

`.62×2` is 0.02 from `--fg-2` and folds there rather than getting a rung of
its own. Named by literal alpha×100, not a fourth/fifth ordinal suffix —
there's no small/base/dim story the way `--fg-1/-2/-3` told one, just three
unrelated panels that each picked their own near-white independently. The
number keeps brighter-vs-dimmer legible next to the existing ordinals
(100 > 85 > 75 > 60 > 50 > 40) without renaming anything that ships.

### Wash (fill) ramp: `--wash-0` / `--wash-1-5`

`background`/`border`/`box-shadow` etc. using `rgba(255,255,255,X)` at
fill-not-text sites: 46 real sites once the audit is restricted to the
fill roles (excludes the six `border: ...rgba(255,255,255,0.3)` sites,
which already equal `--popup-border` exactly — see fallback survey below).

| token | value | absorbs | sites |
|---|---|---|---|
| `--wash-0` | `rgba(255,255,255,0.03)` | .02×6, .025×4, .03×7, .04×6, .045×1 | 24 |
| `--wash-1-5` | `rgba(255,255,255,0.06)` | .06×13, .07×4 | 17 |

`--wash-0` sits below the existing `--wash-1` (0.05); `--wash-1-5` sits
between `--wash-1` and `--wash-2` (0.08), same midpoint-naming precedent as
`--sp-3-5`. Leftover: `.09`/`.10` (1 site each) fold toward `--wash-2`;
`.14` folds toward `--wash-4`; `.16×2` is 0.01 above `--wash-4` and folds
down rather than earning a fifth rung for two sites.

**Not tokenised, four sparse `border` outliers:** `rgba(255,255,255,0.5)`×2,
`0.8`×1, `0.0`×1 — all on crop/drag-select-rect strokes, a different role
(emphasis stroke, not fill or hairline) with too few sites each to cluster.

### Black scrim: `--overlay-20` / `--overlay-80`

`background: rgba(0,0,0,X)` (backdrops, not `box-shadow` — shadows are
`--shadow-*`'s job): 19 sites, spanning 0.2–0.9, only 0.5 named
(`--overlay`) before this pass.

| token | value | absorbs | sites |
|---|---|---|---|
| `--overlay-20` | `rgba(0,0,0,0.2)` | .2×3 | 3 |
| `--overlay-80` | `rgba(0,0,0,0.8)` | .8×4, .85×1, .9×2 | 7 |

`.55×6` is 0.05 from `--overlay` and folds there. `.6`/`.65`/`.7` (1 site
each) stay unclustered — TOKENS.md already flagged this family as having
"no single dominant tier" between the ends, and the re-audit confirms it:
three more one-off sites, no new middle cluster. `box-shadow:
...rgba(0,0,0,0.45)` (1 site) and `border-color: rgba(0,0,0,0.15)` (1
site) are shadow/border roles respectively, not scrim fills — left alone.

### Opaque grey: `--chrome-2-5`

`#333` appears 15 times (13 `background`, 2 `border`) and matches none of
`--chrome-1..6`. It sits at lightness 51, exactly 7 units from `--chrome-2`
(44, `#2c2c2e`) and 7 from `--chrome-3` (58, `#3a3a3c`) — no nearer
neighbour, the same shape as the `--sp-3-5` gap, hence the same naming.

`--chrome-2-5: #333;`

**Not tokenised:** `#111` and `#222` (2 sites each, no shared selector,
darker than `--chrome-1`) — too thin to cluster on their own; recommend
folding both toward `--chrome-1` at adoption. `#f3f3f3` (2 sites, `color:`)
is 2 units from `--ink-6` (`#f5f5f5`) — fold there, no new token. `#595959`
(1 site) is 4 units from `--chrome-5` (`#555`) — fold there. `#2d2d2d` (1
site) is ~1 unit from `--chrome-2` — fold there. `#2b2b2b`, `#0d0d0d` (1
site each, both `var(--popup-bg/--input-bg, #hex)` fallbacks) don't cluster
with anything and aren't a real family on their own.

### Tinted near-whites: `--info-tint` / `--ok-tint`

Not part of any ramp above — the "no home at all" family from the css_guard
scan: near-white text carrying a state hue, one tier paler than
`--info-bright`/`--ok-bright`. Two real clusters, one per hue actually used:

| token | value | absorbs | sites | use |
|---|---|---|---|---|
| `--info-tint` | `#e7f5ff` | `#e7f5ff`×3, `#f5fbff`×2, `#cfe6ff`×2, `#cfeffb`×2, `#d7eef6`×1 | 10 | comparison headings, badges, composition text |
| `--ok-tint` | `#f5fffa` | `#f5fffa`×1, `#e8f5e9`×1 | 2 | About-panel heading + body text |

`--ok-tint`'s cluster is thin (2 sites, one literal each) but real — both
are the same About-panel role at slightly different literal picks, not two
unrelated colours. Kept separate from `-bright` per the rule that a
foreground tint and a saturated foreground aren't interchangeable just
because they share a hue.

**Not tokenised (too sparse, no shared role):** `#a5d6a7` (1 site, medium
green hover text — between `--ok-bright` and `--ok-tint`, closer to
neither); `#d7f5e8` (2 sites, but a `border` role on `.trajSlider` thumbs,
not text — mixing it into a text token would repeat the exact mistake
TOKENS.md's foreground/fill rule exists to prevent); `#0b1f1c` (1 site,
dark-green `#aboutModal` background); `#0c1f17` (1 site, dark-green text on
`#playPauseBtn`, presumably over a light-green fill — different role again).

### `var(--token, #hex)` fallback survey

Every `var(name, #hex-or-rgba)` fallback in the violation list, checked
against every existing token's literal value:

**Already equal to an existing token — free substitution, no visual change:**

| call site | fallback | equals |
|---|---|---|
| `analysisPanels.css` ×5 (`.pt-*` rules) | `var(--highlight-color, #00bcd4)` | `--info` (`#00bcd4`, exact) |
| `structureInfoPanel.css:117` `.press-hold-popup-btn` | `var(--panel-fg, #fff)` | `--panel-fg` / `--fg-1` (`#ffffff`, exact) |
| `bondLengthHistogram.css` (`.phl-alpha-value-input`'s sibling rule) | `var(--highlight-color, #f08412)` | `--danger-rgb` (`240 132 18`, exact — use `rgb(var(--danger-rgb))`) |
| 6× (`rightDock.css`, `panelWindow.css` et al.) | `border: 1px solid var(--border-color, rgba(255, 255, 255, 0.3))` | `--popup-border` (`rgba(255, 255, 255, 0.3)`, exact) |

**Becomes tokenisable now that Wave 2.6 exists (wasn't free before this pass):**

- `structureInfoPanel.css:322` `.segmented-control` — `var(--panel-fg,
  #f5fbff)` → the fallback's `#f5fbff` is one of `--info-tint`'s absorbed
  literals; can become `var(--panel-fg, var(--info-tint))`.
- `addStructure.css:481` `.sg-select-list` — `var(--popup-bg, #2b2b2b)` and
  `analysisPanels.css` `var(--popup-border, #333)` don't equal an existing
  token, but `#333`'s fallback can now use the new `var(--popup-border,
  var(--chrome-2-5))`.

**Checked, no match found (leave as literal fallbacks for adopters'
judgment):** `var(--highlight-color, #4caf50)`, `var(--highlight-color,
#4ade80)`, `var(--popup-bg, #111)`, `var(--popup-bg, #2b2b2b)`,
`var(--input-bg, #0d0d0d)`, `var(--highlight-color, var(--accent-color,
#2a8f4f))`×2, `var(--accent-color, #4a9eff)`, `var(--muted-fg, #9aa0a6)`×2
— see below, this last one is actually dead code, not a real fallback.

### Two bugs found, not fixed here

- **`var(--muted-fg, #9aa0a6)`** (`panelWindow.css:264`,
  `rightDock.css:357`) — `--muted-fg` **is** defined (`theme.css:30`,
  `#f9f9f9`), so this fallback can never actually render; it's dead code,
  not an intentional degrade path. Recommend adopters just drop the
  fallback (`var(--muted-fg)`), not tokenise `#9aa0a6` — there is nothing
  for a new token to represent once the dead branch is gone.
- **`--text-muted`** (the bug named in this task's brief) — grepped the
  whole tree: exactly one reference exists,
  `analysisPanels.css:532`: `color: var(--text-muted, var(--ink-2));` with
  an inline comment already noting `--text-muted` is undefined so `--ink-2`
  (`#999`) is what actually renders. `--text-muted` itself is defined
  nowhere, in any theme. Recommendation: don't define `--text-muted` — one
  call site referencing an alias for a token that already has a name
  (`--ink-2`) doesn't justify minting a second name for the same value.
  Adopters should collapse the site to `color: var(--ink-2);` directly and
  delete the dead `--text-muted` reference, rather than defining the alias
  to make the existing fallback "correct."

## Wave 3 — css_guard follow-up (94 → 73)

*73 was the count when this wave ended, not a standing figure — Wave 4 below
took it to zero.*

Three independent agents had converged on the same short list of hue
families with no ramp. This pass named the ones with enough call sites to
justify it and adopted them; the rest stayed literal. 21 sites moved.

| token | value | sites | role |
|---|---|---|---|
| `--blue-accent-rgb` | `91 168 255` | 4 (1 a near-dupe fold, `.sym-link`'s `rgba(111,182,255,.5)`) | border/ring: `.si-wyckoff-badge` border, `.wyckoff-locked` ring, `.pi-forced-notice` border, `.sym-link` underline |
| `--blue-accent-fill-rgb` | `35 139 230` | 2 | fill tier of the same family: badge gradient's lighter stop, `.pi-forced-notice` background — kept apart from the border tier per "cluster by role" |
| `--shortcuts-danger-rgb` | `220 53 53` | 10 | shortcuts-help destructive actions (clear/reset/conflict) — all in `styles.css`, a different hue from the orange `--danger` |
| `--camera-glow-rgb` | `6 100 50` | 3 | `#cameraTools` hover/unlocked glow ring — deliberately not `--highlight-color`/`--border-color`: must stay fixed green regardless of active backend theme, same call as the bond-range-slider's fixed track (`css_guard_allow.txt`) |
| `--vacancy-amber-rgb` | `255 210 120` | 2 | disordered-site species/vacancy text tint — thin but real, same call as `--ok-tint`'s 2-site precedent |
| `--active-green-rgb` | `125 206 160` | 5 | "active/applied" state accent (atom-editor button, coord-axis slider, new-row separator) — checked against `--ok-bright-rgb` (`126 226 168`) and kept separate: the call sites had already flagged it "not an exact match," and the roles here (border/ring/accent-color) don't match the anneal badge's fill+text pairing |
| `--chrome-1-9` | `rgba(25, 25, 25, 0.9)` | 4 (3 near-dupes: `17/17/17`@.9, `22/22/22`@.88, `26/26/26`@.95) | near-opaque near-black fills above `--chrome-1`'s 0.8 alpha — `.backend-error-panel`, `.backend-potential-toggle`, `.atomistic-grid input`, and a dead `.control-panel` rule (tokenised anyway for consistency) |

**Left literal — below the ~3-site bar, or ruled out by the foreground/fill
rule:** *(Superseded — every entry in this list is a token as of Wave 4. The
~3-site bar itself is retired; see below for why.)*

- `rgba(32, 77, 160, 0.35)` (badge gradient's darker stop) and
  `rgba(25, 55, 110, 0.28)` (`.wyckoff-locked` background) — each a single
  site, and neither is close enough to `--blue-accent-fill-rgb` to fold
  without violating "cluster by role, not hue distance."
- `#1c5fb8`/`#2493ff` (`.wyckoff-locked button.active` gradient) — a single
  site, a solid saturated pair rather than the family's translucent tints.
- `#e63946`, `#ff7b7b`, `rgba(255, 80, 80, *)` (2 sites), `#ff6b6b`
  (2 sites) — a scattered handful of bright reds, each a `color:`
  (foreground) use on its own feature (delete-icon hover, disabled label,
  plane-delete button, two unrelated error texts). None reuses 3+ times,
  and per the foreground/fill rule none of them can safely fold into
  `--shortcuts-danger-rgb` (a fill/border-only family) even where the hue
  is close — text needs to stay a separate token from a fill at the same
  hue, not borrow one.
- `.backend-error-panel`'s dead-code sibling and `styles_file_browswer.css`'s
  `rgba(13, 13, 13, 0.95)` — both already explicitly checked against
  `--chrome-1` and found not to match; not close enough to `--chrome-1-9`
  either.

**Two z-index inversions, one fixed, one investigated (not just colour
this pass) — see "Known inversions" above** for `.cv-panel-menu` (moved
3200 → 2500) and `.info-panel-overlay`/`.info-panel` (moved 999/1000 →
2000/2001).

**`.background-dot`'s border** no longer comes from a raw
`@media (prefers-color-scheme: dark)` query in `responsive.css` (deleted).
It's `--dot-border` now — defined in `default/theme.css`, overridden in
`dark/theme.css` — so it follows the theme the user actually selected via
`ui/ThemeManager.js`, not the OS directly. `twilight/theme.css` doesn't
override it: its scene is light-ish like the base, so the same dark border
applies without restating it.

**`#cameraTools .camera-tool-reset-btn`'s border** was `rgba(250, 132, 18, 1)`
— 250 vs. `--danger-rgb`'s 240 for the same G/B (132, 18) is a one-digit
typo, not a second orange. Corrected and adopted as `rgb(var(--danger-rgb)
/ 1)`; the shift is a hair darker, essentially imperceptible.

**`.popup`'s `position: absolut` typo** (`responsive.css`, 1320px rung) —
checked `.popup`'s base rule (`styles.css`) first: it already sets
`position: absolute`, so the invalid declaration was dead weight, not a
missing position — the `top`/`left` in the same rule were already applying.
Corrected the typo; zero visual change. (`.popup` has no live
`classList`/`className` consumer anywhere in `docs/ui` either, so the rule
isn't currently reachable regardless.)

## Wave 4 — the remaining literals (73 → 0)

42 tokens, added in one block at the end of `themes/default/theme.css` under
the "Hue families that used to sit as literals" header. `css_guard` now
reports clean and `make checks` exits zero; there is no known-violations
baseline left to carry.

**Why the bar moved.** Waves 2.6 and 3 both declined most of these on
call-site count — a hue used once or twice "doesn't justify a token." That
calculus was right when a theme only had to repaint panels that were already
dark. It isn't any more: light-panelled themes are being added, and a literal
sitting in a component stylesheet is a hole a theme cannot reach. Every value
below is a dark-panel assumption baked into `docs/styles/` — white-alpha
hairlines, near-black fills, bright-on-dark error text, black ink on a light
sprite. A one-site literal is exactly as unreachable as a ten-site one, so
site count stopped being the deciding question and reachability took over.
The foreground/fill rule established in Wave 1 still holds and still splits
tokens here (`--danger-bright` vs `--danger-fill`, `--warn-soft` vs
`--warn-banner-bg`) — that rule is about role, not frequency, and nothing
about light themes weakens it.

Values are the originals, so the default palette renders unchanged apart from
five deliberate folds recorded below.

**Eleven of the 73 were never real.** `css_guard.sh`'s colour-keyword scan used
`\b` for its word boundary, and a hyphen is a word boundary to `\b` — so
`rgb(var(--active-green-rgb) / .5)` matched on the "green" *inside the token
name* and reported already-tokenised code as a literal. The pattern now uses
`(?<![-\w])` / `(?![-\w])` lookarounds (needs `rg -P`). Fixing it took the
count 73 → 62, so the real debt was 62. (Eleven reports, not eleven distinct
lines: `.si-wyckoff-badge` was reported twice — once for this false match and
once for a genuine literal in the same gradient, which remained.)

### Danger

`--danger` (amber-orange) is the fill; these are the red foreground tier.

| token | value | role | call sites |
|---|---|---|---|
| `--danger-bright` | `#ff6b6b` | error/destructive text on a dark panel | `analysisPanels.css` `.cmp-comparison-error`; `sceneWidgets.css` `.cv-overlay-error`; `styles.css` `#aboutContent .about-error`; `backendPanel.css` `.atomistic-label-disabled`; `controlPanel.css` `.plane-delete-btn:hover` |
| `--danger-bright-rgb` | `255 107 107` | same hue as a channel triple, for sites composing their own alpha | `controlPanel.css` `.plane-delete-btn` (0.75); `styles.css` `.reset-btn:hover` glow (0.1) |
| `--danger-strong` | `#e63946` | saturated destructive icon hover | `styles_file_browswer.css` `.icon.delete:hover` |
| `--danger-fill` | `rgba(200, 35, 35, 0.92)` | solid destructive button — a fill, kept apart from the foreground tier above | `styles.css` `.reset-btn-danger` |

### Caution

| token | value | role | call sites |
|---|---|---|---|
| `--warn-soft` | `rgba(243, 174, 100, 0.9)` | soft-refusal borders and notes — a caution that isn't an error | `backendPanel.css` `.denyBtn:hover` (both `border-color` and `border`); `structureInfoPanel.css` `.coord-editor-note.refused` |
| `--warn-banner-bg` | `rgba(40, 30, 0, 0.85)` | warm-black backing behind amber banner text; deliberately not `--warn-rgb` at a low alpha, which composes to a bright amber fill instead | `warningBanners.css` `.cv-warning-banner` |
| `--best-row-rgb` | `255 193 7` | amber "best match" row highlight, two alphas off one hue | `styles.css` `.order-structure-row.best` (0.1) and `.order-structure-row.best.showing` (0.18) |

### Positive / switches

Two switch greens survive because two different switch widgets ship with them
— `--switch-on-alt` is the blue one in `toggle_styles.css`, not a duplicate.

| token | value | role | call sites |
|---|---|---|---|
| `--switch-on` | `#4caf50` | checked-state fill of a toggle track | `sceneWidgets.css` `.cv-overlay-toggle-switch input:checked + .toggle_slider`; `forcePanel.css` `.cv-species-toggle input:checked + .cv-species-toggle-track`; `analysisPanels.css` `#showComparisonBonds` / `#showLatticeComparison` / `#enableComparisonToggle` `:checked + .toggle_slider`, and `.tracer-progress-fill` as `--highlight-color`'s fallback |
| `--switch-on-alt` | `#2196f3` | the generic slider's checked blue | `toggle_styles.css` `input:checked + .toggle_slider` |
| `--seg-active-bg` | `#0d8a36` | active button in a segmented control | `structureInfoPanel.css` `.spin-mode-switch-btn.active` |
| `--btn-glow-rgb` | `54 143 110` | button hover glow | `styles.css` `#secondLoadTextButton:hover` (0.35) |
| `--on-accent` | `#0c1f17` | text sitting ON an accent fill — 2.6 spotted this one and filed it as "different role again"; that role is now named | `trajectoryPanel.css` `#playPauseBtn` |
| `--thumb-border` | `#d7f5e8` | slider thumb ring — a border, which is why 2.6 refused to fold it into a text token | `trajectoryPanel.css` `.trajSlider::-webkit-slider-thumb`, `.trajSlider::-moz-range-thumb` |

### Informational blues

| token | value | role | call sites |
|---|---|---|---|
| `--confirm-bg` | `#0066cc` | enabled confirm button fill | `analysisPanels.css` `.pt-confirm-btn:not(:disabled)` |
| `--confirm-border` | `#004499` | its darker border, same rule | `analysisPanels.css` `.pt-confirm-btn:not(:disabled)` |
| `--link-hover` | `#81d4fa` | hovered link on a dark panel | `styles.css` `#aboutContent a:hover` |
| `--row-selected-bg` | `rgba(100, 150, 255, 0.12)` | selected table-row wash | `controlPanel.css` `.planes-row-selected` |
| `--locked-bg` | `rgba(25, 55, 110, 0.28)` | the Wyckoff "locked" surface | `structureInfoPanel.css` `.segmented-control.wyckoff-locked` |
| `--locked-badge-bg` | `rgba(32, 77, 160, 0.35)` | that surface's badge gradient, first stop — the second stop stays `--blue-accent-fill-rgb`, the two stops being from different families | `structureInfoPanel.css` `.si-wyckoff-badge` |
| `--locked-grad-1` | `#1c5fb8` | locked active-button gradient, dark stop | `structureInfoPanel.css` `.segmented-control.wyckoff-locked button.active` |
| `--locked-grad-2` | `#2493ff` | same gradient, light stop | `structureInfoPanel.css` `.segmented-control.wyckoff-locked button.active` |

### The About modal

A surface of its own — green-tinted, unlike every other panel — so it needs
its own handful rather than borrowing the panel tokens. `--about-close-hover`
is the `#a5d6a7` that Wave 2.6 explicitly left out as "closer to neither"
`--ok-bright` nor `--ok-tint`; that was the right call about the ramps and the
wrong conclusion about the token — it isn't a ramp member, it's this modal's
close-button hover.

| token | value | role | call site |
|---|---|---|---|
| `--about-bg` | `#0b1f1c` | modal background | `styles.css` `#aboutModal` |
| `--about-border` | `rgba(129, 199, 132, 0.4)` | its green-tinted border | `styles.css` `#aboutModal` |
| `--about-code-bg` | `rgba(12, 45, 36, 0.7)` | inline-code backing inside it | `styles.css` `#aboutContent code` |
| `--about-close-hover` | `#a5d6a7` | close-button hover | `styles.css` `#aboutClose:hover` |

### Neutrals

The scrim alphas here (0.6, 0.65, 0.7) are the one-off sites Wave 2.6 counted
and left unclustered. They still don't cluster — they get names because each
is a distinct role a light theme has to be able to move, not because a fourth
scrim tier was discovered.

| token | value | role | call sites |
|---|---|---|---|
| `--overlay-60` | `rgba(0, 0, 0, 0.6)` | scrim between `--overlay` (0.5) and `--overlay-80` | `styles.css` `.cv-crop-mask` |
| `--overlay-70` | `rgba(0, 0, 0, 0.7)` | the About modal's backdrop | `styles.css` `#aboutOverlay` |
| `--label-bg` | `rgba(0, 0, 0, 0.65)` | in-scene measurement label backing — a fill, not a backdrop | `styles.css` `.measure-label` |
| `--label-ink` | `#000000` | ink on that label; it sits on a light sprite, so it's the one place the app paints black *on* something rather than behind it | `analysisPanels.css` `.bond-distance-label` (`border` and `color`) |
| `--line-3` | `rgba(255, 255, 255, 0.5)` | hairline brighter than `--line-2` (0.2) — the emphasis stroke 2.6 declined to name | `sceneWidgets.css` `.cv-background-swatch`; `styles.css` `.reset-btn:hover` |
| `--line-dark` | `rgba(0, 0, 0, 0.15)` | hairline ON a light accent fill — the inverse case, and precisely the kind a light theme must be able to flip | `styles.css` `.btn-mini.highlight` |
| `--line-grey` | `#808080` | opaque mid-grey border | `styles.css` `.angle-btn` |
| `--track-bg` | `rgba(128, 128, 128, 0.15)` | slider/progress groove — mid-grey, in neither the white-wash nor the black-overlay family | `analysisPanels.css` `.tracer-progress-bar` |
| `--track-bg-strong` | `rgba(150, 150, 150, 0.5)` | the stronger groove | `bondLengthHistogram.css` `.blh-range-slider .blh-range-bg` and `.bond-range-slider .background-track` |

Those last two selectors were the allowlist's worked example of why
`css_guard_allow.txt` keys on the selector rather than the value: same
literal, only one of them ever reviewed. Both are `--track-bg-strong` now, so
both entries are gone; the comment explaining the rule stays, because the next
pair will need it.

### Extra opaque surfaces

| token | value | role | call site |
|---|---|---|---|
| `--textarea-bg` | `rgba(16, 16, 16, 0.8)` | multi-line input backing | `sceneWidgets.css` `.cv-spin-textarea` |
| `--float-panel-bg` | `rgba(26, 26, 26, 0.8)` | floating scene widgets — `--popup-bg`'s hue at a different alpha, which is why 2.6 found no exact match | `sceneWidgets.css` `.cv-background-picker-panel` |
| `--popup-bg-deep` | `rgba(13, 13, 13, 0.95)` | near-opaque popup; checked against `--chrome-1` and `--chrome-1-9` in Wave 3 and matched neither | `styles_file_browswer.css` `.cv-fb-popup` |

### Lattice axis legend

a/b/c encode data, so they'd normally stay literal — but they have to match
the 3D gizmo, and a theme that retints the scene has to be able to retint
these with it.

| token | value | call site |
|---|---|---|
| `--axis-a` | `#ff3333` | `styles.css` `.dot-a` |
| `--axis-b` | `#33cc33` | `styles.css` `.dot-b` |
| `--axis-c` | `#3366ff` | `styles.css` `.dot-c` |

### Active tool

| token | value | role | call sites |
|---|---|---|---|
| `--tool-active` | `#ff6b35` | active measure-tool border | `styles.css` `.measure-tool-btn.active` |
| `--tool-active-rgb` | `255 107 53` | same hue for its glow | `styles.css` `.measure-tool-btn.active` (0.4) and `.measure-tool-btn.active:hover` (0.5) |

### Five substitutions that shift colour

Everything else in this wave is a byte-identical swap. These five are not, and
are recorded here rather than left to be discovered by eye. Each folds a
near-identical one-off into a token that already had to exist for the rest of
its family; the alternative was minting a second token one or two RGB units
away, which is the fragmentation this pass exists to end.

| call site | was | now | shift |
|---|---|---|---|
| `styles.css` `#aboutContent .about-error` | `#ff8a80` | `--danger-bright` (`#ff6b6b`) | slightly deeper red |
| `backendPanel.css` `.atomistic-label-disabled` | `#ff7b7b` | `--danger-bright` (`#ff6b6b`) | slightly deeper red |
| `controlPanel.css` `.plane-delete-btn` and its `:hover` | `rgba(255, 80, 80, 0.75)` / `rgba(255, 80, 80, 1)` | `rgb(var(--danger-bright-rgb) / 0.75)` / `--danger-bright` | marginally less saturated |
| `structureInfoPanel.css` `.coord-editor-note.refused` | `rgba(255, 180, 120, 0.9)` | `--warn-soft` (`rgba(243, 174, 100, 0.9)`) | a touch warmer and darker |
| `forcePanel.css` `.cv-species-toggle input:checked + .cv-species-toggle-track` | `#00c851` | `--switch-on` (`#4caf50`) | less acid green, now matching every other checked switch in the app |

The last one is the only visible change of the five: this toggle was the sole
switch in the app not painting the shared checked-state green, and it now
matches the others. The four reds/oranges are sub-perceptual at these sizes.

### Fallbacks resolved

Wave 2.6's fallback survey left eight `var(--token, #hex)` fallbacks "for
adopters' judgment." All are resolved: `#4caf50` → `var(--switch-on)`,
`#4ade80` → `var(--ok-bright)`, `#4a9eff` → `var(--info-bright)`, `#2a8f4f`
(×2) → `var(--ok)`, and the three whose token is defined in every theme and
can therefore never render its fallback — `var(--popup-bg, #2b2b2b)`,
`var(--popup-bg, rgba(30, 30, 30, 0.95))`, `var(--input-bg, #0d0d0d)` — had
the dead branch deleted rather than tokenised, on the same reasoning 2.6
applied to `var(--muted-fg, #9aa0a6)`. `styles_file_browswer.css`'s
`rgba(255, 255, 255, 0.0)` border became `transparent`: it was never a colour
choice, just a fully transparent one spelled the long way.
