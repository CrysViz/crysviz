import { StructureContainer } from "../model/index.js";
import { Structure } from "../model/index.js";
import { Spin } from "../model/index.js";
import { Atom } from "../model/index.js";
import { Force } from "../model/index.js";
import { Stress } from "../model/index.js";
import {generateID} from '../utils/index.js'
// From the concrete JS backend, not the math/index.js facade: the facade's
// exports are thin wrappers delegating to a module-scope `activeMathBackend`
// variable at call time (so a WASM backend can be swapped in later), but
// stringifying a wrapper via .toString() into the worker below carries none
// of that surrounding module state with it — the worker throws
// "activeMathBackend is not defined" the moment it's actually called. These
// backend-js.js implementations are plain, self-contained functions with no
// such dependency, so they survive being stringified.
import {
  transpose3x3,
  multiplyMatVec,
  invert3x3,
} from '../math/backend-js.js';
// Main-thread only (NOT stringified into the worker): rotate the SAXIS-frame
// moments the worker returns into global Cartesian.
import { saxisToMatrix, parseSaxis } from '../utils/spinFrame.js';

// VASP reports the on-site magnetisation (magnetization (x)/(y)/(z) blocks) in
// the frame whose z-axis is SAXIS, not the global Cartesian frame. Read the
// SAXIS the run used from the INCAR echo near the top of the OUTCAR; absent
// (the common case) it defaults to (0,0,1) and the rotation is the identity.
function findSaxis(lines) {
  for (const line of lines) {
    const m = line.match(/\bSAXIS\b\s*=\s*(.+)$/i);
    if (m) {
      const s = parseSaxis(m[1]);
      if (s) return s;
    }
  }
  return [0, 0, 1];
}

// Function to show progress bar
function showProgressBar() {
  const progressPanel = document.createElement("div");
  progressPanel.id = "progressPanel";
  progressPanel.style.display = "block";
  progressPanel.style.position = "fixed";
  progressPanel.style.top = "50%";
  progressPanel.style.left = "50%";
  progressPanel.style.transform = "translate(-50%, -50%)";
  progressPanel.style.background = "rgba(0, 0, 0, 0.8)";
  progressPanel.style.color = "white";
  progressPanel.style.padding = "20px";
  progressPanel.style.borderRadius = "5px";
  progressPanel.style.zIndex = "9999";
  progressPanel.style.textAlign = "center";

  const heading = document.createElement("h3");
  heading.textContent = "Loading Large File";
  progressPanel.appendChild(heading);

  const progressBarContainer = document.createElement("div");
  progressBarContainer.style.width = "300px";
  progressBarContainer.style.height = "20px";
  progressBarContainer.style.background = "#333";
  progressBarContainer.style.borderRadius = "5px";
  progressBarContainer.style.margin = "10px auto";
  progressBarContainer.style.overflow = "hidden";

  const progressBar = document.createElement("div");
  progressBar.id = "progressBar";
  progressBar.style.width = "0%";
  progressBar.style.height = "100%";
  progressBar.style.background = "#4CAF50";
  progressBar.style.transition = "width 0.3s";
  progressBarContainer.appendChild(progressBar);

  const progressText = document.createElement("p");
  progressText.id = "progressText";
  progressText.textContent = "0% complete";
  progressPanel.appendChild(progressBarContainer);
  progressPanel.appendChild(progressText);

  document.body.appendChild(progressPanel);
}

// Function to update progress bar
function updateProgressBar(progress) {
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  if (progressBar && progressText) {
    progressBar.style.width = `${progress}%`;
    progressText.textContent = `${Math.round(progress)}% complete`;
  }
}

// Function to hide progress bar
function hideProgressBar() {
  const progressPanel = document.getElementById("progressPanel");
  if (progressPanel) {
    progressPanel.remove();
  }
}

