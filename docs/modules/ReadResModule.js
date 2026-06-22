/**
 * Parser for Res files (supports multiple structures per file)
 * Parses title, cell, lattice, and atomic positions in fractional coordinates
 * Assumes CELL line order: wavelength a b c α β γ
 * Uses SFAC# to map atom types
 */

import { generateID } from './UUIDModule.js';
import { StructureContainer } from "../classes/StructureContainer.js";
import { Structure } from "../classes/Structure.js";
import { Atom } from "../classes/Atom.js";
import { Force } from "../classes/Force.js";
import { Spin } from "../classes/Spin.js";
import { structureShip, fileBrowser } from '../store.js';
import { createRow, selectLastAddedRow } from '../panels/FileBrowswerPanel.js';

const tableBody = document.querySelector("#objectTable tbody");

/**
 * Wrap fractional coordinate into [0, 1) range
 */
function wrapFractional(coord) {
  return ((coord % 1) + 1) % 1;
}


/**
 * Parse Res file content (supports multiple structures per file)
 * @param {string} content - File content
 * @returns {Array} Array of parsed structure data
 */
function parseResContent(content) {
  const lines = content.split(/\r?\n/);
  const results = [];
  let currentResult = {
    title: null,
    cell: null,
    lattice: null,
    atoms: [],
    metadata: {},
    species: []
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // If we encounter a new TITL line and have atoms, finalize current structure
    if (trimmed.startsWith('TITL') && currentResult.atoms.length > 0) {
      results.push({...currentResult}); // Push a copy
      currentResult = {
        title: null,
        cell: null,
        lattice: null,
        atoms: [],
        metadata: {},
        species: []
      };
    }

    // Parse TITL line
    if (trimmed.startsWith('TITL')) {
      const parts = trimmed.split(/\s+/).slice(1);
      currentResult.metadata = {
        name: parts[0],
        pressure: parseFloat(parts[1]),
        volume: parseFloat(parts[2]),
        enthalpy: parseFloat(parts[3]),
        spin: parseInt(parts[4], 10),
        modspin: parseInt(parts[5], 10),
        numIons: parseInt(parts[6], 10),
        symmetry: parts[7]?.replace(/[()]/g, '') || '',
        numCopies: parseInt(parts[9], 10)
      };
      currentResult.title = parts[0];
      continue;
    }

    // Parse CELL line: wavelength a b c α β γ
    if (trimmed.startsWith('CELL')) {
      const values = trimmed.split(/\s+/).slice(1).map(parseFloat);
      if (values.length >= 7) {
        const a = values[1];
        const b = values[2];
        const c = values[3];
        const alpha = values[4];
        const beta = values[5];
        const gamma = values[6];
        currentResult.cell = { a, b, c, alpha, beta, gamma };
        currentResult.lattice = cellParamsToLattice(currentResult.cell);
      }
      continue;
    }

    // Parse SFAC line
    if (trimmed.startsWith('SFAC')) {
      currentResult.species = trimmed.split(/\s+/).slice(1);
      continue;
    }

    // Skip REM lines
    if (trimmed.startsWith('REM')) continue;

    // END line: finalize current structure
    if (trimmed === 'END') {
      if (currentResult.atoms.length > 0) {
        results.push({...currentResult}); // Push a copy
        currentResult = {
          title: null,
          cell: null,
          lattice: null,
          atoms: [],
          metadata: {},
          species: []
        };
      }
      continue;
    }

    // Parse atom lines: AtomName SFAC# x y z [U_iso...]
    if (trimmed.match(/^[A-Za-z0-9]+\s+\d+/)) {
      const parts = trimmed.split(/\s+/).filter(p => p !== '');
      const atomName = parts[0];
      const sfacIndex = parseInt(parts[1], 10) - 1; // Convert to 0-indexed
      let x = parseFloat(parts[2]);
      let y = parseFloat(parts[3]);
      let z = parseFloat(parts[4]);

      // Wrap fractional coordinates into [0, 1) range
      x = ((x % 1) + 1) % 1;
      y = ((y % 1) + 1) % 1;
      z = ((z % 1) + 1) % 1;

      // Use SFAC# to get the element from the SFAC list
      const element = currentResult.species && sfacIndex >= 0 && sfacIndex < currentResult.species.length
        ? currentResult.species[sfacIndex]
        : atomName;

      currentResult.atoms.push({
        element,
        speciesIndex: sfacIndex + 1,
        position: [x, y, z],
        occupancy: parts.length > 5 ? parseFloat(parts[5]) : 1.0
      });
    }
  }

  // Push the last structure if it exists
  if (currentResult.atoms.length > 0) {
    results.push({...currentResult});
  }

  return results;
}

