import { fileBrowser, app, groups } from '../state/store.js';
import { updateField, setActiveField, requestRender } from '../render/index.js';
import {
  getIsosurfaceMaterialSettings,
  getIsosurfaceTriangleSortingEnabled,
  setIsosurfaceMaterialSettings,
  setIsosurfaceTriangleSortingEnabled,
  applyMaterialSettingsToStoredIsosurfaces,
} from '../model/index.js';
import { createColorPicker } from './ColorPickerModule.js';
import { createMaterialEditor, MATERIAL_TYPES } from './StructureInfoPanel/components/MaterialEditor.js';
import { createFieldCatalogWidget } from './FieldCatalogWidget.js';

export let useLogSliderScale = false; // Global variable to track log scale state for iso slider

// The live field-selector widget, so a panel rebuild can tear the previous one
// down (it holds a subscription to the catalog).
/** @type {{destroy: () => void, refresh: () => void} | null} */
let activeCatalogWidget = null;

/**
 * Convert an isoSlider value (0-100) to an iso value based on the selected field's range.
 * @param {number} sliderValue - The slider value (0-100).
 * @param {object} field - The field object with minValue, maxValue, and useAbsoluteIsoValue properties.
 * @returns {number} The computed iso value.
 */
export function sliderToIsoValue(sliderValue, field) {
  if (!field) return 0;

  let normalizedValue = sliderValue / 100;
  let isoFactor = 1;

  let range_min = 0;
  let range_max = field.maxValue;

  if (field.minValue < 0 && !field.useAbsoluteIsoValue) {
    normalizedValue = normalizedValue - 0.5; // Center at 0 for signed fields
    if (normalizedValue < 0) {
      isoFactor = -1;
      normalizedValue *= -1;
      range_min = 0;
      range_max = field.minValue;
    }
    normalizedValue *= 2;
  }

  const logMax = Math.log10(field.absMaxValue);
  const logMin = (field.absMinValue > 0) ? Math.log10(field.absMinValue) : logMax - 30; // avoid log(0)

  if (useLogSliderScale) {
    // use logarithmic scaling for wide ranges to give more control over smaller values
    return isoFactor * Math.pow(10, logMin + normalizedValue * (logMax - logMin));
  }
  else if (field.useAbsoluteIsoValue) {
    // use linear absolute range
    return isoFactor * (field.absMinValue + normalizedValue * (field.absMaxValue - field.absMinValue));
  }
  else {
    // use linear scaling for narrow ranges
    return range_min + normalizedValue * (range_max - range_min);
  }

  
}

/**
 * Convert an iso value back to an isoSlider value (0-100) based on the selected field's range.
 * @param {number} isoValue - The iso value.
 * @param {object} field - The field object with minValue, maxValue, and useAbsoluteIsoValue properties.
 * @returns {number} The slider value (0-100).
 */
export function isoValueToSlider(isoValue, field) {
  if (!field) return 50;

  
  const logMax = Math.log10(field.absMaxValue);
  const logMin = (field.absMinValue > 0) ? Math.log10(field.absMinValue) : logMax - 30; // avoid log(0)
  const useLog = useLogSliderScale;

  if (field.useAbsoluteIsoValue || field.minValue >= 0) {
    let normalizedValue;
    if (useLog) {
      const logIso = Math.log10(Math.abs(isoValue));
      normalizedValue = (logIso - logMin) / (logMax - logMin);
    } else {
      normalizedValue = (isoValue - field.absMinValue) / (field.absMaxValue - field.absMinValue);
    }
    return Math.max(0, Math.min(100, normalizedValue * 100));
  } else {
    const sign = isoValue < 0 ? -1 : 1;
    let normalizedValue;
    if (useLog) {
      const logIso = Math.log10(Math.abs(isoValue));
      normalizedValue = (logIso - logMin) / (logMax - logMin);
    } else {
      normalizedValue = (Math.abs(isoValue) - field.absMinValue) / (field.absMaxValue - field.absMinValue);
    }
    normalizedValue /= 2; // Reverse the *2
    normalizedValue *= sign;
    normalizedValue += 0.5; // Reverse the -0.5 centering
    return Math.max(0, Math.min(100, normalizedValue * 100));
  }
}

