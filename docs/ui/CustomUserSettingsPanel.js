// CustomUserSettingsPanel.js
//
// "Custom User Settings" panel: lets the user override the app's built-in
// per-element color map, per-element atomic-radius map, and per-pair bond-
// distance map - either by loading a JSON file, or by configuring them
// interactively through periodic-table pickers (each of which also has a
// "JSON" tab: an interactive, JSON-shaped listing of every element/pair -
// click a line to edit it, same as clicking a tile). Only elements/pairs the
// user actually touches are recorded as overrides (general.customColorMap,
// general.customAtomicRadii, general.customBondLengths - all sparse); every
// other element/pair keeps using the app's built-in defaults. See
// defaults/color_texture_defaults.js's getElementDefaultColor and
// defaults/radii_defaults.js's getElementRadius, which already consult these
// maps first - this panel is just the UI for populating them.
//
// Bond distances are additionally the *live* general.bondLengths map itself
// (there's no separate "custom" layer in the bonds render pipeline - see
// BondsFracUpdateModule.js's initBondsLengths, which only fills gaps), so
// general.customBondLengths here is bookkeeping only (which pairs the user
// touched, for JSON export/persistence), mirrored into general.bondLengths
// for it to actually render.
//
// Visual convention used throughout: an orange border/text marks something
// the user has overridden; white marks the untouched built-in default.

import { general, fileBrowser } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { downloadBlob } from './SavePanel.js';
import { createBondLengthControls } from './BondLengthPanel.js';
import { openSwatchColorPicker } from './SwatchColorPicker.js';
import { colorHexToCss } from '../utils/ColorModule.js';
import { getElementDefaultColor } from '../defaults/color_texture_defaults.js';
import { getElementRadius } from '../defaults/radii_defaults.js';
import { getContrastingBorder } from './BackgroundPicker.js';
import { syncElementColorMapDropdown } from './ColorPanel.js';
import { elementData, tableLayout, lanthanides, actinides, borderColors, hexToRgb } from './PeriodicTablePickerCore.js';
import { createTabSwitcher } from './TabSwitcher.js';
import { makeSectionHeadline } from './panels/sectionHeadline.js';
import { confirmResetAllShortcuts, getShortcutOverrides, applyShortcutOverrides } from './KeyboardShortcuts.js';

const LS_KEY = 'crysvizCustomUserSettings';
const POPUP_Z = 1300; // above floating panels (1200); child popovers (1400) still layer above this

const OVERRIDE_COLOR = 'rgba(240, 132, 18, 1)'; // orange - the app's existing "user override" accent
const DEFAULT_BORDER = 'rgba(255, 255, 255, 0.55)'; // white - untouched/default
const DEFAULT_TEXT = 'rgba(255, 255, 255, 0.85)';

// ---------------------------------------------------------------------------
// Persistence - one small JSON blob, separate from the panel-layout key
// (matches the app's established convention, e.g. ImageExportPanel.js).
// ---------------------------------------------------------------------------

function saveCustomSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      colorMap: general.customColorMap,
      radiusMap: general.customAtomicRadii,
      bondLengthMap: general.customBondLengths,
    }));
  } catch { /* storage unavailable */ }
  // Every color-map mutation funnels through here, so this is the one place
  // that needs to keep the Visual panel's "Element Color Map" dropdown
  // truthful - it should read "User (custom)" the moment any override exists.
  syncElementColorMapDropdown();
}

function loadCustomSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed?.colorMap) Object.assign(general.customColorMap, parsed.colorMap);
    if (parsed?.radiusMap) Object.assign(general.customAtomicRadii, parsed.radiusMap);
    if (parsed?.bondLengthMap) {
      Object.assign(general.customBondLengths, parsed.bondLengthMap);
      Object.assign(general.bondLengths, parsed.bondLengthMap);
    }
  } catch { /* corrupted/missing -> defaults */ }
  syncElementColorMapDropdown();
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

function parseColorToInt(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
  }
  return null;
}

function normalizeBondEntry(value) {
  if (typeof value === 'number') return { min: 0, max: value };
  if (value && typeof value === 'object' && Number.isFinite(value.max)) {
    return { min: Number.isFinite(value.min) ? value.min : 0, max: value.max };
  }
  return null;
}

function sortedPairKey(el1, el2) {
  return el1 < el2 ? `${el1}-${el2}` : `${el2}-${el1}`;
}

function allElementSymbols() {
  return Object.keys(elementData).sort((a, b) => elementData[a].number - elementData[b].number);
}

// ---------------------------------------------------------------------------
// Apply-to-current-structure - so a change is visible immediately if
// something is already loaded, not just on the next file load.
// ---------------------------------------------------------------------------

function applyColorOverrideLive(element) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  let changed = false;
  structure.atoms.forEach((atom, idx) => {
    if (structure.elements[idx] === element) {
      atom.color = getElementDefaultColor(element);
      atom.elementColor = atom.color;
      atom.defaultColor = atom.color;
      changed = true;
    }
  });
  if (changed) updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
}

function applyRadiusOverrideLive() {
  if (fileBrowser.selectedStructure) {
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
  }
}

function applyBondOverrideLive(pair, entry) {
  general.bondLengths[pair] = entry;
  general.customBondLengths[pair] = entry;
  createBondLengthControls('infoBondControls');
  if (fileBrowser.selectedStructure) {
    updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
  }
}

// ---------------------------------------------------------------------------
// Shared popup chrome
// ---------------------------------------------------------------------------

// A child popover (the swatch color picker) is appended as a sibling of the
// periodic-table popup, not nested inside it - clicking inside it must NOT
// count as "outside" the parent popup.
function isInsideChildPopover(target) {
  return !!target.closest?.('.swatch-color-picker');
}

