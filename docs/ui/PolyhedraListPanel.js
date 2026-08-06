// The Structure window's "Poly" tab: polyhedra categories (order + atom types,
// e.g. "CuO6") with group styling (color/alpha/visibility), each expandable
// into a lazily-built list of individual polyhedra (see
// StructureInfoPanel/components/IndividualPolyhedronRow.js). Mirrors the Bonds
// tab (BondLengthPanel.js). Polyhedra rebuild asynchronously on every
// updateVisualization, so this panel re-renders itself on the
// 'crysviz:polyhedra-rebuilt' CustomEvent dispatched by render/PolyhedraModule.
import { fileBrowser, general } from '../state/store.js';
import { colorHexToCss, createPieDot, updatePieDot } from '../utils/ColorModule.js';
import { createColorPicker } from './ColorPickerModule.js';
import {
  groupPolyhedraByCategory, updatePolyhedraColors, resolvePolyhedronStyle,
  updatePolyhedra, polyhedronFaceColor,
} from '../render/index.js';
import { createIndividualPolyhedronRow } from './StructureInfoPanel/components/IndividualPolyhedronRow.js';
import { createMaterialEditor } from './StructureInfoPanel/components/MaterialEditor.js';
import { createTinyImmunityToggle } from './StructureInfoPanel/components/Immunity.js';
import {
  clampOpacity, applyToOtherTrajectoryFrames, wirePressHoldPopup, createMiniToggleSwitch,
} from './StructureInfoPanel/components/utils.js';

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

/** Reset every polyhedra COLOR customization (category + individual) on one
 *  structure/frame back to defaults; alpha/edgeAlpha/material overrides
 *  survive (mirrors resetAllColorStyling's atom-side semantics in
 *  General.js). Pure data — no mesh/render calls — so it's safe to re-run
 *  against off-screen trajectory frames too. */
function resetAllPolyhedraColors(structure) {
  for (const store of [structure.polyhedraCategoryStyles, structure.polyhedraUserStyles]) {
    if (!store) continue;
    for (const [key, entry] of Object.entries(store)) {
      delete entry.color;
      delete entry.edgeColor;
      if (entry.alpha == null && entry.edgeAlpha == null && entry.material == null && entry.visible == null) {
        delete store[key];
      }
    }
  }
}

/** Resolved face color of a model polyhedron (for swatches). */
function resolvedColorOf(structure, poly) {
  return safeColor(resolvePolyhedronStyle(
    structure, poly.key, poly.catKey, poly.type, poly.centerIndex, poly.colorElem).color);
}

// Re-populate the individual-polyhedron lists of any *expanded* category rows
// (styles changed in place). Collapsed lists refresh lazily on next expand.
export function refreshExpandedPolyhedraLists(panelRoot) {
  panelRoot.querySelectorAll('.individual-polyhedra').forEach((container) => {
    if (/** @type {HTMLElement} */ (container).style.display !== 'none') {
      /** @type {any} */ (container)._populatePolyhedronRows?.(true);
    }
  });
}

/** Re-render the whole panel, preserving which categories are expanded. */
function rerenderPreservingExpansion(panelId = 'infoPolyControls') {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const expanded = [...panel.querySelectorAll('.poly-control')]
    .filter((c) => /** @type {HTMLElement} */ (c.querySelector('.individual-polyhedra'))?.style.display !== 'none')
    .map((c) => /** @type {HTMLElement} */ (c).dataset.catKey);
  createPolyhedraListControls(panelId);
  for (const catKey of expanded) {
    const control = panel.querySelector(`.poly-control[data-cat-key="${catKey}"]`);
    if (!control) continue; // category vanished in the rebuild
    const list = /** @type {HTMLElement} */ (control.querySelector('.individual-polyhedra'));
    const icon = /** @type {HTMLElement} */ (control.querySelector('.poly-expand-icon'));
    /** @type {any} */ (list)?._populatePolyhedronRows?.();
    if (list) list.style.display = 'block';
    if (icon) icon.style.transform = 'rotate(90deg)';
  }
}

