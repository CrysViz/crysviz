import { fileBrowser, groups, general, mode } from '../../../state/store.js';
import { colorHexToCss, getAtomColor, hexToRgba, setAtomColor } from '../../../utils/ColorModule.js';
import { refreshGhostAtoms } from '../../../render/GhostAtomsModule.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import {
  updateSingleAtomColor, updateSingleAtomOpacity, updateSingleAtomDiameter,
  getAtomImageStyle, setAtomImageStyle, clearAtomImageStyle, atomImageKey,
  clearAtomImageStylesForAtom, getAtomImageColor, updateSingleAtomImageColor,
} from '../../../render/AtomsFracUpdateModule.js';
import { updatePolyhedraColors, scheduleBondRebuild } from '../../../render/index.js';
import { createMaterialEditor } from './MaterialEditor.js';
import { updateMeasurementMarkers } from '../../../render/MeasurementModule.js';
import { clampOpacity, clampRadiusScale, updateAtomCoordinates, applyToOtherTrajectoryFrames, wirePressHoldPopup } from './utils.js';
import { selectAtomFromRow, suppressSelectionHighlightFor3D, restoreSelectionHighlight, setArrowHighlightOverride, clearArrowHighlightOverride } from '../../SelectAndHighlightModule.js';
import { createTinyImmunityToggle } from './Immunity.js';
import { createSpinForceEditor } from './SpinForceEditor.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { atomForceToColor, syncBondHalvesToImageColor } from '../../ColorPanel.js';

// Each row's "Edit" button swatch previews the atom's live color, but a
// global recolor (color-map dropdown, mode switch, color-bar limits) never
// rebuilds these rows — so without this, the swatch goes stale exactly like
// the composition pie dots did (see CompositionRow.js's
// updateAllCompositionPieDots for the same pattern). Keyed by atom+image so
// re-creating a row overwrites its own entry instead of accumulating stale
// closures over detached buttons.
const atomRowSwatchUpdateFunctions = {};
document.addEventListener('crysviz:colors-changed', () => {
  Object.values(atomRowSwatchUpdateFunctions).forEach((updateFn) => updateFn());
});



// Helper to get the current color for an atom based on the active color mode


// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

