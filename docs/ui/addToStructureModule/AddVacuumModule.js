// AddVacuumModule.js
import { fileBrowser } from '../../store.js';
import { createBondLengthControls } from '../BondLengthPanel.js';
import { updateVisualization } from '../../crystal-viewer.js';



function openPeriodicTable(callback) {
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

  // Element data (symbol, name, number, mass)
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
    Ge: { name: "Germanium", number: 32, mass: "72.630" },
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
    Ce: { name: "Cerium", number: 58, mass: "140.12" },
    Pr: { name: "Praseodymium", number: 59, mass: "140.91" },
    Nd: { name: "Neodymium", number: 60, mass: "144.24" },
    Pm: { name: "Promethium", number: 61, mass: "145" },
    Sm: { name: "Samarium", number: 62, mass: "150.36" },
    Eu: { name: "Europium", number: 63, mass: "151.96" },
    Gd: { name: "Gadolinium", number: 64, mass: "157.25" },
    Tb: { name: "Terbium", number: 65, mass: "158.93" },
    Dy: { name: "Dysprosium", number: 66, mass: "162.50" },
    Ho: { name: "Holmium", number: 67, mass: "164.93" },
    Er: { name: "Erbium", number: 68, mass: "167.26" },
    Tm: { name: "Thulium", number: 69, mass: "168.93" },
    Yb: { name: "Ytterbium", number: 70, mass: "173.05" },
    Lu: { name: "Lutetium", number: 71, mass: "174.97" },
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
    Th: { name: "Thorium", number: 90, mass: "232.04" },
    Pa: { name: "Protactinium", number: 91, mass: "231.04" },
    U: { name: "Uranium", number: 92, mass: "238.03" },
    Np: { name: "Neptunium", number: 93, mass: "237" },
    Pu: { name: "Plutonium", number: 94, mass: "244" },
    Am: { name: "Americium", number: 95, mass: "243" },
    Cm: { name: "Curium", number: 96, mass: "247" },
    Bk: { name: "Berkelium", number: 97, mass: "247" },
    Cf: { name: "Californium", number: 98, mass: "251" },
    Es: { name: "Einsteinium", number: 99, mass: "252" },
    Fm: { name: "Fermium", number: 100, mass: "257" },
    Md: { name: "Mendelevium", number: 101, mass: "258" },
    No: { name: "Nobelium", number: 102, mass: "259" },
    Lr: { name: "Lawrencium", number: 103, mass: "266" },
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
    Mc: { name: "Moscovium", number: 115, mass: "289" },
    Lv: { name: "Livermorium", number: 116, mass: "293" },
    Ts: { name: "Tennessine", number: 117, mass: "294" },
    Og: { name: "Oganesson", number: 118, mass: "294" }
  };

  // Default border colors (customize as needed)
  const borderColors = {
    // Group 1 - Alkali metals (orange)
    H: '#03d7fc', Li: '#FF9900', Na: '#FF9900', K: '#FF9900',
    Rb: '#FF9900', Cs: '#FF9900', Fr: '#FF9900',
    // Group 2 - Alkaline earth metals (yellow)
    Be: '#FFFF00', Mg: '#FFFF00', Ca: '#FFFF00', Sr: '#FFFF00',
    Ba: '#FFFF00', Ra: '#FFFF00',
    // Groups 3-12 - Transition metals (gold)
    Sc: '#6e0c0c', Ti: '#6e0c0c', V:  '#6e0c0c', Cr: '#6e0c0c', Mn: '#6e0c0c',
    Fe: '#6e0c0c', Co: '#6e0c0c', Ni: '#6e0c0c', Cu: '#6e0c0c', Zn: '#6e0c0c',
    Y:  '#6e0c0c', Zr: '#6e0c0c', Nb: '#6e0c0c', Mo: '#6e0c0c', Tc: '#6e0c0c',
    Ru: '#6e0c0c', Rh: '#6e0c0c', Pd: '#6e0c0c', Ag: '#6e0c0c', Cd: '#6e0c0c',
    La: '#bd3702', Hf: '#6e0c0c', Ta: '#6e0c0c', W:  '#6e0c0c', Re: '#6e0c0c',
    Os: '#6e0c0c', Ir: '#6e0c0c', Pt: '#6e0c0c', Au: '#6e0c0c', Hg: '#6e0c0c',
    Rf: '#6e0c0c', Db: '#6e0c0c', Sg: '#6e0c0c', Bh: '#6e0c0c', Hs: '#6e0c0c',
    Mt: '#6e0c0c', Ds: '#6e0c0c', Rg: '#6e0c0c', Cn: '#6e0c0c',
    // Group 13 - Boron group (green)
    B: '#02b392', Al: '#3d03fc', Ga: '#3d03fc', In: '#3d03fc', Tl: '#3d03fc', Nh: '#363636',
    // Group 14 - Carbon group (teal)
    C: '#0d4701', Si: '#02b392', Ge: '#02b392', Sn: '#3d03fc', Pb: '#3d03fc', Fl: '#363636',
    // Group 15 - Nitrogen group (blue)
    N: '#0d4701', P: '#0d4701', As: '#02b392', Sb: '#02b392', Bi: '#3d03fc', Mc: '#363636',
    // Group 16 - Chalcogens (light blue)
    O: '#0d4701', S: '#0d4701', Se: '#0d4701', Te: '#02b392', Po: '#3d03fc', Lv: '#363636',
    // Group 17 - Halogens (pink)
    F: '#0d4701', Cl: '#0d4701', Br: '#0d4701', I: '#0d4701', At: '#02b392', Ts: '#363636',
    // Group 18 - Noble gases (purple)
    He: '#9900FF', Ne: '#9900FF', Ar: '#9900FF', Kr: '#9900FF', Xe: '#9900FF', Rn: '#9900FF', Og: '#363636',
    // Lanthanides (silver)
    Ce: '#bd3702', Pr: '#bd3702', Nd: '#bd3702', Pm: '#bd3702', Sm: '#bd3702',
    Eu: '#bd3702', Gd: '#bd3702', Tb: '#bd3702', Dy: '#bd3702', Ho: '#bd3702',
    Er: '#bd3702', Tm: '#bd3702', Yb: '#bd3702', Lu: '#bd3702',
    // Actinides (gray)
    Ac: '#bd7802', Th: '#bd7802', Pa: '#bd7802', U:  '#bd7802', Np: '#bd7802',
    Pu: '#bd7802', Am: '#bd7802', Cm: '#bd7802', Bk: '#bd7802', Cf: '#bd7802',
    Es: '#bd7802', Fm: '#bd7802', Md: '#bd7802', No: '#bd7802', Lr: '#bd7802',
    default: '#555'
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

  // Lanthanides (always visible)
  const lanthanides = ["La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu"];

  // Actinides (always visible)
  const actinides = ["Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr"];

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
    z-index: 1001;
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

  // Helper function to convert hex to RGB
  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  }

  // Create the table HTML
  let tableHTML = `
    <h3 style="margin: 0 0 10px 0; text-align: center;">Select an Element</h3>
    <div style="display: grid; grid-template-columns: repeat(18, 30px); gap: 2px; justify-content: center; margin-bottom: 10px;">
  `;

  // Render the main table
  tableLayout.forEach(period => {
    period.forEach(symbol => {
      if (!symbol) {
        tableHTML += `<div style="width: 30px; height: 30px;"></div>`;
      } else {
        const color = borderColors[symbol] || borderColors.default;
        tableHTML += `
          <button class="element-button"
            style="width: 30px; height: 30px; background: transparent; border: 2px solid ${color};
                   color: white; cursor: pointer; transition: all 0.2s; border-radius: 3px;
                   font-size: 12px; position: relative; z-index: 1;"
            data-symbol="${symbol}">
            ${symbol}
          </button>
        `;
      }
    });
  });

  tableHTML += '</div>';

  // Lanthanides row (always visible)
  tableHTML += `<div style="display: grid; grid-template-columns: repeat(15, 30px); gap: 2px; justify-content: center; margin-bottom: 5px;">`;
  lanthanides.forEach(symbol => {
    const color = borderColors[symbol] || borderColors.default;
    tableHTML += `
      <button class="element-button"
        style="width: 30px; height: 30px; background: transparent; border: 2px solid ${color};
               color: white; cursor: pointer; transition: all 0.2s; border-radius: 3px;
               font-size: 12px; position: relative; z-index: 1;"
        data-symbol="${symbol}">
        ${symbol}
      </button>
    `;
  });
  tableHTML += '</div>';

  // Actinides row (always visible)
  tableHTML += `<div style="display: grid; grid-template-columns: repeat(15, 30px); gap: 2px; justify-content: center;">`;
  actinides.forEach(symbol => {
    const color = borderColors[symbol] || borderColors.default;
    tableHTML += `
      <button class="element-button"
        style="width: 30px; height: 30px; background: transparent; border: 2px solid ${color};
               color: white; cursor: pointer; transition: all 0.2s; border-radius: 3px;
               font-size: 12px; position: relative; z-index: 1;"
        data-symbol="${symbol}">
        ${symbol}
      </button>
    `;
  });
  tableHTML += '</div>';

  // Close button
  tableHTML += `<div style="text-align: center; margin-top: 10px;">
                  <button onclick="document.getElementById('periodicTablePopup').remove()"
                    style="padding: 5px 15px; background: #333; border: 1px solid #555;
                           color: white; cursor: pointer; border-radius: 4px;">
                    Close
                  </button>
                </div>`;

  // Add elements to the popup
  periodicTable.innerHTML = tableHTML;
  periodicTable.prepend(selectedElementDisplay);
  document.body.appendChild(periodicTable);

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