// Field browser object to track field selection state.
//
// `availableFields` is the single list every other module reads — PlanesPanel
// builds its Field dropdown from it, the Features toggle and the panel
// availability predicate consult `selectedField`. It is now a GETTER over the
// active FieldCatalog's *loaded* fields rather than a stored array.
//
// That one change is what keeps unloaded wavefunctions out of every menu in the
// app: a WAVECAR offers thousands of bands, but until a band has actually been
// expanded into a grid there is nothing to sample, and anything that offered it
// would be offering a field with no values. Formats whose fields are all parsed
// up front (cube, CHGCAR) get a flat catalog in which every entry is loaded, so
// for them the list is exactly what it always was.
export const fieldBrowser = {
  /** @type {import('../model/FieldCatalog.js').FieldCatalog | null} */
  catalog: null,
  selectedField: null,
  selectedFieldIndex: 0,

  /** @returns {import('../model/Field.js').Field[]} fields that actually hold data */
  get availableFields() {
    return this.catalog ? this.catalog.loadedFields() : [];
  },

  setSelectedField(fieldIndex) {
    const fields = this.availableFields;
    if (fields.length > 0 && fieldIndex >= 0 && fieldIndex < fields.length) {
      const previous = this.selectedField;
      this.selectedFieldIndex = fieldIndex;
      this.selectedField = fields[fieldIndex];
      this._repin(previous, this.selectedField);
      setActiveField(this.selectedField); // Update the active field in the Render3DFieldModule
      return true;
    }
    return false;
  },

  /**
   * Keep the displayed wavefunction out of reach of the cache's eviction sweep.
   *
   * The isosurface and both tracers read `Field.values` on every rebuild, and
   * the catalog decides what to show as "loaded" from what is still cached. If
   * the on-screen band were evicted, its row would flip back to "Load" while it
   * was still being drawn. Only wavefunction-backed fields have a cache behind
   * them; everything else is a plain object and this is a no-op.
   *
   * @param {import('../model/Field.js').Field | null} previous
   * @param {import('../model/Field.js').Field | null} next
   */
  _repin(previous, next) {
    if (previous === next) return;
    const pin = (field, pinned) => {
      const w = field?.wavefunction;
      if (w) w.source.pinField(w.spin, w.kpt, w.band, w.quantity, pinned);
    };
    pin(previous, false);
    pin(next, true);
  },

  /**
   * Select by identity rather than position. The catalog widget works in terms
   * of nodes, and a field's index in `availableFields` shifts as other fields
   * are loaded or evicted, so an index would go stale under it.
   * @param {import('../model/Field.js').Field} field
   */
  selectField(field) {
    const index = this.availableFields.indexOf(field);
    if (index < 0) return false;
    return this.setSelectedField(index);
  },

  /** Point the browser at a new file's catalog, clearing any previous selection. */
  setCatalog(catalog) {
    this._repin(this.selectedField, null);
    this.catalog = catalog || null;
    this.selectedField = null;
    this.selectedFieldIndex = -1;
    if (this.availableFields.length > 0) this.setSelectedField(0);
  },

  /**
   * Drop a field that no longer has data (evicted from the wavefunction cache)
   * from the current selection, so the panel does not keep pointing at it.
   */
  forgetSelectionIfUnloaded() {
    if (!this.selectedField) return;
    if (this.availableFields.includes(this.selectedField)) return;
    this._repin(this.selectedField, null);
    this.selectedField = null;
    this.selectedFieldIndex = -1;
  },

  hasFields() {
    return this.availableFields.length > 0;
  }
};

