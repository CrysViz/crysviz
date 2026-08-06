import { general, fileBrowser } from '../state/store.js';
import { updateAtomCutPlaneState } from '../render/index.js';
import { updateVisualization } from '../core/crystal-viewer.js';

export function addCutPlanePanel(target = "TrajectoryComparisonContainer") {
  const container = document.getElementById(target);
  if (!container) return;
  removeCutPlanePanel(target);
  general.atomCutPlanes ||= [];

  const maxAbsCoordinate = (() => {
    const wrappedCart = fileBrowser.selectedStructure?.periodic?.visibleWrapped?.cart;
    const positions = wrappedCart?.length
      ? wrappedCart
      : fileBrowser.selectedStructure?.atoms?.map((atom) => atom.position) || [];
    let maxValue = 0;
    positions.forEach((position) => {
      position.forEach((value) => {
        maxValue = Math.max(maxValue, Math.abs(Number(value) || 0));
      });
    });
    return Math.max(5, Math.ceil(maxValue || 5));
  })();

  const panel = document.createElement('div');
  panel.id = 'cutPlanePanel';
  panel.className = 'cutplane-panel';

  const header = document.createElement('div');
  header.className = 'cutplane-header';

  const title = document.createElement('div');
  title.textContent = 'Cut Planes';
  title.className = 'cutplane-title';

  const addButton = document.createElement('button');
  addButton.textContent = 'Add Plane';
  addButton.className = 'btn-mini highlight cutplane-add-btn';

  const hint = document.createElement('div');
  hint.textContent = 'Use normal (x, y, z), distance r, and left/right masking. "Keep" is controlled per atom in the info panel.';
  hint.className = 'cutplane-hint';

  const list = document.createElement('div');
  list.className = 'cutplane-list';
  const editor = document.createElement('div');
  editor.className = 'cutplane-editor';
  let selectedPlaneIndex = general.atomCutPlanes.length ? general.atomCutPlanes.length - 1 : -1;

  const syncCutPlanes = () => {
    updateAtomCutPlaneState();
    updateVisualization({
      atomsUpdate: false,
      bondsUpdate: false,
      reRenderAtoms: false,
      reRenderBonds: false,
      reRenderLattice: false,
      reRenderOther: false,
      reRenderComposition: false,
    });
  };

  function clampSliderValue(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(min, Math.min(max, numeric));
  }

  function formatPlaneSummary(plane) {
    return `n=(${Math.round(plane.x ?? 0)}, ${Math.round(plane.y ?? 0)}, ${Math.round(plane.z ?? 0)})  r=${(plane.r ?? 0).toFixed(2)}  ${plane.side || 'left'}`;
  }

  const renderEditor = () => {
    editor.innerHTML = '';
    const plane = general.atomCutPlanes[selectedPlaneIndex];
    if (!plane) {
      const empty = document.createElement('div');
      empty.textContent = 'Add a plane to edit its sliders.';
      empty.className = 'cutplane-empty';
      editor.appendChild(empty);
      return;
    }

    const selectedLabel = document.createElement('div');
    selectedLabel.textContent = `Editing plane ${selectedPlaneIndex + 1}`;
    selectedLabel.className = 'cutplane-selected-label';

    const controlRow = document.createElement('div');
    controlRow.className = 'cutplane-control-row';

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'cutplane-enabled-label';
    const enabledToggle = document.createElement('input');
    enabledToggle.type = 'checkbox';
    enabledToggle.checked = !!plane.enabled;
    const enabledText = document.createElement('span');
    enabledText.textContent = 'Enabled';
    enabledLabel.appendChild(enabledToggle);
    enabledLabel.appendChild(enabledText);

    const side = document.createElement('select');
    ['left', 'right'].forEach((sideName) => {
      const option = document.createElement('option');
      option.value = sideName;
      option.textContent = sideName;
      if ((plane.side || 'left') === sideName) option.selected = true;
      side.appendChild(option);
    });
    side.className = 'cutplane-side-select';

    enabledToggle.onchange = () => {
      plane.enabled = enabledToggle.checked;
      syncCutPlanes();
      renderPlaneRows();
    };
    side.onchange = () => {
      plane.side = side.value;
      syncCutPlanes();
      renderPlaneRows();
    };

    controlRow.appendChild(enabledLabel);
    controlRow.appendChild(side);

    editor.appendChild(selectedLabel);
    editor.appendChild(controlRow);

    [
      { key: 'x', label: 'X', min: -3, max: 3, step: 1, format: (value) => String(Math.round(value)) },
      { key: 'y', label: 'Y', min: -3, max: 3, step: 1, format: (value) => String(Math.round(value)) },
      { key: 'z', label: 'Z', min: -3, max: 3, step: 1, format: (value) => String(Math.round(value)) },
      { key: 'r', label: 'R', min: -maxAbsCoordinate, max: maxAbsCoordinate, step: 0.05 },
    ].forEach((spec) => {
      const row = document.createElement('div');
      row.className = 'cutplane-slider-row';

      const label = document.createElement('span');
      label.textContent = spec.label;
      label.className = 'cutplane-slider-label';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String(spec.step);
      slider.value = String(clampSliderValue(plane[spec.key], spec.min, spec.max));
      slider.className = 'cutplane-slider-input';

      const value = document.createElement('input');
      value.type = 'text';
      value.inputMode = 'decimal';
      value.value = spec.format
        ? spec.format(Number(plane[spec.key] ?? 0))
        : Number(plane[spec.key] ?? 0).toFixed(2);
      value.className = 'cutplane-value-input';

      const commit = (rawValue, { refreshRows = false } = {}) => {
        let numeric = clampSliderValue(rawValue, spec.min, spec.max);
        if (spec.step === 1) {
          numeric = Math.round(numeric);
        }
        plane[spec.key] = numeric;
        slider.value = String(numeric);
        value.value = spec.format ? spec.format(numeric) : numeric.toFixed(2);
        syncCutPlanes();
        if (refreshRows) {
          renderPlaneRows();
        }
      };

      slider.oninput = () => commit(slider.value);
      slider.onchange = () => commit(slider.value, { refreshRows: true });
      value.onchange = () => commit(value.value, { refreshRows: true });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(value);
      editor.appendChild(row);
    });
  };

  const renderPlaneRows = () => {
    list.innerHTML = '';
    if (general.atomCutPlanes.length === 0) {
      selectedPlaneIndex = -1;
      const empty = document.createElement('div');
      empty.textContent = 'No cut planes';
      empty.className = 'cutplane-empty';
      list.appendChild(empty);
      renderEditor();
      return;
    }

    if (selectedPlaneIndex < 0 || selectedPlaneIndex >= general.atomCutPlanes.length) {
      selectedPlaneIndex = general.atomCutPlanes.length - 1;
    }

    general.atomCutPlanes.forEach((plane, index) => {
      const row = document.createElement('div');
      const isSelected = index === selectedPlaneIndex;
      // Selected/unselected background+border are two fixed states, not
      // interpolated data — a modifier class instead of an inline ternary
      // (the selected colour also drives selectButton's text colour below via
      // a descendant selector, see .cutplane-plane-row.is-selected in CSS).
      row.className = isSelected ? 'cutplane-plane-row is-selected' : 'cutplane-plane-row';

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = !!plane.enabled;
      enabled.className = 'cutplane-row-checkbox';

      const body = document.createElement('div');
      body.className = 'cutplane-row-body';
      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.textContent = `Plane ${index + 1}`;
      selectButton.className = 'cutplane-select-btn';
      const summary = document.createElement('div');
      summary.textContent = formatPlaneSummary(plane);
      summary.className = 'cutplane-summary';
      body.appendChild(selectButton);
      body.appendChild(summary);

      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.className = 'btn-mini cutplane-remove-btn';

      enabled.onchange = () => {
        plane.enabled = enabled.checked;
        syncCutPlanes();
        renderEditor();
        renderPlaneRows();
      };
      selectButton.onclick = () => {
        selectedPlaneIndex = index;
        renderPlaneRows();
        renderEditor();
      };
      remove.onclick = () => {
        general.atomCutPlanes.splice(index, 1);
        if (selectedPlaneIndex >= general.atomCutPlanes.length) {
          selectedPlaneIndex = general.atomCutPlanes.length - 1;
        }
        renderPlaneRows();
        syncCutPlanes();
      };

      row.appendChild(enabled);
      row.appendChild(body);
      row.appendChild(remove);
      list.appendChild(row);
    });
    renderEditor();
  };

  addButton.onclick = () => {
    general.atomCutPlanes.push({ enabled: true, x: 1, y: 0, z: 0, r: 0, side: 'left' });
    selectedPlaneIndex = general.atomCutPlanes.length - 1;
    renderPlaneRows();
    syncCutPlanes();
  };

  header.appendChild(title);
  header.appendChild(addButton);
  panel.appendChild(header);
  panel.appendChild(hint);
  panel.appendChild(list);
  panel.appendChild(editor);
  container.appendChild(panel);
  renderPlaneRows();
}

export function removeCutPlanePanel(target = "TrajectoryComparisonContainer") {
  document.getElementById(target)?.querySelector('#cutPlanePanel')?.remove();
}
