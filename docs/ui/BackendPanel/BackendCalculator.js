import { io } from "https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.esm.min.js";

import {fileBrowser} from '../../state/store.js'
let socket = null;
let backendConnected = false


export function addBackendCalcPanel() {
    const panel = document.getElementById("BackendCalcPanel");
    // Clear panel
    panel.innerHTML = "";

    panel.innerHTML = `
        <h2>Analyse Symmetry</h2>

        <button id="connectBtn">Connect Backend</button>
        <button id="disconnectBtn">Disconnect</button>
        <p id="backendStatus">Backend: not connected</p>

        <hr>

        <button class="calcButton" id="calcBtn">Get Spacegroup</button>

        <p id="calcStatus"></p>
        <p id="calcResult"></p>
    `;

    // Hook up buttons
    document.getElementById("connectBtn").onclick = connectBackend;
    document.getElementById("disconnectBtn").onclick = disconnectBackend;
    document.getElementById("calcBtn").onclick = calculate;
}

export function removeBackendCalcPanel() {
    const panel = document.getElementById("BackendCalcPanel");
    panel.innerHTML = `
        <h1>Choose Symmetry or AI mode for more advanced functionalities</h1>
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

    socket.on("result", (data) => {
        document.getElementById("calcStatus").textContent = "Done!";
        document.getElementById("calcResult").textContent = data.result;
    });
}

export function disconnectBackend() {
    if (!backendConnected || !socket) return;

    socket.disconnect();
    backendConnected = false;

    document.getElementById("backendStatus").textContent =
        "Backend: disconnected";

    document.getElementById("calcStatus").textContent = "";
    document.getElementById("calcResult").textContent = "";
}

function calculate() {

    if (!backendConnected) {
        document.getElementById("calcStatus").textContent =
            "Backend not connected!";
        return;
    }

    document.getElementById("calcStatus").textContent =
        "Request sent to backend...";
    document.getElementById("calcResult").textContent = "";
    let positions = fileBrowser.selectedStructure.atoms.map(a => a.position)
    let elements = [...fileBrowser.selectedStructure.elements];
    let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
    socket.emit("getSpacegroup", { "positions": positions, "lattice": lattice, "elements": elements });
}
