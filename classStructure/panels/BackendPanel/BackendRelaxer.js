//import { io } from "https://cdn.socket.io/4.7.5/socket.io.esm.min.js";
import {updateVisualization} from '../../crystal-viewer.js'
import {createBondLengthControls} from '../BondLengthPanel.js'
import {createSpinControls} from '../SpinPanel.js'
import {updateRow} from '../FileBrowswerPanel.js'
import { createRow,selectLastAddedRow } from '../FileBrowswerPanel.js';
import {structureData,structureShip,fileBrowser} from '../../store.js'
import { Structure } from "../../classes/Structure.js";
import { StructureContainer } from "../../classes/StructureContainer.js";
import { Force } from "../../classes/Force.js";
import { Atom } from "../../classes/Atom.js";
import { Stress } from "../../classes/Stress.js";
let socket = null;
let backendConnected = false


export function addBackendRelaxPanel() {
  const panel = document.getElementById("BackendCalcPanel");

    // Clear panel
    panel.innerHTML = "";
    panel.innerHTML = `
      <h2>MLIP Relax</h2>
      <h4> ⚠️ This routine uses the MACE-MPA0 model with all its limitations as default. NOT production ready!!</h4>
      <button id="connectBtn">Connect Backend</button>
      <button id="disconnectBtn">Disconnect</button>
      <p id="backendStatus">Backend: not connected</p>

      <hr>
      <label style="display:flex; flex-direction:column;">
               Relaxation Parameters
             </label>
      <div style="display:flex; gap:10px; align-items:center; margin-bottom:15px;">
          <label style="display:flex; flex-direction:column;">
              Pressure (GPa):
              <input type="number" id="inputPressure" value="0" step="0.1" style="width:80px; margin: 10px;" />
          </label>

          <label style="display:flex; flex-direction:column;">
              Max Force     (eV/Å):
              <input type="number" id="inputMaxForce" value="0.001" step="0.001" style="width:80px; margin: 10px;" />
          </label>
      </div>

      <hr>
  <!-- Two buttons side by side -->
  <div style="display:flex; gap:10px; margin-bottom:15px;">
      <button class="calcButton" id="getEFS" >Get EFS</button>
      <button class="calcButton" id="appendRelaxBtn" >Append Relaxation</button>
      <button class="calcButton" id="newRelaxBtn" >New Relaxation</button>
  </div>

      <p id="calcStatus"></p>
      <p id="calcOutput"></p>
      <p id="calcResult"></p>
  `;


    // Hook up buttons
    document.getElementById("connectBtn").onclick = connectBackend;
    document.getElementById("disconnectBtn").onclick = disconnectBackend;
    document.getElementById("appendRelaxBtn").onclick = () => calculate("append");
    document.getElementById("newRelaxBtn").onclick = () => calculate("new");
    document.getElementById("getEFS").onclick = () => calculate("getEFS");
}

export function removeBackendRelaxPanel() {
    const panel = document.getElementById("BackendRelaxPanel");
    panel.innerHTML = `
        <h1>No backend connected. All data remains on your computer</h1>
    `;
}


