import { fileBrowser, groups, general, mode } from '../../../state/store.js';
import { colorHexToCss, getAtomColor, hexToRgba, setAtomColor, createPieDot, updatePieDot } from '../../../utils/ColorModule.js';
import { refreshGhostAtoms } from '../../../render/GhostAtomsModule.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import {
  updateSingleAtomColor, updateSingleAtomOpacity, updateSingleAtomDiameter,
  getAtomImageStyle, setAtomImageStyle, clearAtomImageStyle, atomImageKey,
  clearAtomImageStylesForAtom, getAtomImageColor, updateSingleAtomImageColor,
} from '../../../render/AtomsFracUpdateModule.js';
import { updatePolyhedraColors, scheduleBondRebuild, formatCharge, setSpeciesColorBulk, refreshBondColorsForAtoms } from '../../../render/index.js';
import { openSwatchColorPicker } from '../../SwatchColorPicker.js';
import { getElementDefaultColor } from '../../../defaults/color_texture_defaults.js';
import { createMaterialEditor } from './MaterialEditor.js';
import { updateMeasurementMarkers } from '../../../render/MeasurementModule.js';
import { clampOpacity, clampRadiusScale, updateAtomCoordinates, applyToOtherTrajectoryFrames, wirePressHoldPopup } from './utils.js';
import { selectAtomFromRow, suppressSelectionHighlightFor3D, restoreSelectionHighlight, setArrowHighlightOverride, clearArrowHighlightOverride } from '../../SelectAndHighlightModule.js';
import { createTinyImmunityToggle } from './Immunity.js';
import { createSpinForceEditor } from './SpinForceEditor.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { atomForceToColor, syncBondHalvesToImageColor } from '../../ColorPanel.js';

/**
 * Formal charges of a site as a display string, or '' when none are known.
 * A disordered site lists one per species, so the row shows every charge on it
 * rather than only the majority species'.
 *
 * @param {any} atom
 * @returns {string}
 */
function formatAtomCharges(atom) {
  if (!atom?.species) return '';
  const parts = atom.species
    .filter((s) => Number.isFinite(s.oxidationState))
    .map((s) => formatCharge(s.oxidationState));
  return parts.length ? parts.join('/') : '';
}

/**
 * Row label for a site: "Fe1" for an ordinary site, "(Na,K)1" for a
 * disordered one — the group's representative element alone ("K1") would
 * silently claim the site is pure K, which is wrong for a 50/50 Na/K site.
 *
 * @param {any} atom
 * @param {string} element fallback for an ordered/unknown atom
 * @param {number} displayNumber
 * @returns {string}
 */
function defaultAtomLabel(atom, element, displayNumber) {
  if (atom?.isDisordered?.()) {
    const elements = [...new Set(atom.species.map((s) => s.element))].sort();
    return `(${elements.join(',')})${displayNumber}`;
  }
  return `${element}${displayNumber}`;
}

/**
 * A weighted colour list splitting a disordered site's colour by occupancy,
 * the same proportions the wedge sphere itself uses — fed to createPieDot()/
 * updatePieDot() for a round pie-dot preview standing in for a multi-species
 * site at a glance. A CSS conic-gradient drew this originally, but hard
 * colour stops in a conic-gradient are prone to a visible anti-aliasing
 * bleed right at the wedge seams (worst at small sizes, exactly what these
 * dots are) — the canvas renderer used everywhere else in the app for the
 * same "pie dot" language (CompositionRow.js, PolyhedraListPanel.js,
 * BondLengthPanel.js) doesn't have that problem, so this matches it instead
 * of drawing its own.
 *
 * @param {any} atom
 * @returns {string[]}
 */
