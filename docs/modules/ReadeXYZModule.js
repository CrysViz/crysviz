/**
 * Unified XYZ/extxyz parser/writer module
 * Auto-detects file format, provides default lattice, and integrates with StructureContainer
 */

import { generateID } from './UUIDModule.js';
import { StructureContainer } from "../classes/StructureContainer.js";
import { Structure } from "../classes/Structure.js";
import { Atom } from "../classes/Atom.js";
import { Force } from "../classes/Force.js";
import { Spin } from "../classes/Spin.js";
import { structureShip, fileBrowser } from '../store.js';
import { createRow, selectLastAddedRow } from '../panels/FileBrowswerPanel.js';
import { transpose3x3, multiplyMatVec, invert3x3 } from '../math/backend-js.js';


/**
 * Auto-detects if the content is extended XYZ (extxyz) or standard XYZ
 * @param {string} content - File content
 * @returns {boolean} True if extxyz, false if standard XYZ
 */
function isExtXYZ(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return false;
  const secondLine = lines[1];
  return secondLine.includes('Lattice=') || secondLine.includes('Properties=');
}

/**
 * Calculate the center of mass of a set of atoms
 * @param {Array} atoms - Array of atom objects with Cartesian positions
 * @returns {Array} [centerX, centerY, centerZ]
 */
function calculateCenterOfMass(atoms) {
  let sumX = 0, sumY = 0, sumZ = 0;
  atoms.forEach(atom => {
    sumX += atom.position[0];
    sumY += atom.position[1];
    sumZ += atom.position[2];
  });
  return [
    sumX / atoms.length,
    sumY / atoms.length,
    sumZ / atoms.length
  ];
}

/**
 * Find the maximum coordinate magnitude in a set of atoms
 * @param {Array} atoms - Array of atom objects with Cartesian positions
 * @returns {number} Maximum coordinate magnitude
 */
function findMaxCoordinateMagnitude(atoms) {
  let maxMag = 0;
  atoms.forEach(atom => {
    const [x, y, z] = atom.position;
    maxMag = Math.max(maxMag, Math.abs(x), Math.abs(y), Math.abs(z));
  });
  return maxMag;
}

/**
 * Generate a large enough orthorhombic box to contain the structure
 * @param {number} maxMag - Maximum coordinate magnitude
 * @returns {Array} 3x3 lattice vectors
 */
function generateBox(maxMag) {
  const size = 2 * (maxMag + 2); // Double the max magnitude + buffer
  return [
    [size, 0, 0],
    [0, size, 0],
    [0, 0, size]
  ];
}

/**
 * Move the center of mass to the center of the box
 * @param {Array} atoms - Array of atom objects with Cartesian positions
 * @param {Array} com - Center of mass [x, y, z]
 * @param {Array} box - Box lattice vectors
 * @returns {Array} Shifted Cartesian coordinates
 */
function moveCOMToBoxCenter(atoms, com, box) {
  const centerX = box[0][0] / 2;
  const centerY = box[1][1] / 2;
  const centerZ = box[2][2] / 2;
  return atoms.map(atom => {
    const [x, y, z] = atom.position;
    return [
      x - com[0] + centerX,
      y - com[1] + centerY,
      z - com[2] + centerZ
    ];
  });
}

/**
 * Convert Cartesian to fractional coordinates
 * @param {Array} cart - Cartesian coordinates
 * @param {Array} lattice - Lattice vectors
 * @returns {Array} Fractional coordinates
 */
function convertCartesianToFractional(cart, lattice) {
  const LT = transpose3x3(lattice);
  const inv = invert3x3(LT, 1e-14);
  return cart.map(v => multiplyMatVec(inv, v).map(x => ((x % 1) + 1) % 1));
}

/**
 * Verify all fractional coordinates are within [0, 1]
 * @param {Array} frac - Fractional coordinates
 * @param {Array} lattice - Lattice vectors
 * @returns {boolean} True if all atoms are inside the box
 */
function verifyAllAtomsInside(frac, lattice) {
  return frac.every(coord => {
    return coord.every(c => c >= 0 && c <= 1);
  });
}

/**
 * Parse XYZ/extxyz file (auto-detects format)
 * @param {string} content - File content
 * @returns {Object} {frames, isExtended}
 */