// Main exported function
export function parseOUTCAR(content, fileName) {
  return new Promise((resolve, reject) => {
    if (!content || typeof content !== "string") {
      reject(new Error("OUTCAR: content must be a non-empty string"));
      return;
    }

    // Count the number of POSITION blocks to estimate steps
    const lines = content.split(/\r?\n/);
    // SAXIS the run used (default (0,0,1)) and the matching global<-SAXIS
    // rotation, applied to each spin's raw moments once the worker returns.
    const saxis = findSaxis(lines);
    const saxisMatrix = saxisToMatrix(saxis);
    let positionBlocks = 0;
    for (const line of lines) {
      if (/^\s*POSITION\s+TOTAL-FORCE/i.test(line)) {
        positionBlocks++;
      }
    }

    // Show progress bar if more than 100 steps are expected
    if (positionBlocks > 100) {
      showProgressBar();
    }

    // Create a Web Worker
    const worker = new Worker(URL.createObjectURL(new Blob([`
      ${findLastIonsPerType.toString()}
      ${findUniqueElements.toString()}
      ${expandElements.toString()}
      ${parseFloats.toString()}
      ${readPositionsForcesBlock.toString()}
      ${readSpinComponent.toString()}
      ${convertCartesianToFractional.toString()}
      ${transpose3x3.toString()}
      ${multiplyMatVec.toString()}
      ${invert3x3.toString()}

      self.onmessage = function(event) {
        const { content, fileName } = event.data;
        const lines = content.split(/\\r?\\n/);

        // Find ions per type
        const ionsPerType = findLastIonsPerType(lines);
        const uniqueElements = findUniqueElements(lines);
        const elements = expandElements(uniqueElements, ionsPerType);
        const natoms = elements.length;

        // Count the number of POSITION blocks to estimate steps
        let positionBlocks = 0;
        for (const line of lines) {
          if (/^\\s*POSITION\\s+TOTAL-FORCE/i.test(line)) {
            positionBlocks++;
          }
        }

        const steps = [];
        let currentLattice = null;
        let currentPositions = [];
        let currentForces = [];
        let currentSpins = new Array(natoms).fill([0, 0, 0]);
        let spinX = null, spinY = null, spinZ = null;
        let currentEnergy = null;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          if (/^\\s*direct\\s+lattice\\s+vectors/i.test(line)) {
            currentLattice = [
              parseFloats(lines[i + 1]),
              parseFloats(lines[i + 2]),
              parseFloats(lines[i + 3]),
            ].map(v => v.slice(0, 3));
          }

          if (/^\\s*POSITION/i.test(line) && (i + 2 < lines.length)) {
            const nextLine = lines[i + 2];
            if (parseFloats(nextLine).length >= 6) {
              const { positions, forces } = readPositionsForcesBlock(lines, i, natoms);
              currentPositions = positions;
              currentForces = forces;

              if (currentLattice && currentPositions.length === natoms) {
                // These moments are in VASP's SAXIS-local frame; the main
                // thread rotates them into global Cartesian afterwards.
                if (spinX && spinY && spinZ) {
                  // Non-collinear: full (mx,my,mz) in the SAXIS frame.
                  currentSpins = spinX.map((_, idx) => [spinX[idx], spinY[idx], spinZ[idx]]);
                } else if (spinX) {
                  // Collinear (ISPIN=2): a single scalar moment per atom that
                  // lies along the spin-quantisation axis, i.e. SAXIS. In the
                  // SAXIS-local frame that axis IS z, so place it on z (not x);
                  // the main-thread SAXIS rotation then points it correctly in
                  // global Cartesian. (The old code put it on x, drawing every
                  // collinear moment 90 degrees off along global +x.)
                  currentSpins = spinX.map(m => [0, 0, m]);
                } else {
                  currentSpins = new Array(natoms).fill([0, 0, 0]);
                }

                steps.push({
                  lattice: currentLattice,
                  positions: currentPositions,
                  forces: currentForces,
                  spins: currentSpins,
                  energy: null,
                  stress: null,
                });

                // Reset per-step so the NEXT ionic step only picks up the
                // magnetization block(s) printed within its own window. VASP
                // may print several magnetization blocks per step (e.g. high
                // NWRITE) -- those all precede this POSITION line, so spinX/Y/Z
                // already hold the last (converged) one. But a later step that
                // prints no block of its own must not silently inherit this
                // step's moments, which is what happened without this reset.
                spinX = null; spinY = null; spinZ = null;

                // Update progress
                const progress = (i / lines.length) * 100;
                self.postMessage({ type: 'progress', progress });
              }
            }
          }

          if (/^\\s*magnetization\\s*\\(x\\)/i.test(line)) {
            spinX = readSpinComponent(lines, i, natoms, /^\\s*magnetization\\s*\\(x\\)/i);
          }
          if (/^\\s*magnetization\\s*\\(y\\)/i.test(line)) {
            spinY = readSpinComponent(lines, i, natoms, /^\\s*magnetization\\s*\\(y\\)/i);
          }
          if (/^\\s*magnetization\\s*\\(z\\)/i.test(line)) {
            spinZ = readSpinComponent(lines, i, natoms, /^\\s*magnetization\\s*\\(z\\)/i);
          }

          // Energy lines print AFTER the POSITION/TOTAL-FORCE block for the
          // same ionic step, so by the time we see them the step is already
          // pushed onto steps above -- attach to the most-recently pushed
          // step (steps[steps.length - 1]) rather than the next one.
          // TOTEN is the fallback; energy(sigma->0) is preferred and, since
          // it prints after TOTEN for the same step, overwrites it below.
          const totenMatch = line.match(/free\\s+energy\\s+TOTEN\\s*=\\s*(-?\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)/i);
          if (totenMatch && steps.length > 0) {
            currentEnergy = parseFloat(totenMatch[1]);
            steps[steps.length - 1].energy = currentEnergy;
          }
          const sigmaMatch = line.match(/energy\\(sigma->0\\)\\s*=\\s*(-?\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)/i);
          if (sigmaMatch && steps.length > 0) {
            currentEnergy = parseFloat(sigmaMatch[1]);
            steps[steps.length - 1].energy = currentEnergy;
          }

          // Stress: the "in kB" line gives the Voigt stress (XX YY ZZ XY YZ ZX)
          // and prints after the POSITION block for the step, so attach it to the
          // most-recently pushed step. Build a symmetric 3x3 tensor.
          const kbMatch = line.match(/^\\s*in kB\\s+(.*)$/i);
          if (kbMatch && steps.length > 0) {
            const sv = parseFloats(kbMatch[1]);
            if (sv.length >= 6) {
              const xx = sv[0], yy = sv[1], zz = sv[2], xy = sv[3], yz = sv[4], zx = sv[5];
              steps[steps.length - 1].stress = [[xx, xy, zx], [xy, yy, yz], [zx, yz, zz]];
            }
          }
        }

        // Build structures
        const structures = steps.map(step => {
          const frac = convertCartesianToFractional(step.positions, step.lattice);
          const atoms = frac.map((pos, i) => ({ position: pos, element: elements[i] }));
          // rawVector is in the SAXIS-local frame; the main thread rotates it
          // into the rendered global-Cartesian vector below.
          const spins = step.spins.map(rawVector => ({ rawVector, scaling: 1.0, color:"#008080" }));
          const forces = step.forces.map(vector => ({ vector, scaling: 1.0 }));

          return {
            elements,
            uniqueElements,
            lattice: step.lattice,
            atoms,
            spins,
            forces,
            energy: step.energy,
            stress: step.stress,
          };
        });

        // Send results back to the main thread
        self.postMessage({ type: 'complete', structures, fileName });
      };
    `], { type: 'application/javascript' })));

    // Send data to the worker
    worker.postMessage({ content, fileName });

    // Handle messages from the worker
    worker.onmessage = (event) => {
      if (event.data.type === 'progress') {
        updateProgressBar(event.data.progress);
      } else if (event.data.type === 'complete') {
        const { structures, fileName } = event.data;

        // Build Structure objects
        const structureObjects = structures.map(structureData => {
          const atoms = structureData.atoms.map(atomData => new Atom({...atomData, uuid: generateID([atomData.element])}));
          // Rotate each spin's SAXIS-frame raw moments into global Cartesian
          // for the rendered vector; keep the raw components on the Spin so the
          // Spins panel can re-project to another frame later.
          const spins = structureData.spins.map(spinData => new Spin({
            ...spinData,
            vector: multiplyMatVec(saxisMatrix, spinData.rawVector),
          }));
          const forces = structureData.forces.map(forceData => new Force(forceData));

          return new Structure({
            elements: structureData.elements,
            uniqueElements: structureData.uniqueElements,
            lattice: structureData.lattice,
            atoms,
            spins,
            spinFrame: { fileSaxis: saxis },
            forces,
            energy: structureData.energy,
            stress: structureData.stress ? new Stress({ tensor: structureData.stress }) : null,
          });
        });

        const container = new StructureContainer({ fileName, structures: structureObjects });

        // Hide progress bar once parsing is complete
        hideProgressBar();
        resolve(container);
      }
    };

    worker.onerror = (error) => {
      console.error("Worker error:", error);
      hideProgressBar();
      reject(error);
    };
  });
}

