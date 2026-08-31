import { StructureContainer } from "../model/index.js";
import { Structure } from "../model/index.js";
import { Spin } from "../model/index.js";
import { Atom } from "../model/index.js";
import { Force } from "../model/index.js";
import { Stress } from "../model/index.js";
import {generateID} from '../utils/index.js'
import { FileSource } from './FileSource.js';
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

/*
 * An MD OUTCAR is routinely hundreds of MB of plain text, so this reader never
 * materialises it as a string. The main thread hands the parse worker a Blob —
 * structured-cloning a Blob copies a REFERENCE, not the bytes — and the worker
 * reads it in fixed-size chunks, keeping only a bounded sliding window of
 * decoded lines alive at any moment.
 *
 * The previous implementation read the whole file as one string, split it into
 * a line array on the main thread (just to find SAXIS and count POSITION
 * blocks), cloned the entire string into the worker, and split it again there —
 * a transient peak of roughly 4-5x the file size. All of that pre-scanning now
 * happens inside the single streaming pass: SAXIS candidates are collected as
 * they stream by, and progress is reported by bytes consumed instead of a
 * pre-counted block total.
 *
 * The parsed frames themselves are still built eagerly — every ionic step
 * becomes a Structure as soon as the worker finishes. That retained cost is a
 * separate concern from the transient one this module addresses.
 */

// Above this the progress overlay is shown. Size stands in for the old
// "more than 100 POSITION blocks" rule, which required splitting the whole
// file into lines up front just to count them: a static-relaxation OUTCAR is a
// few MB at most, while any MD run long enough to have tripped the old rule is
// comfortably past this.
const LARGE_FILE_BYTES = 8 * 1024 * 1024;

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

/**
 * Parse a VASP OUTCAR (possibly an MD trajectory) into a StructureContainer.
 *
 * `content` is normally the FileSource that io/formats.js passes through for a
 * random-access format; a plain string is still accepted for callers that hold
 * the text already (ui/AddonAPI.js hands parse_any decoded addon text).
 *
 * @param {import('./FileSource.js').FileSource | string} content
 * @param {string} fileName
 * @returns {Promise<StructureContainer>}
 */