function speciesPieColors(atom) {
  const species = atom.species.filter((s) => s.occupancy > 1e-3);
  const vacancy = atom.getVacancyFraction();
  const colors = [];
  for (const s of species) {
    const hex = colorHexToCss(s.color ?? getElementDefaultColor(s.element));
    const weight = Math.max(1, Math.round(s.occupancy * 10));
    for (let w = 0; w < weight; w++) colors.push(hex);
  }
  if (vacancy > 1e-3) {
    const weight = Math.max(1, Math.round(vacancy * 10));
    for (let w = 0; w < weight; w++) colors.push('#2a2a30');
  }
  return colors;
}

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

// Same pattern as the swatch registry above, but for the Alpha/Size controls:
// a bulk alpha/size edit from the selection bar (SelectionActionBar.js) mutates
// the atom model and the mesh, but the number/slider inputs of any row already
// open show stale values until this pulls them back from the model. Keyed by
// atom+image so a rebuilt row overwrites its own entry.
const atomRowStyleUpdateFunctions = {};
document.addEventListener('crysviz:atom-style-changed', () => {
  Object.values(atomRowStyleUpdateFunctions).forEach((updateFn) => updateFn());
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
  // Wyckoff orbit rows carry a long label ("F1  16l", site symmetry, orbit
  // size, DOF) that has no room next to three buttons in a docked panel, so
  // they stack: identity on its own line, buttons underneath. Ordinary atom
  // rows keep the original single-line grid (see structureInfoPanel.css for
  // both layouts). Periodic-image rows are inset under the atom they copy.
  const stackedHeader = options.stackedHeader ?? false;
  row.className = 'individual-atom-row'
    + (stackedHeader ? ' stacked-header' : '')
    + (isPeriodicImage ? ' periodic-image' : '');
  row.dataset.atomIndex = String(atomIndex);
  if (perImage) row.dataset.imageIndex = String(imageIndex);
  row.dataset.element = element;

  const imageStyle = perImage ? getAtomImageStyle(fileBrowser.selectedStructure, imageIndex) : null;
  const currentColor = perImage
    ? safeColor(getAtomImageColor(fileBrowser.selectedStructure, imageIndex))
    : safeColor(getAtomColor(atomIndex));
  const currentOpacity = imageStyle?.alpha ?? fileBrowser.selectedStructure.atoms[atomIndex].getOpacity?.() ?? fileBrowser.selectedStructure.atoms[atomIndex].opacity ?? 1;
  const currentRadiusScale = imageStyle?.radiusScale ?? fileBrowser.selectedStructure.atoms[atomIndex].getRadiusScale?.() ?? 1;

  // Atom name and coordinates container
  const nameContainer = document.createElement('div');
  nameContainer.className = 'iar-name-container';

  const rowAtom = fileBrowser.selectedStructure?.atoms?.[atomIndex];

  const name = document.createElement('span');
  const baseLabel = options.label ?? defaultAtomLabel(rowAtom, element, displayNumber);
  // The leading ↳ and dimmed colour (.periodic-image .iar-name, CSS) flag
  // this row as a periodic image of the atom above it, not an atom of its own.
  name.textContent = isPeriodicImage ? `↳ ${baseLabel}` : baseLabel;
  name.className = 'iar-name';

  // Formal charge, when the source file supplied one. Rendered next to the
  // label rather than in metaText so it survives the Wyckoff rows, which use
  // metaText for site symmetry and DOF.
  const chargeText = formatAtomCharges(rowAtom);
  if (chargeText) {
    const charge = document.createElement('span');
    charge.className = 'iar-charge';
    // Leading space so the label's textContent reads "Fe1 3+" rather than
    // "Fe13+" — the visual gap is CSS, which screen readers and any code
    // reading the label do not see.
    charge.textContent = ` ${chargeText}`;
    name.appendChild(charge);
  }

  // Per-image rows show the copy's own (wrapped) coords; the Position editor
  // below still edits the source atom's coords.
  const coords = options.displayCoords ?? fileBrowser.selectedStructure.atoms.map(a => a.position)[atomIndex];
  const coordsDisplay = document.createElement('span');
  coordsDisplay.className = 'iar-coords';
  coordsDisplay.textContent = `(${coords[0].toFixed(3)}, ${coords[1].toFixed(3)}, ${coords[2].toFixed(3)})`;

  nameContainer.appendChild(name);

  // Composition of a disordered site, one species per line: a small swatch
  // (display only — editing lives in the "Color" button's editor below, which
  // for a disordered site shows one box per species) plus the occupancy as a
  // percentage. Sits above the coordinates so the row reads label -> what is
  // on the site -> where it is. Keyed by speciesIndex (not loop position - a
  // low-occupancy species can be skipped) so the species-colour editor below
  // can refresh the matching dot instead of leaving it stuck at its
  // as-built colour after a live colour change.
  const speciesLineSwatches = new Map();
  if (rowAtom?.isDisordered?.()) {
    rowAtom.species.forEach((sp, speciesIndex) => {
      if (sp.occupancy <= 1e-3) return;
      const line = document.createElement('div');
      line.className = 'iar-species-line';

      const swatch = document.createElement('span');
      const swatchHex = colorHexToCss(sp.color ?? getElementDefaultColor(sp.element));
      swatch.className = 'iar-species-swatch';
      swatch.style.background = swatchHex;
      speciesLineSwatches.set(speciesIndex, swatch);

      const text = document.createElement('span');
      text.className = 'iar-species-text';
      text.textContent = `${sp.element} ${Math.round(sp.occupancy * 100)}%`;

      line.appendChild(swatch);
      line.appendChild(text);
      nameContainer.appendChild(line);
    });

    const vacancy = rowAtom.getVacancyFraction();
    if (vacancy > 1e-3) {
      const vacLine = document.createElement('span');
      vacLine.className = 'iar-vacancy-line';
      vacLine.textContent = `vac ${Math.round(vacancy * 100)}%`;
      nameContainer.appendChild(vacLine);
    }
  }

  if (options.metaText) {
    const meta = document.createElement('span');
    meta.className = 'iar-meta';
    meta.textContent = options.metaText;
    nameContainer.appendChild(meta);
  }
  nameContainer.appendChild(coordsDisplay);

  row.appendChild(nameContainer);

  // Panel→3D: clicking the row (its background or the name/coords area, NOT
  // the editor buttons/panels) highlights this atom in the 3D view — the
  // mirror of double-clicking the atom in 3D highlighting this row.
  nameContainer.title = `Highlight ${element}${displayNumber} in the 3D view`;
  row.addEventListener('click', (e) => {
    if (e.target !== row && !nameContainer.contains(/** @type {Node} */ (e.target))) return;
    e.stopPropagation();
    selectAtomFromRow(atomIndex, e, perImage ? imageIndex : null);
  });
  // Hover tint is plain CSS (:hover, structureInfoPanel.css) — a selected row
  // gets its amber highlight from an inline style (SelectAndHighlightModule.js
  // highlightAtomRow), which as an inline style always outranks the :hover
  // rule, so hovering a selected row never overwrites its highlight.

  // Button container
  const buttonContainer = document.createElement('div');
  buttonContainer.className = 'iar-buttons';

  // Color/alpha/size editor button (labeled "Color" — the editor holds more
  // than color; the swatch background still previews the atom color)
  // A round pie dot rather than the flat/gradient rectangle this used to be:
  // a rectangle with a left-right gradient reads ambiguously (could just be
  // an odd lighting on one colour), where a circle split by wedges is the
  // established "this is a fractional split" visual — the same language the
  // composition header's per-element dots already use, so the two read as
  // one system instead of two different colour conventions.
  const colorBtn = document.createElement('button');
  colorBtn.className = 'atom-editor-button iar-color-btn';
  colorBtn.dataset.editorButton = 'color';
  colorBtn.title = rowAtom?.isDisordered?.()
    ? `Edit each species' colour, plus alpha and size, for ${element}${displayNumber}`
    : `Edit color, alpha and size for ${element}${displayNumber}`;
  // A pie dot for a disordered site, wedges proportional to occupancy — the
  // actual reason for the round shape: a flat swatch or a linear gradient
  // both fundamentally cannot show "this is two things," where a pie can.
  // Ordered atoms keep a plain flat circle (no canvas needed, so none is
  // created — see the pieCanvas-drop branch below).
  let pieCanvas = null;
  function updateColorBtnSwatch() {
    if (rowAtom?.isDisordered?.()) {
      const colors = speciesPieColors(rowAtom);
      if (pieCanvas) { updatePieDot(pieCanvas, colors); return; }
      pieCanvas = createPieDot(colors, 24);
      pieCanvas.className = 'iar-pie-canvas';
      // createPieDot() always sets its own inline `border: 1px solid #666`
      // (utils/ColorModule.js) — an inline style beats any class rule, so
      // this has to override it the same way, not through CSS.
      pieCanvas.style.border = 'none';
      colorBtn.style.background = 'transparent';
      colorBtn.appendChild(pieCanvas);
      return;
    }
    if (pieCanvas) { pieCanvas.remove(); pieCanvas = null; } // no longer disordered - drop back to a flat circle
    const color = perImage
      ? safeColor(getAtomImageColor(fileBrowser.selectedStructure, imageIndex))
      : safeColor(getAtomColor(atomIndex));
    colorBtn.style.background = hexToRgba(color, 0.8);
  }
  updateColorBtnSwatch();
  atomRowSwatchUpdateFunctions[`${atomIndex}:${imageIndex ?? 'all'}`] = () => {
    updateColorBtnSwatch();
    refreshSpeciesSwatches();
  };

  // Keeps the small per-species line dots and the big per-species swatch
  // boxes (if the editor is open) in sync with rowAtom.species[i].color.
  // updateColorBtnSwatch above only refreshes the pie icon; nothing
  // previously refreshed these, so a colour change made elsewhere (e.g. the
  // composition group's own per-element dot in CompositionRow.js) left them
  // showing whatever colour they were built with until the whole row got
  // rebuilt. Hoisted (function declaration, not const) so the registration
  // above can reference it despite speciesSwatchButtons/speciesColorRow
  // being declared later in this same function.
  function refreshSpeciesSwatches() {
    rowAtom?.species?.forEach((sp, speciesIndex) => {
      const hex = colorHexToCss(sp.color ?? getElementDefaultColor(sp.element));
      speciesSwatchButtons.get(speciesIndex)?.style.setProperty('background', hex);
      speciesLineSwatches.get(speciesIndex)?.style.setProperty('background', hex);
    });
  }

  // Coordinate edit button
  const coordBtn = document.createElement('button');
  coordBtn.textContent = 'Position';
  coordBtn.className = 'atom-editor-button iar-coord-btn';
  coordBtn.dataset.editorButton = 'coord';
  coordBtn.title = `Edit coordinates for ${element}${displayNumber}`;
  if (!positionEditable) {
    coordBtn.disabled = true;
    coordBtn.title = `Position is fixed by symmetry for ${element}${displayNumber}`;
  }

  // Spin Edit button
  const spinBtn = document.createElement('button');
  // Split the label at the slash onto two lines ("Spin/" / "Force"), the way it
  // was before: it keeps this (longest) button narrow so the three buttons fit
  // beside the name in a docked panel instead of overflowing it.
  spinBtn.innerHTML = 'Spin/<br>Force';
  spinBtn.className = 'atom-editor-button iar-spin-btn';
  spinBtn.dataset.editorButton = 'spin';
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
  editor.style.display = 'none'; // read back via .style.display in General.js's UI-state capture

  // A disordered site is genuinely more than one thing sharing a position, so
  // its colour editor is N small square boxes (one per species) instead of
  // the single big inline picker below — each independently pickable, wired
  // straight to that species' own colour (never atom.userColor/color, which
  // the wedge shader does not read at all: setting it here would visibly do
  // nothing to the sphere, only to bonds, which was the actual bug report).
  // Keyed by speciesIndex, same reasoning as speciesLineSwatches above — lets
  // doResetAtomThisFrame() repaint these big editable boxes after a Reset,
  // the same way each swatch's own onReset callback already repaints itself.
  const speciesSwatchButtons = new Map();
  const speciesColorRow = rowAtom?.isDisordered?.() ? document.createElement('div') : null;
  if (speciesColorRow) {
    speciesColorRow.className = 'iar-species-color-row';
    rowAtom.species.forEach((sp, speciesIndex) => {
      if (sp.occupancy <= 1e-3) return;
      const box = document.createElement('div');
      box.className = 'iar-species-swatch-box';

      const swatchHex = colorHexToCss(sp.color ?? getElementDefaultColor(sp.element));
      const swatchBtn = document.createElement('button');
      speciesSwatchButtons.set(speciesIndex, swatchBtn);
      swatchBtn.type = 'button';
      swatchBtn.title = `Colour for ${sp.element} on this site`;
      swatchBtn.className = 'iar-species-swatch-btn';
      swatchBtn.style.background = swatchHex;
      swatchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSwatchColorPicker(swatchBtn, swatchHex, (hex) => {
          setSpeciesColorBulk([{ atomIndex, speciesIndex }], hex);
          // The small display-only dot next to "<element> <occupancy>%" above
          // shows this same species' colour — openSwatchColorPicker already
          // repaints swatchBtn itself, but nothing else was keeping this one
          // in sync, so it stayed stuck at whatever it was built with.
          speciesLineSwatches.get(speciesIndex)?.style.setProperty('background', hex);
          updateColorBtnSwatch();
          // A representative-species edit changes what colour the bonds
          // touching this site should show. This fires on every pointer-move
          // while dragging in the picker, so it has to be the cheap targeted
          // repaint (no topology recompute) — scheduleBondRebuild's 200ms
          // debounce would just keep getting reset by the next move and never
          // actually run until the drag stopped, which read as "not live."
          refreshBondColorsForAtoms([atomIndex]);
          onColorChange(); // the parent composition row's own pie dot follows too
        }, { onReset: () => {
          setSpeciesColorBulk([{ atomIndex, speciesIndex }], null);
          const defaultHex = colorHexToCss(getElementDefaultColor(sp.element));
          swatchBtn.style.background = defaultHex;
          speciesLineSwatches.get(speciesIndex)?.style.setProperty('background', defaultHex);
          updateColorBtnSwatch();
          refreshBondColorsForAtoms([atomIndex]);
          onColorChange();
        } });
      });

      const label = document.createElement('span');
      label.textContent = sp.element;
      label.className = 'iar-species-swatch-label';

      box.appendChild(swatchBtn);
      box.appendChild(label);
      speciesColorRow.appendChild(box);
    });
  }

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
    updateColorBtnSwatch();
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
  AtomColorApplyBtn.className = 'btn-mini highlight si-action-btn-narrow';

  const AtomColorResetBtn = document.createElement('button');
  AtomColorResetBtn.textContent = 'Reset';
  AtomColorResetBtn.className = 'btn-mini si-action-btn-narrow';

  // Get the default color for this element
  const defaultColor = safeColor(fileBrowser.selectedStructure.getDefaultElementColor(element));
  AtomColorResetBtn.style.background = hexToRgba(defaultColor, 0.8);

  const topRowIndiv = document.createElement('div');
  topRowIndiv.className = 'iar-top-row';
  // A disordered site shows its per-species boxes instead of the single whole-
  // atom picker — that picker still exists (Reset/Apply below still operate on
  // alpha/size, which stay whole-site properties) but is not the colour control
  // for a mixed site.
  topRowIndiv.appendChild(speciesColorRow ?? picker.element);

  const buttonRowIndiv = document.createElement('div');
  buttonRowIndiv.className = 'iar-button-row';
  buttonRowIndiv.appendChild(AtomColorResetBtn);
  buttonRowIndiv.appendChild(AtomColorApplyBtn);

  const atomAlphaRow = document.createElement('div');
  atomAlphaRow.className = 'si-row';
  const atomAlphaLabel = document.createElement('span');
  atomAlphaLabel.textContent = 'Alpha';
  atomAlphaLabel.className = 'si-row-label';
  const atomAlphaSlider = document.createElement('input');
  atomAlphaSlider.type = 'range';
  atomAlphaSlider.min = '0.05';
  atomAlphaSlider.max = '1';
  atomAlphaSlider.step = '0.01';
  atomAlphaSlider.value = String(currentOpacity);
  const atomAlphaValue = document.createElement('input');
  atomAlphaValue.type = 'number';
  atomAlphaValue.min = '0.05';
  atomAlphaValue.max = '1';
  atomAlphaValue.step = '0.01';
  atomAlphaValue.value = currentOpacity.toFixed(2);
  atomAlphaRow.appendChild(atomAlphaLabel);
  atomAlphaRow.appendChild(atomAlphaSlider);
  atomAlphaRow.appendChild(atomAlphaValue);

  // Size (per-atom radius multiplier), same row layout as Alpha.
  const atomSizeRow = document.createElement('div');
  atomSizeRow.className = 'si-row';
  const atomSizeLabel = document.createElement('span');
  atomSizeLabel.textContent = 'Size';
  atomSizeLabel.className = 'si-row-label';
  const atomSizeSlider = document.createElement('input');
  atomSizeSlider.type = 'range';
  atomSizeSlider.min = '0.2';
  atomSizeSlider.max = '3';
  atomSizeSlider.step = '0.05';
  atomSizeSlider.value = String(currentRadiusScale);
  const atomSizeValue = document.createElement('input');
  atomSizeValue.type = 'number';
  atomSizeValue.min = '0.2';
  atomSizeValue.max = '3';
  atomSizeValue.step = '0.05';
  atomSizeValue.value = currentRadiusScale.toFixed(2);
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
  coordEditor.style.display = 'none'; // read back via .style.display in General.js's UI-state capture

  const coordTitle = document.createElement('div');
  coordTitle.className = 'coord-editor-title';
  const coordTitleText = document.createElement('span');
  coordTitleText.textContent = 'Fractional Coordinates';
  coordTitle.appendChild(coordTitleText);
  if (options.freedomNote) {
    const note = document.createElement('span');
    note.className = 'coord-editor-note';
    note.textContent = options.freedomNote;
    coordTitle.appendChild(note);
  }

  // One stacked row per axis: label, slider, number box. Axes the symmetry
  // freezes (axisFreedom[axis] false) are greyed out and disabled — dragging
  // them could only ever be undone by the projection anyway.
  const axisNames = ['x', 'y', 'z'];
  const coordInputsRow = document.createElement('div');
  coordInputsRow.className = 'coord-axis-rows';

  const axisSliders = [];
  const axisInputs = [];

  axisNames.forEach((axisName, axis) => {
    const free = positionEditable && axisFreedom[axis];

    const axisRow = document.createElement('div');
    axisRow.className = 'coord-axis-row';
    axisRow.dataset.axis = axisName;
    axisRow.dataset.free = String(free); // also drives the greyed-out look, see [data-free="false"] in CSS

    const axisLabel = document.createElement('span');
    axisLabel.textContent = axisName;
    axisLabel.className = 'coord-axis-row-label';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'coord-axis-slider';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.0001';
    slider.value = String(coords[axis]);
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
  coordApplyBtn.className = 'btn-mini highlight si-action-btn-wide';
  coordApplyBtn.disabled = !positionEditable;

  const coordResetBtn = document.createElement('button');
  coordResetBtn.textContent = 'Reset';
  coordResetBtn.className = 'btn-mini si-action-btn-wide si-action-btn-wide--gap';
  coordResetBtn.disabled = !positionEditable;

  const coordButtonsRow = document.createElement('div');
  coordButtonsRow.className = 'coord-buttons-row';
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
  // Active/inactive border+glow is plain CSS (.atom-editor-button.active).
  function setButtonActive(button, isActive) {
    button.classList.toggle('active', isActive);
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

  // Re-read Alpha/Size straight from the model onto this row's controls, so a
  // bulk edit elsewhere (the selection bar) that changed this atom is reflected
  // here. Reads the same per-image vs source-atom values the row was built with.
  function syncAlphaSizeControlsFromModel() {
    const structure = fileBrowser.selectedStructure;
    const atom = structure?.atoms?.[atomIndex];
    if (!atom) return;
    const style = perImage ? getAtomImageStyle(structure, imageIndex) : null;
    const opacity = clampOpacity(style?.alpha ?? atom.getOpacity?.() ?? atom.opacity ?? 1);
    const scale = clampRadiusScale(style?.radiusScale ?? atom.getRadiusScale?.() ?? 1);
    atomAlphaSlider.value = String(opacity);
    atomAlphaValue.value = opacity.toFixed(2);
    atomSizeSlider.value = String(scale);
    atomSizeValue.value = scale.toFixed(2);
  }
  atomRowStyleUpdateFunctions[`${atomIndex}:${imageIndex ?? 'all'}`] = syncAlphaSizeControlsFromModel;

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
        note.classList.remove('refused');
        delete note.dataset.refused;
      }
      return;
    }
    if (note && !note.dataset.refused) {
      note.dataset.original = note.textContent;
      note.dataset.refused = '1';
      note.classList.add('refused');
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
    updateColorBtnSwatch();
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
      // A disordered site's wedges each render their OWN species' colour
      // (species[i].color, set via the swatches above), never atom.color/
      // userColor at all — clearing only those left a mixed site's Reset
      // looking like it did nothing. Pure data here (this also runs against
      // off-screen trajectory frames, see the press-and-hold caller below);
      // the wedge-texture repaint for the visible frame happens in
      // doResetAtomThisFrame, which knows which frame is actually on screen.
      atom.species?.forEach((s) => { s.color = null; });

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
      updateColorBtnSwatch();
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

    // Wedge sphere colours (per species) are a separate GPU texture from the
    // plain per-instance colour updateSingleAtomColor() just repainted above
    // — resetLinkedAtomsColorData() already cleared species[i].color as data,
    // this is the one wedge-texture refresh + render request that actually
    // makes it visible, scoped to the frame on screen right now (species
    // colours have no per-image concept, so this is keyed by atomIndex only).
    const speciesResetTargets = [];
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      structure.atoms[linkedAtomIndex]?.species?.forEach((_, speciesIndex) => {
        speciesResetTargets.push({ atomIndex: linkedAtomIndex, speciesIndex });
      });
    });
    // setSpeciesColorBulk now broadcasts crysviz:colors-changed (dispatched
    // synchronously, so this row's own registered listener has already run
    // by the time the call below returns), which repaints this row's swatch
    // boxes/dots via refreshSpeciesSwatches — no need to do it again here.
    if (speciesResetTargets.length) setSpeciesColorBulk(speciesResetTargets, null);

    // resetLinkedAtomsColorData() above already wrote the reset colour (force-
    // derived or element-default) onto atom.color; updateColorBtnSwatch()
    // reads that back — via the same isDisordered() branch as everywhere else
    // — rather than recomputing it a second time here and risking the two
    // falling out of sync (as a flat recompute did for a disordered atom,
    // wiping its pie dot back to a single colour on every Reset).
    updateColorBtnSwatch();

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
  // means nothing, so they claim a whole flex line instead — handled by
  // .individual-atom-row.stacked-header in structureInfoPanel.css.
  return row;
}
