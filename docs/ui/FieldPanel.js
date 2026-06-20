import { fileBrowser, app, general, groups } from '../state/store.js';
import { updateField, setActiveField, toggleFieldVisibility } from '../render/index.js';
import {
  getIsosurfaceMaterialSettings,
  getIsosurfaceTriangleSortingEnabled,
  setIsosurfaceMaterialSettings,
  setIsosurfaceTriangleSortingEnabled,
  applyMaterialSettingsToStoredIsosurfaces,
} from '../model/index.js';

export let useLogSliderScale = false; // Global variable to track log scale state for iso slider

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

// Field browser object to track field selection state
export const fieldBrowser = {
  selectedField: null,
  selectedFieldIndex: 0,
  availableFields: [],
  
  setSelectedField(fieldIndex) {
    if (this.availableFields.length > 0 && fieldIndex >= 0 && fieldIndex < this.availableFields.length) {
      this.selectedFieldIndex = fieldIndex;
      this.selectedField = this.availableFields[fieldIndex];
      setActiveField(this.selectedField); // Update the active field in the Render3DFieldModule
      return true;
    }
    return false;
  },

  setAvailableFields(fields = null) {
    this.availableFields = fields || [];
    // Set default to first field if available
    if (this.availableFields.length > 0) {
      if (!this.selectedField) {
        this.setSelectedField(0);
      }
    } else {
      this.selectedField = null;
      this.selectedFieldIndex = -1;
    }
  },

  hasFields() {
    return this.availableFields.length > 0;
  }
};

