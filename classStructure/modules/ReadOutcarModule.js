// ============================================================================

// tableBody.appendChild(row);
// fileBrowser.fileData.push({idx: -1, name: fileName, traj: traj, step: step })
//
//
//

const tableBody = document.querySelector("#objectTable tbody");
import {structureShip,fileBrowser} from '../store.js';
import {createRow,selectLastAddedRow} from '../panels/FileBrowswerPanel.js'
// ------------------------------------------------------------
// parseOUTCAR — returns a StructureContainer with full trajectory
// ------------------------------------------------------------

import { StructureContainer } from "../classes/StructureContainer.js";
import { Structure } from "../classes/Structure.js";
import { Spin } from "../classes/Spin.js";
import { Atom } from "../classes/Atom.js";
import { Force } from "../classes/Force.js";

// ------------------------------------------------------------
// Main exported function
// ------------------------------------------------------------

export function parseOUTCAR(content,fileName) {
  if (!content || typeof content !== "string") {
    throw new Error("OUTCAR: content must be a non-empty string");
  }

  const lines = content.split(/\r?\n/);

  const ionsPerType = findLastIonsPerType(lines);
  const uniqueElements = findUniqueElements(lines);
  const elements = expandElements(uniqueElements, ionsPerType);
  const natoms = elements.length;

  // Find all ionic steps
  const steps = extractAllSteps(lines, natoms);

  const structures = [];

  for (const step of steps) {
    const lattice = step.lattice;

    // --- convert positions to fractional
    const frac = convertCartesianToFractional(step.positions, lattice);
    const atoms = [];
    frac.forEach((pos, i) => {
        atoms.push(new Atom({
        position: pos,
        element: elements[i]
       }))
      }); 

    const spins = [];
    step.spins.forEach((vector,i) =>{
       console.log(vector)
       spins.push(new Spin({
         vector: vector,
         scaling: 1.0
       }))
    });

    const forces = [];
    step.forces.forEach((vector,i) =>{
       forces.push(new Force({
         vector: vector,
         scaling: 1.0
       })
       )
    });

    structures.push(
      new Structure({
        ucelements,
        uniqueElements,
        lattice,
        ucatoms: atoms,               // fractional = used by your viewer
        ucspins:spins,
        ucforces:forces,
        //positions_cartesian: step.positions // keep working behavior
      })
    );

  }

   let traj = structures.length
   let step = traj
   const row = createRow({name: fileName, traj: traj, step: step });
   tableBody.appendChild(row);
   fileBrowser.fileData.push({idx: -1, name: fileName, traj: traj, step: step });

  let container= new StructureContainer({
    fileName: fileName,
    structures: structures
  });

  structureShip.container.push(container)
  selectLastAddedRow();
}

//
// ------------------------------------------------------------
// Step extraction
// ------------------------------------------------------------
//

function extractAllSteps(lines, natoms) {
  const steps = [];

  const posRegex = /^\s*POSITION\s+TOTAL-FORCE/i; // FIXED

  for (let i = 0; i < lines.length; i++) {
    if (posRegex.test(lines[i])) {
      const lattice = findLatticeBefore(lines, i);
      const { positions, forces } = readPositionsForcesBlock(lines, i, natoms);
      const spins = readSpinVectors(lines, i, natoms);
      
      steps.push({
        lattice,
        positions,
        forces,
        spins: spins,
        scaling: spins.map(v => Math.max(...v.map(Math.abs))),
        forces_3xN: transpose(forces),
        forceScaling: forces.map(v => Math.max(...v.map(Math.abs))),
      });
    }
  }

  return steps;
}

//
// ------------------------------------------------------------
// Lattice search — find last “direct lattice vectors” block before index
// ------------------------------------------------------------
//

function findLatticeBefore(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    if (/^\s*direct\s+lattice\s+vectors/i.test(lines[i])) {
      return [
        parseFloats(lines[i + 1]),
        parseFloats(lines[i + 2]),
        parseFloats(lines[i + 3]),
      ].map(v => v.slice(0, 3));
    }
  }
  throw new Error("OUTCAR: lattice not found before a step");
}

//
// ------------------------------------------------------------
// Read POSITION + FORCE block
// ------------------------------------------------------------
//

function readPositionsForcesBlock(lines, idx, natoms) {
  const positions = [];
  const forces = [];

  // skip header line and dashed line
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

//
// ------------------------------------------------------------
// Spin parsing (X,Y,Z blocks or scalar M)
// ------------------------------------------------------------
//

function readSpinVectors(lines, idx, natoms) {
  const X = readSpinComponent(lines, natoms, /^\s*magnetization\s*\(x\)/i);
  const Y = readSpinComponent(lines, natoms, /^\s*magnetization\s*\(y\)/i);
  const Z = readSpinComponent(lines, natoms, /^\s*magnetization\s*\(z\)/i);
  console.log(Y)
  if (X && Y && Z) {
    let spinsList = X.map((_, i) => [X[i], Y[i], Z[i]])
    return spinsList
  }

  if (X) {
    return X.map(m => [m, 0, 0]);
  }

  return new Array(natoms).fill([0, 0, 0]);
}

function readSpinComponent(lines, natoms, regex) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) start = i;
  if (start < 0) return null;

  const out = new Array(natoms).fill(0);

  let i = start + 2;
  let count = 0;
  console.log(start, lines.length)
  while (i < lines.length && count < natoms) {
    const line = lines[i];
    if (/^\s*tot/i.test(line)) break;
    if (/^\s*$/i.test(line)) break;
    if (/^\s*magnetization/i.test(line)) break;

    const toks = parseFloats(line);
    //if (toks.length < 2) break;

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

//
// ------------------------------------------------------------
// Coordinate conversion
// ------------------------------------------------------------
//

// positions N×3 → fractional N×3
function convertCartesianToFractional(cart, lattice) {
  const LT = transpose(lattice);
  const inv = invert3x3(LT);
  return cart.map(v => multiplyMatVec(inv, v).map(x => ((x % 1) + 1) % 1));
}

//
// ------------------------------------------------------------
// General helpers
// ------------------------------------------------------------
//

function parseFloats(line) {
  return line.trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
}

function transpose(A) {
  return A[0].map((_, i) => A.map(r => r[i]));
}

function multiplyMatVec(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

function invert3x3(m) {
  const [
    [a,b,c],
    [d,e,f],
    [g,h,i],
  ] = m;

  const A =  (e*i - f*h);
  const B = -(d*i - f*g);
  const C =  (d*h - e*g);
  const D = -(b*i - c*h);
  const E =  (a*i - c*g);
  const F = -(a*h - b*g);
  const G =  (b*f - c*e);
  const H = -(a*f - c*d);
  const I =  (a*e - b*d);

  const det = a*A + b*B + c*C;
  if (Math.abs(det) < 1e-14) throw new Error("OUTCAR: lattice matrix not invertible");

  const id = 1 / det;
  return [
    [A*id, D*id, G*id],
    [B*id, E*id, H*id],
    [C*id, F*id, I*id],
  ];
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
  for (const line of lines) {
    const m = line.match(/\bVRHFIN\s*=\s*([A-Za-z][a-z]?)/);
    if (m) out.push(m[1]);
  }
  return out;
}

function expandElements(els, counts) {
  const out = [];
  for (let i = 0; i < els.length; i++) {
    for (let k = 0; k < counts[i]; k++) out.push(els[i]);
  }
  return out;
}

