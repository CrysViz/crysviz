import { createColorPicker } from './ColorPickerModule.js';
import {updateVisualization} from '../core/crystal-viewer.js';
import { app, groups,fileBrowser, general, RENDERING_DEFAULTS} from '../state/store.js';
import {getHeatMapColors,getBatlowColors,getHawaiiColors,getManaguaColors, getViridisColors,getPlasmaColors,getSpectralRColors,getJetColors} from '../defaults/color_texture_defaults.js'

import { updateBonds } from '../render/index.js'
import { updateAtoms } from '../render/index.js'
import { updateSingleBondColor } from '../render/index.js'
import { updatePolyhedra, updatePolyhedraColors, setCelHullWidth, setCelHullPolyWidth } from '../render/index.js'
import { listPipelines, setActivePipeline, requestRender } from '../render/index.js'
import { updateGroundPlane } from '../render/index.js'
import { makeSectionHeadline } from './panels/sectionHeadline.js'
import { maybeShowRaytraceWarning } from './RaytraceWarningModal.js'
import { sizeSliderToValue, sizeValueToSlider, GROUND_OFFSET_RANGE, GROUND_SIZE_RANGE } from './ControlsWiring.js'
import { createColorBar } from './ColorBarWidget.js'
import { registerColorBarSource } from './ColorBarRegistry.js'
import { computeAutoRange } from '../utils/index.js'



function createElement(tag, attributes = {}, styles = {}, textContent = "") {
  const el = document.createElement(tag);
  Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(styles).forEach(([k, v]) => (el.style[k] = v));
  if (textContent) el.textContent = textContent;
  return el;
}

// --- Dropdown Creation ---
// One full-width row: label left, select filling the rest (.control-row in
// styles/toggle_styles.css).
function createDropdown(id, labelText, options, onChange) {
  const block = createElement("div", { class: "control-row" });
  const label = createElement("label", { for: id }, {}, labelText);
  const select = createElement("select", { id });

  options.forEach((opt) => {
    const option = createElement("option", { value: opt.value }, {}, opt.text);
    if (opt.selected) option.selected = true;
    if (opt.disabled) option.disabled = true;
    select.appendChild(option);
  });

  select.addEventListener("change", onChange);
  block.appendChild(label);
  block.appendChild(select);
  return block;
}

/** Options for the "Rendering pipeline" dropdown, in registry order: the
 *  visible pipelines, with hidden ones (superseded split/sorted) omitted —
 *  unless general.showAllRenderPipelines lists them all, or a hidden pipeline
 *  is the currently-active id (a restored/console-set session), in which case
 *  its option is kept so the select stays truthful. */
function renderPipelineOptions() {
  const activeId = general.renderPipeline;
  return listPipelines()
    .filter((p) => !p.hidden || general.showAllRenderPipelines || p.id === activeId)
    .map((p) => ({ value: p.id, text: p.label, selected: p.id === activeId }));
}

/** Rebuild the #renderPipelineMenu <option> list from current state. Called on
 *  session restore (so a restored hidden pipeline id gains an option before the
 *  select is set) and whenever general.showAllRenderPipelines is toggled. */
export function rebuildRenderPipelineMenu() {
  const select = /** @type {HTMLSelectElement} */ (document.getElementById("renderPipelineMenu"));
  if (!select) return;
  select.textContent = "";
  renderPipelineOptions().forEach((opt) => {
    const option = createElement("option", { value: opt.value }, {}, opt.text);
    if (opt.selected) option.selected = true;
    select.appendChild(option);
  });
}

// Keeps the "Element Color Map" dropdown truthful when something outside its
// own onChange changes what it represents - restoring a share link (which
// sets general.useDefaultColors directly) or touching general.customColorMap
// via the Custom User Settings panel (which layers per-element overrides on
// top of whichever base scheme is selected, so the dropdown should show
// "User (custom)" the moment any override exists).
export function syncElementColorMapDropdown() {
  const select = document.getElementById('atomsElementColorMapMenu');
  if (!select) return;
  const hasOverrides = Object.keys(general.customColorMap).length > 0;
  select.value = hasOverrides ? 'user' : (general.useDefaultColors ? 'default' : 'jmol');
}

// --- Color Mapping Functions ---

// Bonds only mirror atom colors in "elements" mode (or the unset default) —
// every atom-color-driven sync below is a no-op otherwise, so a bond in
// Length/White/Solid mode is never touched just because an atom's color
// changed.
function bondsFollowAtomColors() {
  return general.bondsColor === "elements" || general.bondsColor == null;
}

// Mirrors `color` onto ONE mesh-instance's (one periodic image's) attached
// bond halves — the single primitive behind every atom-color-driven bond
// sync in the app (color-map/mode dropdowns, individual atom/element
// pickers, resets). A per-bond user override (bond.userColor, set via the
// individual bond color picker) must always win over this mirroring — see
// updateSingleBond's color precedence (bond userColor > atom userColor >
// mode color) in BondsFracUpdateModule.js — so an overridden half is
// skipped, and this never itself writes bond.userColor: it's a mode-driven
// mirror, not a deliberate per-bond pick, and marking it as one would
// permanently freeze that half against every future legitimate sync.
export function syncBondHalvesToImageColor(structure, imageIndex, color) {
  if (!bondsFollowAtomColors()) return;
  if (!structure?.bondMapping?.[imageIndex]) return;
  structure.bondMapping[imageIndex].forEach((bondHalvIndex) => {
    const indexset = structure.bondObjectMapping[bondHalvIndex];
    const bond = structure.bonds[indexset[0]];
    if (bond.userColor?.[indexset[1]] != null) return;
    updateSingleBondColor(bondHalvIndex, color, true);
    bond.color[indexset[1]] = color;
  });
}

// Mirrors one atom's color onto every one of its periodic images' bond halves.
export function syncBondHalvesToAtomColor(structure, atomIndex, color) {
  structure?.atomImages?.[atomIndex]?.forEach((imageIndex) => {
    syncBondHalvesToImageColor(structure, imageIndex, color);
  });
}

function syncBondsToAtomColors(structure) {
  if (!structure || !structure.atoms) return;
  structure.atoms.forEach((atom, atomIndex) => {
    syncBondHalvesToAtomColor(structure, atomIndex, atom.getColor());
  });
  updateBonds();
}

function updateBondColorsByLength() {
  const bonds = fileBrowser.selectedStructure.bonds;
  if (!bonds) return;

  bonds.forEach((bond, bondIndex) => {
    if (!bond.visibleLen || bond.visibleLen <= 1e-3) return;
    const color = bondLengthToColor(bond.dist, general.BondMin, general.BondMax);
    bond.color[0] = color;
    bond.color[1] = color;
    updateSingleBondColor(bondIndex * 2, color,true);
    updateSingleBondColor(bondIndex * 2 + 1, color,true);
  });

  if (groups.bondsMesh) {
    groups.bondsMesh.instanceColor.needsUpdate = true;
  }
}

function colorMapColors(colorMapName) {
  switch (colorMapName) {
    case "batlow": return getBatlowColors();
    case "hawaii": return getHawaiiColors();
    case "managua": return getManaguaColors();
    case "viridis": return getViridisColors();
    case "plasma": return getPlasmaColors();
    case "spectralR": return getSpectralRColors();
    case "jet": return getJetColors();
    default: return getHeatMapColors();
  }
}

const COLOR_LOG_EPS = 1e-6;

function valueToColor(value, minVal, maxVal, colorMapName, useLog = false) {
  const colors = colorMapColors(colorMapName);
  if (!colors || colors.length === 0) {
    return "#ffffff";
  }

  const nBins = colors.length;
  const clamped = Math.max(minVal, Math.min(maxVal, value));
  let t;
  if (useLog) {
    const lo = Math.log10(Math.max(minVal, COLOR_LOG_EPS));
    const hi = Math.log10(Math.max(maxVal, COLOR_LOG_EPS));
    const v = Math.log10(Math.max(clamped, COLOR_LOG_EPS));
    t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
  } else {
    t = (maxVal > minVal) ? (clamped - minVal) / (maxVal - minVal) : 0.5;
  }
  const bin = Math.min(Math.max(0, Math.floor(t * nBins)), nBins - 1);
  // getHexString(), not manual r*255 truncation: these THREE.Color objects
  // store their intended sRGB appearance internally as linear (color
  // management), so reading .r/.g/.b directly and truncating them as if
  // they were already 0-255 sRGB values skips the linear->sRGB conversion
  // getHexString() does — same value ends up a visibly different color than
  // what the same colormap+value renders as on an instanced mesh (which
  // reads .r/.g/.b directly, correctly, as linear).
  return `#${colors[bin].getHexString()}`;
}