function closePopupOnOutsideClick(popup, onClose) {
  const outsideClick = (e) => {
    if (popup.contains(e.target) || isInsideChildPopover(e.target)) return;
    document.removeEventListener('mousedown', outsideClick);
    onClose();
  };
  // Deferred so the click that opened the popup doesn't immediately close it.
  setTimeout(() => document.addEventListener('mousedown', outsideClick), 0);
  return () => document.removeEventListener('mousedown', outsideClick);
}

function makePopupShell(title, width = 660) {
  const popup = document.createElement('div');
  popup.style.cssText = `
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: var(--popup-bg, #111); color: var(--panel-fg, #fff); border: 1px solid var(--popup-border, #333); border-radius: 8px;
    z-index: ${POPUP_Z}; padding: 15px; font-family: Arial, sans-serif; width: ${width}px; max-width: calc(100vw - 24px);
    max-height: 85vh; overflow-y: auto;
  `;
  const heading = document.createElement('h3');
  heading.textContent = title;
  heading.style.cssText = 'margin: 0 0 10px 0; text-align: center;';
  popup.appendChild(heading);
  document.body.appendChild(popup);
  return popup;
}

// ---------------------------------------------------------------------------
// Shared periodic-table grid renderer - a callback decides each tile's look
// and click behavior, so the same layout serves the color picker, the radius
// picker, and (in 2-select mode) the bond-pair picker.
// ---------------------------------------------------------------------------

function buildPeriodicGrid({ onTileClick, tileLabel, tileStyle, tileTextColor, tileBorderColor, isSelected }) {
  const wrap = document.createElement('div');

  function makeRow(symbols, cols) {
    const row = document.createElement('div');
    row.style.cssText = `display:grid; grid-template-columns:repeat(${cols}, 32px); gap:2px; justify-content:center; margin-bottom:2px;`;
    symbols.forEach((symbol) => {
      if (!symbol) {
        const spacer = document.createElement('div');
        spacer.style.cssText = 'width:32px; height:32px;';
        row.appendChild(spacer);
        return;
      }
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.dataset.symbol = symbol;
      tile.innerHTML = tileLabel(symbol);
      const extra = tileStyle(symbol) || '';
      const selected = isSelected?.(symbol);
      // Symbol color is computed per-tile against its own background
      // (getContrastingBorder - same luminance-based pick used for the scene
      // background/lattice contrast elsewhere), not a fixed white, since tile
      // backgrounds range from near-black to near-white across elements.
      const textColor = tileTextColor ? tileTextColor(symbol) : '#ffffff';
      const shadow = textColor === '#ffffff'
        ? '0 1px 2px rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.6)'
        : '0 1px 1px rgba(255,255,255,0.5)';
      const borderColor = tileBorderColor ? tileBorderColor(symbol, selected) : (selected ? OVERRIDE_COLOR : DEFAULT_BORDER);
      tile.style.cssText = `
        width:32px; height:32px; border-radius:4px; cursor:pointer;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        font-size:9px; line-height:1.1; color:${textColor}; padding:0;
        text-shadow: ${shadow};
        border:2px solid ${borderColor};
        ${extra}
      `;
      tile.addEventListener('click', () => onTileClick(symbol, tile));
      row.appendChild(tile);
    });
    wrap.appendChild(row);
  }

  tableLayout.forEach((period) => makeRow(period, 18));
  makeRow(lanthanides, 15);
  makeRow(actinides, 15);

  return wrap;
}

// A small inline <input> meant to sit inside a line of JSON-looking text.
// Deliberately a visible box (not a transparent/dashed-underline field) so
// it unambiguously reads as "type here", not as plain text.
function makeInlineInput({ type = 'text', value, width }) {
  const input = document.createElement('input');
  input.type = type;
  if (type === 'number') { input.step = '0.01'; input.min = '0'; input.className = 'coord-input'; }
  if (value != null) input.value = value;
  input.style.cssText = `width:${width}px; background:#333; border:1px solid #555; border-radius:3px; color:#fff; font:inherit; padding:1px 3px; cursor:text;`;
  return input;
}

// Interactive, JSON-shaped listing: one line per key with a directly-typable
// inline input for its value - orange text for an override, white for a
// default. Values are edited by typing (commit on blur/Enter), not by
// opening a picker. `buildRow(key, rowEl, hasTrailingComma)` fills in the
// row's content; an optional `footer` (e.g. an "add a new line" affordance)
// is appended after the closing brace.
function buildJsonListView({ keys, isOverridden, buildRow, emptyText, footer }) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size:12px; max-height:440px; overflow-y:auto; background:var(--input-bg, #0d0d0d); border-radius:6px; padding:10px 14px;';

  if (!keys.length) {
    const empty = document.createElement('div');
    empty.textContent = emptyText || 'Nothing here yet.';
    empty.style.cssText = 'color:rgba(255,255,255,0.5); text-align:center; padding:10px 0;';
    wrap.appendChild(empty);
    if (footer) wrap.appendChild(footer);
    return wrap;
  }

  wrap.appendChild(document.createTextNode('{'));

  keys.forEach((key, i) => {
    const row = document.createElement('div');
    row.style.cssText = `display:flex; align-items:center; flex-wrap:wrap; padding:2px 4px 2px 18px; margin:0 -4px; border-radius:3px; color:${isOverridden(key) ? OVERRIDE_COLOR : DEFAULT_TEXT};`;
    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.07)'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
    buildRow(key, row, i < keys.length - 1);
    wrap.appendChild(row);
  });

  wrap.appendChild(document.createTextNode('}'));
  if (footer) wrap.appendChild(footer);
  return wrap;
}

// ---------------------------------------------------------------------------
// Color: periodic table colored by the currently active scheme (CrysViz or
// JMOL, whichever general.useDefaultColors selects) plus any overrides
// already set - click a tile (or a JSON line) to pick a replacement color.
// ---------------------------------------------------------------------------

