import { fileBrowser, general, groups } from '../state/store.js';

import {getDefaultBondCutoff} from '../defaults/radii_defaults.js'



import { updateVisualization } from '../core/crystal-viewer.js';
import { createPieDot, updatePieDot, colorHexToCss } from '../utils/ColorModule.js';
import {clearAllHighlights} from './SelectAndHighlightModule.js';
import { openDoublePeriodicTable } from './PeriodicTableSelectTwoPanel.js';
import { createColorPicker } from './ColorPickerModule.js';
import { createMaterialEditor } from './StructureInfoPanel/components/MaterialEditor.js';
import { createIndividualBondRow } from './StructureInfoPanel/components/IndividualBondRow.js';
import { createTinyToggle } from './StructureInfoPanel/components/Immunity.js';
import {
  clampOpacity, clampRadiusScale, applyToOtherTrajectoryFrames, wirePressHoldPopup, createMiniToggleSwitch,
} from './StructureInfoPanel/components/utils.js';
import {
  bondGroupKey, bondKey, updateSingleBondColor, updateSingleBondOpacity,
  updateSingleBondDiameter,
} from '../render/index.js';
import {
  updateHydrogenBonds, initHydrogenBondPairs, hydrogenBondAcceptorOf,
  resetHydrogenBondLengths, hydrogenBondColorFor,
} from '../render/index.js';
import { showInfoPanel } from './InfoPanel.js';

// The slider container is fluid (flex:1, see .bond-range-slider in
// styles/bondLengthHistogram.css) so it shrinks to fit the Structure Info
// panel at any width instead of overflowing it — BOND_SLIDER_WIDTH is only a
// same-frame-paint fallback for the rare moment a row is built while its tab
// is hidden (display:none reads clientWidth 0); the ResizeObserver in each
// row corrects it the instant the container gets real layout (becomes
// visible / panel or window resizes).
// BOND_SLIDER_THUMB must match the CSS thumb diameter in
// styles/bondLengthHistogram.css's .bond-range-slider block: a range input's
// thumb travels from thumbWidth/2 to width-thumbWidth/2 (it can never center
// past its own edge), so the colored fill track has to be inset by that same
// half-thumb amount on each side — lining it up as a plain 0-100% overlay (no
// inset) makes the fill's ends drift away from the thumbs near the min/max
// stops.
const BOND_SLIDER_WIDTH = 200;
const BOND_SLIDER_THUMB = 16;

/** Pixel offset of a range input's thumb CENTER for value `v` in [0, max],
 *  within a track of the given (actual, current) pixel `width`. */
function bondSliderThumbPos(v, max, width = BOND_SLIDER_WIDTH) {
  const inset = BOND_SLIDER_THUMB / 2;
  return inset + (v / max) * (width - 2 * inset);
}

// Hydrogen-bond distance sliders span a wider window than covalent bonds
// (weak H...A contacts reach ~3.5 A), so the second slider uses its own max.
const HBOND_SLIDER_MAX = 4;

/** Build the "H-bond" sub-control (on/off toggle + H...A distance range
 *  slider) for a hydrogen-bond-eligible pair like "H-O". Returns the row
 *  element. Edits update general.hydrogenBondLengths / hydrogenBondVisibility
 *  and redraw the dashed lines directly (no bonds rebuild needed). */
