import { fileBrowser, general } from '../../../state/store.js';
import { colorHexToCss, createPieDot, getAtomColor } from '../../../utils/ColorModule.js';
import { getAtomImageColor } from '../../../render/AtomsFracUpdateModule.js';
import { getElementDefaultColor } from '../../../defaults/color_texture_defaults.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { getElementAtomIndices, getElementOpacityValues, setSwatchOpacity, createMiniToggleSwitch, updateAtomCoordinatesLive } from './utils.js';
import { createTinyImmunityToggle } from './Immunity.js';
import { createIndividualAtomRow } from './IndividualAtomRow.js';
import { createElementColorEditor } from './ColorEditor.js';
import { setSpeciesColorBulk, refreshBondColorsForAtoms } from '../../../render/index.js';
import { openSwatchColorPicker } from '../../SwatchColorPicker.js';

import { applyWyckoffOrbitPosition, getOrbitAxisFreedom } from '../../SymmetryEditModule.js';

// =============================================
// HELPERS
// =============================================

/**
 * Ensures a color is always a valid CSS hex string (e.g., "#RRGGBB")
 * @param {number|string} color - The color to normalize
 * @returns {string} - Valid CSS hex color
 */
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

// Global registry for all composition row update functions
const compositionRowUpdateFunctions = {};

// =============================================
// MAIN COMPOSITION ROW CREATION
// =============================================

/**
 * Creates a composition row for a standard element
 * @param {string} el - The element symbol
 * @param {number} count - Number of atoms of this element
 * @param {number} total - Total number of atoms in the structure
 * @returns {HTMLElement} - The composition row container
 */
