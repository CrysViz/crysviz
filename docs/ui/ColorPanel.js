import { createColorPicker } from './ColorPickerModule.js';
import {updateVisualization} from '../core/crystal-viewer.js';  
import { app, groups,fileBrowser, general, RENDERING_DEFAULTS} from '../state/store.js';
import {getHeatMapColors,getBatlowColors,getHawaiiColors,getManaguaColors, getViridisColors,getPlasmaColors,getSpectralRColors} from '../defaults/color_texture_defaults.js'

import { updateBonds } from '../render/index.js'
import { updateAtoms } from '../render/index.js'
import { updateSingleBondColor } from '../render/index.js'
import { updatePolyhedra, setCelHullWidth, setCelHullPolyWidth } from '../render/index.js'
import { listPipelines, setActivePipeline, requestRender } from '../render/index.js'
import { makeSectionHeadline } from './panels/sectionHeadline.js'
import { sizeSliderToValue, sizeValueToSlider, GROUND_OFFSET_RANGE, GROUND_SIZE_RANGE } from './ControlsWiring.js'



function createElement(tag, attributes = {}, styles = {}, textContent = "") {
  const el = document.createElement(tag);
  Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(styles).forEach(([k, v]) => (el.style[k] = v));
  if (textContent) el.textContent = textContent;
  return el;
}

// --- Color Bar ---
function createColorBar(container, colormap, minValue, maxValue, type) {
  const wrapper = createElement("div", {}, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "100%",
    marginTop: "6px"
  });

  const barContainer = createElement("div", {}, {
    width: "100%",
    borderRadius: "3px",
    overflow: "hidden"
  });

  const canvas = createElement("canvas", {}, { width: "100%", display: "block" });
  canvas.width = 100;
  canvas.height = 20;
  barContainer.appendChild(canvas);

  const labels = createElement("div", {}, {
    display: "flex",
    justifyContent: "space-between",
    width: "120px",
    marginTop: "4px"
  });

  const inputStyle = {
    width: "25%",
    fontSize: "12px",
    padding: "2px 4px",
    background: "#555",
    color: "#fff",
    border: "1px solid #777",
    borderRadius: "3px",
    textAlign: "center"
  };

  const minInput = createElement("input", {
    type: "text",
    value: minValue
  }, inputStyle);

  const maxInput = createElement("input", {
    type: "text",
    value: maxValue
  }, inputStyle);

  labels.appendChild(minInput);
  labels.appendChild(maxInput);

  wrapper.appendChild(barContainer);
  wrapper.appendChild(labels);
  container.appendChild(wrapper);

  function render() {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let colors;
    switch (colormap) {
      case "batlow": colors = getBatlowColors(); break;
      case "hawaii": colors = getHawaiiColors(); break;
      case "managua": colors = getManaguaColors(); break;
      case "viridis": colors = getViridisColors(); break;
      case "plasma": colors = getPlasmaColors(); break;
      case "spectralR": colors = getSpectralRColors(); break;
      default: colors = getHeatMapColors();
    }

    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    const step = Math.max(1, Math.floor(colors.length / 20));

    for (let i = 0; i < colors.length; i += step) {
      const c = colors[i];
      grad.addColorStop(i / colors.length,
        `rgb(${c.r * 255 | 0}, ${c.g * 255 | 0}, ${c.b * 255 | 0})`);
    }

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function onLimitsChange() {
    const min = parseFloat(minInput.value);
    const max = parseFloat(maxInput.value);
    if (!isFinite(min) || !isFinite(max) || min >= max) {
      alert("Invalid range: Max must be greater than Min");
      return;
    }

    if (type === "atoms") {
      general.ForceMin = min;
      general.ForceMax = max;
      updateAtomColorsByForce();
      updateAtoms();

      // If bonds should match atom colors, update them
      if (general.bondsColor == "elements" || general.bondsColor == null) {
        const structure = fileBrowser.selectedStructure;
        if (structure && structure.atoms) {
          structure.atoms.forEach((atom, atomIndex) => {
            const color = atom.getColor();
            if (structure.atomImages?.[atomIndex]) {
              structure.atomImages[atomIndex].forEach((imageIndex) => {
                if (structure.bondMapping?.[imageIndex]) {
                  structure.bondMapping[imageIndex].forEach((bondHalvIndex) => {
                    updateSingleBondColor(bondHalvIndex, color, true);
                    const indexset = structure.bondObjectMapping[bondHalvIndex];
                    structure.bonds[indexset[0]].color[indexset[1]] = color;
                  });
                }
              });
            }
          });
          updateBonds();
        }
      }
    } else if (type === "bonds") {
      general.BondMin = min;
      general.BondMax = max;
      updateBondColorsByLength();
      updateBonds();
    }
  }


  minInput.addEventListener("change", onLimitsChange);
  maxInput.addEventListener("change", onLimitsChange);

  render();

  return {
    update(cmap) {
      colormap = cmap;
      render();
    },
    remove() {
      wrapper.remove();
    }
  };
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
    select.appendChild(option);
  });

  select.addEventListener("change", onChange);
  block.appendChild(label);
  block.appendChild(select);
  return block;
}