function createHydrogenBondControl(pair) {
  const acceptor = hydrogenBondAcceptorOf(pair);
  const wrap = document.createElement('div');
  wrap.className = 'hbond-control';
  wrap.dataset.pair = pair;

  // Defensive: initHydrogenBondPairs() runs before this for every eligible
  // pair, but never let a missing range take down the whole Bonds panel.
  const range = general.hydrogenBondLengths[pair]
    ?? (general.hydrogenBondLengths[pair] = { min: 1.5, max: 2.6 });
  const enabled = general.hydrogenBondVisibility[pair] !== false;

  // Header: toggle + colour dot + label + live value readout.
  const header = document.createElement('div');
  header.className = 'hbond-header';

  const { wrapper: toggleWrap, input: toggle } = createMiniToggleSwitch(
    `Show/hide ${pair} hydrogen bonds`);
  toggle.checked = enabled;

  // Colour editor (a single colour picker), toggled by the dot — same
  // pattern as the covalent category dot's editor above.
  const colorEditor = document.createElement('div');
  colorEditor.className = 'hbond-color-editor';
  colorEditor.style.display = 'none';
  const colorPicker = createColorPicker(hydrogenBondColorFor(pair), (hex) => {
    general.hydrogenBondColors[pair] = hex;
    updatePieDot(dot, [hex]);
    updateHydrogenBonds(fileBrowser.selectedStructure);
  });
  colorEditor.appendChild(colorPicker.element);

  // Small round colour swatch matching the covalent bonds' category dot.
  const dot = createPieDot([hydrogenBondColorFor(pair)], 20);
  dot.classList.add('dot', 'bond-cat-dot', 'hbond-dot');
  dot.title = `Choose the ${pair} hydrogen-bond colour`;
  dot.onclick = (e) => {
    e.stopPropagation();
    colorEditor.style.display = colorEditor.style.display === 'none' ? 'block' : 'none';
  };

  const label = document.createElement('span');
  label.className = 'hbond-label';
  label.textContent = 'H-bond';
  label.title = `${acceptor}···H hydrogen-bond distance range (dashed lines)`;

  const valueSpan = document.createElement('span');
  valueSpan.className = 'hbond-value';
  valueSpan.textContent = `${range.min.toFixed(2)} - ${range.max.toFixed(2)} Å`;

  // Little "i" button explaining the hydrogen-bond distance/angle criteria.
  const infoBtn = document.createElement('button');
  infoBtn.type = 'button';
  infoBtn.className = 'info-button hbond-info';
  infoBtn.textContent = 'i';
  infoBtn.title = 'About hydrogen bonds';
  infoBtn.onclick = (e) => {
    e.stopPropagation();
    showInfoPanel('./data/hydrogenBondInfo.md');
  };

  header.appendChild(toggleWrap);
  header.appendChild(dot);
  header.appendChild(label);
  header.appendChild(valueSpan);

  // Double slider (same construction as the covalent bond slider, own accent).
  const controlsRow = document.createElement('div');
  controlsRow.className = 'bond-controls-row';

  const sliderContainer = document.createElement('div');
  sliderContainer.className = 'bond-range-slider hbond-range-slider';

  const backgroundTrack = document.createElement('div');
  backgroundTrack.className = 'background-track';
  sliderContainer.appendChild(backgroundTrack);

  const track = document.createElement('div');
  track.className = 'range-track';
  sliderContainer.appendChild(track);

  const minSlider = /** @type {any} */ (document.createElement('input'));
  minSlider.type = 'range';
  minSlider.min = '0';
  minSlider.max = String(HBOND_SLIDER_MAX);
  minSlider.step = '0.05';
  minSlider.value = range.min;
  minSlider.className = 'bond-range-min';
  sliderContainer.appendChild(minSlider);

  const maxSlider = /** @type {any} */ (document.createElement('input'));
  maxSlider.type = 'range';
  maxSlider.min = '0';
  maxSlider.max = String(HBOND_SLIDER_MAX);
  maxSlider.step = '0.05';
  maxSlider.value = range.max;
  maxSlider.className = 'bond-range-max';
  sliderContainer.appendChild(maxSlider);

  function redrawTrackFill() {
    const width = sliderContainer.clientWidth || BOND_SLIDER_WIDTH;
    const minPx = bondSliderThumbPos(parseFloat(minSlider.value), HBOND_SLIDER_MAX, width);
    const maxPx = bondSliderThumbPos(parseFloat(maxSlider.value), HBOND_SLIDER_MAX, width);
    track.style.left = `${minPx}px`;
    track.style.width = `${maxPx - minPx}px`;
  }
  new ResizeObserver(redrawTrackFill).observe(sliderContainer);

  function updateRange() {
    let minVal = parseFloat(minSlider.value);
    let maxVal = parseFloat(maxSlider.value);
    if (maxVal - minVal < 0.1) {
      if (this === minSlider) { minVal = maxVal - 0.1; minSlider.value = minVal; }
      else { maxVal = minVal + 0.1; maxSlider.value = maxVal; }
    }
    if (minVal > maxVal) {
      if (this === minSlider) { minVal = maxVal; minSlider.value = maxVal; }
      else { maxVal = minVal; maxSlider.value = minVal; }
    }
    redrawTrackFill();
    valueSpan.textContent = `${minVal.toFixed(2)} - ${maxVal.toFixed(2)} Å`;
    general.hydrogenBondLengths[pair].min = minVal;
    general.hydrogenBondLengths[pair].max = maxVal;
    updateHydrogenBonds(fileBrowser.selectedStructure);
  }
  minSlider.oninput = updateRange;
  maxSlider.oninput = updateRange;

  function applyEnabled(on) {
    general.hydrogenBondVisibility[pair] = on;
    sliderContainer.style.opacity = on ? '' : '0.4';
    minSlider.disabled = !on;
    maxSlider.disabled = !on;
    updateHydrogenBonds(fileBrowser.selectedStructure);
  }
  toggle.onchange = (e) => applyEnabled(/** @type {any} */ (e.target).checked);

  redrawTrackFill();
  applyEnabled(enabled);

  // The "i" sits after the slider (the bar's flex:1 shrinks to make room).
  controlsRow.appendChild(sliderContainer);
  controlsRow.appendChild(infoBtn);
  wrap.appendChild(header);
  wrap.appendChild(colorEditor);
  wrap.appendChild(controlsRow);
  return wrap;
}

function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

/** Legible text color (black/white) for a given CSS hex background. */
function textColorForBg(cssHex) {
  let hex = cssHex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#000' : '#fff';
}

// Re-populate the individual-bond lists of any *expanded* category rows after a
// bonds rebuild (slider drag / visibility toggle). Collapsed lists refresh
// lazily on next expand via general.bondsBuildCounter.
function refreshExpandedBondLists(panelRoot) {
  panelRoot.querySelectorAll('.individual-bonds').forEach((container) => {
    if (/** @type {HTMLElement} */ (container).style.display !== 'none') {
      /** @type {any} */ (container)._populateBondRows?.();
    }
  });
}