export function parseOUTCAR(content, fileName) {
  return new Promise((resolve, reject) => {
    let blob;
    if (content instanceof FileSource) {
      // For a file on disk this is the file handle itself — nothing is read
      // here, and nothing ever reads it in full.
      blob = content.asBlob();
    } else if (typeof content === "string" && content.length > 0) {
      blob = new Blob([content]);
    } else {
      reject(new Error("OUTCAR: content must be a FileSource or a non-empty string"));
      return;
    }
    if (blob.size === 0) {
      reject(new Error("OUTCAR: file is empty"));
      return;
    }

    if (blob.size > LARGE_FILE_BYTES) {
      showProgressBar();
    }

    // Create a Web Worker. The parser state machine runs there; the helper
    // functions below are stringified into its source.
    const workerUrl = URL.createObjectURL(new Blob([`
      ${expandElements.toString()}
      ${parseFloats.toString()}
      ${readPositionsForcesBlock.toString()}
      ${readSpinComponent.toString()}
      ${convertCartesianToFractional.toString()}
      ${transpose3x3.toString()}
      ${multiplyMatVec.toString()}
      ${invert3x3.toString()}

      self.onmessage = async function(event) {
        // onmessage is async, and a rejected promise inside it does NOT reach
        // worker.onerror on the parent — report failures as a message instead.
        try {
          await parse(event.data);
        } catch (err) {
          self.postMessage({ type: 'error', message: String((err && err.message) || err) });
        }
      };

      async function parse({ blob, fileName }) {
        // ---- chunked line supply -----------------------------------------
        //
        // The file is read CHUNK_BYTES at a time; \`lines\` holds only the
        // not-yet-consumed tail of the decoded text, so memory stays bounded
        // by the chunk size plus the parser's lookahead regardless of file
        // size. \`carry\` is the partial last line of the previous chunk and
        // the streaming TextDecoder holds any split multi-byte sequence, so
        // chunk boundaries are invisible to the parser.
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
          const parts = text.split(/\\r?\\n/);
          // The last segment may continue in the next chunk; hold it back.
          // At EOF it is the (possibly newline-less) final line and stays in.
          carry = done ? '' : parts.pop();
          if (i > 0) { lines = lines.slice(i); i = 0; }
          for (const part of parts) lines.push(part);
          self.postMessage({ type: 'progress', progress: (offset / totalBytes) * 100 });
        }

        // ---- header state, accumulated as lines stream past --------------
        //
        // "ions per type" and the POTCAR element lines appear in the header,
        // well before the first POSITION block, so natoms is known by the
        // time any block reader needs it. Latest-seen wins for ions per type,
        // matching the old whole-file scan that kept the last occurrence.
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

        // SAXIS lines from the INCAR echo, raw. The main thread owns
        // parseSaxis and tries these in order, mirroring the old first-parse
        // -wins scan over the whole file.
        const saxisCandidates = [];

        const steps = [];
        let currentLattice = null;
        let spinX = null, spinY = null, spinZ = null;

        while (true) {
          // Keep enough lookahead in the window that every block reader
          // below can index forward without falling off the end: a
          // POSITION/TOTAL-FORCE or magnetization block is natoms lines
          // plus a small frame.
          const lookahead = natoms + 64;
          while (!done && lines.length - i <= lookahead) await refill();
          if (i >= lines.length) break;
          const line = lines[i];

          let m;
          if ((m = line.match(/ions\\s+per\\s+type\\s*=\\s*(.+)$/i))) {
            ionsPerType = m[1].trim().split(/\\s+/).map(Number);
            refreshElements();
          }
          if ((m = line.match(/POTCAR:\\s+[A-Za-z0-9_]+\\s+([A-Za-z]{1,2})\\s*.*/i))) {
            if (m[1] && !uniqueElements.includes(m[1])) {
              uniqueElements.push(m[1]);
              refreshElements();
            }
          }
          if ((m = line.match(/\\bSAXIS\\b\\s*=\\s*(.+)$/i))) {
            saxisCandidates.push(m[1]);
          }

          if (/^\\s*direct\\s+lattice\\s+vectors/i.test(line)) {
            currentLattice = [
              parseFloats(lines[i + 1] || ''),
              parseFloats(lines[i + 2] || ''),
              parseFloats(lines[i + 3] || ''),
            ].map(v => v.slice(0, 3));
          }

          if (natoms > 0 && /^\\s*POSITION/i.test(line) && (i + 2 < lines.length)) {
            const nextLine = lines[i + 2];
            if (parseFloats(nextLine).length >= 6) {
              const { positions, forces } = readPositionsForcesBlock(lines, i, natoms);

              if (currentLattice && positions.length === natoms) {
                // These moments are in VASP's SAXIS-local frame; the main
                // thread rotates them into global Cartesian afterwards.
                let currentSpins;
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
                // magnetization block(s) printed within its own window. VASP
                // may print several magnetization blocks per step (e.g. high
                // NWRITE) -- those all precede this POSITION line, so spinX/Y/Z
                // already hold the last (converged) one. But a later step that
                // prints no block of its own must not silently inherit this
                // step's moments, which is what happened without this reset.
                spinX = null; spinY = null; spinZ = null;
              }
            }
          }

          if (natoms > 0 && /^\\s*magnetization\\s*\\(x\\)/i.test(line)) {
            spinX = readSpinComponent(lines, i, natoms, /^\\s*magnetization\\s*\\(x\\)/i);
          }
          if (natoms > 0 && /^\\s*magnetization\\s*\\(y\\)/i.test(line)) {
            spinY = readSpinComponent(lines, i, natoms, /^\\s*magnetization\\s*\\(y\\)/i);
          }
          if (natoms > 0 && /^\\s*magnetization\\s*\\(z\\)/i.test(line)) {
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
            steps[steps.length - 1].energy = parseFloat(totenMatch[1]);
          }
          const sigmaMatch = line.match(/energy\\(sigma->0\\)\\s*=\\s*(-?\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)/i);
          if (sigmaMatch && steps.length > 0) {
            steps[steps.length - 1].energy = parseFloat(sigmaMatch[1]);
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

          i++;
        }

        // Build structures
        const structures = steps.map(step => {
          const frac = convertCartesianToFractional(step.positions, step.lattice);
          const atoms = frac.map((pos, idx) => ({ position: pos, element: elements[idx] }));
          // rawVector is in the SAXIS-local frame; the main thread rotates it
          // into the rendered global-Cartesian vector below.
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

        // Send results back to the main thread
        self.postMessage({ type: 'complete', structures, fileName, saxisCandidates });
      }
    `], { type: 'application/javascript' }));
    const worker = new Worker(workerUrl);

    // The worker holds a Blob reference and (transiently) the parsed step
    // data; tear it down as soon as it has answered so neither outlives the
    // load. The old code leaked both the worker and the object URL per load.
    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      hideProgressBar();
    };

    // A Blob structured-clones by reference: the worker gets a handle to the
    // same bytes, not a copy, so this line costs nothing even for a huge file.
    worker.postMessage({ blob, fileName });

    // Handle messages from the worker
    worker.onmessage = (event) => {
      if (event.data.type === 'progress') {
        updateProgressBar(event.data.progress);
      } else if (event.data.type === 'error') {
        cleanup();
        reject(new Error(`OUTCAR: ${event.data.message}`));
      } else if (event.data.type === 'complete') {
        const { structures, fileName, saxisCandidates } = event.data;

        // SAXIS the run used (default (0,0,1)) and the matching global<-SAXIS
        // rotation, applied to each spin's raw moments below. The worker only
        // collects candidate lines; parsing them stays here with the rest of
        // the spin-frame logic.
        let saxis = [0, 0, 1];
        for (const raw of saxisCandidates || []) {
          const s = parseSaxis(raw);
          if (s) { saxis = s; break; }
        }
        const saxisMatrix = saxisToMatrix(saxis);

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

        cleanup();
        resolve(container);
      }
    };

    worker.onerror = (error) => {
      console.error("Worker error:", error);
      cleanup();
      reject(error);
    };
  });
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
