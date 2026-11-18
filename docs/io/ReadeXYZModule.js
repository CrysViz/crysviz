/**
 * Unified XYZ/extxyz parser/writer module
 * Auto-detects file format, provides default lattice, and integrates with StructureContainer
 */

import { generateID } from '../utils/index.js';
import { StructureContainer, TrajectoryContainer } from "../model/index.js";
import { TrajectoryFrameStore } from "../model/TrajectoryFrameStore.js";
import { Structure } from "../model/index.js";
import { Atom } from "../model/index.js";
import { Force } from "../model/index.js";
import { Spin } from "../model/index.js";
// From the concrete JS backend, not the math/index.js facade: the facade's
// exports delegate to a module-scope `activeMathBackend` variable that doesn't
// survive being stringified via .toString() into this file's own worker
// below (only reached when the file has no Lattice= line, so this path is
// easy to miss testing against extxyz files that always specify one).
// ReadOutcarModule.js used to share this constraint; its parser now runs on
// the shared pool (io/outcarParse.js) — the pattern to follow if this worker
// is ever reworked.
import { transpose3x3, multiplyMatVec, invert3x3 } from '../math/backend-js.js';
import { planTrajectoryLoad, LOAD_ALL } from './trajectoryLoadPlan.js';


/**
 * Auto-detects if the content is extended XYZ (extxyz) or standard XYZ
 * @param {string} content - File content
 * @returns {boolean} True if extxyz, false if standard XYZ
 */
