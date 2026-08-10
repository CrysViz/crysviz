// Shared color-bar legend widget used by ForcePanel.js and SpinPanel.js: a
// gradient strip with editable Min/Max inputs, a few labeled tick marks, a
// horizontal/vertical orientation menu, an optional axis legend, and
// drag-into-the-3D-scene support (ui/ColorBarDrag.js).

import * as THREE from '../external/three/three.module.js';
import { general } from '../state/store.js';
import { getHeatMapColors, getBatlowColors, getHawaiiColors, getManaguaColors, getViridisColors, getPlasmaColors, getSpectralRColors, getJetColors } from '../defaults/color_texture_defaults.js';
import { makeColorBarDraggable } from './ColorBarDrag.js';
import { listActiveColorBars } from './ColorBarRegistry.js';
import { applyLegendHtml, legendPlainText } from '../utils/index.js';

function createElement(tag, attributes = {}, styles = {}, textContent = "") {
  const el = document.createElement(tag);
  Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(styles).forEach(([k, v]) => (el.style[k] = v));
  if (textContent) el.textContent = textContent;
  return el;
}

// Exported for render/ImageExportModule.js, which redraws a bar's gradient
// on the export's 2D canvas rather than rasterizing the live DOM widget —
// reusing this (rather than re-deriving the color stops) keeps the exported
// gradient pixel-identical to the on-screen one.
export function colorsFor(colormap) {
  switch (colormap) {
    case "batlow": return getBatlowColors();
    case "hawaii": return getHawaiiColors();
    case "managua": return getManaguaColors();
    case "viridis": return getViridisColors();
    case "plasma": return getPlasmaColors();
    case "spectralR": return getSpectralRColors();
    case "jet": return getJetColors();
    default: return getHeatMapColors();
  }
}

