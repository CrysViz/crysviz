import { fileBrowser, general, groups } from '../state/store.js';

import {atomicRadii} from '../defaults/radii_defaults.js'



import { updateVisualization } from '../core/crystal-viewer.js';
import { createPieDot, colorHexToCss } from '../utils/ColorModule.js';
import {clearAllHighlights} from './SelectAndHighlightModule.js';
import { openDoublePeriodicTable } from './PeriodicTableSelectTwoPanel.js';
import { createColorPicker } from './ColorPickerModule.js';
import { createMaterialEditor } from './StructureInfoPanel/components/MaterialEditor.js';
import { createIndividualBondRow } from './StructureInfoPanel/components/IndividualBondRow.js';
import { createTinyToggle } from './StructureInfoPanel/components/Immunity.js';
import { clampOpacity, clampRadiusScale } from './StructureInfoPanel/components/utils.js';
import {
  bondGroupKey, bondKey, updateSingleBondColor, updateSingleBondOpacity,
  updateSingleBondDiameter,
} from '../render/index.js';

function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
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

// Inject CSS for the double slider
function injectDoubleSliderCSS() {
  const style = document.createElement('style');
  style.textContent = `
    .bond-range-slider {
      position: relative;
      width: 200px;
      height: 16px;
      margin: 0 8px;
    }
    .bond-range-slider .background-track {
      position: absolute;
      height: 4px;
      background: rgba(150, 150, 150, 0.5);
      border-radius: 2px;
      top: 50%;
      left: 0;
      right: 0;
      transform: translateY(-50%);
      z-index: -2;
      maring: 1px
    }
    .bond-range-slider .range-track {
      position: absolute;
      height: 4px;
      background: rgba(6, 140, 50, 0.8);
      border-radius: 2px;
      top: 50%;
      transform: translateY(-50%);
      z-index: -1;
    }
    .bond-range-slider input[type="range"] {
      position: absolute;
      width: 100%;
      height: 16px;
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      pointer-events: none;
    }
    .bond-range-slider input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      border: 1px solid #ccc;
      cursor: pointer;
      pointer-events: auto;
      margin-top: -6px;
    }
    .bond-range-slider input[type="range"]::-moz-range-thumb {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      border: 1px solid #ccc;
      cursor: pointer;
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);
}
injectDoubleSliderCSS();

export function resetBondLengths() {
  for (const pair in general.defaultBondLengths) {
    general.bondLengths[pair] = { ...general.defaultBondLengths[pair] };
  }
  createBondLengthControls();
  updateVisualization({reRenderOther: false, reRenderComposition: false});
}

export function createBondLengthControls(targetPanel='bondControls') {
  const bondControls = document.getElementById(targetPanel);
  // No target is an expected state now: the Bonds window no longer hosts a
  // #bondControls copy (the controls live in the Structure window's Bonds
  // tab, #infoBondControls), so legacy refresh calls simply no-op.
  if (!bondControls) return;

  if (!fileBrowser.selectedStructure) return;

    // --- Reset wrapper + button ---
  const resetWrapper = document.createElement("div");
  resetWrapper.id = "resetBondLengthsWrapper";
  resetWrapper.className = "buttonWrapper";
  resetWrapper.setAttribute("aria-hidden", "true");
  resetWrapper.style.display = "flex";
  resetWrapper.style.justifyContent = "center";
  resetWrapper.style.gap = "8px";

  const resetBtn = document.createElement("button");
  resetBtn.id = "resetBondLengths";
  resetBtn.className = "reset-btn";
  resetBtn.textContent = "Reset to Defaults";
  resetBtn.style.fontSize = "12px";
  resetBtn.style.marginTop= "2px";
  resetBtn.style.height ="22px";
  resetBtn.onclick = () => {
    resetBondLengths();
    clearAllHighlights();

   };

  const addCustomBondBtn = document.createElement("button");
  addCustomBondBtn.id = "addCustomBond";
  addCustomBondBtn.className = "reset-btn";
  addCustomBondBtn.textContent = "Add Custom Bond";
  addCustomBondBtn.style.fontSize = "12px";
  addCustomBondBtn.style.height = "22px";
  addCustomBondBtn.onclick = () => {
    openDoublePeriodicTable((pair) => {
      if (!general.bondLengths[pair]) {
        const [el1, el2] = pair.split('-');
        const defaultRadius = (atomicRadii[el1] || 1.0) + (atomicRadii[el2] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        general.bondLengths[pair] = { min: 0, max: defaultValue };
        general.defaultBondLengths[pair] = { min: 0, max: defaultValue };
        general.bondVisibility[pair] = true;
        createBondLengthControls(targetPanel);
        updateVisualization({
          reRenderBonds: true,
          reRenderOther: false,
          reRenderComposition: false,
        });
      }
    });
  };

  resetWrapper.appendChild(resetBtn);
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
        const defaultRadius = (atomicRadii[uniqueElements[i]] || 1.0) + (atomicRadii[uniqueElements[j]] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
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

    // Add checkbox for bond visibility
    const checkboxDiv = document.createElement('div');
    checkboxDiv.className = 'bond-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = general.bondVisibility[pair];
    checkbox.title = `Show/hide ${pair} bonds`;
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
    checkboxLabel.textContent = pair; // compact, matching the Atoms/Poly headers
    checkboxLabel.title = `Show/hide ${pair} bonds`;
    checkboxLabel.style.fontSize = '12px';
    checkboxLabel.style.color = '#ccc';
    checkboxLabel.style.margin = '0';
    checkboxLabel.style.cursor = 'pointer';

    // Expand caret toggling the individual-bond list (same style as the
    // Atoms-tab composition rows).
    const expandIcon = document.createElement('span');
    expandIcon.textContent = '▶';
    expandIcon.className = 'bond-expand-icon';
    expandIcon.style.cssText = `
      margin-left: 4px;
      font-size: 14px;
      transition: transform 0.2s ease;
      color: rgba(255,255,255,0.8);
      transform: rotate(0deg);
      cursor: pointer;
    `;

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
    countLabel.style.cssText = 'font-size: 11px; color: #ccc; margin-left: auto;';

    function refreshHeader() {
      const members = memberBonds();
      const colors = members.length
        ? members.map((b) => safeColor(b.color?.[0]))
        : [safeColor(structure()?.bondCategoryStyles?.[pair]?.color ?? '#808080')];
      const dot = createPieDot(colors, 20);
      dot.classList.add('dot');
      dot.style.cursor = 'pointer';
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
    catEditor.style.cssText = 'display: none; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

    // Live edits fan out to every bond of the pair, but SKIP members that have
    // a per-copy override for the same field so individual > category holds
    // live as well as after rebuilds (buildBondObjects re-applies both).
    const currentCatColor = safeColor(structure()?.bondCategoryStyles?.[pair]?.color ?? '#808080');
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
    catAlphaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin: 6px 0;';
    const catAlphaLabel = document.createElement('span');
    catAlphaLabel.textContent = 'Alpha';
    catAlphaLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
    const catAlphaSlider = document.createElement('input');
    catAlphaSlider.type = 'range';
    catAlphaSlider.min = '0.05';
    catAlphaSlider.max = '1';
    catAlphaSlider.step = '0.01';
    catAlphaSlider.value = String(currentCatAlpha);
    catAlphaSlider.style.cssText = 'flex:1;';
    const catAlphaValue = document.createElement('input');
    catAlphaValue.type = 'number';
    catAlphaValue.min = '0.05';
    catAlphaValue.max = '1';
    catAlphaValue.step = '0.01';
    catAlphaValue.value = currentCatAlpha.toFixed(2);
    catAlphaValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
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
    catSizeRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin: 6px 0;';
    const catSizeLabel = document.createElement('span');
    catSizeLabel.textContent = 'Size';
    catSizeLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
    const catSizeSlider = document.createElement('input');
    catSizeSlider.type = 'range';
    catSizeSlider.min = '0.2';
    catSizeSlider.max = '3';
    catSizeSlider.step = '0.05';
    catSizeSlider.value = String(currentCatScale);
    catSizeSlider.style.cssText = 'flex:1;';
    const catSizeValue = document.createElement('input');
    catSizeValue.type = 'number';
    catSizeValue.min = '0.2';
    catSizeValue.max = '3';
    catSizeValue.step = '0.05';
    catSizeValue.value = currentCatScale.toFixed(2);
    catSizeValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
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
    catResetBtn.className = 'btn-mini';
    catResetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';
    catResetBtn.title = `Reset ${pair} bonds: removes the group style AND every individual override`;
    catResetBtn.onclick = (e) => {
      e.stopPropagation();
      delete structure().bondCategoryStyles[pair];
      for (const b of memberBonds()) delete structure().bondUserStyles[bondKey(b.indices)];
      updateVisualization({
        reRenderBonds: true,
        reRenderOther: false,
        reRenderComposition: false,
      });
      refreshExpandedBondLists(bondControls);
      refreshBondHeaders(bondControls);
    };
    const catButtonRow = document.createElement('div');
    catButtonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
    catButtonRow.appendChild(catResetBtn);

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
    checkboxDiv.appendChild(checkbox);
    checkboxDiv.appendChild(dotEl);
    checkboxDiv.appendChild(checkboxLabel);
    checkboxDiv.appendChild(expandIcon);
    checkboxDiv.appendChild(countLabel);
    checkboxDiv.appendChild(keepToggle.wrapper);
    refreshHeader();

    // --- Individual bond list (expandable, lazily built) ---
    const bondsContainer = document.createElement('div');
    bondsContainer.className = 'individual-bonds';
    bondsContainer.style.cssText = `
      display: none;
      margin-left: 20px;
      margin-top: 8px;
      border-left: 2px solid rgba(255,255,255,0.1);
      padding-left: 8px;
    `;

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
        empty.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.5); padding: 4px 0;';
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
    controlsRow.style.display = 'flex';
    controlsRow.style.gap = '8px';
    controlsRow.style.alignItems = 'center';

    // Min value display
    const minValueSpan = document.createElement('span');
    minValueSpan.className = 'slider-value';
    minValueSpan.textContent = `${general.bondLengths[pair].min.toFixed(2)} Å`;
    minValueSpan.style.minWidth = '50px';
    minValueSpan.style.textAlign = 'right';

    // Max value display
    const maxValueSpan = document.createElement('span');
    maxValueSpan.className = 'slider-value';
    maxValueSpan.textContent = `${general.bondLengths[pair].max.toFixed(2)} Å`;
    maxValueSpan.style.minWidth = '50px';
    maxValueSpan.style.textAlign = 'left';

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
    minSlider.style.zIndex = '2';
    sliderContainer.appendChild(minSlider);

    // Max slider
    const maxSlider = /** @type {any} */ (document.createElement('input'));
    maxSlider.type = 'range';
    maxSlider.min = '0';
    maxSlider.max = '6';
    maxSlider.step = '0.1';
    maxSlider.value = general.bondLengths[pair].max;
    maxSlider.style.zIndex = '1';
    sliderContainer.appendChild(maxSlider);

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

      const minPercent = (minVal / 6) * 100;
      const maxPercent = (maxVal / 6) * 100;
      track.style.left = `${minPercent}%`;
      track.style.width = `${maxPercent - minPercent}%`;

      minValueSpan.textContent = `${minVal.toFixed(2)} Å`;
      maxValueSpan.textContent = `${maxVal.toFixed(2)} Å`;
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

    // Initialize track
    const minPercent = (parseFloat(minSlider.value) / 6) * 100;
    const maxPercent = (parseFloat(maxSlider.value) / 6) * 100;
    track.style.left = `${minPercent}%`;
    track.style.width = `${maxPercent - minPercent}%`;

    controlsRow.appendChild(minValueSpan);
    controlsRow.appendChild(sliderContainer);
    controlsRow.appendChild(maxValueSpan);

    div.appendChild(checkboxDiv);
    div.appendChild(catEditor);
    div.appendChild(label);
    div.appendChild(controlsRow);
    div.appendChild(bondsContainer);
    bondControls.appendChild(div);
  });
}