function currentColorHex(el) {
  return colorHexToCss(getElementDefaultColor(el));
}

function pickElementColor(anchor, el, onDone) {
  openSwatchColorPicker(anchor, currentColorHex(el), (newHex) => {
    general.customColorMap[el] = parseColorToInt(newHex);
    applyColorOverrideLive(el);
    saveCustomSettings();
    onDone();
  }, {
    onReset: () => {
      delete general.customColorMap[el];
      applyColorOverrideLive(el);
      saveCustomSettings();
      onDone();
    },
  });
}

function openColorPeriodicTable(onChange) {
  const popup = makePopupShell(`Element Colors (currently: ${general.useDefaultColors ? 'CrysViz' : 'JMOL'} + your overrides)`);
  const tabHost = document.createElement('div');
  popup.appendChild(tabHost);

  function renderGrid(container) {
    container.innerHTML = '';
    const grid = buildPeriodicGrid({
      tileLabel: (el) => el,
      tileStyle: (el) => `background:${currentColorHex(el)};`,
      tileTextColor: (el) => getContrastingBorder(currentColorHex(el)),
      isSelected: (el) => Object.prototype.hasOwnProperty.call(general.customColorMap, el),
      onTileClick: (el, tileEl) => pickElementColor(tileEl, el, () => { renderGrid(container); onChange?.(); }),
    });
    container.appendChild(grid);

    const hint = document.createElement('div');
    hint.textContent = 'Click an element to pick its color. Orange marks an override, white is the default.';
    hint.style.cssText = 'text-align:center; font-size:11px; color:rgba(255,255,255,0.6); margin-top:10px;';
    container.appendChild(hint);
  }

  function renderJson(container) {
    container.innerHTML = '';
    container.appendChild(buildJsonListView({
      keys: allElementSymbols(),
      isOverridden: (el) => Object.prototype.hasOwnProperty.call(general.customColorMap, el),
      buildRow: (el, row, hasComma) => {
        const keySpan = document.createElement('span');
        keySpan.textContent = `"${el}": "`;
        const input = makeInlineInput({ type: 'text', value: currentColorHex(el).toUpperCase(), width: 74 });
        const tail = document.createElement('span');
        tail.textContent = `"${hasComma ? ',' : ''}`;

        // Only touch the override map if the value actually changed - just
        // clicking into the field and clicking away (no edit) must not turn
        // a default into an override.
        let beforeEdit = input.value;
        input.addEventListener('focus', () => { beforeEdit = input.value; });

        function commit() {
          if (input.value === beforeEdit) return;
          const num = parseColorToInt(input.value);
          if (num == null) { input.value = beforeEdit; return; }
          general.customColorMap[el] = num;
          applyColorOverrideLive(el);
          saveCustomSettings();
          row.style.color = OVERRIDE_COLOR;
          onChange?.();
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });

        row.appendChild(keySpan);
        row.appendChild(input);
        row.appendChild(tail);
      },
    }));
  }

  createTabSwitcher(tabHost, [
    { id: 'grid', label: 'Periodic Table', render: () => {}, onActivate: renderGrid },
    { id: 'json', label: 'JSON', render: () => {}, onActivate: renderJson },
  ]);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.className = 'btn-mini highlight';
  closeBtn.style.cssText = 'display:block; margin:14px auto 0; padding:5px 20px;';
  closeBtn.addEventListener('click', () => popup.remove());
  popup.appendChild(closeBtn);

  closePopupOnOutsideClick(popup, () => popup.remove());
}

// ---------------------------------------------------------------------------
// Radius: same grid, tiles show the current radius (Å) as text; click opens a
// small floating numeric input next to the anchor (tile or JSON line).
// ---------------------------------------------------------------------------

function radiusCategoryColor(el) {
  return borderColors[el] || borderColors.default;
}

// Orange is already a category border color in this table (alkali metals),
// so it can't also mean "override" without being ambiguous. An override
// instead INVERTS the tile - white background, black text - which no
// category color can be confused with.
function applyRadiusTileVisual(tile, symbol) {
  const overridden = Object.prototype.hasOwnProperty.call(general.customAtomicRadii, symbol);
  tile.style.background = overridden ? '#ffffff' : 'transparent';
  tile.style.borderColor = overridden ? '#ffffff' : radiusCategoryColor(symbol);
  tile.style.color = overridden ? '#000000' : '#ffffff';
}

// Radius grid tiles use the exact same look as the Add Atom/Add Structure
// picker (PeriodicTableSelectPanel.js): transparent tile, 2px border colored
// by chemical category, 12px symbol - element colors are reserved for the
// Color picker, not this one. Each tile also shows its current radius as an
// 8px subscript. Clicking a tile opens the same enlarged "selected element"
// preview that picker uses (atomic number, big symbol, name), with a
// directly-typable radius input next to the symbol.
function buildRadiusGrid({ onTileClick }) {
  const wrap = document.createElement('div');

  function makeRow(symbols, cols) {
    const row = document.createElement('div');
    row.style.cssText = `display:grid; grid-template-columns:repeat(${cols}, 30px); gap:2px; justify-content:center; margin-bottom:2px;`;
    symbols.forEach((symbol) => {
      if (!symbol) {
        const spacer = document.createElement('div');
        spacer.style.cssText = 'width:30px; height:30px;';
        row.appendChild(spacer);
        return;
      }

      const tile = document.createElement('button');
      tile.type = 'button';
      tile.dataset.symbol = symbol;
      tile.style.cssText = `
        width:30px; height:30px; border-radius:3px; cursor:pointer; position:relative; z-index:1;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        border-width:2px; border-style:solid; transition:background 0.2s, border-color 0.2s, color 0.2s, transform 0.2s;
      `;
      applyRadiusTileVisual(tile, symbol);

      const label = document.createElement('div');
      label.textContent = symbol;
      label.style.cssText = 'font-size:12px; line-height:1;';

      const radLabel = document.createElement('div');
      radLabel.className = 'radius-tile-value';
      radLabel.textContent = getElementRadius(symbol).toFixed(2);
      radLabel.style.cssText = 'font-size:8px; opacity:0.85; line-height:1.3;';

      tile.appendChild(label);
      tile.appendChild(radLabel);

      const category = radiusCategoryColor(symbol);
      tile.addEventListener('mouseover', () => {
        tile.style.transform = 'scale(1.2)';
        tile.style.boxShadow = `0 0 12px ${category}`;
        tile.style.zIndex = '2';
      });
      tile.addEventListener('mouseout', () => {
        tile.style.transform = 'scale(1)';
        tile.style.boxShadow = 'none';
        tile.style.zIndex = '1';
      });
      tile.addEventListener('click', () => onTileClick(symbol, tile));

      row.appendChild(tile);
    });
    wrap.appendChild(row);
  }

  tableLayout.forEach((period) => makeRow(period, 18));
  makeRow(lanthanides, 15);
  makeRow(actinides, 15);

  return wrap;
}

