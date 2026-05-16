import { fileBrowser } from '../../store.js';
import { createBondLengthControls } from '../../panels/BondLengthPanel.js';
import { updateVisualization } from '../../crystal-viewer.js';
import { getAtomColor } from '../../modules/ColorModule.js';

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
function isLightColor(hex) {
  if (hex === '#ffffff') return true;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

export function openDoublePeriodicTable(callback) {
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
    z-index: 1000;
    padding: 15px;
    font-family: Arial, sans-serif;
    width: 600px;
  `;

  // Element data
  const elementData = {
    H: { name: "Hydrogen", number: 1, mass: "1.008" },
    He: { name: "Helium", number: 2, mass: "4.0026" },
    Li: { name: "Lithium", number: 3, mass: "6.94" },
    Be: { name: "Beryllium", number: 4, mass: "9.0122" },
    B: { name: "Boron", number: 5, mass: "10.81" },
    C: { name: "Carbon", number: 6, mass: "12.011" },
    N: { name: "Nitrogen", number: 7, mass: "14.007" },
    O: { name: "Oxygen", number: 8, mass: "15.999" },
    F: { name: "Fluorine", number: 9, mass: "18.998" },
    Ne: { name: "Neon", number: 10, mass: "20.180" },
    Na: { name: "Sodium", number: 11, mass: "22.990" },
    Mg: { name: "Magnesium", number: 12, mass: "24.305" },
    Al: { name: "Aluminum", number: 13, mass: "26.982" },
    Si: { name: "Silicon", number: 14, mass: "28.085" },
    P: { name: "Phosphorus", number: 15, mass: "30.974" },
    S: { name: "Sulfur", number: 16, mass: "32.06" },
    Cl: { name: "Chlorine", number: 17, mass: "35.45" },
    Ar: { name: "Argon", number: 18, mass: "39.948" },
    K: { name: "Potassium", number: 19, mass: "39.098" },
    Ca: { name: "Calcium", number: 20, mass: "40.078" },
    Sc: { name: "Scandium", number: 21, mass: "44.956" },
    Ti: { name: "Titanium", number: 22, mass: "47.867" },
    V: { name: "Vanadium", number: 23, mass: "50.942" },
    Cr: { name: "Chromium", number: 24, mass: "51.996" },
    Mn: { name: "Manganese", number: 25, mass: "54.938" },
    Fe: { name: "Iron", number: 26, mass: "55.845" },
    Co: { name: "Cobalt", number: 27, mass: "58.933" },
    Ni: { name: "Nickel", number: 28, mass: "58.693" },
    Cu: { name: "Copper", number: 29, mass: "63.546" },
    Zn: { name: "Zinc", number: 30, mass: "65.38" },
    Ga: { name: "Gallium", number: 31, mass: "69.723" },
    Ge: { name: "Germanium", number: 32, mass: "72.63" },
    As: { name: "Arsenic", number: 33, mass: "74.922" },
    Se: { name: "Selenium", number: 34, mass: "78.971" },
    Br: { name: "Bromine", number: 35, mass: "79.904" },
    Kr: { name: "Krypton", number: 36, mass: "83.798" },
    Rb: { name: "Rubidium", number: 37, mass: "85.468" },
    Sr: { name: "Strontium", number: 38, mass: "87.62" },
    Y: { name: "Yttrium", number: 39, mass: "88.906" },
    Zr: { name: "Zirconium", number: 40, mass: "91.224" },
    Nb: { name: "Niobium", number: 41, mass: "92.906" },
    Mo: { name: "Molybdenum", number: 42, mass: "95.95" },
    Tc: { name: "Technetium", number: 43, mass: "98" },
    Ru: { name: "Ruthenium", number: 44, mass: "101.07" },
    Rh: { name: "Rhodium", number: 45, mass: "102.91" },
    Pd: { name: "Palladium", number: 46, mass: "106.42" },
    Ag: { name: "Silver", number: 47, mass: "107.87" },
    Cd: { name: "Cadmium", number: 48, mass: "112.41" },
    In: { name: "Indium", number: 49, mass: "114.82" },
    Sn: { name: "Tin", number: 50, mass: "118.71" },
    Sb: { name: "Antimony", number: 51, mass: "121.76" },
    Te: { name: "Tellurium", number: 52, mass: "127.60" },
    I: { name: "Iodine", number: 53, mass: "126.90" },
    Xe: { name: "Xenon", number: 54, mass: "131.29" },
    Cs: { name: "Cesium", number: 55, mass: "132.91" },
    Ba: { name: "Barium", number: 56, mass: "137.33" },
    La: { name: "Lanthanum", number: 57, mass: "138.91" },
    Hf: { name: "Hafnium", number: 72, mass: "178.49" },
    Ta: { name: "Tantalum", number: 73, mass: "180.95" },
    W: { name: "Tungsten", number: 74, mass: "183.84" },
    Re: { name: "Rhenium", number: 75, mass: "186.21" },
    Os: { name: "Osmium", number: 76, mass: "190.23" },
    Ir: { name: "Iridium", number: 77, mass: "192.22" },
    Pt: { name: "Platinum", number: 78, mass: "195.08" },
    Au: { name: "Gold", number: 79, mass: "196.97" },
    Hg: { name: "Mercury", number: 80, mass: "200.59" },
    Tl: { name: "Thallium", number: 81, mass: "204.38" },
    Pb: { name: "Lead", number: 82, mass: "207.2" },
    Bi: { name: "Bismuth", number: 83, mass: "208.98" },
    Po: { name: "Polonium", number: 84, mass: "209" },
    At: { name: "Astatine", number: 85, mass: "210" },
    Rn: { name: "Radon", number: 86, mass: "222" },
    Fr: { name: "Francium", number: 87, mass: "223" },
    Ra: { name: "Radium", number: 88, mass: "226" },
    Ac: { name: "Actinium", number: 89, mass: "227" },
    Rf: { name: "Rutherfordium", number: 104, mass: "267" },
    Db: { name: "Dubnium", number: 105, mass: "270" },
    Sg: { name: "Seaborgium", number: 106, mass: "271" },
    Bh: { name: "Bohrium", number: 107, mass: "270" },
    Hs: { name: "Hassium", number: 108, mass: "277" },
    Mt: { name: "Meitnerium", number: 109, mass: "276" },
    Ds: { name: "Darmstadtium", number: 110, mass: "281" },
    Rg: { name: "Roentgenium", number: 111, mass: "280" },
    Cn: { name: "Copernicium", number: 112, mass: "285" },
    Nh: { name: "Nihonium", number: 113, mass: "284" },
    Fl: { name: "Flerovium", number: 114, mass: "289" },
    Mc: { name: "Moscovium", number: 115, mass: "288" },
    Lv: { name: "Livermorium", number: 116, mass: "293" },
    Ts: { name: "Tennessine", number: 117, mass: "294" },
    Og: { name: "Oganesson", number: 118, mass: "294" }
  };

  // Main periodic table layout
  const tableLayout = [
    ["H", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "He"],
    ["Li", "Be", null, null, null, null, null, null, null, null, null, null, "B", "C", "N", "O", "F", "Ne"],
    ["Na", "Mg", null, null, null, null, null, null, null, null, null, null, "Al", "Si", "P", "S", "Cl", "Ar"],
    ["K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr"],
    ["Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I", "Xe"],
    ["Cs", "Ba", "La", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn"],
    ["Fr", "Ra", "Ac", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og"]
  ];

  const lanthanides = ["La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu"];
  const actinides = ["Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr"];

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
      const textColor = isLightColor(color) ? '#000000' : '#ffffff';

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
        const isWhite = color === '#ffffff';
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
      <button onclick="document.getElementById('periodicTablePopup').remove()"
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