export function connectBackend() {
    if (backendConnected) return;

    socket = io("http://localhost:5001", {
        timeout: 1000,
        reconnection: false
    });

    socket.on("connect", () => {
        backendConnected = true;
        document.getElementById("backendStatus").textContent =
            "Backend: connected";
    });

    socket.on("connect_error", () => {
        backendConnected = false;
        document.getElementById("backendStatus").textContent =
            "Backend: not found (running without backend)";
    });

    socket.on("status", (data) => {
        document.getElementById("calcStatus").textContent = data.message;
    });

    socket.on("append", (data) => {
        document.getElementById("calcStatus").textContent = "Done!";
        document.getElementById("calcResult").textContent = data.log
        let newTraj = structureShip.container[fileBrowser.selectedRowIndex].structures.length+ data.result.positions.length
        for (let i = 0; i < data.result.positions.length; i++) {
           let atoms = []
           data.result.position[i].forEach((pos, i) => {
                 atoms.push(new Atom({
                 position: pos,
                 element: structureData.elements,
                 }))
               });
           let structure = new Structure({
               elements:structureData.elements,
               uniqueElements: [...new Set(structureData.elements)],
               lattice:data.result.lattices[i],
               positions:data.result.positions[i],
               atoms: atoms,
               forces:new Forces({vectors: data.result.forces[i]}),
               stress:new Stress({tensor: convertStressEvA3ToGPa(data.result.stresses[i])}),
           })
           structureShip.container[fileBrowser.selectedRowIndex].structures.push(structure)
           console.log("added a structure")
           };
         console.log(structureShip)
         updateRow(fileBrowser.selectedRow,{ name: structureShip.container[fileBrowser.selectedRowIndex].fileName,traj:newTraj, step:newTraj })

    });

      socket.on("new", (data) => {
        document.getElementById("calcStatus").textContent = "Done!";
        document.getElementById("calcResult").textContent = data.log
        let newTraj =  data.result.positions.length
        let fileName = structureShip.container[fileBrowser.selectedRowIndex].fileName
        
        const container = new StructureContainer({fileName:fileName})
         
        for (let i = 0; i < data.result.positions.length; i++) {
           let structure = new Structure({
               elements:structureData.elements,
               uniqueElements: [...new Set(structureData.elements)],
               lattice:data.result.lattices[i],
               positions:data.result.positions[i],
               forces:new Forces({vectors: data.result.forces[i]}),
               stress:new Stress({tensor: convertStressEvA3ToGPa(data.result.stresses[i])}),
           })
           container.structures.push(structure);           
        };
        structureShip.container.push(container)
        console.log(structureShip)
        fileName="rx_"+fileName
        const row = createRow({ name: fileName, traj: container.structures.length, step: container.structures.length });
        document.querySelector("#objectTable tbody").appendChild(row);
        fileBrowser.fileData.push({ name: fileName, traj: container.structures.length, step: container.structures.length });
        selectLastAddedRow();
        
        // somehow re-init the filebrowser

    });

    socket.on("getEFS", (data) => {
        document.getElementById("calcStatus").textContent = data.log;
        let structure = new Structure({
            elements:structureData.elements,
            uniqueElements: [...new Set(structureData.elements)],
            lattice:data.result.lattice,
            positions:data.result.positions,
            forces:new Forces({vectors: data.result.forces}),
            stress:new Stress({tensor: convertStressEvA3ToGPa(data.result.stress)}),
        })
        const pressure = structure.stress.pressure;
        const tensor = structure.stress.tensor;
        displayPressureAndTensor(data.result.maxf, pressure, tensor, "calcOutput");
        console.log(structure)
    });

   socket.on("stressUpdate", (data) => {
     console.log( data.stress[2])
     let stress= new Stress({tensor: convertStressEvA3ToGPa(data.stress)})
     displayPressureAndTensor(data.maxf, stress.pressure, stress.tensor, "calcOutput")
     structureData.lattice= [...data.lattice];
     structureData.positions = [...data.positions];
     createBondLengthControls();
     createSpinControls();
     updateVisualization();
   });
}

function displayPressureAndTensor(maxf, pressure, tensor3x3, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = ""; // clear previous content

  // --- Build text content ---
  let text =  `Max Force: ${maxf.toFixed(5)} eV/Å\n`;
  text +=  `Pressure: ${pressure.toFixed(2)} GPa\n\n`;
  text += "Stress Tensor (GPa)\n\n";

  tensor3x3.forEach(row => {
    // join row numbers with tabs for easy copy/paste
    text += row.map(v => v.toFixed(2)).join("\t") + "\n";
  });

  // Display in a <pre> so formatting is preserved
  const pre = document.createElement("pre");
  pre.textContent = text;
  container.appendChild(pre);
}


function convertStressEvA3ToGPa(stressTensor) {
    const factor = 160.21766208; // eV/Å^3 → GPa
    return stressTensor.map(row => row.map(value => value * factor));
}

export function disconnectBackend() {
    if (!backendConnected || !socket) return;

    socket.disconnect();
    backendConnected = false;

    document.getElementById("backendStatus").textContent =
        "Backend: disconnected";

    document.getElementById("calcStatus").textContent = "";
}

function calculate(style="new") {
     
    if (!backendConnected) {
        document.getElementById("calcStatus").textContent =
            "Backend not connected!";
        return;
    }

   const inputPressure = document.getElementById("inputPressure");
   const pressure = Number(inputPressure.value);

   const inputMaxForce = document.getElementById("inputMaxForce");
   const maxForce = Number(inputMaxForce.value); 

   console.log(style,pressure,maxForce)

    document.getElementById("calcStatus").textContent =
        "Request sent to backend...";
    document.getElementById("calcResult").textContent = "";
    let press_eV=pressure/160.21766
    socket.emit("relaxStructure", { "positions": structureData.positions, "lattice":structureData.lattice, "elements":structureData.elements,"fmax":maxForce,"pressure":press_eV,"style":style });
}