export function addFieldPanel(target = "cvPanelBody-field") {
  const fieldControlsGroup = document.getElementById(target);
  if (!fieldControlsGroup) {
    console.error(`${target} not found`);
    return;
  }

  const structure = fileBrowser.selectedStructure;
  if (!structure || !structure.volumetricFields) {
    console.warn("No volumetric fields available for current structure");
    showNoFieldsMessage(target);
    return;
  }

  // The catalog, not the flat `fields` array, is what the panel is built from.
  // For a WAVECAR `fields` is empty by design — the entries exist but none has
  // been expanded yet — so checking it here would hide the panel that is the
  // only place to load one.
  const catalog = structure.volumetricFields.catalog;
  if (!catalog || catalog.nodes.length === 0) {
    console.warn("Volumetric field catalog is empty");
    showNoFieldsMessage(target);
    return;
  }

  // Keep the browser pointed at this structure's catalog. Switching rows in the
  // file browser rebuilds this panel, and the previous structure's catalog must
  // not linger in `fieldBrowser.availableFields`.
  if (fieldBrowser.catalog !== catalog) fieldBrowser.setCatalog(catalog);

  const container = document.getElementById(target);
  if (!container) {
    console.error(`${target} container not found`);
    return;
  }

  // A catalog with nothing loaded yet (a freshly-opened WAVECAR) still gets the
  // full panel; the isosurface controls are simply disabled until a field is
  // chosen, which is what `syncIsoControlsToSelection` below handles.
  const selected = fieldBrowser.selectedField;
  const isoValue = selected
    ? (selected.isoValue || sliderToIsoValue(55, selected))
    : 0;
  const sliderVal = selected ? isoValueToSlider(isoValue, selected) : 50;
  const materialSettings = getIsosurfaceMaterialSettings();

  const mismatch = structure.volumetricFields.cellMismatch;
  const summary = catalog.summary ? ` &mdash; ${catalog.summary}` : '';

  container.innerHTML = `
    <div class="field-info">
      <p><strong>Source:</strong> ${structure.volumetricFields.source}${summary}</p>
    </div>
    ${mismatch ? `
    <div class="field-cell-mismatch">
      This file's cell does not match the structure it was attached to (largest
      component difference ${mismatch.deviation.toFixed(4)} &#8491;). The field is drawn in the
      structure's cell.
    </div>` : ''}

    <div class="control-group">
      <label class="toggle_row toggle_container">
        <span class="toggle_switch">
          <input type="checkbox" id="FieldAbsoluteValueToggle" ${selected?.useAbsoluteIsoValue ? 'checked' : ''}${selected ? '' : ' disabled'}>
          <span class="toggle_slider"></span>
        </span>
        <span class="toggle_text"> Absolute Isosurface Values</span>
      </label>
      <label class="toggle_row toggle_container">
        <span class="toggle_switch">
          <input type="checkbox" id="LogSliderScaleToggle" ${useLogSliderScale ? 'checked' : ''}>
          <span class="toggle_slider"></span>
        </span>
        <span class="toggle_text"> Logarithmic Slider Scale</span>
      </label>
    </div>

    <div class="control-group">
      <label>Field Selection:</label>
      <div id="fieldCatalogMount"></div>
      <p id="fieldCatalogError" class="field-catalog-error" role="alert"></p>
    </div>

    <div class="control-group">
      <label>Isosurface Value:</label>
      <input type="range" id="isoSlider" min="0" max="100" step="1" value="${sliderVal}">
      <span id="isoValue">${isoValue.toExponential(3)}</span>
    </div>

    <div id="fieldColorToggle" class="spin-toggle" role="button" tabindex="0" aria-expanded="false" aria-controls="fieldColorContent">
    <h4>Color controls</h4>
    <div class="toggle-icon" id="fieldColorToggleIcon">+</div>
    </div>
    <div id="fieldColorContent" class="collapsible-content" aria-hidden="true">
    <div class="field-color-controls">
        <label>Positive Isosurface Color:</label>
        <div id="FieldPosColorPicker"></div>

        <label>Negative Isosurface Color:</label>
        <div id="FieldNegColorPicker"></div>

        <label for="FieldOpacitySlider">Isosurface Opacity:</label>
        <div class="field-opacity-row">
        <input type="range" id="FieldOpacitySlider" min="0" max="1" step="0.01" value="${materialSettings.opacity}">
        <span id="FieldOpacityValue">${materialSettings.opacity.toFixed(2)}</span>
        </div>

        <!-- tracer material block: not strictly color, but it lives alongside
             the color/alpha selectors here like everywhere else -->
        <div id="fieldMaterialEditorMount"></div>
    </div>
    </div>

   
  `;

  // Wire up the isovalue slider, colour pickers and material editor first, so
  // the widget's onSelect callback can drive them.
  const controls = setupFieldControlEvents(container);

  // The field selector. One widget covers a flat list of already-loaded fields
  // and a lazily-loaded spin/k-point/band tree — see ui/FieldCatalogWidget.js.
  const mount = document.getElementById('fieldCatalogMount');
  if (mount) {
    if (activeCatalogWidget) activeCatalogWidget.destroy();
    activeCatalogWidget = createFieldCatalogWidget({
      container: mount,
      catalog,
      selectedField: fieldBrowser.selectedField,
      onSelect: (field) => {
        if (!fieldBrowser.selectField(field)) return;
        controls.syncToSelection();
        updateField(field.isoValue || undefined);
      },
      onError: (error) => {
        // Loading a band can fail for real, recoverable reasons (a truncated
        // file, a grid too large to allocate). Say so where the user is looking
        // rather than only in the console.
        const notice = document.getElementById('fieldCatalogError');
        if (notice) notice.textContent = error.message;
      },
    });
  }

  controls.syncToSelection();
}