function openRadiusPeriodicTable(onChange) {
  const popup = makePopupShell('Element Atomic Radii (Å)');
  const tabHost = document.createElement('div');
  popup.appendChild(tabHost);

  function renderGrid(container) {
    container.innerHTML = '';

    const gridWrap = document.createElement('div');
    gridWrap.style.cssText = 'position:relative;';
    container.appendChild(gridWrap);

    // Enlarged preview, shown once a tile is picked - same shape as the Add
    // Atom picker's own selected-element preview (including the category-
    // color tint), with the radius made a live input right next to the big
    // symbol instead of a static mass value, plus Apply/Reset. Sits a bit
    // left of center (like the Add Atom picker's own preview, at left:40%
    // rather than dead-center) so it doesn't sit directly on top of the
    // element that was just clicked.
    const preview = document.createElement('div');
    preview.style.cssText = `
      display:none; position:absolute; top:0; left:40%; transform:translateX(-50%);
      width:max-content; border-radius:8px;
      border:1px solid transparent; padding:8px; box-sizing:border-box; z-index:2;
    `;
    preview.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; position:relative;">
        <div style="display:flex; flex-direction:column; align-items:center; gap:4px; position:relative;">
          <div class="radius-preview-number" style="position:absolute; top:-4px; left:-4px; font-size:14px; font-weight:normal;"></div>
          <div style="display:flex; align-items:center; gap:6px; margin-top:12px;">
            <span class="radius-preview-symbol" style="font-weight:bold; font-size:24px;"></span>
            <input class="radius-preview-input coord-input" type="number" step="0.01" min="0.05" style="
              width:44px; font-size:12px; text-align:center; background:#222; border:1px solid #555;
              color:white; border-radius:3px; padding:5px 6px;">
            <span style="font-size:11px; color:rgba(255,255,255,0.75);">Å</span>
          </div>
          <div class="radius-preview-name" style="font-size:12px; font-weight:normal; white-space:nowrap;"></div>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px;">
          <button type="button" class="radius-preview-apply btn-mini highlight" style="padding:4px 14px; font-size:11px; white-space:nowrap;">Apply</button>
          <button type="button" class="radius-preview-reset btn-mini" style="padding:4px 14px; font-size:11px; white-space:nowrap;">Reset</button>
        </div>
      </div>
    `;
    gridWrap.appendChild(preview);

    const numberEl = preview.querySelector('.radius-preview-number');
    const symbolEl = preview.querySelector('.radius-preview-symbol');
    const nameEl = preview.querySelector('.radius-preview-name');
    const inputEl = preview.querySelector('.radius-preview-input');
    const applyBtn = preview.querySelector('.radius-preview-apply');
    const resetBtn = preview.querySelector('.radius-preview-reset');
    let activeSymbol = null;
    let beforeEdit = null;

    function refreshTile(symbol) {
      const tile = grid.querySelector(`button[data-symbol="${symbol}"]`);
      if (!tile) return;
      applyRadiusTileVisual(tile, symbol);
      const valueEl = tile.querySelector('.radius-tile-value');
      if (valueEl) valueEl.textContent = getElementRadius(symbol).toFixed(2);
    }

    // Applies unconditionally (used by the Apply button); commit() below
    // only calls this if the value actually changed, so blurring/tabbing
    // away from an untouched field never creates a spurious override.
    function applyValue() {
      const value = parseFloat(inputEl.value);
      if (!Number.isFinite(value) || value <= 0) { inputEl.value = beforeEdit; return; }
      general.customAtomicRadii[activeSymbol] = value;
      applyRadiusOverrideLive();
      saveCustomSettings();
      refreshTile(activeSymbol);
      beforeEdit = inputEl.value;
      onChange?.();
    }
    function commit() {
      if (!activeSymbol || inputEl.value === beforeEdit) return;
      applyValue();
    }
    inputEl.addEventListener('blur', commit);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); inputEl.blur(); } });
    applyBtn.addEventListener('click', () => { if (activeSymbol) applyValue(); });
    resetBtn.addEventListener('click', () => {
      if (!activeSymbol) return;
      delete general.customAtomicRadii[activeSymbol];
      applyRadiusOverrideLive();
      saveCustomSettings();
      inputEl.value = getElementRadius(activeSymbol).toFixed(2);
      beforeEdit = inputEl.value;
      refreshTile(activeSymbol);
      onChange?.();
    });

    function selectSymbol(symbol) {
      const el = elementData[symbol];
      if (!el) return;
      activeSymbol = symbol;
      numberEl.textContent = el.number;
      symbolEl.textContent = symbol;
      nameEl.textContent = el.name;
      inputEl.value = getElementRadius(symbol).toFixed(2);
      beforeEdit = inputEl.value;

      // Same category-color tint as the Add Atom picker's own preview.
      const category = radiusCategoryColor(symbol);
      const { r, g, b } = hexToRgb(category);
      preview.style.background = `rgba(${r}, ${g}, ${b}, 0.3)`;
      preview.style.borderColor = category;

      preview.style.display = 'block';
      inputEl.focus();
      inputEl.select();
    }

    const grid = buildRadiusGrid({ onTileClick: selectSymbol });
    gridWrap.appendChild(grid);

    const hint = document.createElement('div');
    hint.textContent = 'Click an element, then type its radius. An override inverts the tile (white background, black text); the border stays its category color.';
    hint.style.cssText = 'text-align:center; font-size:11px; color:rgba(255,255,255,0.6); margin-top:10px;';
    container.appendChild(hint);
  }

  function renderJson(container) {
    container.innerHTML = '';
    container.appendChild(buildJsonListView({
      keys: allElementSymbols(),
      isOverridden: (el) => Object.prototype.hasOwnProperty.call(general.customAtomicRadii, el),
      buildRow: (el, row, hasComma) => {
        const keySpan = document.createElement('span');
        keySpan.textContent = `"${el}": `;
        const input = makeInlineInput({ type: 'number', value: getElementRadius(el).toFixed(2), width: 54 });
        const tail = document.createElement('span');
        tail.textContent = hasComma ? ',' : '';

        let beforeEdit = input.value;
        input.addEventListener('focus', () => { beforeEdit = input.value; });

        function commit() {
          if (input.value === beforeEdit) return;
          const value = parseFloat(input.value);
          if (!Number.isFinite(value) || value <= 0) { input.value = beforeEdit; return; }
          general.customAtomicRadii[el] = value;
          applyRadiusOverrideLive();
          saveCustomSettings();
          row.style.color = OVERRIDE_COLOR;
          onChange?.();
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });

        row.appendChild(keySpan);
        row.appendChild(input);
        row.appendChild(tail);
      },
    }));
  }

  createTabSwitcher(tabHost, [
    { id: 'grid', label: 'Periodic Table', render: () => {}, onActivate: renderGrid },
    { id: 'json', label: 'JSON', render: () => {}, onActivate: renderJson },
  ]);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.className = 'btn-mini highlight';
  closeBtn.style.cssText = 'display:block; margin:14px auto 0; padding:5px 20px;';
  closeBtn.addEventListener('click', () => popup.remove());
  popup.appendChild(closeBtn);

  closePopupOnOutsideClick(popup, () => popup.remove());
}

// ---------------------------------------------------------------------------
// Bonds: pick two elements on the grid - the periodic table already lists
// every element, so there's no separate "type a pair" entry point to keep in
// sync. The distance editor appears INLINE, in the periodic table's own
// blank rectangle above the transition metals (groups 3-12 are unused in
// periods 1-3 of every standard layout) - picking a pair never swaps the
// grid out for a separate view. Any pair without an existing override gets
// its default computed on the spot (same radius-sum formula
// BondsFracUpdateModule.js's initBondsLengths seeds a loaded structure's
// bonds with), so every pair already has a sensible starting value. The JSON
// tab lists every pair known so far (i.e. already overridden, or already
// seen in a loaded structure) with directly-typable min/max fields.
// ---------------------------------------------------------------------------

// Same default a loaded structure's bonds get seeded with (radius sum,
// capped at 6 A) - used here so a pair with no override yet still starts
// from a sensible value instead of an arbitrary placeholder.
function computeDefaultBondEntry(elA, elB) {
  const max = Math.min(getElementRadius(elA) + getElementRadius(elB), 6.0);
  return { min: 0.0, max };
}

function openBondPairPicker(onChange) {
  const popup = makePopupShell('Bond Distance Overrides');
  const tabHost = document.createElement('div');
  popup.appendChild(tabHost);

  let selected = [];

  function renderPickGrid(container) {
    container.innerHTML = '';

    // Relative wrapper so the inline distance editor can be absolutely
    // positioned over the grid's own blank space instead of navigating away.
    const gridWrap = document.createElement('div');
    gridWrap.style.cssText = 'position:relative;';
    container.appendChild(gridWrap);

    // Same look as the Add Atom/Add Structure picker - transparent tile,
    // border colored by chemical category - not the element's own render
    // color (that's the Color picker's job).
    const grid = buildPeriodicGrid({
      tileLabel: (el) => el,
      tileStyle: () => 'background:transparent;',
      tileBorderColor: (el, isSel) => (isSel ? OVERRIDE_COLOR : radiusCategoryColor(el)),
      isSelected: (el) => selected.includes(el),
      onTileClick: (el) => {
        // Always APPEND (never toggle by value) so clicking the same element
        // twice in a row builds a homonuclear pair (e.g. "Si-Si") instead of
        // deselecting it - a third click starts a fresh pair. Removing a
        // single pending pick is done via its chip in the overlay, not by
        // re-clicking the tile.
        selected = selected.length < 2 ? [...selected, el] : [el];
        refreshTileBorders();
        renderOverlay();
      },
    });
    gridWrap.appendChild(grid);

    // Blank rectangle above the transition metals: groups 3-12, periods 1-3
    // (columns index 2-11, rows 0-2 - see PeriodicTablePickerCore.js's
    // tableLayout, which leaves those slots null for H/He and the two
    // main-group rows). No box chrome (border/shadow/opaque fill) on
    // purpose - this should read as content sitting directly in the table's
    // own empty space, not a separate floating card stacked on top of it.
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:absolute; left:68px; top:0; width:338px; height:100px;
      display:none; flex-direction:column; align-items:center; justify-content:center; gap:4px;
    `;
    gridWrap.appendChild(overlay);

    function refreshTileBorders() {
      grid.querySelectorAll('button[data-symbol]').forEach((tile) => {
        const symbol = tile.dataset.symbol;
        tile.style.borderColor = selected.includes(symbol) ? OVERRIDE_COLOR : radiusCategoryColor(symbol);
      });
    }

    // Chip showing one selected element, same look as an Add Atom tile -
    // transparent, bordered by chemical category, plain white symbol - just
    // bigger so it reads clearly at a glance.
    function elementChip(el, onRemove) {
      const chip = document.createElement('div');
      chip.textContent = el;
      chip.title = 'Click to remove from selection';
      chip.style.cssText = `
        width:40px; height:40px; border-radius:5px; display:flex; align-items:center; justify-content:center;
        font-size:17px; font-weight:700; cursor:pointer; background:transparent; color:#ffffff;
        border:2px solid ${radiusCategoryColor(el)};
      `;
      chip.addEventListener('click', onRemove);
      return chip;
    }

    function renderOverlay() {
      overlay.innerHTML = '';
      if (selected.length < 1) {
        overlay.style.display = 'none';
        return;
      }
      overlay.style.display = 'flex';

      // Click a chip to drop that pick back out of the selection - there's
      // no separate "deselect" button cluttering this up.
      const chipsRow = document.createElement('div');
      chipsRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
      selected.forEach((el, i) => {
        if (i > 0) {
          const dash = document.createElement('span');
          dash.textContent = '–';
          dash.style.cssText = 'font-size:15px; color:rgba(255,255,255,0.7);';
          chipsRow.appendChild(dash);
        }
        chipsRow.appendChild(elementChip(el, () => {
          selected = selected.filter((_, idx) => idx !== i);
          refreshTileBorders();
          renderOverlay();
        }));
      });
      overlay.appendChild(chipsRow);

      if (selected.length < 2) {
        const hint = document.createElement('div');
        hint.textContent = 'Pick a second element - the same one again makes a self-bond (e.g. Si-Si).';
        hint.style.cssText = 'font-size:10px; color:rgba(255,255,255,0.65); text-shadow:0 1px 2px rgba(0,0,0,0.8); text-align:center; max-width:260px;';
        overlay.appendChild(hint);
        return;
      }

      const [elA, elB] = selected;
      const pair = sortedPairKey(elA, elB);
      const existing = general.bondLengths[pair] ?? computeDefaultBondEntry(elA, elB);

      // Distance fields and Confirm sit on the same row, next to each other,
      // to leave the chips room to be bigger without growing the total height.
      const fieldsRow = document.createElement('div');
      fieldsRow.style.cssText = 'display:flex; align-items:center; gap:5px; font-size:10px; color:rgba(255,255,255,0.85); text-shadow:0 1px 2px rgba(0,0,0,0.8);';
      const distLabel = document.createElement('span');
      distLabel.textContent = 'Distance';
      function smallField(value) {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.01';
        input.min = '0';
        input.className = 'coord-input';
        input.value = value.toFixed(2);
        input.style.cssText = 'width:42px; background:#333; border:1px solid #555; color:white; padding:2px; text-align:center; font-size:10px;';
        return input;
      }
      const minInput = smallField(existing.min);
      const maxInput = smallField(existing.max);
      const unit = document.createElement('span');
      unit.textContent = 'Å';

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.textContent = 'Apply';
      applyBtn.className = 'btn-mini highlight';
      applyBtn.style.cssText = 'padding:3px 10px; font-size:10px; margin-left:4px;';
      applyBtn.addEventListener('click', () => {
        const min = parseFloat(minInput.value) || 0;
        const max = parseFloat(maxInput.value) || 0;
        if (max <= 0) return;
        applyBondOverrideLive(pair, { min, max });
        saveCustomSettings();
        onChange?.();
        selected = [];
        refreshTileBorders();
        renderOverlay();
        renderPairs();
      });

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.textContent = 'Reset';
      resetBtn.className = 'btn-mini';
      resetBtn.style.cssText = 'padding:3px 10px; font-size:10px;';
      resetBtn.addEventListener('click', () => {
        delete general.customBondLengths[pair];
        general.bondLengths[pair] = computeDefaultBondEntry(elA, elB);
        createBondLengthControls('infoBondControls');
        if (fileBrowser.selectedStructure) updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
        saveCustomSettings();
        onChange?.();
        renderPairs();
        renderOverlay();
      });

      fieldsRow.appendChild(distLabel);
      fieldsRow.appendChild(minInput);
      fieldsRow.appendChild(document.createTextNode('–'));
      fieldsRow.appendChild(maxInput);
      fieldsRow.appendChild(unit);
      fieldsRow.appendChild(applyBtn);
      fieldsRow.appendChild(resetBtn);
      overlay.appendChild(fieldsRow);
    }

    renderOverlay();

    const hint = document.createElement('div');
    hint.textContent = 'Click two elements to set a bond-distance override for that pair.';
    hint.style.cssText = 'text-align:center; font-size:11px; color:rgba(255,255,255,0.6); margin-top:10px;';
    container.appendChild(hint);

    const pairsHost = document.createElement('div');
    container.appendChild(pairsHost);
    function renderPairs() { renderPairList(pairsHost, () => { renderPairs(); onChange?.(); }); }
    renderPairs();
  }

  function renderJsonList(container) {
    container.innerHTML = '';
    const pairs = Object.keys(general.bondLengths).sort();
    container.appendChild(buildJsonListView({
      keys: pairs,
      isOverridden: (pair) => Object.prototype.hasOwnProperty.call(general.customBondLengths, pair),
      buildRow: (pair, row, hasComma) => {
        const { min, max } = general.bondLengths[pair];
        const keySpan = document.createElement('span');
        keySpan.textContent = `"${pair}": { "min": `;
        const minInput = makeInlineInput({ type: 'number', value: min.toFixed(2), width: 46 });
        const midSpan = document.createElement('span');
        midSpan.textContent = ', "max": ';
        const maxInput = makeInlineInput({ type: 'number', value: max.toFixed(2), width: 46 });
        const tail = document.createElement('span');
        tail.textContent = ` }${hasComma ? ',' : ''}`;

        [minInput, maxInput].forEach((inp) => {
          inp.dataset.before = inp.value;
          inp.addEventListener('focus', () => { inp.dataset.before = inp.value; });
        });

        function commit() {
          if (minInput.value === minInput.dataset.before && maxInput.value === maxInput.dataset.before) return;
          const minV = parseFloat(minInput.value) || 0;
          const maxV = parseFloat(maxInput.value) || 0;
          if (maxV <= 0) return;
          applyBondOverrideLive(pair, { min: minV, max: maxV });
          saveCustomSettings();
          row.style.color = OVERRIDE_COLOR;
          onChange?.();
        }
        [minInput, maxInput].forEach((inp) => {
          inp.addEventListener('blur', commit);
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); inp.blur(); } });
        });

        row.appendChild(keySpan);
        row.appendChild(minInput);
        row.appendChild(midSpan);
        row.appendChild(maxInput);
        row.appendChild(tail);
      },
      emptyText: 'No bond pairs known yet - load a structure, or pick a pair via the Periodic Table tab.',
    }));
  }

  createTabSwitcher(tabHost, [
    { id: 'grid', label: 'Periodic Table', render: () => {}, onActivate: renderPickGrid },
    { id: 'json', label: 'JSON', render: () => {}, onActivate: renderJsonList },
  ]);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.className = 'btn-mini highlight';
  closeBtn.style.cssText = 'display:block; margin:14px auto 0; padding:5px 20px;';
  closeBtn.addEventListener('click', () => popup.remove());
  popup.appendChild(closeBtn);

  closePopupOnOutsideClick(popup, () => popup.remove());
}

