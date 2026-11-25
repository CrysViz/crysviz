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
  updatePolyhedra, polyhedronFaceColor, polyhedraElementKeyOf,
} from '../render/index.js';
import { createIndividualPolyhedronRow } from './StructureInfoPanel/components/IndividualPolyhedronRow.js';
import { fillRows, rememberedPage } from './StructureInfoPanel/components/PagedRows.js';
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
  resetPolyhedraColorsIn(structure.polyhedraCategoryStyles, structure.polyhedraElementStyles);
  resetUserPolyhedraColors(structure);
}

/** The individual polyhedron colours of one frame (per-frame overrides). */
function resetUserPolyhedraColors(structure) {
  resetPolyhedraColorsIn(structure.polyhedraUserStyles);
}

function resetPolyhedraColorsIn(...stores) {
  for (const store of stores) {
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
    if (!/** @type {HTMLElement} */ (container).hidden) {
      /** @type {any} */ (container)._populatePolyhedronRows?.(true);
    }
  });
}

/** Re-render the whole panel, preserving which categories are expanded. */
function rerenderPreservingExpansion(panelId = 'infoPolyControls') {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const expanded = [...panel.querySelectorAll('.poly-control')]
    .filter((c) => !/** @type {HTMLElement} */ (c.querySelector('.individual-polyhedra'))?.hidden)
    .map((c) => /** @type {HTMLElement} */ (c).dataset.catKey);
  const groupsOpen = capturePolyGroupExpansion(panel);
  // Editors open at the time (an element row's or a category's colour editor)
  // come back open: a rebuild fired by the colour edit itself (Complete
  // Polyhedra recomputes, a frame rebuild) must not close what is being used.
  const openGroupEditors = [...panel.querySelectorAll('.phl-group[data-group-key]')]
    .filter((g) => /** @type {HTMLElement} */ (g.querySelector('.phl-group-editor'))?.style.display === 'block')
    .map((g) => /** @type {HTMLElement} */ (g).dataset.groupKey);
  const openCatEditors = [...panel.querySelectorAll('.poly-control[data-cat-key]')]
    .filter((c) => { const e = /** @type {HTMLElement} */ (c.querySelector('.poly-cat-editor')); return e && !e.hidden; })
    .map((c) => /** @type {HTMLElement} */ (c).dataset.catKey);
  createPolyhedraListControls(panelId);
  restorePolyGroupExpansion(panel, groupsOpen);
  for (const groupKey of openGroupEditors) {
    const e = /** @type {HTMLElement} */ (panel.querySelector(`.phl-group[data-group-key="${CSS.escape(groupKey)}"] .phl-group-editor`));
    if (e) e.style.display = 'block';
  }
  for (const catKey of openCatEditors) {
    const e = /** @type {HTMLElement} */ (panel.querySelector(`.poly-control[data-cat-key="${CSS.escape(catKey)}"] .poly-cat-editor`));
    if (e) e.hidden = false;
  }
  for (const catKey of expanded) {
    const control = panel.querySelector(`.poly-control[data-cat-key="${catKey}"]`);
    if (!control) continue; // category vanished in the rebuild
    const list = /** @type {HTMLElement} */ (control.querySelector('.individual-polyhedra'));
    const icon = /** @type {HTMLElement} */ (control.querySelector('.poly-expand-icon'));
    /** @type {any} */ (list)?._populatePolyhedronRows?.();
    if (list) list.hidden = false;
    if (icon) icon.classList.add('is-expanded');
  }
}

/** Which element groups (Ca, Ti, Cages) of the Poly tab are open:
 *  { groupKey: true|false }, for every group shown. */
export function capturePolyGroupExpansion(root) {
  const out = {};
  root?.querySelectorAll('.phl-group[data-group-key]').forEach((g) => {
    out[/** @type {HTMLElement} */ (g).dataset.groupKey] =
      /** @type {HTMLElement} */ (g.querySelector('.phl-group-body'))?.style.display !== 'none';
  });
  return out;
}

/** Re-open/close the element groups as capturePolyGroupExpansion saw them
 *  (a group not in `state` keeps its default). */
