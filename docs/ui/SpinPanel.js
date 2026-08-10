import * as THREE from '../external/three/three.module.js';
import { updateSpins } from '../render/index.js';
import { fileBrowser, general } from '../state/store.js';
import { Spin } from '../model/index.js'; // Update path
import { createColorBar } from './ColorBarWidget.js';
import { registerColorBarSource } from './ColorBarRegistry.js';
import { computeAutoRange } from '../utils/index.js';

const SPIN_COLORBAR_FLOATING_ID = 'spinColorBarFloating';

// Module-scope (not local to addSpinPanel()) so removeSpinPanel() — called
// both from a fresh addSpinPanel() and from the panel-collapse path — can
// reach the live instance and persist its layout before disposing it. A
// panel rebuild (file change, collapse/reopen) otherwise throws the
// orientation and floating position away with no way to recover them, since
// they only ever lived inside the widget's own closures.
let spinColorBarInstance = null;

registerColorBarSource('spin', 'Spin (μB)', () => spinColorBarInstance);

// Helper function to create elements
function createElement(tag, attributes = {}, styles = {}, textContent = "") {
  const el = document.createElement(tag);
  Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(styles).forEach(([k, v]) => (el.style[k] = v));
  if (textContent) el.textContent = textContent;
  return el;
}

// Save the live color bar's orientation/floating state into `general` right
// before it's torn down, so the next build (fresh addSpinPanel(), or a
// colormap-triggered rebuild within one) can restore it instead of always
// resetting to docked/horizontal.
function captureSpinColorBarState() {
  if (!spinColorBarInstance) return;
  const settings = spinColorBarInstance.getSettings();
  general.spinColorBarOrientation = settings.orientation;
  general.spinColorBarFlipSide = settings.flipSide;
  general.colorBarSize = settings.size;
  general.spinColorScale = settings.scale;
  general.spinLegendText = settings.legend;
  general.spinColorBarFloating = spinColorBarInstance.isFloating();
  if (general.spinColorBarFloating) {
    // The anchor (offset from #view's edges), not raw left/top: a file
    // change's own transient layout churn can shift #view's rect between
    // this capture and the next build's restore, and a raw pixel target
    // wouldn't track that — the bar would drift a little further off on
    // every reload even though nothing about its placement changed.
    general.spinColorBarFloatPos = spinColorBarInstance.getAnchor();
  }
}

export function removeSpinPanel() {
  // A dragged-out color bar lives outside this group's DOM subtree (it was
  // reparented to document.body when floated); spinColorBarInstance.remove()
  // finds it via its own wrapper reference regardless of where it ended up.
  captureSpinColorBarState();
  spinColorBarInstance?.remove();
  spinColorBarInstance = null;
  // Defensive fallback: covers a floating node somehow left behind without a
  // live spinColorBarInstance to reach it (shouldn't normally happen).
  document.getElementById(SPIN_COLORBAR_FLOATING_ID)?.remove();
  const panel = document.getElementById("spinControlsGroup");
  if (panel) panel.remove();
}