function renderPairList(container, onRemoved) {
  container.innerHTML = '';
  const pairs = Object.keys(general.customBondLengths);
  if (!pairs.length) return;

  const listWrap = document.createElement('div');
  listWrap.style.cssText = 'margin-top:14px; border-top:1px solid rgba(255,255,255,0.15); padding-top:10px;';
  const listHeading = document.createElement('div');
  listHeading.textContent = 'Your bond-distance overrides:';
  listHeading.style.cssText = 'font-size:12px; color:rgba(255,255,255,0.7); margin-bottom:6px;';
  listWrap.appendChild(listHeading);

  pairs.forEach((pair) => {
    const { min, max } = general.customBondLengths[pair];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:3px 0; color:' + OVERRIDE_COLOR + ';';
    const text = document.createElement('span');
    text.textContent = `${pair}: ${min.toFixed(2)}–${max.toFixed(2)} Å`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove override';
    removeBtn.className = 'btn-mini';
    removeBtn.style.cssText = 'width:20px; height:20px; padding:0; font-size:10px;';
    removeBtn.addEventListener('click', () => {
      delete general.customBondLengths[pair];
      delete general.bondLengths[pair];
      createBondLengthControls('infoBondControls');
      if (fileBrowser.selectedStructure) updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
      saveCustomSettings();
      onRemoved?.();
    });
    row.appendChild(text);
    row.appendChild(removeBtn);
    listWrap.appendChild(row);
  });

  container.appendChild(listWrap);
}

