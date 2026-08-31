/**
 * Streaming VASP OUTCAR parser: a Blob in, plain trajectory data out.
 *
 * This is the compute half of OUTCAR loading, split out of
 * `io/ReadOutcarModule.js` so it can run as a pool-worker task
 * (`workers/computeWorker.js`, task 'outcarParse') instead of an ad-hoc worker
 * assembled from stringified functions. It touches no DOM and builds no model
 * classes — the main thread turns the returned data into Structure objects and
 * owns the SAXIS-frame rotation.
 *
 * An MD OUTCAR is routinely hundreds of MB of text, so the file is never
 * materialised as a string: the Blob is read in fixed-size chunks through a
 * streaming TextDecoder, and only a bounded sliding window of decoded lines is
 * alive at any moment (the chunk plus the lookahead a POSITION/TOTAL-FORCE or
 * magnetization block needs). Chunk boundaries are invisible to the parser: the
 * partial trailing line of each chunk is carried into the next, and the decoder
 * holds any split multi-byte sequence.
 */

// The concrete JS backend rather than the math/index.js facade: the facade
// delegates to a module-scope `activeMathBackend` that only the main thread's
// startup initialises, and a pool worker has its own module graph where that
// never runs. These are trivial pure functions; the JS versions are the right
// tool on every thread.
import {
  transpose3x3,
  multiplyMatVec,
  invert3x3,
} from '../math/backend-js.js';

/**
 * Parse an OUTCAR Blob into plain per-step trajectory data.
 *
 * `onProgress` (optional) is called with a 0–100 percentage as chunks are
 * consumed — bytes read stand in for lines parsed, which they track to within
 * one chunk.
 *
 * The returned `structures` entries hold exactly what a Structure needs, as
 * plain arrays/objects that survive a structured clone: elements,
 * uniqueElements, lattice, atoms ({position, element}, fractional), spins
 * ({rawVector, ...} — still in VASP's SAXIS-local frame), forces ({vector,
 * ...}), energy, stress (3x3 tensor or null). `saxisCandidates` are the raw
 * right-hand sides of any SAXIS lines from the INCAR echo, in file order; the
 * caller owns parsing them (utils/spinFrame.js is main-thread code).
 *
 * @param {Blob} blob
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<{structures: Array<object>, saxisCandidates: string[]}>}
 */