// Exported for render/ImageExportModule.js — see colorsFor above.
export function formatTick(v) {
  if (!isFinite(v)) return '';
  let s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

// Exact powers of ten print as "1e-4" / "1" / "1e3" rather than the decimal
// expansion — matches how the log tick picker below always chooses tick
// *values* that are clean decades once the range spans more than one.
function formatDecadeTick(k) {
  return k === 0 ? "1" : `1e${k}`;
}

// log10(0) is -Infinity; clamp tick values below this floor before taking a
// log so a tick landing at/near 0 doesn't blow up its own position math.
const LOG_EPS = 1e-6;

const INNER_TICKS = 3; // labeled ticks strictly between min and max (linear, or a log range under one decade)
const MAX_LOG_TICKS = 4; // decade ticks cap, not counting the min/max endpoints

// Once a log-scaled range spans more than a decade, evenly-spaced-by-fraction
// ticks land on odd values like "3.28" — prefer the clean decades (1e-4, 1e-3,
// …) that fall strictly inside (min, max) instead, thinned to at most
// MAX_LOG_TICKS if there are more decades than that.
// Exported for render/ImageExportModule.js — see colorsFor above.
export function computeTicks(min, max, scale) {
  if (scale === 'log' && min > 0 && max / min > 10) {
    const lo = Math.log10(min);
    const hi = Math.log10(max);
    let decades = [];
    for (let k = Math.ceil(lo - 1e-9); k <= Math.floor(hi + 1e-9); k++) {
      const v = Math.pow(10, k);
      if (v > min * (1 + 1e-9) && v < max * (1 - 1e-9)) decades.push(k);
    }
    if (decades.length > MAX_LOG_TICKS) {
      const n = decades.length;
      const picked = [];
      for (let i = 0; i < MAX_LOG_TICKS; i++) {
        picked.push(decades[Math.round(i * (n - 1) / (MAX_LOG_TICKS - 1))]);
      }
      decades = [...new Set(picked)];
    }
    if (decades.length > 0) {
      return decades.map(k => ({
        value: Math.pow(10, k),
        frac: (k - lo) / (hi - lo),
        label: formatDecadeTick(k),
      }));
    }
    // No clean decade strictly inside the range (e.g. 12 -> 130): fall
    // through to evenly-spaced-by-fraction ticks below.
  }
  // Sub-decade log range (or a >10x range with no clean decade inside it):
  // pick plain evenly-spaced-by-VALUE ticks (same numbers linear mode would
  // show — e.g. 0.25 for [0.2, 0.3]) rather than evenly-spaced-by-POSITION
  // ticks, whose *values* under log interpolation land on the geometric
  // mean (0.2449… -> "0.24" here) — correct for where that position falls
  // on a log-normalized bar, but a needlessly odd-looking number for a
  // range this narrow. Reposition each nice value at its true log-scale
  // fraction instead, so the tick still marks the right spot on the bar.
  const ticks = [];
  const lo = min > 0 ? Math.log10(min) : NaN;
  const hi = max > 0 ? Math.log10(max) : NaN;
  for (let i = 1; i <= INNER_TICKS; i++) {
    const linFrac = i / (INNER_TICKS + 1);
    const value = min + linFrac * (max - min);
    const frac = scale === 'log' && hi > lo
      ? (Math.log10(Math.max(value, LOG_EPS)) - lo) / (hi - lo)
      : linFrac;
    ticks.push({ value, frac, label: formatTick(value) });
  }
  return ticks;
}

const DEFAULT_BAR_LENGTH = 300; // canvas internal resolution, px
const MIN_BAR_LENGTH = 120;
const MAX_BAR_LENGTH = 700;
const THICKNESS = 36;
// Breathing room between the resize frame and the measured tick/legend
// content it encloses — shared by positionResizeHandle (the frame itself)
// and positionControlsStrip (which now aligns to that same frame rather
// than the bare bar, since the frame reads as the bar's actual boundary
// once it's floating), so the strip's width always matches the frame's.
const FRAME_PAD = 6;
// Tick/legend/min-max text sizes at DEFAULT_BAR_LENGTH, once floating —
// scaled by the same ratio as the bar's own length (ui/GizmoDrag.js's
// applyLegendScale does the same thing for the gizmo's legend), so a longer
// bar reads with bigger labels instead of the same fixed-size text just
// spread further apart. x1.2 (not the original size, but not the earlier
// x1.5 either — dialed back 20% after that read too large).
const TICK_LABEL_BASE_FONT = 16;
const LEGEND_BASE_FONT = 20;
const INPUT_BASE_FONT = 20;
// Docked bars ignore the above entirely (see fontScale()) — a fixed, quite
// a bit smaller size instead of the floating scale, since a resized floating
// bar sharing its length via general.colorBarSize would otherwise inflate a
// docked bar's text too even though it never actually grows to match (docked
// bars stretch to the panel row width, not barLength). These match the
// original sizes this widget used before floating bars got their own,
// larger scale.
const DOCKED_TICK_LABEL_FONT = 14;
const DOCKED_LEGEND_FONT = 14;
const DOCKED_INPUT_FONT = 14;
// Legend placement is fixed geometry, not measured off the rendered tick
// labels: this widget is often built while its panel is still `display:none`
// mid-expand, where every offsetTop/offsetHeight reads back as 0. x1.2,
// matching the floating *_BASE_FONT scale above — shared by both floating
// and docked (docked's smaller fixed text ends up with a little more
// breathing room than it strictly needs, simpler than a fully separate
// docked geometry set for a difference that's mostly invisible).
const TICK_LABEL_GAP = 6; // bar edge -> near edge of the tick label
const TICK_LABEL_SPAN_H = 22; // approx tick label height (horizontal mode)
const TICK_LABEL_SPAN_V = 34; // approx tick label width (vertical mode)
const LEGEND_GAP = 5; // tick label's far edge -> near edge of the legend
// Shown (dim, italic) in place of the legend when its text is empty — either
// the user cleared it, or nothing was ever typed — so there's still
// something on-screen to click to start typing again. Without this, an
// emptied legend went display:none along with its own click handler, and the
// user had no way back in.
const LEGEND_PLACEHOLDER = "Click to add legend";

// Min/Max are positioned like tick labels now (renderMinMax, at frac 0/1
// on the bar — the same row the numbers renderTicks() computes actually
// sit in), not a separate pair of boxes flanking the bar, so they need to
// be absolutely positioned rather than flex children.
const MINMAX_WIDTH = 46; // centered on the bar's own two ends, so half of this overhangs past each edge
// Everything about these inputs that never changes lives in the
// .cv-colorbar-value-input class (styles/sceneWidgets.css) — including the
// z-index reasoning (it has to clear resizeFrame's, see that class's own
// comment). Only fontSize/width (scaledFont/scaledInputWidth) and
// textAlign/position (orientation-dependent, applyLayout/positionMinMax)
// are ever actually recomputed, so they stay set from JS.

// Best-effort read of "the same feature the background swatch itself uses":
// general.currentLatticeColor is the live, contrast-safe color the app
// already computes against whatever the scene background actually is right
// now (theme-derived OR a manually-picked custom color — unlike the
// `--lattice-color` CSS token, which only tracks the theme). It's polymorphic
// (hex string or numeric THREE hex), so normalize through THREE.Color.
// Exported for render/ImageExportModule.js — see colorsFor above.
export function currentContrastColor() {
  const v = general.currentLatticeColor;
  if (v == null) return null;
  try {
    return `#${new THREE.Color(/** @type {any} */ (v)).getHexString()}`;
  } catch {
    return null;
  }
}

/**
 * @param {HTMLElement} container mount point; its children are replaced
 * @param {string} colormap initial colormap id
 * @param {number} minValue
 * @param {number} maxValue
 * @param {{ floatingId?: string, onLimitsCommit?: (min: number, max: number) => void,
 *   fallbackMin?: number, fallbackMax?: number, legend?: string, scale?: string,
 *   onScaleChange?: (scale: string) => void, onAutoRange?: () => void,
 *   onLegendChange?: (legend: string) => void, isScaleLocked?: () => boolean,
 *   orientation?: string, flipSide?: boolean, size?: number }} [opts]
 *   legend: axis title shown alongside the bar (e.g. "Force (eV/Å)"), rotated
 *   to read bottom-to-top when the bar is vertical. Click-to-edit: the raw
 *   text can contain a few HTML tags (<b>, <i>, <sup>, <sub>) and/or LaTeX/
 *   markdown-ish shorthand (**bold**, *italic*, ^{2}/^2, _{2}/_2) — see
 *   utils/LegendRichText.js for exactly what's recognized. scale: which
 *   formula the printed tick values follow — must match the colormap's own
 *   normalization.
 *   onScaleChange: called when the user toggles the menu's Log Scale item —
 *   the widget only owns how its OWN ticks are labeled (currentScale below);
 *   whatever colormap this bar is a legend for (Forces/Spins' actual scene
 *   coloring, arrow lengths) lives outside the widget entirely, so it needs
 *   this callback to stay in sync. Omit it (as Atoms/Bonds' bars do) and the
 *   menu item doesn't appear at all — there's nothing for it to drive.
 *   isScaleLocked: polled fresh every time the menu opens — when it returns
 *   true, the Log Scale item is disabled (can't be toggled off) instead of
 *   just calling onScaleChange. Forces/Spins pass this when their own "log
 *   length" toggle is on, since arrow length reads this same scale and a
 *   log-length arrow next to a linearly-colored one would be internally
 *   inconsistent about what a given magnitude looks like — the side panel's
 *   own Log Scale checkbox gets the identical lock, this is just the same
 *   rule reaching the OTHER place a user can flip it (the floating bar's own
 *   menu, reachable even when the side panel is collapsed).
 *   onAutoRange: called when the user picks the menu's Auto Range item — same
 *   reasoning as onScaleChange: the widget has no idea what data field it's
 *   even a legend for, so recomputing min/max from that data lives entirely
 *   with the caller. Omitting it hides the menu item.
 *   onLegendChange: called with the new raw legend text right after the user
 *   finishes editing it (blur/Enter) — a caller that wants the customization
 *   to survive a rebuild (colormap switch, panel reload) needs to persist it
 *   itself and pass it back in as `legend` next time; getSettings().legend
 *   also always reflects the current raw text if a caller would rather read
 *   it lazily right before tearing the widget down instead.
 *   orientation/flipSide/size: initial state, so a caller that tears down and
 *   rebuilds this widget (e.g. on a colormap switch) can carry over the
 *   user's current layout instead of resetting to horizontal/near-side/default
 *   length.
 */
export function createColorBar(container, colormap, minValue, maxValue, opts = {}) {
  const { floatingId, onLimitsCommit, onScaleChange, onAutoRange, onLegendChange, isScaleLocked = () => false, fallbackMin = 0, fallbackMax = 2, legend = '' } = opts;
  container.innerHTML = '';

  let orientation = opts.orientation === 'vertical' ? 'vertical' : 'horizontal';
  // Which side the tick labels + legend render on: false = the original/
  // default edge (below the bar horizontal, right of it vertical), true =
  // the opposite edge (above / left).
  let flipSide = !!opts.flipSide;
  let currentColormap = colormap;
  let currentScale = opts.scale || 'linear';
  // The bar's length along its own axis — only meaningful once floating
  // (docked horizontal bars stretch to fill the panel row instead; see
  // applyLayout). Resized via the drag handle at the bar's far end.
  let barLength = Math.min(Math.max(opts.size || DEFAULT_BAR_LENGTH, MIN_BAR_LENGTH), MAX_BAR_LENGTH);

  // display:flex row so the grip sits beside the bar (docked has nowhere
  // else useful to put it — orientation/simplify are floating-only). Once
  // floating, controlsBar goes position:absolute (styles/toggle_styles.css)
  // and drops out of this flow entirely, leaving valueRow to fill the row
  // alone exactly as before. margin-top/bottom aren't set here — the
  // applyLayout() call at the end of this function always sets both before
  // the widget ever paints, off the orientation/flipSide state that isn't
  // known yet at creation time.
  const wrapper = createElement("div", { class: "cv-colorbar-wrapper" });

  const controlsBar = createElement("div", { class: "cv-colorbar-controls" });
  // Bridges the CONTROLS_GAP dead zone between the frame's top edge and the
  // controls strip's own bottom edge (positioned alongside it, below) — see
  // positionControlsStrip for why that gap exists and why hovering across it
  // needs something hit-testable there. Deliberately just this thin sliver,
  // not the whole (large, mostly-empty) strip: making the entire strip
  // permanently pointer-events:auto so it stays reachable regardless of
  // :hover timing (a fix tried here previously) meant the invisible
  // controls strip - opacity 0 except while actively hovered - was always
  // live and could silently swallow clicks meant for whatever's underneath
  // it wherever the bar happened to be floating. This bridge keeps that
  // footprint to the minimum needed to keep the hover chain unbroken.
  const controlsBridge = createElement("div", { class: "cv-colorbar-controls-bridge" });
  // flex:1/min-width:0 (valueRow as a flex ITEM of wrapper) live in
  // sceneWidgets.css alongside .cv-colorbar-values' own display:flex rule
  // (toggle_styles.css, which governs valueRow as a flex CONTAINER for its
  // own children — a different axis, no overlap).
  const valueRow = createElement("div", { class: "cv-colorbar-values" });
  wrapper.appendChild(controlsBar);
  wrapper.appendChild(controlsBridge);
  wrapper.appendChild(valueRow);

  // Hamburger menu (floating-only, like the layout it replaced): Horizontal /
  // Vertical / Dock in one dropdown instead of three separate icon buttons.
  // menu is a sibling of menuBtn (not a child) — a <button> can't validly
  // contain other <button>s, which the menu items are.
  const menuWrap = createElement("div", { class: "cv-colorbar-menu-wrap" });
  const menuBtn = createElement("button", {
    type: "button", class: "cv-colorbar-menu-btn", title: "Layout options"
  }, {}, "☰");
  const menu = createElement("div", { class: "cv-colorbar-menu" });
  const menuHorizontal = createElement("button", {
    type: "button", class: "cv-colorbar-menu-item"
  }, {}, "Horizontal");
  const menuVertical = createElement("button", {
    type: "button", class: "cv-colorbar-menu-item"
  }, {}, "Vertical");
  const menuFlip = createElement("button", {
    type: "button", class: "cv-colorbar-menu-item"
  }, {}, "Flip Side");
  const menuLogScale = createElement("button", {
    type: "button", class: "cv-colorbar-menu-item"
  }, {}, "Log Scale");
  const menuAutoRange = createElement("button", {
    type: "button", class: "cv-colorbar-menu-item"
  }, {}, "Auto Range");
  const menuResetSize = createElement("button", {
    type: "button", class: "cv-colorbar-menu-item"
  }, {}, "Reset Size");
  const menuDock = createElement("button", {
    type: "button", class: "cv-colorbar-menu-item"
  }, {}, "Dock");
  menu.appendChild(menuHorizontal);
  menu.appendChild(menuVertical);
  menu.appendChild(menuFlip);
  menu.appendChild(menuLogScale);
  menu.appendChild(menuAutoRange);
  menu.appendChild(menuResetSize);
  menu.appendChild(menuDock);
  menuWrap.appendChild(menuBtn);
  menuWrap.appendChild(menu);

  controlsBar.appendChild(menuWrap);

  // position:relative lives on .cv-colorbar-bar-handle itself (sceneWidgets.css,
  // alongside the cursor:grab/grabbing rule that class already carries from
  // toggle_styles.css) — barOuter's own flex/width/height/margin vary with
  // orientation and floating state, so those stay set from applyLayout().
  const barOuter = createElement("div", { class: "cv-colorbar-bar-handle" });
  valueRow.appendChild(barOuter); // valueRow's only child now — Min/Max moved off it, see below
  const canvas = createElement("canvas", { class: "cv-colorbar-gradient-canvas" });
  const tickLayer = createElement("div", { class: "cv-colorbar-tick-layer" });
  barOuter.appendChild(canvas);
  barOuter.appendChild(tickLayer);

  // The legend is click-to-edit: a plain click swaps it into a raw-text
  // editing mode (contentEditable on the same node, so its position/rect
  // stay exactly where the layout math below already puts it — no separate
  // <input> to keep in sync), showing the currentLegendRaw markup for the
  // user to type over. Blur/Enter commits it back through
  // utils/LegendRichText.js's sanitizer+renderer. See beginLegendEdit /
  // commitLegendEdit below, wired up after positionLegend/relayoutFloating
  // exist to call them.
  // position/color/white-space/letter-spacing/cursor/outline are constant
  // (styles/sceneWidgets.css); display/opacity/font-style/font-size are all
  // reset unconditionally by refreshLegendContent()/positionLegend() below
  // before this ever paints, so they're not worth setting twice here.
  let currentLegendRaw = legend;
  const legendLabel = createElement("div", {
    class: "cv-colorbar-legend", spellcheck: "false", title: "Click to edit legend"
  });
  barOuter.appendChild(legendLabel);

  let legendEditing = false;

  // Always visible/clickable — even with no text — so the placeholder
  // itself is the way back in once the legend's been cleared. Real text
  // (currentLegendRaw) always wins over the placeholder when present. The
  // empty/placeholder state's opacity is driven by CSS (.cv-colorbar-legend-
  // empty, toggle_styles.css), not inline, since it needs a :hover rule —
  // invisible normally, faintly readable on hover, rather than a permanent
  // "Click to add legend" sitting on every bar with no legend right now.
  function refreshLegendContent() {
    legendLabel.style.display = "block";
    if (currentLegendRaw) {
      legendLabel.classList.remove("cv-colorbar-legend-empty");
      legendLabel.style.opacity = "0.85";
      legendLabel.style.fontStyle = "normal";
      applyLegendHtml(legendLabel, currentLegendRaw);
    } else {
      legendLabel.classList.add("cv-colorbar-legend-empty");
      legendLabel.style.opacity = "";
      legendLabel.style.fontStyle = "italic";
      legendLabel.textContent = LEGEND_PLACEHOLDER;
    }
  }
  refreshLegendContent();

  function beginLegendEdit() {
    if (legendEditing) return;
    legendEditing = true;
    legendLabel.style.display = "block";
    legendLabel.classList.remove("cv-colorbar-legend-empty");
    legendLabel.classList.add("cv-colorbar-legend-editing");
    legendLabel.style.opacity = "0.85";
    legendLabel.style.fontStyle = "normal";
    legendLabel.contentEditable = "true";
    legendLabel.textContent = currentLegendRaw;
    legendLabel.focus();
    const range = document.createRange();
    range.selectNodeContents(legendLabel);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  // commit=false (Escape) discards the edit and restores whatever was there
  // before; commit=true (blur/Enter) reads the raw markup back out of the
  // now-plain-text node and re-renders it through applyLegendHtml. Either
  // way positionLegend/relayoutFloating run afterward since the legend's
  // rendered size (and therefore the bar's own reserved margin/clearance —
  // see applyLayout's reservePx and legendHalfHeight) can have changed.
  function finishLegendEdit(commit) {
    if (!legendEditing) return;
    legendEditing = false;
    legendLabel.contentEditable = "false";
    legendLabel.classList.remove("cv-colorbar-legend-editing");
    if (commit) {
      const next = (legendLabel.textContent || '').trim();
      if (next !== currentLegendRaw) {
        currentLegendRaw = next;
        onLegendChange?.(currentLegendRaw);
      }
    }
    refreshLegendContent();
    applyLayout();
    render(currentColormap);
    relayoutFloating();
  }

  // Same reasoning as minInput/maxInput's own pointerdown stopPropagation
  // just below (barOuter is a whole-widget drag handle whose pointerdown
  // listener preventDefault()s unconditionally, which otherwise steals the
  // click-to-focus before it reaches this contentEditable div).
  legendLabel.addEventListener("pointerdown", (e) => e.stopPropagation());
  legendLabel.addEventListener("click", () => beginLegendEdit());
  legendLabel.addEventListener("blur", () => finishLegendEdit(true));
  legendLabel.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); legendLabel.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); finishLegendEdit(false); }
  });

  // Min/Max: positioned in renderMinMax (below) at frac 0/1 — exactly where
  // a tick label for the bar's own endpoints would sit, in the same row as
  // the numbers renderTicks() computes in between — rather than as a
  // separate pair of boxes flanking the bar. Children of barOuter (not
  // tickLayer, which renderTicks() wipes and rebuilds on every render —
  // that would destroy and recreate these on every value change, losing
  // focus/typing state mid-edit).
  const minInput = createElement("input", { type: "number", value: minValue, step: "0.1", class: "cv-colorbar-value-input" });
  const maxInput = createElement("input", { type: "number", value: maxValue, step: "0.1", class: "cv-colorbar-value-input" });
  barOuter.appendChild(minInput);
  barOuter.appendChild(maxInput);

  // Resize affordance: a frame around the bar's whole visual footprint
  // (color strip + tick labels + legend — sized/positioned in
  // positionResizeHandle below), purely decorative (pointer-events: none,
  // always — see toggle_styles.css), with a single grab handle at its far
  // corner (the end that grows: right in horizontal mode, top in vertical),
  // mirroring the PNG export crop tool's selection rectangle + corner
  // handle look. Sitting right at the frame's own corner — outside the
  // labeled content the frame encloses, not overlapping any of it — means
  // it can safely stay interactive on its own without the frame around it
  // needing to be too: an earlier version made the whole frame
  // pointer-events: auto so the gap between the bar and the handle stayed
  // continuously hoverable, but since the frame also encloses Min/Max and
  // sits under the controls strip, that ended up swallowing clicks meant
  // for both instead. Floating-only (styles/toggle_styles.css scopes both
  // to .cv-colorbar-floating) — docked horizontal bars stretch to fill the
  // panel row instead of having a length of their own to resize. handle is
  // a child of frame (not barOuter) so its CSS corner offsets (-11px etc.)
  // are relative to the frame's own box.
  const resizeFrame = createElement("div", { class: "cv-colorbar-resize-frame" });
  const resizeHandle = createElement("div", { class: "cv-colorbar-resize-handle" });
  resizeHandle.title = "Drag to resize";
  resizeFrame.appendChild(resizeHandle);
  barOuter.appendChild(resizeFrame);

  container.appendChild(wrapper);

  function fontScale() {
    return barLength / DEFAULT_BAR_LENGTH;
  }

  // Resolves a text size for whichever state the bar is actually in — docked
  // bars use a fixed, quite a bit smaller size (DOCKED_*_FONT), independent
  // of barLength: general.colorBarSize is shared with every other showing
  // bar (ColorBarWidget.js's setSize broadcast), so a docked bar can be
  // carrying a barLength some floating bar grew to even though it never
  // visually grows to match (docked bars stretch to the panel row's width
  // instead) — scaling its font off that value would make its text swell for
  // no visible reason. Floating bars keep the length-proportional scale.
  function scaledFont(baseFont, dockedFont) {
    const floating = dragCtl?.isFloating() ?? false;
    return floating ? baseFont * fontScale() : dockedFont;
  }

  // MINMAX_WIDTH's fixed 46px comfortably fits short values ("0", "2.5") at
  // the default size, but longer ones — more decimals, or scientific
  // notation like "1.00e-4" — clip inside that box once the bar's resized
  // bigger and the input's own font grows to match: the digits are still
  // THERE, just not all visible without scrolling the field. Scale the box
  // by the same factor AND measure the input's own current text (like
  // tickLabelSpanV — a long typed value needs more than just the scaled
  // default), once floating (docked bars stay at the small fixed
  // DOCKED_INPUT_FONT, so the default width is never actually too small for
  // them). A separate function from applyInputStyle (below), not folded into
  // it, so a plain Min/Max edit (onLimitsBlur -> renderTicks(), which needs
  // this re-run against the newly typed text) can call just this without
  // also resetting textAlign back to plainInputStyle's default "center" —
  // applyLayout's own vertical-mode left/right alignment wouldn't get
  // reapplied on that path, unlike here where applyLayout always runs
  // before renderTicks in every OTHER caller.
  function scaledInputWidth(input) {
    if (!(dragCtl?.isFloating() ?? false)) return `${MINMAX_WIDTH}px`;
    const fontPx = scaledFont(INPUT_BASE_FONT, DOCKED_INPUT_FONT);
    measureCtx.font = `${fontPx}px 'CrysViz Sans', sans-serif`;
    const textWidth = measureCtx.measureText(input.value || '').width;
    return `${Math.max(MINMAX_WIDTH * fontScale(), textWidth + 14)}px`;
  }

  function applyInputStyle(input) {
    // Constant chrome lives in .cv-colorbar-value-input (sceneWidgets.css);
    // only the length-scaled size actually varies per call.
    input.style.fontSize = `${scaledFont(INPUT_BASE_FONT, DOCKED_INPUT_FONT)}px`;
    input.style.width = scaledInputWidth(input);
  }

  // Off-DOM canvas for text-width measurement — unlike offsetWidth on the
  // actual rendered tick labels, ctx.measureText doesn't depend on layout
  // having happened (no `display:none` mid-expand pitfall, see
  // positionLegend's own comment below), so this is safe to use even before
  // the widget is visible.
  const measureCtx = document.createElement('canvas').getContext('2d');

  // Vertical mode's tick labels sit beside the bar rather than below it, so
  // positionLegend needs to know how far out they actually reach before it
  // can clear the legend title past them — TICK_LABEL_SPAN_V is only a
  // fallback for when there's no valid range yet to measure against.
  // Widest-current-tick-text, not just the current font size: a bar showing
  // "0.5"/"1"/"1.5" needs far less clearance than the same bar in log scale
  // showing "1.00e-4"/"1.00e2", and a fixed constant can't tell those apart.
  function tickLabelSpanV() {
    const min = parseFloat(minInput.value);
    const max = parseFloat(maxInput.value);
    if (!isFinite(min) || !isFinite(max) || min >= max) return TICK_LABEL_SPAN_V;
    measureCtx.font = `${scaledFont(TICK_LABEL_BASE_FONT, DOCKED_TICK_LABEL_FONT)}px 'CrysViz Sans', sans-serif`;
    let widest = TICK_LABEL_SPAN_V;
    for (const { label } of computeTicks(min, max, currentScale)) {
      widest = Math.max(widest, measureCtx.measureText(label).width);
    }
    return widest;
  }

  // Vertical mode's legend rotates -90deg around its own pre-rotation
  // center, then gets translateX/Y(-50%)'d back so that center lands
  // exactly on the `left: offset` anchor point (positionLegend's own
  // comment) — meaning the anchor is the legend's CENTER once rendered,
  // not its near edge like the offset formula otherwise assumes. Its
  // rendered (rotated) footprint reaches back toward the bar by half of
  // its own PRE-rotation height (a single text line's height, at the
  // legend's own scaled font size) from that center point — left
  // unaccounted for, that half-height eats directly into whatever
  // clearance tickLabelSpanV()/legendGap reserved past the tick labels, and
  // grows right along with them as the bar (and the legend's font) is
  // resized bigger, which is what actually made bigger floating bars
  // overlap even though the tick-clearing math above looked right.
  function legendHalfHeight() {
    const fontPx = scaledFont(LEGEND_BASE_FONT, DOCKED_LEGEND_FONT);
    measureCtx.font = `${fontPx}px 'CrysViz Sans', sans-serif`;
    const m = measureCtx.measureText(legendPlainText(currentLegendRaw) || LEGEND_PLACEHOLDER);
    const ascent = m.actualBoundingBoxAscent || fontPx * 0.8;
    const descent = m.actualBoundingBoxDescent || fontPx * 0.2;
    return (ascent + descent) / 2;
  }

  // Horizontal mode still uses fixed geometry (TICK_LABEL_SPAN_H) rather
  // than measuring: this widget is frequently built while its host panel is
  // still `display:none` mid-expand (docked panels build lazily on first
  // reveal), where every offsetTop/offsetWidth reads back as 0 — so an
  // offsetWidth-based measure-then-place approach would silently stack the
  // legend on top of the bar instead of below it. Vertical is floating-only
  // (never docked, never hidden mid-expand), and tickLabelSpanV() above
  // measures via canvas rather than offsetWidth specifically to sidestep
  // this, so it doesn't have the same constraint.
  function positionLegend() {
    legendLabel.style.fontSize = `${scaledFont(LEGEND_BASE_FONT, DOCKED_LEGEND_FONT)}px`;
    const horizontal = orientation === 'horizontal';
    // TICK_LABEL_SPAN_V is a fallback approximation of the tick labels'
    // rendered WIDTH in vertical mode (they sit beside the bar, not below
    // it) — tickLabelSpanV() below measures the actual current tick text at
    // the actual current font size instead, since both vary: font size
    // with fontScale() as the bar is resized, and text width with the
    // tick values themselves (scientific notation like "1.00e-3" is much
    // wider than "0.5"). Using the fixed constant for either routinely
    // overflowed it, overlapping the legend title beside it. Horizontal is
    // unaffected: TICK_LABEL_SPAN_H measures label HEIGHT there, which
    // barely varies the way WIDTH does for vertical's SPAN, and horizontal
    // wasn't reported as overlapping.
    const span = horizontal ? TICK_LABEL_SPAN_H : tickLabelSpanV();
    // A little extra breathing room as the tick font itself grows, on top
    // of just fitting the wider text above — matches how tick font size
    // scales with the bar (fontScale()).
    const legendGap = horizontal ? LEGEND_GAP : LEGEND_GAP * fontScale();
    const halfHeight = horizontal ? 0 : legendHalfHeight();
    const offset = `calc(100% + ${TICK_LABEL_GAP + span + legendGap + halfHeight}px)`;
    if (horizontal) {
      legendLabel.style.left = "50%";
      legendLabel.style.right = "";
      legendLabel.style.top = flipSide ? "" : offset;
      legendLabel.style.bottom = flipSide ? offset : "";
      legendLabel.style.transform = "translateX(-50%)";
      legendLabel.style.transformOrigin = "";
    } else {
      legendLabel.style.top = "50%";
      legendLabel.style.bottom = "";
      legendLabel.style.left = flipSide ? "" : offset;
      legendLabel.style.right = flipSide ? offset : "";
      // legendLabel is a wide `nowrap` box before rotation; rotating it
      // -90deg around its default center pivot leaves its rendered (now
      // vertical) footprint centered on that same point, which sits
      // offsetWidth/2 PAST the `left`/`right` anchor above — in the
      // direction the box's own local (0,0) is offset from that anchor,
      // which is opposite for `left` vs. `right` positioning (a `left`
      // anchor IS local (0,0); a `right` anchor sits width-to-the-right of
      // it, at local (0,0) = anchor - width). Uncorrected, the whole
      // rotated text visibly lands offsetWidth/2 further out than the
      // offset intends, growing with the legend text's length — this is
      // what the "37px offset" actually looked like on screen (well past
      // 70px on a long legend name), and, unfixed for the `right`-anchored
      // (flipSide) case specifically even after that fix, what flipping to
      // the labels' other side was still doing. translateX(±50%) —
      // evaluated, like translateY, against the element's own un-rotated
      // width regardless of where it sits in the transform list or what
      // it's combined with — corrects exactly that offsetWidth/2, in
      // whichever direction the anchor side calls for, without touching
      // transform-origin (which also has to stay untouched for the box's
      // actual center, not some other point, to land on the vertically-
      // centered `top: 50%` anchor after rotation).
      legendLabel.style.transformOrigin = "";
      legendLabel.style.transform = flipSide
        ? "translateX(50%) translateY(-50%) rotate(-90deg)"
        : "translateX(-50%) translateY(-50%) rotate(-90deg)";
    }
  }

  // How far the tick labels + legend (whichever side flipSide put them on)
  // actually extend beyond barOuter's own box, in each direction — measured
  // off their real rendered rects rather than guessed from a fixed reserve,
  // so it tracks whatever's actually on screen (docked's smaller fixed font
  // vs. floating's length-scaled one, a long vs. short legend name, however
  // many px the current tick text needs) instead of a static number that
  // either overshoots (a big gap between the frame and the text) or
  // undershoots (the frame not reaching the text at all).
  function labeledExtent() {
    const barRect = barOuter.getBoundingClientRect();
    const rects = Array.from(tickLayer.querySelectorAll('.cv-colorbar-tick-label')).map((el) => el.getBoundingClientRect());
    rects.push(minInput.getBoundingClientRect(), maxInput.getBoundingClientRect());
    rects.push(legendLabel.getBoundingClientRect()); // always visible now — see refreshLegendContent
    if (!rects.length) return { top: 0, bottom: 0, left: 0, right: 0 };
    return {
      top: Math.max(0, barRect.top - Math.min(...rects.map((r) => r.top))),
      bottom: Math.max(0, Math.max(...rects.map((r) => r.bottom)) - barRect.bottom),
      left: Math.max(0, barRect.left - Math.min(...rects.map((r) => r.left))),
      right: Math.max(0, Math.max(...rects.map((r) => r.right)) - barRect.right),
    };
  }

  // The resize frame's rect in screen coordinates — barOuter's own box
  // expanded by labeledExtent() + FRAME_PAD on every side. The single
  // source both positionResizeHandle (which draws the frame) and
  // positionControlsStrip (which aligns the hover strip to it, now that
  // the frame — not the bare color strip — reads as the bar's actual
  // visual boundary once floating) size themselves against, so the two
  // always agree on where "the bar" is.
  function frameRect() {
    const barRect = barOuter.getBoundingClientRect();
    const ext = labeledExtent();
    return {
      left: barRect.left - ext.left - FRAME_PAD,
      top: barRect.top - ext.top - FRAME_PAD,
      width: barRect.width + ext.left + ext.right + FRAME_PAD * 2,
      height: barRect.height + ext.top + ext.bottom + FRAME_PAD * 2,
    };
  }

  const CONTROLS_GAP = 8; // frame's top edge -> bottom edge of the controls strip

  // Matches the hover-revealed controls strip's width/position to the
  // resize frame (CSS handles the docked case — .cv-colorbar-controls sits
  // in normal flex flow beside the bar there, no absolute positioning to
  // compute) — the full frame width in both orientations now (vertical used
  // to only center over the frame's midpoint at an auto width, since the
  // bare bar is only THICKNESS px wide, too narrow to anchor the strip's
  // width to — the frame doesn't have that problem, it's already however
  // wide the labeled content needs). `top` is computed here too, not left
  // to CSS's fixed -34px: that was measured against the bare bar, and once
  // Min/Max moved onto the bar itself (positionMinMax) vertical mode's
  // frame can extend upward past a fixed offset — the strip and frame
  // overlapping instead of clearing it. Reads frameRect(), so — like
  // positionResizeHandle below — this has to run after renderTicks() has
  // (re)built the current tick labels, hence it's called from the end of
  // render() (and again from relayoutFloating(), after a resize or
  // orientation switch settles the wrapper's own final size/position —
  // these offsets are expressed relative to wrapper's edges, which that can
  // move), not from inside applyLayout() like it used to be.
  function positionControlsStrip() {
    if (!dragCtl?.isFloating()) {
      controlsBar.style.left = '';
      controlsBar.style.right = '';
      controlsBar.style.width = '';
      controlsBar.style.top = '';
      controlsBar.style.bottom = '';
      controlsBridge.style.left = '';
      controlsBridge.style.width = '';
      controlsBridge.style.bottom = '';
      controlsBridge.style.height = '';
      return;
    }
    const frame = frameRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const left = `${frame.left - wrapperRect.left}px`;
    const width = `${frame.width}px`;
    const gapBottom = wrapperRect.bottom - frame.top; // frame's own top edge, wrapper-bottom-relative
    controlsBar.style.left = left;
    controlsBar.style.right = 'auto';
    controlsBar.style.width = width;
    controlsBar.style.top = 'auto';
    controlsBar.style.bottom = `${gapBottom + CONTROLS_GAP}px`;
    controlsBridge.style.left = left;
    controlsBridge.style.width = width;
    controlsBridge.style.bottom = `${gapBottom}px`;
    controlsBridge.style.height = `${CONTROLS_GAP}px`;
  }

  const RESIZE_HANDLE_CORNERS = ['nw', 'ne', 'sw', 'se'];

  // Sizes resizeFrame to enclose the bar's whole visual footprint (color
  // strip + tick labels + legend, wherever those land — labeledExtent,
  // above) and puts the single resizeHandle at whichever of its corners
  // sits on the labeled side (flipSide) AND the bottom (vertical) or right
  // (horizontal) — the corner nearest the numbers it's next to, and (since
  // it sits right at the frame's own corner) outside the labeled content
  // itself, not overlapping Min/Max or the ticks. Bottom for vertical, not
  // top: dragging a corner further away from the bar body reads as
  // "growing" it regardless of orientation (bindResizeHandle's delta signs
  // match), so the handle sits at the end you'd naturally pull outward from,
  // the same "bottom-right, drag away" grip a resize cursor anywhere else
  // uses — not the far/max end of the value axis. Reads the tick labels'
  // actual rendered rects, so it must run after renderTicks() has (re)built
  // them for the current layout — called from the end of render(), not
  // applyLayout() (which runs BEFORE renderTicks() in every caller, when
  // the old tick labels, if any, are still the ones from the PREVIOUS
  // render).
  function positionResizeHandle() {
    if (!dragCtl?.isFloating()) {
      resizeFrame.style.top = '';
      resizeFrame.style.bottom = '';
      resizeFrame.style.left = '';
      resizeFrame.style.right = '';
      return;
    }
    const horizontal = orientation === 'horizontal';
    const ext = labeledExtent();
    resizeFrame.style.top = `${-(ext.top + FRAME_PAD)}px`;
    resizeFrame.style.bottom = `${-(ext.bottom + FRAME_PAD)}px`;
    resizeFrame.style.left = `${-(ext.left + FRAME_PAD)}px`;
    resizeFrame.style.right = `${-(ext.right + FRAME_PAD)}px`;

    const corner = horizontal
      ? (flipSide ? 'ne' : 'se')
      : (flipSide ? 'sw' : 'se');
    for (const c of RESIZE_HANDLE_CORNERS) {
      resizeHandle.classList.toggle(`cv-colorbar-resize-handle-${c}`, c === corner);
    }
  }

  function applyLayout() {
    const horizontal = orientation === 'horizontal';
    const floating = dragCtl?.isFloating() ?? false;
    // Docked horizontal bars stretch to fill the panel row instead of
    // having a length of their own to resize; every other case (floating
    // horizontal, or vertical — which is floating-only anyway) does.
    const fixedLength = floating || !horizontal;
    // The hover-revealed controls strip spans the full bar width in
    // horizontal mode (the bar is wide, so a full-width strip guarantees
    // whichever part of it the pointer approaches from still leads into the
    // strip). Vertical mode inverts that: the bar itself is narrow (just
    // THICKNESS px) while the strip's buttons need much more room than that,
    // so pinning it to the bar's width let the buttons overflow past their
    // own box and paint disconnected from the bar below. cv-colorbar-vertical
    // (styles/toggle_styles.css) switches the strip to shrink-to-fit and
    // center over the bar instead.
    wrapper.classList.toggle('cv-colorbar-vertical', !horizontal);

    valueRow.style.width = horizontal ? "100%" : "auto";
    // Reserve room for the tick row and the legend title beyond it — below
    // the bar by default, above it when flipped; vertical mode puts both to
    // the side instead, needing no extra margin either way. The legend row
    // is always shown now (real text or the click-to-add placeholder — see
    // refreshLegendContent), so this no longer varies with whether there's
    // currently text in it.
    const reservePx = 84;
    wrapper.style.marginBottom = horizontal && !flipSide ? `${reservePx}px` : "9px";
    wrapper.style.marginTop = horizontal && flipSide ? `${reservePx}px` : "9px";

    // Docked horizontal bars stretch to fill the panel row (flex:1, no
    // length of their own). Floating bars, either orientation, are a fixed,
    // user-resizable length instead (the drag handle at the bar's far end).
    barOuter.style.flex = fixedLength ? "0 0 auto" : "1";
    barOuter.style.minWidth = "0";
    barOuter.style.width = horizontal ? (fixedLength ? `${barLength}px` : "auto") : `${THICKNESS}px`;
    barOuter.style.height = horizontal ? `${THICKNESS}px` : `${barLength}px`;
    // Min/Max are centered ON the bar's own two ends (positionMinMax) and
    // overhang MINMAX_WIDTH/2 past each edge — floating bars have the whole
    // scene to grow into, so that overhang costs nothing, but a docked bar
    // stretches to fill the panel row's exact width with no slack, so the
    // overhang would run past the panel's edge and get clipped/overflow
    // (most visibly Max, since Min's usual "0" is narrow enough to often
    // still fit). Shrink the bar itself to leave that room instead.
    // (!fixedLength only happens for docked+horizontal — see its own
    // definition above.)
    barOuter.style.marginLeft = !fixedLength ? `${MINMAX_WIDTH / 2}px` : "0";
    barOuter.style.marginRight = !fixedLength ? `${MINMAX_WIDTH / 2}px` : "0";

    canvas.width = horizontal ? (fixedLength ? barLength : DEFAULT_BAR_LENGTH) : THICKNESS;
    canvas.height = horizontal ? THICKNESS : barLength;
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    applyInputStyle(minInput);
    applyInputStyle(maxInput);
    // Horizontal: the input's fixed-width box is centered ON the bar's own
    // edge (positionMinMax's translateX(-50%)), so centering the text
    // within that box is what keeps the digits themselves centered on the
    // edge too. Vertical doesn't center the box the same way — it's flush
    // against the bar at tickOffset (left edge at that x when !flipSide,
    // right edge when flipped — positionMinMax again), matching how the
    // plain tick labels next to it are unstyled/naturally left-aligned —
    // so centering the TEXT within the box left an odd gap between the bar
    // and where the digits actually started rendering, instead of lining
    // up with the tick numbers right above/below it. Align to whichever
    // edge of the box is actually flush against the bar.
    const minMaxAlign = horizontal ? "center" : (flipSide ? "right" : "left");
    minInput.style.textAlign = minMaxAlign;
    maxInput.style.textAlign = minMaxAlign;
    positionLegend();
    // positionControlsStrip()/positionResizeHandle()/renderMinMax() run
    // later, from render() — see positionControlsStrip's own comment.
    // valueRow's only child is barOuter now (Min/Max moved off it onto the
    // bar itself, see their creation comment) — nothing left to reorder
    // here the way orientation switches used to require.
  }

  // Toggling orientation changes the bar's natural size, but a floated
  // widget has a fixed inline width pinned from the last drop —
  // without clearing it first the new layout renders squeezed into the old
  // box (visibly offset, especially switching to vertical). Re-measure and
  // re-clamp against the scene bounds around the same anchor point instead.
  // Re-measures the wrapper's width (grown/shrunk along with barOuter) and
  // re-derives its position from the anchor already captured for it — NOT
  // dragCtl.floatAt(), which re-floats from scratch (reparents to body,
  // fires onFloatChange -> a second full applyLayout()+render()) and was,
  // called from every pointermove of a resize drag times every currently
  // showing bar (setSize's broadcast), the main reason resizing felt laggy.
  function relayoutFloating() {
    if (!dragCtl?.isFloating()) return;
    wrapper.style.width = '';
    wrapper.style.width = `${wrapper.offsetWidth || 260}px`;
    dragCtl.reapplyAnchor();
    // positionControlsStrip's `left` is a snapshot pixel offset from
    // wrapper's own edge, not barOuter-relative like positionResizeHandle's
    // (that one's a child of barOuter itself, so it tracks automatically) —
    // clearing/re-measuring wrapper's width just above can shift where
    // barOuter actually sits inside it (vertical mode right-aligns onto
    // wrapper's own box via flex, so a wrapper narrower or wider than its
    // snapshot moves that alignment), leaving the strip stranded wherever it
    // was computed for the pre-reflow width instead of the settled one.
    positionControlsStrip();
  }

  // Undocked, text has no opaque box of its own to lean on, so it borrows
  // the same contrast-safe color the app already picks for the scene
  // background swatch itself. general.currentLatticeColor can change from
  // many places (theme switch, live color-picker drag, auto day/night) with
  // no shared change event, so this polls once per frame — cheap, and only
  // runs while the bar is actually floating over the scene.
  let contrastRafId = null;
  function tickContrast() {
    wrapper.style.color = currentContrastColor() || '';
    contrastRafId = requestAnimationFrame(tickContrast);
  }
  function startContrastSync() {
    if (contrastRafId != null) return;
    tickContrast();
  }
  function stopContrastSync() {
    if (contrastRafId != null) cancelAnimationFrame(contrastRafId);
    contrastRafId = null;
    wrapper.style.color = '';
  }

  // Min/Max sit exactly where a tick label for the bar's own two endpoints
  // would (frac 0 and 1) — same formula renderTicks() below uses for the
  // computed ticks between them, just without a loop since there's always
  // exactly one of each. Positioned unconditionally, even with an
  // in-progress invalid range (renderTicks() bails out before drawing
  // anything in that case) — they're the editable source of that range, so
  // they need to stay visible and in place for the user to fix it.
  function positionMinMax() {
    const horizontal = orientation === 'horizontal';
    const tickOffset = `calc(100% + ${TICK_LABEL_GAP}px)`;
    [[minInput, 0], [maxInput, 1]].forEach(([input, frac]) => {
      // Re-measured on every call (not just from applyInputStyle) so typing
      // a longer value — onLimitsBlur/onLimitsChange re-render via
      // renderTicks() -> here, without an applyLayout() in between — widens
      // the box to keep pace instead of clipping until the next layout pass.
      input.style.width = scaledInputWidth(input);
      if (horizontal) {
        input.style.left = `${frac * 100}%`;
        input.style.right = '';
        input.style.top = flipSide ? '' : tickOffset;
        input.style.bottom = flipSide ? tickOffset : '';
        input.style.transform = 'translateX(-50%)';
      } else {
        const topFrac = 1 - frac; // max is at the top, like the other ticks
        input.style.top = `${topFrac * 100}%`;
        input.style.bottom = '';
        input.style.left = flipSide ? '' : tickOffset;
        input.style.right = flipSide ? tickOffset : '';
        input.style.transform = 'translateY(-50%)';
      }
    });
  }

  function renderTicks() {
    positionMinMax();
    // tickLabelSpanV() (positionLegend, vertical mode) needs the actual
    // current tick text to size the legend's clearance against — min/max
    // typed directly into the inputs re-renders via this function alone
    // (onLimitsBlur/onLimitsChange), without going through applyLayout()
    // first, so positionLegend has to be re-run from here too or it keeps
    // sizing against whatever range was in effect the last time
    // applyLayout() ran instead of what just got typed.
    positionLegend();
    tickLayer.innerHTML = '';
    const horizontal = orientation === 'horizontal';
    const min = parseFloat(minInput.value);
    const max = parseFloat(maxInput.value);
    if (!isFinite(min) || !isFinite(max) || min >= max) return;

    const ticks = computeTicks(min, max, currentScale);
    const tickFontSize = `${scaledFont(TICK_LABEL_BASE_FONT, DOCKED_TICK_LABEL_FONT)}px`;
    ticks.forEach(({ frac, label: text }) => {
      const line = createElement("div", { class: "cv-colorbar-tick-line" });
      // position/color/white-space are constant (sceneWidgets.css); fontSize
      // is the length-scaled size (scaledFont), recomputed per render.
      const label = createElement("div", { class: "cv-colorbar-tick-label" }, {
        fontSize: tickFontSize,
      }, text);

      const tickOffset = `calc(100% + ${TICK_LABEL_GAP}px)`;
      if (horizontal) {
        line.style.left = `${frac * 100}%`;
        line.style.top = "0";
        line.style.bottom = "0";
        line.style.width = "1px";
        label.style.left = `${frac * 100}%`;
        label.style.top = flipSide ? "" : tickOffset;
        label.style.bottom = flipSide ? tickOffset : "";
        label.style.transform = "translateX(-50%)";
      } else {
        const topFrac = 1 - frac; // max is at the top
        line.style.top = `${topFrac * 100}%`;
        line.style.left = "0";
        line.style.right = "0";
        line.style.height = "1px";
        label.style.top = `${topFrac * 100}%`;
        label.style.left = flipSide ? "" : tickOffset;
        label.style.right = flipSide ? tickOffset : "";
        label.style.transform = "translateY(-50%)";
      }
      tickLayer.appendChild(line);
      tickLayer.appendChild(label);
    });
  }

  function render(cmap, scale) {
    currentColormap = cmap;
    if (scale) currentScale = scale;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const colors = colorsFor(cmap);
    const horizontal = orientation === 'horizontal';
    const grad = horizontal
      ? ctx.createLinearGradient(0, 0, canvas.width, 0)
      : ctx.createLinearGradient(0, canvas.height, 0, 0); // bottom (min) -> top (max)
    const step = Math.max(1, Math.floor(colors.length / 20));

    for (let i = 0; i < colors.length; i += step) {
      // getHexString(), not manual r*255 truncation: these THREE.Color
      // objects store their sRGB appearance internally as linear (color
      // management) — truncating .r/.g/.b directly skips that conversion
      // and paints a bar that doesn't match what the same colormap+value
      // renders as on the atoms/bonds/forces/spins it's the legend for.
      grad.addColorStop(i / colors.length, `#${colors[i].getHexString()}`);
    }

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    renderTicks();
    // Both read the tick labels renderTicks() just (re)built, so they have
    // to run after them — see positionControlsStrip's own comment.
    positionControlsStrip();
    positionResizeHandle();
  }

  function onLimitsChange(e) {
    e.stopPropagation();
    renderTicks();
  }

  function onLimitsBlur() {
    let min = parseFloat(minInput.value);
    let max = parseFloat(maxInput.value);

    // Only overwrite the input's own text when a fallback actually kicks
    // in — reassigning .value to the parsed number otherwise would
    // re-stringify it through JS's own number formatting, silently
    // dropping scientific notation the user typed (e.g. "2e-3" would come
    // back as "0.002") even though the value committed is identical.
    if (isNaN(min) || minInput.value === "") { min = fallbackMin; minInput.value = min; }
    if (isNaN(max) || maxInput.value === "") { max = fallbackMax; maxInput.value = max; }
    if (min >= max) {
      min = fallbackMin;
      max = fallbackMax;
      minInput.value = min;
      maxInput.value = max;
    }

    renderTicks();
    onLimitsCommit?.(min, max);
  }

  function onLimitsKeyDown(e) {
    if (e.key === "Enter") onLimitsBlur();
  }

  minInput.addEventListener("input", onLimitsChange);
  maxInput.addEventListener("input", onLimitsChange);
  minInput.addEventListener("blur", onLimitsBlur);
  maxInput.addEventListener("blur", onLimitsBlur);
  minInput.addEventListener("keydown", onLimitsKeyDown);
  maxInput.addEventListener("keydown", onLimitsKeyDown);
  // barOuter is itself a whole-widget drag handle (ColorBarDrag.js's
  // extraHandles: [barOuter]) — its pointerdown listener calls
  // preventDefault() unconditionally (before it even knows whether a real
  // drag is starting), and Min/Max are its descendants now, so their own
  // pointerdown bubbles up into that listener too. preventDefault() on
  // pointerdown suppresses the browser's default click-to-focus behavior,
  // so clicking either input visibly landed on it (elementFromPoint agreed)
  // but never actually focused it — the click was "stolen" by the drag
  // handle before it could take effect. stopPropagation (not
  // preventDefault, which would also block the input's own normal
  // behavior) keeps it from ever reaching that listener.
  minInput.addEventListener("pointerdown", (e) => e.stopPropagation());
  maxInput.addEventListener("pointerdown", (e) => e.stopPropagation());

  function setOrientation(next) {
    orientation = next;
    applyLayout();
    render(currentColormap);
    relayoutFloating();
  }

  function closeMenu() {
    menu.classList.remove('cv-colorbar-menu-open');
  }

  // Vertical only makes sense once undocked (there's no room for a tall bar
  // in the docked panel's fixed-width column); Dock only makes sense once
  // there's actually somewhere to dock back to. Reset Size is the same —
  // docked bars stretch to fill the panel row (applyLayout's fixedLength),
  // ignoring barLength entirely, so there's nothing for it to reset. Flip
  // Side, Log Scale and Auto Range have no such constraint — they work the
  // same docked or floating. Log Scale/Auto Range only appear at all if the
  // caller passed onScaleChange/onAutoRange — without them there's nothing
  // outside the widget for the toggle/action to actually drive (see the
  // opts doc comment).
  function updateMenuState() {
    const floating = dragCtl?.isFloating() ?? false;
    menuHorizontal.classList.toggle('cv-colorbar-menu-item-active', orientation === 'horizontal');
    menuVertical.classList.toggle('cv-colorbar-menu-item-active', orientation === 'vertical');
    menuVertical.disabled = !floating;
    menuVertical.title = floating ? '' : 'Drag the bar into the scene to use a vertical layout';
    menuFlip.classList.toggle('cv-colorbar-menu-item-active', flipSide);
    menuLogScale.style.display = onScaleChange ? '' : 'none';
    menuLogScale.classList.toggle('cv-colorbar-menu-item-active', currentScale === 'log');
    const scaleLocked = isScaleLocked();
    menuLogScale.disabled = scaleLocked;
    menuLogScale.title = scaleLocked ? '"log length" requires Log Scale — turn it off first to change this' : '';
    menuAutoRange.style.display = onAutoRange ? '' : 'none';
    menuResetSize.style.display = floating ? '' : 'none';
    menuDock.style.display = floating ? '' : 'none';
  }

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = !menu.classList.contains('cv-colorbar-menu-open');
    if (opening) updateMenuState();
    menu.classList.toggle('cv-colorbar-menu-open', opening);
  });
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains('cv-colorbar-menu-open')) return;
    if (!menuWrap.contains(/** @type {Node} */ (e.target))) closeMenu();
  });

  menuHorizontal.addEventListener("click", (e) => {
    e.stopPropagation();
    setOrientation('horizontal');
    closeMenu();
  });
  menuVertical.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menuVertical.disabled) return;
    setOrientation('vertical');
    closeMenu();
  });
  menuFlip.addEventListener("click", (e) => {
    e.stopPropagation();
    flipSide = !flipSide;
    applyLayout();
    render(currentColormap);
    relayoutFloating();
    closeMenu();
  });
  menuLogScale.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!onScaleChange || menuLogScale.disabled) return;
    currentScale = currentScale === 'log' ? 'linear' : 'log';
    // Re-renders this bar's own ticks against the new scale immediately;
    // onScaleChange is what actually re-normalizes the scene's colors/arrow
    // lengths to match — the widget has no reach into that itself.
    render(currentColormap);
    relayoutFloating();
    onScaleChange(currentScale);
    closeMenu();
  });
  menuAutoRange.addEventListener("click", (e) => {
    e.stopPropagation();
    onAutoRange?.();
    closeMenu();
  });
  menuResetSize.addEventListener("click", (e) => {
    e.stopPropagation();
    // Same broadcast the resize handle's drag uses (ColorBarRegistry.js) —
    // every currently-showing bar resets together, not just this one.
    general.colorBarSize = DEFAULT_BAR_LENGTH;
    for (const bar of listActiveColorBars()) bar.instance.setSize?.(DEFAULT_BAR_LENGTH);
    closeMenu();
  });
  menuDock.addEventListener("click", (e) => {
    e.stopPropagation();
    dragCtl?.dockBack();
    closeMenu();
  });

  // Defined before the first applyLayout() call below (which reads
  // dragCtl?.isFloating() to size the bar) — makeColorBarDraggable only
  // wires up event listeners at this point, none of which depend on layout
  // having already run.
  const dragCtl = floatingId
    ? makeColorBarDraggable(wrapper, floatingId, {
      gripParent: controlsBar,
      extraHandles: [barOuter],
      onFloatChange: (floating) => {
        closeMenu();
        // Orientation is hidden once docked (CSS), so leaving it vertical
        // from the bar's time in the scene would strand the docked panel in
        // a state with no control to undo it.
        if (!floating && orientation !== 'horizontal') {
          orientation = 'horizontal';
        }
        applyLayout();
        if (floating) startContrastSync(); else stopContrastSync();
        render(currentColormap);
      },
    })
    : null;

  // Resize handle: drag to change the bar's length. Every currently-showing
  // color bar (Forces/Spins/Atoms/Bonds — ui/ColorBarRegistry.js) is kept at
  // the same length, live during the drag, not just this one — resizing any
  // one of them resizes them all, since they're meant to read as one
  // consistent legend system rather than four independently-sized widgets.
  resizeHandle.addEventListener('pointerdown', (e) => {
    if (!dragCtl?.isFloating()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeHandle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startLength = barLength;
    const horizontalAtStart = orientation === 'horizontal';
    // Both grow toward the end the handle sits at (bottom-right): the
    // intent is for the bar's own top-left corner to stay fixed on screen
    // as barLength grows, so dragging the handle further right/down — away
    // from that fixed corner — is what visually "pulls the bar bigger"
    // instead of fighting it. That corner isn't actually anchored by
    // anything on its own, though — setSize() -> relayoutFloating() ->
    // reapplyAnchor() re-derives left/top from ColorBarDrag.js's captured
    // anchor, which tracks whichever of #view's edges (top/bottom,
    // left/right) was CLOSER at drop time, not necessarily top/left. When
    // it's bottom or right, growing the bar pushes the anchored edge's
    // opposite corner — i.e. exactly the "fixed" top-left corner — the
    // other way instead, which visibly drifts the bar (and can push its
    // top tick label above #view's own top edge, clipped) as it grows.
    // Pin the wrapper's own top-left explicitly for the duration of this
    // drag instead of trusting the anchor to land there; recaptureAnchor()
    // at drag end re-syncs so a later #view resize behaves normally again.
    const marginLeft = parseFloat(getComputedStyle(wrapper).marginLeft) || 0;
    const marginTop = parseFloat(getComputedStyle(wrapper).marginTop) || 0;
    const startRect = wrapper.getBoundingClientRect();
    const pinnedLeft = startRect.left - marginLeft;
    const pinnedTop = startRect.top - marginTop;

    const onMove = (mv) => {
      const delta = horizontalAtStart ? (mv.clientX - startX) : (mv.clientY - startY);
      const size = Math.min(Math.max(startLength + delta, MIN_BAR_LENGTH), MAX_BAR_LENGTH);
      general.colorBarSize = size;
      for (const bar of listActiveColorBars()) bar.instance.setSize?.(size);
      wrapper.style.left = `${pinnedLeft}px`;
      wrapper.style.top = `${pinnedTop}px`;
    };
    const onUp = () => {
      resizeHandle.removeEventListener('pointermove', onMove);
      resizeHandle.removeEventListener('pointerup', onUp);
      resizeHandle.removeEventListener('pointercancel', onUp);
      dragCtl?.recaptureAnchor();
    };
    resizeHandle.addEventListener('pointermove', onMove);
    resizeHandle.addEventListener('pointerup', onUp);
    resizeHandle.addEventListener('pointercancel', onUp);
  });

  applyLayout();
  render(colormap);

  return {
    update(cmap, scale) { render(cmap, scale); },
    remove() { stopContrastSync(); dragCtl?.destroy(); wrapper.remove(); },
    isFloating: () => dragCtl?.isFloating() ?? false,
    getFloatPos: () => dragCtl?.getFloatPos() ?? null,
    floatAt: (left, top) => dragCtl?.floatAt(left, top),
    // getAnchor/floatAtAnchor track position relative to #view's edges
    // rather than raw page pixels — use these (not getFloatPos/floatAt) for
    // any restore that isn't immediate, e.g. across a panel rebuild, where
    // #view's rect may have shifted in the meantime.
    getAnchor: () => dragCtl?.getAnchor() ?? null,
    floatAtAnchor: (anchor) => dragCtl?.floatAtAnchor(anchor),
    // The bar's true on-screen visual footprint, for render/ImageExportModule.js
    // to composite a WYSIWYG export at the bar's actual position. wrapper's own
    // getBoundingClientRect() undersells this: the tick labels and legend text
    // are positioned via `top/bottom: calc(100% + Npx)` on children, which can
    // render outside wrapper's own layout box without being clipped (default
    // overflow:visible) — the union of wrapper + every tick label + the legend
    // is what's actually visible.
    getVisualRect() {
      const rects = [wrapper.getBoundingClientRect(), minInput.getBoundingClientRect(), maxInput.getBoundingClientRect()];
      tickLayer.querySelectorAll('.cv-colorbar-tick-label').forEach((el) => rects.push(el.getBoundingClientRect()));
      rects.push(legendLabel.getBoundingClientRect()); // always visible now — see refreshLegendContent
      const left = Math.min(...rects.map((r) => r.left));
      const top = Math.min(...rects.map((r) => r.top));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    },
    // Just the gradient strip's own box (unlike getVisualRect's union with
    // the tick labels/legend) — render/ImageExportModule.js needs this to
    // lay the redrawn ticks/legend out FROM, the same way the live widget's
    // CSS does from barOuter.
    getBarRect: () => barOuter.getBoundingClientRect(),
    // The floating wrapper's own box (unlike getVisualRect's union with tick
    // labels/legend) — ui/ColorBarDrag.js's center-snap needs the box that's
    // actually being dragged (left/top/width/height), not its visual
    // footprint, which can be pushed off-center by an asymmetric flipped
    // legend.
    getWrapperRect: () => wrapper.getBoundingClientRect(),
    // Identity check for ui/ColorBarDrag.js's center-snap, so it can skip
    // comparing a bar against itself when scanning every active bar.
    getElement: () => wrapper,
    // Includes the full render state (not just layout) so a caller like
    // render/ImageExportModule.js can redraw this bar elsewhere (the export
    // canvas) without reaching into the widget's private closures.
    getSettings: () => ({
      orientation, flipSide, legend: currentLegendRaw,
      colormap: currentColormap,
      scale: currentScale,
      min: parseFloat(minInput.value),
      max: parseFloat(maxInput.value),
      // The exact text currently in the Min/Max inputs — render/
      // ImageExportModule.js's drawColorBar uses these (not formatTick(min)/
      // formatTick(max), the same rounding the bar's own INNER ticks use) so
      // the exported endpoint labels match what's actually on screen: a
      // typed "2e-3" stays "2e-3" instead of losing its notation through
      // parseFloat, and a longer decimal like "0.0599" isn't crushed to
      // formatTick's 2-decimal-place "0.06".
      minText: minInput.value,
      maxText: maxInput.value,
      size: barLength,
      // The tick label font size actually on screen right now (CSS px,
      // already run through scaledFont's fontScale() for a floating bar) —
      // render/ImageExportModule.js scales this by its own screen->output
      // pixel ratio instead of deriving an unrelated size from the bar's
      // OUTPUT pixel dimensions, so exported text stays proportional to
      // what's actually showing rather than drifting with crop/output
      // resolution choices that have nothing to do with the widget's own
      // font-scaling (fontScale(), tied to barLength).
      tickFontPx: scaledFont(TICK_LABEL_BASE_FONT, DOCKED_TICK_LABEL_FONT),
      legendFontPx: scaledFont(LEGEND_BASE_FONT, DOCKED_LEGEND_FONT),
      inputFontPx: scaledFont(INPUT_BASE_FONT, DOCKED_INPUT_FONT),
    }),
    // Push a min/max the caller computed externally (e.g. flooring 0 to a
    // log-safe value on switching to log scale) into the visible inputs and
    // re-render the ticks against it, without tearing the widget down.
    setRange(min, max) {
      minInput.value = min;
      maxInput.value = max;
      renderTicks();
    },
    // Applies a length chosen elsewhere — the resize handle's drag broadcasts
    // to every other currently-showing bar via this (ui/ColorBarRegistry.js),
    // so all of them stay the same size instead of just the one being
    // dragged.
    setSize(size) {
      barLength = Math.min(Math.max(size, MIN_BAR_LENGTH), MAX_BAR_LENGTH);
      applyLayout();
      render(currentColormap);
      relayoutFloating();
    },
  };
}
