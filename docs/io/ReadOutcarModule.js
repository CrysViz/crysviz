import { StructureContainer } from "../model/index.js";
import { Structure } from "../model/index.js";
import { Spin } from "../model/index.js";
import { Atom } from "../model/index.js";
import { Force } from "../model/index.js";
import { Stress } from "../model/index.js";
import { TrajectoryFrameStore, TrajectoryContainer } from "../model/index.js";
import {generateID} from '../utils/index.js'
import { FileSource } from './FileSource.js';
import { parseOutcarBlob } from './outcarParse.js';
import * as workerPool from '../workers/workerPool.js';
// Rotate the SAXIS-frame moments the parser returns into global Cartesian.
import { multiplyMatVec } from '../math/backend-js.js';
import { saxisToMatrix, parseSaxis } from '../utils/spinFrame.js';

/*
 * OUTCAR loading, main-thread half: progress UI, dispatch, and turning the
 * parsed per-step data into Structure objects (including the SAXIS-frame
 * rotation of the magnetic moments).
 *
 * The parsing itself lives in `io/outcarParse.js` and runs on the shared
 * worker pool (`workers/workerPool.js`, task 'outcarParse') — not in an ad-hoc
 * worker assembled from stringified functions, which is what this module used
 * to spin up (and leak) per load. The worker receives the file as a Blob;
 * structured-cloning a Blob copies a reference, not the bytes, so handing a
 * multi-hundred-MB MD OUTCAR to the pool is free and the file is never
 * materialised as a string on any thread — the parser streams it in bounded
 * chunks.
 *
 * The parsed frames are still built eagerly — every ionic step becomes a
 * Structure as soon as the parser finishes. That retained cost is a separate
 * concern from the transient one this design addresses.
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
 * Parse on the pool when possible, on the main thread when not — the same
 * dispatch shape as workers/waveTasks.js: a pool that cannot start (module
 * worker unsupported, blocked by a CSP) must not take OUTCAR loading down with
 * it, so fall back rather than failing the load.
 * @param {Blob} blob
 * @returns {Promise<{structures: Array<object>, saxisCandidates: string[]}>}
 */
async function runParse(blob) {
  if (workerPool.available()) {
    try {
      return await workerPool.run('outcarParse', { blob }, undefined, updateProgressBar);
    } catch (error) {
      console.warn('OUTCAR parse failed in a pool worker; falling back to the '
        + 'main thread. The UI will block while it runs.', error);
    }
  }
  return parseOutcarBlob(blob, updateProgressBar);
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
export async function parseOUTCAR(content, fileName) {
  let blob;
  if (content instanceof FileSource) {
    // For a file on disk this is the file handle itself — nothing is read
    // here, and nothing ever reads it in full.
    blob = content.asBlob();
  } else if (typeof content === "string" && content.length > 0) {
    blob = new Blob([content]);
  } else {
    throw new Error("OUTCAR: content must be a FileSource or a non-empty string");
  }
  if (blob.size === 0) {
    throw new Error("OUTCAR: file is empty");
  }

  if (blob.size > LARGE_FILE_BYTES) {
    showProgressBar();
  }

  try {
    const { structures, saxisCandidates } = await runParse(blob);

    // SAXIS the run used (default (0,0,1)) and the matching global<-SAXIS
    // rotation, applied to each spin's raw moments below. The parser only
    // collects candidate lines from the INCAR echo; parsing them stays here
    // with the rest of the spin-frame logic.
    let saxis = [0, 0, 1];
    for (const raw of saxisCandidates || []) {
      const s = parseSaxis(raw);
      if (s) { saxis = s; break; }
    }
    const saxisMatrix = saxisToMatrix(saxis);

    // A multi-frame trajectory is NOT built into per-frame Structures any
    // more: the physics is packed into flat typed arrays (~76 MB for a
    // 110 MB / 1790-frame MD OUTCAR, where eager Structures measured
    // ~1.8 GB) and frames materialise on demand as they are viewed —
    // model/TrajectoryContainer.js owns that life cycle, including keeping
    // any frame the user styles or edits. Single-frame files keep the eager
    // path: they are cheap and are the ones that get edited heavily.
    if (structures.length > 1) {
      const store = TrajectoryFrameStore.fromParsedSteps(structures, {
        elements: structures[0].elements,
        saxisMatrix,
        saxis,
      });
      return new TrajectoryContainer({ fileName, store });
    }

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

    return new StructureContainer({ fileName, structures: structureObjects });
  } finally {
    hideProgressBar();
  }
}