export function addVacuumPanel(container) {
  container.innerHTML = `
    <div style="display: flex; align-items: center; margin-bottom: 10px; flex-wrap: nowrap;">
      <div style="display: flex; align-items: center; margin-right: 15px;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">X (Å):</label>
        <input type="number" id="vacX" value="0" step="0.1" style="width: 80px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <div style="display: flex; align-items: center; margin-right: 15px;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">Y (Å):</label>
        <input type="number" id="vacY" value="0" step="0.1" style="width: 80px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <div style="display: flex; align-items: center; margin-right: 15px;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">Z (Å):</label>
        <input type="number" id="vacZ" value="0" step="0.1" style="width: 80px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <button id="applyVacuum" class="btn-mini highlight" style="padding: 5px 10px; background: var(--bg-color); color: white; cursor: pointer;">Apply Vacuum</button>
    </div>
  `;

  // Vacuum tab logic
  container.querySelector('#applyVacuum').addEventListener('click', () => {
    const vacX = parseFloat(container.querySelector('#vacX').value) || 0;
    const vacY = parseFloat(container.querySelector('#vacY').value) || 0;
    const vacZ = parseFloat(container.querySelector('#vacZ').value) || 0;
    addVacuum(vacX, vacY, vacZ);
  });
}




export function addAtomsPanel(container) {
  container.innerHTML = `
    <div style="margin-bottom: 10px;">
      <table id="atomsTable" style="width:100%; margin-top: 10px; border-collapse: collapse;">
        <thead>
          <tr>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">Element</th>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">X</th>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">Y</th>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">Z</th>
            <th style="border: 1px solid #444; padding: 5px; font-size: 12px; text-align: center;">Color</th>
          </tr>
        </thead>
        <tbody>
          <!-- Rows will be added dynamically -->
        </tbody>
      </table>

      <div style="text-align: center; margin-top: 10px;">
        <button id="addNewRow" class="btn-mini highlight" style="width: 90%;" >
          + Add New Atom
        </button>
      </div>
    </div>

    <div style="margin-top: 15px; display: flex; align-items: center;">
      <textarea id="bulkInput" placeholder="Element x y z [color]
Example:
H 0.5 0.5 0.5 #FF0000
C 1.0 1.0 1.0
O 1.5 1.5 1.5 #00FF00" style="flex: 1; height: 80px; background: #333; border: 1px solid #555; color: white; padding: 5px; resize: vertical; margin-right: 10px;"></textarea>
      <div style="display: flex; flex-direction: column;">
        <button id="selectElementForBulk" class="btn-mini highlight">Select Element</button>
        <button id="applyBulk" class="btn-mini highlight" style="padding: 5px 10px; margin-top: 10px">Apply Bulk</button>
      </div>
    </div>

    <div style="margin-top: 15px; text-align: right;">
      <button id="addToStructure" class="btn-mini highlight" style="margin-right: 10px">Add to Structure</button>
      <button id="makeNewStructure" class="btn-mini highlight" >Add to New Structure</button>
    </div>
  `;

  // Store atoms to be added
  const atomsToAdd = [];
  let currentBulkElementInput = null;

  // Function to add a new row to the table
  function addRowToTable(element = '', x = 0, y = 0, z = 0, color = '#000000') {
    const tbody = container.querySelector('#atomsTable tbody');

    // Clear empty rows before adding new ones
    const rows = tbody.querySelectorAll('tr');
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const elementInput = lastRow.querySelector('.atom-element');
      if (!elementInput || elementInput.value === '') {
        tbody.removeChild(lastRow);
      }
    }

    const newRow = document.createElement('tr');

    newRow.innerHTML = `
      <td style="border: 1px solid #444; padding: 5px;">
        <div style="display: flex; flex-direction: column;">
          <input type="text" class="atom-element" value="${element}" style="width: 100px; background: #333; border: 1px solid #555; color: white; padding: 3px; margin: 4px; margin-bottom: 3px; border-radius: 3px;">
          <button class="select-element-btn"  style="padding: 2px 5px; background: #595959; border: none; color: white; cursor: pointer; font-size: 10px; width: 100%; border-radius: 3px;">Select Element</button>
        </div>
      </td>
      <td style="border: 1px solid #444; padding: 5px;"><input type="number" class="atom-x" value="${x}" step="0.1" style="width: 100%; background: #333; border: 1px solid #555; color: white; padding: 3px;"></td>
      <td style="border: 1px solid #444; padding: 5px;"><input type="number" class="atom-y" value="${y}" step="0.1" style="width: 100%; background: #333; border: 1px solid #555; color: white; padding: 3px;"></td>
      <td style="border: 1px solid #444; padding: 5px;"><input type="number" class="atom-z" value="${z}" step="0.1" style="width: 100%; background: #333; border: 1px solid #555; color: white; padding: 3px;"></td>
      <td style="border: 1px solid #444; padding: 5px;"><input type="color" class="atom-color" value="${color}" style="width: 100%; height: 22px; padding: 0;"></td>
    `;

    tbody.appendChild(newRow);

    // Add event listener to the select button
    const selectBtn = newRow.querySelector('.select-element-btn');
    selectBtn.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      openPeriodicTable((element) => {
        if (row) {
          row.querySelector('.atom-element').value = element;
        }
      });
    });
  }

  // Add initial row
  addRowToTable();

  // Add new row button
  container.querySelector('#addNewRow').addEventListener('click', () => {
    addRowToTable();
  });

  // Bulk input logic - Select element button for bulk input
  container.querySelector('#selectElementForBulk').addEventListener('click', () => {
    currentBulkElementInput = container.querySelector('#bulkInput');
    openPeriodicTable((element) => {
      if (currentBulkElementInput) {
        const start = currentBulkElementInput.selectionStart;
        const end = currentBulkElementInput.selectionEnd;
        const currentValue = currentBulkElementInput.value;

        const newValue = currentValue.substring(0, start) +
                        element +
                        currentValue.substring(end, currentValue.length);

        currentBulkElementInput.value = newValue;
        currentBulkElementInput.focus();
        currentBulkElementInput.setSelectionRange(start + element.length, start + element.length);
      }
    });
  });

  // Apply bulk input - Adds rows to the table
  container.querySelector('#applyBulk').addEventListener('click', () => {
    const bulkInput = container.querySelector('#bulkInput').value;
    const lines = bulkInput.split('\n');

    // Clear all empty rows before adding bulk input
    const tbody = container.querySelector('#atomsTable tbody');
    const rows = tbody.querySelectorAll('tr');
    rows.forEach(row => {
      const elementInput = row.querySelector('.atom-element');
      if (!elementInput || elementInput.value === '') {
        tbody.removeChild(row);
      }
    });

    lines.forEach(line => {
      if (line.trim() === '') return;

      // Parse line in format: Element x y z [color]
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const element = parts[0];
        const x = parseFloat(parts[1]) || 0;
        const y = parseFloat(parts[2]) || 0;
        const z = parseFloat(parts[3]) || 0;
        const color = parts[4] || '#000000';

        addRowToTable(element, x, y, z, color);
      }
    });

    container.querySelector('#bulkInput').value = '';
  });

  // Add to structure button
  container.querySelector('#addToStructure').addEventListener('click', () => {
    const tbody = container.querySelector('#atomsTable tbody');
    const rows = tbody.querySelectorAll('tr');

    rows.forEach(row => {
      const element = row.querySelector('.atom-element').value;
      const x = parseFloat(row.querySelector('.atom-x').value) || 0;
      const y = parseFloat(row.querySelector('.atom-y').value) || 0;
      const z = parseFloat(row.querySelector('.atom-z').value) || 0;
      const color = row.querySelector('.atom-color').value;

      if (element) {
        atomsToAdd.push({ element, x, y, z, color });
      }
    });

    atomsToAdd.forEach(atom => {
      addAtom(atom.element, atom.x, atom.y, atom.z, false);
    });
    atomsToAdd.length = 0;
  });

  // Make new structure button
  container.querySelector('#makeNewStructure').addEventListener('click', () => {
    const tbody = container.querySelector('#atomsTable tbody');
    const rows = tbody.querySelectorAll('tr');

    rows.forEach(row => {
      const element = row.querySelector('.atom-element').value;
      const x = parseFloat(row.querySelector('.atom-x').value) || 0;
      const y = parseFloat(row.querySelector('.atom-y').value) || 0;
      const z = parseFloat(row.querySelector('.atom-z').value) || 0;
      const color = row.querySelector('.atom-color').value;

      if (element) {
        atomsToAdd.push({ element, x, y, z, color });
      }
    });

    atomsToAdd.forEach(atom => {
      addAtom(atom.element, atom.x, atom.y, atom.z, true);
    });
    atomsToAdd.length = 0;
  });
}