function showNoFieldsMessage(target = "cvPanelBody-field") {
  const container = document.getElementById(target);
  if (!container) {
    console.error(`${target} not found`);
    return;
  }

  container.innerHTML = `
    <div class="no-fields-message">
      <p>No volumetric fields available for the current structure.</p>
      <p>Load a CHGCAR or .cube file to visualize volumetric data.</p>
    </div>
  `;
}

export function removeFieldPanel(target = "cvPanelBody-field") {
  const fieldControlsGroup = document.getElementById(target);

  // The selector holds a subscription to the catalog; dropping the DOM without
  // unsubscribing would leave it redrawing into a detached element forever.
  if (activeCatalogWidget) {
    activeCatalogWidget.destroy();
    activeCatalogWidget = null;
  }

  if (fieldControlsGroup) {
    // NOTE: this used to walk every field disposing `__fieldMesh` /
    // `__fieldMeshNegative`. Nothing in the codebase has ever assigned those
    // properties — the isosurface meshes live on groups.isosurfaceGroup and are
    // disposed by clearField()/deleteField() in render/Render3DFieldModule.js —
    // so the block was dead. It type-checked only because `availableFields` was
    // an untyped empty array; now that it is a Field[] the dead access is a
    // visible error, which is what surfaced it.
    fieldControlsGroup.innerHTML = '';
  }
}

/**
 * Wire the isovalue slider, the two toggles and the colour/material controls.
 *
 * Field SELECTION is no longer handled here — that moved to the catalog widget,
 * which calls back into `syncToSelection()` (returned below) so the slider
 * follows whichever field is now active.
 *
 * @returns {{syncToSelection: () => void}}
 */