export function addSpinPanel(target = "cvPanelBody-spins") {
  // Remove existing panel if any
  removeSpinPanel();

  const targetPanel = document.getElementById(target);
  if (!targetPanel) {
    console.error("Target container not found:", target);
    return;
  }

  // Outer wrapper. The hosting panel window (ui/panels/) provides the title
  // bar and collapse, so no header is built here.
  const group = document.createElement("div");
  group.id = "spinControlsGroup";
  group.className = "cv-scene-panel-group";

  // --- Panel ---
  const panel = document.createElement("div");
  panel.id = "spinPanel";

  const content = document.createElement("div");
  content.id = "spinControlsContent";
  content.className = "cv-scene-panel-content";

  // Activation ("Show Spins") lives in the Features window; this panel only
  // configures how the spins are drawn.
  //

  // --- No-spins note ---
  const noSpinsNote = document.createElement("div");
  noSpinsNote.className = "control-note cv-force-hidden";
  noSpinsNote.textContent = "No spin data available for this structure. Upload a file that includes spin information (e.g. an OUTCAR) or add spins manually.";
  content.appendChild(noSpinsNote);

  // --- Global Scaling slider ---
  const lengthWrapper = document.createElement("div");
  lengthWrapper.className = "cv-force-row";

  const lengthTopRow = document.createElement("div");
  lengthTopRow.className = "cv-force-split-row";

  const lengthLabel = document.createElement("label");
  lengthLabel.textContent = "Global Scaling (Length): ";

  // "log length" — scales arrow LENGTH logarithmically instead of linearly,
  // independent of the color map's own Log Scale toggle below (though
  // turning this on forces+locks that one — see logLengthCheckbox's change
  // handler for why a log-length arrow next to a linear-color one would be
  // internally inconsistent about what a given magnitude looks like).
  const logLengthLabel = document.createElement("label");
  logLengthLabel.className = "cv-force-check";

  const logLengthCheckbox = document.createElement("input");
  logLengthCheckbox.type = "checkbox";
  logLengthCheckbox.id = "spinLogLengthCheckbox";
  logLengthCheckbox.checked = general.spinLengthLogScale === true;

  logLengthLabel.appendChild(logLengthCheckbox);
  logLengthLabel.appendChild(document.createTextNode("log length"));

  lengthTopRow.appendChild(lengthLabel);
  lengthTopRow.appendChild(logLengthLabel);
  lengthWrapper.appendChild(lengthTopRow);

  const lengthBottomRow = document.createElement("div");
  lengthBottomRow.className = "cv-force-split-row";

  const lengthValue = document.createElement("span");
  lengthValue.className = "cv-force-value";
  lengthValue.textContent = (general.spinScale ?? 1.0).toFixed(2);

  const lengthSlider = /** @type {any} */ (document.createElement("input"));
  lengthSlider.type = "range";
  lengthSlider.min = 0.1;
  lengthSlider.max = 10;
  lengthSlider.step = 0.1;
  lengthSlider.value = general.spinScale ?? 1.0;

  lengthBottomRow.appendChild(lengthValue);
  lengthBottomRow.appendChild(lengthSlider);
  lengthWrapper.appendChild(lengthBottomRow);
  content.appendChild(lengthWrapper);

  // --- Size slider ---
  const sizeWrapper = document.createElement("div");
  sizeWrapper.className = "cv-force-row";

  const sizeLabel = document.createElement("label");
  sizeLabel.textContent = "Arrow Size (Diameter): ";

  const sizeValue = document.createElement("span");
  sizeValue.className = "cv-force-value";
  sizeValue.textContent = (general.spinRadius ?? 0.1).toFixed(2);

  const sizeSlider = /** @type {any} */ (document.createElement("input"));
  sizeSlider.type = "range";
  sizeSlider.min = 0.01;
  sizeSlider.max = 0.15;
  sizeSlider.step = 0.01;
  sizeSlider.value = general.spinRadius ?? 0.1;

  sizeWrapper.appendChild(sizeLabel);
  sizeWrapper.appendChild(sizeValue);
  sizeWrapper.appendChild(sizeSlider);
  content.appendChild(sizeWrapper);

  // --- Species Visibility Panel ---
  const speciesVisibilityLabel = document.createElement("div");
  speciesVisibilityLabel.className = "cv-force-subheading";
  speciesVisibilityLabel.textContent = "Species Visibility:";
  content.appendChild(speciesVisibilityLabel);

  const speciesVisibilityContainer = document.createElement("div");
  speciesVisibilityContainer.id = "speciesVisibilityContainer";
  speciesVisibilityContainer.className = "cv-species-toggle-grid";
  content.appendChild(speciesVisibilityContainer);

  // --- Source and Color Map dropdowns wrapper ---
  const dropdownsWrapper = document.createElement("div");
  dropdownsWrapper.className = "cv-spin-dropdowns-row";

  // --- Spin Source dropdown ---
  const sourceWrapper = document.createElement("div");

  const sourceLabel = document.createElement("label");
  sourceLabel.textContent = "Spin Source: ";
  sourceLabel.className = "cv-force-label-block";

  const sourceSelect = document.createElement("select");
  sourceSelect.className = "cv-scene-select cv-scene-select--block";

  const structureOption = document.createElement("option");
  structureOption.value = "structure";
  structureOption.textContent = "From Structure";

  const manualOption = document.createElement("option");
  manualOption.value = "manual";
  manualOption.textContent = "Manual";

  sourceSelect.appendChild(structureOption);
  sourceSelect.appendChild(manualOption);

  sourceWrapper.appendChild(sourceLabel);
  sourceWrapper.appendChild(sourceSelect);

  // --- Color Map dropdown and color bar container ---
  const colorMapWrapper = document.createElement("div");
  colorMapWrapper.className = "cv-spin-colormap-col";

  const colorMapLabel = document.createElement("label");
  colorMapLabel.textContent = "Color Map: ";
  colorMapLabel.className = "cv-force-label-block";

  const colorMapSelect = document.createElement("select");
  colorMapSelect.className = "cv-scene-select cv-scene-select--block cv-spin-colormap-select";

  const noneOption = document.createElement("option");
  noneOption.value = "none";
  noneOption.textContent = "None (Default)";

  const heatMapOption = document.createElement("option");
  heatMapOption.value = "heatmap";
  heatMapOption.textContent = "Heat Map";

  const directionMapOption = document.createElement("option");
  directionMapOption.value = "direction";
  directionMapOption.textContent = "Direction Map";

  const plusminusMapOption = document.createElement("option");
  plusminusMapOption.value = "plusminus";
  plusminusMapOption.textContent = "Plus-Minus Map";

  const elementMapOption = document.createElement("option");
  elementMapOption.value = "element";
  elementMapOption.textContent = "Element Color Map";

  const batlowOption = document.createElement("option");
  batlowOption.value = "batlow";
  batlowOption.textContent = "Batlow";

  const hawaiiOption = document.createElement("option");
  hawaiiOption.value = "hawaii";
  hawaiiOption.textContent = "Hawaii";

  const managuaOption = document.createElement("option");
  managuaOption.value = "managua";
  managuaOption.textContent = "Managua";

  const viridisOption = document.createElement("option");
  viridisOption.value = "viridis";
  viridisOption.textContent = "Viridis";

  const plasmaOption = document.createElement("option");
  plasmaOption.value = "plasma";
  plasmaOption.textContent = "Plasma";

  const spectralROption = document.createElement("option");
  spectralROption.value = "spectralR";
  spectralROption.textContent = "Spectral R";

  const jetOption = document.createElement("option");
  jetOption.value = "jet";
  jetOption.textContent = "Jet";

  colorMapSelect.appendChild(noneOption);
  colorMapSelect.appendChild(directionMapOption);
  colorMapSelect.appendChild(plusminusMapOption);
  colorMapSelect.appendChild(elementMapOption);
  colorMapSelect.appendChild(heatMapOption);
  colorMapSelect.appendChild(batlowOption);
  colorMapSelect.appendChild(hawaiiOption);
  colorMapSelect.appendChild(managuaOption);
  colorMapSelect.appendChild(viridisOption);
  colorMapSelect.appendChild(plasmaOption);
  colorMapSelect.appendChild(spectralROption);
  colorMapSelect.appendChild(jetOption);
  colorMapSelect.value = general.spinColorMap ?? "none";

  // --- Log Scale + Auto Range, side by side, above the color bar itself ---
  // (mirrors ForcePanel.js's own row, for the same reason: a docked bar
  // needs its own reachable controls while the floating layout menu is
  // opened by long press.)
  const barControlsRow = document.createElement("div");
  barControlsRow.className = "cv-force-bar-controls cv-force-bar-controls--spin";

  const logLabel = document.createElement("label");
  logLabel.className = "cv-force-check";

  const logCheckbox = document.createElement("input");
  logCheckbox.type = "checkbox";
  logCheckbox.id = "spinLogScaleCheckbox";
  logCheckbox.checked = general.spinColorScale === "log";

  logLabel.appendChild(logCheckbox);
  logLabel.appendChild(document.createTextNode("Log Scale"));

  // "log length" (above, next to Global Scaling) forces this on and locks it
  // — a log-length arrow next to a linear color scale would disagree about
  // what a given spin magnitude looks like. Unlocks again once "log length"
  // is turned back off (but doesn't force Log Scale back off; that stays
  // the user's own choice). Mirrors ForcePanel.js's syncLogScaleLock.
  function syncLogScaleLock() {
    const locked = logLengthCheckbox.checked;
    logCheckbox.disabled = locked;
    logLabel.classList.toggle("cv-check-locked", locked);
    logLabel.title = locked ? '"log length" requires Log Scale — turn it off first to change this' : "";
  }

  const autoRangeBtn = document.createElement("button");
  autoRangeBtn.type = "button";
  autoRangeBtn.textContent = "Auto Range";
  autoRangeBtn.className = "file-action-btn cv-auto-range-btn";

  barControlsRow.appendChild(logLabel);
  barControlsRow.appendChild(autoRangeBtn);

  colorMapWrapper.appendChild(colorMapLabel);
  colorMapWrapper.appendChild(colorMapSelect);
  colorMapWrapper.appendChild(barControlsRow);

  dropdownsWrapper.appendChild(sourceWrapper);
  dropdownsWrapper.appendChild(colorMapWrapper);
  content.appendChild(dropdownsWrapper);

  // --- Color Bar Container (full panel width, below both dropdowns) ---
  const colorBarContainer = document.createElement("div");
  colorBarContainer.id = "spinColorBarContainer";
  colorBarContainer.className = "cv-force-colorbar-container cv-force-row cv-force-hidden";
  content.appendChild(colorBarContainer);


  // --- Current Spins/Forces list ---
  const currentSpinsLabel = document.createElement("div");
  currentSpinsLabel.className = "cv-force-subheading";
  currentSpinsLabel.textContent = "Current Spins/Forces:";
  content.appendChild(currentSpinsLabel);

  const currentSpinsList = document.createElement("textarea");
  currentSpinsList.id = "currentSpinsList";
  currentSpinsList.className = "cv-spin-textarea cv-spin-textarea--list";
  currentSpinsList.readOnly = true;
  content.appendChild(currentSpinsList);

  // --- Manual spin text input ---
  const textLabel = document.createElement("div");
  textLabel.className = "cv-force-subheading";
  textLabel.textContent = "Manual Spin Vectors (x y z [scale] [color]):";
  content.appendChild(textLabel);

  const textarea = document.createElement("textarea");
  textarea.id = "spinTextInput";
  textarea.placeholder = "x y z [scale] [color]\nExample:\n1 1 1\n1 1 1 1.0 teal\n0 0 1 2.0 #0000ff";
  textarea.className = "cv-spin-textarea cv-spin-textarea--input";
  content.appendChild(textarea);

  // --- Action buttons ---
  const buttonWrapper = document.createElement("div");
  buttonWrapper.className = "cv-spin-button-row";

  const drawBtn = document.createElement("button");
  drawBtn.textContent = "Draw";
  drawBtn.className = "btn-mini highlight";

  const overwriteBtn = document.createElement("button");
  overwriteBtn.textContent = "Overwrite Structure";
  overwriteBtn.className = "btn-mini highlight";

  const restoreBtn = document.createElement("button");
  restoreBtn.textContent = "Restore";
  restoreBtn.className = "btn-mini highlight";

  buttonWrapper.appendChild(drawBtn);
  buttonWrapper.appendChild(overwriteBtn);
  buttonWrapper.appendChild(restoreBtn);
  content.appendChild(buttonWrapper);

  // --- Build hierarchy ---
  panel.appendChild(content);
  group.appendChild(panel);
  targetPanel.appendChild(group);

  function parseManualSpins() {
  const input = textarea.value.trim().split("\n").filter(Boolean);
  const spins = [];
  const structure = fileBrowser.selectedStructure;

  if (!structure) return spins;

  input.forEach((line, i) => {
    const p = line.trim().split(/\s+/);
    if (p.length < 3) return;

    const x = parseFloat(p[0]);
    const y = parseFloat(p[1]);
    const z = parseFloat(p[2]);
    let scale = 1.0;
    let color = new THREE.Color("#008080"); // Default to teal as THREE.Color

    if (p.length > 3 && !isNaN(parseFloat(p[3]))) {
      scale = parseFloat(p[3]);
      if (p.length > 4) {
        // Convert string color to THREE.Color if needed
        color = /** @type {any} */ (p[4]) instanceof THREE.Color ?
          p[4] :
          new THREE.Color(p[4] || "#008080");
      }
    } else if (p.length > 3) {
      color = new THREE.Color(p[3] || "#008080");
    }

    if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
      // Get position from atoms array if it exists
      const position = structure.atoms[i]?.position ?
        [...structure.atoms[i].position] :
        null;

      spins.push(new Spin({
        atomIndex: i,
        vector: [x, y, z],
        scaling: scale,
        color: color,
        element: structure.elements[i],
        position: position
      }));
    }
  });
  return spins;
}


  // --- Function to update the current spins/forces list ---
  function updateCurrentSpinsList() {
  const structure = fileBrowser.selectedStructure;
  const useManualSpins = sourceSelect.value === "manual";
  const spins = useManualSpins ? parseManualSpins() : structure.spins;

  if (spins.length > 0) {
    const spinLines = spins.map(spin => {
      const scale = spin.scaling ?? 1.0;
      // Convert THREE.Color to hex string if needed
      const color = spin.color instanceof THREE.Color ?
        `#${spin.color.getHexString()}` :
        spin.color;
      return `${spin.vector.join(" ")} ${scale} ${color}`;
    });
    currentSpinsList.value = spinLines.join("\n");
  } else {
    currentSpinsList.value = "No spins available.";
  }
}

  // --- Event listeners ---
  lengthSlider.addEventListener("input", () => {
    const val = parseFloat(lengthSlider.value);
    lengthValue.textContent = val.toFixed(2);
    general.spinScale = val;
    if (general.spinsActive) updateSpins(val, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
  });

  sizeSlider.addEventListener("input", () => {
    const val = parseFloat(sizeSlider.value);
    sizeValue.textContent = val.toFixed(2);
    general.spinRadius = val;
    if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
  });

  logLengthCheckbox.addEventListener("change", () => {
    general.spinLengthLogScale = logLengthCheckbox.checked;
    if (logLengthCheckbox.checked) {
      applyLogScale(true); // forces + (via syncLogScaleLock below) locks Log Scale on; redraws
    } else if (general.spinsActive) {
      updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
    }
    syncLogScaleLock();
  });

  sourceSelect.addEventListener("change", () => {
    updateCurrentSpinsList();
    if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
  });

// Only the very first scalar colormap pick for this panel instance should
// derive the range from the structure's spin lengths; every switch after
// that (including bouncing through "none"/direction/plusminus, which don't
// show a range at all) should keep whatever range is already set instead of
// recomputing it out from under the user. Local (not module-scope), so a
// full panel rebuild (file change, collapse/reopen) recomputes fresh for
// the new structure's spin magnitudes — mirroring ForcePanel's
// preserveRange=false default for its own initial build.
let spinRangeInitialized = false;

// Builds (or tears down/hides) the color bar to match colorMapSelect's
// current value. Shared between the colormap dropdown's change handler and
// the panel's initial build, so a restored persisted colormap actually gets
// a widget instead of just a select value nothing reads.
function refreshColorBarVisibility() {
  const cmap = colorMapSelect.value;
  const isScalar = cmap !== "none" && cmap !== "direction" && cmap !== "plusminus" && cmap !== "element";
  barControlsRow.classList.toggle("cv-force-hidden", !isScalar);

  // The bar may currently be floating over the scene (dragged out of
  // colorBarContainer into document.body), so innerHTML='' alone wouldn't
  // remove it — dispose the instance explicitly, persisting its
  // orientation/floating position into general first (read back below) so
  // a colormap change doesn't dock it or flip it back to horizontal.
  captureSpinColorBarState();
  spinColorBarInstance?.remove();
  spinColorBarInstance = null;
  colorBarContainer.innerHTML = '';

  if (isScalar) {
    colorBarContainer.classList.remove("cv-force-hidden");

    let minValue = general.spinMin;
    let maxValue = general.spinMax;
    const haveUsableRange = spinRangeInitialized && isFinite(minValue) && isFinite(maxValue) && minValue < maxValue;

    if (!haveUsableRange) {
      minValue = 0;
      maxValue = 2;

      const structure = fileBrowser.selectedStructure;
      if (structure?.spins) {
        // Calculate lengths for all spins
        const lengths = structure.spins
          .map(spin => {
            if (!spin.vector) return 0;
            const mag = Math.sqrt(
              spin.vector[0] ** 2 +
              spin.vector[1] ** 2 +
              spin.vector[2] ** 2
            );
            return mag * (spin.scaling ?? 1.0);
          })
          .filter(len => len > 0.1); // Only consider lengths > 0.1

        if (lengths.length > 0) {
          minValue = Math.min(...lengths);
          maxValue = Math.max(...lengths);

          // Round up to 1 decimal place
          minValue = Math.ceil(minValue * 10) / 10;
          maxValue = Math.ceil(maxValue * 10) / 10;

          // Add a small buffer to max value (also rounded up)
          maxValue = Math.ceil(maxValue * 1.05 * 10) / 10;

          // Ensure min is less than max
          if (minValue >= maxValue) {
            minValue = Math.floor(maxValue * 0.9 * 10) / 10;
          }
        }
      }

      // Set default values if no valid spins found
      if (minValue >= maxValue) {
        minValue = 0;
        maxValue = 2;
      }

      // Update general values
      general.spinMin = minValue;
      general.spinMax = maxValue;
      spinRangeInitialized = true;
    }

    // Show the color bar with calculated values
    spinColorBarInstance = createColorBar(colorBarContainer, cmap, minValue, maxValue, {
      floatingId: SPIN_COLORBAR_FLOATING_ID,
      fallbackMin: minValue,
      fallbackMax: maxValue,
      legend: general.spinLegendText ?? "Spin (μB)",
      scale: general.spinColorScale,
      orientation: general.spinColorBarOrientation,
      flipSide: general.spinColorBarFlipSide,
      size: general.colorBarSize,
      onLimitsCommit: (min, max) => {
        general.spinMin = min;
        general.spinMax = max;
        if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), cmap);
      },
      onScaleChange: (scale) => applyLogScale(scale === "log"),
      onAutoRange: () => applyAutoRange(),
      isScaleLocked: () => logLengthCheckbox.checked,
    });
    if (general.spinColorBarFloating && general.spinColorBarFloatPos) {
      spinColorBarInstance.floatAtAnchor(general.spinColorBarFloatPos);
    }
  } else {
    colorBarContainer.classList.add("cv-force-hidden");
  }
}

