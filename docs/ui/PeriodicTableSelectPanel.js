// PeriodicTableSelectPanel.js
// Element-select periodic-table popup, shared so add-atoms/bulk (and other
// features) can reuse it. openPeriodicTable(callback) opens the table and
// invokes callback(elementSymbol) on selection. Self-contained DOM code.
//
// Element/color/layout data lives in PeriodicTablePickerCore.js, shared with
// PeriodicTableSelectTwoPanel.js (the bond-pair picker) so the two popups
// can't drift apart. Tiles are colored by chemical category (borderColors -
// the classic periodic-table group coloring), not the element's own render
// color - that's reserved for the Color/Bond Distance pickers in
// CustomUserSettingsPanel.js, which are specifically about that color.

import {
  elementData, borderColors, tableLayout, lanthanides, actinides, hexToRgb,
  closeAnyPicker, wirePickerDismiss,
} from './PeriodicTablePickerCore.js';

export function openPeriodicTable(callback) {
  closeAnyPicker();

  // Create the popup container
  const periodicTable = document.createElement('div');
  periodicTable.id = 'periodicTablePopup';
  periodicTable.className = 'pt-popup';

  // Create selected element display (compact)
  const selectedElementDisplay = document.createElement('div');
  selectedElementDisplay.id = 'selectedElementDisplay';
  selectedElementDisplay.className = 'pt-selected-display';

  selectedElementDisplay.innerHTML = `
    <div class="pt-selected-inner">
      <div id="selectedElementNumber" class="pt-selected-number"></div>
      <div id="selectedElementSymbol" class="pt-selected-symbol"></div>
      <div id="selectedElementName" class="pt-selected-name"></div>
      <div id="selectedElementMass" class="pt-selected-mass"></div>
    </div>
  `;

  // Function to show selected element
  function showSelectedElement(symbol) {
    const element = elementData[symbol];
    if (!element) return;

    const display = document.getElementById('selectedElementDisplay');
    const color = borderColors[symbol] || borderColors.default;

    // Set display background to match element color (semi-transparent)
    display.style.background = `rgba(${hexToRgb(color).r}, ${hexToRgb(color).g}, ${hexToRgb(color).b}, 0.3)`;
    display.style.border = `1px solid ${color}`;

    display.style.display = 'block';
    document.getElementById('selectedElementSymbol').textContent = symbol;
    document.getElementById('selectedElementSymbol').style.color = color;
    document.getElementById('selectedElementName').textContent = element.name;
    document.getElementById('selectedElementNumber').textContent = element.number;
    document.getElementById('selectedElementMass').textContent = element.mass;
  }

  function tileHTML(symbol) {
    const color = borderColors[symbol] || borderColors.default;
    return `
      <button class="element-button pt-tile"
        style="border-color: ${color}; --tile-glow: ${color};"
        data-symbol="${symbol}">
        ${symbol}
      </button>
    `;
  }

  // Create the table HTML
  let tableHTML = `
    <h3 class="pt-heading">Select an Element</h3>
    <div class="pt-grid-main">
  `;

  // Render the main table
  tableLayout.forEach(period => {
    period.forEach(symbol => {
      tableHTML += symbol ? tileHTML(symbol) : `<div class="pt-tile-empty"></div>`;
    });
  });

  tableHTML += '</div>';

  // Lanthanides row (always visible)
  tableHTML += `<div class="pt-grid-15 pt-grid-15-mb">`;
  lanthanides.forEach(symbol => { tableHTML += tileHTML(symbol); });
  tableHTML += '</div>';

  // Actinides row (always visible)
  tableHTML += `<div class="pt-grid-15">`;
  actinides.forEach(symbol => { tableHTML += tileHTML(symbol); });
  tableHTML += '</div>';

  // Close button
  tableHTML += `<div class="pt-close-row">
                  <button class="periodic-table-close pt-btn">
                    Close
                  </button>
                </div>`;

  // Add elements to the popup
  periodicTable.innerHTML = tableHTML;
  periodicTable.prepend(selectedElementDisplay);
  document.body.appendChild(periodicTable);

  wirePickerDismiss(periodicTable, periodicTable.querySelector('.periodic-table-close'));

  // Add event listeners to all element buttons. Hover glow is plain CSS
  // (.pt-tile:hover, see analysisPanels.css) driven by the --tile-glow
  // custom property set per tile in tileHTML() above.
  const elementButtons = periodicTable.querySelectorAll('.element-button');
  elementButtons.forEach(button => {
    const symbol = button.getAttribute('data-symbol');

    button.addEventListener('click', () => {
      showSelectedElement(symbol);
      if (callback) callback(symbol);
    });
  });
}