// --- Color Mapping Functions ---
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

export function bondLengthToColor(bondLength, minVal = general.BondMin, maxVal = general.BondMax) {
  let colors;
  switch (general.bondsColorMap) {
    case "batlow": colors = getBatlowColors(); break;
    case "hawaii": colors = getHawaiiColors(); break;
    case "managua": colors = getManaguaColors(); break;
    case "viridis": colors = getViridisColors(); break;
    case "plasma": colors = getPlasmaColors(); break;
    case "spectralR": colors = getSpectralRColors(); break;
    default: colors = getHeatMapColors();
  }

  if (!colors || colors.length === 0) {
    return "#ffffff";
  }

  const nBins = colors.length;
  const clamped = Math.max(minVal, Math.min(maxVal, bondLength));
  let t = (maxVal > minVal) ? (clamped - minVal) / (maxVal - minVal) : 0.5;
  const bin = Math.min(Math.max(0, Math.floor(t * nBins)), nBins - 1);
  return `#${(colors[bin].r * 255 | 0).toString(16).padStart(2, '0')}${(colors[bin].g * 255 | 0).toString(16).padStart(2, '0')}${(colors[bin].b * 255 | 0).toString(16).padStart(2, '0')}`;
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

  const min = general.ForceMin;
  const max = general.ForceMax;
  const colorMap = general.atomColorMap || "heatmap";

  // Get color array
  let colors;
  switch (colorMap) {
    case "batlow": colors = getBatlowColors(); break;
    case "hawaii": colors = getHawaiiColors(); break;
    case "managua": colors = getManaguaColors(); break;
    case "viridis": colors = getViridisColors(); break;
    case "plasma": colors = getPlasmaColors(); break;
    case "spectralR": colors = getSpectralRColors(); break;
    default: colors = getHeatMapColors();
  }

  if (!colors || colors.length === 0) {
    alert("No colors available for selected color map. Using element colors instead.");
    return false;
  }

  const nBins = colors.length;

  // Auto-calculate range if min equals max
  if (min === max) {
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

  structure.atoms.forEach((atom, atomIndex) => {
    const forceObj = structure.forces[atomIndex];
    if (!forceObj || !forceObj.vector || forceObj.vector.length < 3) {
      const element = structure.elements[atomIndex];
      atom.color = structure.getDefaultElementColor(element);
      return;
    }

    const vector = forceObj.vector;
    const magnitude = Math.sqrt(vector[0]*vector[0] + vector[1]*vector[1] + vector[2]*vector[2]);
    let bin = 0;

    if (max > min) {
      const clamped = Math.max(min, Math.min(max, magnitude));
      const t = (clamped - min) / (max - min);
      bin = Math.floor(t * nBins);
    }

    bin = Math.max(0, Math.min(bin, nBins - 1));

    if (bin >= colors.length || !colors[bin]) {
      const element = structure.elements[atomIndex];
      atom.color = structure.getDefaultElementColor(element);
      return;
    }

    const colorObj = colors[bin];
    const color = `#${(colorObj.r * 255 | 0).toString(16).padStart(2, '0')}${(colorObj.g * 255 | 0).toString(16).padStart(2, '0')}${(colorObj.b * 255 | 0).toString(16).padStart(2, '0')}`;
    atom.color = color;
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
    ptControlsBlock.style.display = general.renderPipeline === "pathtrace" ? "block" : "none";
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
    listPipelines().map((p) => ({
      value: p.id, text: p.label, selected: general.renderPipeline === p.id,
    })), () => {
      setActivePipeline(renderPipelineMenu.querySelector("select").value);
      updateRenderingControlsVisibility();
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
  const rtControlsBlock = createElement("div", {},
    { display: isTracerPipeline ? "block" : "none" });
  const rtResRow = createElement("div", { class: "control-row" });
  const rtResLabel = createElement("label", { for: "rtResolutionScale" }, {},
    `RT resolution: ${Math.round((general.rtResolutionScale ?? 0.75) * 100)}%`);
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

  const groundRow = createElement("div", { class: "control-row" });
  const groundLabel = createElement("label", { for: "rtGroundToggle" }, {}, "Ground plane");
  const groundToggle = createElement("input", { type: "checkbox", id: "rtGroundToggle" },
    { justifySelf: "start", width: "auto" });
  groundToggle.checked = !!general.rtGroundPlane;
  groundToggle.addEventListener("change", () => {
    general.rtGroundPlane = groundToggle.checked;
    groundOptions.style.display = groundToggle.checked ? "block" : "none";
    app.pipeline?.resetAccumulation?.();
    requestRender();
  });
  groundRow.appendChild(groundLabel);
  groundRow.appendChild(groundToggle);
  rtControlsBlock.appendChild(groundRow);

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

  groundOptions.appendChild(makeTracerSliderRow('rtGroundOffset', 'rtGroundOffset',
    0, 1, 'any', general.rtGroundOffset ?? 0.75,
    (v) => `Ground distance: ${v.toFixed(2)}`,
    (v) => { general.rtGroundOffset = v; }, GROUND_OFFSET_RANGE));
  groundOptions.appendChild(makeTracerSliderRow('rtGroundSize', 'rtGroundSize',
    0, 1, 'any', general.rtGroundSize ?? 2.5,
    (v) => `Ground size: ${v.toFixed(2)}x`,
    (v) => { general.rtGroundSize = v; }, GROUND_SIZE_RANGE));
  groundOptions.appendChild(makeTracerSliderRow('rtGroundScale', 'rtGroundScale',
    0.5, 10, 0.25, general.rtGroundScale ?? 2,
    (v) => `Tile size: ${v.toFixed(2)}`,
    (v) => { general.rtGroundScale = v; }));
  groundOptions.appendChild(makeTracerSliderRow('rtGroundReflect', 'rtGroundReflect',
    0, 1, 0.05, general.rtGroundReflect ?? 0,
    (v) => `Ground reflect: ${v.toFixed(2)}`,
    (v) => { general.rtGroundReflect = v; }));
  rtControlsBlock.appendChild(groundOptions);

  content.appendChild(rtControlsBlock);

  // Path-tracing-only controls: the denoiser toggle (light softness moved to
  // the shared tracer block above — it drives both tracers' soft shadows).
  const ptControlsBlock = createElement("div", {},
    { display: general.renderPipeline === "pathtrace" ? "block" : "none" });
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
  ptControlsBlock.appendChild(ptDenoiseRow);

  content.appendChild(ptControlsBlock);

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
  let atomsColorBar = null;
  let atomsMenu; // Declare for access in fallback

  const atomsMenuBlock = createElement("div", {});
  atomsMenu = createDropdown("atomsMenu", "Atoms", [
    { value: "elements", text: "Element", selected: true },
    { value: "force", text: "Force" }
  ], onAtomsModeChange);

  const atomsElementColorMapBlock = createElement("div", {});

  const atomsElementColorMapMenu = createDropdown("atomsElementColorMapMenu", "Element Color Map", [
    { value: "default", text: "CrysViz Default", selected: true },
    { value: "jmol", text: "JMol-like" }
  ], () => {
    const useDefault = atomsElementColorMapMenu.querySelector("select").value === "default";
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

  const atomsColorMapBlock = createElement("div", { style: "display:none;" });

  const atomsColorMapMenu = createDropdown("atomsColorMapMenu", "Color Map", [
    { value: "heatmap", text: "Heatmap", selected: true },
    { value: "batlow", text: "Batlow" },
    { value: "hawaii", text: "Hawaii" },
    { value: "managua", text: "Managua" },
    { value: "viridis", text: "Viridis" },
    { value: "plasma", text: "Plasma" },
    { value: "spectralR", text: "Spectral R" }
  ], () => {
    const cmap = atomsColorMapMenu.querySelector("select").value;
    general.atomColorMap = cmap;
    atomsColorBar?.update(cmap);
    if (general.atomsColor === "force") {
      updateAtomColorsByForce();
      updateAtoms();

      // If bonds should match atom colors, update them
      if (general.bondsColor == "elements" || general.bondsColor == null) {
        const structure = fileBrowser.selectedStructure;
        if (structure && structure.atoms) {
          structure.atoms.forEach((atom, atomIndex) => {
            const color = atom.getColor();
            if (structure.atomImages?.[atomIndex]) {
              structure.atomImages[atomIndex].forEach((imageIndex) => {
                if (structure.bondMapping?.[imageIndex]) {
                  structure.bondMapping[imageIndex].forEach((bondHalvIndex) => {
                    updateSingleBondColor(bondHalvIndex, color, true);
                    const indexset = structure.bondObjectMapping[bondHalvIndex];
                    structure.bonds[indexset[0]].color[indexset[1]] = color;
                  });
                }
              });
            }
          });
          updateBonds();
        }
      }
    }
  });
  const atomsColorBarContainer = createElement("div", {}, { display: "none", marginTop: "8px" });
  atomsColorMapBlock.appendChild(atomsColorMapMenu);
  atomsColorMapBlock.appendChild(atomsColorBarContainer);

  atomsMenuBlock.appendChild(atomsMenu);
  atomsMenuBlock.appendChild(atomsElementColorMapBlock);
  atomsElementColorMapBlock.appendChild(atomsElementColorMapMenu);
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
          "atoms"
        );
      }
      if (!updateAtomColorsByForce()) {
        atomsMenu.querySelector("select").value = "elements";
        general.atomsColor = "elements";
        updateAtoms();
        return;
      }
    } else if (isElements) {
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
    } else {
      atomsColorBar?.remove();
      atomsColorBar = null;
      // Reset to element colors
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

    // If bonds should match atom colors (elements mode or default)
    if (general.bondsColor == "elements" || general.bondsColor == null) {
      if (structure && structure.atoms) {
        structure.atoms.forEach((atom, atomIndex) => {
          const color = atom.getColor();
          if (structure.atomImages?.[atomIndex]) {
            structure.atomImages[atomIndex].forEach((imageIndex) => {
              if (structure.bondMapping?.[imageIndex]) {
                structure.bondMapping[imageIndex].forEach((bondHalvIndex) => {
                  updateSingleBondColor(bondHalvIndex, color, true); // Pass true to overwrite
                  const indexset = structure.bondObjectMapping[bondHalvIndex];
                  structure.bonds[indexset[0]].color[indexset[1]] = color;
                });
              }
            });
          }
        });
        updateBonds();
      }
    }

    general.atomsColor = mode;
    updateAtoms();

  }


  // =========================
  // BONDS
  // =========================
  let bondsColorBar = null;
  let bondsSolidColorPicker = null;

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
    { value: "spectralR", text: "Spectral R" }
  ], () => {
    const cmap = bondsColorMapMenu.querySelector("select").value;
    general.bondsColorMap = cmap;
    bondsColorBar?.update(cmap);
    updateBondColorsByLength();
    updateBonds();
  });

  const bondsColorBarContainer = createElement("div", {}, { display: "none", marginTop: "8px" });
  bondsColorMapBlock.appendChild(bondsColorMapMenu);
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

    // Control visibility of each section independently
    bondsColorMapBlock.style.display = isLength ? "block" : "none";
    bondsColorBarContainer.style.display = isLength ? "block" : "none";
    bondsSolidColorBlock.style.display = isSolid ? "block" : "none";

    if (isLength) {
      if (!bondsColorBar) {
        bondsColorBar = createColorBar(
          bondsColorBarContainer,
          general.bondsColorMap,
          general.BondMin,
          general.BondMax,
          "bonds"
        );
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
      // Reset to element colors
      const bonds = fileBrowser.selectedStructure.bonds;
      bonds.forEach((bond, bondIndex) => {
        if (!bond.visibleLen || bond.visibleLen <= 1e-3) return;
        const atoms = fileBrowser.selectedStructure.atoms;
        bond.color[0] = atoms[bond.srcIndices[0]].color;
        bond.color[1] = atoms[bond.srcIndices[1]].color;
        updateSingleBondColor(bondIndex * 2, bond.color[0]);
        updateSingleBondColor(bondIndex * 2 + 1, bond.color[1]);
      });
    }

    // Clean up if not in solid mode
    if (!isSolid && bondsSolidColorPicker) {
      bondsSolidColorContainer.innerHTML = "";
      bondsSolidColorPicker = null;
    }
    general.bondsColor = mode;
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
}
