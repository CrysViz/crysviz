# CrysViz style guide

How styling works here, and what to do when you touch it. Written after the
CSS consolidation that moved ~3 500 lines of styling out of JavaScript and put
every colour behind a token. **The next goal is adding themes** — most of this
document exists to make that a one-file job.

Companion docs: `docs/styles/TOKENS.md` is the reference for what every token
means and which literals it replaced. `CSSPlan.md` is the historical plan and
is mostly of archaeological interest now.

## Where things live

```
docs/themes/default/theme.css   the token vocabulary (175 declarations).
                                The ONLY place a colour or font stack may live.
docs/themes/<id>/<mode>.css     a palette's mode: redefines the tokens it changes
docs/themes/themes.json         the palette registry
docs/styles/responsive.css      every @media rule in the app, one ladder
docs/styles/<component>.css     component rules — tokens only, no literals
docs/ui/ThemeManager.js         loads base + selected override, mirrors the
                                scene tokens into three.js
```

`docs/index.html` loads: `theme-base` → component stylesheets → `formControls`
→ `responsive.css` → `#theme-active`. **That order is load-bearing.**
`responsive.css` is late so its rules win cascade ties; `#theme-active` is last
so a theme can override anything.

Never edit `docs/external/` or `docs/compiled/` — vendored.
`docs/addons/` is out of scope entirely (the Energy Landscape addon is shelved
and self-contained; it injects its own `<style>` on purpose because addons load
dynamically).

## The four invariants

`tools/ci/css_guard.sh` runs inside `make checks` and enforces:

1. No colour literal outside `docs/themes/`
2. No `font-family` outside `docs/themes/`
3. No `@media` outside `docs/styles/responsive.css`
4. No CSS-in-JS under `docs/` (`cssText`, `createElement('style')`,
   `adoptedStyleSheets`, `insertRule`)

Exceptions live in `tools/ci/css_guard_allow.txt`, **keyed on the selector, not
the value** — the same literal appears at a reviewed data-viz call site and at
an unreviewed one, and a value-keyed entry would amnesty both.

