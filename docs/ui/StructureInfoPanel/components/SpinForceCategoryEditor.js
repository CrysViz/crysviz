import { fileBrowser, general } from '../../../state/store.js';
import { getElementDefaultColor } from '../../../defaults/color_texture_defaults.js';
import { updateForces, updateSpins, requestRender } from '../../../render/index.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { createMaterialEditor, MATERIAL_TYPES } from './MaterialEditor.js';

function safeColor(value) {
  if (value?.isColor) return `#${value.getHexString()}`;
  if (typeof value === 'number') return `#${value.toString(16).padStart(6, '0')}`;
  if (typeof value === 'string' && value.startsWith('#')) return value;
  return '#808080';
}

/**
 * Compact species-level Spin/Force style editor. A mixed site-signature row
 * edits each element in its group, while ordinary rows contain one element.
 */
export function createSpinForceCategoryEditor(elements) {
  const categoryElements = [...new Set(elements.filter(Boolean))];
  const categoryElementSet = new Set(categoryElements);
  const editor = document.createElement('div');
  editor.className = 'spin-force-category-editor';
  editor.style.display = 'none';

  let mode = 'spin';
  const switchRow = document.createElement('div');
  switchRow.className = 'spin-mode-switch spin-force-category-switch';
  const modeButtons = {};
  for (const name of ['spin', 'force']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name === 'spin' ? 'Spin' : 'Force';
    button.className = 'spin-mode-switch-btn spin-force-category-mode';
    button.dataset.mode = name;
    modeButtons[name] = button;
    switchRow.appendChild(button);
  }
  editor.appendChild(switchRow);

  const pickerMount = document.createElement('div');
  pickerMount.className = 'spin-force-category-color';
  editor.appendChild(pickerMount);

  const materialEditor = createMaterialEditor(
    () => {
      const structure = fileBrowser.selectedStructure;
      const styles = mode === 'spin' ? structure?.spinCategoryStyles : structure?.forceCategoryStyles;
      return styles?.[categoryElements[0]]?.material;
    },
    (material) => {
      const structure = fileBrowser.selectedStructure;
      if (!structure) return;
      const storeName = mode === 'spin' ? 'spinCategoryStyles' : 'forceCategoryStyles';
      structure[storeName] ??= {};
      for (const element of categoryElements) {
        const style = (structure[storeName][element] ??= {});
        if (material) style.material = material;
        else delete style.material;
        if (!style.color) {
          if (!Object.keys(style).length) delete structure[storeName][element];
        }
      }
      requestRender();
    }, {
      types: MATERIAL_TYPES.filter((type) => type.value !== 'glass'),
    });
  editor.appendChild(materialEditor);

  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = 'Reset';
  resetButton.className = 'btn-mini si-action-btn-wide spin-force-category-reset';
  editor.appendChild(resetButton);

  function styles() {
    const structure = fileBrowser.selectedStructure;
    const storeName = mode === 'spin' ? 'spinCategoryStyles' : 'forceCategoryStyles';
    return { structure, storeName, store: structure?.[storeName] };
  }

  function currentColor() {
    const { store } = styles();
    return safeColor(store?.[categoryElements[0]]?.color
      ?? getElementDefaultColor(categoryElements[0]));
  }

  function refreshArrows() {
    if (mode === 'spin' && general.spinsActive) {
      updateSpins(general.spinScale ?? 1, false, [], general.spinColorMap ?? 'none');
    } else if (mode === 'force' && general.forcesActive) {
      updateForces(general.forceScale ?? 1, general.forceColorMap ?? 'heatmap');
    }
    requestRender();
  }

  function restoreDefaultArrowColors() {
    const structure = fileBrowser.selectedStructure;
    const arrows = mode === 'spin' ? structure?.spins : structure?.forces;
    if (!arrows) return;
    arrows.forEach((arrow, index) => {
      if (!arrow?.userColor && categoryElementSet.has(structure.elements[index])) {
        // The "none" colormap intentionally leaves this value untouched;
        // reset the category's stale write to the constructor default.
        arrow.color = arrow.defaultColor?.clone?.() ?? arrow.defaultColor;
      }
    });
  }

  function mountPicker() {
    pickerMount.replaceChildren();
    const picker = createColorPicker(currentColor(), (hex) => {
      const { structure, storeName } = styles();
      if (!structure) return;
      structure[storeName] ??= {};
      for (const element of categoryElements) {
        const style = (structure[storeName][element] ??= {});
        style.color = hex;
      }
      refreshArrows();
    });
    pickerMount.appendChild(picker.element);
  }

  function setMode(nextMode) {
    mode = nextMode;
    for (const [name, button] of Object.entries(modeButtons)) {
      button.classList.toggle('active', name === mode);
    }
    mountPicker();
    materialEditor.syncFromStore?.();
  }

  for (const [name, button] of Object.entries(modeButtons)) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setMode(name);
    });
  }

  resetButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const { structure, storeName } = styles();
    if (!structure) return;
    for (const element of categoryElements) delete structure[storeName]?.[element];
    restoreDefaultArrowColors();
    refreshArrows();
    mountPicker();
    materialEditor.syncFromStore?.();
  });

  /** @type {any} */ (editor).getMode = () => mode;
  /** @type {any} */ (editor).setMode = setMode;
  setMode(mode);
  return editor;
}