colorMapSelect.addEventListener("change", () => {
  const cmap = colorMapSelect.value;
  general.spinColorMap = cmap;
  refreshColorBarVisibility();

  // When "none" is selected, reset all spins to their original color or teal
  if (cmap === "none") {
    const structure = fileBrowser.selectedStructure;
    if (structure?.spins) {
      structure.spins.forEach(spin => {
        if (spin instanceof Spin && spin.original) {
          spin.color = spin.original.color;
        } else if (spin.color) {
          // Keep existing color if set
        } else {
          spin.color = "#008080"; // Default to teal
        }
      });
    }
  }

  // Always update spins when changing color map (if they're shown at all)
  if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), cmap);
});

// Shared by the side-panel checkbox and the floating color bar's own
// layout-menu "Log Scale" item (ColorBarWidget.js's onScaleChange) — either
// one can flip it, and both stay in sync since this is the only place that
// actually applies the change. Mirrors ForcePanel.js's applyLogScale.
function applyLogScale(isLog) {
  general.spinColorScale = isLog ? "log" : "linear";
  // log10(0) is -Infinity, so a min of 0 breaks the log color mapping and
  // the tick math — floor it to a small positive value the moment log
  // scale turns on, same as ForcePanel.js.
  if (isLog && general.spinMin <= 0) {
    general.spinMin = 0.01;
    spinColorBarInstance?.setRange(general.spinMin, general.spinMax);
  }
  logCheckbox.checked = isLog;
  spinColorBarInstance?.update(colorMapSelect.value, general.spinColorScale);
  if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
}

