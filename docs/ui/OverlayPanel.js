// Multi-Structure Overlay module: overlay any number of structures on top of
// the main one. Structures are picked via the checkboxes in the structure
// table (ui/FileBrowswerPanel.js); this panel hosts the master "Enable
// Overlay" toggle, the main structure's own opacity, the lattice-overlay
// popup toggle, and a scrollable table with one row per overlaid structure
// (name, opacity, bonds visibility, remove) — see fileBrowser.overlayEntries
// (state/store.js) and syncOverlayFromCheckboxes (ui/FileBrowswerPanel.js),
// the single place that reconciles "what's checked" into that list.
//
// Mutually exclusive with the classic Comparison panel (ui/ComparisonPanel.js,
// general.compareModeOn) — both drive the same checkboxes, so only one mode's
// rules ("exactly one" vs "any number") can be in effect at a time. Enabling
// this one turns Comparison off, and vice versa.

import { general, fileBrowser } from '../state/store.js';
import { removeLatticeComparisonPopup } from './LatticeComparisonPanel.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { syncOverlayFromCheckboxes, overlayEntryLabel, refreshOverlayLatticePlots } from './FileBrowswerPanel.js';

/**
 * Build a labeled toggle switch (the pill-shaped checkbox used throughout
 * this panel). Returns the input element so callers can wire `change`.
 */
function createToggleSwitch(id, labelText, checked) {
  const container = document.createElement("label");
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.margin = "10px 0";

  const switchEl = document.createElement("span");
  switchEl.style.position = "relative";
  switchEl.style.display = "inline-block";
  switchEl.style.width = "50px";
  switchEl.style.height = "24px";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = checked;
  input.style.opacity = "0";
  input.style.width = "0";
  input.style.height = "0";

  const slider = document.createElement("span");
  slider.className = "toggle_slider";
  slider.style.position = "absolute";
  slider.style.cursor = "pointer";
  slider.style.top = "0";
  slider.style.left = "0";
  slider.style.right = "0";
  slider.style.bottom = "0";
  slider.style.backgroundColor = "#ccc";
  slider.style.transition = ".4s";
  slider.style.borderRadius = "24px";

  const sliderInner = document.createElement("span");
  sliderInner.style.position = "absolute";
  sliderInner.style.height = "16px";
  sliderInner.style.width = "16px";
  sliderInner.style.left = "4px";
  sliderInner.style.bottom = "4px";
  sliderInner.style.backgroundColor = "white";
  sliderInner.style.transition = ".4s";
  sliderInner.style.borderRadius = "50%";

  slider.appendChild(sliderInner);
  switchEl.appendChild(input);
  switchEl.appendChild(slider);

  const text = document.createElement("span");
  text.textContent = labelText;
  text.style.marginLeft = "10px";

  container.appendChild(switchEl);
  container.appendChild(text);

  return { container, input };
}

/** A single labeled opacity slider (0-1). Returns the input for wiring. */
function createOpacitySlider(id, labelText, value) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex; flex-direction:column; margin: 6px 0;";

  const labelRow = document.createElement("div");
  labelRow.style.cssText = "display:flex; justify-content:space-between; font-size:11px; color:#ccc; margin-bottom:2px;";
  const label = document.createElement("span");
  label.textContent = labelText;
  const valueLabel = document.createElement("span");
  valueLabel.textContent = value.toFixed(2);
  labelRow.appendChild(label);
  labelRow.appendChild(valueLabel);

  const input = document.createElement("input");
  input.type = "range";
  input.id = id;
  input.min = "0";
  input.max = "1";
  input.step = "0.01";
  input.value = String(value);
  input.style.width = "100%";

  input.addEventListener('input', () => { valueLabel.textContent = parseFloat(input.value).toFixed(2); });

  wrap.appendChild(labelRow);
  wrap.appendChild(input);
  return { wrap, input };
}