function parseXYZContent(content) {
  const lines = content.split(/\r?\n/);
  const frames = [];
  let i = 0;
  const isExtended = isExtXYZ(content);

  while (i < lines.length) {
    const natoms = parseInt(lines[i], 10);
    if (isNaN(natoms) || natoms <= 0) break;
    const comment = lines[i + 1] || '';
    const frame = { comment, atoms: [], forces: [], lattice: null };

    // Parse lattice if extxyz
    if (isExtended) {
      const latticeMatch = comment.match(/Lattice="([^"]+)"/);
      if (latticeMatch) {
        const latticeVals = latticeMatch[1].split(/\s+/).map(parseFloat);
        frame.lattice = [
          latticeVals.slice(0, 3),
          latticeVals.slice(3, 6),
          latticeVals.slice(6, 9)
        ];
      }
    }

    // Parse atoms and forces
    for (let j = 0; j < natoms; j++) {
      const parts = lines[i + 2 + j].trim().split(/\s+/);
      const atom = { element: parts[0] };
      atom.position = [
        parseFloat(parts[1]),
        parseFloat(parts[2]),
        parseFloat(parts[3])
      ];
      frame.atoms.push(atom);

      // Parse forces if present
      if (parts.length >= 7) {
        frame.forces.push([
          parseFloat(parts[4]),
          parseFloat(parts[5]),
          parseFloat(parts[6])
        ]);
      } else {
        frame.forces.push([0, 0, 0]);
      }
    }

    // If no lattice, center and box
    if (!frame.lattice) {
      const com = calculateCenterOfMass(frame.atoms);
      const maxMag = findMaxCoordinateMagnitude(frame.atoms);
      const box = generateBox(maxMag);
      const shiftedPositions = moveCOMToBoxCenter(frame.atoms, com, box);
      frame.atoms.forEach((atom, idx) => {
        atom.position = shiftedPositions[idx];
      });
      frame.lattice = box;
      // Double-check fractional coordinates
      const frac = convertCartesianToFractional(
        frame.atoms.map(a => a.position),
        frame.lattice
      );
      if (!verifyAllAtomsInside(frac, frame.lattice)) {
        console.warn("Some atoms are outside the box, increasing box size...");
        // If any atom is outside, double the box size
        const newBox = generateBox(maxMag * 2);
        frame.lattice = newBox;
      }
    }

    frames.push(frame);
    i += 2 + natoms;
  }
  return { frames, isExtended };
}

/**
 * Show progress bar
 */
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

/**
 * Update progress bar
 * @param {number} progress - Progress percentage
 */
function updateProgressBar(progress) {
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  if (progressBar && progressText) {
    progressBar.style.width = `${progress}%`;
    progressText.textContent = `${Math.round(progress)}% complete`;
  }
}

/**
 * Hide progress bar
 */
function hideProgressBar() {
  const progressPanel = document.getElementById("progressPanel");
  if (progressPanel) {
    progressPanel.remove();
  }
}

/**
 * Main exported function for parsing XYZ/extxyz files and integrating with StructureContainer
 * @param {string} content - File content
 * @param {string} fileName - File name
 * @returns {Promise} Promise resolving to parsed Structure objects
 */
export function parseXYZFile(content, fileName) {
  return new Promise((resolve, reject) => {
    if (!content || typeof content !== "string") {
      reject(new Error("Content must be a non-empty string"));
      return;
    }

    // Estimate frames for progress reporting
    const lines = content.split(/\r?\n/);
    let frameCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const natoms = parseInt(lines[i], 10);
      if (!isNaN(natoms) && natoms > 0) frameCount++;
    }

    if (frameCount > 100) {
      showProgressBar();
    }

    // Use Web Worker for large files
    const worker = new Worker(URL.createObjectURL(new Blob([`
      ${isExtXYZ.toString()}
      ${calculateCenterOfMass.toString()}
      ${findMaxCoordinateMagnitude.toString()}
      ${generateBox.toString()}
      ${moveCOMToBoxCenter.toString()}
      ${convertCartesianToFractional.toString()}
      ${verifyAllAtomsInside.toString()}
      ${parseXYZContent.toString()}
      ${generateID.toString()}
      ${transpose3x3.toString()}
      ${multiplyMatVec.toString()}
      ${invert3x3.toString()}

      self.onmessage = function(event) {
        const { content } = event.data;
        try {
          const result = parseXYZContent(content);
          self.postMessage({ type: 'complete', ...result });
        } catch (error) {
          self.postMessage({ type: 'error', error: error.message });
        }
      };
    `], { type: 'application/javascript' })));

    worker.onmessage = (event) => {
      if (event.data.type === 'complete') {
        const { frames } = event.data;

        // Build Structure objects
        const structureObjects = frames.map(frame => {
          const elements = frame.atoms.map(atom => atom.element);
          const uniqueElements = [...new Set(elements)];

          // Convert Cartesian to fractional coordinates
          const fracPositions = convertCartesianToFractional(
            frame.atoms.map(a => a.position),
            frame.lattice
          );

          const atoms = frame.atoms.map((atomData, idx) =>
            new Atom({
              element: atomData.element,
              position: fracPositions[idx],
              uuid: generateID([atomData.element])
            })
          );
          const forces = frame.forces.map(forceData =>
            new Force({ vector: forceData, scaling: 1.0 })
          );
          const spins = frame.atoms.map(() =>
            new Spin({ vector: [0, 0, 0], scaling: 1.0 })
          );

          return new Structure({
            elements,
            uniqueElements,
            lattice: frame.lattice,
            atoms,
            spins,
            forces,
          });
        });

        // Update UI and store
        const traj = structureObjects.length;
        const step = traj;
        const tableBody = document.querySelector("#objectTable tbody");
        const row = createRow({ name: fileName, traj, step });
        tableBody.appendChild(row);
        fileBrowser.fileData.push({ idx: -1, name: fileName, traj, step });

        const container = new StructureContainer({ fileName, structures: structureObjects });
        structureShip.container.push(container);
        selectLastAddedRow();

        hideProgressBar();
        resolve(structureObjects);
      } else if (event.data.type === 'error') {
        hideProgressBar();
        reject(new Error(event.data.error));
      }
    };

    worker.onerror = (error) => {
      hideProgressBar();
      reject(error);
    };

    worker.postMessage({ content });
  });
}