export async function parseOutcarBlob(blob, onProgress) {
  // ---- chunked line supply -------------------------------------------------
  const CHUNK_BYTES = 4 * 1024 * 1024;
  const totalBytes = blob.size;
  const decoder = new TextDecoder();
  let lines = [];
  let i = 0;                    // cursor into the window
  let offset = 0;               // bytes handed to the decoder so far
  let carry = '';
  let done = totalBytes === 0;

  async function refill() {
    const buf = await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
    offset += buf.byteLength;
    let text = carry + decoder.decode(buf, { stream: true });
    if (offset >= totalBytes) {
      text += decoder.decode();
      done = true;
    }
    const parts = text.split(/\r?\n/);
    // The last segment may continue in the next chunk; hold it back. At EOF it
    // is the (possibly newline-less) final line and stays in.
    carry = done ? '' : parts.pop();
    if (i > 0) { lines = lines.slice(i); i = 0; }
    for (const part of parts) lines.push(part);
    if (onProgress) onProgress((offset / totalBytes) * 100);
  }

  // ---- header state, accumulated as lines stream past ----------------------
  //
  // "ions per type" and the POTCAR element lines appear in the header, well
  // before the first POSITION block, so natoms is known by the time any block
  // reader needs it. Latest-seen wins for ions per type, matching the old
  // whole-file scan that kept the last occurrence.
  let ionsPerType = [];
  const uniqueElements = [];
  let elements = [];
  let natoms = 0;
  function refreshElements() {
    if (uniqueElements.length && ionsPerType.length) {
      elements = expandElements(uniqueElements, ionsPerType);
      natoms = elements.length;
    }
  }

  /** @type {string[]} */
  const saxisCandidates = [];

  const steps = [];
  let currentLattice = null;
  let spinX = null, spinY = null, spinZ = null;

  while (true) {
    // Keep enough lookahead in the window that every block reader below can
    // index forward without falling off the end: a POSITION/TOTAL-FORCE or
    // magnetization block is natoms lines plus a small frame.
    const lookahead = natoms + 64;
    while (!done && lines.length - i <= lookahead) await refill();
    if (i >= lines.length) break;
    const line = lines[i];

    let m;
    if ((m = line.match(/ions\s+per\s+type\s*=\s*(.+)$/i))) {
      ionsPerType = m[1].trim().split(/\s+/).map(Number);
      refreshElements();
    }
    if ((m = line.match(/POTCAR:\s+[A-Za-z0-9_]+\s+([A-Za-z]{1,2})\s*.*/i))) {
      if (m[1] && !uniqueElements.includes(m[1])) {
        uniqueElements.push(m[1]);
        refreshElements();
      }
    }
    if ((m = line.match(/\bSAXIS\b\s*=\s*(.+)$/i))) {
      saxisCandidates.push(m[1]);
    }

    if (/^\s*direct\s+lattice\s+vectors/i.test(line)) {
      currentLattice = [
        parseFloats(lines[i + 1] || ''),
        parseFloats(lines[i + 2] || ''),
        parseFloats(lines[i + 3] || ''),
      ].map(v => v.slice(0, 3));
    }

    if (natoms > 0 && /^\s*POSITION/i.test(line) && (i + 2 < lines.length)) {
      const nextLine = lines[i + 2];
      if (parseFloats(nextLine).length >= 6) {
        const { positions, forces } = readPositionsForcesBlock(lines, i, natoms);

        if (currentLattice && positions.length === natoms) {
          // These moments are in VASP's SAXIS-local frame; the main thread
          // rotates them into global Cartesian afterwards.
          let currentSpins;
          if (spinX && spinY && spinZ) {
            // Non-collinear: full (mx,my,mz) in the SAXIS frame.
            currentSpins = spinX.map((_, idx) => [spinX[idx], spinY[idx], spinZ[idx]]);
          } else if (spinX) {
            // Collinear (ISPIN=2): a single scalar moment per atom that lies
            // along the spin-quantisation axis, i.e. SAXIS. In the SAXIS-local
            // frame that axis IS z, so place it on z (not x); the main-thread
            // SAXIS rotation then points it correctly in global Cartesian.
            // (The old code put it on x, drawing every collinear moment 90
            // degrees off along global +x.)
            currentSpins = spinX.map(mom => [0, 0, mom]);
          } else {
            currentSpins = new Array(natoms).fill([0, 0, 0]);
          }

          steps.push({
            lattice: currentLattice,
            positions,
            forces,
            spins: currentSpins,
            energy: null,
            stress: null,
          });

          // Reset per-step so the NEXT ionic step only picks up the
          // magnetization block(s) printed within its own window. VASP may
          // print several magnetization blocks per step (e.g. high NWRITE) --
          // those all precede this POSITION line, so spinX/Y/Z already hold
          // the last (converged) one. But a later step that prints no block of
          // its own must not silently inherit this step's moments, which is
          // what happened without this reset.
          spinX = null; spinY = null; spinZ = null;
        }
      }
    }

    if (natoms > 0 && /^\s*magnetization\s*\(x\)/i.test(line)) {
      spinX = readSpinComponent(lines, i, natoms, /^\s*magnetization\s*\(x\)/i);
    }
    if (natoms > 0 && /^\s*magnetization\s*\(y\)/i.test(line)) {
      spinY = readSpinComponent(lines, i, natoms, /^\s*magnetization\s*\(y\)/i);
    }
    if (natoms > 0 && /^\s*magnetization\s*\(z\)/i.test(line)) {
      spinZ = readSpinComponent(lines, i, natoms, /^\s*magnetization\s*\(z\)/i);
    }

    // Energy lines print AFTER the POSITION/TOTAL-FORCE block for the same
    // ionic step, so by the time we see them the step is already pushed onto
    // steps above -- attach to the most-recently pushed step
    // (steps[steps.length - 1]) rather than the next one. TOTEN is the
    // fallback; energy(sigma->0) is preferred and, since it prints after TOTEN
    // for the same step, overwrites it below.
    const totenMatch = line.match(/free\s+energy\s+TOTEN\s*=\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/i);
    if (totenMatch && steps.length > 0) {
      steps[steps.length - 1].energy = parseFloat(totenMatch[1]);
    }
    const sigmaMatch = line.match(/energy\(sigma->0\)\s*=\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/i);
    if (sigmaMatch && steps.length > 0) {
      steps[steps.length - 1].energy = parseFloat(sigmaMatch[1]);
    }

    // Stress: the "in kB" line gives the Voigt stress (XX YY ZZ XY YZ ZX) and
    // prints after the POSITION block for the step, so attach it to the
    // most-recently pushed step. Build a symmetric 3x3 tensor.
    const kbMatch = line.match(/^\s*in kB\s+(.*)$/i);
    if (kbMatch && steps.length > 0) {
      const sv = parseFloats(kbMatch[1]);
      if (sv.length >= 6) {
        const xx = sv[0], yy = sv[1], zz = sv[2], xy = sv[3], yz = sv[4], zx = sv[5];
        steps[steps.length - 1].stress = [[xx, xy, zx], [xy, yy, yz], [zx, yz, zz]];
      }
    }

    i++;
  }

  const structures = steps.map(step => {
    const frac = convertCartesianToFractional(step.positions, step.lattice);
    const atoms = frac.map((pos, idx) => ({ position: pos, element: elements[idx] }));
    // rawVector is in the SAXIS-local frame; the main thread rotates it into
    // the rendered global-Cartesian vector.
    const spins = step.spins.map(rawVector => ({ rawVector, scaling: 1.0, color: "#008080" }));
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

  return { structures, saxisCandidates };
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