export function bondLengthToColor(bondLength, minVal = general.BondMin, maxVal = general.BondMax) {
  return valueToColor(bondLength, minVal, maxVal, general.bondsColorMap, general.bondColorScale === "log");
}

// Same binning as bondLengthToColor, but reads the ATOMS color map
// (general.atomColorMap) — used to recompute an individual atom's force
// color (on reset, or when force mode repaints), which must track whatever
// color map the Atoms panel currently has selected, not the Bonds one.
export function atomForceToColor(magnitude, minVal = general.ForceMin, maxVal = general.ForceMax) {
  return valueToColor(magnitude, minVal, maxVal, general.atomColorMap, general.atomColorScale === "log");
}

function updateAtomColorsByForce() {
  const structure = fileBrowser.selectedStructure;
  if (!structure || !structure.atoms) {
    alert("No atoms data available for force coloring. Using element colors instead.");
    return false;
  }

  // Check if forces exist and match atom count
  if (!structure.forces || structure.forces.length !== structure.atoms.length) {
    alert("No force data available for this structure. Using element colors instead.");
    return false;
  }

  // Print first few force vectors for debugging

  const colorMap = general.atomColorMap || "heatmap";

  // Get color array
  const colors = colorMapColors(colorMap);

  if (!colors || colors.length === 0) {
    alert("No colors available for selected color map. Using element colors instead.");
    return false;
  }

  // Auto-calculate range if min equals max
  if (general.ForceMin === general.ForceMax) {
    let actualMin = Infinity;
    let actualMax = -Infinity;
    structure.forces.forEach(forceObj => {
      const vector = forceObj.vector;
      if (!vector || vector.length < 3) return;
      const magnitude = Math.sqrt(vector[0]*vector[0] + vector[1]*vector[1] + vector[2]*vector[2]);
      actualMin = Math.min(actualMin, magnitude);
      actualMax = Math.max(actualMax, magnitude);
    });
    general.ForceMin = actualMin;
    general.ForceMax = actualMax === actualMin ? actualMin + 1 : actualMax;
  }

  // Read AFTER the auto-calc above (not before, into stale locals) — it may
  // have just replaced general.ForceMin/Max, and every atom below needs the
  // final range, not whatever was there before this call.
  const min = general.ForceMin;
  const max = general.ForceMax;

  structure.atoms.forEach((atom, atomIndex) => {
    const forceObj = structure.forces[atomIndex];
    if (!forceObj || !forceObj.vector || forceObj.vector.length < 3) {
      const element = structure.elements[atomIndex];
      atom.color = structure.getDefaultElementColor(element);
      return;
    }

    const vector = forceObj.vector;
    const magnitude = Math.sqrt(vector[0]*vector[0] + vector[1]*vector[1] + vector[2]*vector[2]);
    // Delegates to the same binning valueToColor uses elsewhere (bonds-by-
    // length, atomForceToColor) instead of a second hand-rolled copy — this
    // one used to be linear-only, unlike valueToColor's now-log-aware
    // version, and there's no reason the two should drift.
    atom.color = valueToColor(magnitude, min, max, colorMap, general.atomColorScale === "log");
  });

  if (groups.atomsMesh) {
    groups.atomsMesh.instanceColor.needsUpdate = true;
  }
  return true;
}