// Refresh every category header (pie dot colors + count/percentage) after an
// in-place rebuild; full panel re-creations go through renderComposition.
function refreshBondHeaders(panelRoot) {
  panelRoot.querySelectorAll('.bond-control').forEach((control) => {
    /** @type {any} */ (control)._refreshBondHeader?.();
  });
}

// A global recolor (Bonds color-map dropdown, mode switch, color-bar limits,
// individual/category bond edits elsewhere) doesn't go through any of the
// three refreshBondHeaders() call sites above (those only fire on
// visibility/slider/rebuild actions), so category pie dots went stale the
// same way the composition pie dots and Edit-button swatches did. Keyed by
// pair so re-creating a category row overwrites its own entry.
const bondCategorySwatchUpdateFunctions = {};
document.addEventListener('crysviz:colors-changed', () => {
  Object.values(bondCategorySwatchUpdateFunctions).forEach((updateFn) => updateFn());
});

export function resetBondLengths() {
  for (const pair in general.defaultBondLengths) {
    general.bondLengths[pair] = { ...general.defaultBondLengths[pair] };
  }
  // Reset the hydrogen-bond ranges alongside the covalent ones — they share
  // the same "Reset Bond Lengths" button and the same Bonds-tab rows.
  resetHydrogenBondLengths();
  // createBondLengthControls() never clears its target container first (it's
  // an append-only builder, unlike e.g. createPolyhedraListControls) — its
  // only safe caller is renderComposition(), which always hands it a freshly
  // recreated, empty #infoBondControls div. Calling it directly here (a
  // previous fix attempt) instead DUPLICATED every category row on top of
  // the existing ones each time Reset was clicked. Go through
  // updateVisualization's reRenderComposition instead, which rebuilds the
  // whole composition panel (bonds tab included) from a clean slate — the
  // same path every other bond-length-affecting flow already relies on to
  // refresh this same UI. reRenderBonds:true is still needed alongside it so
  // the 3D bond SET (which pairs qualify at the just-reset min/max) actually
  // recomputes — bondsUpdate (the default) only repaints existing bonds, it
  // doesn't re-filter by length range.
  updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: "open" });
}

/** Reset every bond COLOR customization (category + individual) on one
 *  structure/frame back to defaults; alpha/size/material overrides survive
 *  (mirrors resetAllColorStyling's atom-side semantics in General.js). Pure
 *  data — no mesh/render calls — so it's safe to re-run against off-screen
 *  trajectory frames too. */
function resetAllBondColors(structure) {
  for (const store of [structure.bondCategoryStyles, structure.bondUserStyles]) {
    if (!store) continue;
    for (const [key, entry] of Object.entries(store)) {
      delete entry.color;
      if (entry.alpha == null && entry.radiusScale == null && entry.material == null) {
        delete store[key];
      }
    }
  }
}