function isExtXYZ(content) {
  // Only the second line matters; finding it with indexOf instead of
  // splitting the whole file (which, for a large trajectory, allocated one
  // string per line just to read line 2).
  const first = content.indexOf('\n');
  if (first < 0) return false;
  let end = content.indexOf('\n', first + 1);
  if (end < 0) end = content.length;
  const secondLine = content.slice(first + 1, end);
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
 * Parse XYZ/extxyz content into per-frame typed columns (runs in the worker).
 *
 * Per frame: `elements` (null when identical to the previous frame's, so a
 * fixed-composition trajectory sends its species once), `lattice`,
 * `positions` (FRACTIONAL, wrapped into [0, 1) — the conversion the main
 * thread used to do per atom), and `forces` / `spins` (Float64Array, or null
 * when no atom line of the frame has those columns). The buffers are
 * transferred, not cloned.
 *
 * Line-for-line the same reading as before — `trim().split(/\s+/)` per atom
 * line, parseFloat per token, forces from 7+ columns and spins from 10+ (a
 * line without them reads zeros, as before), the same Cartesian-to-
 * fractional arithmetic — but scanning the text with indexOf and token
 * offsets instead of splitting the whole file into lines and every line into
 * tokens, and without an object plus three small arrays per atom per frame.
 * That made large trajectories run the worker (and then the main thread,
 * which structure-cloned it all back and built an Atom per atom per frame)
 * out of memory.
 *
 * Chunked use (a file too large for one string, see parseXYZBlob): with
 * `opts.final` false, `content` may end inside a frame or a line — only the
 * frames complete in it are parsed, and `consumed` tells where the rest
 * starts (to prepend to the next chunk). `opts.state` carries what spans
 * chunks (extended-XYZ detection, the previous frame's elements, the end).
 * Called with the whole text, as before, it reads exactly as it always did.
 *
 * A load plan (io/trajectoryLoadPlan.js) in `opts.state` — `stride`,
 * `maxFrames` — keeps every stride-th frame, at most maxFrames of them: the
 * other frames' lines are stepped over unread, and reading stops once
 * maxFrames are kept.
 *
 * @param {string} content
 * @param {{final?: boolean, state?: any}} [opts]
 * @returns {{frames: any[], isExtended: boolean, consumed: number}}
 */
function parseXYZColumns(content, opts) {
  const final = !opts || opts.final !== false;
  const state = (opts && opts.state) || {};
  if (state.isExtended === undefined) state.isExtended = isExtXYZ(content);
  const isExtended = state.isExtended;
  const len = content.length;
  let pos = 0;
  // lines[i] of content.split(/\r?\n/), one at a time; null past the end
  // (and, mid-file, for a last line whose newline is still to come).
  const nextLine = () => {
    if (pos > len) return null;
    let end = content.indexOf('\n', pos);
    if (end < 0) {
      if (!final) return null;
      end = len;
    }
    let stop = end;
    if (stop > pos && content.charCodeAt(stop - 1) === 13) stop -= 1;
    const line = content.slice(pos, stop);
    pos = end + 1;
    return line;
  };
  // nextLine without reading the line (false where it returns null).
  const skipLine = () => {
    if (pos > len) return false;
    let end = content.indexOf('\n', pos);
    if (end < 0) {
      if (!final) return false;
      end = len;
    }
    pos = end + 1;
    return true;
  };
  const stride = state.stride > 1 ? state.stride : 1;
  const maxFrames = state.maxFrames ?? Infinity;
  // The characters /\s/ matches (what trim() strips and split(/\s+/) splits on).
  const isSpace = (c) => c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f
    || c === 0x205f || c === 0x3000 || c === 0xfeff;
  const starts = new Int32Array(10);
  const ends = new Int32Array(10);
  // Token offsets of `line` (first 10 kept), returns the token count.
  const tokenize = (line) => {
    let n = 0;
    const L = line.length;
    let i = 0;
    while (i < L) {
      while (i < L && isSpace(line.charCodeAt(i))) i++;
      if (i >= L) break;
      const st = i;
      while (i < L && !isSpace(line.charCodeAt(i))) i++;
      if (n < 10) { starts[n] = st; ends[n] = i; }
      n++;
    }
    return n;
  };
  const num = (line, n, k) => (k < n ? parseFloat(line.slice(starts[k], ends[k])) : NaN);

  const frames = [];
  let prevElements = state.prevElements ?? null;
  for (;;) {
    if (state.done) break;
    const frameStart = pos;
    const head = nextLine();
    if (head === null) break;
    const natoms = parseInt(head, 10);
    if (isNaN(natoms) || natoms <= 0) { state.done = true; break; }
    const commentLine = nextLine();
    if (commentLine === null && !final) { pos = frameStart; break; }
    const seen = state.seen ?? 0;
    if (seen % stride !== 0) {
      // A frame the load plan skips: step over its atom lines.
      let skipped = 0;
      while (skipped < natoms && skipLine()) skipped++;
      if (skipped < natoms) {
        if (!final) { pos = frameStart; break; }
        throw new Error(`XYZ: the file ends inside frame ${seen + 1} (expected ${natoms} atom lines)`);
      }
      state.seen = seen + 1;
      continue;
    }
    const comment = commentLine || '';
    let lattice = null;
    if (isExtended) {
      const latticeMatch = comment.match(/Lattice="([^"]+)"/);
      if (latticeMatch) {
        const latticeVals = latticeMatch[1].split(/\s+/).map(parseFloat);
        lattice = [latticeVals.slice(0, 3), latticeVals.slice(3, 6), latticeVals.slice(6, 9)];
      }
    }

    const elements = new Array(natoms);
    const cart = new Float64Array(natoms * 3);
    let forces = null;
    let spins = null;
    let incomplete = false;
    for (let j = 0; j < natoms; j++) {
      const line = nextLine();
      if (line === null) {
        if (!final) { incomplete = true; break; }
        throw new Error(`XYZ: the file ends inside frame ${frames.length + 1} (expected ${natoms} atom lines)`);
      }
      const n = tokenize(line);
      elements[j] = n > 0 ? line.slice(starts[0], ends[0]) : '';
      const o = j * 3;
      cart[o] = num(line, n, 1);
      cart[o + 1] = num(line, n, 2);
      cart[o + 2] = num(line, n, 3);
      if (n >= 7) {
        if (!forces) forces = new Float64Array(natoms * 3);
        forces[o] = num(line, n, 4);
        forces[o + 1] = num(line, n, 5);
        forces[o + 2] = num(line, n, 6);
      }
      if (n >= 10) {
        if (!spins) spins = new Float64Array(natoms * 3);
        spins[o] = num(line, n, 7);
        spins[o + 1] = num(line, n, 8);
        spins[o + 2] = num(line, n, 9);
      }
    }

    if (incomplete) { pos = frameStart; break; }

    // If no lattice, center and box (small molecules: the per-atom helpers
    // as before, so the box and the shifted positions are unchanged).
    if (!lattice) {
      const atoms = elements.map((element, j) => ({
        element, position: [cart[j * 3], cart[j * 3 + 1], cart[j * 3 + 2]],
      }));
      const com = calculateCenterOfMass(atoms);
      const maxMag = findMaxCoordinateMagnitude(atoms);
      const box = generateBox(maxMag);
      const shiftedPositions = moveCOMToBoxCenter(atoms, com, box);
      shiftedPositions.forEach((p, j) => {
        cart[j * 3] = p[0]; cart[j * 3 + 1] = p[1]; cart[j * 3 + 2] = p[2];
      });
      lattice = box;
      const frac = convertCartesianToFractional(shiftedPositions, lattice);
      if (!verifyAllAtomsInside(frac, lattice)) {
        console.warn("Some atoms are outside the box, increasing box size...");
        lattice = generateBox(maxMag * 2);
      }
    }

    // Cartesian -> fractional, wrapped into [0, 1): convertCartesianToFractional's
    // arithmetic (multiplyMatVec with the inverse of the transposed lattice).
    const inv = invert3x3(transpose3x3(lattice), 1e-14);
    const positions = new Float64Array(natoms * 3);
    for (let j = 0; j < natoms; j++) {
      const o = j * 3;
      const v0 = cart[o], v1 = cart[o + 1], v2 = cart[o + 2];
      const x = inv[0][0] * v0 + inv[0][1] * v1 + inv[0][2] * v2;
      const y = inv[1][0] * v0 + inv[1][1] * v1 + inv[1][2] * v2;
      const z = inv[2][0] * v0 + inv[2][1] * v1 + inv[2][2] * v2;
      positions[o] = ((x % 1) + 1) % 1;
      positions[o + 1] = ((y % 1) + 1) % 1;
      positions[o + 2] = ((z % 1) + 1) % 1;
    }

    let same = prevElements !== null && prevElements.length === natoms;
    for (let j = 0; same && j < natoms; j++) if (prevElements[j] !== elements[j]) same = false;
    frames.push({ elements: same ? null : elements, lattice, positions, forces, spins });
    if (!same) prevElements = elements;
    state.seen = seen + 1;
    state.kept = (state.kept ?? 0) + 1;
    if (state.kept >= maxFrames) state.done = true;
  }
  state.prevElements = prevElements;
  // Mid-file, pos is where the first incomplete frame starts.
  return { frames, isExtended, consumed: final || state.done ? len : Math.min(pos, len) };
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
  const bar = document.getElementById("progressBar");
  const text = document.getElementById("progressText");
  if (bar) bar.style.width = `${Math.round(progress)}%`;
  if (text) text.textContent = `${Math.round(progress)}% complete`;
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
 * A multi-frame file straight into a store-backed trajectory: each parsed
 * frame already is a FramePhysics record (model/TrajectoryFrameStore.js), so
 * no Structure (with its frozen original), Atom, Force or Spin is built per
 * frame — at 10^5 atoms that was gigabytes and most of the load time. A
 * freshly parsed frame has no styles to record. Forces and spins are kept
 * only when the file has those columns (a missing column used to be stored as
 * zeros, three columns per atom per frame of nothing).
 * @param {string} fileName @param {any[]} frames
 */
function trajectoryFromColumns(fileName, frames) {
  const physics = frames.map((f) => ({
    elements: f.elements,
    spinFrame: { fileSaxis: [0, 0, 1] },
    lattice: f.lattice,
    positions: f.positions,
    forces: f.forces,
    // The file's spins are Cartesian already: raw == global (as a Spin built
    // from the vector alone carries it).
    spinVectors: f.spins,
    spinRaw: f.spins,
    energy: null,
    stress: null,
  }));
  return new TrajectoryContainer({ fileName, store: new TrajectoryFrameStore({ frames: physics }) });
}

/**
 * A single-frame file as an eager, editable Structure (registered atom ids,
 * one Force and Spin per atom as before — zeros where the file has none).
 * @param {any} frame
 */
function structureFromColumns(frame) {
  const { elements, lattice, positions } = frame;
  const n = elements.length;
  const vec = (arr, i) => (arr ? [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]] : [0, 0, 0]);
  const atoms = new Array(n);
  const forces = new Array(n);
  const spins = new Array(n);
  for (let i = 0; i < n; i++) {
    atoms[i] = new Atom({ element: elements[i], position: vec(positions, i), uuid: generateID([elements[i]]) });
    forces[i] = new Force({ vector: vec(frame.forces, i), scaling: 1.0 });
    spins[i] = new Spin({ vector: vec(frame.spins, i), scaling: 1.0 });
  }
  return new Structure({
    elements: [...elements],
    uniqueElements: [...new Set(elements)],
    lattice,
    atoms,
    spins,
    forces,
  });
}

/**
 * Above this size an .xyz file is parsed in chunks straight from the file
 * (the worker reads it slice by slice) instead of as one string: a browser
 * caps a string at about 512 M characters, so a GB-sized trajectory could
 * not be loaded at all.
 */
export const XYZ_STREAM_MIN_BYTES = 256 * 1024 * 1024;
const XYZ_CHUNK_BYTES = 32 * 1024 * 1024;
/** The start of the file the memory estimate reads. */
const XYZ_ESTIMATE_CHARS = 4 * 1024 * 1024;

/**
 * Estimate an .xyz trajectory from its start: the first frame's atom count,
 * its columns (forces from 7, spins from 10) and its line lengths, scaled to
 * the file size. Memory per frame is what the parse stores: 8 bytes per
 * coordinate, per column. Null when the start is not an .xyz frame.
 * @param {string} head @param {number} totalSize the file's length
 * @returns {{frames: number, atoms: number, bytesPerFrame: number} | null}
 */
export function estimateXYZ(head, totalSize) {
  const nl1 = head.indexOf('\n');
  const atoms = parseInt(nl1 < 0 ? head : head.slice(0, nl1), 10);
  if (nl1 < 0 || !(atoms > 0)) return null;
  const nl2 = head.indexOf('\n', nl1 + 1);
  if (nl2 < 0) return null;
  let pos = nl2 + 1;
  let lines = 0;
  let columns = 0;
  while (lines < atoms && lines < 20000) {
    const end = head.indexOf('\n', pos);
    if (end < 0) break;
    if (lines === 0) columns = head.slice(pos, end).trim().split(/\s+/).length;
    pos = end + 1;
    lines++;
  }
  if (!lines) return null;
  const textPerFrame = nl2 + 1 + atoms * (pos - nl2 - 1) / lines;
  const arrays = 1 + (columns >= 7 ? 1 : 0) + (columns >= 10 ? 1 : 0);
  return { frames: Math.max(1, Math.round(totalSize / textPerFrame)), atoms, bytesPerFrame: atoms * 24 * arrays };
}

/** The load plan for an .xyz file (io/trajectoryLoadPlan.js). */
async function planXYZLoad(head, totalSize, fileName) {
  const est = estimateXYZ(head, totalSize);
  if (!est) return LOAD_ALL;
  return planTrajectoryLoad({ fileName, ...est, bytes: est.frames * est.bytesPerFrame, estimated: true });
}

/**
 * Main exported function for parsing XYZ/extxyz files and integrating with StructureContainer
 * @param {string | import('./FileSource.js').FileSource} content - File content, or the file
 * @param {string} fileName - File name
 * @returns {Promise} Promise resolving to parsed Structure objects
 */
export async function parseXYZFile(content, fileName) {
  if (content && typeof content === 'object' && typeof content.readAllText === 'function') {
    const source = content;
    if (source.kind !== 'text' && source.size > XYZ_STREAM_MIN_BYTES) {
      const blob = source.asBlob();
      const plan = await planXYZLoad(await blob.slice(0, XYZ_ESTIMATE_CHARS).text(), blob.size, fileName);
      return parseXYZBlob(blob, fileName, { plan });
    }
    content = await source.readAllText();
  }
  if (!content || typeof content !== "string") {
    throw new Error("Content must be a non-empty string");
  }
  const plan = await planXYZLoad(content.slice(0, XYZ_ESTIMATE_CHARS), content.length, fileName);

  // Estimate frames for progress reporting: lines / (atoms + 2) of the first
  // frame, counted with indexOf (splitting the whole file into lines on the
  // main thread, just for this, cost seconds and a copy of the file).
  let lineCount = 1;
  for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1)) lineCount++;
  const firstAtoms = parseInt(content.slice(0, Math.max(0, content.indexOf('\n'))) || content, 10);
  const frameCount = firstAtoms > 0 ? Math.floor(lineCount / (firstAtoms + 2)) : 0;

  return runXYZWorker({ content, ...plan }, fileName, frameCount > 100);
}

