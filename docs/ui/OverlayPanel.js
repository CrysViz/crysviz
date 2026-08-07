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
import { createToggleRow } from './ToggleSwitch.js';

/** Labeled stock pill toggle with this panel's row spacing/label margin. */
function createToggleSwitch(id, labelText, checked) {
  const { row: container, input } = createToggleRow({
    id, label: labelText, checked,
    rowClass: 'cv-overlay-toggle-row', textClass: 'cv-overlay-toggle-text',
  });
  return { container, input };
}

/** A single labeled opacity slider (0-1). Returns the input for wiring. */
function createOpacitySlider(id, labelText, value) {
  const wrap = document.createElement("div");
  wrap.className = "cv-overlay-opacity-row";

  const labelRow = document.createElement("div");
  labelRow.className = "cv-overlay-opacity-label-row";
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
  wrapper.className = "cv-overlay-table";

  if (!fileBrowser.overlayEntries.length) {
    const empty = document.createElement("div");
    empty.textContent = 'No structures overlaid yet — check rows in the Files list.';
    empty.className = "cv-overlay-table-empty";
    wrapper.appendChild(empty);
    container.appendChild(wrapper);
    return;
  }

  for (const entry of fileBrowser.overlayEntries) {
    const row = document.createElement("div");
    row.className = "cv-overlay-row";

    const headRow = document.createElement("div");
    headRow.className = "cv-overlay-head-row";

    const name = document.createElement("span");
    name.textContent = overlayEntryLabel(entry);
    name.className = "cv-overlay-entry-name";
    headRow.appendChild(name);

    const controls = document.createElement("div");
    controls.className = "cv-overlay-controls";

    const bondsLabel = document.createElement("label");
    bondsLabel.className = "cv-overlay-bonds-label";
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
    removeBtn.className = "btn-mini cv-overlay-remove-btn";
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
  overlayError.className = "cv-overlay-error cv-force-hidden";
  if (general.overlayModeOn && fileBrowser.overlayEntries.length === 0) {
    overlayError.textContent = 'Check one or more structures below to overlay them.';
    overlayError.classList.remove("cv-force-hidden");
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
  tableHeading.className = "cv-overlay-table-heading";
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
    polyhedraNote.className = "cv-overlay-note";
    container.appendChild(polyhedraNote);
  }

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