export function createIndividualAtomRow(element, atomIndex, displayNumber = atomIndex + 1, options = {}) {
  const linkedAtomIndices = options.linkedAtomIndices ?? [atomIndex];
  const positionUpdater = options.positionUpdater ?? ((coords) => updateAtomCoordinates(atomIndex, coords));
  const resetCoordsProvider = options.resetCoordsProvider ?? (() => fileBrowser.selectedStructure?.original?.atoms?.[atomIndex]?.position ?? null);
  const positionEditable = options.positionEditable ?? true;
  // Which fractional axes this row may move along (Wyckoff rows pass the
  // orbit's freedom mask; ordinary atoms are free in all three). A frozen axis
  // gets a greyed-out, disabled slider + box in the coordinate editor.
  const axisFreedom = options.axisFreedom ?? [true, true, true];
  // Applied while a slider is being dragged: same edit, but without the
  // composition rebuild that would destroy this row mid-drag.
  const livePositionUpdater = options.livePositionUpdater ?? positionUpdater;
  const onColorChange = options.onColorChange ?? (() => {}); // Callback for color changes
  // Per-image mode ("Link periodic copies" off): this row represents ONE
  // on-screen copy (options.imageIndex = mesh instance id). Color/Alpha/Size
  // then edit only that copy via structure.atomImageStyles. Position, Spin and
  // cut-plane immunity keep source-atom semantics (a position edit moves all
  // copies — they are the same physical atom).
  const imageIndex = options.imageIndex ?? null;
  const perImage = imageIndex != null;
  // Integer periodic offset of this on-screen copy from its source cell. A
  // copy with a non-zero offset is a periodic IMAGE, not the atom itself: it
  // may only be recoloured. Position/Spin edit the physical atom (they'd move
  // or annotate every copy), which reads as a bug on an image row, so those
  // buttons are dropped there and the whole row is inset + marked as a copy.
  const imageOffset = options.imageOffset ?? null;
  const isPeriodicImage = perImage && !!imageOffset && imageOffset.some((v) => v !== 0);

  const row = document.createElement('div');
  row.className = 'individual-atom-row';
  row.dataset.atomIndex = String(atomIndex);
  if (perImage) row.dataset.imageIndex = String(imageIndex);
  row.dataset.element = element;
  // Wyckoff orbit rows carry a long label ("F1  16l", site symmetry, orbit
  // size, DOF) that has no room next to three buttons in a docked panel, so
  // they stack: identity on its own line, buttons underneath. Ordinary atom
  // rows keep the original single-line grid.
  const stackedHeader = options.stackedHeader ?? false;
  row.style.cssText = stackedHeader
    ? 'display: flex; flex-wrap: wrap; align-items: center; column-gap: 10px; row-gap: 6px; padding: 6px 0; font-size: 11px;'
    // Name column is `auto`: it shrinks to the coords' min-content but no
    // further, so the coordinates never overflow into (and overlap) the buttons.
    // Buttons keep their natural width, "Spin/Force" split to two lines, and the
    // reduced left indent on the container leaves room for all three.
    : 'display: grid; grid-template-columns: auto auto auto; align-items: center; column-gap: 10px; padding: 4px 0; font-size: 11px;';
  // Inset image rows so they sit under the atom they copy, not beside it.
  if (isPeriodicImage) row.style.marginLeft = '14px';

  const imageStyle = perImage ? getAtomImageStyle(fileBrowser.selectedStructure, imageIndex) : null;
  const currentColor = perImage
    ? safeColor(getAtomImageColor(fileBrowser.selectedStructure, imageIndex))
    : safeColor(getAtomColor(atomIndex));
  const currentOpacity = imageStyle?.alpha ?? fileBrowser.selectedStructure.atoms[atomIndex].getOpacity?.() ?? fileBrowser.selectedStructure.atoms[atomIndex].opacity ?? 1;
  const currentRadiusScale = imageStyle?.radiusScale ?? fileBrowser.selectedStructure.atoms[atomIndex].getRadiusScale?.() ?? 1;

  // Atom name and coordinates container
  const nameContainer = document.createElement('div');
  nameContainer.style.cssText = stackedHeader
    ? 'display: flex; flex-direction: column; gap: 2px; flex: 1 1 100%; min-width: 0;'
    : 'display: flex; flex-direction: column; gap: 2px;';

  const name = document.createElement('span');
  const baseLabel = options.label ?? `${element}${displayNumber}`;
  // The leading ↳ and dimmed colour flag this row as a periodic image of the
  // atom above it rather than an atom in its own right.
  name.textContent = isPeriodicImage ? `↳ ${baseLabel}` : baseLabel;
  name.style.color = isPeriodicImage ? 'rgba(255,255,255,0.6)' : '#ddd';

  // Per-image rows show the copy's own (wrapped) coords; the Position editor
  // below still edits the source atom's coords.
  const coords = options.displayCoords ?? fileBrowser.selectedStructure.atoms.map(a => a.position)[atomIndex];
  const coordsDisplay = document.createElement('span');
  coordsDisplay.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.8); font-family: monospace;';
  coordsDisplay.textContent = `(${coords[0].toFixed(3)}, ${coords[1].toFixed(3)}, ${coords[2].toFixed(3)})`;

  nameContainer.appendChild(name);
  if (options.metaText) {
    const meta = document.createElement('span');
    meta.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.55);';
    meta.textContent = options.metaText;
    nameContainer.appendChild(meta);
  }
  nameContainer.appendChild(coordsDisplay);

  row.appendChild(nameContainer);

  // Panel→3D: clicking the row (its background or the name/coords area, NOT
  // the editor buttons/panels) highlights this atom in the 3D view — the
  // mirror of double-clicking the atom in 3D highlighting this row.
  nameContainer.style.cursor = 'pointer';
  nameContainer.title = `Highlight ${element}${displayNumber} in the 3D view`;
  row.addEventListener('click', (e) => {
    if (e.target !== row && !nameContainer.contains(/** @type {Node} */ (e.target))) return;
    e.stopPropagation();
    selectAtomFromRow(atomIndex, e, perImage ? imageIndex : null);
  });
  // Hover feedback, skipped while the row carries the amber selection styling
  // (highlightAtomRow sets dataset.selectionOrder on selected rows).
  row.addEventListener('mouseenter', () => {
    if (!row.dataset.selectionOrder) row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });
  row.addEventListener('mouseleave', () => {
    if (!row.dataset.selectionOrder) row.style.backgroundColor = '';
  });

  // Button container
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = stackedHeader
    ? 'display: flex; gap: 8px; flex: 1 1 auto; flex-wrap: wrap;'
    // One row of buttons at their natural width; "Spin/Force" is split onto two
    // lines (its <br>), keeping the trio compact enough to sit beside the name.
    : 'display: flex; gap: 6px; justify-content: flex-end;';

  const inactiveButtonBorder = '1px solid rgba(255,255,255,0.2)';
  const activeButtonBorder = '1px solid rgba(125, 206, 160, 0.95)';
  const activeButtonShadow = '0 0 0 1px rgba(125, 206, 160, 0.35), inset 0 0 0 1px rgba(125, 206, 160, 0.15)';

  // Color/alpha/size editor button (labeled "Color" — the editor holds more
  // than color; the swatch background still previews the atom color)
  const colorBtn = document.createElement('button');
  colorBtn.textContent = 'Color';
  colorBtn.className = 'atom-editor-button';
  colorBtn.dataset.editorButton = 'color';
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 10px; white-space: normal; line-height: 1.15; text-align: center;';
  colorBtn.title = `Edit color, alpha and size for ${element}${displayNumber}`;
  function updateColorBtnSwatch() {
    const color = perImage
      ? safeColor(getAtomImageColor(fileBrowser.selectedStructure, imageIndex))
      : safeColor(getAtomColor(atomIndex));
    colorBtn.style.background = hexToRgba(color, 0.8);
  }
  updateColorBtnSwatch();
  atomRowSwatchUpdateFunctions[`${atomIndex}:${imageIndex ?? 'all'}`] = updateColorBtnSwatch;

  // Coordinate edit button
  const coordBtn = document.createElement('button');
  coordBtn.textContent = 'Position';
  coordBtn.className = 'atom-editor-button';
  coordBtn.dataset.editorButton = 'coord';
  coordBtn.style.cssText = 'background: var(--bg-color); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 10px; white-space: normal; line-height: 1.15; text-align: center;';
  coordBtn.title = `Edit coordinates for ${element}${displayNumber}`;
  if (!positionEditable) {
    coordBtn.disabled = true;
    coordBtn.style.opacity = '0.45';
    coordBtn.style.cursor = 'not-allowed';
    coordBtn.title = `Position is fixed by symmetry for ${element}${displayNumber}`;
  }

  // Spin Edit button
  const spinBtn = document.createElement('button');
  // Split the label at the slash onto two lines ("Spin/" / "Force"), the way it
  // was before: it keeps this (longest) button narrow so the three buttons fit
  // beside the name in a docked panel instead of overflowing it.
  spinBtn.innerHTML = 'Spin/<br>Force';
  spinBtn.className = 'atom-editor-button';
  spinBtn.dataset.editorButton = 'spin';
  spinBtn.style.cssText = 'background: var(--bg-color); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 10px; white-space: normal; line-height: 1.15; text-align: center;';
  spinBtn.title = `Edit Spin for ${element}${displayNumber}`;

  const keepToggle = createTinyImmunityToggle(linkedAtomIndices, `Keep ${element}${displayNumber} visible across cut planes`);

  buttonContainer.appendChild(colorBtn);
  // A periodic image only owns its colour; Position/Spin belong to the
  // physical atom (its own, un-inset row), so they are omitted here.
  if (!isPeriodicImage) {
    buttonContainer.appendChild(coordBtn);
    buttonContainer.appendChild(spinBtn);
  }

  row.appendChild(buttonContainer);
  row.appendChild(keepToggle.wrapper);

  // --- Editors ---
  const editor = document.createElement('div');
  editor.className = 'atom-color-editor';
  editor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const mom_color = currentColor;
  const picker = createColorPicker(mom_color, (hex) => {
    let structure = fileBrowser.selectedStructure;
    if (perImage) {
      // Only this on-screen copy: persist in the per-image store and paint the
      // one instance — never mutate the shared source atom.
      setAtomImageStyle(structure, imageIndex, { color: hex });
      updateSingleAtomImageColor(imageIndex, hex);
      syncBondHalvesToImageColor(structure, imageIndex, hex);
    } else {
      linkedAtomIndices.forEach((linkedAtomIndex) => {
        const linkedAtom = structure.atoms[linkedAtomIndex];
        // Authoritative color state, set unconditionally: an atom with zero
        // periodic images right now (e.g. currently hidden) never runs the
        // per-image loop below, so without this its userColor/color would
        // silently keep the old value forever, surviving even a later restore.
        linkedAtom.userColor = hex;
        setAtomColor(linkedAtom, hex);
        // Newest edit wins: a linked recolor overrides earlier per-copy colors.
        clearAtomImageStylesForAtom(structure, linkedAtomIndex, 'color');
        structure.atomImages[linkedAtomIndex]?.forEach(imgIndex => {
          syncBondHalvesToImageColor(structure, imgIndex, hex);
          updateSingleAtomColor(linkedAtomIndex, imgIndex, structure.elements[linkedAtomIndex], hex, hex);
        });
      });
    }
    groups.atomsMesh.instanceColor.needsUpdate = true;
    if (groups.bondsMesh) {
      groups.bondsMesh.instanceColor.needsUpdate = true;
    }
    colorBtn.style.background = hexToRgba(hex, 0.8);
    onColorChange(); // Notify parent to update pie dot
    // A centered polyhedron is coloured by its centre atom, so recolour in place (cheap, no
    // geometry recompute) — the polyhedron of the edited atom matches its new colour.
    updatePolyhedraColors();
    // This callback updates the real-atom mesh directly rather than going
    // through updateVisualization, so it's one of the color-edit paths that
    // doesn't get updateVisualization's own ghost-refresh hook.
    if (mode.measureMode === 'hide' || mode.measureMode === 'restore') refreshGhostAtoms();
  });

  const AtomColorApplyBtn = document.createElement('button');
  AtomColorApplyBtn.textContent = 'Apply';
  AtomColorApplyBtn.className = 'btn-mini highlight';
  AtomColorApplyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 50px; width: 50px;';

  const AtomColorResetBtn = document.createElement('button');
  AtomColorResetBtn.textContent = 'Reset';
  AtomColorResetBtn.className = 'btn-mini';
  AtomColorResetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 50px; width: 50px;';

  // Get the default color for this element
  const defaultColor = safeColor(fileBrowser.selectedStructure.getDefaultElementColor(element));
  AtomColorResetBtn.style.background = hexToRgba(defaultColor, 0.8);

  const topRowIndiv = document.createElement('div');
  topRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';
  topRowIndiv.appendChild(picker.element);

  const buttonRowIndiv = document.createElement('div');
  buttonRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  buttonRowIndiv.appendChild(AtomColorResetBtn);
  buttonRowIndiv.appendChild(AtomColorApplyBtn);

  const atomAlphaRow = document.createElement('div');
  atomAlphaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
  const atomAlphaLabel = document.createElement('span');
  atomAlphaLabel.textContent = 'Alpha';
  atomAlphaLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const atomAlphaSlider = document.createElement('input');
  atomAlphaSlider.type = 'range';
  atomAlphaSlider.min = '0.05';
  atomAlphaSlider.max = '1';
  atomAlphaSlider.step = '0.01';
  atomAlphaSlider.value = String(currentOpacity);
  atomAlphaSlider.style.cssText = 'flex:1;';
  const atomAlphaValue = document.createElement('input');
  atomAlphaValue.type = 'number';
  atomAlphaValue.min = '0.05';
  atomAlphaValue.max = '1';
  atomAlphaValue.step = '0.01';
  atomAlphaValue.value = currentOpacity.toFixed(2);
  atomAlphaValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  atomAlphaRow.appendChild(atomAlphaLabel);
  atomAlphaRow.appendChild(atomAlphaSlider);
  atomAlphaRow.appendChild(atomAlphaValue);

  // Size (per-atom radius multiplier), same row layout as Alpha.
  const atomSizeRow = document.createElement('div');
  atomSizeRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
  const atomSizeLabel = document.createElement('span');
  atomSizeLabel.textContent = 'Size';
  atomSizeLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const atomSizeSlider = document.createElement('input');
  atomSizeSlider.type = 'range';
  atomSizeSlider.min = '0.2';
  atomSizeSlider.max = '3';
  atomSizeSlider.step = '0.05';
  atomSizeSlider.value = String(currentRadiusScale);
  atomSizeSlider.style.cssText = 'flex:1;';
  const atomSizeValue = document.createElement('input');
  atomSizeValue.type = 'number';
  atomSizeValue.min = '0.2';
  atomSizeValue.max = '3';
  atomSizeValue.step = '0.05';
  atomSizeValue.value = currentRadiusScale.toFixed(2);
  atomSizeValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  atomSizeRow.appendChild(atomSizeLabel);
  atomSizeRow.appendChild(atomSizeSlider);
  atomSizeRow.appendChild(atomSizeValue);

  // Per-atom ray/path-tracing material override (wins over the species
  // entry). Follows the row's linking mode like Color/Alpha/Size: with "Link
  // periodic copies" OFF the row is one on-screen copy and the material goes
  // into its atomImageStyles entry ONLY; linked edits fan out to every linked
  // atom and drop stale per-copy overrides (newest edit wins).
  const materialEditor = createMaterialEditor(
    () => {
      const structure = fileBrowser.selectedStructure;
      if (perImage) return getAtomImageStyle(structure, imageIndex)?.material;
      return structure?.atomUserMaterials?.[atomIndex];
    },
    (material) => {
      const structure = fileBrowser.selectedStructure;
      if (!structure) return;
      if (perImage) {
        setAtomImageStyle(structure, imageIndex, { material: material ?? undefined });
        return;
      }
      structure.atomUserMaterials = structure.atomUserMaterials ?? {};
      linkedAtomIndices.forEach((linkedAtomIndex) => {
        if (material) structure.atomUserMaterials[linkedAtomIndex] = material;
        else delete structure.atomUserMaterials[linkedAtomIndex];
        clearAtomImageStylesForAtom(structure, linkedAtomIndex, 'material');
      });
    },
    // a cleared per-atom entry falls back to the effective SPECIES material:
    // the manual species entry, else the Element-Materials-Map preset
    { getDefault: () => {
      const structure = fileBrowser.selectedStructure;
      const el = structure?.elements?.[atomIndex];
      if (!el) return null;
      return structure.atomMaterials?.[el] ?? structure.getDefaultElementMaterial?.(el);
    } });

  editor.appendChild(topRowIndiv);
  editor.appendChild(atomAlphaRow);
  editor.appendChild(atomSizeRow);
  editor.appendChild(materialEditor);
  editor.appendChild(buttonRowIndiv);

  // Coordinate editor
  const coordEditor = document.createElement('div');
  coordEditor.className = 'atom-coord-editor';
  coordEditor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const coordTitle = document.createElement('div');
  coordTitle.className = 'coord-editor-title';
  coordTitle.style.cssText = 'display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11px; color: rgba(255,255,255,0.8); margin-bottom: 6px; font-weight: 500;';
  const coordTitleText = document.createElement('span');
  coordTitleText.textContent = 'Fractional Coordinates';
  coordTitle.appendChild(coordTitleText);
  if (options.freedomNote) {
    const note = document.createElement('span');
    note.className = 'coord-editor-note';
    note.textContent = options.freedomNote;
    note.style.cssText = 'font-size: 10px; font-weight: 400; color: rgba(255,255,255,0.45);';
    coordTitle.appendChild(note);
  }

  // One stacked row per axis: label, slider, number box. Axes the symmetry
  // freezes (axisFreedom[axis] false) are greyed out and disabled — dragging
  // them could only ever be undone by the projection anyway.
  const axisNames = ['x', 'y', 'z'];
  const coordInputsRow = document.createElement('div');
  coordInputsRow.className = 'coord-axis-rows';
  coordInputsRow.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px;';

  const axisSliders = [];
  const axisInputs = [];

  axisNames.forEach((axisName, axis) => {
    const free = positionEditable && axisFreedom[axis];

    const axisRow = document.createElement('div');
    axisRow.className = 'coord-axis-row';
    axisRow.dataset.axis = axisName;
    axisRow.dataset.free = String(free);
    axisRow.style.cssText = `display: grid; grid-template-columns: 10px minmax(0, 1fr) 72px; align-items: center; gap: 6px;${free ? '' : ' opacity: 0.4;'}`;

    const axisLabel = document.createElement('span');
    axisLabel.textContent = axisName;
    axisLabel.style.cssText = 'font-size: 10px; color: rgba(255,255,255,0.65); font-family: monospace;';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'coord-axis-slider';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.0001';
    slider.value = String(coords[axis]);
    slider.style.cssText = 'width: 100%; min-width: 0; accent-color: rgba(125,206,160,0.95);';
    slider.disabled = !free;
    slider.title = free
      ? `Drag to move ${axisName} (fractional)`
      : `${axisName} is fixed by the site symmetry`;

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'coord-num-input';
    input.value = coords[axis].toFixed(6);
    input.step = '0.000001';
    input.placeholder = axisName;
    // The spinner arrows eat a third of a 72px box at this font size; the
    // slider is the coarse control, so the box is text-only. The inline
    // appearance:textfield handles Firefox; recent Chrome ignores it for the
    // spinner, so .coord-num-input strips the webkit spin buttons in CSS.
    input.style.cssText = 'width: 100%; min-width: 0; padding: 3px 4px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 10px; font-family: monospace; -moz-appearance: textfield; appearance: textfield;';
    input.disabled = !free;
    input.title = slider.title;

    axisRow.appendChild(axisLabel);
    axisRow.appendChild(slider);
    axisRow.appendChild(input);
    coordInputsRow.appendChild(axisRow);
    axisSliders.push(slider);
    axisInputs.push(input);
  });


  const coordApplyBtn = document.createElement('button');
  coordApplyBtn.textContent = 'Apply';
  coordApplyBtn.className = 'btn-mini highlight';
  coordApplyBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';
  coordApplyBtn.disabled = !positionEditable;

  const coordResetBtn = document.createElement('button');
  coordResetBtn.textContent = 'Reset';
  coordResetBtn.className = 'btn-mini';
  coordResetBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px; margin-right: 6px;';
  coordResetBtn.disabled = !positionEditable;

  const coordButtonsRow = document.createElement('div');
  coordButtonsRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';
  coordButtonsRow.appendChild(coordResetBtn);
  coordButtonsRow.appendChild(coordApplyBtn);

  coordEditor.appendChild(coordTitle);
  coordEditor.appendChild(coordInputsRow);
  coordEditor.appendChild(coordButtonsRow);

  // Spin/Force editor
  const spinEditor = createSpinForceEditor(atomIndex, element, {
    // Only retarget the 3D highlight if this editor is the one currently
    // open — a mode switch inside a closed/hidden editor (state restore,
    // e.g.) shouldn't touch the highlight.
    onModeChange: (mode) => {
      if (spinEditor.style.display !== 'none') setArrowHighlightOverride(atomIndex, mode);
    },
  });

  // --- Event Handlers ---
  function setButtonActive(button, isActive) {
    button.style.border = isActive ? activeButtonBorder : inactiveButtonBorder;
    button.style.boxShadow = isActive ? activeButtonShadow : 'none';
  }

  function setActiveEditor(editorType = null) {
    const editorMap = {
      color: editor,
      coord: coordEditor,
      spin: spinEditor,
    };

    const buttonMap = {
      color: colorBtn,
      coord: coordBtn,
      spin: spinBtn,
    };

    // The 3D selection glow overwrites the atom's real color — hide it while
    // the color editor is open so a live color change is actually visible,
    // and bring it back once the editor closes (or another editor opens).
    const wasColorOpen = editor.style.display !== 'none';
    if (editorType === 'color') suppressSelectionHighlightFor3D();
    else if (wasColorOpen) restoreSelectionHighlight();

    // While the Spin/Force editor is open for this atom, the 3D highlight
    // targets its arrow (whichever tab — spin or force — is active) instead
    // of the atom sphere; closing it (or switching to another editor)
    // reverts to the normal atom-sphere highlight.
    const wasSpinOpen = spinEditor.style.display !== 'none';
    if (editorType === 'spin') setArrowHighlightOverride(atomIndex, /** @type {any} */ (spinEditor).getMode());
    else if (wasSpinOpen) clearArrowHighlightOverride();

    Object.entries(editorMap).forEach(([type, panel]) => {
      panel.style.display = type === editorType ? 'block' : 'none';
    });

    Object.entries(buttonMap).forEach(([type, button]) => {
      setButtonActive(button, type === editorType);
    });
  }

  function applyIndividualOpacity(rawValue) {
    const value = clampOpacity(rawValue);
    atomAlphaSlider.value = String(value);
    atomAlphaValue.value = value.toFixed(2);
    if (perImage) {
      setAtomImageStyle(fileBrowser.selectedStructure, imageIndex, { alpha: value });
      updateSingleAtomOpacity(imageIndex, value);
      return;
    }
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      const atom = fileBrowser.selectedStructure.atoms[linkedAtomIndex];
      atom.setOpacity(value);
      clearAtomImageStylesForAtom(fileBrowser.selectedStructure, linkedAtomIndex, 'alpha');
      fileBrowser.selectedStructure.atomImages[linkedAtomIndex]?.forEach((imgIndex) => {
        updateSingleAtomOpacity(imgIndex, value);
      });
    });
  }

  atomAlphaSlider.oninput = (e) => applyIndividualOpacity(/** @type {any} */ (e.target).value);
  atomAlphaValue.oninput = (e) => applyIndividualOpacity(/** @type {any} */ (e.target).value);

  function applyIndividualRadiusScale(rawValue) {
    const value = clampRadiusScale(rawValue);
    atomSizeSlider.value = String(value);
    atomSizeValue.value = value.toFixed(2);
    const structure = fileBrowser.selectedStructure;
    if (perImage) {
      setAtomImageStyle(structure, imageIndex, { radiusScale: value });
      updateSingleAtomDiameter(imageIndex, element, value);
    } else {
      linkedAtomIndices.forEach((linkedAtomIndex) => {
        structure.atoms[linkedAtomIndex].setRadiusScale(value);
        clearAtomImageStylesForAtom(structure, linkedAtomIndex, 'radiusScale');
        structure.atomImages[linkedAtomIndex]?.forEach((imgIndex) => {
          updateSingleAtomDiameter(imgIndex, structure.elements[linkedAtomIndex], value);
        });
      });
    }
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
    updateMeasurementMarkers();
    // Bond visible lengths bake the atom radii in — refresh once settled.
    scheduleBondRebuild();
  }

  atomSizeSlider.oninput = (e) => applyIndividualRadiusScale(/** @type {any} */ (e.target).value);
  atomSizeValue.oninput = (e) => applyIndividualRadiusScale(/** @type {any} */ (e.target).value);

  colorBtn.onclick = (e) => {
    e.stopPropagation();
    const shouldOpen = editor.style.display === 'none';
    setActiveEditor(shouldOpen ? 'color' : null);
  };

  coordBtn.onclick = (e) => {
    if (!positionEditable) return;
    e.stopPropagation();
    const shouldOpen = coordEditor.style.display === 'none';
    setActiveEditor(shouldOpen ? 'coord' : null);
  };

  spinBtn.onclick = (e) => {
    e.stopPropagation();
    const shouldOpen = spinEditor.style.display === 'none';
    if (shouldOpen) /** @type {any} */ (spinEditor).refresh?.();
    setActiveEditor(shouldOpen ? 'spin' : null);
  };

  // Read the atom's real position back into the three axis rows. A Wyckoff
  // edit is projected onto the site's freedom subspace and can move axes the
  // user didn't touch (coupled sites like (x, x, z)), so what landed is the
  // only thing worth showing.
  function syncAxisControlsFromStructure() {
    const position = fileBrowser.selectedStructure?.atoms?.[atomIndex]?.position;
    if (!position) return;
    position.forEach((value, axis) => {
      axisSliders[axis].value = String(value);
      axisInputs[axis].value = value.toFixed(6);
    });
    coordsDisplay.textContent = `(${position[0].toFixed(3)}, ${position[1].toFixed(3)}, ${position[2].toFixed(3)})`;
  }

  function readAxisInputs() {
    const values = axisInputs.map((input) => parseFloat(input.value));
    return values.some((value) => isNaN(value)) ? null : values;
  }

  // Slider drags apply live but coalesce to one update per frame — each apply
  // re-lays-out atoms and bonds.
  // A Wyckoff move that would put symmetry-equivalent atoms on top of each
  // other is refused (returns false) — say so and snap the controls back to
  // where the atom actually is.
  function reportRefusedMove(applied) {
    const note = coordEditor.querySelector('.coord-editor-note');
    if (applied !== false) {
      if (note && note.dataset.refused) {
        note.textContent = note.dataset.original ?? '';
        note.style.color = 'rgba(255,255,255,0.45)';
        delete note.dataset.refused;
      }
      return;
    }
    if (note && !note.dataset.refused) {
      note.dataset.original = note.textContent;
      note.dataset.refused = '1';
      note.style.color = 'rgba(255,180,120,0.9)';
    }
    if (note) note.textContent = 'atoms would overlap';
    syncAxisControlsFromStructure();
  }

  let pendingFrame = null;
  function applyLive() {
    if (pendingFrame != null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      const coordsNow = readAxisInputs();
      if (!coordsNow) return;
      reportRefusedMove(livePositionUpdater(coordsNow));
      syncAxisControlsFromStructure();
    });
  }

  axisSliders.forEach((slider, axis) => {
    slider.oninput = () => {
      axisInputs[axis].value = parseFloat(slider.value).toFixed(6);
      applyLive();
    };
    // Releasing the slider is not a "commit": it stays on the live path so the
    // editor survives the drag. Apply does the full update (composition panel
    // included, which rebuilds and closes this row's editor).
    slider.onchange = () => {
      const coordsNow = readAxisInputs();
      if (!coordsNow) return;
      reportRefusedMove(livePositionUpdater(coordsNow));
      syncAxisControlsFromStructure();
    };
  });

  axisInputs.forEach((input, axis) => {
    input.oninput = () => {
      const value = parseFloat(input.value);
      if (!isNaN(value)) axisSliders[axis].value = String(value);
    };
  });

  coordApplyBtn.onclick = () => {
    const newCoords = readAxisInputs();
    if (!newCoords) return;
    if (positionUpdater(newCoords) === false) {
      reportRefusedMove(false);
      return;
    }
    coordsDisplay.textContent = `(${newCoords[0].toFixed(3)}, ${newCoords[1].toFixed(3)}, ${newCoords[2].toFixed(3)})`;
  };

  coordResetBtn.onclick = () => {
    const originalCoords = resetCoordsProvider();
    if (originalCoords) {
      originalCoords.forEach((value, axis) => {
        axisSliders[axis].value = String(value);
        axisInputs[axis].value = value.toFixed(6);
      });
      positionUpdater([...originalCoords]);
      coordsDisplay.textContent = `(${originalCoords[0].toFixed(3)}, ${originalCoords[1].toFixed(3)}, ${originalCoords[2].toFixed(3)})`;
      setActiveEditor(null);
    }
  };

  // Pure-data push of this row's current color/opacity/radius/material for
  // linkedAtomIndices onto another (off-screen) frame — no mesh/render calls,
  // since only the currently-displayed frame has a live mesh to update.
  // Per-copy (perImage) rows have no trajectory equivalent (an "image index"
  // is a render-time concept for the current frame only), so this is only
  // used from the non-perImage branch below.
  function pushLinkedAtomsDataToFrame(frame) {
    const src = fileBrowser.selectedStructure;
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      const srcAtom = src.atoms[linkedAtomIndex];
      const atom = frame.atoms[linkedAtomIndex];
      if (!atom) return;
      atom.color = srcAtom.color;
      atom.userColor = srcAtom.userColor;
      atom.elementColor = srcAtom.elementColor;
      atom.elementOpacity = srcAtom.elementOpacity;
      atom.opacity = srcAtom.opacity;
      atom.radiusScale = srcAtom.radiusScale ?? 1;
      if (src.atomUserMaterials?.[linkedAtomIndex] !== undefined) {
        frame.atomUserMaterials ??= {};
        frame.atomUserMaterials[linkedAtomIndex] = src.atomUserMaterials[linkedAtomIndex];
      } else if (frame.atomUserMaterials) {
        delete frame.atomUserMaterials[linkedAtomIndex];
      }
    });
  }

  function closeAtomColorEditor() {
    const currentColor = safeColor(getAtomColor(atomIndex));
    colorBtn.style.background = hexToRgba(currentColor, 0.8);
    setActiveEditor(null);
    onColorChange(); // Notify parent to update pie dot
    updateVisualization({
      bondsUpdate: false,
      reRenderAtoms: false,
      reRenderBonds: false,
      reRenderLattice: false,
      reRenderOther: false,
      reRenderComposition: "open",
    });
  }
  AtomColorApplyBtn.title = 'Click: close. Press and hold: copy this color/alpha/size to every trajectory frame.';
  wirePressHoldPopup(AtomColorApplyBtn, {
    holdLabel: 'Apply to Trajectory',
    onPress: closeAtomColorEditor,
    onConfirm: () => {
      if (perImage) {
        // atomImageKey is srcIndex + integer periodic offset — stable across
        // frames of a fixed-topology trajectory (same key format the Bonds/
        // Polyhedra rows already transplant directly), unlike the raw
        // instanceId, which is only a this-frame render detail.
        const structure = fileBrowser.selectedStructure;
        const key = atomImageKey(structure, imageIndex);
        if (!key) return;
        const style = { ...structure.atomImageStyles?.[key] };
        applyToOtherTrajectoryFrames(structure, (frame) => {
          frame.atomImageStyles ??= {};
          frame.atomImageStyles[key] = { ...style };
        });
      } else {
        applyToOtherTrajectoryFrames(fileBrowser.selectedStructure, pushLinkedAtomsDataToFrame);
      }
    },
  });

  // Pure-data reset of the linked-atom-indices branch below, reusable against
  // off-screen trajectory frames (see resetBtn's press-and-hold wiring).
  function resetLinkedAtomsColorData(structure, currentMode) {
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      clearAtomImageStylesForAtom(structure, linkedAtomIndex);
      if (structure.atomUserMaterials) delete structure.atomUserMaterials[linkedAtomIndex];
      const atom = structure.atoms[linkedAtomIndex];
      const element = structure.elements[linkedAtomIndex];

      if (atom.userColor !== undefined) delete atom.userColor;
      if (atom.forceColor !== undefined) delete atom.forceColor;

      if (currentMode === "force") {
        const forceObj = structure.forces?.[linkedAtomIndex];
        if (forceObj?.vector?.length >= 3) {
          const magnitude = Math.sqrt(
            forceObj.vector[0] ** 2 +
            forceObj.vector[1] ** 2 +
            forceObj.vector[2] ** 2
          );
          atom.color = atomForceToColor(magnitude, general.ForceMin, general.ForceMax);
        } else {
          atom.color = structure.getDefaultElementColor(element);
        }
      } else {
        atom.color = structure.getDefaultElementColor(element);
      }

      atom.resetToElementOpacity();
      atom.resetRadiusScale?.();
    });
  }

  function doResetAtomThisFrame() {
    const structure = fileBrowser.selectedStructure;
    const currentMode = general.atomsColor; // current color mode

    if (perImage) {
      // Reset only this copy: drop its style entry and repaint from the source
      // atom's model values (the hex==null repaint path resolves them now that
      // the override is gone).
      const atom = structure.atoms[atomIndex];
      clearAtomImageStyle(structure, imageIndex);
      updateSingleAtomColor(atomIndex, imageIndex, element);
      updateSingleAtomOpacity(imageIndex, atom.getOpacity?.() ?? atom.opacity ?? 1);
      updateSingleAtomDiameter(imageIndex, element, atom.getRadiusScale?.() ?? 1);
      groups.atomsMesh.instanceMatrix.needsUpdate = true;
      syncBondHalvesToImageColor(structure, imageIndex, safeColor(atom.getColor()));
      if (groups.bondsMesh) groups.bondsMesh.instanceColor.needsUpdate = true;
      // Sync the editor controls without re-writing the store.
      const srcOpacity = clampOpacity(atom.getOpacity?.() ?? atom.opacity ?? 1);
      atomAlphaSlider.value = String(srcOpacity);
      atomAlphaValue.value = srcOpacity.toFixed(2);
      const srcScale = clampRadiusScale(atom.getRadiusScale?.() ?? 1);
      atomSizeSlider.value = String(srcScale);
      atomSizeValue.value = srcScale.toFixed(2);
      colorBtn.style.background = hexToRgba(safeColor(atom.getColor()), 0.8);
      updateMeasurementMarkers();
      onColorChange();
      updatePolyhedraColors();
      setActiveEditor(null);
      return { structure, currentMode };
    }

    resetLinkedAtomsColorData(structure, currentMode);

    linkedAtomIndices.forEach((linkedAtomIndex) => {
      const atom = structure.atoms[linkedAtomIndex];
      structure.atomImages[linkedAtomIndex]?.forEach((imageIndex) => {
        syncBondHalvesToImageColor(structure, imageIndex, safeColor(atom.getColor()));
        updateSingleAtomColor(linkedAtomIndex, imageIndex, structure.elements[linkedAtomIndex]);
        updateSingleAtomOpacity(imageIndex, atom.getOpacity());
      });
    });

    // update button to show reset color
    const resetColor = currentMode === "force"
      ? atomForceToColor(
          Math.sqrt(
            (fileBrowser.selectedStructure.forces?.[atomIndex]?.vector?.[0] || 0) ** 2 +
            (fileBrowser.selectedStructure.forces?.[atomIndex]?.vector?.[1] || 0) ** 2 +
            (fileBrowser.selectedStructure.forces?.[atomIndex]?.vector?.[2] || 0) ** 2
          ),
          general.ForceMin,
          general.ForceMax
        )
      : safeColor(fileBrowser.selectedStructure.getDefaultElementColor(element));

    colorBtn.style.background = hexToRgba(resetColor, 0.8);

    applyIndividualOpacity(fileBrowser.selectedStructure.atoms[atomIndex].getOpacity?.() ?? 1);
    applyIndividualRadiusScale(fileBrowser.selectedStructure.atoms[atomIndex].getRadiusScale?.() ?? 1);
    onColorChange();
    // A centered polyhedron is coloured by its centre atom, so recolour in place
    // (cheap, no geometry recompute) — matches the perImage reset branch above.
    updatePolyhedraColors();
    updateVisualization({
      bondsUpdate: false,
      reRenderAtoms: false,
      reRenderBonds: false,
      reRenderLattice: false,
      reRenderOther: false,
      reRenderComposition: "open",
    });
    setActiveEditor(null);
    return { structure, currentMode };
  }
  AtomColorResetBtn.title = 'Click: this frame. Press and hold: whole trajectory.';
  wirePressHoldPopup(AtomColorResetBtn, {
    holdLabel: 'Reset Trajectory',
    onPress: () => { doResetAtomThisFrame(); },
    onConfirm: () => {
      const { structure, currentMode } = doResetAtomThisFrame();
      if (perImage) {
        const key = atomImageKey(structure, imageIndex);
        if (key) applyToOtherTrajectoryFrames(structure, (frame) => { delete frame.atomImageStyles?.[key]; });
      } else {
        applyToOtherTrajectoryFrames(structure, (frame) => resetLinkedAtomsColorData(frame, currentMode));
      }
    },
  });
  row.appendChild(editor);
  // Image rows have no Position/Spin buttons, so their editors are unreachable
  // — don't add them to the DOM.
  if (!isPeriodicImage) {
    row.appendChild(coordEditor);
    row.appendChild(spinEditor);
  }
  // The editors span the full row; in the stacked (flex) layout `grid-column`
  // on them means nothing, so they claim a whole flex line instead.
  if (stackedHeader) {
    [editor, coordEditor, spinEditor].forEach((panel) => { panel.style.flex = '1 1 100%'; });
  }
  return row;
}
