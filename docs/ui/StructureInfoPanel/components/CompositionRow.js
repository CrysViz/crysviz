import { fileBrowser } from '../../../state/store.js';
import { colorHexToCss, createPieDot, getAtomColor } from '../../../utils/ColorModule.js';
import { getElementAtomIndices, getElementOpacityValues, setSwatchOpacity } from './utils.js';
import { createTinyImmunityToggle } from './Immunity.js';
import { createIndividualAtomRow } from './IndividualAtomRow.js';
import { createElementColorEditor } from './ColorEditor.js';

import { applyWyckoffOrbitPosition } from '../../SymmetryEditModule.js';

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
export function createCompositionRow(el, count, total) {
  const container = document.createElement('div');
  container.className = 'comp-container';

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

  // Get all atom indices for this element
  const elementAtomIndices = getElementAtomIndices(el);

  // =========================================
  // PIE DOT MANAGEMENT
  // =========================================

  /**
   * Updates the pie dot for this element row
   * Recreates the dot with current atom colors
   */
  function updatePieDotForRow() {
    // Get current colors for all atoms of this element
    const atomColors = elementAtomIndices.map(index => safeColor(getAtomColor(index)));
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

    // Make the dot clickable to open the color editor
    dot.title = `Customize color for all ${el} atoms`;
    dot.onclick = (e) => {
      e.stopPropagation();
      editor.style.display = (editor.style.display === 'none') ? 'flex' : 'none';
      if (editor.style.display === 'flex') editor.style.flexDirection = 'column';
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

  const expandIcon = document.createElement('span');
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

  const countLabel = document.createElement('span');
  const pct = (100 * count / total).toFixed(1);
  countLabel.textContent = `${count} (${pct}%)`;
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
    margin-left: 20px;
    margin-top: 8px;
    border-left: 2px solid rgba(255,255,255,0.1);
    padding-left: 8px;
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
    for (let i = 0; i < elementAtomIndices.length; i++) {
      const atomIndex = elementAtomIndices[i];
      const atomRow = createIndividualAtomRow(el, atomIndex, i + 1, {
        onColorChange: updatePieDotForRow  // Pass callback to update pie dot
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
    const atomColors = wyckoffAtomIndices.map(index => safeColor(getAtomColor(index)));
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

  const expandIcon = document.createElement('span');
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
    margin-left: 20px;
    margin-top: 8px;
    border-left: 2px solid rgba(255,255,255,0.1);
    padding-left: 8px;
  `;

  // Create individual atom rows for each Wyckoff site
  entries.forEach((entry, index) => {
    const atomRow = createIndividualAtomRow(el, entry.representativeIndex, index + 1, {
      linkedAtomIndices: entry.atomIndices,
      label: `${el}${index + 1}  ${entry.multiplicity}${entry.wyckoff}`,
      metaText: `${entry.siteSymmetry ? `${entry.siteSymmetry}  |  ` : ''}orbit ${entry.atomIndices.length}  |  ${entry.isFixed ? 'fixed' : `${entry.dofDimension} DOF`}`,
      positionUpdater: (coords) => applyWyckoffOrbitPosition(entry.representativeIndex, coords),
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