logCheckbox.addEventListener("change", () => {
  applyLogScale(logCheckbox.checked);
});

function updateNoSpinsNote() {
  noSpinsNote.classList.toggle("cv-force-hidden", !!fileBrowser.selectedStructure?.spins?.length);
}

// Shared by the Auto Range button and the layout menu's own "Auto Range"
// item (onAutoRange). Recomputes min/max from whichever spins are actually
// showing right now (manual list or the structure's own), padded 20% of
// the data's own span on each side (computeAutoRange) — mirrors
// ForcePanel.js's applyAutoRange.
function applyAutoRange() {
  const spins = sourceSelect.value === "manual" ? parseManualSpins() : fileBrowser.selectedStructure?.spins;
  if (!spins?.length) return;
  const magnitudes = spins.map((spin) => {
    if (!spin?.vector) return NaN;
    const mag = Math.sqrt(spin.vector[0] ** 2 + spin.vector[1] ** 2 + spin.vector[2] ** 2);
    return mag * (spin.scaling ?? 1.0);
  });
  const range = computeAutoRange(magnitudes, 0.2, { clampMinAtZero: true });
  if (!range) return;
  let { min, max } = range;
  if (general.spinColorScale === "log" && min <= 0) min = 0.01;
  general.spinMin = min;
  general.spinMax = max;
  spinColorBarInstance?.setRange(min, max);
  if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
}
autoRangeBtn.addEventListener("click", applyAutoRange);


  // Bulk edits here (Overwrite/Restore) replace structure.spins wholesale,
  // but the Structure Info panel's per-atom Spin/Force row editor
  // (SpinForceEditor.js) only re-syncs its displayed vector when its own row
  // reopens — it has no way to know this panel just changed the atom it's
  // showing. Nudge any editor that's currently open.
  function refreshOpenStructureInfoSpinEditors() {
    document.querySelectorAll('.atom-spin-editor').forEach((el) => {
      if (el.style.display !== 'none') /** @type {any} */ (el).refresh?.();
    });
  }

  // --- Draw button ---
  drawBtn.addEventListener("click", () => {
    if (sourceSelect.value === "manual") {
      const manualSpins = parseManualSpins();
      if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, true, manualSpins, colorMapSelect.value);
      updateCurrentSpinsList();
    }
  });

  // --- Overwrite button ---
  overwriteBtn.addEventListener("click", () => {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;

    const manualSpins = parseManualSpins();
    const spins = [];

    for (let i = 0; i < structure.atoms.length; i++) {
      const manualSpin = manualSpins.find(s => s.atomIndex === i);
      if (manualSpin) {
        spins.push(new Spin({
          vector: manualSpin.vector,
          scaling: manualSpin.scaling ?? 1.0,
          color: manualSpin.color,
          atomIndex: i,
          element: structure.elements[i],
          position: structure.atoms[i]?.position
        }));
      } else {
        // Default to teal for new spins
        spins.push(new Spin({
          vector: [0, 0, 0],
          scaling: 1.0,
          color: "#008080", // Default teal
          atomIndex: i,
          element: structure.elements[i],
          position: structure.atoms[i]?.position
        }));
      }
    }

    // structure.originalSpins is captured once, at load time, by the
    // Structure constructor (model/Structure.js) — it always reflects the
    // true as-loaded state, so "Restore" works below even if Overwrite is
    // never clicked; nothing to snapshot here.
    structure.spins = spins;
    if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, false, [], colorMapSelect.value);
      updateNoSpinsNote()
      updateCurrentSpinsList();
      createSpeciesVisibilityToggles();
      refreshOpenStructureInfoSpinEditors();
  });

  // --- Restore button ---
  restoreBtn.addEventListener("click", () => {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;

    // Restore the as-loaded spins (model/Structure.js's originalSpins
    // snapshot) — an empty array when the structure had none at load, which
    // correctly empties structure.spins back out below rather than no-op'ing.
    structure.spins = structure.originalSpins.map(original => {
      return new Spin({
        vector: [...original.vector],
        scaling: original.scaling,
        color: original.color || "#008080", // Fallback to teal if no color was stored
        atomIndex: original.atomIndex,
        element: original.element,
        position: original.position ? [...original.position] : null
      });
    });

    if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, false, [], colorMapSelect.value);
    updateCurrentSpinsList();
    createSpeciesVisibilityToggles();
    refreshOpenStructureInfoSpinEditors();
  });

  // --- Function to create species visibility toggles ---
  function createSpeciesVisibilityToggles() {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;

    // Clear existing toggles
    speciesVisibilityContainer.innerHTML = '';

    // Get unique elements
    const uniqueElements = [...new Set(structure.elements)];

    // Create a toggle for each element
    uniqueElements.forEach(element => {
      const toggleItem = createElement("div", { class: "cv-species-toggle-item" });

      // The shared pill (toggle_styles.css); cv-species-toggle only shrinks it.
      const toggleContainer = createElement("label", { class: "toggle_switch cv-species-toggle" });

      const checkbox = createElement("input", {
        type: "checkbox",
        id: `species-${element}`,
        checked: "checked"
      });

      const slider = createElement("span", { class: "toggle_slider" });

      toggleContainer.appendChild(checkbox);
      toggleContainer.appendChild(slider);

      const label = createElement("label", {
        for: `species-${element}`,
        class: "cv-species-toggle-label"
      }, {}, element);

      toggleItem.appendChild(toggleContainer);
      toggleItem.appendChild(label);
      speciesVisibilityContainer.appendChild(toggleItem);

      if (typeof general.speciesVisibility === 'undefined') {
        general.speciesVisibility = {};
      }
      if (typeof general.speciesVisibility[element] === 'undefined') {
        general.speciesVisibility[element] = true;
      }

      checkbox.checked = general.speciesVisibility[element];

      // Colour/knob position now come from the browser's own :checked
      // selector (styles/forcePanel.css) — this only needs to keep the
      // stored visibility flag and the scene render in sync.
      function updateToggle() {
        general.speciesVisibility[element] = checkbox.checked;
        // Only re-render the arrows if they're actually supposed to be
        // shown — this fires on initial panel build too (once per species),
        // which must never be the thing that turns arrows on when "Show
        // Spins" itself is off.
        if (general.spinsActive) {
          updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
        }
      }

      updateToggle();

      checkbox.addEventListener("change", updateToggle);
      toggleContainer.addEventListener("click", (e) => {
        e.stopPropagation();
        checkbox.checked = !checkbox.checked;
        updateToggle();
      });
      label.addEventListener("click", () => {
        checkbox.checked = !checkbox.checked;
        updateToggle();
      });
    });
  }

  // If "log length" was already on from a previous build, keep Log Scale in
  // sync (and locked) rather than let the two drift apart.
  if (general.spinLengthLogScale) {
    general.spinColorScale = "log";
    logCheckbox.checked = true;
  }
  syncLogScaleLock();

  // Initialize species visibility toggles, the color bar (restoring the
  // persisted colormap/orientation/floating position), and current spins list
  createSpeciesVisibilityToggles();
  refreshColorBarVisibility();
  updateCurrentSpinsList();
  updateNoSpinsNote();
}
