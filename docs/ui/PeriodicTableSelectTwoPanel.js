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
  periodicTable.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: #111;
    color: white;
    border: 1px solid #333;
    border-radius: 8px;
    z-index: 1300;
    padding: 15px;
    font-family: Arial, sans-serif;
    width: 600px;
  `;

  // Track selected elements (up to 2)
  let selectedElements = [];

  // Create selected elements display area
  const selectedDisplay = document.createElement('div');
  selectedDisplay.id = 'selectedElementsDisplay';
  selectedDisplay.style.cssText = `
    display: flex;
    justify-content: center;
    gap: 10px;
    margin: 10px 0;
    min-height: 40px;
  `;

  // Function to update the selected elements display
  function updateSelectedDisplay() {
    selectedDisplay.innerHTML = '';
    if (selectedElements.length === 0) return;

    const container = document.createElement('div');
    container.style.cssText = `
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 4px;
    `;

    selectedElements.forEach((symbol, index) => {
      const color = getElementColor(symbol);
      const isWhite = color === '#ffffff';

      const elementDiv = document.createElement('div');
      elementDiv.style.cssText = `
        width: 36px;
        height: 36px;
        border: 2px solid ${color};
        background: transparent;
        display: flex;
        justify-content: center;
        align-items: center;
        font-weight: bold;
        color: ${color};
        font-size: 14px;
        box-shadow: 0 0 8px ${color};
        border-radius: 4px;
      `;
      elementDiv.textContent = symbol;
      container.appendChild(elementDiv);

      if (index < selectedElements.length - 1) {
        const dashDiv = document.createElement('div');
        dashDiv.textContent = '—';
        dashDiv.style.color = isWhite ? '#000000' : color;
        dashDiv.style.fontSize = '16px';
        dashDiv.style.fontWeight = 'bold';
        container.appendChild(dashDiv);
      }
    });

    selectedDisplay.appendChild(container);
  }

  // Helper to render a row of elements
  function renderElementRow(symbols, isLanthanideActinide = false) {
    let rowHTML = `<div style="display: grid; grid-template-columns: repeat(${isLanthanideActinide ? 15 : 18}, 30px); gap: 2px; justify-content: center; margin-bottom: ${isLanthanideActinide ? '5px' : '10px'};">`;
    symbols.forEach(symbol => {
      if (!symbol) {
        rowHTML += `<div style="width: 30px; height: 30px;"></div>`;
      } else {
        const isPresent = presentElements.has(symbol);
        const color = getElementColor(symbol);
        const isSelected = selectedElements.includes(symbol);

        rowHTML += `
          <button class="element-button"
            style="width: 30px; height: 30px;
                   background: transparent;
                   border: ${isPresent ? '2px' : '1px'} solid ${isPresent ? color : '#444'};
                   color: ${isPresent ? color : '#444'};
                   cursor: ${isPresent ? 'pointer' : 'not-allowed'};
                   transition: all 0.2s; border-radius: 3px;
                   font-size: 12px; position: relative; z-index: 1;
                   opacity: ${isPresent ? 1 : 0.5};
                   ${isSelected ? 'box-shadow: 0 0 10px ' + color + '; transform: scale(1.1);' : ''}"
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
    <h3 style="margin: 0 0 10px 0; text-align: center;">Select Two Elements for Bond</h3>
    ${renderElementRow(tableLayout[0])}
    ${renderElementRow(tableLayout[1])}
    ${renderElementRow(tableLayout[2])}
    ${renderElementRow(tableLayout[3])}
    ${renderElementRow(tableLayout[4])}
    ${renderElementRow(tableLayout[5])}
    ${renderElementRow(tableLayout[6])}
    ${renderElementRow(lanthanides, true)}
    ${renderElementRow(actinides, true)}
    <div style="text-align: center; margin-top: 10px; display: flex; justify-content: center; gap: 10px;">
      <button id="confirmBondSelection" disabled
        style="padding: 5px 15px; background: #333; border: 1px solid #555;
               color: white; cursor: pointer; border-radius: 4px;">
        Confirm Bond
      </button>
      <button class="periodic-table-close"
        style="padding: 5px 15px; background: #333; border: 1px solid #555;
               color: white; cursor: pointer; border-radius: 4px;">
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

  // Add event listeners to all element buttons
  const elementButtons = periodicTable.querySelectorAll('.element-button');
  const confirmButton = periodicTable.querySelector('#confirmBondSelection');

  elementButtons.forEach(button => {
    const symbol = button.getAttribute('data-symbol');
    const isPresent = presentElements.has(symbol);
    const color = getElementColor(symbol);

    if (!isPresent) return;

    button.addEventListener('mouseover', () => {
      if (!selectedElements.includes(symbol)) {
        button.style.transform = 'scale(1.2)';
        button.style.boxShadow = `0 0 12px ${color}`;
        button.style.zIndex = '2';
      }
    });

    button.addEventListener('mouseout', () => {
      if (!selectedElements.includes(symbol)) {
        button.style.transform = 'scale(1)';
        button.style.boxShadow = 'none';
        button.style.zIndex = '1';
      }
    });

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
        btn.style.transform = isBtnSelected ? 'scale(1.1)' : 'scale(1)';
        btn.style.boxShadow = isBtnSelected ? `0 0 10px ${btnColor}` : 'none';
      });
    });
  });

  // Update confirm button state
  function updateButtonState() {
    confirmButton.disabled = selectedElements.length < 2;
    confirmButton.style.background = selectedElements.length >= 2 ? '#0066cc' : '#333';
    confirmButton.style.borderColor = selectedElements.length >= 2 ? '#004499' : '#555';
    confirmButton.style.cursor = selectedElements.length >= 2 ? 'pointer' : 'not-allowed';
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