/**
 * Main exported function for parsing Res files (supports multiple structures)
 * @param {string} content - File content
 * @param {string} fileName - File name
 * @returns {Promise} Promise resolving to array of Structure objects
 */
export function parseResFile(content, fileName) {
  return new Promise((resolve, reject) => {
    if (!content || typeof content !== "string") {
      reject(new Error("Content must be a non-empty string"));
      return;
    }

    try {
      const parsedStructures = parseResContent(content);

      // If no structures found, reject
      if (parsedStructures.length === 0) {
        reject(new Error("No valid structures found in file"));
        return;
      }

      const structureObjects = parsedStructures.map((parsed, idx) => {
        const { atoms, lattice, metadata } = parsed;

        const atomObjects = atoms.map((atom, atomIdx) =>
          new Atom({
            element: atom.element,
            position: atom.position, // Fractional coordinates, wrapped to [0, 1)
            uuid: generateID([atom.element, atomIdx, idx])
          })
        );

        const forces = atoms.map(() => new Force({ vector: [0, 0, 0], scaling: 1.0 }));
        const spins = atoms.map(() => new Spin({ vector: [0, 0, 0], scaling: 1.0 }));

        const elements = atoms.map(a => a.element);
        const uniqueElements = [...new Set(elements)];

        return new Structure({
          elements,
          uniqueElements,
          lattice,
          atoms: atomObjects,
          spins,
          forces,
          metadata
        });
      });

      // Create a SINGLE row for the file, with traj = number of structures
      const traj = structureObjects.length;
      const step = traj;
      const row = createRow({ name: fileName, traj, step });
      if (tableBody) tableBody.appendChild(row);
      fileBrowser.fileData.push({ idx: -1, name: fileName, traj, step });

      const container = new StructureContainer({ fileName, structures: structureObjects });
      structureShip.container.push(container);
      selectLastAddedRow();

      resolve(structureObjects);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Convert cell parameters (a, b, c, α, β, γ) to lattice vectors
 * @param {Object} cell - {a, b, c, alpha, beta, gamma}
 * @returns {Array} 3x3 lattice vectors
 */
function cellParamsToLattice(cell) {
  const { a, b, c, alpha, beta, gamma } = cell;
  const alphaRad = alpha * Math.PI / 180;
  const betaRad = beta * Math.PI / 180;
  const gammaRad = gamma * Math.PI / 180;

  const cosAlpha = Math.cos(alphaRad);
  const cosBeta = Math.cos(betaRad);
  const cosGamma = Math.cos(gammaRad);
  const sinGamma = Math.sin(gammaRad);

  const volumeFactor = Math.sqrt(
    1 - cosAlpha * cosAlpha - cosBeta * cosBeta - cosGamma * cosGamma +
    2 * cosAlpha * cosBeta * cosGamma
  );

  return [
    [a, 0, 0],
    [b * cosGamma, b * sinGamma, 0],
    [
      c * cosBeta,
      c * (cosAlpha - cosBeta * cosGamma) / sinGamma,
      c * volumeFactor / sinGamma
    ]
  ];
}