export function addColorPanel(target = "colorContainer") {
  const targetPanel = document.getElementById(target);
  if (!targetPanel || document.getElementById("colorControlsGroup")) return;

  // Collapse/expand is handled by the unified panel window (ui/panels/)
  // hosting this content, so no header/toggle is built here.
  const group = createElement("div", { id: "colorControlsGroup" });
  const panel = createElement("div", { id: "colorSettingsPanel" });

  const content = createElement("div", {
    id: "colorControlsContent"
  });

  // The Rendering section is a dependency tree: the pipeline comes first and
  // decides which of the remaining controls make sense — per-pipeline knobs
  // (peel layers / tracer sliders), then Render Style (raster pipelines only:
  // the tracers have their own material model), then the cel outline block
  // (raster + cel only). One helper computes ALL visibility from state so the
  // dropdown handlers and share-restore stay consistent.
  const RASTER_PIPELINES = ["forward", "split-atoms", "sorted-atoms", "wboit", "depthpeel"];
  function updateRenderingControlsVisibility() {
    const isRaster = RASTER_PIPELINES.includes(general.renderPipeline);
    const isTracer = general.renderPipeline === "raytrace" || general.renderPipeline === "pathtrace";
    depthPeelBlock.style.display = general.renderPipeline === "depthpeel" ? "grid" : "none";
    rtControlsBlock.style.display = isTracer ? "block" : "none";
    // The denoiser lives in the shared tracer "Advanced" section (visible for
    // both tracers), but is a path-tracing-only control, so its row is toggled
    // individually here.
    ptDenoiseRow.style.display = general.renderPipeline === "pathtrace" ? "grid" : "none";
    // The ground block is always visible (all pipelines), but "Ground reflect"
    // is a tracer-only analytic-mirror control, so its row is toggled here.
    groundReflectRow.style.display = isTracer ? "grid" : "none";
    renderStyleMenu.style.display = isRaster ? "grid" : "none";
    outlineBlock.style.display = isRaster && general.renderStyle === "cel" ? "block" : "none";
    // Structure-window tracer-only blocks (material editors) hide under the
    // raster pipelines via this body class (see styles.css). The underlying
    // material stores are always persisted regardless.
    document.body.classList.toggle("tracer-pipeline", isTracer);
  }

  // Render style (material) dropdown. Switching style rebuilds the meshes:
  // cel shading uses a different material class (MeshToonMaterial), so the
  // materials cannot just be re-parameterized in place.
  const renderStyleMenu = createDropdown("renderStyleMenu", "Render Style", [
    { value: "metallic", text: "Metallic", selected: general.renderStyle === "metallic" },
    { value: "matte", text: "Matte", selected: general.renderStyle === "matte" },
    { value: "cel", text: "Cel shading", selected: general.renderStyle === "cel" },
  ], () => {
    general.renderStyle = renderStyleMenu.querySelector("select").value;
    updateRenderingControlsVisibility();
    const hasComparison = !!fileBrowser.comparisonStructure;
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      SecondReRenderAtoms: hasComparison,
      SecondReRenderBonds: hasComparison,
    });
    // Hull outlines are children created at polyhedra build time — rebuild so
    // they appear/disappear with the style (no-op when polyhedra are off).
    if (general.celOutlineMode === "hull") updatePolyhedra();
  });

  // Rendering pipeline (how a frame is drawn) — the top of the tree.
  const renderPipelineMenu = createDropdown("renderPipelineMenu", "Rendering pipeline",
    renderPipelineOptions(), () => {
      const pipelineValue = renderPipelineMenu.querySelector("select").value;
      const wasTracer = general.renderPipeline === 'raytrace' || general.renderPipeline === 'pathtrace';
      const isTracer = pipelineValue === 'raytrace' || pipelineValue === 'pathtrace';
      const doSwitch = () => {
        setActivePipeline(pipelineValue);
        updateRenderingControlsVisibility();
      };
      // Performance warning each time a (potentially slow) tracer mode is
      // ENTERED from a raster mode — switching between the two tracers does not
      // re-warn; "Don't show this again" suppresses it permanently. When the
      // warning IS shown the switch is DEFERRED: the prior (raster) pipeline
      // keeps rendering (responsive GUI) while the modal is open. Ok performs
      // the switch; Cancel/Escape/backdrop reverts the dropdown to the pipeline
      // that is still active (general.renderPipeline). updateRenderingControls-
      // Visibility reads general.renderPipeline (not the select), so no tracer
      // knobs flash while the modal is open.
      if (isTracer && !wasTracer) {
        const shown = maybeShowRaytraceWarning({
          onConfirm: doSwitch,
          onCancel: () => {
            renderPipelineMenu.querySelector("select").value = general.renderPipeline;
            updateRenderingControlsVisibility();
          },
        });
        if (!shown) doSwitch(); // suppressed -> switch immediately as before
      } else {
        doSwitch();
      }
    });
  content.appendChild(renderPipelineMenu);

  // Depth-peeling quality/performance knob: number of peel passes per frame
  // (transparent surfaces deeper than this many layers are dropped). Shown
  // only while the depthpeel pipeline is selected.
  const depthPeelBlock = createElement("div", { class: "control-row" },
    { display: general.renderPipeline === "depthpeel" ? "grid" : "none" });
  const depthPeelLabel = createElement("label", { for: "depthPeelLayersSlider" }, {},
    `Peel layers: ${general.depthPeelLayers}`);
  const depthPeelSlider = createElement("input", {
    type: "range", id: "depthPeelLayersSlider", min: "1", max: "10", step: "1",
    value: String(general.depthPeelLayers),
  });
  depthPeelSlider.addEventListener("input", () => {
    general.depthPeelLayers = parseInt(depthPeelSlider.value, 10);
    depthPeelLabel.textContent = `Peel layers: ${general.depthPeelLayers}`;
    requestRender();
  });
  depthPeelBlock.appendChild(depthPeelLabel);
  depthPeelBlock.appendChild(depthPeelSlider);
  content.appendChild(depthPeelBlock);

  // Ray/path-tracing controls: internal render resolution (quality/perf knob)
  // and extra mirror reflectivity, shared by the raytrace + pathtrace
  // pipelines so the two can be compared apples to apples; changes take
  // effect on the next accumulated frame (the pipelines read `general`).
  const isTracerPipeline = general.renderPipeline === "raytrace" || general.renderPipeline === "pathtrace";
  const rtControlsBlock = createElement("div", { id: "rtControlsBlock" },
    { display: isTracerPipeline ? "block" : "none" });
  const rtResRow = createElement("div", { class: "control-row" });
  const rtResLabel = createElement("label", { for: "rtResolutionScale" }, {},
    `RT resolution: ${Math.round((general.rtResolutionScale ?? 0.95) * 100)}%`);
  const rtResSlider = createElement("input", {
    type: "range", id: "rtResolutionScale", min: "0.25", max: "1", step: "0.05",
    value: String(general.rtResolutionScale),
  });
  rtResSlider.addEventListener("input", () => {
    general.rtResolutionScale = parseFloat(rtResSlider.value);
    rtResLabel.textContent = `RT resolution: ${Math.round(general.rtResolutionScale * 100)}%`;
    requestRender();
  });
  rtResRow.appendChild(rtResLabel);
  rtResRow.appendChild(rtResSlider);
  rtControlsBlock.appendChild(rtResRow);

  // Tiled ("gentle") rendering: split each accumulation sample into scissored
  // tiles, one per frame, so the shared GPU stays responsive while the tracer
  // converges (default ON). Toggling restarts the accumulation. Lives in the
  // "Advanced" section built below.
  const rtTiledRow = createElement("div", { class: "control-row" });
  const rtTiledLabel = createElement("label", { for: "rtTiledToggle" }, {}, "Tiled rendering");
  const rtTiledToggle = createElement("input", { type: "checkbox", id: "rtTiledToggle" },
    { justifySelf: "start", width: "auto" });
  rtTiledToggle.checked = general.rtTiledRender !== false;
  rtTiledToggle.addEventListener("change", () => {
    general.rtTiledRender = rtTiledToggle.checked;
    app.pipeline?.resetAccumulation?.();
    requestRender();
  });
  rtTiledRow.appendChild(rtTiledLabel);
  rtTiledRow.appendChild(rtTiledToggle);

  // Interactive raster preview: while the user drives the view, render cheap
  // depth-peeled frames instead of tracing, resuming the tracer after a hidden
  // config-only rest delay (general.rtPreviewRestDelay; no GUI). Default ON. No
  // accumulation reset on toggle — it changes only how interactive frames are
  // drawn, not the converged image. Lives in the "Advanced" section below.
  const rtPreviewRow = createElement("div", { class: "control-row" });
  const rtPreviewLabel = createElement("label", { for: "rtPreviewToggle" }, {}, "Interactive raster preview");
  const rtPreviewToggle = createElement("input", { type: "checkbox", id: "rtPreviewToggle" },
    { justifySelf: "start", width: "auto" });
  rtPreviewToggle.checked = general.rtRasterPreview !== false;
  rtPreviewToggle.addEventListener("change", () => {
    general.rtRasterPreview = rtPreviewToggle.checked;
    requestRender();
  });
  rtPreviewRow.appendChild(rtPreviewLabel);
  rtPreviewRow.appendChild(rtPreviewToggle);

  // Match background color: pin the traced backdrop to the exact picked
  // background color (the pipeline inverse-tone-maps primary-miss rays;
  // default ON). Off restores the older look where the backdrop is
  // tone-mapped along with the scene. Lives in the "Advanced" section below.
  const rtBgMatchRow = createElement("div", { class: "control-row" });
  const rtBgMatchLabel = createElement("label", { for: "rtBgMatchToggle" }, {}, "Match background color");
  const rtBgMatchToggle = createElement("input", { type: "checkbox", id: "rtBgMatchToggle" },
    { justifySelf: "start", width: "auto" });
  rtBgMatchToggle.checked = general.rtBackgroundMatch !== false;
  rtBgMatchToggle.addEventListener("change", () => {
    general.rtBackgroundMatch = rtBgMatchToggle.checked;
    app.pipeline?.resetAccumulation?.();
    requestRender();
  });
  rtBgMatchRow.appendChild(rtBgMatchLabel);
  rtBgMatchRow.appendChild(rtBgMatchToggle);

  // Legacy tone mapping: the original tracers' Reinhard operator (muted,
  // desaturated midtones) instead of exposure x ACES (raster parity; default).
  // Output-pass only — no accumulation reset needed (the traced-background
  // interplay with "Match background color" rides the pipeline's look key).
  // Lives in the "Advanced" section below.
  const rtLegacyToneRow = createElement("div", { class: "control-row" });
  const rtLegacyToneLabel = createElement("label", { for: "rtLegacyToneToggle" }, {}, "Legacy tone mapping");
  const rtLegacyToneToggle = createElement("input", { type: "checkbox", id: "rtLegacyToneToggle" },
    { justifySelf: "start", width: "auto" });
  rtLegacyToneToggle.checked = general.rtToneMapLegacy === true;
  rtLegacyToneToggle.addEventListener("change", () => {
    general.rtToneMapLegacy = rtLegacyToneToggle.checked;
    requestRender();
  });
  rtLegacyToneRow.appendChild(rtLegacyToneLabel);
  rtLegacyToneRow.appendChild(rtLegacyToneToggle);

  // Denoiser (path-tracing only): edge-aware denoiser on the screen output.
  // Lives in the shared "Advanced" section (visible for both tracers) but its
  // row is shown only under the pathtrace pipeline (updateRenderingControlsVisibility).
  const ptDenoiseRow = createElement("div", { class: "control-row" });
  const ptDenoiseLabel = createElement("label", { for: "ptDenoiseToggle" }, {}, "Denoiser");
  const ptDenoiseToggle = createElement("input", { type: "checkbox", id: "ptDenoiseToggle" },
    { justifySelf: "start", width: "auto" });
  ptDenoiseToggle.checked = general.ptDenoise !== false;
  ptDenoiseToggle.addEventListener("change", () => {
    general.ptDenoise = ptDenoiseToggle.checked;
    requestRender();
  });
  ptDenoiseRow.appendChild(ptDenoiseLabel);
  ptDenoiseRow.appendChild(ptDenoiseToggle);

  const rtReflRow = createElement("div", { class: "control-row" });
  const rtReflLabel = createElement("label", { for: "rtReflectivity" }, {},
    `Reflectivity: ${(general.rtReflectivity ?? 0.15).toFixed(2)}`);
  const rtReflSlider = createElement("input", {
    type: "range", id: "rtReflectivity", min: "0", max: "1", step: "0.05",
    value: String(general.rtReflectivity),
  });
  rtReflSlider.addEventListener("input", () => {
    general.rtReflectivity = parseFloat(rtReflSlider.value);
    rtReflLabel.textContent = `Reflectivity: ${general.rtReflectivity.toFixed(2)}`;
    app.pipeline?.resetAccumulation?.();
    requestRender();
  });
  rtReflRow.appendChild(rtReflLabel);
  rtReflRow.appendChild(rtReflSlider);
  rtControlsBlock.appendChild(rtReflRow);

  // helper for the remaining tracer rows: label+slider updating a `general`
  // key, resetting the accumulation so the change takes effect immediately
  // With `quadRange` set, the slider element holds a [0,1] position with the
  // size-sliders' quadratic mapping (fine control near the minimum, large
  // reach at the top); every writer of the ELEMENT value must then write the
  // inverse-mapped position (reset button below, ShareModule restore).
  const makeTracerSliderRow = (id, labelFor, min, max, step, value, fmt, onSet, quadRange) => {
    const rowEl = createElement("div", { class: "control-row" });
    const labelEl = createElement("label", { for: id }, {}, fmt(value));
    const sliderEl = createElement("input", quadRange
      ? { type: "range", id, min: "0", max: "1", step: "any",
          value: String(sizeValueToSlider(value, quadRange)) }
      : { type: "range", id, min: String(min), max: String(max), step: String(step),
          value: String(value) });
    sliderEl.addEventListener("input", () => {
      const v = quadRange
        ? sizeSliderToValue(parseFloat(sliderEl.value), quadRange)
        : parseFloat(sliderEl.value);
      onSet(v);
      labelEl.textContent = fmt(v);
      app.pipeline?.resetAccumulation?.();
      requestRender();
    });
    rowEl.appendChild(labelEl);
    rowEl.appendChild(sliderEl);
    return rowEl;
  };

  // Light softness is shared by both tracers (PT area-light radius, RT
  // shadow-ray cone); DoF and the ground plane apply to both as well.
  rtControlsBlock.appendChild(makeTracerSliderRow('ptLightSoftness', 'ptLightSoftness',
    0, 1, 0.05, general.ptLightSoftness ?? 0.3,
    (v) => `Light softness: ${v.toFixed(2)}`,
    (v) => { general.ptLightSoftness = v; }));
  rtControlsBlock.appendChild(makeTracerSliderRow('rtLightIntensity', 'rtLightIntensity',
    0, 3, 0.05, general.rtLightIntensity ?? 1.2,
    (v) => `Light intensity: ${v.toFixed(2)}`,
    (v) => { general.rtLightIntensity = v; }));
  rtControlsBlock.appendChild(makeTracerSliderRow('rtAmbient', 'rtAmbient',
    0, 1, 0.02, general.rtAmbient ?? 0.3,
    (v) => `Ambient light: ${v.toFixed(2)}`,
    (v) => { general.rtAmbient = v; }));
  // Saturation grades the scene but leaves the BACKGROUND pinned to the
  // picked color (the pipeline bakes the inverse grade into the primary-miss
  // background), so changing it restarts the accumulation like other knobs.
  rtControlsBlock.appendChild(makeTracerSliderRow('rtSaturation', 'rtSaturation',
    0, 2, 0.05, general.rtSaturation ?? 1,
    (v) => `Saturation: ${v.toFixed(2)}`,
    (v) => { general.rtSaturation = v; }));
  rtControlsBlock.appendChild(makeTracerSliderRow('rtDofAperture', 'rtDofAperture',
    0, 2, 0.02, general.rtDofAperture ?? 0,
    (v) => `DoF aperture: ${v.toFixed(2)}`,
    (v) => { general.rtDofAperture = v; }));
  rtControlsBlock.appendChild(makeTracerSliderRow('rtDofFocus', 'rtDofFocus',
    0.2, 3, 0.05, general.rtDofFocus ?? 1,
    (v) => `Focus distance: ×${v.toFixed(2)}`,
    (v) => { general.rtDofFocus = v; }));

  // Ground plane block — ALWAYS VISIBLE (all pipelines): the raster pipelines
  // and tracer preview frames draw a raster ground disc (render/GroundPlaneModule)
  // matched to the tracers' analytic disc, so the floor no longer disappears
  // while the view is manipulated in mixed mode. The block is appended after the
  // cel-outline block (below); only the "Ground reflect" row is tracer-gated
  // (groundReflectRow, toggled in updateRenderingControlsVisibility).
  const groundBlock = createElement("div", {});

  const groundRow = createElement("div", { class: "control-row" });
  const groundLabel = createElement("label", { for: "rtGroundToggle" }, {}, "Ground plane");
  const groundToggle = createElement("input", { type: "checkbox", id: "rtGroundToggle" },
    { justifySelf: "start", width: "auto" });
  groundToggle.checked = !!general.rtGroundPlane;
  groundToggle.addEventListener("change", () => {
    general.rtGroundPlane = groundToggle.checked;
    groundOptions.style.display = groundToggle.checked ? "block" : "none";
    updateGroundPlane(); // create/position/hide the raster disc
    app.pipeline?.resetAccumulation?.();
    requestRender();
  });
  groundRow.appendChild(groundLabel);
  groundRow.appendChild(groundToggle);
  groundBlock.appendChild(groundRow);

  // Ground options (shown while the plane is enabled): orientation, pattern,
  // the two pattern colors (default: follow the background), tile size and
  // the mirror fraction. All changes restart the accumulation via the
  // pipeline's look key; the handlers also reset explicitly for snappiness.
  const groundOptions = createElement("div", {},
    { display: general.rtGroundPlane ? "block" : "none" });
  const groundSelectRow = (id, labelText, options, current, onChange) => {
    const rowEl = createElement("div", { class: "control-row" });
    rowEl.appendChild(createElement("label", { for: id }, {}, labelText));
    const select = createElement("select", { id });
    for (const [value, text] of options) {
      const opt = createElement("option", { value }, {}, text);
      if (value === current) opt.setAttribute("selected", "selected");
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      onChange(/** @type {HTMLSelectElement} */ (select).value);
      app.pipeline?.resetAccumulation?.();
      requestRender();
    });
    rowEl.appendChild(select);
    return rowEl;
  };
  groundOptions.appendChild(groundSelectRow('rtGroundPattern', 'Ground pattern', [
    ['solid', 'Solid'],
    ['checker', 'Checkerboard'],
    ['grid', 'Grid'],
  ], general.rtGroundPattern ?? 'solid', (v) => { general.rtGroundPattern = v; }));

  const groundColorRow = (id, labelText, key) => {
    const rowEl = createElement("div", { class: "control-row" });
    rowEl.appendChild(createElement("label", { for: id }, {}, labelText));
    const input = createElement("input", { type: "color", id },
      { justifySelf: "start", width: "48px", height: "24px", padding: "0" });
    const bg = app.scene?.background;
    input.value = general[key]
      ?? (bg?.isColor ? `#${bg.getHexString()}` : '#e8e8e8');
    input.addEventListener("input", () => {
      general[key] = input.value;
      app.pipeline?.resetAccumulation?.();
      requestRender();
    });
    rowEl.appendChild(input);
    return rowEl;
  };
  groundOptions.appendChild(groundColorRow('rtGroundColor1', 'Ground color 1', 'rtGroundColor1'));
  groundOptions.appendChild(groundColorRow('rtGroundColor2', 'Ground color 2', 'rtGroundColor2'));

  // Offset/size affect PLACEMENT, so they also reposition the raster disc
  // (pattern/colors/scale need nothing — they refresh per-frame in onBeforeRender).
  groundOptions.appendChild(makeTracerSliderRow('rtGroundOffset', 'rtGroundOffset',
    0, 1, 'any', general.rtGroundOffset ?? 0.75,
    (v) => `Ground distance: ${v.toFixed(2)}`,
    (v) => { general.rtGroundOffset = v; updateGroundPlane(); }, GROUND_OFFSET_RANGE));
  groundOptions.appendChild(makeTracerSliderRow('rtGroundSize', 'rtGroundSize',
    0, 1, 'any', general.rtGroundSize ?? 2.5,
    (v) => `Ground size: ${v.toFixed(2)}x`,
    (v) => { general.rtGroundSize = v; updateGroundPlane(); }, GROUND_SIZE_RANGE));
  groundOptions.appendChild(makeTracerSliderRow('rtGroundScale', 'rtGroundScale',
    0.5, 10, 0.25, general.rtGroundScale ?? 2,
    (v) => `Tile size: ${v.toFixed(2)}`,
    (v) => { general.rtGroundScale = v; }));
  // "Ground reflect" is tracer-only (analytic mirror floor); the row is gated to
  // the tracers in updateRenderingControlsVisibility.
  const groundReflectRow = makeTracerSliderRow('rtGroundReflect', 'rtGroundReflect',
    0, 1, 0.05, general.rtGroundReflect ?? 0,
    (v) => `Ground reflect: ${v.toFixed(2)}`,
    (v) => { general.rtGroundReflect = v; });
  groundOptions.appendChild(groundReflectRow);
  groundBlock.appendChild(groundOptions);

  // "Advanced" section: seldom-touched tracer toggles, collapsed by default.
  // Reuses the app's native <details>/<summary> collapsible idiom (the same
  // `eos-collapsible` styling used by the EOS panel's reference-data section:
  // a green header strip with a caret that rotates on open). Shown for both
  // tracers via rtControlsBlock; the Denoiser row inside is toggled to
  // pathtrace-only by updateRenderingControlsVisibility. Collapse state is
  // native <details> UI state — not persisted.
  const rtAdvanced = createElement("details", { class: "eos-collapsible" });
  const rtAdvancedSummary = createElement("summary", { class: "eos-collapsible-summary" });
  rtAdvancedSummary.appendChild(createElement("span", { class: "eos-collapsible-arrow" }, {}, "▶"));
  rtAdvancedSummary.appendChild(createElement("span", {}, {}, "Advanced"));
  rtAdvanced.appendChild(rtAdvancedSummary);
  const rtAdvancedBody = createElement("div", { class: "eos-collapsible-body" });
  rtAdvancedBody.appendChild(rtTiledRow);
  rtAdvancedBody.appendChild(rtPreviewRow);
  rtAdvancedBody.appendChild(rtBgMatchRow);
  rtAdvancedBody.appendChild(rtLegacyToneRow);
  rtAdvancedBody.appendChild(ptDenoiseRow);
  rtAdvanced.appendChild(rtAdvancedBody);
  rtControlsBlock.appendChild(rtAdvanced);

  content.appendChild(rtControlsBlock);

  // Render Style follows the per-pipeline knobs (raster pipelines only).
  content.appendChild(renderStyleMenu);

  // Cel outline controls: mode selector plus mode-specific width sliders.
  // Both widths are world units. 'Screen space' = post-process with clean
  // shared contours, thickness converted from world units per fragment so it
  // tracks zoom (general.celOutlineWidth, read live each frame). '3D hull' =
  // the classic inverted-hull geometry (general.celHullWidth /
  // celHullPolyWidth, live uniform updates; switching MODE rebuilds the
  // meshes since hulls are created at build time).
  const outlineBlock = createElement("div", {},
    { display: general.renderStyle === "cel" ? "block" : "none" });

  const makeSliderRow = (labelText, forId, input) => {
    const row = createElement("div", { class: "control-row" });
    row.appendChild(createElement("label", { for: forId }, {}, labelText));
    row.appendChild(input);
    return row;
  };

  const outlineModeMenu = createDropdown("celOutlineModeMenu", "Outline Mode", [
    { value: "screen", text: "Screen space", selected: general.celOutlineMode === "screen" },
    { value: "hull", text: "3D hull", selected: general.celOutlineMode === "hull" },
  ], () => {
    general.celOutlineMode = outlineModeMenu.querySelector("select").value;
    const isHull = general.celOutlineMode === "hull";
    screenControls.style.display = isHull ? "none" : "block";
    hullControls.style.display = isHull ? "block" : "none";
    const hasComparison = !!fileBrowser.comparisonStructure;
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      SecondReRenderAtoms: hasComparison,
      SecondReRenderBonds: hasComparison,
    });
    updatePolyhedra(); // add/remove polyhedra hull children
  });
  outlineBlock.appendChild(outlineModeMenu);

  const screenControls = createElement("div", {},
    { display: general.celOutlineMode === "screen" ? "block" : "none" });
  // Quadratic slider response: most of the travel controls thin widths, where
  // the differences matter; the top end caps at a moderate max thickness.
  const CEL_OUTLINE_MAX = 0.1; // world units at slider max
  const outlineSlider = createElement("input", {
    type: "range", id: "celOutlineWidth", min: "0", max: "1", step: "0.01",
    value: String(Math.sqrt(Math.min(general.celOutlineWidth, CEL_OUTLINE_MAX) / CEL_OUTLINE_MAX)),
  });
  outlineSlider.addEventListener("input", () => {
    const v = parseFloat(outlineSlider.value);
    general.celOutlineWidth = CEL_OUTLINE_MAX * v * v;
  });
  screenControls.appendChild(makeSliderRow("Outline", "celOutlineWidth", outlineSlider));
  outlineBlock.appendChild(screenControls);

  const hullControls = createElement("div", {},
    { display: general.celOutlineMode === "hull" ? "block" : "none" });
  const hullSlider = createElement("input", {
    type: "range", id: "celHullWidth", min: "0", max: "0.2", step: "0.005",
    value: String(general.celHullWidth),
  });
  hullSlider.addEventListener("input", () => {
    setCelHullWidth(parseFloat(hullSlider.value));
  });
  const hullPolySlider = createElement("input", {
    type: "range", id: "celHullPolyWidth", min: "0", max: "0.2", step: "0.005",
    value: String(general.celHullPolyWidth),
  });
  hullPolySlider.addEventListener("input", () => {
    setCelHullPolyWidth(parseFloat(hullPolySlider.value));
  });
  hullControls.appendChild(makeSliderRow("Outline", "celHullWidth", hullSlider));
  hullControls.appendChild(makeSliderRow("Polyhedra Outline", "celHullPolyWidth", hullPolySlider));

  // Hull outlines are opaque inverted-hull shells; on a transparent object
  // they would black out everything behind it, so transparent objects are
  // skipped. Thicker polyhedra edges ("Polyhedra Edge Width" under Sizes)
  // give a practically similar look.
  const hullNote = createElement("div", { id: "celHullTransparencyNote", class: "control-note" },
    {}, "Note: transparent objects do not get outlines");
  hullControls.appendChild(hullNote);

  outlineBlock.appendChild(hullControls);

  content.appendChild(outlineBlock);

  // Ground plane block: always visible (all pipelines), after the cel-outline
  // block and before the reset row (built above, near the tracer controls).
  content.appendChild(groundBlock);

  // Reset every Rendering-section setting to its default (RENDERING_DEFAULTS
  // in state/store.js — the same values `general` boots with). Routed through
  // the real controls' events so labels, visibility, pipeline switching and
  // mesh rebuilds all follow; no-op dispatches are skipped.
  function resetRenderingSettings() {
    const D = RENDERING_DEFAULTS;
    // Sliders/checkboxes fire unconditionally (their handlers are cheap and
    // idempotent, and `general` may diverge from the DOM value); only the
    // selects are guarded, since their handlers rebuild meshes/pipelines.
    const fire = (id, value, event) => {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      if (!el) return;
      el.value = String(value);
      el.dispatchEvent(new Event(event));
    };
    const fireCheck = (id, checked) => {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      if (!el) return;
      el.checked = checked;
      el.dispatchEvent(new Event('change'));
    };
    // pipeline + style first: they drive the visibility tree and rebuilds
    if (general.renderPipeline !== D.renderPipeline) fire('renderPipelineMenu', D.renderPipeline, 'change');
    if (general.renderStyle !== D.renderStyle) fire('renderStyleMenu', D.renderStyle, 'change');
    if (general.celOutlineMode !== D.celOutlineMode) fire('celOutlineModeMenu', D.celOutlineMode, 'change');
    fire('depthPeelLayersSlider', D.depthPeelLayers, 'input');
    fire('celOutlineWidth', Math.sqrt(D.celOutlineWidth / CEL_OUTLINE_MAX), 'input'); // quadratic slider
    fire('celHullWidth', D.celHullWidth, 'input');
    fire('celHullPolyWidth', D.celHullPolyWidth, 'input');
    fire('rtResolutionScale', D.rtResolutionScale, 'input');
    fireCheck('rtTiledToggle', D.rtTiledRender);
    fireCheck('rtPreviewToggle', D.rtRasterPreview);
    fireCheck('rtBgMatchToggle', D.rtBackgroundMatch);
    fireCheck('rtLegacyToneToggle', D.rtToneMapLegacy);
    fire('rtReflectivity', D.rtReflectivity, 'input');
    fire('ptLightSoftness', D.ptLightSoftness, 'input');
    fire('rtLightIntensity', D.rtLightIntensity, 'input');
    fire('rtAmbient', D.rtAmbient, 'input');
    fire('rtSaturation', D.rtSaturation, 'input');
    fire('rtDofAperture', D.rtDofAperture, 'input');
    fire('rtDofFocus', D.rtDofFocus, 'input');
    fireCheck('rtGroundToggle', D.rtGroundPlane);
    fire('rtGroundPattern', D.rtGroundPattern, 'change');
    // quadratic sliders: the ELEMENT holds a [0,1] position
    fire('rtGroundOffset', sizeValueToSlider(D.rtGroundOffset, GROUND_OFFSET_RANGE), 'input');
    fire('rtGroundSize', sizeValueToSlider(D.rtGroundSize, GROUND_SIZE_RANGE), 'input');
    fire('rtGroundScale', D.rtGroundScale, 'input');
    fire('rtGroundReflect', D.rtGroundReflect, 'input');
    // ground colors: default = null (follow the background)
    general.rtGroundColor1 = D.rtGroundColor1;
    general.rtGroundColor2 = D.rtGroundColor2;
    fireCheck('ptDenoiseToggle', D.ptDenoise);
    requestRender();
  }

  const resetRenderingRow = createElement("div", {}, { margin: "8px 0 4px" });
  const resetRenderingBtn = createElement("button",
    { id: "resetRenderingBtn", type: "button", class: "btn-mini" },
    { padding: "3px 10px", fontSize: "0.85em" }, "Reset rendering settings");
  resetRenderingBtn.addEventListener('click', resetRenderingSettings);
  resetRenderingRow.appendChild(resetRenderingBtn);
  content.appendChild(resetRenderingRow);

  updateRenderingControlsVisibility();

  // =========================
  // ATOMS
  // =========================
  const ATOM_COLORBAR_FLOATING_ID = 'atomColorBarFloating';
  let atomsColorBar = null;
  let atomsMenu; // Declare for access in fallback

  registerColorBarSource('atom', 'Atom Force (eV/Å)', () => atomsColorBar);

  // Save the live color bar's orientation/floating state into `general`
  // right before it's torn down (switching out of Force mode), so switching
  // back in restores it instead of resetting to docked/horizontal.
  function captureAtomColorBarState() {
    if (!atomsColorBar) return;
    const settings = atomsColorBar.getSettings();
    general.atomColorBarOrientation = settings.orientation;
    general.atomColorBarFlipSide = settings.flipSide;
    general.atomColorScale = settings.scale;
    general.colorBarSize = settings.size;
    general.atomLegendText = settings.legend;
    general.atomColorBarFloating = atomsColorBar.isFloating();
    if (general.atomColorBarFloating) {
      general.atomColorBarFloatPos = atomsColorBar.getAnchor();
    }
  }

  const atomsMenuBlock = createElement("div", {});
  atomsMenu = createDropdown("atomsMenu", "Atoms", [
    { value: "elements", text: "Element", selected: true },
    { value: "force", text: "Force" }
  ], onAtomsModeChange);

  const atomsElementColorMapBlock = createElement("div", {});

  const atomsElementColorMapMenu = createDropdown("atomsElementColorMapMenu", "Element Color Map", [
    { value: "default", text: "CrysViz Default", selected: true },
    { value: "jmol", text: "JMol-like" },
    // Not user-selectable (disabled) - this option only ever gets set
    // programmatically by syncElementColorMapDropdown(), to reflect that
    // per-element overrides (Custom User Settings) are layered on top of
    // whichever base scheme is chosen below.
    { value: "user", text: "User (custom)", disabled: true },
  ], () => {
    const select = atomsElementColorMapMenu.querySelector("select");
    if (select.value === "user") return;
    const useDefault = select.value === "default";
    general.useDefaultColors = useDefault;
    // Explicitly update all atom colors with the new scheme
    const structure = fileBrowser.selectedStructure;

    if (structure && general.atomsColor === "elements") {
      structure.atoms.forEach((atom, atomIndex) => {
        const element = structure.elements[atomIndex];
        atom.color = structure.getDefaultElementColor(element);
      });
      if (groups.atomsMesh) {
        groups.atomsMesh.instanceColor.needsUpdate = true;
      }
      updateVisualization({reRenderAtoms:true,reRenderBonds:true,updateOther:true});
    }
  });

  // "Element Materials Map" — per-species tracer-material presets (the
  // material analog of the color map above; defaults/material_defaults.js).
  // Materials only affect the ray/path-tracing pipelines, so the row hides
  // under raster via the body.tracer-pipeline gate (styles.css), like the
  // Structure-window material editors. Color-palette parity: switching the
  // map RESETS manual material edits on the selected structure.
  const atomsElementMaterialsMapMenu = createDropdown("atomsElementMaterialsMapMenu", "Element Materials Map", [
    { value: "crysviz", text: "CrysViz Default", selected: general.elementMaterialsMap !== "standard" },
    { value: "standard", text: "Standard", selected: general.elementMaterialsMap === "standard" }
  ], () => {
    general.elementMaterialsMap = atomsElementMaterialsMapMenu.querySelector("select").value;
    const structure = fileBrowser.selectedStructure;
    if (structure) {
      structure.atomMaterials = {};
      structure.atomUserMaterials = {};
      for (const styles of [structure.atomImageStyles, structure.bondUserStyles, structure.bondCategoryStyles]) {
        for (const key of Object.keys(styles ?? {})) delete styles[key].material;
      }
    }
    // Already-mounted material editors (Structure-window species/atom/bond
    // rows, FieldPanel) seeded from the OLD map at build time — re-sync them
    // to the new effective defaults.
    document.querySelectorAll(".material-editor").forEach((el) => {
      /** @type {HTMLElement & { syncFromStore?: () => void }} */ (el).syncFromStore?.();
    });
    // The tracer SceneEncoder fingerprint picks the map change up on the next
    // requested frame (re-encode + accumulation reset); raster is unaffected.
    requestRender();
  });
  atomsElementMaterialsMapMenu.classList.add("tracer-only-control");

  const atomsColorMapBlock = createElement("div", { style: "display:none;" });

  const atomsColorMapMenu = createDropdown("atomsColorMapMenu", "Color Map", [
    { value: "heatmap", text: "Heatmap", selected: true },
    { value: "batlow", text: "Batlow" },
    { value: "hawaii", text: "Hawaii" },
    { value: "managua", text: "Managua" },
    { value: "viridis", text: "Viridis" },
    { value: "plasma", text: "Plasma" },
    { value: "spectralR", text: "Spectral R" },
    { value: "jet", text: "Jet" }
  ], () => {
    const cmap = atomsColorMapMenu.querySelector("select").value;
    general.atomColorMap = cmap;
    atomsColorBar?.update(cmap);
    if (general.atomsColor === "force") {
      updateAtomColorsByForce();
      updateAtoms();

      syncBondsToAtomColors(fileBrowser.selectedStructure);
      updatePolyhedraColors();
    }
  });
  // --- Log color scale toggle --- (mirrors ForcePanel.js/SpinPanel.js's own
  // checkboxes: the floating color bar's burger menu only exists once
  // .cv-colorbar-floating applies, so a docked bar needs its own reachable
  // toggle too, not just the menu item.)
  const atomsBarControlsRow = createElement("div", {}, {
    display: "flex", alignItems: "center", gap: "12px", margin: "4px 0",
  });
  const atomsLogLabel = createElement("label", {}, {
    display: "flex", alignItems: "center", gap: "4px", fontSize: "12px",
    color: "white", whiteSpace: "nowrap", cursor: "pointer",
  });
  const atomsLogCheckbox = createElement("input", { type: "checkbox", id: "atomsLogScaleCheckbox" });
  atomsLogCheckbox.checked = general.atomColorScale === "log";
  atomsLogLabel.appendChild(atomsLogCheckbox);
  atomsLogLabel.appendChild(document.createTextNode("Log Scale"));

  const atomsAutoRangeBtn = createElement("button", {
    type: "button", class: "file-action-btn cv-auto-range-btn",
  }, {}, "Auto Range");

  atomsBarControlsRow.appendChild(atomsLogLabel);
  atomsBarControlsRow.appendChild(atomsAutoRangeBtn);

  // Shared by atomsLogCheckbox and the color bar's own burger-menu "Log
  // Scale" item (onScaleChange below) — either can flip it, both stay synced.
  function applyAtomLogScale(isLog) {
    general.atomColorScale = isLog ? "log" : "linear";
    if (isLog && general.ForceMin <= 0) {
      general.ForceMin = 0.01;
      atomsColorBar?.setRange(general.ForceMin, general.ForceMax);
    }
    atomsLogCheckbox.checked = isLog;
    atomsColorBar?.update(general.atomColorMap, general.atomColorScale);
    if (general.atomsColor === "force") {
      updateAtomColorsByForce();
      updateAtoms();
      syncBondsToAtomColors(fileBrowser.selectedStructure);
      updatePolyhedraColors();
    }
  }
  atomsLogCheckbox.addEventListener("change", () => applyAtomLogScale(atomsLogCheckbox.checked));

  // Shared by atomsAutoRangeBtn and the burger menu's own "Auto Range" item.
  // Recomputes min/max from the structure's actual force magnitudes, padded
  // 20% of the data's own span on each side (computeAutoRange).
  function applyAtomAutoRange() {
    const structure = fileBrowser.selectedStructure;
    if (!structure?.forces?.length) return;
    const magnitudes = structure.forces.map((force) => {
      if (!force?.vector) return NaN;
      const mag = Math.sqrt(force.vector[0] ** 2 + force.vector[1] ** 2 + force.vector[2] ** 2);
      return mag;
    });
    const range = computeAutoRange(magnitudes, 0.2, { clampMinAtZero: true });
    if (!range) return;
    let { min, max } = range;
    if (general.atomColorScale === "log" && min <= 0) min = 0.01;
    general.ForceMin = min;
    general.ForceMax = max;
    atomsColorBar?.setRange(min, max);
    if (general.atomsColor === "force") {
      updateAtomColorsByForce();
      updateAtoms();
      syncBondsToAtomColors(structure);
      updatePolyhedraColors();
    }
  }
  atomsAutoRangeBtn.addEventListener("click", applyAtomAutoRange);

  const atomsColorBarContainer = createElement("div", {}, { display: "none", marginTop: "8px" });
  atomsColorMapBlock.appendChild(atomsColorMapMenu);
  atomsColorMapBlock.appendChild(atomsBarControlsRow);
  atomsColorMapBlock.appendChild(atomsColorBarContainer);

  atomsMenuBlock.appendChild(atomsMenu);
  atomsMenuBlock.appendChild(atomsElementColorMapBlock);
  atomsElementColorMapBlock.appendChild(atomsElementColorMapMenu);
  atomsElementColorMapBlock.appendChild(atomsElementMaterialsMapMenu);
  atomsMenuBlock.appendChild(atomsColorMapBlock);

  function onAtomsModeChange() {
    const mode = atomsMenu.querySelector("select").value;
    const structure = fileBrowser.selectedStructure;

    // Check if switching to force mode but no forces available
    if (mode === "force") {
      if (!structure || !structure.forces || structure.forces.length !== structure.atoms.length) {
        alert("No force data available for this structure. Using element colors instead.");
        atomsMenu.querySelector("select").value = "elements";
        general.atomsColor = "elements";
        updateAtoms();
        return;
      }
    }

    const isForce = mode === "force";
    const isElements = mode === "elements";

    atomsElementColorMapBlock.style.display = isElements ? "block" : "none";
    atomsColorMapBlock.style.display = isForce ? "block" : "none";
    atomsColorBarContainer.style.display = isForce ? "block" : "none";


    if (isForce) {
      if (!atomsColorBar) {
        atomsColorBar = createColorBar(
          atomsColorBarContainer,
          general.atomColorMap,
          general.ForceMin,
          general.ForceMax,
          {
            floatingId: ATOM_COLORBAR_FLOATING_ID,
            fallbackMin: general.ForceMin,
            fallbackMax: general.ForceMax,
            legend: general.atomLegendText ?? "Atom Force (eV/Å)",
            scale: general.atomColorScale,
            orientation: general.atomColorBarOrientation,
            flipSide: general.atomColorBarFlipSide,
            size: general.colorBarSize,
            onLimitsCommit: (min, max) => {
              general.ForceMin = min;
              general.ForceMax = max;
              updateAtomColorsByForce();
              updateAtoms();
              // No-ops unless bonds are in "elements" mode (see bondsFollowAtomColors).
              syncBondsToAtomColors(fileBrowser.selectedStructure);
              updatePolyhedraColors();
            },
            onScaleChange: (scale) => applyAtomLogScale(scale === "log"),
            onAutoRange: () => applyAtomAutoRange(),
          }
        );
        if (general.atomColorBarFloating && general.atomColorBarFloatPos) {
          atomsColorBar.floatAtAnchor(general.atomColorBarFloatPos);
        }
      }
      if (!updateAtomColorsByForce()) {
        atomsMenu.querySelector("select").value = "elements";
        general.atomsColor = "elements";
        updateAtoms();
        return;
      }
    } else if (isElements) {
      captureAtomColorBarState();
      atomsColorBar?.remove();
      atomsColorBar = null;
      // When switching to elements mode, update all atoms with current color scheme
      if (structure && structure.atoms) {
        structure.atoms.forEach((atom, atomIndex) => {
          const element = structure.elements[atomIndex];
          atom.color = structure.getDefaultElementColor(element);
        });
        if (groups.atomsMesh) {
          groups.atomsMesh.instanceColor.needsUpdate = true;
        }
      }
    }

    syncBondsToAtomColors(structure);

    general.atomsColor = mode;
    updateAtoms();
    updatePolyhedraColors();

  }


  // =========================
  // BONDS
  // =========================
  const BOND_COLORBAR_FLOATING_ID = 'bondColorBarFloating';
  let bondsColorBar = null;
  let bondsSolidColorPicker = null;

  registerColorBarSource('bond', 'Bond Length (Å)', () => bondsColorBar);

  // Save the live color bar's orientation/floating state into `general`
  // right before it's torn down (switching out of Length mode), so
  // switching back in restores it instead of resetting to docked/horizontal.
  function captureBondColorBarState() {
    if (!bondsColorBar) return;
    const settings = bondsColorBar.getSettings();
    general.bondColorBarOrientation = settings.orientation;
    general.bondColorBarFlipSide = settings.flipSide;
    general.bondColorScale = settings.scale;
    general.colorBarSize = settings.size;
    general.bondLegendText = settings.legend;
    general.bondColorBarFloating = bondsColorBar.isFloating();
    if (general.bondColorBarFloating) {
      general.bondColorBarFloatPos = bondsColorBar.getAnchor();
    }
  }

  const bondsMenuBlock = createElement("div", {});
  const bondsMenu = createDropdown("bondsMenu", "Bonds", [
    { value: "elements", text: "Elements", selected: true },
    { value: "white", text: "White" },
    { value: "length", text: "Length" },
    { value: "solid", text: "Solid Color" }
  ], onBondsModeChange);

  // Color map section (for Length mode)
  const bondsColorMapBlock = createElement("div", { style: "display:none;" });
  const bondsColorMapMenu = createDropdown("bondsColorMapMenu", "Color Map", [
    { value: "heatmap", text: "Heatmap", selected: true },
    { value: "batlow", text: "Batlow" },
    { value: "hawaii", text: "Hawaii" },
    { value: "managua", text: "Managua" },
    { value: "viridis", text: "Viridis" },
    { value: "plasma", text: "Plasma" },
    { value: "spectralR", text: "Spectral R" },
    { value: "jet", text: "Jet" }
  ], () => {
    const cmap = bondsColorMapMenu.querySelector("select").value;
    general.bondsColorMap = cmap;
    bondsColorBar?.update(cmap);
    updateBondColorsByLength();
    updateBonds();
    updatePolyhedraColors();
  });

  // --- Log Scale + Auto Range, side by side --- (see the atoms ones above
  // for why docked-reachable controls are needed alongside the burger menu.)
  const bondsBarControlsRow = createElement("div", {}, {
    display: "flex", alignItems: "center", gap: "12px", margin: "4px 0",
  });
  const bondsLogLabel = createElement("label", {}, {
    display: "flex", alignItems: "center", gap: "4px", fontSize: "12px",
    color: "white", whiteSpace: "nowrap", cursor: "pointer",
  });
  const bondsLogCheckbox = createElement("input", { type: "checkbox", id: "bondsLogScaleCheckbox" });
  bondsLogCheckbox.checked = general.bondColorScale === "log";
  bondsLogLabel.appendChild(bondsLogCheckbox);
  bondsLogLabel.appendChild(document.createTextNode("Log Scale"));

  const bondsAutoRangeBtn = createElement("button", {
    type: "button", class: "file-action-btn cv-auto-range-btn",
  }, {}, "Auto Range");

  bondsBarControlsRow.appendChild(bondsLogLabel);
  bondsBarControlsRow.appendChild(bondsAutoRangeBtn);

  function applyBondLogScale(isLog) {
    general.bondColorScale = isLog ? "log" : "linear";
    if (isLog && general.BondMin <= 0) {
      general.BondMin = 0.01;
      bondsColorBar?.setRange(general.BondMin, general.BondMax);
    }
    bondsLogCheckbox.checked = isLog;
    bondsColorBar?.update(general.bondsColorMap, general.bondColorScale);
    updateBondColorsByLength();
    updateBonds();
    updatePolyhedraColors();
  }
  bondsLogCheckbox.addEventListener("change", () => applyBondLogScale(bondsLogCheckbox.checked));

  // Shared by bondsAutoRangeBtn and the burger menu's own "Auto Range" item.
  // Recomputes min/max from the actual visible bond lengths, padded 20% of
  // the data's own span on each side (computeAutoRange).
  function applyBondAutoRange() {
    const bonds = fileBrowser.selectedStructure?.bonds;
    if (!bonds?.length) return;
    const lengths = bonds
      .filter((bond) => bond.visibleLen && bond.visibleLen > 1e-3)
      .map((bond) => bond.dist);
    const range = computeAutoRange(lengths, 0.2, { clampMinAtZero: true });
    if (!range) return;
    let { min, max } = range;
    if (general.bondColorScale === "log" && min <= 0) min = 0.01;
    general.BondMin = min;
    general.BondMax = max;
    bondsColorBar?.setRange(min, max);
    updateBondColorsByLength();
    updateBonds();
    updatePolyhedraColors();
  }
  bondsAutoRangeBtn.addEventListener("click", applyBondAutoRange);

  const bondsColorBarContainer = createElement("div", {}, { display: "none", marginTop: "8px" });
  bondsColorMapBlock.appendChild(bondsColorMapMenu);
  bondsColorMapBlock.appendChild(bondsBarControlsRow);
  bondsColorMapBlock.appendChild(bondsColorBarContainer);

  // Solid color picker section (separate block)
  const bondsSolidColorBlock = createElement("div", { style: "display:none;" });
  const bondsSolidColorContainer = createElement("div", {}, { marginTop: "8px" });
  bondsSolidColorBlock.appendChild(bondsSolidColorContainer);

  // Append all bond-related elements
  bondsMenuBlock.appendChild(bondsMenu);
  bondsMenuBlock.appendChild(bondsColorMapBlock);
  bondsMenuBlock.appendChild(bondsSolidColorBlock);

  function onBondsModeChange() {
    const mode = bondsMenu.querySelector("select").value;
    const isLength = mode === "length";
    const isWhite = mode === "white";
    const isSolid = mode === "solid";

    // Set before recoloring below: the "reset to elements" branch calls
    // syncBondsToAtomColors(), which gates on general.bondsColor already
    // being the NEW mode — setting this after that call left it reading the
    // stale mode and silently skipping the resync.
    general.bondsColor = mode;

    // Control visibility of each section independently
    bondsColorMapBlock.style.display = isLength ? "block" : "none";
    bondsColorBarContainer.style.display = isLength ? "block" : "none";
    bondsSolidColorBlock.style.display = isSolid ? "block" : "none";

    // The color bar can be floating over the scene (outside this container),
    // so leaving Length mode has to tear it down explicitly rather than just
    // hiding bondsColorBarContainer — that wouldn't touch a floated bar at all.
    if (!isLength && bondsColorBar) {
      captureBondColorBarState();
      bondsColorBar.remove();
      bondsColorBar = null;
    }

    if (isLength) {
      if (!bondsColorBar) {
        bondsColorBar = createColorBar(
          bondsColorBarContainer,
          general.bondsColorMap,
          general.BondMin,
          general.BondMax,
          {
            floatingId: BOND_COLORBAR_FLOATING_ID,
            fallbackMin: general.BondMin,
            fallbackMax: general.BondMax,
            legend: general.bondLegendText ?? "Bond Length (Å)",
            scale: general.bondColorScale,
            orientation: general.bondColorBarOrientation,
            flipSide: general.bondColorBarFlipSide,
            size: general.colorBarSize,
            onLimitsCommit: (min, max) => {
              general.BondMin = min;
              general.BondMax = max;
              updateBondColorsByLength();
              updateBonds();
              updatePolyhedraColors();
            },
            onScaleChange: (scale) => applyBondLogScale(scale === "log"),
            onAutoRange: () => applyBondAutoRange(),
          }
        );
        if (general.bondColorBarFloating && general.bondColorBarFloatPos) {
          bondsColorBar.floatAtAnchor(general.bondColorBarFloatPos);
        }
      }
      updateBondColorsByLength();
    }
    else if (isWhite) {
      const bonds = fileBrowser.selectedStructure.bonds;
      bonds.forEach((bond, bondIndex) => {
        if (!bond.visibleLen || bond.visibleLen <= 1e-3) return;
        bond.color[0] = "#ffffff";
        bond.color[1] = "#ffffff";
        updateSingleBondColor(bondIndex * 2, "#ffffff",true);
        updateSingleBondColor(bondIndex * 2 + 1, "#ffffff",true);
      });
    }
    else if (isSolid) {
      // Clean up existing picker
      if (bondsSolidColorPicker) {
        bondsSolidColorContainer.innerHTML = "";
        bondsSolidColorPicker = null;
      }

      // Create new color picker
      bondsSolidColorPicker = createColorPicker(general.solidBondColor || "#ffffff", (hex) => {
        const bonds = fileBrowser.selectedStructure.bonds;
        bonds.forEach((bond, bondIndex) => {
          if (!bond.visibleLen || bond.visibleLen <= 1e-3) return;
          bond.color[0] = hex;
          bond.color[1] = hex;
          updateSingleBondColor(bondIndex * 2, hex,true);
          updateSingleBondColor(bondIndex * 2 + 1, hex,true);
        });
        general.solidBondColor = hex;
        updateBonds();
        updatePolyhedraColors();
      });

      // Append the picker's DOM element
      bondsSolidColorContainer.appendChild(bondsSolidColorPicker.element);

      // Apply initial color
      const solidColor = general.solidBondColor || "#ffffff";
      const bonds = fileBrowser.selectedStructure.bonds;
      bonds.forEach((bond, bondIndex) => {
        if (!bond.visibleLen || bond.visibleLen <= 1e-3) return;
        bond.color[0] = solidColor;
        bond.color[1] = solidColor;
        updateSingleBondColor(bondIndex * 2, solidColor, true);
        updateSingleBondColor(bondIndex * 2 + 1, solidColor,true);
      });
    }
    else {
      // Reset to element colors — mirrors each bond half to its endpoint
      // atom's actual displayed color (getColor(), not the raw default),
      // respecting any per-bond user override.
      syncBondsToAtomColors(fileBrowser.selectedStructure);
    }

    // Clean up if not in solid mode
    if (!isSolid && bondsSolidColorPicker) {
      bondsSolidColorContainer.innerHTML = "";
      bondsSolidColorPicker = null;
    }
    updatePolyhedraColors();
  }

  // =========================
  // ASSEMBLE
  // =========================
  content.appendChild(makeSectionHeadline('Colors'));
  content.appendChild(atomsMenuBlock);
  content.appendChild(bondsMenuBlock);

  panel.appendChild(content);
  group.appendChild(panel);
  targetPanel.appendChild(group);

  // The dropdown above hardcodes "CrysViz Default" as selected at creation;
  // fix it up to the real state (including "User (custom)" if overrides were
  // already restored from localStorage before this panel built).
  syncElementColorMapDropdown();
}