export function createCompositionRow(el, count, total, options = {}) {
  // `el` is the group's representative element and still keys everything that
  // is genuinely element-scoped (visibility, the colour editor, the pie-dot
  // registry). `options.label`/`options.atomIndices` describe the GROUP, which
  // for a mixed site is a composition like "(K,Na)" rather than one element -
  // without them a 50/50 Na/K structure puts every site under K and leaves an
  // empty, uninteractable Na row.
  const container = document.createElement('div');
  container.className = 'comp-container';
  container.dataset.element = el;
  if (options.key) container.dataset.signature = options.key;

  const row = document.createElement('div');
  row.className = 'comp-row';
  row.style.cssText = `
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: 8px;
    row-gap: 6px;
    cursor: pointer;
    transition: background-color 0.2s ease;
  `;

  const left = document.createElement('div');
  left.className = 'comp-left';

  // Per-element visibility (parity with the Bonds/Poly tab headers): hides
  // only this element's atom spheres (zero-scaled, also unpickable); bonds and
  // polyhedra keep their own visibility toggles.
  const { wrapper: visCheckboxSwitch, input: visCheckbox } = createMiniToggleSwitch(`Show/hide all ${el} atoms`);
  visCheckbox.checked = general.atomVisibility[el] !== false;
  visCheckbox.onchange = (e) => {
    general.atomVisibility[el] = /** @type {any} */ (e.target).checked;
    updateVisualization({
      atomsUpdate: true,
      bondsUpdate: false,
      reRenderAtoms: false,
      reRenderBonds: false,
      reRenderLattice: false,
      reRenderOther: false,
      reRenderComposition: false,
    });
  };
  left.appendChild(visCheckboxSwitch);

  // Get all atom indices for this element — including hidden ones. This
  // feeds the color/opacity/immunity editors below (and the per-atom row
  // list), which must still reach a hidden atom or its color/opacity would
  // silently stay stuck at whatever it was before hiding, even surviving a
  // later restore. The visible-only COUNT shown in this row's header comes
  // from computeComposition() separately and is unaffected by this.
  const elementAtomIndices = options.atomIndices ?? getElementAtomIndices(el, { includeHidden: true });

  // =========================================
  // PIE DOT MANAGEMENT
  // =========================================

  /**
   * Updates the pie dot for this element row
   * Recreates the dot with current atom colors
   */
  function updatePieDotForRow() {
    // Get current colors for all atoms of this element. When periodic-copy
    // linking is off, aggregate the resolved per-copy colors instead so the
    // dot reflects individually recolored copies.
    const structure = fileBrowser.selectedStructure;
    // A color-change event can fire between fileBrowser.selectedStructure
    // being swapped and this row's own rebuild (e.g. syncPlanesForSelectedStructure's
    // updateVisualization call, which runs before updateStructureFromRowAndStep's
    // final reRenderComposition:true) — so elementAtomIndices may briefly hold
    // indices from the PREVIOUS structure. Drop any that are out of range for
    // the structure actually selected right now instead of crashing.
    const atomCount = structure?.atoms?.length ?? 0;
    const validIndices = elementAtomIndices.filter((index) => index < atomCount);
    const atomColors = (!general.linkPeriodicCopies && structure?.atomImages)
      ? validIndices.flatMap((index) =>
          (structure.atomImages[index] ?? []).map((img) => safeColor(getAtomImageColor(structure, img))))
      : validIndices.flatMap((index) => {
        const atom = structure.atoms[index];
        // A disordered site has only one resolved colour (its representative),
        // so asking each atom for a single colour would paint a Na/K group
        // entirely K. Contribute each species' own colour instead, repeated in
        // proportion to its occupancy, so the dot shows the real split.
        if (atom?.isDisordered?.()) {
          const slices = [];
          for (const sp of atom.species) {
            const weight = Math.max(1, Math.round(sp.occupancy * 10));
            for (let w = 0; w < weight; w++) slices.push(safeColor(getElementDefaultColor(sp.element)));
          }
          const vacancy = atom.getVacancyFraction();
          if (vacancy > 1e-3) {
            const weight = Math.max(1, Math.round(vacancy * 10));
            for (let w = 0; w < weight; w++) slices.push(safeColor(0x2a2a30));
          }
          return slices;
        }
        return [safeColor(getAtomColor(index))];
      });
    const currentOpacity = getElementOpacityValues(el)[0] ?? 1;

    // Remove the old dot(s) if present — a single element, or a wrapper of
    // several for a mixed group (see below).
    const oldDot = left.querySelector('.dot');
    if (oldDot) left.removeChild(oldDot);

    const groupElements = options.elements ?? [el];
    // A vacancy-only "disorder" (one real species, e.g. "(U,Vac)") still needs
    // the per-element path below: the single-dot branch's editor writes
    // atom.userColor, which the wedge shader does not read for ANY disordered
    // atom (isDisordered() is true here too, from the vacancy alone) — using
    // it would repaint bonds but leave the sphere itself unchanged, exactly
    // the bug setSpeciesColorBulk below exists to avoid for a mixed group.
    if (groupElements.length > 1 || options.hasVacancy) {
      // A mixed group ("(K,Na)") gets one dot PER ELEMENT rather than one
      // blended swatch: each is independently pickable, and picking one bulk-
      // sets that element's colour across every site in the group that
      // carries it. A single flat dot per element (vs. per-atom pie slices)
      // reads clearly at this size; sites with different colours per element
      // still show their own split when expanded into individual rows.
      const wrapper = document.createElement('div');
      wrapper.classList.add('dot');
      // flex:none is load-bearing here, not decoration: the wrapper sits in a
      // flex row with other content competing for width, and without it each
      // dot's default flex-shrink squeezed it down to a ~6px sliver (visibly
      // an oval, not round) rather than staying at its declared size.
      // A touch more than the single-dot case's 8px .comp-left gap alone (two
      // 18px dots read as visually wider than the one dot they replace), but
      // not so much that it starves the row's right column (count/percentage)
      // of width — this is a grid row (auto 1fr), so anything spent on the
      // left column here is width the right column doesn't get.
      // align-items:center is load-bearing, not decoration: without it the two
      // dot buttons default to a slight vertical offset from the row's other
      // content (measured ~1.5px low against the label next to them) rather
      // than sharing its center.
      // width/height:auto override the shared .dot class's own 15x15 fixed
      // size (added only so this wrapper picks up the rest of .dot's rules) —
      // without them the wrapper was clamped to that 15px box while its two
      // 18px, flex:none children refused to shrink and overflowed past its
      // edges instead, visibly overlapping the "(K,Na)" label after it.
      wrapper.style.cssText = 'display:flex; align-items:center; gap:3px; margin-right:6px; flex: none; width: auto; height: auto;';

      groupElements.forEach((groupEl) => {
        // One colour entry per site that carries this element, so the dot
        // shows a real split if sites disagree — the same aggregation a
        // single-element group's dot already gets (line ~120 above), just
        // scoped to this one element within the mixed group instead of every
        // atom. Previously this took only the first site's colour, which drew
        // as a single flat "massive" swatch and hid any per-site variation.
        const elementColors = [];
        for (const atomIndex of validIndices) {
          const atom = structure.atoms[atomIndex];
          const sp = atom?.species?.find((s) => s.element === groupEl);
          if (sp) elementColors.push(safeColor(sp.color ?? getElementDefaultColor(groupEl)));
        }
        const repHex = elementColors[0] ?? safeColor(getElementDefaultColor(groupEl));

        const miniDot = createPieDot(elementColors.length ? elementColors : [repHex], 18);
        miniDot.style.cssText = `
          width: 18px; height: 18px; border-radius: 50%; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.4); flex: none;
        `;
        miniDot.title = `Customize ${groupEl}'s colour across this group`;
        miniDot.addEventListener('click', (e) => {
          e.stopPropagation();
          openSwatchColorPicker(miniDot, repHex, (hex) => {
            const targets = [];
            for (const atomIndex of validIndices) {
              structure.atoms[atomIndex]?.species?.forEach((s, speciesIndex) => {
                if (s.element === groupEl) targets.push({ atomIndex, speciesIndex });
              });
            }
            setSpeciesColorBulk(targets, hex);
            // Bonds resolve colour from getRepresentativeColor(), which this
            // bulk edit can change for any site in the group — not just the
            // sphere, which setSpeciesColorBulk already repainted. The cheap
            // targeted repaint, not scheduleBondRebuild: this fires on every
            // pointer-move while dragging in the picker, and a 200ms-debounced
            // full rebuild just keeps getting reset by the next move.
            refreshBondColorsForAtoms(targets.map((t) => t.atomIndex));
            // openSwatchColorPicker's generic anchor.style.background=hex is a
            // no-op on this canvas-based pie dot (its drawn pixels sit on top,
            // opaque) — without redrawing it here, only a thin ring at the
            // canvas edge (anti-aliasing gap) picks up the new colour while the
            // dot itself keeps showing the stale wedge colours. setSpeciesColorBulk
            // does broadcast crysviz:colors-changed (which updateAllCompositionPieDots
            // below is also listening for), but that fires synchronously as part
            // of the call above — this explicit repaint stays as the immediate,
            // guaranteed-correct one for THIS row rather than relying on event
            // dispatch order across every other listener also reacting to it.
            updatePieDotForRow();
          });
        });
        wrapper.appendChild(miniDot);
      });

      setSwatchOpacity(wrapper, currentOpacity);
      left.insertBefore(wrapper, visCheckboxSwitch.nextSibling);
      return;
    }

    // Create new dot with current colors
    const dot = createPieDot(atomColors, 20);
    dot.classList.add('dot');
    dot.style.cssText = `
      width: 20px;
      height: 20px;
      margin-right: 6px;
      border: 1px solid rgba(255,255,255,0.4);
      cursor: pointer;
    `;
    setSwatchOpacity(dot, currentOpacity);
    // Keep DOM order checkbox -> dot -> name -> caret across repaints.
    left.insertBefore(dot, visCheckboxSwitch.nextSibling);

    // Make the dot clickable to open the color editor
    dot.title = `Customize color for all ${el} atoms`;
    dot.onclick = (e) => {
      e.stopPropagation();
      editor.style.display = (editor.style.display === 'none') ? 'flex' : 'none';
      if (editor.style.display === 'flex') editor.style.flexDirection = 'column';
      // Mirrors the row's own click handler closing the color editor when
      // expanding/collapsing — the dot closes the individual-atom list the
      // same way, so the two never clutter the row at once.
      if (atomsContainer.style.display !== 'none') {
        atomsContainer.style.display = 'none';
        expandIcon.style.transform = 'rotate(0deg)';
      }
    };
  }

  // Create initial pie dot
  updatePieDotForRow();

  // Store the update function in the global registry
  compositionRowUpdateFunctions[options.key ?? el] = updatePieDotForRow;

  // =========================================
  // ROW CONTENT
  // =========================================

  const name = document.createElement('span');
  name.textContent = options.label ?? el;
  // Explicit, scale-respecting size matching Bonds'/Poly's category labels
  // (styles.css's global `label` rule) so all three tabs render identically
  // regardless of viewport width — this span isn't a <label>, so it doesn't
  // inherit that rule, and previously fell through to `.comp-row`'s
  // narrow-viewport override instead, causing a mismatch.
  name.style.fontSize = 'calc(14px * var(--cv-font-scale, 1))';

  const expandIcon = document.createElement('span');
  expandIcon.className = 'comp-expand-icon';
  expandIcon.textContent = '▶';
  expandIcon.style.cssText = `
    margin-left: 4px;
    font-size: 14px;
    transition: transform 0.2s ease;
    color: rgba(255,255,255,0.8);
    transform: rotate(0deg);
  `;

  const keepToggle = createTinyImmunityToggle(
    elementAtomIndices,
    `Keep all ${el} atoms visible across cut planes`
  );

  left.appendChild(name);
  left.appendChild(expandIcon);

  const right = document.createElement('div');
  right.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  `;

  // Percentage in its own, smaller span: at the row's normal font size
  // "4 (80.0%)" was wide enough to wrap onto a second line whenever the left
  // column (checkbox + dot(s) + label) ate into the grid row's other column -
  // nowrap alone would have just pushed the overflow off the edge instead of
  // fixing it, so the percentage has to actually take less width.
  const countLabel = document.createElement('span');
  countLabel.style.cssText = 'white-space: nowrap;';
  const pct = (100 * count / total).toFixed(1);
  countLabel.textContent = `${count} `;
  const pctLabel = document.createElement('span');
  pctLabel.style.cssText = 'font-size: 0.8em; color: rgba(255,255,255,0.7);';
  pctLabel.textContent = `(${pct}%)`;
  countLabel.appendChild(pctLabel);
  right.appendChild(countLabel);
  right.appendChild(keepToggle.wrapper);

  row.appendChild(left);
  row.appendChild(right);

  // =========================================
  // ATOM LIST (expandable)
  // =========================================

  const atomsContainer = document.createElement('div');
  atomsContainer.className = 'individual-atoms';
  atomsContainer.style.cssText = `
    display: none;
    margin-left: 6px;
    margin-top: 8px;
    border-left: 2px solid rgba(255,255,255,0.1);
    padding-left: 6px;
  `;

  // The individual atom rows are expensive to build (one DOM subtree per atom)
  // and stay hidden until the row is expanded. Eagerly building thousands of
  // them on every load dominated load time for large structures, so populate
  // lazily on first expand instead. The populate fn is also exposed on the
  // container so code that expands it programmatically (e.g. highlight/scroll
  // to a specific atom) can ensure the rows exist first.
  let atomsPopulated = false;
  function populateAtomRows() {
    if (atomsPopulated) return;
    atomsPopulated = true;
    const structure = fileBrowser.selectedStructure;
    // "Link periodic copies" off: one row per DISPLAYED atom (per periodic
    // image), so boundary copies can be styled individually. The toggle
    // rebuilds the whole composition DOM, so no extra staleness handling is
    // needed here. (This function is never reached in wyckoff mode.)
    if (!general.linkPeriodicCopies && structure?.atomImages) {
      elementAtomIndices.forEach((atomIndex, i) => {
        const images = structure.atomImages[atomIndex] ?? [];
        images.forEach((imageIndex, j) => {
          const frac = structure.periodic?.visibleWrapped?.frac?.[imageIndex];
          const off = frac
            ? [0, 1, 2].map((a) => Math.round(frac[a] - structure.atoms[atomIndex].position[a]))
            : [0, 0, 0];
          atomsContainer.appendChild(createIndividualAtomRow(el, atomIndex, i + 1, {
            imageIndex,
            imageOffset: off,
            displayCoords: frac,
            metaText: `copy ${j + 1}/${images.length}  (${off.join(',')})`,
            onColorChange: updatePieDotForRow,
            // The (0,0,0) copy still exposes Position; give it the live updater
            // so a drag doesn't rebuild this panel out from under the slider
            // (the default here is the full-rebuild path — that's why the
            // unlinked slider only responded to clicks, not drags).
            livePositionUpdater: (coords) => updateAtomCoordinatesLive(atomIndex, coords),
          }));
        });
      });
      return;
    }
    for (let i = 0; i < elementAtomIndices.length; i++) {
      const atomIndex = elementAtomIndices[i];
      const atomRow = createIndividualAtomRow(el, atomIndex, i + 1, {
        onColorChange: updatePieDotForRow,  // Pass callback to update pie dot
        // Drag the coordinate sliders live without rebuilding this very panel
        // out from under them — the release/Apply still runs the full update.
        livePositionUpdater: (coords) => updateAtomCoordinatesLive(atomIndex, coords),
      });
      atomsContainer.appendChild(atomRow);
    }
  }
  /** @type {any} */ (atomsContainer)._populateAtomRows = populateAtomRows;

  // =========================================
  // EVENT HANDLERS
  // =========================================

  row.addEventListener('mouseenter', () => {
    row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });

  row.addEventListener('mouseleave', () => {
    row.style.backgroundColor = 'transparent';
  });

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = atomsContainer.style.display !== 'none';
    if (!isExpanded) populateAtomRows(); // build rows lazily on first expand
    atomsContainer.style.display = isExpanded ? 'none' : 'block';
    expandIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
    updatePieDotForRow(); // Update pie dot when expanded/collapsed
    editor.style.display = 'none'; // expanding/collapsing closes the category color editor
  });

  container.appendChild(row);
  container.appendChild(atomsContainer);

  // =========================================
  // COLOR EDITOR
  // =========================================

  const editor = createElementColorEditor(el, updatePieDotForRow, elementAtomIndices);
  container.appendChild(editor);

  return container;
}

// =============================================
// WYCKOFF COMPOSITION ROW CREATION
// =============================================

/**
 * Creates a composition row for a Wyckoff site element
 * @param {string} el - The element symbol
 * @param {Array} entries - Wyckoff site entries
 * @param {number} total - Total number of atoms in the structure
 * @returns {HTMLElement} - The composition row container
 */

export function createWyckoffCompositionRow(el, entries, total) {
  const container = document.createElement('div');
  container.className = 'comp-container';
  container.dataset.element = el;

  const row = document.createElement('div');
  row.className = 'comp-row';
  row.style.cssText = `
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: 8px;
    row-gap: 6px;
    cursor: pointer;
    transition: background-color 0.2s ease;
  `;

  const left = document.createElement('div');
  left.className = 'comp-left';

  // Get all atom indices for this Wyckoff element
  const wyckoffAtomIndices = entries.flatMap(entry => entry.atomIndices);

  // =========================================
  // PIE DOT MANAGEMENT
  // =========================================

  /**
   * Updates the pie dot for this Wyckoff element row
   */
  function updatePieDotForRow() {
    // See the non-Wyckoff updatePieDotForRow above for why this bounds check
    // is needed — a color-change event can fire against a just-swapped
    // fileBrowser.selectedStructure before this row itself rebuilds.
    const atomCount = fileBrowser.selectedStructure?.atoms?.length ?? 0;
    const atomColors = wyckoffAtomIndices
      .filter((index) => index < atomCount)
      .map(index => safeColor(getAtomColor(index)));
    const currentOpacity = getElementOpacityValues(el)[0] ?? 1;

    // Remove old dot if it exists
    const oldDot = left.querySelector('.dot');
    if (oldDot) left.removeChild(oldDot);

    // Create new dot with current colors
    const dot = createPieDot(atomColors, 20);
    dot.classList.add('dot');
    dot.style.cssText = `
      width: 20px;
      height: 20px;
      margin-right: 6px;
      border: 1px solid rgba(255,255,255,0.4);
      cursor: pointer;
    `;
    setSwatchOpacity(dot, currentOpacity);
    left.insertBefore(dot, left.firstChild);

    //  ADD CLICK HANDLER TO OPEN COLOR EDITOR
    dot.title = `Customize color for all ${el} atoms`;
    dot.onclick = (e) => {
      e.stopPropagation();
      editor.style.display = (editor.style.display === 'none') ? 'flex' : 'none';
      if (editor.style.display === 'flex') editor.style.flexDirection = 'column';
      // Mirrors the row's own click handler closing the color editor when
      // expanding/collapsing — the dot closes the individual-atom list the
      // same way, so the two never clutter the row at once.
      if (atomsContainer.style.display !== 'none') {
        atomsContainer.style.display = 'none';
        expandIcon.style.transform = 'rotate(0deg)';
      }
    };
  }

  // Create initial pie dot
  updatePieDotForRow();

  // Store the update function in the global registry
  compositionRowUpdateFunctions[el] = updatePieDotForRow;

  // =========================================
  // ROW CONTENT
  // =========================================

  const name = document.createElement('span');
  name.textContent = el;
  // Explicit, scale-respecting size matching Bonds'/Poly's category labels
  // (styles.css's global `label` rule) so all three tabs render identically
  // regardless of viewport width — this span isn't a <label>, so it doesn't
  // inherit that rule, and previously fell through to `.comp-row`'s
  // narrow-viewport override instead, causing a mismatch.
  name.style.fontSize = 'calc(14px * var(--cv-font-scale, 1))';

  const expandIcon = document.createElement('span');
  expandIcon.className = 'comp-expand-icon';
  expandIcon.textContent = '▶';
  expandIcon.style.cssText = `
    margin-left: 4px;
    font-size: 14px;
    transition: transform 0.2s ease;
    color: rgba(255,255,255,0.8);
    transform: rotate(0deg);
  `;

  const keepToggle = createTinyImmunityToggle(
    wyckoffAtomIndices,
    `Keep all ${el} atoms visible across cut planes`
  );

  left.appendChild(name);
  left.appendChild(expandIcon);

  const right = document.createElement('div');
  right.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  `;

  const countLabel = document.createElement('span');
  const pct = (100 * entries.length / total).toFixed(1);
  countLabel.textContent = `${entries.length} (${pct}%)`;
  right.appendChild(countLabel);
  right.appendChild(keepToggle.wrapper);

  row.appendChild(left);
  row.appendChild(right);

  // =========================================
  // ATOM LIST (expandable)
  // =========================================

  const atomsContainer = document.createElement('div');
  atomsContainer.className = 'individual-atoms';
  atomsContainer.style.cssText = `
    display: none;
    margin-left: 6px;
    margin-top: 8px;
    border-left: 2px solid rgba(255,255,255,0.1);
    padding-left: 6px;
  `;

  // Create individual atom rows for each Wyckoff site
  entries.forEach((entry, index) => {
    const atomRow = createIndividualAtomRow(el, entry.representativeIndex, index + 1, {
      linkedAtomIndices: entry.atomIndices,
      label: `${el}${index + 1}  ${entry.multiplicity}${entry.wyckoff}`,
      metaText: `${entry.siteSymmetry ? `${entry.siteSymmetry}  |  ` : ''}orbit ${entry.atomIndices.length}  |  ${entry.isFixed ? 'fixed' : `${entry.dofDimension} DOF`}`,
      positionUpdater: (coords) => applyWyckoffOrbitPosition(entry.representativeIndex, coords),
      // Slider drags skip the composition rebuild — it would replace this very
      // row (and the slider being dragged) on every frame.
      livePositionUpdater: (coords) => applyWyckoffOrbitPosition(
        entry.representativeIndex, coords, fileBrowser.selectedStructure, { reRenderComposition: false }),
      axisFreedom: getOrbitAxisFreedom(entry),
      // dofDimension is the dimension of the freedom subspace, which is not the
      // number of movable axes when they are coupled ((x, x, z) is 2 DOF across
      // 3 movable axes) — the greyed-out rows show which axes are frozen.
      freedomNote: entry.isFixed ? 'fixed by symmetry' : `${entry.dofDimension} DOF`,
      stackedHeader: true,
      resetCoordsProvider: () => fileBrowser.selectedStructure?.original?.atoms?.[entry.representativeIndex]?.position ?? null,
      positionEditable: !entry.isFixed,
      onColorChange: updatePieDotForRow
    });
    atomsContainer.appendChild(atomRow);
  });

  // =========================================
  // EVENT HANDLERS
  // =========================================

  row.addEventListener('mouseenter', () => {
    row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });

  row.addEventListener('mouseleave', () => {
    row.style.backgroundColor = 'transparent';
  });

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = atomsContainer.style.display !== 'none';
    atomsContainer.style.display = isExpanded ? 'none' : 'block';
    expandIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
    updatePieDotForRow();
    editor.style.display = 'none'; // expanding/collapsing closes the category color editor
  });

  container.appendChild(row);
  container.appendChild(atomsContainer);

  // CREATE AND ADD COLOR EDITOR FOR WYCKOFF ELEMENTS
  const editor = createElementColorEditor(el, updatePieDotForRow, wyckoffAtomIndices);
  container.appendChild(editor);

  return container;
}