/** Uncheck an overlay entry's file-browser checkbox and re-sync — the single
 *  source of truth for the overlay list stays the checkboxes themselves. */
function removeOverlayEntry(entry) {
  const cb = entry.row?.querySelector('input[type="checkbox"]');
  if (cb) cb.checked = false;
  syncOverlayFromCheckboxes();
}

/** The scrollable table: one row per fileBrowser.overlayEntries entry. */
function buildOverlayTable(container) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "max-height: 260px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; margin: 8px 0;";

  if (!fileBrowser.overlayEntries.length) {
    const empty = document.createElement("div");
    empty.textContent = 'No structures overlaid yet — check rows in the Files list.';
    empty.style.cssText = "padding: 10px; font-size: 12px; color: rgba(255,255,255,0.6); font-style: italic;";
    wrapper.appendChild(empty);
    container.appendChild(wrapper);
    return;
  }

  for (const entry of fileBrowser.overlayEntries) {
    const row = document.createElement("div");
    row.style.cssText = "padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; gap:4px;";

    const headRow = document.createElement("div");
    headRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:8px;";

    const name = document.createElement("span");
    name.textContent = overlayEntryLabel(entry);
    name.style.cssText = "font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    headRow.appendChild(name);

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex; align-items:center; gap:8px; flex-shrink:0;";

    const bondsLabel = document.createElement("label");
    bondsLabel.style.cssText = "display:flex; align-items:center; gap:3px; font-size:11px; color:#ccc; cursor:pointer;";
    const bondsCheckbox = document.createElement("input");
    bondsCheckbox.type = "checkbox";
    bondsCheckbox.checked = entry.showBonds;
    bondsCheckbox.addEventListener('change', () => {
      entry.showBonds = bondsCheckbox.checked;
      updateVisualization({ atomsUpdate: false, bondsUpdate: false, SecondBondsUpdate: true });
    });
    bondsLabel.appendChild(bondsCheckbox);
    bondsLabel.appendChild(document.createTextNode('Bonds'));
    controls.appendChild(bondsLabel);

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove this structure from the overlay";
    removeBtn.className = "btn-mini";
    removeBtn.style.cssText = "width:22px; height:22px; padding:0; line-height:0; display:flex; align-items:center; justify-content:center;";
    removeBtn.addEventListener('click', () => removeOverlayEntry(entry));
    controls.appendChild(removeBtn);

    headRow.appendChild(controls);
    row.appendChild(headRow);

    const { wrap: opacityWrap, input: opacityInput } = createOpacitySlider(
      `overlayOpacity-${entry.key}`, 'Opacity', entry.opacity
    );
    opacityInput.addEventListener('input', () => {
      entry.opacity = parseFloat(opacityInput.value);
      updateVisualization({ atomsUpdate: false, bondsUpdate: false, SecondAtomsUpdate: true, SecondBondsUpdate: true });
    });
    row.appendChild(opacityWrap);

    wrapper.appendChild(row);
  }

  container.appendChild(wrapper);
}

/**
 * Build the Multi-Structure Overlay panel controls into the given container.
 */
