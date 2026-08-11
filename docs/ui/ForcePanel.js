import { updateForces } from '../render/index.js';
import { fileBrowser, general } from '../state/store.js';
import { createColorBar } from './ColorBarWidget.js';
import { registerColorBarSource } from './ColorBarRegistry.js';
import { computeAutoRange } from '../utils/index.js';
import { addForceHistogramPanel } from './AnalysisPanels/ForceHistogram.js';
import { makeSectionHeadline } from './panels/sectionHeadline.js';

const FORCE_COLORBAR_FLOATING_ID = 'forceColorBarFloating';

// Module-scope (not local to addForcePanel()) so removeForcePanel() — called
// both from a fresh addForcePanel() and from the panel-collapse path — can
// reach the live instance and persist its layout before disposing it. A
// panel rebuild (file change, collapse/reopen) otherwise throws the
// orientation and floating position away with no way to recover them, since
// they only ever lived inside the widget's own closures.
let colorBarInstance = null;

registerColorBarSource('force', 'Force (eV/Å)', () => colorBarInstance);

// Helper function to create elements
function createElement(tag, attributes = {}, styles = {}, textContent = "") {
  const el = document.createElement(tag);
  Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(styles).forEach(([k, v]) => (el.style[k] = v));
  if (textContent) el.textContent = textContent;
  return el;
}

// Save the live color bar's orientation/floating state into `general` right
// before it's torn down, so the next build (fresh addForcePanel(), or a
// colormap-triggered rebuild within one) can restore it instead of always
// resetting to docked/horizontal.
function captureColorBarState() {
  if (!colorBarInstance) return;
  const settings = colorBarInstance.getSettings();
  general.forceColorBarOrientation = settings.orientation;
  general.forceColorBarFlipSide = settings.flipSide;
  general.colorBarSize = settings.size;
  general.forceLegendText = settings.legend;
  general.forceColorBarFloating = colorBarInstance.isFloating();
  if (general.forceColorBarFloating) {
    // The anchor (offset from #view's edges), not raw left/top: a file
    // change's own transient layout churn can shift #view's rect between
    // this capture and the next build's restore, and a raw pixel target
    // wouldn't track that — the bar would drift a little further off on
    // every reload even though nothing about its placement changed.
    general.forceColorBarFloatPos = colorBarInstance.getAnchor();
  }
}

export function removeForcePanel() {
  // A dragged-out color bar lives outside this group's DOM subtree (it was
  // reparented to document.body when floated); colorBarInstance.remove()
  // finds it via its own wrapper reference regardless of where it ended up.
  captureColorBarState();
  colorBarInstance?.remove();
  colorBarInstance = null;
  // Defensive fallback: covers a floating node somehow left behind without a
  // live colorBarInstance to reach it (shouldn't normally happen).
  document.getElementById(FORCE_COLORBAR_FLOATING_ID)?.remove();
  const el = document.getElementById("forceControlsGroup");
  if (el) el.remove();
}

