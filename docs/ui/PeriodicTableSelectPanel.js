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

  // Create selected element display (compact)
  const selectedElementDisplay = document.createElement('div');
  selectedElementDisplay.id = 'selectedElementDisplay';
    selectedElementDisplay.style.cssText = `
    display: none;
    position: absolute;
    top: 55px;
    left: 40%;
    transform: translateX(-50%);
    width: 80px;
    height: 60px;
    background: rgba(0, 0, 0, 0.8);
    border-radius: 8px;
    padding: 5px;
    text-align: center;
    z-index: 1301;
    box-sizing: border-content;
    border: 2px solid transparent;
  `;

  selectedElementDisplay.innerHTML = `
    <div style="position: relative; width: 100%; height: 100%;">
      <div id="selectedElementNumber" style="
        position: absolute;
        top: 2px;
        left: 2px;
        font-size: 14px;
        font-weight: normal;
      "></div>
      <div id="selectedElementSymbol" style="
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-weight: bold;
        font-size: 24px;
      "></div>
      <div id="selectedElementName" style="
        position: absolute;
        bottom: -5px;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 12px;
        font-weight: normal;
      "></div>
      <div id="selectedElementMass" style="
        position: absolute;
        top: 2px;
        right: 2px;
        font-size: 12px;
        font-weight: normal;
      "></div>
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
      <button class="element-button"
        style="width: 30px; height: 30px; background: transparent; border: 2px solid ${color};
               color: white; cursor: pointer; transition: all 0.2s; border-radius: 3px;
               font-size: 12px; position: relative; z-index: 1;"
        data-symbol="${symbol}">
        ${symbol}
      </button>
    `;
  }

  // Create the table HTML
  let tableHTML = `
    <h3 style="margin: 0 0 10px 0; text-align: center;">Select an Element</h3>
    <div style="display: grid; grid-template-columns: repeat(18, 30px); gap: 2px; justify-content: center; margin-bottom: 10px;">
  `;

  // Render the main table
  tableLayout.forEach(period => {
    period.forEach(symbol => {
      tableHTML += symbol ? tileHTML(symbol) : `<div style="width: 30px; height: 30px;"></div>`;
    });
  });

  tableHTML += '</div>';

  // Lanthanides row (always visible)
  tableHTML += `<div style="display: grid; grid-template-columns: repeat(15, 30px); gap: 2px; justify-content: center; margin-bottom: 5px;">`;
  lanthanides.forEach(symbol => { tableHTML += tileHTML(symbol); });
  tableHTML += '</div>';

  // Actinides row (always visible)
  tableHTML += `<div style="display: grid; grid-template-columns: repeat(15, 30px); gap: 2px; justify-content: center;">`;
  actinides.forEach(symbol => { tableHTML += tileHTML(symbol); });
  tableHTML += '</div>';

  // Close button
  tableHTML += `<div style="text-align: center; margin-top: 10px;">
                  <button class="periodic-table-close"
                    style="padding: 5px 15px; background: #333; border: 1px solid #555;
                           color: white; cursor: pointer; border-radius: 4px;">
                    Close
                  </button>
                </div>`;

  // Add elements to the popup
  periodicTable.innerHTML = tableHTML;
  periodicTable.prepend(selectedElementDisplay);
  document.body.appendChild(periodicTable);

  wirePickerDismiss(periodicTable, periodicTable.querySelector('.periodic-table-close'));

  // Add event listeners to all element buttons
  const elementButtons = periodicTable.querySelectorAll('.element-button');
  elementButtons.forEach(button => {
    const symbol = button.getAttribute('data-symbol');
    const color = borderColors[symbol] || borderColors.default;

    button.addEventListener('mouseover', () => {
      button.style.transform = 'scale(1.2)';
      button.style.boxShadow = `0 0 12px ${color}`;
      button.style.zIndex = '2';
    });

    button.addEventListener('mouseout', () => {
      button.style.transform = 'scale(1)';
      button.style.boxShadow = 'none';
      button.style.zIndex = '1';
    });

    button.addEventListener('click', () => {
      showSelectedElement(symbol);
      if (callback) callback(symbol);
    });
  });
}