// ---------------------------------------------------------------------------
// JSON load/export - one small file-input + download-button pair per map.
// ---------------------------------------------------------------------------

function makeJsonFileInput(onLoaded) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      onLoaded(parsed);
    } catch (err) {
      console.warn('Custom User Settings: failed to parse JSON file', err);
    }
  });
  document.body.appendChild(input);
  return input;
}

function buildMapSection({ title, description, countLabel, onOpenPicker, onClearAll }) {
  const section = document.createElement('div');
  section.style.cssText = 'margin-bottom: 16px;';

  section.appendChild(makeSectionHeadline(title));

  const desc = document.createElement('div');
  desc.textContent = description;
  desc.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.6); margin-bottom: 8px;';
  section.appendChild(desc);

  const countRow = document.createElement('div');
  countRow.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.75); margin-bottom: 8px;';
  section.appendChild(countRow);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';

  const configureBtn = document.createElement('button');
  configureBtn.type = 'button';
  configureBtn.textContent = 'Configure via Periodic Table';
  configureBtn.className = 'btn-mini highlight';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear All';
  clearBtn.className = 'btn-mini';

  configureBtn.addEventListener('click', onOpenPicker);
  clearBtn.addEventListener('click', onClearAll);

  btnRow.appendChild(configureBtn);
  btnRow.appendChild(clearBtn);
  section.appendChild(btnRow);

  function refreshCount() {
    countRow.textContent = countLabel();
  }
  refreshCount();

  return { section, refreshCount };
}