/**
 * Parse an .xyz file in chunks of `chunkBytes` read from the Blob inside the
 * worker (only complete frames per chunk; the rest carries over), with the
 * progress bar following the bytes read. The same result as parsing the
 * whole text at once.
 * @param {Blob} blob
 * @param {string} fileName
 * @param {{chunkBytes?: number, plan?: import('./trajectoryLoadPlan.js').TrajectoryPlan}} [opts]
 * @returns {Promise<any>}
 */
export function parseXYZBlob(blob, fileName, { chunkBytes = XYZ_CHUNK_BYTES, plan = LOAD_ALL } = {}) {
  return runXYZWorker({ blob, chunkBytes, ...plan }, fileName, true);
}

/**
 * One worker per parse: it is terminated (and its Blob URL revoked) as soon
 * as the parse settles — left running, every load kept a whole worker thread
 * alive for the session, and its onmessage closure kept the parsed container
 * alive after the row was deleted.
 * @param {{content?: string, blob?: Blob, chunkBytes?: number, stride?: number, maxFrames?: number}} message
 * @param {string} fileName
 * @param {boolean} withProgress
 */
function runXYZWorker(message, fileName, withProgress) {
  return new Promise((resolve, reject) => {
    if (withProgress) showProgressBar();

    const workerUrl = URL.createObjectURL(new Blob([`
      ${isExtXYZ.toString()}
      ${calculateCenterOfMass.toString()}
      ${findMaxCoordinateMagnitude.toString()}
      ${generateBox.toString()}
      ${moveCOMToBoxCenter.toString()}
      ${convertCartesianToFractional.toString()}
      ${verifyAllAtomsInside.toString()}
      ${parseXYZColumns.toString()}
      ${transpose3x3.toString()}
      ${multiplyMatVec.toString()}
      ${invert3x3.toString()}

      async function parseBlob(blob, chunkBytes, state) {
        const decoder = new TextDecoder();
        const frames = [];
        let isExtended = false;
        let carry = '';
        for (let off = 0; off < blob.size && !state.done; off += chunkBytes) {
          const last = off + chunkBytes >= blob.size;
          const bytes = await blob.slice(off, off + chunkBytes).arrayBuffer();
          const text = carry + decoder.decode(bytes, { stream: !last });
          const result = parseXYZColumns(text, { final: last, state });
          for (const f of result.frames) frames.push(f);
          isExtended = result.isExtended;
          carry = text.slice(result.consumed);
          self.postMessage({ type: 'progress', fraction: Math.min(1, (off + chunkBytes) / blob.size) });
        }
        return { frames, isExtended };
      }

      self.onmessage = async function(event) {
        const { content, blob, chunkBytes, stride, maxFrames } = event.data;
        const state = { stride, maxFrames };
        try {
          const result = blob ? await parseBlob(blob, chunkBytes, state) : parseXYZColumns(content, { final: true, state });
          const transfer = [];
          for (const f of result.frames) {
            transfer.push(f.positions.buffer);
            if (f.forces) transfer.push(f.forces.buffer);
            if (f.spins) transfer.push(f.spins.buffer);
          }
          self.postMessage({ type: 'complete', frames: result.frames, isExtended: result.isExtended }, transfer);
        } catch (error) {
          self.postMessage({ type: 'error', error: error.message });
        }
      };
    `], { type: 'application/javascript' }));
    const worker = new Worker(workerUrl);
    const dispose = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    };

    worker.onmessage = (event) => {
      if (event.data.type === 'progress') {
        updateProgressBar(event.data.fraction * 100);
      } else if (event.data.type === 'complete') {
        dispose();
        const { frames } = event.data;
        // Composition sent once per change; restore it per frame (shared by
        // reference, as the store's builders intern it).
        let elements = null;
        for (const frame of frames) {
          if (frame.elements) elements = frame.elements;
          frame.elements = elements;
        }
        const container = frames.length > 1
          ? trajectoryFromColumns(fileName, frames)
          : new StructureContainer({ fileName, structures: frames.map(structureFromColumns) });
        // Planned before parsing: not held against the limit again.
        /** @type {any} */ (container).loadPlanned = true;

        hideProgressBar();
        resolve(container);
      } else if (event.data.type === 'error') {
        dispose();
        hideProgressBar();
        reject(new Error(event.data.error));
      }
    };

    worker.onerror = (error) => {
      dispose();
      hideProgressBar();
      reject(error);
    };

    worker.postMessage(message);
  });
}