export function createBondLengthControls(targetPanel='bondControls') {
  const bondControls = document.getElementById(targetPanel);
  // No target is an expected state now: the Bonds window no longer hosts a
  // #bondControls copy (the controls live in the Structure window's Bonds
  // tab, #infoBondControls), so legacy refresh calls simply no-op.
  if (!bondControls) return;

  if (!fileBrowser.selectedStructure) return;

  // Seed per-pair hydrogen-bond ranges/visibility so the second sliders below
  // have values to bind to (idempotent — existing user edits are kept).
  initHydrogenBondPairs(fileBrowser.selectedStructure);

    // --- Reset wrapper (Add Custom Bond only now — Reset Bond Lengths moved
    // to the bottom, next to Reset Colors) ---
  const resetWrapper = document.createElement("div");
  resetWrapper.id = "resetBondLengthsWrapper";
  resetWrapper.className = "buttonWrapper";
  resetWrapper.setAttribute("aria-hidden", "true");

  const addCustomBondBtn = document.createElement("button");
  addCustomBondBtn.id = "addCustomBond";
  // Deactivated for now: the underlying data model holds one length range
  // per element pair, so this button can only add a pair that has none yet
  // (e.g. a cross-element pair the auto-detector never saw) — not a second,
  // independent range for a pair that already has one. Keeping the handler
  // below intact (just hidden, see .blp-add-custom-btn) rather than deleting
  // it in case that single-range-only version of "Add Custom Bond" turns out
  // to be wanted later.
  addCustomBondBtn.className = "reset-btn blp-add-custom-btn";
  addCustomBondBtn.textContent = "Add Custom Bond";
  addCustomBondBtn.onclick = () => {
    openDoublePeriodicTable((pair) => {
      if (general.bondLengths[pair]) {
        // One range per element pair is all this data model holds (it's a
        // flat pair -> {min,max} dictionary) — picking a pair that's already
        // defined has nothing new to add, it would just silently overwrite
        // the existing definition. Say so instead of doing nothing with no
        // feedback; edit the existing range in the list above instead.
        const prior = addCustomBondBtn.textContent;
        addCustomBondBtn.textContent = `${pair} already exists — edit it above`;
        setTimeout(() => { if (addCustomBondBtn.isConnected) addCustomBondBtn.textContent = prior; }, 1800);
        return;
      }
      const [el1, el2] = pair.split('-');
      const defaultValue = getDefaultBondCutoff(el1, el2);
      general.bondLengths[pair] = { min: 0, max: defaultValue };
      general.defaultBondLengths[pair] = { min: 0, max: defaultValue };
      general.bondVisibility[pair] = true;
      // createBondLengthControls(targetPanel) directly here would duplicate
      // every category row on top of the existing ones (see resetBondLengths
      // - it's an append-only builder, safe only via renderComposition's
      // freshly emptied container). Go through reRenderComposition instead.
      updateVisualization({
        reRenderBonds: true,
        reRenderOther: false,
        reRenderComposition: "open",
      });
    });
  };

  resetWrapper.appendChild(addCustomBondBtn);

  bondControls.appendChild(resetWrapper);
  let elements = [...fileBrowser.selectedStructure.elements];
  const uniqueElements = [...new Set(elements)];
  const pairs = [];

  // Generate all unique pairs
  for (let i = 0; i < uniqueElements.length; i++) {
    for (let j = i; j < uniqueElements.length; j++) {
      const pair = uniqueElements[i] < uniqueElements[j]
        ? `${uniqueElements[i]}-${uniqueElements[j]}`
        : `${uniqueElements[j]}-${uniqueElements[i]}`;
      pairs.push(pair);

      if (!general.bondLengths[pair]) {
        const defaultValue = getDefaultBondCutoff(uniqueElements[i], uniqueElements[j]);
        general.bondLengths[pair] = { min: 0.0, max: defaultValue };
        general.defaultBondLengths[pair] = { min: 0.0, max: defaultValue }; // Store default
      }

      // Initialize bond visibility if not set
      if (general.bondVisibility[pair] === undefined) {
        general.bondVisibility[pair] = true;
      }
    }
  }

  pairs.forEach(pair => {
    const div = document.createElement('div');
    div.className = 'bond-control';
    div.dataset.pair = pair;

    // Bond visibility toggle
    const checkboxDiv = document.createElement('div');
    checkboxDiv.className = 'bond-checkbox';

    const { wrapper: checkboxSwitch, input: checkbox } = createMiniToggleSwitch(`Show/hide ${pair} bonds`);
    checkbox.checked = general.bondVisibility[pair];
    checkbox.onchange = (e) => {
      general.bondVisibility[pair] = /** @type {any} */ (e.target).checked;
      updateVisualization({
        reRenderBonds: true,
        reRenderOther: false,
        reRenderComposition: false,
      });
      refreshExpandedBondLists(bondControls);
      refreshBondHeaders(bondControls);
    };

    const checkboxLabel = document.createElement('label');
    checkboxLabel.textContent = pair;
    checkboxLabel.title = `Show/hide ${pair} bonds`;
    // Explicit, scale-respecting size matching the Atoms tab's element-symbol
    // label, so both stay identical regardless of viewport width instead of
    // relying on the ambient cascade (global `label` rule here vs. Atoms'
    // `.comp-row` narrow-viewport override there). --fs-lg is exactly
    // calc(14px * var(--cv-font-scale, 1)).
    checkboxLabel.className = 'bond-checkbox-label';

    // Expand caret toggling the individual-bond list (same style as the
    // Atoms-tab composition rows).
    const expandIcon = document.createElement('span');
    expandIcon.textContent = '▶';
    expandIcon.className = 'bond-expand-icon';

    // --- Live header: pie dot (opens the category editor) + count(pct%) ---
    const structure = () => fileBrowser.selectedStructure;
    const pairOf = (b) => (b.elements[0] < b.elements[1]
      ? `${b.elements[0]}-${b.elements[1]}` : `${b.elements[1]}-${b.elements[0]}`);
    const memberBonds = () => (structure()?.bonds ?? []).filter((b) => pairOf(b) === pair);
    const catStyle = () => (structure().bondCategoryStyles ??= {})[pair] ??= {};

    /** @type {HTMLElement} */
    let dotEl = document.createElement('span');
    const countLabel = document.createElement('span');
    countLabel.className = 'bond-count';

    function refreshHeader() {
      const members = memberBonds();
      // No bonds currently fall in this pair's length range (0 members) —
      // but the DEFAULT color is purely a function of the two element
      // symbols (Bond.js derives it from general.customColorMap/
      // defaultColorMap, never from a live Bond instance), so an empty
      // category can still preview its real would-be color instead of a
      // dead grey placeholder.
      const [el1, el2] = pair.split('-');
      const defaultPairColors = [el1, el2].map((el) => safeColor(structure()?.getDefaultElementColor(el)));
      const catColorOverride = structure()?.bondCategoryStyles?.[pair]?.color;
      const colors = members.length
        ? members.map((b) => safeColor(b.color?.[0]))
        : catColorOverride != null ? [safeColor(catColorOverride)] : defaultPairColors;
      const dot = createPieDot(colors, 20);
      // Match the Atoms tab's dot size (the shared .dot CSS class alone
      // renders at 10x10 — its rule predates this row and this row never
      // overrode it, unlike CompositionRow.js's atom dot).
      dot.classList.add('dot', 'bond-cat-dot');
      dot.title = `Customize color/alpha/size for all ${pair} bonds`;
      dot.onclick = (e) => {
        e.stopPropagation();
        catEditor.style.display = catEditor.style.display === 'none' ? 'block' : 'none';
      };
      dotEl.replaceWith(dot);
      dotEl = dot;
      const total = structure()?.bonds?.length ?? 0;
      countLabel.textContent = `${members.length} (${total ? (100 * members.length / total).toFixed(1) : '0.0'}%)`;
    }
    /** @type {any} */ (div)._refreshBondHeader = refreshHeader;
    bondCategorySwatchUpdateFunctions[pair] = refreshHeader;

    // --- Per-pair cut-plane immunity toggle (parity with the Atoms header) ---
    const keepToggle = createTinyToggle({
      title: `Keep ${pair} bonds visible across cut planes`,
      checked: !!general.bondCutImmunity[pair],
      onChange: (on) => {
        general.bondCutImmunity[pair] = on;
        updateVisualization({
          atomsUpdate: false,
          bondsUpdate: true,
          reRenderAtoms: false,
          reRenderBonds: false,
          reRenderLattice: false,
          reRenderOther: false,
          reRenderComposition: false,
        });
      },
    });

    // --- Category style editor (color + alpha + size for the whole pair) ---
    const catEditor = document.createElement('div');
    catEditor.className = 'bond-cat-editor';
    // Explicit inline default alongside the CSS class's own `display: none`:
    // this codebase reads `.style.display` back in several places (this
    // file, StructureInfoPanel/General.js's expand-state capture) as the
    // source of truth for open/closed — the CSS class alone would make
    // those reads see '' instead of 'none' before the first toggle.
    catEditor.style.display = 'none';

    // Live edits fan out to every bond of the pair, but SKIP members that have
    // a per-copy override for the same field so individual > category holds
    // live as well as after rebuilds (buildBondObjects re-applies both).
    // Falls back to the pair's real default color (element-based, not
    // dependent on a live bond existing) rather than a placeholder grey.
    const currentCatColor = safeColor(
      structure()?.bondCategoryStyles?.[pair]?.color ?? structure()?.getDefaultElementColor(pair.split('-')[0]));
    const catPicker = createColorPicker(currentCatColor, (hex) => {
      catStyle().color = hex;
      for (const b of memberBonds()) {
        if (structure().bondUserStyles?.[bondKey(b.indices)]?.color != null) continue;
        b.color = [hex, hex];
        b.userColor = [hex, hex];
        if (b.instanceIds && groups.bondsMesh) {
          updateSingleBondColor(b.instanceIds[0], hex, true);
          updateSingleBondColor(b.instanceIds[1], hex, true);
        }
      }
      if (groups.bondsMesh) groups.bondsMesh.instanceColor.needsUpdate = true;
      refreshHeader();
      refreshExpandedBondLists(bondControls);
    });

    const currentCatAlpha = clampOpacity(structure()?.bondCategoryStyles?.[pair]?.alpha ?? 1);
    const catAlphaRow = document.createElement('div');
    catAlphaRow.className = 'bond-cat-row';
    const catAlphaLabel = document.createElement('span');
    catAlphaLabel.textContent = 'Alpha';
    catAlphaLabel.className = 'bond-cat-row-label';
    const catAlphaSlider = document.createElement('input');
    catAlphaSlider.type = 'range';
    catAlphaSlider.min = '0.05';
    catAlphaSlider.max = '1';
    catAlphaSlider.step = '0.01';
    catAlphaSlider.value = String(currentCatAlpha);
    const catAlphaValue = document.createElement('input');
    catAlphaValue.type = 'number';
    catAlphaValue.min = '0.05';
    catAlphaValue.max = '1';
    catAlphaValue.step = '0.01';
    catAlphaValue.value = currentCatAlpha.toFixed(2);
    catAlphaValue.className = 'bond-cat-row-input';
    function applyCatAlpha(rawValue) {
      const value = clampOpacity(rawValue);
      catAlphaSlider.value = String(value);
      catAlphaValue.value = value.toFixed(2);
      catStyle().alpha = value;
      for (const b of memberBonds()) {
        if (structure().bondUserStyles?.[bondKey(b.indices)]?.alpha != null) continue;
        b.alpha = value;
        if (b.instanceIds) {
          updateSingleBondOpacity(b.instanceIds[0], value);
          updateSingleBondOpacity(b.instanceIds[1], value);
        }
      }
    }
    catAlphaSlider.oninput = (e) => applyCatAlpha(/** @type {any} */ (e.target).value);
    catAlphaValue.oninput = (e) => applyCatAlpha(/** @type {any} */ (e.target).value);
    catAlphaRow.appendChild(catAlphaLabel);
    catAlphaRow.appendChild(catAlphaSlider);
    catAlphaRow.appendChild(catAlphaValue);

    const currentCatScale = clampRadiusScale(structure()?.bondCategoryStyles?.[pair]?.radiusScale ?? 1);
    const catSizeRow = document.createElement('div');
    catSizeRow.className = 'bond-cat-row';
    const catSizeLabel = document.createElement('span');
    catSizeLabel.textContent = 'Size';
    catSizeLabel.className = 'bond-cat-row-label';
    const catSizeSlider = document.createElement('input');
    catSizeSlider.type = 'range';
    catSizeSlider.min = '0.2';
    catSizeSlider.max = '3';
    catSizeSlider.step = '0.05';
    catSizeSlider.value = String(currentCatScale);
    const catSizeValue = document.createElement('input');
    catSizeValue.type = 'number';
    catSizeValue.min = '0.2';
    catSizeValue.max = '3';
    catSizeValue.step = '0.05';
    catSizeValue.value = currentCatScale.toFixed(2);
    catSizeValue.className = 'bond-cat-row-input';
    function applyCatSize(rawValue) {
      const value = clampRadiusScale(rawValue);
      catSizeSlider.value = String(value);
      catSizeValue.value = value.toFixed(2);
      catStyle().radiusScale = value;
      for (const b of memberBonds()) {
        if (structure().bondUserStyles?.[bondKey(b.indices)]?.radiusScale != null) continue;
        b.radius = general.bondRadius * value;
        if (b.instanceIds && groups.bondsMesh) {
          updateSingleBondDiameter(b.instanceIds[0], b.radius);
          updateSingleBondDiameter(b.instanceIds[1], b.radius);
        }
      }
    }
    catSizeSlider.oninput = (e) => applyCatSize(/** @type {any} */ (e.target).value);
    catSizeValue.oninput = (e) => applyCatSize(/** @type {any} */ (e.target).value);
    catSizeRow.appendChild(catSizeLabel);
    catSizeRow.appendChild(catSizeSlider);
    catSizeRow.appendChild(catSizeValue);

    const catResetBtn = document.createElement('button');
    catResetBtn.textContent = 'Reset';
    catResetBtn.className = 'btn-mini bond-cat-btn';
    catResetBtn.title = `Reset ${pair} bonds: removes the group style AND every individual override.\nClick: this frame. Press and hold: whole trajectory.`;
    // Preview the two elements' default (pre-override) half-colors, same idea
    // as the element editor's Reset swatch — each bond half is colored by its
    // own endpoint element by default.
    const [defColor1, defColor2] = (memberBonds()[0]?.defaultColor ?? []).map(safeColor);
    if (defColor1 && defColor2) {
      catResetBtn.style.background = `linear-gradient(90deg, ${defColor1} 50%, ${defColor2} 50%)`;
      catResetBtn.style.borderColor = 'rgba(0,0,0,0.2)';
      catResetBtn.style.color = textColorForBg(defColor1);
      catResetBtn.style.textShadow = '0 0 3px rgba(0,0,0,0.6)';
    }
    function resetPairOnFrame(frame) {
      delete frame.bondCategoryStyles?.[pair];
      (frame.bonds ?? []).filter((b) => pairOf(b) === pair)
        .forEach((b) => delete frame.bondUserStyles?.[bondKey(b.indices)]);
    }
    wirePressHoldPopup(catResetBtn, {
      holdLabel: 'Reset Trajectory',
      onPress: (e) => {
        e.stopPropagation();
        resetPairOnFrame(structure());
        updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
        refreshExpandedBondLists(bondControls);
        refreshBondHeaders(bondControls);
      },
      onConfirm: (e) => {
        e.stopPropagation();
        resetPairOnFrame(structure());
        // Clear this same pair's category + member overrides on every other
        // frame too, using each frame's OWN bond list/keys (not a copy of
        // this frame's), since wrapped-index bond keys can drift frame to frame.
        applyToOtherTrajectoryFrames(structure(), resetPairOnFrame);
        updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
        refreshExpandedBondLists(bondControls);
        refreshBondHeaders(bondControls);
      },
    });

    const catApplyBtn = document.createElement('button');
    catApplyBtn.textContent = 'Apply';
    catApplyBtn.className = 'btn-mini highlight bond-cat-btn';
    catApplyBtn.title = `Click: close. Press and hold: copy ${pair} bonds' group color/alpha/size to every trajectory frame.`;
    wirePressHoldPopup(catApplyBtn, {
      holdLabel: 'Apply to Trajectory',
      onPress: (e) => {
        e.stopPropagation();
        catEditor.style.display = 'none';
      },
      onConfirm: (e) => {
        e.stopPropagation();
        const style = { ...structure().bondCategoryStyles[pair] };
        applyToOtherTrajectoryFrames(structure(), (frame) => {
          frame.bondCategoryStyles ??= {};
          frame.bondCategoryStyles[pair] = { ...style };
        });
      },
    });

    const catButtonRow = document.createElement('div');
    catButtonRow.className = 'bond-cat-btn-row';
    catButtonRow.appendChild(catResetBtn);
    catButtonRow.appendChild(catApplyBtn);

    // Per-pair ray/path-tracing material (bondCategoryStyles[pair].material).
    const catMaterialEditor = createMaterialEditor(
      () => structure()?.bondCategoryStyles?.[pair]?.material,
      (material) => {
        if (material) catStyle().material = material;
        else delete catStyle().material;
      });

    catEditor.appendChild(catPicker.element);
    catEditor.appendChild(catAlphaRow);
    catEditor.appendChild(catSizeRow);
    catEditor.appendChild(catMaterialEditor);
    catEditor.appendChild(catButtonRow);

    // Uniform header order across tabs: checkbox, dot, label, caret, count, immunity.
    checkboxDiv.appendChild(checkboxSwitch);
    checkboxDiv.appendChild(dotEl);
    checkboxDiv.appendChild(checkboxLabel);
    checkboxDiv.appendChild(expandIcon);
    checkboxDiv.appendChild(countLabel);
    checkboxDiv.appendChild(keepToggle.wrapper);
    refreshHeader();

    // --- Individual bond list (expandable, lazily built) ---
    const bondsContainer = document.createElement('div');
    bondsContainer.className = 'individual-bonds';
    // See the matching comment on catEditor.style.display above.
    bondsContainer.style.display = 'none';

    // One row per bond is expensive and hidden until expanded, so build lazily
    // on first expand (mirrors the Atoms tab). structure.bonds is recreated by
    // every bonds rebuild, so cached rows are refreshed whenever
    // general.bondsBuildCounter has moved on. Exposed on the container so code
    // that expands programmatically (highlight/scroll to a bond) can ensure
    // the rows exist first.
    let builtForBuildId = -1;
    function populateBondRows() {
      if (builtForBuildId === general.bondsBuildCounter) return;
      builtForBuildId = general.bondsBuildCounter;
      bondsContainer.innerHTML = '';
      const structure = fileBrowser.selectedStructure;
      const bonds = structure?.bonds ?? [];
      // "Link periodic copies" on: one row per physical bond — periodic-image
      // copies grouped by bondGroupKey, edits/selection fan out to all copies.
      const linking = general.linkPeriodicCopies !== false;
      const groupsMap = linking ? new Map() : null; // groupKey -> member indices (insertion order)
      bonds.forEach((bond, bondIndex) => {
        const [e1, e2] = bond.elements;
        const bondPair = e1 < e2 ? `${e1}-${e2}` : `${e2}-${e1}`;
        if (bondPair !== pair) return;
        if (!linking) {
          bondsContainer.appendChild(createIndividualBondRow(bond, bondIndex));
          return;
        }
        const gk = bondGroupKey(structure, bond);
        let members = groupsMap.get(gk);
        if (!members) { members = []; groupsMap.set(gk, members); }
        members.push(bondIndex);
      });
      if (linking) {
        for (const [gk, members] of groupsMap) {
          bondsContainer.appendChild(createIndividualBondRow(
            bonds[members[0]], members[0], { linkedBondIndexes: members, groupKey: gk }));
        }
      }
      if (!bondsContainer.children.length) {
        const empty = document.createElement('div');
        empty.className = 'bond-empty-note';
        empty.textContent = 'No bonds in the current length range';
        bondsContainer.appendChild(empty);
      }
    }
    /** @type {any} */ (bondsContainer)._populateBondRows = populateBondRows;

    function toggleBondList(e) {
      e.stopPropagation();
      const isExpanded = bondsContainer.style.display !== 'none';
      if (!isExpanded) populateBondRows(); // build rows lazily on first expand
      bondsContainer.style.display = isExpanded ? 'none' : 'block';
      expandIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
      catEditor.style.display = 'none'; // expanding/collapsing closes the category color editor
    }
    expandIcon.onclick = toggleBondList;
    checkboxLabel.onclick = toggleBondList;

    const label = document.createElement('div');
    label.className = 'bond-label';
    label.textContent = `${pair}: `;

    const valueSpan = document.createElement('span');
    valueSpan.className = 'slider-value';
    valueSpan.textContent = `${general.bondLengths[pair].min.toFixed(2)} - ${general.bondLengths[pair].max.toFixed(2)} Å`;
    label.appendChild(valueSpan);

    const controlsRow = document.createElement('div');
    controlsRow.className = 'bond-controls-row';

    // Double slider container
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'bond-range-slider';

    // Background track (light grey)
    const backgroundTrack = document.createElement('div');
    backgroundTrack.className = 'background-track';
    sliderContainer.appendChild(backgroundTrack);

    // Selected range track (green)
    const track = document.createElement('div');
    track.className = 'range-track';
    track.style.left = '0%';
    track.style.width = '100%';
    sliderContainer.appendChild(track);

    // Min slider
    const minSlider = /** @type {any} */ (document.createElement('input'));
    minSlider.type = 'range';
    minSlider.min = '0';
    minSlider.max = '6';
    minSlider.step = '0.1';
    minSlider.value = general.bondLengths[pair].min;
    minSlider.className = 'bond-range-min';
    sliderContainer.appendChild(minSlider);

    // Max slider
    const maxSlider = /** @type {any} */ (document.createElement('input'));
    maxSlider.type = 'range';
    maxSlider.min = '0';
    maxSlider.max = '6';
    maxSlider.step = '0.1';
    maxSlider.value = general.bondLengths[pair].max;
    maxSlider.className = 'bond-range-max';
    sliderContainer.appendChild(maxSlider);

    // Fill-track position depends on the container's ACTUAL current width,
    // not a fixed constant, now that .bond-range-slider is fluid (flex:1) —
    // recomputed from the live slider values on every call, so both a value
    // change and a pure resize (tab becoming visible, panel/window resize)
    // can call this without duplicating the min/max readout.
    function redrawTrackFill() {
      const width = sliderContainer.clientWidth || BOND_SLIDER_WIDTH;
      const minPx = bondSliderThumbPos(parseFloat(minSlider.value), 6, width);
      const maxPx = bondSliderThumbPos(parseFloat(maxSlider.value), 6, width);
      track.style.left = `${minPx}px`;
      track.style.width = `${maxPx - minPx}px`;
    }
    // clientWidth reads 0 while the row's tab is hidden (display:none) —
    // ResizeObserver fires again the instant the container gets real layout
    // (tab switched to, panel/window resized), so the fill self-corrects
    // instead of staying pinned to the display:none-time (wrong) width.
    new ResizeObserver(redrawTrackFill).observe(sliderContainer);

    // Update function for both sliders
    function updateBondRange() {
      let minVal = parseFloat(minSlider.value);
      let maxVal = parseFloat(maxSlider.value);

      // Enforce a minimum range of 0.1
      if (maxVal - minVal < 0.1) {
        if (this === minSlider) {
          minVal = maxVal - 0.1;
          minSlider.value = minVal;
        } else {
          maxVal = minVal + 0.1;
          maxSlider.value = maxVal;
        }
      }

      // Ensure min <= max
      if (minVal > maxVal) {
        if (this === minSlider) {
          minVal = maxVal;
          minSlider.value = maxVal;
        } else {
          maxVal = minVal;
          maxSlider.value = minVal;
        }
      }

      redrawTrackFill();

      valueSpan.textContent = `${minVal.toFixed(2)} - ${maxVal.toFixed(2)} Å`;

      general.bondLengths[pair].min = minVal;
      general.bondLengths[pair].max = maxVal;

      updateVisualization({
        reRenderBonds: true,
        reRenderOther: false,
        reRenderComposition: false,
      });
      refreshExpandedBondLists(bondControls);
      refreshBondHeaders(bondControls);
    }

    minSlider.oninput = updateBondRange;
    maxSlider.oninput = updateBondRange;

    // Initialize track (ResizeObserver's own initial callback also covers
    // this once layout lands, but painting the best-guess position
    // synchronously avoids a visible jump on the frame the row first shows).
    redrawTrackFill();

    controlsRow.appendChild(sliderContainer);

    div.appendChild(checkboxDiv);
    div.appendChild(catEditor);
    div.appendChild(label);
    div.appendChild(controlsRow);
    // Second slider for hydrogen-bond-capable pairs (H + electronegative
    // acceptor, e.g. O-H): controls the dashed D-H...A contact distance range.
    if (hydrogenBondAcceptorOf(pair)) {
      div.appendChild(createHydrogenBondControl(pair));
    }
    div.appendChild(bondsContainer);
    bondControls.appendChild(div);
  });

  // Below every individual bond category — same placement as the Atoms tab's
  // Reset Colors/Reset Styling row below the composition list.
  const resetColorsRow = document.createElement('div');
  resetColorsRow.className = 'blp-reset-colors-row';

  // Historic id kept (never rename ids); label describes the actual behavior.
  const resetBtn = document.createElement("button");
  resetBtn.id = "resetBondLengths";
  resetBtn.className = "reset-btn blp-reset-btn";
  resetBtn.textContent = "Reset Bond Lengths";
  resetBtn.onclick = () => {
    resetBondLengths();
    clearAllHighlights();
  };

  const resetBondColorsBtn = document.createElement('button');
  resetBondColorsBtn.id = 'resetBondColorsBtn';
  resetBondColorsBtn.textContent = 'Reset Colors';
  resetBondColorsBtn.className = 'reset-btn blp-reset-btn';
  resetBondColorsBtn.title = 'Reset every bond color customization (category and individual) to element defaults.\nClick: this frame. Press and hold: whole trajectory.';
  wirePressHoldPopup(resetBondColorsBtn, {
    holdLabel: 'Reset Trajectory',
    onPress: () => {
      resetAllBondColors(fileBrowser.selectedStructure);
      updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: "open" });
    },
    onConfirm: () => {
      const structure = fileBrowser.selectedStructure;
      resetAllBondColors(structure);
      applyToOtherTrajectoryFrames(structure, resetAllBondColors);
      updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: "open" });
    },
  });
  resetColorsRow.appendChild(resetBtn);
  resetColorsRow.appendChild(resetBondColorsBtn);
  bondControls.appendChild(resetColorsRow);
}