// The polyhedra group was swapped or cleared (async) — refresh the panel.
document.addEventListener('crysviz:polyhedra-rebuilt', () => {
  rerenderPreservingExpansion();
});

// A pure recolor (atom color-map dropdown, mode switch, color-bar limits,
// individual edits) only fires crysviz:colors-changed, not
// crysviz:polyhedra-rebuilt — so category pie dots went stale the same way
// the Bonds tab's did. Keyed by catKey so re-creating a category overwrites
// its own entry instead of accumulating stale closures.
const polyCategorySwatchUpdateFunctions = {};
document.addEventListener('crysviz:colors-changed', () => {
  Object.values(polyCategorySwatchUpdateFunctions).forEach((updateFn) => updateFn());
});

export function createPolyhedraListControls(targetPanel = 'infoPolyControls') {
  const polyControls = document.getElementById(targetPanel);
  if (!polyControls) return;
  // Idempotent (unlike createBondLengthControls): the rebuilt event re-runs
  // this into the same div, so clear previous content first.
  polyControls.innerHTML = '';

  const structure = fileBrowser.selectedStructure;
  if (!structure) return;

  const hint = (text) => {
    const div = document.createElement('div');
    div.className = 'phl-hint';
    div.textContent = text;
    polyControls.appendChild(div);
    return div;
  };

  if (!general.showPolyhedra) {
    hint('Polyhedra are not enabled.');
    const enableWrapper = document.createElement('div');
    enableWrapper.className = 'phl-enable-wrapper';
    const enableBtn = document.createElement('button');
    enableBtn.id = 'enablePolyhedraFromTab';
    enableBtn.className = 'reset-btn phl-enable-btn';
    enableBtn.textContent = 'Enable polyhedra';
    // Drive the real "Show Polyhedra" checkbox so the ControlsWiring path runs.
    enableBtn.onclick = () => document.getElementById('showPolyhedra')?.click();
    enableWrapper.appendChild(enableBtn);
    polyControls.appendChild(enableWrapper);
    return;
  }

  const model = structure.polyhedra;
  if (!model?.polyhedra?.length) {
    // Compute is async — the rebuilt event re-renders this panel when it lands.
    hint('No polyhedra (still computing, or none found).');
    return;
  }

  const categories = groupPolyhedraByCategory(structure);

  categories.forEach((entry, catKey) => {
    const div = document.createElement('div');
    div.className = 'poly-control bond-control'; // bond-control reuses the row styling
    div.dataset.catKey = catKey;

    function catStyle() {
      return structure.polyhedraCategoryStyles[catKey] ??= {};
    }

    // --- Header row: visibility toggle, swatch, label, caret ---
    const headerDiv = document.createElement('div');
    headerDiv.className = 'bond-checkbox';

    const { wrapper: checkboxSwitch, input: checkbox } = createMiniToggleSwitch(`Show/hide all ${entry.label} polyhedra`);
    checkbox.checked = structure.polyhedraCategoryStyles[catKey]?.visible !== false;
    checkbox.onchange = (e) => {
      catStyle().visible = /** @type {any} */ (e.target).checked;
      updatePolyhedraColors();
    };

    const label = document.createElement('label');
    label.textContent = entry.label;
    // Explicit, scale-respecting size matching the Atoms tab's element-symbol
    // label, so both stay identical regardless of viewport width instead of
    // relying on the ambient cascade (global `label` rule here vs. Atoms'
    // `.comp-row` narrow-viewport override there).
    label.className = 'phl-cat-label';

    // Count + percentage, matching the Atoms/Bonds headers.
    const totalPolys = model.polyhedra.length || 1;
    const countLabel = document.createElement('span');
    countLabel.className = 'poly-count phl-count-label';
    countLabel.textContent = `${entry.indices.length} (${(100 * entry.indices.length / totalPolys).toFixed(1)}%)`;

    // Cut-plane immunity (parity with the Atoms header): the compute drops
    // polyhedra whose center OR vertex atoms are cut, so immunity is applied
    // to ALL of the category's member atoms (center + vertex sources) via the
    // existing atom mechanism — shared state with the Atoms tab toggles, and
    // the polyhedron stays visually complete (its atoms survive the cut too).
    const memberAtomIndices = [...new Set(entry.indices.flatMap((i) => {
      const p = model.polyhedra[i];
      return p ? [p.centerIndex, ...(p.vertexSrcList ?? [])] : [];
    }).filter(Number.isInteger))];
    const keepToggle = createTinyImmunityToggle(memberAtomIndices,
      `Keep ${entry.label} polyhedra visible across cut planes (marks their atoms immune)`);
    // Runs after the component's own listener (registration order): the
    // immunity flags are set first, then the polyhedra recompute picks them up.
    keepToggle.toggle.addEventListener('change', () => updatePolyhedra());

    // Expand caret (same style as the Bonds tab)
    const expandIcon = document.createElement('span');
    expandIcon.textContent = '▶';
    expandIcon.className = 'poly-expand-icon phl-expand-icon';

    // Swatch: pie dot over the members' resolved colors; opens the group editor.
    const memberColors = entry.indices.map((i) => resolvedColorOf(structure, model.polyhedra[i]));
    const dot = createPieDot(memberColors, 20);
    // Match the Atoms tab's dot size (the shared .dot CSS class alone
    // renders at 10x10 — this row never overrode it, unlike CompositionRow.js).
    dot.classList.add('dot', 'phl-cat-dot');
    dot.title = `Customize color/alpha for all ${entry.label} polyhedra`;
    polyCategorySwatchUpdateFunctions[catKey] = () => {
      updatePieDot(dot, entry.indices.map((i) => resolvedColorOf(structure, model.polyhedra[i])));
    };

    // Uniform header order across tabs: checkbox, dot, label, caret, count, immunity.
    headerDiv.appendChild(checkboxSwitch);
    headerDiv.appendChild(dot);
    headerDiv.appendChild(label);
    headerDiv.appendChild(expandIcon);
    headerDiv.appendChild(countLabel);
    headerDiv.appendChild(keepToggle.wrapper);
    div.appendChild(headerDiv);

    // --- Group editor (color + alpha for the whole category) ---
    const catEditor = document.createElement('div');
    catEditor.className = 'poly-cat-editor phl-cat-editor';
    // See the matching comment on listContainer.style.display below.
    catEditor.style.display = 'none';

    const currentCatColor = safeColor(
      structure.polyhedraCategoryStyles[catKey]?.color ?? memberColors[0]);
    const catPicker = createColorPicker(currentCatColor, (hex) => {
      // Individual overrides still win over this (documented precedence).
      catStyle().color = hex;
      updatePolyhedraColors();
      refreshExpandedPolyhedraLists(polyControls);
    });

    const currentCatAlpha = clampOpacity(structure.polyhedraCategoryStyles[catKey]?.alpha ?? 0.5);
    const alphaRow = document.createElement('div');
    alphaRow.className = 'phl-slider-row';
    const alphaLabel = document.createElement('span');
    alphaLabel.textContent = 'Alpha';
    alphaLabel.className = 'phl-alpha-label';
    const alphaSlider = document.createElement('input');
    alphaSlider.type = 'range';
    alphaSlider.min = '0.05';
    alphaSlider.max = '1';
    alphaSlider.step = '0.01';
    alphaSlider.value = String(currentCatAlpha);
    alphaSlider.className = 'phl-alpha-slider';
    const alphaValue = document.createElement('input');
    alphaValue.type = 'number';
    alphaValue.min = '0.05';
    alphaValue.max = '1';
    alphaValue.step = '0.01';
    alphaValue.value = currentCatAlpha.toFixed(2);
    alphaValue.className = 'phl-alpha-value-input';
    function applyCatAlpha(rawValue) {
      const value = clampOpacity(rawValue);
      alphaSlider.value = String(value);
      alphaValue.value = value.toFixed(2);
      catStyle().alpha = value;
      updatePolyhedraColors();
    }
    alphaSlider.oninput = (e) => applyCatAlpha(/** @type {any} */ (e.target).value);
    alphaValue.oninput = (e) => applyCatAlpha(/** @type {any} */ (e.target).value);
    alphaRow.appendChild(alphaLabel);
    alphaRow.appendChild(alphaSlider);
    alphaRow.appendChild(alphaValue);

    // --- Edge styling (color + alpha for the edge lines of the whole category) ---
    const p0 = model.polyhedra[entry.indices[0]];
    const resolvedEdge = resolvePolyhedronStyle(
      structure, null, catKey, p0.type, p0.centerIndex, p0.colorElem);

    const edgeHeader = document.createElement('div');
    edgeHeader.textContent = 'Edge';
    edgeHeader.className = 'phl-edge-header';

    const edgePicker = createColorPicker(safeColor(resolvedEdge.edgeColor), (hex) => {
      catStyle().edgeColor = hex;
      updatePolyhedraColors();
    });

    const currentEdgeAlpha = clampOpacity(
      structure.polyhedraCategoryStyles[catKey]?.edgeAlpha ?? resolvedEdge.edgeOpacity);
    const edgeAlphaRow = document.createElement('div');
    edgeAlphaRow.className = 'phl-slider-row';
    const edgeAlphaLabel = document.createElement('span');
    edgeAlphaLabel.textContent = 'Edge alpha';
    edgeAlphaLabel.className = 'phl-edge-alpha-label';
    const edgeAlphaSlider = document.createElement('input');
    edgeAlphaSlider.type = 'range';
    edgeAlphaSlider.min = '0.05';
    edgeAlphaSlider.max = '1';
    edgeAlphaSlider.step = '0.01';
    edgeAlphaSlider.value = String(currentEdgeAlpha);
    edgeAlphaSlider.className = 'phl-alpha-slider';
    const edgeAlphaValue = document.createElement('input');
    edgeAlphaValue.type = 'number';
    edgeAlphaValue.min = '0.05';
    edgeAlphaValue.max = '1';
    edgeAlphaValue.step = '0.01';
    edgeAlphaValue.value = currentEdgeAlpha.toFixed(2);
    edgeAlphaValue.className = 'phl-alpha-value-input';
    function applyCatEdgeAlpha(rawValue) {
      const value = clampOpacity(rawValue);
      edgeAlphaSlider.value = String(value);
      edgeAlphaValue.value = value.toFixed(2);
      catStyle().edgeAlpha = value;
      updatePolyhedraColors();
    }
    edgeAlphaSlider.oninput = (e) => applyCatEdgeAlpha(/** @type {any} */ (e.target).value);
    edgeAlphaValue.oninput = (e) => applyCatEdgeAlpha(/** @type {any} */ (e.target).value);
    edgeAlphaRow.appendChild(edgeAlphaLabel);
    edgeAlphaRow.appendChild(edgeAlphaSlider);
    edgeAlphaRow.appendChild(edgeAlphaValue);

    const catResetBtn = document.createElement('button');
    catResetBtn.textContent = 'Reset';
    catResetBtn.className = 'btn-mini phl-cat-square-btn';
    catResetBtn.title = `Reset this whole category: removes the group style AND every individual ${entry.label} override.\nClick: this frame. Press and hold: whole trajectory.`;
    // Preview the category's default (pre-override) face color, same idea as
    // the element editor's Reset swatch.
    const representative = model.polyhedra[entry.indices[0]];
    if (representative) {
      const defColor = safeColor(polyhedronFaceColor(representative.type, representative.centerIndex, representative.colorElem));
      catResetBtn.style.background = defColor;
      catResetBtn.style.borderColor = 'rgba(0,0,0,0.2)';
      catResetBtn.style.color = textColorForBg(defColor);
    }
    function resetCategoryOnFrame(frame) {
      delete frame.polyhedraCategoryStyles?.[catKey];
      // A frame that's never been displayed has no polyhedra model yet (and
      // therefore no overrides to clear); use its OWN grouping/keys rather
      // than this frame's, since indices are per-structure.
      const frameEntry = frame === structure ? entry : groupPolyhedraByCategory(frame).get(catKey);
      if (!frameEntry) return;
      const polys = frame.polyhedra?.polyhedra;
      if (!polys) return;
      for (const i of frameEntry.indices) {
        delete frame.polyhedraUserStyles?.[polys[i].key];
      }
    }
    wirePressHoldPopup(catResetBtn, {
      holdLabel: 'Reset Trajectory',
      onPress: (e) => {
        e.stopPropagation();
        resetCategoryOnFrame(structure);
        updatePolyhedraColors();
        rerenderPreservingExpansion(targetPanel);
      },
      onConfirm: (e) => {
        e.stopPropagation();
        resetCategoryOnFrame(structure);
        applyToOtherTrajectoryFrames(structure, resetCategoryOnFrame);
        updatePolyhedraColors();
        rerenderPreservingExpansion(targetPanel); // refresh swatches everywhere
      },
    });

    const catApplyBtn = document.createElement('button');
    catApplyBtn.textContent = 'Apply';
    catApplyBtn.className = 'btn-mini highlight phl-cat-square-btn';
    catApplyBtn.title = `Click: close. Press and hold: copy this ${entry.label} category's color/alpha to every trajectory frame.`;
    wirePressHoldPopup(catApplyBtn, {
      holdLabel: 'Apply to Trajectory',
      onPress: (e) => {
        e.stopPropagation();
        catEditor.style.display = 'none';
      },
      onConfirm: (e) => {
        e.stopPropagation();
        const style = { ...structure.polyhedraCategoryStyles[catKey] };
        applyToOtherTrajectoryFrames(structure, (frame) => {
          frame.polyhedraCategoryStyles ??= {};
          frame.polyhedraCategoryStyles[catKey] = { ...style };
        });
      },
    });

    const catButtonRow = document.createElement('div');
    catButtonRow.className = 'phl-cat-button-row';
    catButtonRow.appendChild(catResetBtn);
    catButtonRow.appendChild(catApplyBtn);

    // Per-category ray/path-tracing material (polyhedraCategoryStyles[catKey].material).
    const catMaterialEditor = createMaterialEditor(
      () => structure.polyhedraCategoryStyles?.[catKey]?.material,
      (material) => {
        if (material) catStyle().material = material;
        else delete catStyle().material;
      });

    catEditor.appendChild(catPicker.element);
    catEditor.appendChild(alphaRow);
    catEditor.appendChild(edgeHeader);
    catEditor.appendChild(edgePicker.element);
    catEditor.appendChild(edgeAlphaRow);
    catEditor.appendChild(catMaterialEditor);
    catEditor.appendChild(catButtonRow);
    div.appendChild(catEditor);

    dot.onclick = (e) => {
      e.stopPropagation();
      catEditor.style.display = (catEditor.style.display === 'none') ? 'block' : 'none';
    };

    // --- Individual polyhedra list (expandable, lazily built) ---
    const listContainer = document.createElement('div');
    listContainer.className = 'individual-polyhedra phl-individual-list';
    // Explicit inline default alongside the CSS class's own `display: none`:
    // this codebase reads `.style.display` back in several places (this
    // file, StructureInfoPanel/General.js's expand-state capture) as the
    // source of truth for open/closed — the CSS class alone would make
    // those reads see '' instead of 'none' before the first toggle.
    listContainer.style.display = 'none';

    // Lazy + stale-aware (general.polyhedraBuildCounter bumps on every group
    // swap). `force` repopulates even when not stale — used after in-place
    // style resets, which don't rebuild the polyhedra.
    let builtForBuildId = -1;
    function populatePolyhedronRows(force = false) {
      if (!force && builtForBuildId === general.polyhedraBuildCounter) return;
      builtForBuildId = general.polyhedraBuildCounter;
      listContainer.innerHTML = '';
      // "Link periodic copies" on: one row per physical polyhedron — periodic
      // image copies grouped by poly.groupKey, edits/selection fan out to all.
      const linking = general.linkPeriodicCopies !== false;
      if (!linking) {
        entry.indices.forEach((polyIndex, pos) => {
          const poly = model.polyhedra[polyIndex];
          if (!poly) return;
          listContainer.appendChild(createIndividualPolyhedronRow(poly, polyIndex, pos + 1));
        });
      } else {
        const groupsMap = new Map(); // groupKey -> member poly indices (insertion order)
        for (const polyIndex of entry.indices) {
          const poly = model.polyhedra[polyIndex];
          if (!poly) continue;
          const gk = poly.groupKey ?? poly.key;
          let members = groupsMap.get(gk);
          if (!members) { members = []; groupsMap.set(gk, members); }
          members.push(polyIndex);
        }
        let pos = 0;
        for (const [gk, members] of groupsMap) {
          pos += 1;
          listContainer.appendChild(createIndividualPolyhedronRow(
            model.polyhedra[members[0]], members[0], pos,
            { linkedPolyIndexes: members, groupKey: gk }));
        }
      }
      if (!listContainer.children.length) {
        const empty = document.createElement('div');
        empty.className = 'phl-empty-list-msg';
        empty.textContent = 'No polyhedra in this category';
        listContainer.appendChild(empty);
      }
    }
    /** @type {any} */ (listContainer)._populatePolyhedronRows = populatePolyhedronRows;

    function togglePolyList(e) {
      e.stopPropagation();
      const isExpanded = listContainer.style.display !== 'none';
      if (!isExpanded) populatePolyhedronRows(); // build rows lazily on first expand
      listContainer.style.display = isExpanded ? 'none' : 'block';
      expandIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
      catEditor.style.display = 'none'; // expanding/collapsing closes the category color editor
    }
    expandIcon.onclick = togglePolyList;
    label.onclick = togglePolyList;

    div.appendChild(listContainer);
    polyControls.appendChild(div);
  });

  // Below every individual polyhedra category — same placement as the Atoms
  // tab's Reset Colors/Reset Styling row below the composition list, and the
  // Bonds tab's Reset Colors row below its category list.
  const resetColorsRow = document.createElement('div');
  resetColorsRow.className = 'phl-reset-colors-row';
  const resetPolyColorsBtn = document.createElement('button');
  resetPolyColorsBtn.id = 'resetPolyColorsBtn';
  resetPolyColorsBtn.textContent = 'Reset Colors';
  resetPolyColorsBtn.className = 'reset-btn phl-reset-colors-btn';
  resetPolyColorsBtn.title = 'Reset every polyhedra color customization (category and individual) to element defaults.\nClick: this frame. Press and hold: whole trajectory.';
  wirePressHoldPopup(resetPolyColorsBtn, {
    holdLabel: 'Reset Trajectory',
    onPress: () => {
      resetAllPolyhedraColors(structure);
      updatePolyhedraColors();
      rerenderPreservingExpansion(targetPanel);
    },
    onConfirm: () => {
      resetAllPolyhedraColors(structure);
      applyToOtherTrajectoryFrames(structure, resetAllPolyhedraColors);
      updatePolyhedraColors();
      rerenderPreservingExpansion(targetPanel);
    },
  });
  resetColorsRow.appendChild(resetPolyColorsBtn);
  polyControls.appendChild(resetColorsRow);
}