function findLastIonsPerType(lines) {
  const re = /ions\s+per\s+type\s*=\s*(.+)$/i;
  let out = [];
  for (const line of lines) {
    const m = line.match(re);
    if (m) out = m[1].trim().split(/\s+/).map(Number);
  }
  return out;
}

function findUniqueElements(lines) {
  const out = [];
  const re = /POTCAR:\s+[A-Za-z0-9_]+\s+([A-Za-z]{1,2})\s*.*/i;
  for (const line of lines) {
    const m = line.match(re);
    if (m && m[1] && !out.includes(m[1])) {
      console.log(m)
      out.push(m[1]);
    }
  }
  console.log(out)
  return out;
}

function expandElements(els, counts) {
  const out = [];
  for (let i = 0; i < els.length; i++) {
    for (let k = 0; k < counts[i]; k++) out.push(els[i]);
  }
  return out;
}

function parseFloats(line) {
  return line.trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
}

function readPositionsForcesBlock(lines, idx, natoms) {
  const positions = [];
  const forces = [];
  let i = idx + 2;
  for (let n = 0; n < natoms; n++, i++) {
    const toks = parseFloats(lines[i]);
    if (toks.length < 6) break;
    const x = toks[0], y = toks[1], z = toks[2];
    const fx = toks[3], fy = toks[4], fz = toks[5];
    positions.push([x, y, z]);
    forces.push([fx, fy, fz]);
  }
  return { positions, forces };
}

function readSpinComponent(lines, startIdx, natoms, regex) {
  const out = new Array(natoms).fill(0);
  let i = startIdx + 2;
  let count = 0;
  while (i < lines.length && count < natoms) {
    const line = lines[i];
    if (/^\s*tot/i.test(line) || /^\s*$/i.test(line) || /^\s*magnetization/i.test(line)) break;
    const toks = parseFloats(line);
    const idxAtom = toks[0] - 1;
    const value = toks[toks.length - 1];
    if (idxAtom >= 0 && idxAtom < natoms) {
      out[idxAtom] = value;
      count++;
    }
    i++;
  }
  return out;
}

function convertCartesianToFractional(cart, lattice) {
  const LT = transpose3x3(lattice);
  const inv = invert3x3(LT, 1e-14);
  return cart.map(v => multiplyMatVec(inv, v).map(x => ((x % 1) + 1) % 1));
}