The allowlist is for colours that **encode data** (chart series, status dots,
gradient-picker stops, the bond-range slider's fixed green). It is not a
dumping ground for un-tokenised debt. If the guard finds something real, fix it
or report it — do not allowlist it away.

**The guard currently reports ~73 violations and therefore fails.** These are
hue families with too few call sites to justify a token, listed in TOKENS.md.
That is a known, deliberate baseline, not a regression. If your change moves
that number *up*, you added debt.

## Adding a theme

Theming is two axes. A **palette** is the colour family and is picked from the
dropdown; a **mode** is `light` / `twilight` / `dark` and is picked from the
icon row. `auto` is a mode, not a palette — it follows the OS through the
palette's own `auto` pair, so "Fluorite, following the system" is expressible.

1. Create `docs/themes/<id>/<mode>.css` for each mode the palette offers.
   Redefine only what changes — it layers on top of `default/theme.css`, which
   supplies everything else.
2. Add one entry to `docs/themes/themes.json`:

   ```json
   { "id": "<id>", "name": "Display Name",
     "auto": ["light", "dark"],
     "modes": { "light": "<id>/light.css", "dark": "<id>/dark.css" } }
   ```

3. That's it. No JS, no `index.html` change.

A palette only offers the modes it lists; the icon row disables the rest, and
switching to a palette that lacks the current mode falls back through that
palette's `auto` pair rather than stranding the selection. `"modes"` may map a
mode to `null`, which means "base theme only" — that is how Default's Light
works.

Optional: drop icons in `docs/themes/<id>/icons/` and override the
`--icon-*` tokens; `url()` resolves relative to your mode's CSS file.

### What a theme must know

- **Two tokens are read by JavaScript**, not just CSS: `--scene-bg` and
  `--lattice-color`. `ThemeManager` mirrors them into three.js for the WebGL
  canvas clear colour and the unit-cell lines. A theme that changes the scene
  must set both, and they must be resolvable by `getComputedStyle` (a plain
  colour, not something exotic).
- **The accent tokens follow the compute backend**, not the theme:
  `--bg-color`, `--highlight-color`, `--accent-color`, `--hover-color`,
  `--border-color` are defined on `.theme-standard` / `.theme-symmetry`, which
  `ui/BackendPanel/BackendTheme.js` toggles on `<body>`. A theme *may* redefine
  those classes to recolour accents, but by default leaves them alone.
- **`auto` mode**: each palette's `"auto": [lightMode, darkMode]` pair follows
  the OS `prefers-color-scheme`. It is the default selection. Nothing else in
  the app should read `prefers-color-scheme` directly — that produced a real
  bug where picking "Light" on a dark-mode OS left one element dark, and a
  second one where a dead per-frame block in `AnimateModule` would have fought
  the theme every frame. If something needs to differ by OS scheme, it becomes
  a token that the dark mode overrides. `ThemeManager` stamps the effective
  mode on `<html data-theme>` and the palette on `<html data-palette>`; that
  pair is what everything else reads (see `AddonAPI.getTheme`).
- **The UI panels are dark in every theme today.** `dark/` and `twilight/` only
  override scene colours. A genuinely light-panelled theme is untested — it
  will need `--fg-*` (white-alpha) and `--chrome-*`/`--ink-*` (opaque ramps)
  redefined, and that is where the remaining 73 literals will show as holes.

## The token vocabulary

Full reference in `docs/styles/TOKENS.md`. The shape:

| group | tokens |
|---|---|
| surfaces | `--surface-bg` `--panel-bg` `--group-bg` `--menu-bg` `--popup-bg` `--input-bg` |
| text ramp | `--fg-1` (1.0) `--fg-85` `--fg-75` `--fg-2` (0.6) `--fg-50` `--fg-3` (0.4) |
| opaque ramps | `--chrome-1..6` (dark widget chrome) `--ink-1..6` (off-white text) |
| washes | `--wash-0` `--wash-1` `--wash-1-5` `--wash-2..4` (white alpha fills) |
| lines | `--line-1` `--line-2` `--popup-border` |
| scrims | `--overlay-20` `--overlay` (0.5) `--overlay-80` `--overlay-light` |
| shadows | `--shadow-sm/-md/-lg/-glow`, `--shadow-rgb` for custom geometry |
| state | `--danger` `--warn` `--ok` `--info`, each with `-bright`, `-tint`, `-rgb` |
| type | `--font-ui` `--font-mono` `--font-display`; `--fs-xs…--fs-hero`; `--fw-*`; `--lh-*` |
| space | `--sp-1..6` plus `--sp-3-5` (10px) |
| radius | `--radius-3/-4/-5/-sm/(--radius 8)/-9/-md/-12/-24` |
| depth | `--z-*` ladder |
| layout | `--ui-width` `--ui-total-width` `--gizmo-*` `--popup-left` |

Two rules that were learned the hard way and are worth restating:

**A state colour used as foreground is a different token from the same state
used as a fill.** Folding the light link/heading colours into their darker
same-family token measurably dropped contrast and had to be reverted. That is
what `-bright` and `-tint` exist for.

**Cluster by role, not by hue distance.** Two colours being close in RGB does
not make them interchangeable.

**Font-size tokens already carry `var(--cv-font-scale, 1)`.** Never wrap one in
another `calc()` — that double-applies the user's font-scale setting.

## Layout: one token, not one rule per place

`--ui-width` is the side panel's width and feeds `--ui-total-width`, which
positions the gizmo, camera tools and popups. Overriding it per breakpoint in
`responsive.css` cascades to all of them. Prefer that over touching `#ui`
directly — a `#ui { width: 280px }` rule sat dead for a long time because the
base rule's `min-width: var(--ui-width)` outranked it.

## The breakpoint ladder

All in `responsive.css`, widest first:

| rung | condition |
|---|---|
| roomy | `max-width: 1320px` |
| compact | `max-width: 1024px` — dock collapses, panel goes off-canvas |
| mobile | `max-width: 720px` — panel becomes a full-width sheet |
| tiny | `max-width: 420px` |
| (complement) | `min-width: 721px` — for rules that want horizontal room |
| short | `max-height: 480px` |
| coarse | `pointer: coarse` — touch targets to `--control-h-touch` |
| fine | `(hover: hover) and (pointer: fine)` — hover-only affordances |

`ui/MobileMenu.js` reads the compact rung through `matchMedia` rather than
keeping its own copy of `1024`. Keep it that way.

Mobile uses `dvh`, not `vh` (a retracting URL bar otherwise puts panel bottoms
out of reach), and `max(…, env(safe-area-inset-*))` for edge-anchored chrome.

## Traps that have actually caused bugs here

**`className =` wipes classes.** `body.className = 'my-class'` destroyed the
`cv-panel-body` class `PanelWindow` had put there, taking the panel's
background with it and letting the 3D scene show through the form. Use
`classList.add`.

**JS reads styles back.** Several places use `element.style.display !== 'none'`
(and `.opacity`, `.background`) as a state flag. Move that property into a
class and the inline value reads empty, silently inverting the check. Nothing
catches it but a browser test. **Before moving any `style.X` write, grep for
reads of `.style.X`.** Do not "fix" it by switching the reader to
`getComputedStyle` — that changes a convention other code relies on.

**Inline styles beat classes.** Selection highlighting is applied inline, so a
stylesheet `:hover` rule cannot overwrite it — which is what makes the hover
conversions safe. Check before assuming.

**`*/` inside a comment ends it.** Writing `--fg-*/--ink-*` in a CSS comment
closes the comment early and leaks the rest of the sentence into the rule as
invalid CSS. This shipped twice. Say "the fg and ink ramps".

**Sidebar-authored content gets adopted.** The Atomistic UI is written for the
380px sidebar and then adopted into a much wider dock pane. Width caps must be
lifted with a descendant selector (`.cv-panel-body .backend-control-group`),
not a child selector — panels nest.

## Verifying a change

```
make checks                                    # eslint, tsc, imports, css guard
tools/browsertest/run.sh tests/<name>.test.js  # one file (or several)
tools/browsertest/run-all.sh 4                 # the whole suite, 4 shards
```

Run browser tests from **inside `tools/browsertest/`** — its paths are relative
to that directory.

**Run only one suite at a time.** The box has 8 cores and rendering is software
GL, so two overlapping `run-all.sh` invocations starve the renderer and produce
a cascade of fake pixel-assertion failures. A clean run is ~1195/1197.

Known flaky under parallel load — re-run in isolation before believing them:
`mdensemble` (stochastic barostat), `tracerfield` / `tracerpreview` (GPU
accumulation counts), `mdensembleui`'s badge-opacity check, and the pixel
coverage assertions in `celoutline`, `bondrows`, `depthpeeledges`,
`tracermaterials`.

### Writing tests for styling

Assert **relationships, not values**. `color === "rgba(255,255,255,0.75)"`
pins a token value and breaks on any legitimate palette change — that is churn,
not signal. Assert that the colour *changes* when the theme changes, that the
panel *is* painted, that content *tracks* its pane width.

Anything that animates must be waited for, not slept on. `transitionend` alone
is not enough — an interrupted transition fires one early. Follow it with a rAF
poll until the value stops changing.

Theming and the ladder are covered by `themeswitch.test.js` and
`responsiveladder.test.js`. `panelcontentfill.test.js` is the reference for
"content fills its pane". Playwright cannot emulate `pointer: coarse`, so the
touch-target rung has no automated coverage.

## Conventions

Match the file you are editing. Class names are kebab-case, prefixed by the
owning component. Comments explain **why** — the constraint, or the bug that
forced the code — not what the line does. No `/** @type {any} */`, `: any`,
`@ts-ignore`, or `eslint-disable`; if the types do not work, fix the types.

Commit messages: conventional prefix with a scope, subject under ~50 chars,
imperative. Body only when the reason is not obvious from the diff. No
trailers.