// ---------------------------------------------------------------------------
// Applying a parsed sub-object of the combined JSON to each map - shared by
// the single "Load JSON" action below (loading a category that isn't present
// in the file is a no-op, so older/partial exports still work).
// ---------------------------------------------------------------------------

function applyColorMapJson(parsed) {
  Object.entries(parsed || {}).forEach(([el, value]) => {
    const num = parseColorToInt(value);
    if (num != null) {
      general.customColorMap[el] = num;
      applyColorOverrideLive(el);
    }
  });
}

function applyRadiusMapJson(parsed) {
  Object.entries(parsed || {}).forEach(([el, value]) => {
    const num = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isFinite(num) && num > 0) general.customAtomicRadii[el] = num;
  });
  applyRadiusOverrideLive();
}

function applyBondMapJson(parsed) {
  Object.entries(parsed || {}).forEach(([rawPair, value]) => {
    const entry = normalizeBondEntry(value);
    if (!entry) return;
    const [a, b] = rawPair.split('-');
    const pair = a && b ? sortedPairKey(a, b) : rawPair;
    applyBondOverrideLive(pair, entry);
  });
}

export function buildCustomUserSettingsPanel(body) {
  loadCustomSettings();

  const colorSection = buildMapSection({
    title: 'Colors',
    description: 'Per-element color overrides. Starts from the active scheme (CrysViz or JMOL) - only the elements you touch are saved.',
    countLabel: () => `${Object.keys(general.customColorMap).length} element(s) overridden`,
    onOpenPicker: () => openColorPeriodicTable(() => colorSection.refreshCount()),
    onClearAll: () => {
      Object.keys(general.customColorMap).forEach((el) => { delete general.customColorMap[el]; applyColorOverrideLive(el); });
      saveCustomSettings();
      colorSection.refreshCount();
    },
  });

  const radiusSection = buildMapSection({
    title: 'Radii',
    description: 'Per-element atomic-radius overrides (Å), used to size atoms and to seed default bond-length cutoffs.',
    countLabel: () => `${Object.keys(general.customAtomicRadii).length} element(s) overridden`,
    onOpenPicker: () => openRadiusPeriodicTable(() => radiusSection.refreshCount()),
    onClearAll: () => {
      Object.keys(general.customAtomicRadii).forEach((el) => delete general.customAtomicRadii[el]);
      applyRadiusOverrideLive();
      saveCustomSettings();
      radiusSection.refreshCount();
    },
  });

  const bondSection = buildMapSection({
    title: 'Bond Distances',
    description: 'Per-pair bond min/max-distance overrides (Å), e.g. "Fe-O". Pick two elements, then dial in the distance for that pair.',
    countLabel: () => `${Object.keys(general.customBondLengths).length} pair(s) overridden`,
    onOpenPicker: () => openBondPairPicker(() => bondSection.refreshCount()),
    onClearAll: () => {
      Object.keys(general.customBondLengths).forEach((pair) => {
        delete general.customBondLengths[pair];
        delete general.bondLengths[pair];
      });
      createBondLengthControls('infoBondControls');
      if (fileBrowser.selectedStructure) updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
      saveCustomSettings();
      bondSection.refreshCount();
    },
  });

  function refreshAllCounts() {
    colorSection.refreshCount();
    radiusSection.refreshCount();
    bondSection.refreshCount();
  }

  // One combined load/save for everything - keyed by category so more can be
  // added later (e.g. a future "textures" key) without breaking older files.
  const globalSection = document.createElement('div');
  globalSection.style.cssText = 'margin-bottom: 18px;';
  globalSection.appendChild(makeSectionHeadline('All Settings'));

  const globalDesc = document.createElement('div');
  globalDesc.textContent = 'Load or save colors, radii, and bond distances together as one file.';
  globalDesc.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.6); margin-bottom: 8px;';
  globalSection.appendChild(globalDesc);

  const globalBtnRow = document.createElement('div');
  globalBtnRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';

  const loadAllBtn = document.createElement('button');
  loadAllBtn.type = 'button';
  loadAllBtn.textContent = 'Load JSON';
  loadAllBtn.className = 'btn-mini highlight';

  const downloadAllBtn = document.createElement('button');
  downloadAllBtn.type = 'button';
  downloadAllBtn.textContent = 'Download JSON';
  downloadAllBtn.className = 'btn-mini';

  const fileInput = makeJsonFileInput((parsed) => {
    if (parsed?.colors) applyColorMapJson(parsed.colors);
    if (parsed?.radii) applyRadiusMapJson(parsed.radii);
    if (parsed?.bondLengths) applyBondMapJson(parsed.bondLengths);
    if (parsed?.shortcuts) applyShortcutOverrides(parsed.shortcuts);
    saveCustomSettings();
    refreshAllCounts();
  });
  loadAllBtn.addEventListener('click', () => fileInput.click());
  downloadAllBtn.addEventListener('click', () => {
    const colorsOut = {};
    Object.entries(general.customColorMap).forEach(([el, num]) => { colorsOut[el] = colorHexToCss(num); });
    const combined = {
      colors: colorsOut,
      radii: { ...general.customAtomicRadii },
      bondLengths: { ...general.customBondLengths },
      shortcuts: getShortcutOverrides(),
    };
    downloadBlob('crysviz-custom-settings.json', new Blob([JSON.stringify(combined, null, 2)], { type: 'application/json' }));
  });

  globalBtnRow.appendChild(loadAllBtn);
  globalBtnRow.appendChild(downloadAllBtn);
  globalSection.appendChild(globalBtnRow);

  const shortcutsSection = buildKeyboardShortcutsSection();

  body.appendChild(globalSection);
  body.appendChild(colorSection.section);
  body.appendChild(radiusSection.section);
  body.appendChild(bondSection.section);
  body.appendChild(shortcutsSection);
}

// Shortcut overrides travel with the combined "All Settings" JSON above (its
// own "shortcuts" key) rather than a separate file - this section only holds
// the "start over" action. The per-shortcut rebind/clear buttons live in the
// shortcuts help modal (Shift+H).
function buildKeyboardShortcutsSection() {
  const section = document.createElement('div');
  section.style.cssText = 'margin-bottom: 16px;';
  section.appendChild(makeSectionHeadline('Keyboard Shortcuts'));

  const desc = document.createElement('div');
  desc.textContent = 'Your customized bindings are included in the "All Settings" JSON above. Open the shortcut list with Shift+H to see or rebind individual keys, or reset everything back to defaults here.';
  desc.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.6); margin-bottom: 8px;';
  section.appendChild(desc);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = 'Reset to Defaults';
  resetBtn.className = 'btn-mini';
  resetBtn.addEventListener('click', confirmResetAllShortcuts);

  btnRow.appendChild(resetBtn);
  section.appendChild(btnRow);

  return section;
}