export function addForcePanel(target = "cvPanelBody-forces") {
  removeForcePanel();
  const targetPanel = document.getElementById(target);
  if (!targetPanel) { console.warn("ForcePanel: target not found:", target); return; }

  // Outer wrapper. The hosting panel window (ui/panels/) provides the title
  // bar and collapse, so no header is built here.
  const group = document.createElement("div");
  group.id = "forceControlsGroup";
  group.className = "cv-scene-panel-group";

  // --- Panel ---
  const panel = document.createElement("div");
  panel.id = "forcePanel";

  const content = document.createElement("div");
  content.id = "forceControlsContent";
  content.className = "cv-scene-panel-content";

  // Activation ("Show Forces") lives in the Features window; this panel only
  // configures how the forces are drawn.

  // --- No-forces note ---
  const noForcesNote = document.createElement("div");
  noForcesNote.className = "control-note cv-force-hidden";
  noForcesNote.textContent = "No force data available for this structure. Upload a file that includes forces (e.g. an OUTCAR) or run a Relax/MD calculation.";
  content.appendChild(noForcesNote);

  // --- Histogram ---
  // Opens ui/AnalysisPanels/ForceHistogram.js's window (side-dock by
  // default) — same "Histograms" idiom as the Bonds window's Bond Length /
  // Coordination Number buttons (BondPanel.js). Disabled while the structure
  // has no force data (updateNoForcesNote keeps this in sync on rebuild and
  // on every redraw()).
  const histogramSection = document.createElement("div");
  histogramSection.className = "cv-force-row";
  histogramSection.appendChild(makeSectionHeadline("Histograms"));

  const histogramRow = document.createElement("div");
  histogramRow.className = "cv-force-hist-row";

  const histogramLabel = document.createElement("span");
  histogramLabel.className = "cv-force-hist-label";
  histogramLabel.textContent = "Force Histogram";

  const histogramBtn = document.createElement("button");
  histogramBtn.type = "button";
  histogramBtn.id = "openForceHistogram";
  histogramBtn.className = "btn-mini highlight";
  histogramBtn.textContent = "Open";
  histogramBtn.title = "Open the Force Histogram window";
  histogramBtn.addEventListener("click", () => addForceHistogramPanel());

  histogramRow.append(histogramLabel, histogramBtn);
  histogramSection.appendChild(histogramRow);
  content.appendChild(histogramSection);

  // --- Global Scaling slider ---
  const sliderWrapper = document.createElement("div");
  sliderWrapper.className = "cv-force-row";

  const sliderTopRow = document.createElement("div");
  sliderTopRow.className = "cv-force-split-row";

  const sliderLabel = document.createElement("label");
  sliderLabel.textContent = "Global Scaling (Length): ";

  // "log length" — scales arrow LENGTH logarithmically instead of linearly,
  // independent of the color map's own Log Scale toggle below (though
  // turning this on forces+locks that one — see logLengthCheckbox's change
  // handler for why a log-length arrow next to a linear-color one would be
  // internally inconsistent about what a given magnitude looks like).
  const logLengthLabel = document.createElement("label");
  logLengthLabel.className = "cv-force-check";

  const logLengthCheckbox = document.createElement("input");
  logLengthCheckbox.type = "checkbox";
  logLengthCheckbox.id = "forceLogLengthCheckbox";
  logLengthCheckbox.checked = general.forceLengthLogScale === true;

  logLengthLabel.appendChild(logLengthCheckbox);
  logLengthLabel.appendChild(document.createTextNode("log length"));

  sliderTopRow.appendChild(sliderLabel);
  sliderTopRow.appendChild(logLengthLabel);
  sliderWrapper.appendChild(sliderTopRow);

  const sliderBottomRow = document.createElement("div");
  sliderBottomRow.className = "cv-force-split-row";

  const sliderValue = document.createElement("span");
  sliderValue.className = "cv-force-value";
  sliderValue.textContent = (general.forceScale ?? 1.0).toFixed(2);
  const slider = /** @type {any} */ (document.createElement("input"));
  slider.type = "range";
  slider.min = 0.1; slider.max = 10; slider.step = 0.1;
  slider.value = general.forceScale ?? 1.0;
  sliderBottomRow.appendChild(sliderValue);
  sliderBottomRow.appendChild(slider);
  sliderWrapper.appendChild(sliderBottomRow);
  content.appendChild(sliderWrapper);

  // --- Size slider ---
  const widthWrapper = document.createElement("div");
  widthWrapper.className = "cv-force-row";
  const widthLabel = document.createElement("label");
  widthLabel.textContent = "Arrow Size (Diameter): ";
  const widthValue = document.createElement("span");
  widthValue.className = "cv-force-value";
  widthValue.textContent = (general.forceRadius ?? 0.1).toFixed(2);
  const widthSlider = /** @type {any} */ (document.createElement("input"));
  widthSlider.type = "range";
  widthSlider.min = 0.01; widthSlider.max = 0.15; widthSlider.step = 0.01;
  widthSlider.value = general.forceRadius ?? 0.1;
  widthWrapper.appendChild(widthLabel);
  widthWrapper.appendChild(widthValue);
  widthWrapper.appendChild(widthSlider);
  content.appendChild(widthWrapper);

  // --- Species Visibility Panel ---
  const speciesVisibilityLabel = document.createElement("div");
  speciesVisibilityLabel.className = "cv-force-subheading";
  speciesVisibilityLabel.textContent = "Species Visibility:";
  content.appendChild(speciesVisibilityLabel);

  const speciesVisibilityContainer = document.createElement("div");
  speciesVisibilityContainer.id = "forceSpeciesVisibilityContainer";
  speciesVisibilityContainer.className = "cv-species-toggle-grid";
  content.appendChild(speciesVisibilityContainer);

  // --- Color Map dropdown + color bar ---
  const colorMapWrapper = document.createElement("div");
  colorMapWrapper.className = "cv-force-row";

  const colorMapLabel = document.createElement("label");
  colorMapLabel.textContent = "Color Map: ";
  colorMapLabel.className = "cv-force-label-block";

  const colorMapRow = document.createElement("div");
  colorMapRow.className = "cv-force-colormap";

  const colorMapSelect = document.createElement("select");
  colorMapSelect.className = "cv-scene-select cv-scene-select--flex";

  // Same set/order SpinPanel.js offers, so the two panels read as one
  // consistent system instead of each having its own slightly different list.
  const options = [
    ["none", "None (Default)"],
    ["direction", "Direction Map"],
    ["plusminus", "Plus-Minus Map"],
    ["element", "Element Color Map"],
    ["heatmap", "Heat Map"],
    ["batlow", "Batlow"],
    ["hawaii", "Hawaii"],
    ["managua", "Managua"],
    ["viridis", "Viridis"],
    ["plasma", "Plasma"],
    ["spectralR", "Spectral R"],
    ["jet", "Jet"],
  ];
  options.forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    colorMapSelect.appendChild(opt);
  });
  colorMapSelect.value = general.forceColorMap ?? "heatmap";
  colorMapRow.appendChild(colorMapSelect);

  // --- Log Scale + Auto Range, side by side, above the color bar itself ---
  const barControlsRow = document.createElement("div");
  barControlsRow.className = "cv-force-bar-controls cv-force-bar-controls--force";

  const logLabel = document.createElement("label");
  logLabel.className = "cv-force-check";

  const logCheckbox = document.createElement("input");
  logCheckbox.type = "checkbox";
  logCheckbox.id = "forceLogScaleCheckbox";
  logCheckbox.checked = general.forceColorScale === "log";

  logLabel.appendChild(logCheckbox);
  logLabel.appendChild(document.createTextNode("Log Scale"));

  // "log length" (above, next to Global Scaling) forces this on and locks it
  // — a log-length arrow next to a linear color scale would disagree about
  // what a given force magnitude looks like. Unlocks again once "log
  // length" is turned back off (but doesn't force Log Scale back off; that
  // stays the user's own choice).
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

  const colorBarContainer = document.createElement("div");
  colorBarContainer.id = "forceColorBarContainer";
  colorBarContainer.className = "cv-force-colorbar-container cv-force-hidden";

  colorMapWrapper.appendChild(colorMapLabel);
  colorMapWrapper.appendChild(colorMapRow);
  colorMapWrapper.appendChild(barControlsRow);
  colorMapWrapper.appendChild(colorBarContainer);
  content.appendChild(colorMapWrapper);

  // --- Build hierarchy ---
  panel.appendChild(content);
  group.appendChild(panel);
  targetPanel.appendChild(group);

  function currentColorMap() { return colorMapSelect.value; }

  // preserveRange: keep whatever's in general.forceMin/forceMax (typed in by
  // the user, or from an earlier build) instead of recomputing from the
  // structure's force lengths. Callers that only change how the same range
  // is displayed (the colormap dropdown) pass true; callers where the
  // underlying data may have changed (initial build) recompute.
  function refreshColorBarVisibility(preserveRange = false) {
    const cmap = currentColorMap();
    const isScalar = cmap !== "none" && cmap !== "direction" && cmap !== "plusminus" && cmap !== "element";
    barControlsRow.classList.toggle("cv-force-hidden", !isScalar);

    // The bar may currently be floating over the scene (dragged out of
    // colorBarContainer into document.body), so innerHTML='' alone wouldn't
    // remove it — dispose the instance explicitly, persisting its
    // orientation/floating position into general first (read back below)
    // so a colormap change doesn't dock it or flip it back to horizontal.
    captureColorBarState();
    colorBarInstance?.remove();
    colorBarInstance = null;
    colorBarContainer.innerHTML = '';

    if (isScalar) {
      colorBarContainer.classList.remove("cv-force-hidden");

      let minValue = general.forceMin;
      let maxValue = general.forceMax;
      const haveUsableRange = preserveRange && isFinite(minValue) && isFinite(maxValue) && minValue < maxValue;

      if (!haveUsableRange) {
        minValue = 0;
        maxValue = 2;

        const structure = fileBrowser.selectedStructure;
        if (structure?.forces) {
          const lengths = structure.forces
            .map(force => {
              if (!force.vector) return 0;
              const mag = Math.sqrt(force.vector[0] ** 2 + force.vector[1] ** 2 + force.vector[2] ** 2);
              return mag * (force.scaling ?? 1.0);
            })
            .filter(len => len > 0.05);

          if (lengths.length > 0) {
            minValue = Math.min(...lengths);
            maxValue = Math.max(...lengths);
            minValue = Math.ceil(minValue * 10) / 10;
            maxValue = Math.ceil(maxValue * 10) / 10;
            maxValue = Math.ceil(maxValue * 1.05 * 10) / 10;
            if (minValue >= maxValue) minValue = Math.floor(maxValue * 0.9 * 10) / 10;
          }
        }

        if (minValue >= maxValue) { minValue = 0; maxValue = 2; }

        general.forceMin = minValue;
        general.forceMax = maxValue;
      }

      colorBarInstance = createColorBar(colorBarContainer, cmap, minValue, maxValue, {
        floatingId: FORCE_COLORBAR_FLOATING_ID,
        fallbackMin: minValue,
        fallbackMax: maxValue,
        legend: general.forceLegendText ?? "Force (eV/Å)",
        scale: general.forceColorScale,
        orientation: general.forceColorBarOrientation,
        flipSide: general.forceColorBarFlipSide,
        size: general.colorBarSize,
        isLocked: () => general.forceColorBarLocked,
        onLockChange: (locked) => { general.forceColorBarLocked = locked; },
        onLimitsCommit: (min, max) => {
          general.forceMin = min;
          general.forceMax = max;
          redraw();
        },
        onScaleChange: (scale) => applyLogScale(scale === "log"),
        onAutoRange: () => applyAutoRange(),
        isScaleLocked: () => logLengthCheckbox.checked,
      });
      if (general.forceColorBarFloating && general.forceColorBarFloatPos) {
        colorBarInstance.floatAtAnchor(general.forceColorBarFloatPos);
      }
    } else {
      colorBarContainer.classList.add("cv-force-hidden");
    }
  }

  function updateNoForcesNote() {
    const hasForces = !!fileBrowser.selectedStructure?.forces?.length;
    noForcesNote.classList.toggle("cv-force-hidden", hasForces);
    histogramBtn.disabled = !hasForces;
    histogramBtn.title = hasForces
      ? "Open the Force Histogram window"
      : "No force data on this structure — nothing to plot";
  }

  function redraw() {
    updateNoForcesNote();
    // Every control in this panel (sliders, colormap, species toggles,
    // range/scale changes) funnels through here — gating on forcesActive
    // once, right here, means none of them can render arrows into the scene
    // while "Show Forces" is off, whether that's the panel's own initial
    // build or a later user interaction.
    if (general.forcesActive && fileBrowser.selectedStructure?.forces?.length) {
      updateForces(general.forceScale ?? 1.0, currentColorMap());
    }
  }

  // Shared by the side-panel checkbox and the floating color bar's own
  // layout-menu "Log Scale" item (ColorBarWidget.js's onScaleChange) — either
  // one can flip it, and both stay in sync since this is the only place that
  // actually applies the change.
  function applyLogScale(isLog) {
    general.forceColorScale = isLog ? "log" : "linear";
    // log10(0) is -Infinity, so a min of 0 (the usual "no forces yet"
    // default, or just what the auto-computed range rounds down to) breaks
    // the log color mapping and the tick math — floor it to a small
    // positive value the moment log scale turns on.
    if (isLog && general.forceMin <= 0) {
      general.forceMin = 0.01;
      colorBarInstance?.setRange(general.forceMin, general.forceMax);
    }
    logCheckbox.checked = isLog;
    colorBarInstance?.update(currentColorMap(), general.forceColorScale);
    redraw();
  }

  // Shared by the Auto Range button and the layout menu's own "Auto Range"
  // item (onAutoRange). Recomputes min/max from the actual force magnitudes
  // currently on the structure (not whatever was last typed/loaded), padded
  // 20% of the data's own span on each side (computeAutoRange) so values
  // right at the extremes don't read as clipped/off-scale.
  function applyAutoRange() {
    const structure = fileBrowser.selectedStructure;
    if (!structure?.forces?.length) return;
    const magnitudes = structure.forces.map((force) => {
      if (!force?.vector) return NaN;
      const mag = Math.sqrt(force.vector[0] ** 2 + force.vector[1] ** 2 + force.vector[2] ** 2);
      return mag * (force.scaling ?? 1.0);
    });
    const range = computeAutoRange(magnitudes, 0.2, { clampMinAtZero: true });
    if (!range) return;
    let { min, max } = range;
    // Same log10(0) = -Infinity guard applyLogScale uses.
    if (general.forceColorScale === "log" && min <= 0) min = 0.01;
    general.forceMin = min;
    general.forceMax = max;
    colorBarInstance?.setRange(min, max);
    redraw();
  }
  autoRangeBtn.addEventListener("click", applyAutoRange);

  // --- Event listeners ---
  slider.addEventListener("input", () => {
    let val = parseFloat(slider.value);
    if (Math.abs(val - 1) < 0.05) val = 1;
    slider.value = val;
    sliderValue.textContent = val.toFixed(2);
    general.forceScale = val;
    redraw();
  });

  widthSlider.addEventListener("input", () => {
    const val = parseFloat(widthSlider.value);
    widthValue.textContent = val.toFixed(2);
    general.forceRadius = val;
    redraw();
  });

  logLengthCheckbox.addEventListener("change", () => {
    general.forceLengthLogScale = logLengthCheckbox.checked;
    if (logLengthCheckbox.checked) {
      applyLogScale(true); // forces + (via syncLogScaleLock below) locks Log Scale on; redraws
    } else {
      redraw();
    }
    syncLogScaleLock();
  });

  colorMapSelect.addEventListener("change", () => {
    general.forceColorMap = currentColorMap();
    refreshColorBarVisibility(true);

    // When "none" is selected, reset forces to their default color instead
    // of leaving whatever a previous colormap last computed (mirrors
    // SpinPanel.js's own "none" handling).
    if (general.forceColorMap === "none") {
      const structure = fileBrowser.selectedStructure;
      structure?.forces?.forEach(force => { if (force.defaultColor) force.color = force.defaultColor; });
    }

    redraw();
  });

  logCheckbox.addEventListener("change", () => {
    applyLogScale(logCheckbox.checked);
  });

  // --- Function to create species visibility toggles ---
  function createSpeciesVisibilityToggles() {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;

    speciesVisibilityContainer.innerHTML = '';

    const uniqueElements = [...new Set(structure.elements)];

    uniqueElements.forEach(element => {
      const toggleItem = createElement("div", { class: "cv-species-toggle-item" });

      // The shared pill (toggle_styles.css); cv-species-toggle only shrinks it.
      const toggleContainer = createElement("label", { class: "toggle_switch cv-species-toggle" });

      const checkbox = createElement("input", {
        type: "checkbox",
        id: `force-species-${element}`,
        checked: "checked"
      });

      const slider = createElement("span", { class: "toggle_slider" });

      toggleContainer.appendChild(checkbox);
      toggleContainer.appendChild(slider);

      const label = createElement("label", {
        for: `force-species-${element}`,
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
        redraw();
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
  if (general.forceLengthLogScale) {
    general.forceColorScale = "log";
    logCheckbox.checked = true;
  }
  syncLogScaleLock();

  // Initialize species visibility toggles, color bar, and the no-forces note
  createSpeciesVisibilityToggles();
  refreshColorBarVisibility();
  updateNoForcesNote();
}