export function addAtomVacuumPanel(buttonId = 'addButton') {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.warn(`No element with id '${buttonId}' found.`);
    return;
  }

  button.addEventListener('click', () => {
    const existingPanel = document.getElementById('vacuumAndAtomsPanel');
    if (existingPanel) {
      existingPanel.remove();
    }

    const panel = document.createElement('div');
    panel.id = 'vacuumAndAtomsPanel';
    panel.style.cssText = `
      position: fixed;
      top: 150px;
      left: var(--popup-left);
      padding: 15px;
      background-color: rgba(42, 42, 42, 0.9);
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 8px;
      z-index: 999;
      width: 500px;
    `;

    panel.innerHTML = `
      <div class="segmented-backend-control" id="AddPanelModeSwitch" style="margin-bottom: 10px;">
        <button data-tab="atoms" class="active">Add Atoms</button>
        <button data-tab="vacuum">Add Vacuum</button>
      </div>

      <div id="atomsTab" class="tab-content active" style="display: block;"></div>
      <div id="vacuumTab" class="tab-content" style="display: none;"></div>

      <button id="closePanel" class="btn-mini highlight" style="margin-top: 10px; padding: 5px 10px; background: rgba(240, 132, 18,0.90); border: none; color: white; cursor: pointer;">Close</button>
    `;

    document.body.appendChild(panel);

    // Initialize tabs
    addAtomsPanel(panel.querySelector('#atomsTab'));
    addVacuumPanel(panel.querySelector('#vacuumTab'));

    // Tab switching logic
    const tabButtons = panel.querySelectorAll('#AddPanelModeSwitch button');
    const tabContents = panel.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.style.display = 'none');

        button.classList.add('active');
        document.getElementById(button.dataset.tab + 'Tab').style.display = 'block';
      });
    });

    // Close panel
    panel.querySelector('#closePanel').addEventListener('click', () => {
      if (panel.parentNode) {
        panel.parentNode.removeChild(panel);
      }
    });
  });
}

