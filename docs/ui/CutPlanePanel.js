import { general, fileBrowser } from '../state/store.js';
import { updateAtomCutPlaneState } from '../render/index.js';
import { updateVisualization } from '../core/crystal-viewer.js';

export function addCutPlanePanel(target = "TrajectoryComparisonContainer") {
  const container = document.getElementById(target);
  if (!container) return;
  removeCutPlanePanel(target);
  general.atomCutPlanes ||= [];

  const maxAbsCoordinate = (() => {
    const wrappedCart = fileBrowser.selectedStructure?.periodic?.wrapped?.cart;
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
  panel.style.cssText = `
    margin-top: 10px;
    padding: 10px;
    border-radius: 10px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    overflow: hidden;
  `;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;';

  const title = document.createElement('div');
  title.textContent = 'Cut Planes';
  title.style.cssText = 'font-size:13px; font-weight:600; color:#f3f3f3;';

  const addButton = document.createElement('button');
  addButton.textContent = 'Add Plane';
  addButton.className = 'btn-mini highlight';
  addButton.style.cssText = 'height: 28px; padding: 0 10px; font-size: 11px;';

  const hint = document.createElement('div');
  hint.textContent = 'Use normal (x, y, z), distance r, and left/right masking. "Keep" is controlled per atom in the info panel.';
  hint.style.cssText = 'font-size:10px; color: rgba(255,255,255,0.62); margin-bottom:8px; line-height:1.35;';

  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  const editor = document.createElement('div');
  editor.style.cssText = 'margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; gap:8px;';
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
      empty.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.55);';
      editor.appendChild(empty);
      return;
    }

    const selectedLabel = document.createElement('div');
    selectedLabel.textContent = `Editing plane ${selectedPlaneIndex + 1}`;
    selectedLabel.style.cssText = 'font-size:11px; font-weight:600; color:#f3f3f3;';

    const controlRow = document.createElement('div');
    controlRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;';

    const enabledLabel = document.createElement('label');
    enabledLabel.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; color:#ddd;';
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
    side.style.cssText = 'height:28px; min-width:88px; background: rgba(0,0,0,0.28); color:#fff; border:1px solid rgba(255,255,255,0.12); border-radius:6px;';

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
      row.style.cssText = 'display:grid; grid-template-columns: 18px 1fr 56px; gap:8px; align-items:center;';

      const label = document.createElement('span');
      label.textContent = spec.label;
      label.style.cssText = 'font-size:11px; color:#ddd; font-weight:600;';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String(spec.step);
      slider.value = String(clampSliderValue(plane[spec.key], spec.min, spec.max));
      slider.style.cssText = 'width:100%; min-width:0;';

      const value = document.createElement('input');
      value.type = 'text';
      value.inputMode = 'decimal';
      value.value = spec.format
        ? spec.format(Number(plane[spec.key] ?? 0))
        : Number(plane[spec.key] ?? 0).toFixed(2);
      value.style.cssText = 'height:28px; width:56px; padding: 4px 6px; background: rgba(0,0,0,0.28); color:#fff; border:1px solid rgba(255,255,255,0.12); border-radius:6px; box-sizing:border-box; text-align:center;';

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
      empty.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.55);';
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
      row.style.cssText = `
        display:grid;
        grid-template-columns: 18px minmax(0,1fr) auto;
        gap:8px;
        align-items:center;
        width:100%;
        padding:6px 8px;
        border-radius:8px;
        background:${isSelected ? 'rgba(17,128,57,0.16)' : 'rgba(255,255,255,0.02)'};
        border:1px solid ${isSelected ? 'rgba(17,128,57,0.45)' : 'rgba(255,255,255,0.06)'};
        box-sizing:border-box;
      `;

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = !!plane.enabled;
      enabled.style.margin = '0';

      const body = document.createElement('div');
      body.style.cssText = 'min-width:0; overflow:hidden;';
      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.textContent = `Plane ${index + 1}`;
      selectButton.style.cssText = `border:none; background:transparent; color:${isSelected ? '#e9fff1' : 'rgba(255,255,255,0.86)'}; text-align:left; min-width:0; padding:0; cursor:pointer;`;
      const summary = document.createElement('div');
      summary.textContent = formatPlaneSummary(plane);
      summary.style.cssText = 'font-size:10px; color: rgba(255,255,255,0.62); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px;';
      body.appendChild(selectButton);
      body.appendChild(summary);

      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.className = 'btn-mini';
      remove.style.cssText = 'height: 28px; padding: 0 8px; font-size: 11px; min-width:64px;';

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