export function addOverlayPanel(container) {
  if (!container) return;

  container.innerHTML = "";

  // Master toggle: checking file-browser rows no longer starts rendering them
  // as overlays by itself — this must also be on (ui/FileBrowswerPanel.js's
  // syncOverlayFromCheckboxes reconciles the two).
  const { container: enableToggleContainer, input: enableToggleInput } =
    createToggleSwitch("enableOverlayToggle", "Enable Overlay", general.overlayModeOn);
  container.appendChild(enableToggleContainer);

  // Persistent error line: "check a structure" (nothing checked), while
  // overlay mode is on. fileBrowser.overlayEntries/general.overlayModeOn are
  // kept consistent continuously by syncOverlayFromCheckboxes (every checkbox
  // change, row delete, ...), so this only needs to reflect current state —
  // it must NOT call syncOverlayFromCheckboxes itself, which would rebuild
  // this very panel and recurse.
  const overlayError = document.createElement("div");
  overlayError.id = "overlayErrorField";
  overlayError.style.cssText = `
    font-size: 12px;
    color: #ff6b6b;
    margin: 0 0 10px 0;
    display: none;
  `;
  if (general.overlayModeOn && fileBrowser.overlayEntries.length === 0) {
    overlayError.textContent = 'Check one or more structures below to overlay them.';
    overlayError.style.display = 'block';
  }
  container.appendChild(overlayError);

  // Add toggle for lattice comparison
  const { container: latticeToggleContainer, input: latticeToggleInput } =
    createToggleSwitch("showLatticeOverlayToggle", "Show Lattice Overlay", general.comparisonActive);
  container.appendChild(latticeToggleContainer);

  // Main structure's own opacity — independent of each overlay entry's own
  // opacity slider (in the table below).
  const { wrap: mainOpacityWrap, input: mainOpacityInput } =
    createOpacitySlider("overlayMainOpacitySlider", "Main structure opacity", general.mainOpacity);
  container.appendChild(mainOpacityWrap);
  mainOpacityInput.addEventListener('input', () => {
    general.mainOpacity = parseFloat(mainOpacityInput.value);
    updateVisualization({ atomsUpdate: true, bondsUpdate: true });
  });

  const tableHeading = document.createElement("div");
  tableHeading.textContent = "Overlaid structures";
  tableHeading.style.cssText = "font-size:12px; font-weight:600; margin-top:10px;";
  container.appendChild(tableHeading);

  buildOverlayTable(container);

  // Polyhedra aren't rendered for overlay structures yet — the main
  // pipeline's WASM/worker compute, cage detection, and "Complete Polyhedra"
  // atom-completion aren't safely separable per-structure without more work,
  // so this is deferred rather than half-implemented. Only shown when
  // polyhedra are actually visible, so it doesn't clutter the panel otherwise.
  if (general.showPolyhedra) {
    const polyhedraNote = document.createElement("div");
    polyhedraNote.textContent = "Note: Polyhedra are not yet shown for overlay structures.";
    polyhedraNote.style.fontSize = "12px";
    polyhedraNote.style.color = "#ccc";
    polyhedraNote.style.fontStyle = "italic";
    polyhedraNote.style.margin = "8px 0 0 0";
    container.appendChild(polyhedraNote);
  }

  // Add dynamic style for checked state
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    #showLatticeOverlayToggle:checked + .toggle_slider {
      background-color: #4CAF50 !important;
    }
    #showLatticeOverlayToggle:checked + .toggle_slider > span {
      transform: translateX(26px) !important;
    }
    #enableOverlayToggle:checked + .toggle_slider {
      background-color: #4CAF50 !important;
    }
    #enableOverlayToggle:checked + .toggle_slider > span {
      transform: translateX(26px) !important;
    }
  `;
  document.head.appendChild(styleElement);

  // Add event listeners
  enableToggleInput.addEventListener('change', function() {
    general.overlayModeOn = this.checked;
    // Mutually exclusive with the classic Comparison panel — both interpret
    // the same file-browser checkboxes, so only one mode's rules can apply.
    if (general.overlayModeOn) general.compareModeOn = false;
    syncOverlayFromCheckboxes();
  });

  // Event listener for lattice comparison toggle. The flag makes structure/
  // frame changes keep the popup in sync (ui/FileBrowswerPanel.js).
  latticeToggleInput.addEventListener('change', function() {
    general.comparisonActive = this.checked;
    if (this.checked) {
      refreshOverlayLatticePlots();
    } else {
      removeLatticeComparisonPopup();
    }
  });
}

/**
 * Tear down the overlay panel: clears the controls, closes the
 * lattice-overlay popup, and deactivates its follow-updates flag.
 */
export function removeOverlayPanel(container) {
  if (container) container.innerHTML = "";
  general.comparisonActive = false;
  removeLatticeComparisonPopup();
}
