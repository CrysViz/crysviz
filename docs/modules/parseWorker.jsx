import {
  transpose3x3,
  multiplyMatVec,
  invert3x3,
} from './math/backend-js.js';

console.log = () => {};
console.warn = () => {};

self.onmessage = (event) => {
  const { content, fileName } = event.data;
  const lines = content.split(/\r?\n/);

  // Find ions per type
  const ionsPerType = findLastIonsPerType(lines);
  const uniqueElements = findUniqueElements(lines);
  const elements = expandElements(uniqueElements, ionsPerType);
  const natoms = elements.length;

  // Count the number of POSITION blocks to estimate steps
  let positionBlocks = 0;
  for (const line of lines) {
    if (/^\s*POSITION\s+TOTAL-FORCE/i.test(line)) {
      positionBlocks++;
    }
  }

  const steps = [];
  let currentLattice = null;
  let currentPositions = [];
  let currentForces = [];
  let currentSpins = new Array(natoms).fill([0, 0, 0]);
  let spinX = null, spinY = null, spinZ = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*direct\s+lattice\s+vectors/i.test(line)) {
      currentLattice = [
        parseFloats(lines[i + 1]),
        parseFloats(lines[i + 2]),
        parseFloats(lines[i + 3]),
      ].map(v => v.slice(0, 3));
    }

    if (/^\s*POSITION/i.test(line) && (i + 2 < lines.length)) {
      const nextLine = lines[i + 2];
      if (parseFloats(nextLine).length >= 6) {
        const { positions, forces } = readPositionsForcesBlock(lines, i, natoms);
        currentPositions = positions;
        currentForces = forces;

        if (currentLattice && currentPositions.length === natoms) {
          if (spinX && spinY && spinZ) {
            currentSpins = spinX.map((_, idx) => [spinX[idx], spinY[idx], spinZ[idx]]);
          } else if (spinX) {
            currentSpins = spinX.map(m => [m, 0, 0]);
          } else {
            currentSpins = new Array(natoms).fill([0, 0, 0]);
          }

          steps.push({
            lattice: currentLattice,
            positions: currentPositions,
            forces: currentForces,
            spins: currentSpins,
          });

          // Update progress
          const progress = (i / lines.length) * 100;
          self.postMessage({ type: 'progress', progress });
        }
      }
    }

    if (/^\s*magnetization\s*\(x\)/i.test(line)) {
      spinX = readSpinComponent(lines, i, natoms, /^\s*magnetization\s*\(x\)/i);
    }
    if (/^\s*magnetization\s*\(y\)/i.test(line)) {
      spinY = readSpinComponent(lines, i, natoms, /^\s*magnetization\s*\(y\)/i);
    }
    if (/^\s*magnetization\s*\(z\)/i.test(line)) {
      spinZ = readSpinComponent(lines, i, natoms, /^\s*magnetization\s*\(z\)/i);
    }
  }

  // Build structures
  const structures = steps.map(step => {
    const frac = convertCartesianToFractional(step.positions, step.lattice);
    const atoms = frac.map((pos, i) => ({ position: pos, element: elements[i] }));
    const spins = step.spins.map(vector => ({ vector, scaling: 1.0 }));
    const forces = step.forces.map(vector => ({ vector, scaling: 1.0 }));

    return {
      elements,
      uniqueElements,
      lattice: step.lattice,
      atoms,
      spins,
      forces,
    };
  });

  // Send results back to the main thread
  self.postMessage({ type: 'complete', structures, fileName });
};

// Helper functions (copy these from your main file)
function findLastIonsPerType(lines) {
  console.log(lines)
  const re = /ions\s+per\s+type\s*=\s*(.+)$/i;
  let out = [];
  for (const line of lines) {
    const m = line.match(re);
    if (m) out = m[1].trim().split(/\s+/).map(Number);
  }
  return out;
}

function findUniqueElements(lines) {
  console.log(lines)
  const out = [];
  const re = /POTCAR:\s+[A-Za-z0-9_]+\s+([A-Za-z][a-z]?)\s+/i;
  for (const line of lines) {
    const m = line.match(re);
    if (m && m[1] && !out.includes(m[1])) {
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
