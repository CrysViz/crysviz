import { fileBrowser, groups, general, structureShip } from '../../../store.js';
import { colorHexToCss, createPieDot, updatePieDot, getAtomColor } from '../../../modules/ColorModule.js';
import { getElementAtomIndices, getElementOpacityValues, setSwatchOpacity, clampOpacity } from './utils.js';
import { createTinyImmunityToggle } from './Immunity.js';
import { createIndividualAtomRow } from './IndividualAtomRow.js';
import { createElementColorEditor } from './ColorEditor.js';
import { updateVisualization } from '../../../crystal-viewer.js';




// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

export function createCompositionRow(el, count, total) {
  const container = document.createElement('div');
  container.className = 'comp-container';

  const row = document.createElement('div');
  row.className = 'comp-row';
  row.style.cssText = 'display:grid; grid-template-columns: auto 1fr; align-items:center; column-gap:8px; row-gap:6px; cursor: pointer; transition: background-color 0.2s ease;';

  const left = document.createElement('div');
  left.className = 'comp-left';

  // Get all atom indices for this element
  const elementAtomIndices = getElementAtomIndices(el);

  // Function to update the pie dot
  function updatePieDotForRow() {
    const atomColors = elementAtomIndices.map(index => safeColor(getAtomColor(index)));
    const currentOpacity = getElementOpacityValues(el)[0] ?? 1;

    // Remove old dot if it exists
    const oldDot = left.querySelector('.dot');
    if (oldDot) left.removeChild(oldDot);

    // Create new dot with current colors
    const dot = createPieDot(atomColors, 20);
    dot.classList.add('dot');
    dot.style.cssText = 'width: 20px; height: 20px; margin-right: 6px; border: 1px solid rgba(255,255,255,0.4);';
    setSwatchOpacity(dot, currentOpacity);
    left.insertBefore(dot, left.firstChild);

    // Make the dot clickable to open the color editor
    dot.style.cursor = 'pointer';
    dot.title = 'Customize color for all ' + el + ' atoms';
    dot.onclick = (e) => {
      e.stopPropagation();
      editor.style.display = (editor.style.display === 'none') ? 'flex' : 'none';
      if (editor.style.display === 'flex') editor.style.flexDirection = 'column';
    };
  }

  // Create initial pie dot
  updatePieDotForRow();

  const name = document.createElement('span');
  name.textContent = el;

  const expandIcon = document.createElement('span');
  expandIcon.textContent = '▶';
  expandIcon.style.cssText = 'margin-left: 4px; font-size: 14px; transition: transform 0.2s ease; color: rgba(255,255,255,0.8); transform: rotate(0deg);';
  const keepToggle = createTinyImmunityToggle(elementAtomIndices, `Keep all ${el} atoms visible across cut planes`);

  left.appendChild(name);
  left.appendChild(expandIcon);

  const right = document.createElement('div');
  right.style.cssText = 'display:flex; align-items:center; justify-content:flex-end; gap:8px;';
  const countLabel = document.createElement('span');
  const pct = (100 * count / total).toFixed(1);
  countLabel.textContent = `${count} (${pct}%)`;
  right.appendChild(countLabel);
  right.appendChild(keepToggle.wrapper);

  row.appendChild(left);
  row.appendChild(right);

  const atomsContainer = document.createElement('div');
  atomsContainer.className = 'individual-atoms';
  atomsContainer.style.cssText = 'display: none; margin-left: 20px; margin-top: 8px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 8px;';

  for (let i = 0; i < elementAtomIndices.length; i++) {
    const actualAtomIndex = elementAtomIndices[i];
    const atomRow = createIndividualAtomRow(el, actualAtomIndex, i + 1, {
      onColorChange: updatePieDotForRow  // Pass callback to update pie dot
    });
    atomsContainer.appendChild(atomRow);
  }

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

  // Create element color editor
  const editor = createElementColorEditor(el, updatePieDotForRow, elementAtomIndices);
  container.appendChild(editor);

  return container;
}

export function createWyckoffCompositionRow(el, entries, total) {
  const container = document.createElement('div');
  container.className = 'comp-container';

  const row = document.createElement('div');
  row.className = 'comp-row';
  row.style.cssText = 'display:grid; grid-template-columns: auto 1fr; align-items:center; column-gap:8px; row-gap:6px; cursor: pointer; transition: background-color 0.2s ease;';

  const left = document.createElement('div');
  left.className = 'comp-left';

  // Get all atom indices for this Wyckoff element
  const wyckoffAtomIndices = entries.flatMap(entry => entry.atomIndices);

  // Function to update the pie dot
  function updatePieDotForRow() {
    const atomColors = wyckoffAtomIndices.map(index => safeColor(getAtomColor(index)));
    const currentOpacity = getElementOpacityValues(el)[0] ?? 1;

    // Remove old dot if it exists
    const oldDot = left.querySelector('.dot');
    if (oldDot) left.removeChild(oldDot);

    // Create new dot with current colors
    const dot = createPieDot(atomColors, 20);
    dot.classList.add('dot');
    dot.style.cssText = 'width: 20px; height: 20px; margin-right: 6px; border: 1px solid rgba(255,255,255,0.4);';
    setSwatchOpacity(dot, currentOpacity);
    left.insertBefore(dot, left.firstChild);
  }

  // Create initial pie dot
  updatePieDotForRow();

  const name = document.createElement('span');
  name.textContent = el;
  const expandIcon = document.createElement('span');
  expandIcon.textContent = '▶';
  expandIcon.style.cssText = 'margin-left: 4px; font-size: 14px; transition: transform 0.2s ease; color: rgba(255,255,255,0.8); transform: rotate(0deg);';
  const keepToggle = createTinyImmunityToggle(wyckoffAtomIndices, `Keep all ${el} atoms visible across cut planes`);

  left.appendChild(name);
  left.appendChild(expandIcon);

  const right = document.createElement('div');
  right.style.cssText = 'display:flex; align-items:center; justify-content:flex-end; gap:8px;';
  const countLabel = document.createElement('span');
  const pct = (100 * entries.length / total).toFixed(1);
  countLabel.textContent = `${entries.length} (${pct}%)`;
  right.appendChild(countLabel);
  right.appendChild(keepToggle.wrapper);

  row.appendChild(left);
  row.appendChild(right);

  const atomsContainer = document.createElement('div');
  atomsContainer.className = 'individual-atoms';
  atomsContainer.style.cssText = 'display: none; margin-left: 20px; margin-top: 8px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 8px;';

  entries.forEach((entry, index) => {
    const atomRow = createIndividualAtomRow(el, entry.representativeIndex, index + 1, {
      linkedAtomIndices: entry.atomIndices,
      label: `${el}${index + 1}  ${entry.multiplicity}${entry.wyckoff}`,
      metaText: `${entry.siteSymmetry ? `${entry.siteSymmetry}  |  ` : ''}orbit ${entry.atomIndices.length}  |  ${entry.isFixed ? 'fixed' : `${entry.dofDimension} DOF`}`,
      positionUpdater: (coords) => applyWyckoffOrbitPosition(entry.representativeIndex, coords),
      resetCoordsProvider: () => fileBrowser.selectedStructure?.original?.atoms?.[entry.representativeIndex]?.position ?? null,
      positionEditable: !entry.isFixed,
      onColorChange: updatePieDotForRow  // Pass callback to update pie dot
    });
    atomsContainer.appendChild(atomRow);
  });

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
  return container;
}