export function restorePolyGroupExpansion(root, state) {
  for (const [groupKey, open] of Object.entries(state ?? {})) {
    const g = root?.querySelector(`.phl-group[data-group-key="${CSS.escape(groupKey)}"]`);
    /** @type {any} */ (g)?._setExpanded?.(open);
  }
}

/** The element group of a category key: the centre element for a centred
 *  polyhedron ("c:Ca:O8" -> "Ca"), 'cage' for every cage category — also
 *  its key in structure.polyhedraElementStyles. */
const polyGroupKeyOf = polyhedraElementKeyOf;

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
// The element group rows' swatch + eye (derived from their categories), by group key.
const polyGroupUpdateFunctions = {};
document.addEventListener('crysviz:colors-changed', () => {
  Object.values(polyCategorySwatchUpdateFunctions).forEach((updateFn) => updateFn());
  Object.values(polyGroupUpdateFunctions).forEach((updateFn) => updateFn());
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

  // One group row per centre element (and one for the cages), in the order
  // the categories come; its controls act on all of its categories.
  for (const key of Object.keys(polyGroupUpdateFunctions)) delete polyGroupUpdateFunctions[key];
  /** @type {Map<string, {body: HTMLElement, catKeys: string[], syncCategories: (() => void)[]}>} */
  const groupsByKey = new Map();
  for (const catKey of categories.keys()) {
    const groupKey = polyGroupKeyOf(catKey);
    let group = groupsByKey.get(groupKey);
    if (!group) {
      group = { body: null, catKeys: [], syncCategories: [] };
      groupsByKey.set(groupKey, group);
    }
    group.catKeys.push(catKey);
  }
  for (const [groupKey, group] of groupsByKey) {
    group.body = createPolyGroupRow(polyControls, structure, model, categories, groupKey, group);
  }

  categories.forEach((entry, catKey) => {
    const group = groupsByKey.get(polyGroupKeyOf(catKey));
    const div = document.createElement('div');
    div.className = 'poly-control bond-control'; // bond-control reuses the row styling
    div.dataset.catKey = catKey;

    function catStyle() {
      return structure.polyhedraCategoryStyles[catKey] ??= {};
    }
    // The element row's entry (a layer under this category's own style).
    const elStyle = () => structure.polyhedraElementStyles?.[polyGroupKeyOf(catKey)] ?? {};
    const shownNow = () => (structure.polyhedraCategoryStyles[catKey]?.visible ?? elStyle().visible) !== false;

    // --- Header row: visibility toggle, swatch, label, caret ---
    const headerDiv = document.createElement('div');
    headerDiv.className = 'bond-checkbox';

    const { wrapper: checkboxSwitch, input: checkbox } = createMiniToggleSwitch(`Show/hide all ${entry.label} polyhedra`);
    checkbox.checked = shownNow();
    // Shows what the polyhedra do (this category's own setting, else its
    // element row's). A click that differs from the element row sets this
    // category's own override (so one category can be shown while its
    // element is off, or hidden while it is on); one that agrees drops it.
    checkbox.onchange = (e) => {
      const on = /** @type {any} */ (e.target).checked;
      if (on === (elStyle().visible !== false)) delete catStyle().visible;
      else catStyle().visible = on;
      updatePolyhedraColors(); // also refreshes the element group's eye
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
    // See the matching comment on listContainer.hidden below.
    catEditor.hidden = true;

    const currentCatColor = safeColor(
      structure.polyhedraCategoryStyles[catKey]?.color ?? memberColors[0]);
    const catPicker = createColorPicker(currentCatColor, (hex) => {
      // Individual overrides still win over this (documented precedence).
      catStyle().color = hex;
      updatePolyhedraColors();
      refreshExpandedPolyhedraLists(polyControls);
    });

    const currentCatAlpha = clampOpacity(structure.polyhedraCategoryStyles[catKey]?.alpha ?? elStyle().alpha ?? 0.5);
    const alphaRow = document.createElement('div');
    alphaRow.className = 'phl-slider-row';
    const alphaLabel = document.createElement('span');
    alphaLabel.textContent = 'Alpha';
    alphaLabel.className = 'phl-alpha-label';
    const alphaSlider = document.createElement('input');
    alphaSlider.type = 'range';
    alphaSlider.min = '0';
    alphaSlider.max = '1';
    alphaSlider.step = '0.01';
    alphaSlider.value = String(currentCatAlpha);
    alphaSlider.className = 'phl-alpha-slider';
    const alphaValue = document.createElement('input');
    alphaValue.type = 'number';
    alphaValue.min = '0';
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

    const currentEdgeAlpha = clampOpacity(resolvedEdge.edgeOpacity);
    const edgeAlphaRow = document.createElement('div');
    edgeAlphaRow.className = 'phl-slider-row';
    const edgeAlphaLabel = document.createElement('span');
    edgeAlphaLabel.textContent = 'Edge alpha';
    edgeAlphaLabel.className = 'phl-edge-alpha-label';
    const edgeAlphaSlider = document.createElement('input');
    edgeAlphaSlider.type = 'range';
    edgeAlphaSlider.min = '0';
    edgeAlphaSlider.max = '1';
    edgeAlphaSlider.step = '0.01';
    edgeAlphaSlider.value = String(currentEdgeAlpha);
    edgeAlphaSlider.className = 'phl-alpha-slider';
    const edgeAlphaValue = document.createElement('input');
    edgeAlphaValue.type = 'number';
    edgeAlphaValue.min = '0';
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
    catResetBtn.title = `Reset this category: removes the group style (whole trajectory) and every individual ${entry.label} override on this frame.\nPress and hold: also clears the individual overrides on every frame.`;
    // Preview the category's default (pre-override) face color, same idea as
    // the element editor's Reset swatch.
    const representative = model.polyhedra[entry.indices[0]];
    if (representative) {
      const defColor = safeColor(polyhedronFaceColor(representative.type, representative.centerIndex, representative.colorElem));
      catResetBtn.classList.add('is-swatch'); // dark hairline (styles.css)
      catResetBtn.style.background = defColor;
      catResetBtn.style.color = textColorForBg(defColor);
    }
    // The group style is one for the whole trajectory (the trajectory's
    // shared styles, model/materializeFrame.js SHARED_STYLE_DICTS): one
    // delete on the shown frame resets it everywhere. Individual overrides
    // are per frame.
    function resetCategoryOnFrame(frame) {
      delete frame.polyhedraCategoryStyles?.[catKey];
      resetMembersOnFrame(frame);
    }
    function resetMembersOnFrame(frame) {
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
        applyToOtherTrajectoryFrames(structure, resetMembersOnFrame);
        updatePolyhedraColors();
        rerenderPreservingExpansion(targetPanel); // refresh swatches everywhere
      },
    });

    const catApplyBtn = document.createElement('button');
    catApplyBtn.textContent = 'Apply';
    catApplyBtn.className = 'btn-mini highlight phl-cat-square-btn';
    // A category style already applies to every frame of a trajectory.
    catApplyBtn.title = 'Close. The group style applies to every trajectory frame.';
    catApplyBtn.onclick = (e) => {
      e.stopPropagation();
      catEditor.hidden = true;
    };

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
      catEditor.hidden = !catEditor.hidden;
    };

    // --- Individual polyhedra list (expandable, lazily built) ---
    const listContainer = document.createElement('div');
    listContainer.className = 'individual-polyhedra phl-individual-list';
    // Closed until expanded: .hidden is the open/closed state read back here
    // and by StructureInfoPanel/General.js's expand-state capture.
    listContainer.hidden = true;

    // Lazy + stale-aware (general.polyhedraBuildCounter bumps on every group
    // swap). `force` repopulates even when not stale — used after in-place
    // style resets, which don't rebuild the polyhedra. A long list shows one
    // page of rows (StructureInfoPanel/components/PagedRows.js);
    // _showPolyhedronRow brings up a polyhedron's page.
    let builtForBuildId = -1;
    let polyRows = null;
    let polyEntries = [];
    // isFocus: a test for the entry whose page to open on.
    function populatePolyhedronRows(force = false, isFocus = null) {
      if (!force && builtForBuildId === general.polyhedraBuildCounter) return;
      builtForBuildId = general.polyhedraBuildCounter;
      listContainer.innerHTML = '';
      // "Link periodic copies" on: one row per physical polyhedron — periodic
      // image copies grouped by poly.groupKey, edits/selection fan out to all.
      const linking = general.linkPeriodicCopies !== false;
      const entries = []; // [polyIndex, position] unlinked, [representative, position, members, groupKey] linked
      if (!linking) {
        entry.indices.forEach((polyIndex, pos) => {
          if (model.polyhedra[polyIndex]) entries.push([polyIndex, pos + 1]);
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
        for (const [gk, members] of groupsMap) entries.push([members[0], ++pos, members, gk]);
      }
      polyEntries = entries;
      polyRows = fillRows(listContainer, entries.length, (k) => {
        const [polyIndex, pos, members, gk] = entries[k];
        return members
          ? createIndividualPolyhedronRow(model.polyhedra[polyIndex], polyIndex, pos,
            { linkedPolyIndexes: members, groupKey: gk })
          : createIndividualPolyhedronRow(model.polyhedra[polyIndex], polyIndex, pos);
      }, {
        noun: 'polyhedra',
        ...rememberedPage(structure, `polyhedra:${catKey}`),
        focus: isFocus ? entries.findIndex(isFocus) : -1,
      });
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'phl-empty-list-msg';
        empty.textContent = 'No polyhedra in this category';
        listContainer.appendChild(empty);
      }
    }
    /** @type {any} */ (listContainer)._showPolyhedronRow = (key, groupKey = null) => {
      const isFocus = ([polyIndex, , , gk]) => (groupKey
        ? gk === groupKey
        : model.polyhedra[polyIndex]?.key === key);
      if (builtForBuildId !== general.polyhedraBuildCounter) populatePolyhedronRows(false, isFocus);
      else polyRows.showItem(polyEntries.findIndex(isFocus));
    };
    /** @type {any} */ (listContainer)._populatePolyhedronRows = populatePolyhedronRows;

    function togglePolyList(e) {
      e.stopPropagation();
      const isExpanded = !listContainer.hidden;
      if (!isExpanded) populatePolyhedronRows(); // build rows lazily on first expand
      listContainer.hidden = isExpanded;
      expandIcon.classList.toggle('is-expanded', !isExpanded);
      catEditor.hidden = true; // expanding/collapsing closes the category color editor
    }
    expandIcon.onclick = togglePolyList;
    label.onclick = togglePolyList;

    // The element group row wrote this category's style: show it here.
    group.syncCategories.push(() => {
      const st = structure.polyhedraCategoryStyles[catKey] ?? {};
      checkbox.checked = shownNow();
      // (Its colour pickers are left alone: setHex would write back through
      // their onChange, once per category.)
      const a = clampOpacity(st.alpha ?? elStyle().alpha ?? 0.5);
      alphaSlider.value = String(a);
      alphaValue.value = a.toFixed(2);
      const ea = clampOpacity(resolvePolyhedronStyle(
        structure, null, catKey, p0.type, p0.centerIndex, p0.colorElem).edgeOpacity);
      edgeAlphaSlider.value = String(ea);
      edgeAlphaValue.value = ea.toFixed(2);
    });

    div.appendChild(listContainer);
    group.body.appendChild(div);
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
  resetPolyColorsBtn.title = 'Reset every polyhedra color customization to element defaults: category colors (whole trajectory) and individual colors on this frame.\nPress and hold: also clears the individual colors on every frame.';
  wirePressHoldPopup(resetPolyColorsBtn, {
    holdLabel: 'Reset Trajectory',
    onPress: () => {
      resetAllPolyhedraColors(structure);
      updatePolyhedraColors();
      rerenderPreservingExpansion(targetPanel);
    },
    onConfirm: () => {
      resetAllPolyhedraColors(structure);
      applyToOtherTrajectoryFrames(structure, resetUserPolyhedraColors);
      updatePolyhedraColors();
      rerenderPreservingExpansion(targetPanel);
    },
  });
  resetColorsRow.appendChild(resetPolyColorsBtn);
  polyControls.appendChild(resetColorsRow);
}

/** One alpha row (label, slider, number field) of a group editor. */
function createAlphaRow(text, labelClass, initial, onValue) {
  const row = document.createElement('div');
  row.className = 'phl-slider-row';
  const label = document.createElement('span');
  label.textContent = text;
  label.className = labelClass;
  const slider = document.createElement('input');
  Object.assign(slider, { type: 'range', min: '0', max: '1', step: '0.01', className: 'phl-alpha-slider' });
  const field = document.createElement('input');
  Object.assign(field, { type: 'number', min: '0', max: '1', step: '0.01', className: 'phl-alpha-value-input' });
  const show = (v) => { slider.value = String(v); field.value = v.toFixed(2); };
  show(initial);
  const apply = (raw) => { const v = clampOpacity(raw); show(v); onValue(v); };
  slider.oninput = () => apply(slider.value);
  field.oninput = () => apply(field.value);
  row.append(label, slider, field);
  return row;
}

/**
 * The group row of one centre element (or of the cages): caret, eye, swatch
 * (opening a colour/alpha/edge editor), symbol and counts. Its controls write
 * the element's entry in structure.polyhedraElementStyles (whole trajectory,
 * a layer under the category styles — so it also reaches categories that
 * appear later, at a full rebuild of another frame) and drop the same field
 * from its categories' own entries, so that the element setting is what all
 * of them show. Returns the body the category rows go into.
 */
function createPolyGroupRow(polyControls, structure, model, categories, groupKey, group) {
  const { catKeys } = group;
  const title = groupKey === 'cage' ? 'Cages' : groupKey;
  const indicesOf = () => catKeys.flatMap((k) => categories.get(k)?.indices ?? []);
  const nPolys = indicesOf().length;
  structure.polyhedraElementStyles ??= {};
  const elStyle = () => (structure.polyhedraElementStyles[groupKey] ??= {});
  // Every category of this element in the (trajectory-wide) store, also the
  // ones not on this frame.
  const ownCatKeys = () => Object.keys(structure.polyhedraCategoryStyles)
    .filter((k) => polyGroupKeyOf(k) === groupKey);

  const wrap = document.createElement('div');
  wrap.className = 'phl-group';
  wrap.dataset.groupKey = groupKey;

  const header = document.createElement('div');
  header.className = 'bond-checkbox phl-group-header';

  const { wrapper: eyeSwitch, input: eye } = createMiniToggleSwitch(`Show/hide all ${title} polyhedra`);
  eye.classList.add('phl-group-eye');

  const dot = createPieDot(['#808080'], 20);
  dot.classList.add('dot', 'phl-cat-dot', 'phl-group-dot');
  dot.title = `Customize color/alpha for all ${title} polyhedra`;

  const label = document.createElement('label');
  label.className = 'phl-cat-label phl-group-label';
  label.textContent = title;

  const caret = document.createElement('span');
  caret.textContent = '▶';
  caret.className = 'phl-expand-icon phl-group-expand-icon';

  const count = document.createElement('span');
  count.className = 'phl-count-label phl-group-count';
  count.textContent = `${nPolys} ${nPolys === 1 ? 'polyhedron' : 'polyhedra'}, ${catKeys.length} ${catKeys.length === 1 ? 'type' : 'types'}`;

  header.append(eyeSwitch, dot, label, caret, count);
  wrap.appendChild(header);

  // The eye: on when the element is shown and none of its categories
  // overrides that to hidden, off when it is hidden and none overrides to
  // shown, half-way otherwise. The swatch is a pie of the members' colours.
  function refresh() {
    const elShown = structure.polyhedraElementStyles[groupKey]?.visible !== false;
    const overridden = catKeys.some((k) => {
      const v = structure.polyhedraCategoryStyles[k]?.visible;
      return v != null && v !== elShown;
    });
    eye.checked = elShown && !overridden;
    eye.indeterminate = overridden;
    updatePieDot(dot, indicesOf().map((i) => resolvedColorOf(structure, model.polyhedra[i])));
  }
  polyGroupUpdateFunctions[groupKey] = refresh;

  function writeElement(field, value) {
    elStyle()[field] = value;
    for (const k of ownCatKeys()) delete structure.polyhedraCategoryStyles[k][field];
    group.syncCategories.forEach((fn) => fn());
    updatePolyhedraColors(); // fires colors-changed: swatches and this row refresh
  }
  eye.onchange = () => writeElement('visible', eye.checked);

  // --- Group editor: colour, alpha, edge colour, edge alpha, Reset ---
  const editor = document.createElement('div');
  editor.className = 'phl-cat-editor phl-group-editor';
  editor.style.display = 'none';
  const firstCat = categories.get(catKeys[0]);
  const p0 = model.polyhedra[firstCat.indices[0]];
  const st0 = structure.polyhedraElementStyles[groupKey] ?? {};
  const resolved0 = resolvePolyhedronStyle(structure, null, catKeys[0], p0.type, p0.centerIndex, p0.colorElem);
  const picker = createColorPicker(safeColor(st0.color ?? resolved0.color), (hex) => {
    writeElement('color', hex);
    refreshExpandedPolyhedraLists(polyControls);
  });
  const alphaRow = createAlphaRow('Alpha', 'phl-alpha-label',
    clampOpacity(st0.alpha ?? resolved0.opacity), (v) => writeElement('alpha', v));
  const edgeHeader = document.createElement('div');
  edgeHeader.textContent = 'Edge';
  edgeHeader.className = 'phl-edge-header';
  const edgePicker = createColorPicker(safeColor(st0.edgeColor ?? resolved0.edgeColor), (hex) => writeElement('edgeColor', hex));
  const edgeAlphaRow = createAlphaRow('Edge alpha', 'phl-edge-alpha-label',
    clampOpacity(st0.edgeAlpha ?? resolved0.edgeOpacity), (v) => writeElement('edgeAlpha', v));
  const buttonRow = document.createElement('div');
  buttonRow.className = 'phl-cat-button-row';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini phl-cat-square-btn phl-group-reset';
  resetBtn.title = `Reset every ${title} polyhedra style: the ${title} row's and its categories' (whole trajectory). Individual polyhedra keep theirs.`;
  resetBtn.onclick = (e) => {
    e.stopPropagation();
    delete structure.polyhedraElementStyles[groupKey];
    for (const k of ownCatKeys()) delete structure.polyhedraCategoryStyles[k];
    updatePolyhedraColors();
    rerenderPreservingExpansion(polyControls.id);
  };
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Apply';
  closeBtn.className = 'btn-mini highlight phl-cat-square-btn';
  closeBtn.title = `Close. The style applies to every ${title} category, also ones found later, on every trajectory frame.`;
  closeBtn.onclick = (e) => { e.stopPropagation(); editor.style.display = 'none'; };
  buttonRow.append(resetBtn, closeBtn);
  editor.append(picker.element, alphaRow, edgeHeader, edgePicker.element, edgeAlphaRow, buttonRow);
  wrap.appendChild(editor);
  dot.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = editor.style.display === 'none' ? 'block' : 'none';
  };

  // --- Body: the category rows. Open by default when there is one category.
  const body = document.createElement('div');
  body.className = 'phl-group-body';
  wrap.appendChild(body);
  function setExpanded(open) {
    body.style.display = open ? 'block' : 'none';
    caret.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
  }
  /** @type {any} */ (wrap)._setExpanded = setExpanded;
  setExpanded(catKeys.length === 1);
  const toggle = (e) => {
    e.stopPropagation();
    setExpanded(body.style.display === 'none');
    editor.style.display = 'none';
  };
  caret.onclick = toggle;
  label.onclick = toggle;

  refresh();
  polyControls.appendChild(wrap);
  return body;
}