function setupFieldControlEvents(container) {
  const slider = document.getElementById('isoSlider');
  const valueDisplay = document.getElementById('isoValue');
  const absoluteValueCheckbox = document.getElementById('FieldAbsoluteValueToggle');
  const logScaleCheckbox = document.getElementById('LogSliderScaleToggle');
  const triangleSortCheckbox = document.getElementById('FieldTriangleSortToggle');
  const fieldColorToggle = document.getElementById('fieldColorToggle');
  const fieldColorToggleIcon = document.getElementById('fieldColorToggleIcon');
  const fieldColorContent = document.getElementById('fieldColorContent');
  const posColorPickerContainer = document.getElementById('FieldPosColorPicker');
  const negColorPickerContainer = document.getElementById('FieldNegColorPicker');
  const opacitySlider = document.getElementById('FieldOpacitySlider');
  const opacityValue = document.getElementById('FieldOpacityValue');

  // Custom color picker (matches the rest of the app) instead of the
  // browser's native <input type="color"> swatch.
  const currentMaterialSettings = getIsosurfaceMaterialSettings();
  const posPicker = createColorPicker(currentMaterialSettings.positiveColor, () => applyFieldMaterialControls());
  const negPicker = createColorPicker(currentMaterialSettings.negativeColor, () => applyFieldMaterialControls());
  posColorPickerContainer?.appendChild(posPicker.element);
  negColorPickerContainer?.appendChild(negPicker.element);

  // Ray/path-tracing material for the field isosurface (glass excluded — no
  // refraction through the ray-marched medium). Hidden under raster pipelines
  // by the global `.material-editor` CSS rule.
  const matMount = document.getElementById('fieldMaterialEditorMount');
  if (matMount) {
    matMount.appendChild(createMaterialEditor(
      () => fileBrowser.selectedStructure?.fieldMaterial,
      (m) => {
        const s = fileBrowser.selectedStructure;
        if (!s) return;
        if (m) s.fieldMaterial = m; else delete s.fieldMaterial;
      },
      { types: MATERIAL_TYPES.filter((t) => t.value !== 'glass') }));
  }

  function setColorPanelOpen(open) {
    if (!fieldColorContent || !fieldColorToggle || !fieldColorToggleIcon) return;

    if (open) {
      fieldColorContent.classList.add('open');
      fieldColorContent.setAttribute('aria-hidden', 'false');
      fieldColorToggle.setAttribute('aria-expanded', 'true');
      fieldColorToggleIcon.textContent = '−';
    } else {
      fieldColorContent.classList.remove('open');
      fieldColorContent.setAttribute('aria-hidden', 'true');
      fieldColorToggle.setAttribute('aria-expanded', 'false');
      fieldColorToggleIcon.textContent = '+';
    }
  }

  function isAnyStoredIsosurfaceInScene() {
    if (!app.scene || !groups.isosurfaceGroup) return false;

    const isInScene = (entry) => {
      if (!entry || !entry.id) return false;
      return app.scene.getObjectById(entry.id) !== undefined;
    };

    if (Array.isArray(groups.isosurfaceGroup)) {
      return groups.isosurfaceGroup.some(isInScene);
    }
    if (groups.isosurfaceGroup instanceof Set) {
      for (const entry of groups.isosurfaceGroup) {
        if (isInScene(entry)) return true;
      }
      return false;
    }
    if (groups.isosurfaceGroup instanceof Map) {
      for (const entry of groups.isosurfaceGroup.values()) {
        if (isInScene(entry)) return true;
      }
      return false;
    }

    return isInScene(groups.isosurfaceGroup);
  }

  function applyFieldMaterialControls() {
    const settings = {
      positiveColor: posPicker.getHex(),
      negativeColor: negPicker.getHex(),
      opacity: parseFloat(opacitySlider?.value),
    };

    if (opacityValue && Number.isFinite(settings.opacity)) {
      opacityValue.textContent = settings.opacity.toFixed(2);
    }

    setIsosurfaceMaterialSettings(settings);
    applyMaterialSettingsToStoredIsosurfaces(groups.isosurfaceGroup, settings);

    if (isAnyStoredIsosurfaceInScene()) {
      // Render through the pipeline on the next rAF tick instead of an
      // out-of-band renderer.render() that would bypass it.
      requestRender();
    }
  }

  setColorPanelOpen(false);

  if (fieldColorToggle) {
    fieldColorToggle.addEventListener('click', function () {
      setColorPanelOpen(!fieldColorContent.classList.contains('open'));
    });

    fieldColorToggle.addEventListener('keydown', function (e) {
      // Space is reserved globally as a keyboard-shortcut modifier
      // (ui/KeyboardShortcuts.js) — Enter alone toggles this box.
      if (e.key === 'Enter') {
        e.preventDefault();
        setColorPanelOpen(!fieldColorContent.classList.contains('open'));
      }
    });
  }

  if (opacitySlider) {
    opacitySlider.addEventListener('input', applyFieldMaterialControls);
    opacitySlider.addEventListener('change', applyFieldMaterialControls);
  }



  // Event listeners

  // Live isosurface updates while DRAGGING the iso slider: rebuilds are
  // COALESCED to at most one marching-cubes pass per animation frame (the
  // pending callback reads the field's CURRENT isoValue, so rapid drag events
  // never queue work — the latest value wins). Marching cubes runs
  // synchronously in WASM: ms-scale for typical grids, up to ~100 ms per step
  // on very large CHGCAR grids, which merely throttles the drag cadence.
  // Under the tracers an iso change is a CORE scene edit, so with the
  // interactive raster preview enabled the drag shows the live raster surface
  // and the tracer re-converges after the rest delay.
  let liveIsoScheduled = false;
  let lastBuiltIso = null;
  function scheduleLiveIsoUpdate() {
    if (liveIsoScheduled) return;
    liveIsoScheduled = true;
    requestAnimationFrame(() => {
      liveIsoScheduled = false;
      const field = fieldBrowser.selectedField;
      const structure = fileBrowser.selectedStructure;
      if (!field || !structure || !structure.volumetricFields) return;
      if (field.isoValue === lastBuiltIso) return;
      lastBuiltIso = field.isoValue;
      updateField(field.isoValue);
    });
  }

  // Iso-slider release: the authoritative final rebuild (skipped when the live
  // path already built this exact value).
  slider.addEventListener('change', function () {
    let sliderValue = parseFloat(slider.value);
    if (!fieldBrowser.selectedField) return;

    const isoValue = sliderToIsoValue(sliderValue, fieldBrowser.selectedField);

    // 1. Update the displayed value
    valueDisplay.textContent = isoValue.toExponential(3);

    // 2. Store the iso value on the selected field for bookkeeping
    fieldBrowser.selectedField.isoValue = isoValue;

    // 3. Rebuild the isosurface for the selected field
    const structure = fileBrowser.selectedStructure;
    if (structure && structure.volumetricFields && isoValue !== lastBuiltIso) {
      lastBuiltIso = isoValue;
      updateField(isoValue);
    }
  });

  // Slider drag: update the readout and schedule a coalesced live rebuild.
  slider.addEventListener('input', function () {
    let sliderValue = parseFloat(slider.value);
    if (!fieldBrowser.selectedField) return;

    const isoValue = sliderToIsoValue(sliderValue, fieldBrowser.selectedField);

    // Update the displayed value
    valueDisplay.textContent = isoValue.toExponential(3);
    fieldBrowser.selectedField.isoValue = isoValue; // Update the isoValue on the selected field for memory
    scheduleLiveIsoUpdate();
  });

  absoluteValueCheckbox.addEventListener('change', function () {
    if (!fieldBrowser.selectedField) return;

    fieldBrowser.selectedField.useAbsoluteIsoValue = absoluteValueCheckbox.checked;

    // Update the slider range and displayed value based on the new setting
    const sliderValue = isoValueToSlider(fieldBrowser.selectedField.isoValue, fieldBrowser.selectedField);
    slider.value = sliderValue;

    // Re-render the field with the updated absolute value setting
    updateField(fieldBrowser.selectedField.isoValue);
  });

  logScaleCheckbox.addEventListener('change', function () {
    if (!fieldBrowser.selectedField) return;

    useLogSliderScale = logScaleCheckbox.checked;

    // Update the slider range and displayed value based on the new setting
    const sliderValue = parseFloat(slider.value);
    if (useLogSliderScale) {
      slider.value = sliderValue.toExponential(3);
    }
    else {
      slider.value = sliderValue.toPrecision(3);
    }
  });

  if (triangleSortCheckbox) {
    triangleSortCheckbox.addEventListener('change', function () {
      setIsosurfaceTriangleSortingEnabled(triangleSortCheckbox.checked);
    });
  }

  // NOTE: updateAllIsosurfaces was never implemented (its init call below is also
  // commented out), so this listener referenced an undefined function and would
  // throw. Disabled until a real handler exists (e.g. () => updateField()).
  // fieldToggles.forEach((toggle) => {
  //   toggle.addEventListener('change', updateAllIsosurfaces);
  // });

  // Initialize with first field visible
  //updateAllIsosurfaces();

  /**
   * Point the iso controls at whatever field is currently selected.
   *
   * Called once when the panel is built and again every time the catalog widget
   * reports a new selection. It replaces the per-radio handlers that used to
   * live here: selection is the widget's job now, because with a lazily-loaded
   * catalog a field's position in `availableFields` shifts as other fields are
   * loaded or evicted, and an index-based handler would go stale.
   *
   * With nothing selected (a freshly-opened WAVECAR) the controls are disabled
   * rather than hidden, so the panel keeps its shape while the user picks a band.
   */
  function syncToSelection() {
    const field = fieldBrowser.selectedField;
    const enabled = Boolean(field);

    slider.disabled = !enabled;
    absoluteValueCheckbox.disabled = !enabled;

    if (!field) {
      valueDisplay.textContent = '—';
      return;
    }

    const isoValue = field.isoValue || sliderToIsoValue(55, field);
    field.isoValue = isoValue;
    slider.value = String(isoValueToSlider(isoValue, field));
    valueDisplay.textContent = isoValue.toExponential(3);
    // Track the newly selected field's own absolute-value preference.
    absoluteValueCheckbox.checked = Boolean(field.useAbsoluteIsoValue);
    lastBuiltIso = null; // a different field: force the next rebuild through
  }

  return { syncToSelection };
}

export function updateFieldPanel() {
  // Gated on the pre-refactor `general.SpinForceState`, which no longer
  // exists anywhere — the condition was always true, so this function has
  // been a no-op since the panel regroup. Kept as an explicit no-op to
  // preserve behavior; revisit if the Field panel needs live refreshes.
  if (true) {
    return;
  }

  const structure = fileBrowser.selectedStructure;

  if (!structure) {
    console.warn("No structure selected for updating field panel");
    return;
  }

  removeFieldPanel();
  addFieldPanel();
}