// =============================================
// GLOBAL UPDATE FUNCTION
// =============================================

/**
 * Updates all composition row pie dots at once
 * Call this when color maps or modes change globally
 */
export function updateAllCompositionPieDots() {
  Object.values(compositionRowUpdateFunctions).forEach(updateFn => updateFn());
}

/**
 * Drop every registered row updater. `renderComposition()` rebuilds the
 * composition DOM from scratch on every call but this registry is keyed by
 * element symbol and was never cleared, so an element present in a
 * previously-selected structure but absent from the current one left its
 * updater behind — the next `crysviz:colors-changed` event (fired by every
 * `updateVisualization()` call) would then call it with atom indices from the
 * old structure against the new (possibly smaller) `fileBrowser.selectedStructure`,
 * crashing on an out-of-range atom lookup. Call this before (re)creating rows.
 */
export function clearCompositionRowRegistry() {
  for (const key of Object.keys(compositionRowUpdateFunctions)) delete compositionRowUpdateFunctions[key];
}

// Recoloring (color-map change, mode switch, color-bar limits, individual
// atom/bond edits, resets) never rebuilds these rows from scratch, so their
// pie dots would otherwise go stale — refresh in place whenever anything
// signals a color change (see notifyColorsChanged in PolyhedraModule.js,
// already fired by every such recolor path via updatePolyhedraColors()).
document.addEventListener('crysviz:colors-changed', updateAllCompositionPieDots);
