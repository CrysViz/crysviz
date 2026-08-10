import { fileBrowser } from '../state/store.js';
import { getAtomColor } from '../utils/ColorModule.js';
import { tableLayout, lanthanides, actinides, closeAnyPicker, wirePickerDismiss } from './PeriodicTablePickerCore.js';

// Helper: Normalize color to hex string
function normalizeColor(color) {
  if (!color) return '#888888';
  if (typeof color === 'number') return `#${color.toString(16).padStart(6, '0')}`;
  if (typeof color === 'string') {
    if (color.startsWith('#')) return color;
    return `#${color.padStart(6, '0')}`;
  }
  return '#888888';
}

// Helper: Determine if a color is light (needs dark text)

export function openDoublePeriodicTable(callback) {
  closeAnyPicker();

  // Get element color, returns white if multiple colors exist for the element
  function getElementColor(symbol) {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return '#888888';

    const atomIndices = structure.elements
      .map((el, idx) => el === symbol ? idx : -1)
      .filter(idx => idx !== -1);

    if (atomIndices.length === 0) return '#888888';

    const colors = atomIndices.map(idx => normalizeColor(getAtomColor(idx)));
    const allSameColor = colors.every(c => c === colors[0]);

    return allSameColor ? colors[0] : '#ffffff';
  }

  // Get the set of elements present in the current structure
  const presentElements = new Set(
    fileBrowser.selectedStructure ? fileBrowser.selectedStructure.elements : []
  );

  // Create the popup container
  const periodicTable = document.createElement('div');
  periodicTable.id = 'periodicTablePopup';
  periodicTable.className = 'pt-popup';

  // Track selected elements (up to 2)
  let selectedElements = [];

  // Create selected elements display area
  const selectedDisplay = document.createElement('div');
  selectedDisplay.id = 'selectedElementsDisplay';
  selectedDisplay.className = 'pt-selected-row';

  // Function to update the selected elements display
  function updateSelectedDisplay() {
    selectedDisplay.innerHTML = '';
    if (selectedElements.length === 0) return;

    const container = document.createElement('div');
    container.className = 'pt-selected-pair';

    selectedElements.forEach((symbol, index) => {
      const color = getElementColor(symbol);
      const isWhite = color === '#ffffff';

      const elementDiv = document.createElement('div');
      elementDiv.className = 'pt-selected-tile';
      elementDiv.style.borderColor = color;
      elementDiv.style.color = color;
      elementDiv.style.boxShadow = `0 0 8px ${color}`;
      elementDiv.textContent = symbol;
      container.appendChild(elementDiv);

      if (index < selectedElements.length - 1) {
        const dashDiv = document.createElement('div');
        dashDiv.textContent = '—';
        dashDiv.className = 'pt-selected-dash';
        dashDiv.style.color = isWhite ? '#000000' : color;
        container.appendChild(dashDiv);
      }
    });

    selectedDisplay.appendChild(container);
  }

  // Helper to render a row of elements
  function renderElementRow(symbols, isLanthanideActinide = false) {
    const rowClass = isLanthanideActinide ? 'pt-grid-15 pt-grid-15-mb' : 'pt-grid-main';
    let rowHTML = `<div class="${rowClass}">`;
    symbols.forEach(symbol => {
      if (!symbol) {
        rowHTML += `<div class="pt-tile-empty"></div>`;
      } else {
        const isPresent = presentElements.has(symbol);
        const color = getElementColor(symbol);
        const isSelected = selectedElements.includes(symbol);
        const tileClass = `element-button pt-tile${isSelected ? ' is-selected' : ''}`;

        rowHTML += `
          <button class="${tileClass}"
            style="border-color: ${isPresent ? color : '#444'};
                   color: ${isPresent ? color : '#444'};
                   --tile-glow: ${color};"
            data-symbol="${symbol}"
            ${!isPresent ? 'disabled' : ''}>
            ${symbol}
          </button>
        `;
      }
    });
    rowHTML += '</div>';
    return rowHTML;
  }

  // Create the table HTML
  let tableHTML = `
    <h3 class="pt-heading">Select Two Elements for Bond</h3>
    ${renderElementRow(tableLayout[0])}
    ${renderElementRow(tableLayout[1])}
    ${renderElementRow(tableLayout[2])}
    ${renderElementRow(tableLayout[3])}
    ${renderElementRow(tableLayout[4])}
    ${renderElementRow(tableLayout[5])}
    ${renderElementRow(tableLayout[6])}
    ${renderElementRow(lanthanides, true)}
    ${renderElementRow(actinides, true)}
    <div class="pt-btn-row">
      <button id="confirmBondSelection" class="pt-btn pt-confirm-btn" disabled>
        Confirm Bond
      </button>
      <button class="periodic-table-close pt-btn">
        Close
      </button>
    </div>
  `;

  // Add elements to the popup
  periodicTable.innerHTML = tableHTML;
  periodicTable.insertBefore(selectedDisplay, periodicTable.firstChild.nextSibling);
  document.body.appendChild(periodicTable);
  wirePickerDismiss(periodicTable, periodicTable.querySelector('.periodic-table-close'));

  // Update selected display initially
  updateSelectedDisplay();

  // Add event listeners to all element buttons. Hover glow (present,
  // unselected tiles only) is plain CSS (.pt-tile:hover, see
  // analysisPanels.css), driven by the --tile-glow custom property set per
  // tile in renderElementRow() above.
  const elementButtons = periodicTable.querySelectorAll('.element-button');
  const confirmButton = periodicTable.querySelector('#confirmBondSelection');

  elementButtons.forEach(button => {
    const symbol = button.getAttribute('data-symbol');
    const isPresent = presentElements.has(symbol);

    if (!isPresent) return;

    button.addEventListener('click', () => {
      if (selectedElements.length < 2) {
        selectedElements.push(symbol);
      } else {
        selectedElements = [selectedElements[1], symbol];
      }

      updateSelectedDisplay();
      updateButtonState();

      elementButtons.forEach(btn => {
        const btnSymbol = btn.getAttribute('data-symbol');
        const btnColor = getElementColor(btnSymbol);
        const isBtnSelected = selectedElements.includes(btnSymbol);
        const isBtnPresent = presentElements.has(btnSymbol);
        btn.style.borderColor = isBtnPresent ? btnColor : '#444';
        btn.style.color = isBtnPresent ? btnColor : '#444';
        btn.classList.toggle('is-selected', isBtnSelected);
      });
    });
  });

  // Update confirm button state — background/border/cursor are plain CSS
  // (.pt-confirm-btn:not(:disabled), see analysisPanels.css) keyed off this
  // same disabled flag.
  function updateButtonState() {
    confirmButton.disabled = selectedElements.length < 2;
  }

  // Confirm selection
  confirmButton.onclick = () => {
    if (selectedElements.length === 2) {
      const [elem1, elem2] = selectedElements;
      const pair = elem1 < elem2 ? `${elem1}-${elem2}` : `${elem2}-${elem1}`;
      if (callback) callback(pair);
      periodicTable.remove();
    }
  };
}