export function addFieldPanel(target = "SpinForceFieldContainer") {
  const fieldControlsGroup = document.getElementById(target);
  if (!fieldControlsGroup) {
    console.error(`${target} not found`);
    return;
  }

  const structure = fileBrowser.selectedStructure;
  if (!structure || !structure.volumetricFields || !structure.volumetricFields.fields) {
    console.warn("No volumetric fields available for current structure");
    showNoFieldsMessage(target);
    return;
  }

  const fields = structure.volumetricFields.fields;
  if (fields.length === 0) {
    console.warn("Volumetric fields array is empty");
    showNoFieldsMessage(target);
    return;
  }

  if (!fieldBrowser.selectedField) {
    console.warn("No selected field in fieldBrowser after setting available fields");
    showNoFieldsMessage(target);
    return;
  }

  // Update fieldBrowser with available fields
  fieldBrowser.setAvailableFields(fields);

  const container = document.getElementById(target);
  if (!container) {
    console.error(`${target} container not found`);
    return;
  }

  // Show the field controls group
  container.style.display = "block";

  const isoValue = fieldBrowser.selectedField.isoValue || sliderToIsoValue(55, fieldBrowser.selectedField);
  const sliderVal = isoValueToSlider(isoValue, fieldBrowser.selectedField);
  const materialSettings = getIsosurfaceMaterialSettings();

  container.innerHTML = `
    <h3>Volumetric Field Controls</h3>
    
    <div class="field-info">
      <p><strong>Source:</strong> ${structure.volumetricFields.source}</p>
    </div>

    <div class="control-group">
      <label class="toggle_row toggle_container">
        <span class="toggle_switch">
          <input type="checkbox" id="ShowFieldToggle" ${fieldBrowser.selectedField.isVisible ? 'checked' : ''}>
          <span class="toggle_slider"></span>
        </span>
        <span class="toggle_text"> Show Field </span>
      </label>
      <label class="toggle_row toggle_container">
        <span class="toggle_switch">
          <input type="checkbox" id="FieldAbsoluteValueToggle" ${fieldBrowser.selectedField.useAbsoluteIsoValue ? 'checked' : ''}>
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
      <label class="toggle_row toggle_container">
        <span class="toggle_switch">
          <input type="checkbox" id="FieldTriangleSortToggle" ${getIsosurfaceTriangleSortingEnabled() ? 'checked' : ''}>
          <span class="toggle_slider"></span>
        </span>
        <span class="toggle_text"> Camera Distance Sorting</span>
      </label>
    </div>

    <div class="control-group">
      <label>Field Selection:</label>
      <table id="fieldSelectionTable">
        <thead>
          <tr>
            <th class="fth">Selected</th>
            <th class="fth">Field</th>
          </tr>
        </thead>
        <tbody>
        <!-- Rows will be populated dynamically -->
        </tbody>
      </table>
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
    <div style="display:flex; flex-direction:column; gap:8px;">
        <label for="FieldPosColorPicker">Positive Isosurface Color:</label>
        <input type="color" id="FieldPosColorPicker" value="${materialSettings.positiveColor}">

        <label for="FieldNegColorPicker">Negative Isosurface Color:</label>
        <input type="color" id="FieldNegColorPicker" value="${materialSettings.negativeColor}">

        <label for="FieldOpacitySlider">Isosurface Opacity:</label>
        <div style="display:flex; align-items:center; gap:8px;">
        <input type="range" id="FieldOpacitySlider" min="0" max="1" step="0.01" value="${materialSettings.opacity}">
        <span id="FieldOpacityValue">${materialSettings.opacity.toFixed(2)}</span>
        </div>
    </div>
    </div>

   
  `;

  // Populate field selection table
  const tableBody = document.querySelector("#fieldSelectionTable tbody");
  fields.forEach((field, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>
        <input type="radio" name="primaryField" class="fieldPrimary" data-field-index="${index}" ${index === fieldBrowser.selectedFieldIndex ? 'checked' : ''}>
      </td>
      <td>${field.label}</td>
    `;
    tableBody.appendChild(row);
  });

  // Add event listeners
  setupFieldControlEvents(fields, container);

  // Setup delete field button
  //const deleteButton = document.getElementById("deleteField");
  //if (deleteButton) {
  //  deleteButton.onclick = removeFieldPanel;
  //}
}

function showNoFieldsMessage(target = "SpinForceFieldContainer") {
  const container = document.getElementById(target);
  if (!container) {
    console.error(`${target} not found`);
    return;
  }

  // Show the field controls group
  container.style.display = "block";

  container.innerHTML = `
    <h3>Volumetric Field Controls</h3>
    <div class="no-fields-message">
      <p>No volumetric fields available for the current structure.</p>
      <p>Load a CHGCAR or .cube file to visualize volumetric data.</p>
    </div>
  `;
}

export function removeFieldPanel(target = "SpinForceFieldContainer") {
  const fieldControlsGroup = document.getElementById(target);
  
  if (fieldControlsGroup) {
    // Clean up any existing field meshes
    if (fieldBrowser.hasFields()) {
      fieldBrowser.availableFields.forEach(field => {
        if (field.__fieldMesh) {
          app.scene.remove(field.__fieldMesh);
          field.__fieldMesh.geometry.dispose();
          field.__fieldMesh.material.dispose();
          field.__fieldMesh = null;
        }
        if (field.__fieldMeshNegative) {
          app.scene.remove(field.__fieldMeshNegative);
          field.__fieldMeshNegative.geometry.dispose();
          field.__fieldMeshNegative.material.dispose();
          field.__fieldMeshNegative = null;
        }
      });
    }
    
    // Clear the controls content and hide the group
    if (fieldControlsGroup) {
      fieldControlsGroup.innerHTML = '';
    }
    fieldControlsGroup.style.display = "none";
  }
}

function setupFieldControlEvents(fields, container) {
  const slider = document.getElementById('isoSlider');
  const valueDisplay = document.getElementById('isoValue');
  const showFieldToggle = document.getElementById('ShowFieldToggle');
  const absoluteValueCheckbox = document.getElementById('FieldAbsoluteValueToggle');
  const logScaleCheckbox = document.getElementById('LogSliderScaleToggle');
  const triangleSortCheckbox = document.getElementById('FieldTriangleSortToggle');
  const fieldPrimaryRadios = document.querySelectorAll('.fieldPrimary');
  const fieldColorToggle = document.getElementById('fieldColorToggle');
  const fieldColorToggleIcon = document.getElementById('fieldColorToggleIcon');
  const fieldColorContent = document.getElementById('fieldColorContent');
  const posColorPicker = document.getElementById('FieldPosColorPicker');
  const negColorPicker = document.getElementById('FieldNegColorPicker');
  const opacitySlider = document.getElementById('FieldOpacitySlider');
  const opacityValue = document.getElementById('FieldOpacityValue');

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
      positiveColor: posColorPicker?.value,
      negativeColor: negColorPicker?.value,
      opacity: parseFloat(opacitySlider?.value),
    };

    if (opacityValue && Number.isFinite(settings.opacity)) {
      opacityValue.textContent = settings.opacity.toFixed(2);
    }

    setIsosurfaceMaterialSettings(settings);
    applyMaterialSettingsToStoredIsosurfaces(groups.isosurfaceGroup, settings);

    if (isAnyStoredIsosurfaceInScene() && app.renderer && app.camera) {
      app.renderer.render(app.scene, app.camera);
    }
  }

  setColorPanelOpen(false);

  if (fieldColorToggle) {
    fieldColorToggle.addEventListener('click', function () {
      setColorPanelOpen(!fieldColorContent.classList.contains('open'));
    });

    fieldColorToggle.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setColorPanelOpen(!fieldColorContent.classList.contains('open'));
      }
    });
  }

  if (posColorPicker) {
    posColorPicker.addEventListener('input', applyFieldMaterialControls);
    posColorPicker.addEventListener('change', applyFieldMaterialControls);
  }
  if (negColorPicker) {
    negColorPicker.addEventListener('input', applyFieldMaterialControls);
    negColorPicker.addEventListener('change', applyFieldMaterialControls);
  }
  if (opacitySlider) {
    opacitySlider.addEventListener('input', applyFieldMaterialControls);
    opacitySlider.addEventListener('change', applyFieldMaterialControls);
  }



  // Event listeners

  // Iso-slider: update display, compute new iso value, re-render selected field on release
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
    if (structure && structure.volumetricFields) {
      updateField(isoValue);
    }
  });

  // slider input event: update text of slider value
  slider.addEventListener('input', function () {
    let sliderValue = parseFloat(slider.value);
    if (!fieldBrowser.selectedField) return;

    const isoValue = sliderToIsoValue(sliderValue, fieldBrowser.selectedField);

    // Update the displayed value
    valueDisplay.textContent = isoValue.toExponential(3);
    fieldBrowser.selectedField.isoValue = isoValue; // Update the isoValue on the selected field for memory
  });

  showFieldToggle.addEventListener('change', function () {
    if (!fieldBrowser.selectedField) return;

    fieldBrowser.selectedField.isVisible = showFieldToggle.checked;

    // Re-render the field with the updated visibility setting
    toggleFieldVisibility(showFieldToggle.checked);

    updateField(fieldBrowser.selectedField.isoValue);
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

  // Primary field selection radios
  fieldPrimaryRadios.forEach((radio) => {
    radio.addEventListener('change', function() {
      const fieldIndex = parseInt(this.dataset.fieldIndex);
      if (fieldBrowser.setSelectedField(fieldIndex)) {
        const isoValue = fieldBrowser.selectedField.isoValue || sliderToIsoValue(55, fieldBrowser.selectedField);
        slider.value = isoValueToSlider(isoValue, fieldBrowser.selectedField);
        valueDisplay.textContent = isoValue.toExponential(3);
        // Update the Absolute Iso Value toggle state based on the newly selected field
        absoluteValueCheckbox.checked = fieldBrowser.selectedField.useAbsoluteIsoValue;
        showFieldToggle.checked = fieldBrowser.selectedField.isVisible; // default to visible if not set

        // Update field with iso value for newly selected field
        updateField(isoValue);
      }
    });
  });
}

export function updateFieldPanel() {
  if (general.SpinForceState != "Fields") {
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
