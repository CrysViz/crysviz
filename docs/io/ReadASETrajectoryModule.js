/**
 * ASE ULM (Universal Library Manager) Trajectory Parser
 *
 * ULM files consist of:
 * 1. A JSON header (metadata, data block descriptors)
 * 2. Raw binary data (positions, forces, cells, etc. as float64 arrays)
 *
 * THIS PARSER REQUIRES THE FILE TO BE READ AS ArrayBuffer, NOT TEXT.
 * The loader reads `.traj` files with FileReader.readAsArrayBuffer() and
 * dispatches the raw ArrayBuffer here via parse_any.
 */

import { Atom } from "../model/index.js";
import { Force } from "../model/index.js";
import { Stress } from "../model/index.js";
import { StructureContainer, TrajectoryContainer } from "../model/index.js";
import { Structure } from "../model/index.js";
import { generateID } from "../utils/index.js";

/**
 * Parses an ASE ULM trajectory file and returns a StructureContainer.
 * Row creation and insertion into the structureShip are handled by the caller
 * (the loader), mirroring the other refactored readers.
 * @param {ArrayBuffer} arrayBuffer - The file content as an ArrayBuffer (NOT TEXT!)
 * @param {string} fileName - The name of the file
 * @returns {StructureContainer}
 */
export function parseASETrajectory(arrayBuffer, fileName) {
  // Validate input
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new Error(
      "parseASETrajectory: Expected ArrayBuffer, got " + typeof arrayBuffer +
      ". The loader must read .traj files with FileReader.readAsArrayBuffer()."
    );
  }

  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length === 0) {
    throw new Error("parseASETrajectory: Empty file");
  }

  // --- Step 1: Extract JSON header ---
  // ULM JSON header starts at byte 0 and is a valid JSON object
  // We need to find the closing '}' of the outermost object
  let jsonEnd = 0;
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];

    // Handle string literals
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (c === 0x5C) { // Backslash
      escapeNext = true;
      continue;
    }
    if (c === 0x22) { // Double quote
      inString = !inString;
      continue;
    }

    // Only count braces outside of strings
    if (!inString) {
      if (c === 0x7B) braceCount++; // {
      if (c === 0x7D) braceCount--; // }

      // Found the end of the outermost JSON object
      if (braceCount === 0 && jsonEnd === 0 && i > 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  // If brace counting failed, try to find the first null byte or non-ASCII
  if (jsonEnd === 0) {
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0 || bytes[i] > 127) {
        jsonEnd = i;
        break;
      }
    }
  }

  if (jsonEnd === 0) {
    throw new Error("parseASETrajectory: Could not find JSON header end");
  }

  // Parse the JSON header
  let header;
  try {
    const jsonStr = new TextDecoder().decode(bytes.subarray(0, jsonEnd));
    header = JSON.parse(jsonStr);
  } catch (e) {
    // Debug: print first 500 bytes as text for inspection
    const debugStr = new TextDecoder().decode(bytes.subarray(0, Math.min(500, bytes.length)));
    console.log("First 500 bytes:", debugStr);
    throw new Error("parseASETrajectory: Failed to parse JSON header: " + e.message);
  }

  // --- Step 2: Validate ULM header structure ---
  if (!header.descriptor || !Array.isArray(header.descriptor)) {
    throw new Error(
      "parseASETrajectory: Invalid ULM header - missing 'descriptor' array"
    );
  }

  // --- Step 3: Extract metadata and frame info ---
  const metadata = header.metadata || {};
  const descriptor = header.descriptor;

  // Find the positions block to get numFrames and numAtoms
  let numFrames = 0;
  let numAtoms = 0;
  for (const block of descriptor) {
    if (block.name === "positions" && block.shape) {
      numFrames = block.shape[0];
      numAtoms = block.shape[1];
      break;
    }
  }

  if (numFrames === 0 || numAtoms === 0) {
    throw new Error(
      "parseASETrajectory: Could not determine numFrames or numAtoms from descriptor"
    );
  }

  // --- Step 4: Prepare binary data access ---
  const dv = new DataView(arrayBuffer);
  const structures = [];

  // Helper: Get byte offset for a specific frame in a block
  function getFrameOffset(blockName, frameIndex) {
    for (const block of descriptor) {
      if (block.name === blockName) {
        const itemsize = block.itemsize || 8; // Default to float64 (8 bytes)
        const shape = block.shape || [];
        const [, ...rest] = shape;
        const elementsPerFrame = rest.reduce((a, b) => a * b, 1);
        return block.offset + frameIndex * elementsPerFrame * itemsize;
      }
    }
    return null;
  }

  // Helper: Read float64 array for a specific frame
  function readFrameFloat64(blockName, frameIndex, expectedLength) {
    const offset = getFrameOffset(blockName, frameIndex);
    if (offset === null) return null;

    const result = [];
    for (let i = 0; i < expectedLength; i++) {
      result.push(dv.getFloat64(offset + i * 8, true)); // little-endian
    }
    return result;
  }

  // --- Step 5: Parse each frame ---
  for (let frameIndex = 0; frameIndex < numFrames; frameIndex++) {
    // Read cell (3x3)
    let lattice = null;
    const cellFlat = readFrameFloat64("cells", frameIndex, 9);
    if (cellFlat && cellFlat.length === 9) {
      lattice = [
        cellFlat.slice(0, 3),
        cellFlat.slice(3, 6),
        cellFlat.slice(6, 9)
      ];
    }

    // Read positions (numAtoms x 3)
    const positionsFlat = readFrameFloat64("positions", frameIndex, numAtoms * 3);
    const positions = [];
    if (positionsFlat && positionsFlat.length === numAtoms * 3) {
      for (let i = 0; i < numAtoms; i++) {
        positions.push(positionsFlat.slice(i * 3, (i + 1) * 3));
      }
    }

    // Read forces (numAtoms x 3)
    const forcesFlat = readFrameFloat64("forces", frameIndex, numAtoms * 3);
    const forces = [];
    if (forcesFlat && forcesFlat.length === numAtoms * 3) {
      for (let i = 0; i < numAtoms; i++) {
        forces.push(forcesFlat.slice(i * 3, (i + 1) * 3));
      }
    }

    // Read stress (Voigt notation: 6 components)
    let stressTensor = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const stressFlat = readFrameFloat64("stress", frameIndex, 6);
    if (stressFlat && stressFlat.length === 6) {
      // Voigt: [sxx, syy, szz, syz, sxz, sxy]
      stressTensor = [
        [stressFlat[0], stressFlat[5], stressFlat[4]],
        [stressFlat[5], stressFlat[1], stressFlat[3]],
        [stressFlat[4], stressFlat[3], stressFlat[2]]
      ];
    }

    // Read element symbols or numbers
    let elements = Array(numAtoms).fill("X");
    const numbers = readFrameFloat64("numbers", frameIndex, numAtoms);
    if (numbers) {
      // Map atomic numbers to symbols (first 20 elements)
      const atomicSymbols = [
        "X", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
        "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca"
      ];
      elements = numbers.map(n => atomicSymbols[Math.round(n)] || "X");
    }
    if (metadata.symbols) {
      elements = metadata.symbols;
    }

    // --- Create Structure ---
    const atoms = positions.map((p, i) =>
      new Atom({
        position: p,
        element: elements[i] || "X",
        uuid: generateID([elements[i], i, frameIndex])
      })
    );

    const forceObjects = forces.map(f =>
      new Force({ vector: f, scaling: 1.0 })
    );

    const stress = new Stress({ tensor: stressTensor });

    structures.push(
      new Structure({
        elements,
        uniqueElements: [...new Set(elements)],
        lattice,
        forces: forceObjects,
        stress,
        atoms,
        spins: [],
      })
    );
  }

  // Return a container; the loader registers it in the UI/store. Multi-frame
  // trajectories become store-backed (physics packed per frame, one live
  // Structure for rendering); single frames stay eager.
  return structures.length > 1
    ? TrajectoryContainer.fromStructures(fileName, structures)
    : new StructureContainer({ fileName, structures });
}
