// The Structure window's "Poly" tab: polyhedra categories (order + atom types,
// e.g. "CuO6") with group styling (color/alpha/visibility), each expandable
// into a lazily-built list of individual polyhedra (see
// StructureInfoPanel/components/IndividualPolyhedronRow.js). Mirrors the Bonds
// tab (BondLengthPanel.js). Polyhedra rebuild asynchronously on every
// updateVisualization, so this panel re-renders itself on the
// 'crysviz:polyhedra-rebuilt' CustomEvent dispatched by render/PolyhedraModule.
import { fileBrowser, general } from '../state/store.js';
import { colorHexToCss, createPieDot } from '../utils/ColorModule.js';
import { createColorPicker } from './ColorPickerModule.js';
import {
  groupPolyhedraByCategory, updatePolyhedraColors, resolvePolyhedronStyle,
} from '../render/index.js';
import { createIndividualPolyhedronRow } from './StructureInfoPanel/components/IndividualPolyhedronRow.js';
import { clampOpacity } from './StructureInfoPanel/components/utils.js';

function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
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
    div.style.cssText = 'font-size: 12px; color: rgba(255,255,255,0.6); padding: 8px 0; text-align: center;';
    div.textContent = text;
    polyControls.appendChild(div);
    return div;
  };

  if (!general.showPolyhedra) {
    hint('Polyhedra are not enabled.');
    const enableWrapper = document.createElement('div');
    enableWrapper.style.cssText = 'display: flex; justify-content: center;';
    const enableBtn = document.createElement('button');
    enableBtn.id = 'enablePolyhedraFromTab';
    enableBtn.className = 'reset-btn';
    enableBtn.textContent = 'Enable polyhedra';
    enableBtn.style.cssText = 'font-size: 12px; height: 22px;';
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

    // --- Header row: visibility checkbox, swatch, label, caret ---
    const headerDiv = document.createElement('div');
    headerDiv.className = 'bond-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = structure.polyhedraCategoryStyles[catKey]?.visible !== false;
    checkbox.title = `Show/hide all ${entry.label} polyhedra`;
    checkbox.onchange = (e) => {
      catStyle().visible = /** @type {any} */ (e.target).checked;
      updatePolyhedraColors();
    };

    const label = document.createElement('label');
    label.textContent = `${entry.label} (${entry.indices.length})`;
    label.style.cssText = 'font-size: 12px; color: #ccc; margin: 0; cursor: pointer;';

    // Expand caret (same style as the Bonds tab)
    const expandIcon = document.createElement('span');
    expandIcon.textContent = '▶';
    expandIcon.className = 'poly-expand-icon';
    expandIcon.style.cssText = `
      margin-left: 4px;
      font-size: 14px;
      transition: transform 0.2s ease;
      color: rgba(255,255,255,0.8);
      transform: rotate(0deg);
      cursor: pointer;
    `;

    // Swatch: pie dot over the members' resolved colors; opens the group editor.
    const memberColors = entry.indices.map((i) => resolvedColorOf(structure, model.polyhedra[i]));
    const dot = createPieDot(memberColors, 20);
    dot.classList.add('dot');
    dot.style.cursor = 'pointer';
    dot.title = `Customize color/alpha for all ${entry.label} polyhedra`;

    headerDiv.appendChild(checkbox);
    headerDiv.appendChild(label);
    headerDiv.appendChild(expandIcon);
    headerDiv.appendChild(dot);
    div.appendChild(headerDiv);

    // --- Group editor (color + alpha for the whole category) ---
    const catEditor = document.createElement('div');
    catEditor.className = 'poly-cat-editor';
    catEditor.style.cssText = 'display: none; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

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
    alphaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin: 6px 0;';
    const alphaLabel = document.createElement('span');
    alphaLabel.textContent = 'Alpha';
    alphaLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
    const alphaSlider = document.createElement('input');
    alphaSlider.type = 'range';
    alphaSlider.min = '0.05';
    alphaSlider.max = '1';
    alphaSlider.step = '0.01';
    alphaSlider.value = String(currentCatAlpha);
    alphaSlider.style.cssText = 'flex:1;';
    const alphaValue = document.createElement('input');
    alphaValue.type = 'number';
    alphaValue.min = '0.05';
    alphaValue.max = '1';
    alphaValue.step = '0.01';
    alphaValue.value = currentCatAlpha.toFixed(2);
    alphaValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
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

    const catResetBtn = document.createElement('button');
    catResetBtn.textContent = 'Reset';
    catResetBtn.className = 'btn-mini';
    catResetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';
    catResetBtn.title = `Reset this whole category: removes the group style AND every individual ${entry.label} override`;
    catResetBtn.onclick = (e) => {
      e.stopPropagation();
      delete structure.polyhedraCategoryStyles[catKey];
      for (const i of entry.indices) {
        delete structure.polyhedraUserStyles[model.polyhedra[i].key];
      }
      updatePolyhedraColors();
      rerenderPreservingExpansion(targetPanel); // refresh swatches everywhere
    };
    const catButtonRow = document.createElement('div');
    catButtonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
    catButtonRow.appendChild(catResetBtn);

    catEditor.appendChild(catPicker.element);
    catEditor.appendChild(alphaRow);
    catEditor.appendChild(catButtonRow);
    div.appendChild(catEditor);

    dot.onclick = (e) => {
      e.stopPropagation();
      catEditor.style.display = (catEditor.style.display === 'none') ? 'block' : 'none';
    };

    // --- Individual polyhedra list (expandable, lazily built) ---
    const listContainer = document.createElement('div');
    listContainer.className = 'individual-polyhedra';
    listContainer.style.cssText = `
      display: none;
      margin-left: 20px;
      margin-top: 8px;
      border-left: 2px solid rgba(255,255,255,0.1);
      padding-left: 8px;
    `;

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
        empty.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.5); padding: 4px 0;';
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
    }
    expandIcon.onclick = togglePolyList;
    label.onclick = togglePolyList;

    div.appendChild(listContainer);
    polyControls.appendChild(div);
  });
}
