import { fileBrowser, structureShip, general } from '../../state/store.js';
import { structureHasFractionalOccupancy } from '../DisorderWarningBanner.js';
import {
  buildNEPStructure,
  relaxUntilConverged,
  applyStructureToViewer,
  expandKeptVectorsToFull,
  maxForce,
  pressureGPaFromStress,
} from '../../atomistic/relaxer.js';
import {
  initializeMDState,
  runMDSimulation,
  applyMDStateToViewer,
  createNEPForceEvaluator,
  createVelocityVerletIntegrator,
  createCosineAnnealingSchedule,
  createBussiThermostat,
  createStochasticCellBarostat,
  createNoBarostat,
  recommendedTimestepFs,
  DEFAULT_THERMOSTAT_TAU_FS,
  DEFAULT_BAROSTAT_TAU_FS,
  MIN_BAROSTAT_TAU_RATIO,
  mdProfileMeasure,
} from '../../atomistic/MD.js';
import { ensureWorkerNEPReady, createWorkerNEPForceEvaluator } from '../../atomistic/nepWorkerClient.js';
import { ensureTrajectoryPanelForLive, feedLiveStep, resetLivePlot, endLiveFeed } from '../TrajectoryPanel.js';
import { MLIPRunner } from '../../external/mlip_wasm/mlip_runner.js';
import { WorkerMLIPRunner } from '../../atomistic/mlipWorkerClient.js';
import { ASERunner, DEFAULT_ASE_URL } from '../../atomistic/aseClient.js';
import { PET_MAD_BASE_URL, fetchPetModel, inspectPetModelFile, elementsOutside } from '../../atomistic/petModels.js';
import { PET_LINK_OPTION, bindPetModelList, petModelFor, selectedPetModel } from './PetModelList.js';
import { mountPotentialNotice, setPotentialLabel, notifyPotentialChange, potentialSource } from '../../atomistic/potentialNotice.js';
import { dataSourceOf } from '../../model/dataSource.js';
import { getContainerForStructure } from '../../state/structures.js';
import {
  isIsolated, isMultithreadRequested, canRequestIsolation, setMultithreadEnabled,
} from '../../host/coi.js';
import { confirmAppReload, reloadAbandoned } from '../LeaveGuard.js';
import { withAppStressConvention } from '../../atomistic/calculatorStress.js';
import { withAtomLimit, assertPotentialSize, potentialSizeProblem } from '../../atomistic/potentialLimits.js';
import { updateForces } from '../../render/index.js';
import { updateRow, createRow, selectStructure, selectContainer } from '../FileBrowswerPanel.js';
import { refreshActivePanels, getPanelPref, setPanelPref, getPanel } from '../panels/PanelManager.js';
import { refreshFileStructureSummary } from '../FileStructureSummary.js';
import { updateVisualization } from '../../core/crystal-viewer.js';
import { fracToCartPoint, cartToFractional, normalizeFractionalPoint } from '../../math/index.js';
import {
  isWyckoffModeActive,
  symmetrizeCartesianPositions,
  symmetrizeCartesianVectors,
  symmetrizeCartesianStrain,
} from '../SymmetryEditModule.js';
import { TrajectoryContainer } from '../../model/index.js';
import { Atom } from '../../model/index.js';
import { Force } from '../../model/index.js';
import { Stress } from '../../model/index.js';
import { Structure } from '../../model/index.js';
import { refreshBackendTheme } from './BackendTheme.js';
import { JOBS_CHANGED, cancelJob, runningJob, startJob } from '../../host/jobs.js';
import { mdJobResult, mdProgress, relaxJobResult, relaxProgress } from '../../host/commands.js';
import { isVacancy } from '../../render/VacancyMarkerModule.js';

const tableBody = document.querySelector('#objectTable tbody');

let nepRunner = null;
let nepInitPromise = null;

// PET-MAD (mlip.js) state. The runner is a singleton keyed by backend: changing
// the backend requires a fresh runner (a different wasm variant / module),
// while changing the model just reloads weights on the existing runner.
// Models come from atomistic/petModels.js (built-in PET-MAD, catalogues,
// links); the list is PetModelList.js.
// All PET-MAD singleton state lives in one object so a backend change (or a
// failed init) replaces/clears it atomically instead of resetting five vars
// in lockstep. Shape: { backend, initPromise, runner, loadedModelKey,
// modelPromise, modelPromiseKey, modelMeta }.
let mlipState = null;

/** @type {ASERunner|null} */
let aseRunner = null;
/** @type {Promise<ASERunner>|null} */
let aseConnectPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function initNEP() {
  if (nepInitPromise) return nepInitPromise;

  nepInitPromise = (async () => {
    await loadScript('./external/nep_wasm/nep_wasm.js');
    await loadScript('./external/nep_wasm/nep_simple.js');

    const runner = new window.NEPWasmRunner({
      defaultModelUrl: './external/nep_wasm/nep89_20250409.txt',
    });

    await runner.init();
    await runner.loadDefaultModel();
    nepRunner = withAtomLimit(withAppStressConvention(runner), 'nep');
    return nepRunner;
  })();

  return nepInitPromise;
}

// Progress bars in the Atomistic window: the potential's loading bar under
// the potential picker, and MD's and Relax's run progress under their
// buttons. `fraction` in 0..1 fills the bar, null sweeps it (no end known).
function progressMarkup(role, ariaLabel) {
  return `
    <div class="atomistic-progress" data-role="${role}" hidden>
      <div class="atomistic-progress-label" data-role="progress-label"></div>
      <div class="atomistic-progress-track" data-role="progress-bar" role="progressbar"
           aria-label="${ariaLabel}" aria-valuemin="0" aria-valuemax="100">
        <div class="atomistic-progress-fill" data-role="progress-fill"></div>
      </div>
    </div>`;
}

// These bars and the title status below are called from inside relaxation
// and MD steps: they show progress and must never be what stops a run, so
// they tolerate missing pieces instead of throwing.

/** @param {any} box an element from progressMarkup @param {string} label @param {number|null} [fraction] */
function showProgress(box, label, fraction = null) {
  if (!box) return;
  box.hidden = false;
  const labelEl = box.querySelector('[data-role="progress-label"]');
  if (labelEl) labelEl.textContent = label;
  const bar = box.querySelector('[data-role="progress-bar"]');
  const fill = /** @type {HTMLElement|null} */ (box.querySelector('[data-role="progress-fill"]'));
  if (!bar || !fill) return;
  const known = Number.isFinite(fraction);
  bar.classList.toggle('is-indeterminate', !known);
  if (known) {
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    fill.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
  } else {
    fill.style.width = '';
    bar.removeAttribute('aria-valuenow');
  }
}

/** @param {any} box an element from progressMarkup */
function hideProgress(box) {
  if (box) box.hidden = true;
}

// A run's state in the Atomistic window's title bar ("MD 37%", "Relax step
// 12"): seen when the window is collapsed, or scrolled away from the bar.
// Skipped when the window cannot show it: no window yet, or a browser that
// still runs a cached ui/panels/PanelWindow.js from before setStatus existed
// (static hosts let browsers keep modules for minutes after a deploy, and a
// page can then mix new and old modules).
function setAtomisticTitleStatus(text) {
  try {
    const win = /** @type {any} */ (getPanel('backend'));
    if (typeof win?.setStatus === 'function') win.setStatus(text);
  } catch (error) {
    console.warn('Atomistic window title status:', error);
  }
}

// The loading bar under the potential picker. Each loader (nep, mlip, ase)
// reports under its own key; the latest one shows. A model download fills it,
// wasm start-up, weights parsing and a model loading on the ASE server sweep
// it. Found by query, not through a shell, so loads started from other
// windows (EOS, phonons) show here too.
const potentialLoads = new Map();

function setPotentialLoad(key, label, fraction = null) {
  potentialLoads.delete(key);
  potentialLoads.set(key, { label, fraction });
  renderPotentialLoad();
}

function endPotentialLoad(key) {
  if (potentialLoads.delete(key)) renderPotentialLoad();
}

function renderPotentialLoad() {
  const box = document.querySelector('#BackendPotentialSelector [data-role="potential-load"]');
  const current = [...potentialLoads.values()].pop();
  if (current) showProgress(box, current.label, current.fraction);
  else hideProgress(box);
}

const megabytes = (bytes) => (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0);

async function ensureNEPReady(statusEl, stateEl = null) {
  if (nepRunner) {
    if (stateEl) stateEl.textContent = `Built-in model ready: ${nepRunner.modelInfo.name}`;
    return nepRunner;
  }

  if (statusEl) statusEl.textContent = 'Loading built-in NEP model...';
  if (stateEl) stateEl.textContent = 'Built-in model loading...';

  setPotentialLoad('nep', 'Loading the built-in NEP model …');
  let runner;
  try {
    runner = await initNEP();
  } finally {
    endPotentialLoad('nep');
  }

  if (statusEl) statusEl.textContent = 'Built-in NEP model loaded.';
  if (stateEl) stateEl.textContent = `Built-in model ready: ${runner.modelInfo.name}`;
  return runner;
}

function setMLIPStatus(shell, message) {
  if (shell?.mlipStatusEl) shell.mlipStatusEl.textContent = message;
}

// Initialize (or reuse) the PET-MAD runner for the backend/model currently
// selected in the shell controls, then return the ready runner. A backend
// change rebuilds the runner; a model change reloads weights on the existing
// runner. Concurrent loads are de-duplicated per model key via mlipState.
async function ensureMLIPReady(shell) {
  const backend = shell.mlipBackendSelect?.value || 'cpu';
  const modelFile = selectedPetModel(shell.mlipModelSelect);
  const localFile = shell.mlipFileInput?.files?.[0] || null;
  if (!modelFile && !localFile) {
    throw new Error('Paste a link to a .gguf model or a catalogue and press Add, or pick a model.');
  }

  // Keyed by backend and transport (worker or main thread) on the state
  // object, not the runner, so a switch made while the previous init is still
  // in flight also takes effect: the old runner is destroyed once its init
  // settles.
  try {
    return await loadMLIP(shell, backend, modelFile, localFile);
  } finally {
    endPotentialLoad('mlip');
  }
}

/** ensureMLIPReady's work, reporting to the loading bar as it goes. */
async function loadMLIP(shell, backend, modelFile, localFile) {
  const useWorker = general.mlipWorker !== false && typeof Worker !== 'undefined';
  const runnerKey = `${backend}|${useWorker ? 'worker' : 'main'}`;
  if (mlipState && mlipState.key !== runnerKey) {
    const old = mlipState;
    mlipState = null;
    old.initPromise.then((r) => r.destroy()).catch(() => { /* never initialized */ });
  }

  if (!mlipState) {
    setMLIPStatus(shell, `initializing PET-MAD (${backend}) …`);
    const state = {
      backend,
      key: runnerKey,
      initPromise: null,
      runner: null,
      loadedModelKey: null,
      modelPromise: null,
      modelPromiseKey: null,
      // What the loaded model says about itself (petModels.describeGGUF,
      // overlaid by its catalogue entry): name, species, trained elements.
      modelMeta: null,
    };
    state.initPromise = (async () => {
      const threads = /** @type {number|'auto'|false} */ (general.mlipThreads ?? 'auto');
      const blockedGemm = general.mlipBlockedGemm !== false;
      const gpuReadback = general.mlipGpuReadback === 'map' ? 'map' : 'auto';
      const gpuMatmul = general.mlipGpuMatmul === 'reg_tile' ? 'reg_tile' : 'tile4';
      // Off the main thread whenever possible (workers/mlipWorker.js): an
      // evaluation is tens to hundreds of ms and would block paint and input
      // for every relax/MD step. Falls back to the in-thread runner when the
      // worker cannot start (no Worker, or a backend the worker cannot host).
      let runner = null;
      if (useWorker) {
        try {
          runner = withAtomLimit(withAppStressConvention(
            new WorkerMLIPRunner({ backend, threads, blockedGemm, gpuReadback, gpuMatmul })), 'mlip');
          await runner.init();
        } catch (workerError) {
          console.warn('PET-MAD worker unavailable, running the potential on the main thread:', workerError);
          runner = null;
        }
      }
      if (!runner) {
        runner = withAtomLimit(withAppStressConvention(
          new MLIPRunner({ backend, threads, blockedGemm, gpuReadback, gpuMatmul })), 'mlip');
        await runner.init();
      }
      state.runner = runner;
      return runner;
    })();
    // A failed init must not poison the singleton: clear it so the next
    // attempt retries instead of re-awaiting the cached rejection.
    state.initPromise.catch(() => {
      if (mlipState === state) mlipState = null;
    });
    mlipState = state;
  }
  const state = mlipState;
  let runner;
  try {
    if (!state.runner) setPotentialLoad('mlip', `Starting PET-MAD (${backend}) …`);
    runner = await state.initPromise;
  } catch (error) {
    // WebGPU (or 'auto' resolving to it) can fail on adapter/device request;
    // fall back to the CPU build instead of leaving the panel dead. The
    // rejection handler above has already cleared mlipState, so the retry
    // builds a fresh cpu runner.
    if (backend !== 'cpu' && shell.mlipBackendSelect) {
      console.warn(`PET-MAD ${backend} backend failed; falling back to cpu:`, error);
      shell.mlipBackendSelect.value = 'cpu';
      setMLIPStatus(shell, `${backend} init failed (${error.message || error}) — falling back to cpu`);
      return ensureMLIPReady(shell);
    }
    throw error;
  }
  if (mlipState !== state) return ensureMLIPReady(shell);

  const modelKey = localFile
    ? `file:${localFile.name}:${localFile.size}`
    : `url:${modelFile}`;

  while (state.loadedModelKey !== modelKey) {
    if (state.modelPromise && state.modelPromiseKey !== modelKey) {
      // A different model is mid-load on this runner; let it settle, then
      // re-check (loads are serialized — never piggyback on the wrong key).
      try {
        await state.modelPromise;
      } catch (_e) { /* previous load failed; ours proceeds below */ }
      if (mlipState !== state) return ensureMLIPReady(shell);
      continue;
    }
    if (!state.modelPromise) {
      state.modelPromiseKey = modelKey;
      state.modelPromise = (async () => {
        if (localFile) {
          setMLIPStatus(shell, `loading ${localFile.name} …`);
          setPotentialLoad('mlip', `Loading ${localFile.name} …`);
          const info = await inspectPetModelFile(localFile);
          await runner.loadModelFromFile(localFile);
          state.modelMeta = { ...info, name: info.name || localFile.name };
        } else {
          // Catalogue and link entries are URLs, as are the benchmarks' own
          // options (./bench-models/…); the built-in entries are bare file
          // names under the Hugging Face repo. All of them download through
          // fetchPetModel (direct links, checks, checksum, cache) and reach
          // the runner as a File.
          const item = petModelFor(modelFile);
          const url = /^(https?:)?\/\/|^\.{0,2}\//.test(modelFile) ? modelFile : PET_MAD_BASE_URL + modelFile;
          const label = item?.entry.name || modelFile.split('/').pop();
          setPotentialLoad('mlip', `Loading ${label} …`);
          const { file, info, checked } = await fetchPetModel(url, {
            sha256: item?.entry.sha256,
            name: item?.source.kind === 'builtin' ? modelFile : label,
            onProgress: ({ loadedBytes, totalBytes }) => {
              const pct = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0;
              setMLIPStatus(shell, `fetching ${label} … ${pct}%`);
              setPotentialLoad('mlip', totalBytes
                ? `Downloading ${label}: ${megabytes(loadedBytes)} of ${megabytes(totalBytes)} MB`
                : `Downloading ${label}: ${megabytes(loadedBytes)} MB`,
              totalBytes ? loadedBytes / totalBytes : null);
            },
          });
          setMLIPStatus(shell, `loading ${label} …`);
          setPotentialLoad('mlip', `Loading ${label} into PET-MAD …`);
          await runner.loadModelFromFile(file);
          // The catalogue's description wins over what the file says.
          state.modelMeta = { ...info, ...(item ? stripEmpty(item.entry) : {}), checked };
        }
        state.loadedModelKey = modelKey;
      })();
    }
    try {
      await state.modelPromise;
    } finally {
      if (state.modelPromiseKey === modelKey) {
        state.modelPromise = null;
        state.modelPromiseKey = null;
      }
    }
  }

  // general.mlipThreads / mlipBlockedGemm / mlipGpuReadback / mlipGpuMatmul may have changed since this runner
  // was built (the Debug window's benchmark switches them between runs):
  // apply them in place.
  const wantThreads = general.mlipThreads ?? 'auto';
  if (typeof runner.setThreads === 'function' && runner.threads !== wantThreads) {
    await runner.setThreads(/** @type {number|'auto'|false} */ (wantThreads));
  }
  const wantGemm = general.mlipBlockedGemm !== false;
  if (typeof runner.setBlockedGemm === 'function' && runner.blockedGemm !== wantGemm) {
    await runner.setBlockedGemm(wantGemm);
  }
  const wantReadback = general.mlipGpuReadback === 'map' ? 'map' : 'auto';
  if (typeof runner.setGpuReadback === 'function' && runner.gpuReadback !== wantReadback) {
    await runner.setGpuReadback(wantReadback);
  }
  const wantMatmul = general.mlipGpuMatmul === 'reg_tile' ? 'reg_tile' : 'tile4';
  if (typeof runner.setGpuMatmul === 'function' && runner.gpuMatmul !== wantMatmul) {
    await runner.setGpuMatmul(wantMatmul);
  }

  const domainNote = checkPetModelElements(state.modelMeta);
  const readyText = `PET-MAD ready: ${runner.modelInfo.name} (${mlipRuntimeLabel(runner)})${domainNote}`;
  setMLIPStatus(shell, readyText);
  if (shell.sourceStateEl) shell.sourceStateEl.textContent = readyText;
  return runner;
}

/** An entry without its undefined fields, so it does not blank what the file says. */
function stripEmpty(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * The selected structure against the loaded model: an element the model has
 * no parameters for stops the run here with its name (instead of an opaque
 * failure inside predict); one outside the elements a fine-tuned model was
 * trained for (catalogue `elements`, or the exporter's pet.training_species)
 * is only noted, since the model still runs there, as extrapolation.
 * @param {{ name?: string, species?: string[], elements?: string[] }|null|undefined} meta
 * @returns {string} a note for the status line, or ''
 */
function checkPetModelElements(meta) {
  const structure = fileBrowser.selectedStructure;
  if (!meta || !structure?.elements) return '';
  const present = structure.elements
    .filter((e) => !isVacancy(e))
    .map((e) => String(e).charAt(0).toUpperCase() + String(e).slice(1).toLowerCase());
  const missing = elementsOutside(present, meta.species);
  if (missing.length) {
    throw new Error(`${meta.name || 'This model'} has no parameters for ${missing.join(', ')}.`);
  }
  const outside = elementsOutside(present, meta.elements);
  return outside.length
    ? ` — trained for ${meta.elements.join(', ')}; ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside that`
    : '';
}

// "cpu, 4 threads, worker" — where and how a PET-MAD runner evaluates, for
// the status lines (so a user can see whether the multi-threaded build is on).
function mlipRuntimeLabel(runner) {
  const d = typeof runner?.describe === 'function' ? runner.describe() : null;
  if (!d) return '';
  const where = runner.offThread ? 'worker' : 'main thread';
  if (d.variant === 'gpu') return `webgpu, ${where}`;
  const threads = Math.max(1, Number(d.threads) || 1);
  return `cpu, ${threads} thread${threads === 1 ? '' : 's'}, ${where}`;
}

// Return the ready runner for the active potential (nep -> NEP wasm singleton,
// mlip -> PET-MAD runner, ase -> the ASE server). All expose the same
// { modelInfo, compute } surface buildNEPStructure / relaxUntilConverged /
// createNEPForceEvaluator consume.
async function ensureCalculatorReady(potential, shell) {
  if (potential === 'mlip') return ensureMLIPReady(shell);
  if (potential === 'ase') return ensureASEReady(shell);
  return ensureNEPReady(shell.statusEl, shell.sourceStateEl);
}

// Write-only stand-in for a panel status element: the ensure* helpers report
// progress by assigning .textContent, so a setter that forwards to a callback
// lets them run without any panel DOM.
function statusElAdapter(onStatus) {
  return { set textContent(text) { onStatus(String(text)); } };
}

// Interatomic potentials and ML force fields need one definite species per
// site — there is no defined force on an atom that is half Fe and half Ni —
// so refuse rather than return numbers for a structure the model cannot
// describe. Shared by every run entry point below (headless calculator
// access, and the Relax/EFS/MD panel's own buttons — local NEP/PET-MAD *and*
// the remote ASE dispatch, which otherwise has no calculator-readiness check
// at all to hang this on).
function assertOrderedStructure() {
  if (structureHasFractionalOccupancy()) {
    throw new Error(
      'This structure has fractionally occupied sites, which interatomic potentials cannot represent. '
      + 'Use "Order structure" to generate an ordered approximation first.'
    );
  }
}

/** Atoms the potential would see (vacancies are left out, see buildNEPStructure). */
function potentialAtomCount(structure = fileBrowser.selectedStructure) {
  if (!structure?.atoms) return 0;
  const elements = structure.elements || [];
  let n = 0;
  for (let i = 0; i < structure.atoms.length; i += 1) if (!isVacancy(elements[i])) n += 1;
  return n;
}

/** Refuse, before anything is set up, a structure the potential cannot take. */
export function assertStructureFitsPotential(potential) {
  assertPotentialSize(potential, potentialAtomCount());
}

/** Say up front, when the panel opens, that the selected structure is too big. */
function showPotentialSizeNotice(shell, potential) {
  const problem = potentialSizeProblem(potential, potentialAtomCount());
  if (problem && shell.resultEl) shell.resultEl.textContent = problem;
}

// Shared by ensureActiveCalculator and ensureCalculatorRunner below: resolves
// general.atomisticPotential to a ready { runner, potential }. When the
// Relax/MD panel IS built, its PET-MAD backend/model controls are reused so a
// headless load matches (and shares the singleton with) whatever the user
// picked there. 'ase' throws — it computes on a remote server, not in the
// browser.
/** @param {(text: string) => void} [onStatus] */
async function resolveCalculatorRunner(onStatus = () => {}) {
  const potential = general.atomisticPotential || 'nep';
  const statusEl = statusElAdapter(onStatus);
  // The PET-MAD backend/model controls live in the persistent potential
  // selector (buildSourcePanel), not in the action body.
  const panel = document.getElementById('BackendPotentialSelector')
    ?? document.getElementById('BackendCalcPanel');
  const shell = {
    statusEl,
    sourceStateEl: statusEl,
    mlipStatusEl: statusEl,
    mlipBackendSelect: panel?.querySelector('[data-role="mlip-backend"]') ?? null,
    mlipModelSelect: panel?.querySelector('[data-role="mlip-model"]') ?? null,
    mlipFileInput: panel?.querySelector('[data-role="mlip-file"]') ?? null,
    aseUrlInput: panel?.querySelector('[data-role="ase-url"]') ?? null,
    backendStateEl: panel?.querySelector('[data-role="backend-state"]') ?? null,
  };
  const runner = await ensureCalculatorReady(potential, shell);
  return { runner, potential };
}

/**
 * Headless access to the active in-browser calculator (EOS scans, addons):
 * resolves general.atomisticPotential to a ready { runner, potential } without
 * needing the Relax/MD panel open.
 * @param {(text: string) => void} [onStatus]
 */
export async function ensureActiveCalculator(onStatus = () => {}) {
  assertOrderedStructure();
  return resolveCalculatorRunner(onStatus);
}

/**
 * Same headless calculator access as ensureActiveCalculator, but WITHOUT the
 * ordered-structure guard — for computing on structures that are already
 * known to be ordered (Order Structure's random-sample energy comparison
 * builds fully-ordered candidates from a disordered source; asserting against
 * fileBrowser.selectedStructure there would reject on the still-disordered
 * structure the candidates were built FROM, not the candidates themselves).
 * @param {(text: string) => void} [onStatus]
 */
export async function ensureCalculatorRunner(onStatus = () => {}) {
  return resolveCalculatorRunner(onStatus);
}

// The ASE server sends ASE's get_stress(): eV/Å³, tension-positive. Stored in
// the app convention (eV/Å³, compression positive — model/Stress.js).
function setCurrentEFS(out, keptIndices = null) {
  if (Array.isArray(out?.forces)) {
    // The potential returns one force per NON-vacancy atom; expand back to the
    // full atom list (vacancies get a zero force) so structure.forces stays
    // index-aligned with structure.atoms for the Forces panel and arrows.
    const forces = expandKeptVectorsToFull(
      fileBrowser.selectedStructure.atoms.length, out.forces, keptIndices);
    fileBrowser.selectedStructure.forces = forces.map((v) => new Force({ vector: [...v] }));
  }
  // The potential energy, so the Files window's Parameters section (and every
  // relax/MD frame snapshotted from this structure) carries it alongside the
  // forces and stress.
  if (Number.isFinite(Number(out?.total_energy))) {
    fileBrowser.selectedStructure.energy = Number(out.total_energy);
  }
  // Stress is optional — some calculators don't provide it. Don't throw when
  // it's absent; just leave the structure without a stress tensor. It arrives
  // in the app convention (eV/Å³, compression positive; see
  // atomistic/calculatorStress.js) and is stored as is.
  if (Array.isArray(out?.stress?.matrix3x3)) {
    fileBrowser.selectedStructure.stress = new Stress({
      tensor: out.stress.matrix3x3.map((row) => [...row]),
    });
    // A new pressure: the NEP high-pressure warning may now apply.
    notifyPotentialChange();
  }
  // Where these numbers came from, for the Parameters section's "Source:"
  // and the .crysviz session (model/dataSource.js): the potential that ran.
  if (Array.isArray(out?.forces) || Number.isFinite(Number(out?.total_energy)) || Array.isArray(out?.stress?.matrix3x3)) {
    fileBrowser.selectedStructure.dataSource = potentialSource();
  }

  if (general.forcesActive) {
    updateForces();
  }
  // Same geometry, new energy/forces/stress: the Parameters section must show
  // them (its own refresh only fires on geometry changes).
  refreshFileStructureSummary();
}

// Exported for the browser test: this is the working copy MD/relax actually
// animate, and what it silently drops (symmetry, velocities) is invisible from
// anywhere else in the UI.
export function snapshotCurrentStructure() {
  const src = fileBrowser.selectedStructure;
  const elements = [...src.elements];
  const atoms = src.atoms.map((atom, index) => new Atom({
    position: [...atom.position],
    element: elements[index],
    uuid: atom.uuid,
  }));
  const forces = (src.forces ?? []).map((force) => new Force({ vector: [...force.vector] }));
  const stress = src.stress ? new Stress({ tensor: src.stress.tensor.map((row) => [...row]) }) : null;
  // Carried like forces (not reset here) so an MD frame's velocities survive
  // into its saved trajectory frame — that's what "Continue MD" resumes from.
  const velocities = src.velocities ? src.velocities.map((v) => [...v]) : null;

  return new Structure({
    elements,
    uniqueElements: [...new Set(elements)],
    lattice: src.lattice.map((row) => [...row]),
    atoms,
    forces,
    stress,
    energy: Number.isFinite(src.energy) ? src.energy : null,
    // The source of that energy as this structure shows it (its own, else its
    // file's), so a frame keeps it whatever trajectory it lands in.
    dataSource: dataSourceOf(src, getContainerForStructure(src)),
    velocities,
    // MD/relax animate a snapshot, not the source, and every symmetrize call
    // in MD.js keys off `structure.symmetry.mode === 'wyckoff'`. Dropping it
    // here left the working copy looking unconstrained, so Wyckoff-mode runs
    // silently integrated without symmetry and even zero-freedom sites moved.
    // Shared by reference: it is derived, read-only data (operations, orbits,
    // site-freedom bases) that no run mutates.
    symmetry: src.symmetry ?? null,
    periodic: { hash: 'None', wrapped: null },
  });
}

// Copy a snapshot's positions/lattice/forces back into a structure in place
// (preserving object identity + styles). Used to undo the in-place mutation MD
// makes to the source structure while it animates the viewer.
function restoreStructureInPlace(target, src) {
  if (!target || !src) return;
  if (Array.isArray(src.lattice)) target.lattice = src.lattice.map((row) => [...row]);
  if (Array.isArray(src.atoms)) {
    src.atoms.forEach((atom, index) => {
      if (target.atoms[index] && Array.isArray(atom.position)) {
        target.atoms[index].position = [...atom.position];
      }
    });
  }
  target.forces = (src.forces ?? []).map((force) => new Force({ vector: [...force.vector] }));
  // The run's setCurrentEFS calls wrote its own stress and energy onto the
  // source too; put back what the structure had before the run.
  target.stress = src.stress?.tensor ? new Stress({ tensor: src.stress.tensor.map((row) => [...row]) }) : null;
  target.energy = Number.isFinite(src.energy) ? src.energy : null;
  target.dataSource = src.dataSource ?? null;
  // Drop the wrapped-position cache so the restored structure re-wraps from its
  // own positions instead of a leftover MD frame's.
  target.periodic = { hash: 'None', wrapped: null };
}

// ASE: backend/server.py as a calculator (atomistic/aseClient.js), used by
// every workflow through ensureCalculatorReady like NEP and PET-MAD. One
// connection per page; the URL is remembered.
function aseServerUrl(shell) {
  const typed = shell?.aseUrlInput?.value?.trim();
  return typed || getPanelPref('aseServerUrl') || DEFAULT_ASE_URL;
}

function setASEState(shell, text) {
  if (shell?.backendStateEl) shell.backendStateEl.textContent = text;
}

async function ensureASEReady(shell) {
  const url = aseServerUrl(shell);
  if (aseRunner && aseRunner.url !== url) disconnectASE(shell);
  if (aseRunner?.connected && aseRunner.modelInfo) return aseRunner;
  if (!aseConnectPromise) {
    aseConnectPromise = (async () => {
      setASEState(shell, `Backend: connecting to ${url} …`);
      setPotentialLoad('ase', `Connecting to the ASE server at ${url} …`);
      const runner = withAppStressConvention(new ASERunner({ url }));
      try {
        await runner.init();
      } catch (error) {
        setASEState(shell, 'Backend: not connected');
        throw error;
      }
      runner.onDisconnect = () => {
        if (aseRunner === runner) aseRunner = null;
        setASEState(shell, 'Backend: disconnected');
        showASEModels(shell, null);
      };
      setPanelPref('aseServerUrl', url);
      // The model picked last time, when this server offers it too.
      const wanted = getPanelPref('aseModel');
      if (wanted && wanted !== runner.modelId && runner.models.some((m) => m.id === wanted)) {
        setASEState(shell, `Backend: loading ${wanted} on the server …`);
        setPotentialLoad('ase', `Loading ${wanted} on the ASE server …`);
        try {
          await runner.setModel(wanted);
        } catch (error) {
          console.warn('ASE: the remembered model did not load; using the server default:', error);
        }
      }
      aseRunner = runner;
      setASEState(shell, `Backend: ${runner.modelInfo.name} at ${url}`);
      showASEModels(shell, runner);
      notifyPotentialChange();
      return runner;
    })().finally(() => {
      aseConnectPromise = null;
      endPotentialLoad('ase');
    });
  }
  return aseConnectPromise;
}

function disconnectASE(shell) {
  const runner = aseRunner;
  aseRunner = null;
  runner?.destroy();
  setASEState(shell, 'Backend: disconnected');
  showASEModels(shell, null);
  notifyPotentialChange();
}

/**
 * The server's models in the ASE controls: shown when it offers more than
 * one (python backend/server.py --model A --model B), hidden otherwise.
 * @param {any} shell
 * @param {ASERunner|null} runner
 */
function showASEModels(shell, runner) {
  const select = /** @type {HTMLSelectElement|null} */ (shell?.aseModelSelect ?? null);
  const row = shell?.aseModelRow ?? null;
  if (!select || !row) return;
  const models = runner?.modelId != null ? runner.models : [];
  row.classList.toggle('hidden', models.length < 2);
  select.innerHTML = '';
  for (const m of models) {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.loaded ? m.label : `${m.id} (loads on first use)`;
    if (m.error) option.title = m.error;
    select.appendChild(option);
  }
  if (runner?.modelId != null) select.value = runner.modelId;
}

/** Switch the connected server's model from the ASE controls. */
async function switchASEModel(shell, id) {
  const runner = aseRunner;
  if (!runner) return;
  const previous = runner.modelId;
  setASEState(shell, `Backend: loading ${id} on the server …`);
  setPotentialLoad('ase', `Loading ${id} on the ASE server …`);
  shell.aseModelSelect.disabled = true;
  try {
    await runner.setModel(id);
    setPanelPref('aseModel', id);
    setASEState(shell, `Backend: ${runner.modelInfo.name} at ${runner.url}`);
  } catch (error) {
    setASEState(shell, `Backend: ${id} did not load: ${error.message || error}`);
    console.warn(error);
  } finally {
    endPotentialLoad('ase');
    shell.aseModelSelect.disabled = false;
    showASEModels(shell, runner);
    if (runner.modelId !== id && previous != null) shell.aseModelSelect.value = previous;
    notifyPotentialChange();
  }
}

/** The PET-MAD model the next run uses, for the potential notices. */
function mlipModelLabel(shell) {
  const file = shell?.mlipFileInput?.files?.[0];
  if (file) return `${file.name} (local file, in your browser)`;
  const option = shell?.mlipModelSelect?.selectedOptions?.[0];
  const name = option && option.value !== PET_LINK_OPTION
    ? option.textContent.replace(/\s*\(\d+ [kM]B\)$/, '')
    : 'PET-MAD xs';
  return `${name} (in your browser)`;
}

/** The ASE server's model, for the potential notices. */
function aseModelLabel(shell) {
  if (aseRunner?.connected && aseRunner.modelInfo) return `${aseRunner.modelInfo.name} on ${aseRunner.url}`;
  return `a model on your ASE server at ${aseServerUrl(shell)} (not connected)`;
}

/**
 * Pressures in play for the selected structure, GPa (compression positive):
 * the relax target, the NPT target, and the pressure computed last.
 * @returns {{ label: string, gpa: number }[]}
 */
function atomisticPressures() {
  const body = document.getElementById('BackendCalcPanel');
  const out = [];
  const relax = /** @type {HTMLInputElement|null} */ (body?.querySelector('#relaxTargetPressureInput') ?? null);
  if (relax) out.push({ label: 'target pressure', gpa: Number(relax.value) });
  const npt = /** @type {HTMLInputElement|null} */ (body?.querySelector('#mdPressureInput') ?? null);
  if (npt && !npt.disabled) out.push({ label: 'NPT pressure', gpa: Number(npt.value) });
  const stress = fileBrowser.selectedStructure?.stress;
  if (stress) out.push({ label: 'the structure\'s pressure', gpa: Number(stress.pressureGPa) });
  return out;
}

// The potential picker lives in its OWN persistent element (#BackendPotentialSelector),
// rendered once and ABOVE the Relax/MD switch — the user picks the potential
// first, then an action, and the choice (general.atomisticPotential) survives
// switching Relax<->MD and is what Order Structure / EOS read too.
function buildSourcePanel() {
  return `
    <div class="atomistic-panel">
      <div class="atomistic-source-panel">
        <div class="atomistic-source-row">
          <div class="atomistic-source-label" data-role="potential-label">Choose potential</div>
          <div class="backend-potential-toggle" data-role="potential-toggle">
            <button type="button" class="active" data-potential="nep">NEP</button>
            <button type="button" data-potential="mlip">PET-MAD</button>
            <button type="button" data-potential="ase">ASE</button>
          </div>
        </div>
        <div class="atomistic-source-copy">
          <div class="atomistic-source-state" data-role="source-state"></div>
        </div>
        ${progressMarkup('potential-load', 'Loading the potential')}
        <div data-role="potential-notice-host"></div>
        <div class="atomistic-backend-actions hidden" data-role="mlip-source">
          <label class="atomistic-inline-toggle">
            <span>model</span>
            <select class="atomistic-input-sm" data-role="mlip-model">
              <optgroup label="PET-MAD" data-role="mlip-builtin-models">
                <option value="pet-mad-xs.gguf">PET-MAD xs (17 MB)</option>
                <option value="pet-mad-s.gguf">PET-MAD s (100 MB)</option>
              </optgroup>
              <option value="${PET_LINK_OPTION}">from a link…</option>
            </select>
          </label>
          <div class="atomistic-model-link hidden" data-role="mlip-link-row">
            <input type="url" class="atomistic-input-sm" data-role="mlip-link" spellcheck="false" autocomplete="off"
                   placeholder="link to a .gguf model or a catalogue .json" aria-label="Model or catalogue link">
            <button type="button" class="calcButton" data-role="mlip-link-add">Add</button>
          </div>
          <div class="atomistic-model-info" data-role="mlip-model-info">
            <span data-role="mlip-model-info-text"></span>
            <button type="button" class="atomistic-text-button hidden" data-role="mlip-forget"
                    title="Remove this catalogue (all its models) or link from the list">forget</button>
          </div>
          <label class="atomistic-inline-toggle">
            <span>backend</span>
            <select class="atomistic-input-sm" data-role="mlip-backend">
              <option value="cpu">cpu</option>
              <option value="auto">auto</option>
              <option value="webgpu">webgpu</option>
            </select>
          </label>
          <button type="button" class="calcButton" data-role="mlip-load">Load model</button>
          <label class="atomistic-inline-toggle">
            <span>local .gguf</span>
            <input type="file" accept=".gguf" class="atomistic-input-sm" data-role="mlip-file">
          </label>
          <label class="atomistic-inline-toggle" data-role="mlip-multithread-row"
                 title="Run the CPU build on several cores. Needs a cross-origin isolated page, so turning it on or off reloads CrysViz.">
            <span>multi-threaded</span>
            <input type="checkbox" data-role="mlip-multithread">
          </label>
          <label class="atomistic-inline-toggle" data-role="mlip-threads-row">
            <span>threads</span>
            <select class="atomistic-input-sm atomistic-threads-select" data-role="mlip-threads"></select>
          </label>
          <div class="atomistic-backend-state" data-role="mlip-status">PET-MAD: not loaded</div>
        </div>
        <div class="atomistic-backend-actions hidden" data-role="ase-connectors">
          <label class="atomistic-inline-toggle" title="Where backend/server.py listens (python backend/server.py --help).">
            <span>server</span>
            <input type="text" class="atomistic-input-sm" data-role="ase-url" spellcheck="false" autocomplete="off">
          </label>
          <label class="atomistic-inline-toggle atomistic-ase-model hidden" data-role="ase-model-row"
                 title="Models this server offers: start it with several, e.g. python backend/server.py --model mace-mp --model orb (--list shows all)">
            <span>model</span>
            <select class="atomistic-input-sm" data-role="ase-model"></select>
          </label>
          <button type="button" class="calcButton" data-role="connect-ase">Connect</button>
          <button type="button" class="calcButton" data-role="disconnect-ase">Disconnect</button>
          <div class="atomistic-backend-state" data-role="backend-state">Backend: not connected</div>
        </div>
      </div>
    </div>
  `;
}

function buildBodyShell() {
  return `
    <div class="atomistic-panel">
      <div class="atomistic-body" data-role="body"></div>
    </div>
  `;
}

// One shell object over the two persistent containers: the potential picker
// (#BackendPotentialSelector) and the action body (#BackendCalcPanel).
function getShellBindings() {
  const selector = document.getElementById('BackendPotentialSelector');
  const calc = document.getElementById('BackendCalcPanel');
  const sourceStateEl = selector?.querySelector('[data-role="source-state"]');
  return {
    toggle: selector?.querySelector('[data-role="potential-toggle"]'),
    sourceStateEl,
    potentialNoticeHost: selector?.querySelector('[data-role="potential-notice-host"]'),
    potentialLabel: selector?.querySelector('[data-role="potential-label"]'),
    aseConnectorsEl: selector?.querySelector('[data-role="ase-connectors"]'),
    aseUrlInput: selector?.querySelector('[data-role="ase-url"]'),
    aseModelRow: selector?.querySelector('[data-role="ase-model-row"]'),
    aseModelSelect: selector?.querySelector('[data-role="ase-model"]'),
    backendStateEl: selector?.querySelector('[data-role="backend-state"]'),
    mlipSourceEl: selector?.querySelector('[data-role="mlip-source"]'),
    mlipModelSelect: selector?.querySelector('[data-role="mlip-model"]'),
    mlipLinkRow: selector?.querySelector('[data-role="mlip-link-row"]'),
    mlipLinkInput: selector?.querySelector('[data-role="mlip-link"]'),
    mlipLinkAddBtn: selector?.querySelector('[data-role="mlip-link-add"]'),
    mlipModelInfoText: selector?.querySelector('[data-role="mlip-model-info-text"]'),
    mlipForgetBtn: selector?.querySelector('[data-role="mlip-forget"]'),
    mlipBackendSelect: selector?.querySelector('[data-role="mlip-backend"]'),
    mlipLoadBtn: selector?.querySelector('[data-role="mlip-load"]'),
    mlipFileInput: selector?.querySelector('[data-role="mlip-file"]'),
    mlipStatusEl: selector?.querySelector('[data-role="mlip-status"]'),
    mlipMultithreadInput: selector?.querySelector('[data-role="mlip-multithread"]'),
    mlipMultithreadRow: selector?.querySelector('[data-role="mlip-multithread-row"]'),
    mlipThreadsSelect: selector?.querySelector('[data-role="mlip-threads"]'),
    mlipThreadsRow: selector?.querySelector('[data-role="mlip-threads-row"]'),
    bodyEl: calc?.querySelector('[data-role="body"]'),
    statusEl: sourceStateEl,
    resultEl: sourceStateEl,
  };
}

function readRelaxParams(bodyEl) {
  return {
    maxSteps: Number(bodyEl.querySelector('#relaxMaxStepsInput')?.value || 200),
    forceTol: Number(bodyEl.querySelector('#relaxForceTolInput')?.value || 0.01),
    targetPressure: Number(bodyEl.querySelector('#relaxTargetPressureInput')?.value || 0),
    stressTol: Number(bodyEl.querySelector('#relaxStressTolInput')?.value || 0.2),
  };
}

// Default cell-strain magnitude for the Rattle "cell" option (±2%); editable
// in the UI.
const RATTLE_LATTICE_PCT = 0.02;

// Standard normal sample (Box–Muller) for the atom-displacement rattle.
function gaussianRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Apply a random perturbation to the selected structure: a Gaussian displacement
// (std = amp Å) to every atom and, when doLattice is set, a small symmetric
// random strain (±RATTLE_LATTICE_PCT) to the cell. Mutates the structure in
// place (the user's explicit intent — rattle then relax) and re-renders.
//
// In Wyckoff mode both the displacement field and the strain are projected onto
// what the space group allows, so rattling stays inside the symmetry the user
// locked — same contract as constrained MD/relax. Note the projection shrinks
// the perturbation (a site with no freedom does not move at all, and a hexagonal
// cell only breathes along its allowed strains), so the effective amplitude is
// below `amp` by design rather than being renormalised back up.
function rattleSelectedStructure(amp, doLattice, latticePct = RATTLE_LATTICE_PCT) {
  const s = fileBrowser.selectedStructure;
  if (!s || !Array.isArray(s.atoms) || !s.atoms.length) return;
  const lattice = s.lattice.map((r) => [...r]);
  const constrained = isWyckoffModeActive(s);

  const cartPositions = s.atoms.map((atom) => fracToCartPoint(atom.position, lattice));
  let displacements = s.atoms.map(() => [
    gaussianRandom() * amp,
    gaussianRandom() * amp,
    gaussianRandom() * amp,
  ]);
  if (constrained) displacements = symmetrizeCartesianVectors(displacements, lattice, s);

  let moved = cartPositions.map((cart, i) => [
    cart[0] + displacements[i][0],
    cart[1] + displacements[i][1],
    cart[2] + displacements[i][2],
  ]);
  // Re-project the positions themselves: the displacement field alone leaves
  // each orbit consistent only to float precision, and the symmetry analysis
  // downstream runs at a tolerance that deserves better than that.
  if (constrained) moved = symmetrizeCartesianPositions(moved, lattice, s);

  s.atoms.forEach((atom, i) => {
    // Wrap back into [0,1). An atom sitting near a face is as likely to be
    // kicked out of the cell as into it, and nothing downstream folds it back:
    // periodicWrapped() only mirrors atoms that lie ON a face/edge/corner, it
    // does not normalize out-of-cell coordinates, so the atom would simply
    // render outside the box. Under PBC the wrapped position is the same
    // physical site.
    atom.position = normalizeFractionalPoint(cartToFractional(moved[i], lattice));
  });

  if (doLattice) {
    // Symmetric random strain E (independent components in [-pct, pct]);
    // new lattice = old · (I + E).
    const pct = latticePct;
    let E = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        const e = (Math.random() * 2 - 1) * pct;
        E[i][j] = e;
        E[j][i] = e;
      }
    }
    if (constrained) E = symmetrizeCartesianStrain(E, lattice, s);
    s.lattice = lattice.map((row) => [0, 1, 2].map(
      (j) => row[j] + row[0] * E[0][j] + row[1] * E[1][j] + row[2] * E[2][j],
    ));
  }

  // Forces/stress/velocities are stale after moving atoms; drop them (velocities
  // also so a rattled MD tip doesn't look like a "Continue MD"-able last frame)
  // and re-render geometry.
  s.forces = [];
  s.stress = null;
  s.velocities = null;
  s.periodic = { hash: 'None', wrapped: null };
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderLattice: true });
}

function renderRelaxBody(bodyEl, potential) {
  bodyEl.innerHTML = `
    <button type="button" class="atomistic-card atomistic-efs-card" id="relaxEfsCard">
      <div class="atomistic-card-title-row">
        <span class="atomistic-card-title">EFS</span>
        <div class="atomistic-efs-title-right">
          <span class="atomistic-card-pill">${potential === 'ase' ? 'server' : 'in-browser'}</span>
          <span class="atomistic-efs-refresh-hint">↻ click to compute</span>
        </div>
      </div>
      <div class="atomistic-card-metrics" id="relaxEfsMetrics">
        <div>energy / atom: —</div>
        <div>max force: —</div>
        <div>pressure: —</div>
      </div>
    </button>
    <div class="atomistic-card atomistic-card-compact">
      <div class="atomistic-card-title atomistic-card-title-accent">Geometry optimization</div>
      <div class="atomistic-grid atomistic-grid-2 atomistic-grid-compact">
        <label>
          <span>max steps</span>
          <input type="number" class="atomistic-input-sm" id="relaxMaxStepsInput" value="200" step="10" min="1">
        </label>
        <label>
          <span>force tol</span>
          <input type="number" class="atomistic-input-sm" id="relaxForceTolInput" value="0.01" step="0.001" min="0">
        </label>
        <label>
          <span>target P</span>
          <input type="number" class="atomistic-input-sm" id="relaxTargetPressureInput" value="0" step="0.1">
        </label>
        <label>
          <span>stress tol</span>
          <input type="number" class="atomistic-input-sm" id="relaxStressTolInput" value="0.2" step="0.1" min="0">
        </label>
      </div>
      <div class="atomistic-button-row atomistic-button-row-compact">
        <button type="button" class="calcButton" id="relaxBtn">Relax</button>
        <button type="button" class="calcButton" id="relaxStopBtn" disabled>Stop</button>
      </div>
      ${progressMarkup('relax-progress', 'Relaxation progress')}
    </div>
    <div class="atomistic-card atomistic-card-compact">
      <div class="atomistic-card-title atomistic-card-title-accent">Rattle</div>
      <div class="atomistic-grid atomistic-grid-3 atomistic-grid-compact atomistic-rattle-grid">
        <label title="Gaussian displacement applied to every atom; the value is the standard deviation in Å.">
          <span>coordinate (Å)</span>
          <input type="number" class="atomistic-input-sm" id="relaxRattleAmpInput" value="0.1" step="0.01" min="0">
        </label>
        <label title="Random symmetric strain on the cell: each independent strain component is drawn uniformly from ±this percent, so both lattice lengths and angles change.">
          <span class="atomistic-rattle-toggle-label">
            lattice (±%)
            <input type="checkbox" id="relaxRattleLatticeChk">
          </span>
          <input type="number" class="atomistic-input-sm" id="relaxRattleLatticePctInput" value="2" step="0.5" min="0">
        </label>
        <div class="atomistic-rattle-action">
          <button type="button" class="calcButton" id="relaxRattleBtn">Rattle</button>
        </div>
      </div>
    </div>
  `;
}

// Expanding the Simulated Annealing section is what ENABLES annealing — the
// run reads `!annealControls.classList.contains('hidden')`. That is a lot of
// meaning to hang on a disclosure triangle, so the header carries an explicit
// "on" badge and turns green while it applies, and the section spells out the
// schedule that replaces the fixed temperature above it.
function renderMDAnnealSummary(bodyEl) {
  const controls = bodyEl.querySelector('#mdAnnealControls');
  const icon = bodyEl.querySelector('#mdAnnealIcon');
  const header = bodyEl.querySelector('#mdAnnealHeader');
  if (!controls || !icon) return;
  const enabled = !controls.classList.contains('hidden');
  icon.textContent = enabled ? '▾' : '▸';
  header?.classList.toggle('active', enabled);

  const hint = bodyEl.querySelector('#mdAnnealHint');
  if (hint) {
    const tMin = Number(bodyEl.querySelector('#mdAnnealMinInput')?.value) || 0;
    const tMax = Number(bodyEl.querySelector('#mdAnnealMaxInput')?.value) || 0;
    const peak = Number(bodyEl.querySelector('#mdAnnealPeakPctInput')?.value) || 0;
    const start = Number(bodyEl.querySelector('#mdTemperatureInput')?.value) || 0;
    hint.textContent = enabled
      ? `while this section is open the temperature above is only the start: ${start} K → ${tMax} K at ${peak}% of the run → ${tMin} K`
      : '';
  }
}

function renderMDBody(bodyEl, potential) {
  bodyEl.innerHTML = `
    <div class="atomistic-card atomistic-card-compact">
      <div class="atomistic-source-row">
        <div class="atomistic-source-label">Ensemble</div>
        <div class="backend-potential-toggle" id="mdEnsembleSwitch">
          <button type="button" class="active" data-ensemble="nvt">NVT</button>
          <button type="button" data-ensemble="npt">NPT</button>
        </div>
      </div>
      <div class="atomistic-ensemble-hint" id="mdEnsembleHint"></div>
      <div class="atomistic-grid atomistic-grid-2 atomistic-grid-compact">
        <label>
          <span>Steps</span>
          <input type="number" class="atomistic-input-sm" id="mdStepsInput" value="500" step="50" min="1">
        </label>
        <label>
          <span>timestep (fs)</span>
          <input type="number" class="atomistic-input-sm" id="mdTimestepInput" value="${recommendedTimestepFs(fileBrowser.selectedStructure?.elements)}" step="0.1" min="0.05">
        </label>
        <label>
          <span>temperature (K)</span>
          <input type="number" class="atomistic-input-sm" id="mdTemperatureInput" value="300" step="10" min="1">
        </label>
        <label id="mdPressureField">
          <span>pressure (GPa)</span>
          <input type="number" class="atomistic-input-sm" id="mdPressureInput" value="0" step="0.1" disabled>
        </label>
        <label>
          <span>Save every (steps)</span>
          <input type="number" class="atomistic-input-sm" id="mdSaveStrideInput" value="${Math.max(1, Number(general.backendTrajectorySaveStride || 4))}" step="1" min="1">
        </label>
      </div>
      <div class="atomistic-anneal-section">
        <button type="button" class="atomistic-collapse-toggle" id="mdCouplingHeader">
          <span id="mdCouplingIcon">▸</span>
          <span class="atomistic-card-title-accent atomistic-anneal-title">Coupling times</span>
        </button>
        <div class="hidden" id="mdCouplingControls">
          <div class="atomistic-grid atomistic-grid-2 atomistic-grid-compact">
            <label>
              <span>thermostat τ (fs)</span>
              <input type="number" class="atomistic-input-sm" id="mdTauTInput" value="${DEFAULT_THERMOSTAT_TAU_FS}" step="10" min="1">
            </label>
            <label id="mdTauPField">
              <span>barostat τ (fs)</span>
              <input type="number" class="atomistic-input-sm" id="mdTauPInput" value="${DEFAULT_BAROSTAT_TAU_FS}" step="100" min="10" disabled>
            </label>
          </div>
          <div class="atomistic-ensemble-hint" id="mdCouplingHint"></div>
        </div>
      </div>
      <div class="atomistic-anneal-section">
        <button type="button" class="atomistic-collapse-toggle" id="mdAnnealHeader">
          <span id="mdAnnealIcon">▸</span>
          <span class="atomistic-card-title-accent atomistic-anneal-title">Simulated Annealing</span>
          <span class="atomistic-anneal-badge" id="mdAnnealBadge">on</span>
        </button>
        <div class="hidden" id="mdAnnealControls">
          <div class="atomistic-grid atomistic-grid-3 atomistic-grid-compact atomistic-anneal-grid">
            <label>
              <span>Tmin (K)</span>
              <input type="number" class="atomistic-input-sm" id="mdAnnealMinInput" value="100" step="10" min="1">
            </label>
            <label>
              <span>Tmax (K)</span>
              <input type="number" class="atomistic-input-sm" id="mdAnnealMaxInput" value="1200" step="10" min="1">
            </label>
            <label>
              <span>Peak at %</span>
              <input type="number" class="atomistic-input-sm" id="mdAnnealPeakPctInput" value="30" step="1" min="1" max="99">
            </label>
          </div>
          <div class="atomistic-ensemble-hint" id="mdAnnealHint"></div>
        </div>
      </div>
      <div class="atomistic-button-row atomistic-button-row-compact">
        <button type="button" class="calcButton" id="mdStartBtn">start</button>
        <button type="button" class="calcButton" id="mdStopBtn" disabled>stop</button>
      </div>
      ${progressMarkup('md-progress', 'MD progress')}
    </div>
  `;
}

/**
 * @param {any} shell @param {any} params @param {string} potential
 * @param {any} job its job (host/jobs.js): progress goes there too, and Stop
 *   (cancelJob) ends it after the current step; the steps so far are kept.
 */
async function runLocalRelax(shell, params, potential, job) {
  const metricsEl = shell.bodyEl.querySelector('#relaxEfsMetrics');
  // How far it got. A relaxation has no known end (it stops when converged),
  // so the bar sweeps and the label carries the step and the max force.
  const progressBox = shell.bodyEl.querySelector('[data-role="relax-progress"]');
  try {
    showProgress(progressBox, 'Relaxation: getting the potential ready …');
    setAtomisticTitleStatus('Relax …');
    const runner = await ensureCalculatorReady(potential, shell);
    shell.statusEl.textContent = 'Relaxation running...';
    shell.resultEl.textContent = '';
    const relaxed = await runRelax(params, {
      runner,
      potential,
      shouldStop: () => job.cancelled,
      onProgress: (progress) => {
        const { step, maxSteps, maxForce: mF, energyPerAtomEv, pressureGPa } = progress;
        job.progress = relaxProgress(progress);
        shell.statusEl.textContent = `step ${step} / ${maxSteps}`;
        showProgress(progressBox, `Relaxation: step ${step} (max ${maxSteps}) · `
          + `max force ${mF.toFixed(3)} eV/Å, target ${params.forceTol}`);
        if (metricsEl) {
          metricsEl.innerHTML = `
            <div>energy / atom: ${energyPerAtomEv.toFixed(6)} eV</div>
            <div>max force: ${mF.toFixed(5)} eV/Å</div>
            <div>pressure: ${pressureGPa === null ? 'n/a' : `${pressureGPa.toFixed(2)} GPa`}</div>
          `;
        }
      },
    });
    shell.statusEl.textContent = '';
    shell.resultEl.textContent = relaxed.converged
      ? `Converged after ${relaxed.steps} steps.`
      : relaxed.stopped
        ? `Stopped after ${relaxed.steps} steps, before converging.`
        : `Stopped after ${relaxed.steps} steps (max steps), not converged.`;
    return relaxed;
  } finally {
    hideProgress(progressBox);
    setAtomisticTitleStatus(null);
  }
}

/**
 * One relaxation of the selected structure, recorded into a new relax_… row
 * (the source row is left as it was). The Relax window and the host's
 * run_relax job both call this; the caller gets the potential ready first.
 * params: forceTol (eV/Å), maxSteps, targetPressure (GPa), stressTol (GPa),
 * relaxCell (default true: the cell relaxes to targetPressure too).
 * @param {any} params
 * @param {{ runner: any, potential: string, shouldStop?: () => boolean,
 *   onProgress?: (p: {step: number, maxSteps: number, maxForce: number, energyPerAtomEv: number, pressureGPa: number|null}) => void }} ctx
 */
export async function runRelax(params, { runner, potential, shouldStop = () => false, onProgress = () => {} }) {
  const noStress = runner.supportsStress === false;
  const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
  const saveStride = Math.max(1, Number(general.backendTrajectorySaveStride || 1));
  let lastSavedStep = 0;
  const srcContainer = structureShip.container[fileBrowser.selectedRowIndex];
  // Relax animates this structure in place; keep the reference to restore it.
  const originalStructure = fileBrowser.selectedStructure;
  const relaxLabel = `relax_${potential}_${srcContainer?.fileName ?? 'run'}`;
  // Store-backed: frames pack into the trajectory store as the run saves them.
  const relaxContainer = TrajectoryContainer.fromStructures(relaxLabel, [snapshotCurrentStructure()]);
  // Persisted plot series (energy / mean force / pressure), 1:1 with frames.
  // `step` records the real relax step per saved frame so the plot's x-axis
  // reads steps (a multiple of the save stride); seed frame = step 0.
  relaxContainer.plotSeries = { step: [0], etotEv: [NaN], meanForce: [NaN], pressure: [NaN] };
  structureShip.container.push(relaxContainer);
  const relaxRow = createRow({ name: relaxLabel, traj: 1, step: 1 });
  tableBody.appendChild(relaxRow);

  resetLivePlot();
  ensureTrajectoryPanelForLive();
  let lastMetrics = /** @type {any} */ (null);
  const meanForceOf = (forces) => (Array.isArray(forces) && forces.length
    ? forces.reduce((a, v) => a + Math.hypot(v[0], v[1], v[2]), 0) / forces.length
    : NaN);
  const pushRelaxSeries = (m) => {
    relaxContainer.plotSeries.step.push(Number.isFinite(m.step) ? m.step : NaN);
    relaxContainer.plotSeries.etotEv.push(Number.isFinite(m.etotEv) ? m.etotEv : NaN);
    relaxContainer.plotSeries.meanForce.push(Number.isFinite(m.meanForce) ? m.meanForce : NaN);
    relaxContainer.plotSeries.pressure.push(Number.isFinite(m.pressure) ? m.pressure : NaN);
  };

  try {
    // Animate a throwaway working copy, not the source structure: the relax
    // loop mutates fileBrowser.selectedStructure in place for live feedback, and
    // we do not want that to alter the user's starting structure. Only relax_…
    // holds the trajectory. (restoreStructureInPlace remains a safety net.)
    const workingStructure = snapshotCurrentStructure();
    // Relax has no dynamics — never let a stale velocity value (e.g. carried
    // over from an MD frame relaxed in place) survive onto relax's own frames,
    // or a later "Continue MD" could mistake this trajectory's tip for a
    // resumable one.
    workingStructure.velocities = null;
    fileBrowser.selectedStructure = workingStructure;

    const initial = buildNEPStructure(runner, fileBrowser.selectedStructure);
    const relaxed = await relaxUntilConverged(runner, initial, {
      fmaxTol: params.forceTol,
      maxSteps: params.maxSteps,
      atomStep: 0.02,
      cellStep: 0.002,
      targetPressureGPa: params.targetPressure,
      pressureTolGPa: params.stressTol,
      relaxCell: params.relaxCell ?? true,
      shouldStop,
      onStep: (step, current, out, mF) => {
        // snapshotCurrentStructure copies the viewer structure, so a save-step must
        // also apply the current state to the viewer first.
        const shouldSave = step % saveStride === 0;
        const shouldUpdateViewer = step === 1 || shouldSave || step % viewerStride === 0;
        if (shouldUpdateViewer) {
          applyStructureToViewer(current, fileBrowser.selectedStructure);
          setCurrentEFS(out, current.keptIndices);
        }

        lastMetrics = {
          step,
          etotEv: Number(out.total_energy),
          meanForce: meanForceOf(out.forces),
          pressure: pressureGPaFromStress(out.stress?.matrix3x3),
        };
        if (shouldSave) {
          relaxContainer.appendFrame(snapshotCurrentStructure());
          lastSavedStep = step;
          feedLiveStep(lastMetrics);
          pushRelaxSeries(lastMetrics);
        }

        setAtomisticTitleStatus(`Relax step ${step}`);
        onProgress({
          step, maxSteps: params.maxSteps, maxForce: mF, energyPerAtomEv: Number(out.energy_per_atom),
          pressureGPa: (!noStress && out.stress?.matrix3x3) ? pressureGPaFromStress(out.stress.matrix3x3) : null,
        });
      },
    });

    applyStructureToViewer(relaxed.structure, fileBrowser.selectedStructure, { full: true });
    setCurrentEFS(relaxed.result, relaxed.structure.keptIndices);

    // Always keep the final state in the trajectory, even off-stride.
    if (relaxed.steps !== lastSavedStep) {
      relaxContainer.appendFrame(snapshotCurrentStructure());
      if (lastMetrics) {
        feedLiveStep({ ...lastMetrics, step: relaxed.steps });
        pushRelaxSeries(lastMetrics);
      }
    }
    const stepsSaved = relaxContainer.structures.length;
    updateRow(relaxRow, { name: relaxLabel, traj: stepsSaved, step: stepsSaved });
    const out = relaxed.result;
    return {
      container: relaxContainer, steps: relaxed.steps, converged: relaxed.converged, stopped: relaxed.stopped,
      frames: stepsSaved, maxForce: relaxed.maxForce, energyEv: Number(out?.total_energy),
      energyPerAtomEv: Number(out?.energy_per_atom), pressureGPa: noStress ? null : relaxed.pressureGPa,
    };
  } finally {
    // Live run over: release the plot, restore the source structure (relax
    // mutated it in place), and switch to the recorded relaxation trajectory.
    endLiveFeed();
    // Separate try/catch so a restore hiccup can't block switching to the
    // recorded relaxation trajectory (see the MD path for the rationale).
    try {
      restoreStructureInPlace(originalStructure, relaxContainer.frameAtDetached(0));
    } catch { /* safety net only */ }
    try {
      // By container, not "last row": rows may have been reordered meanwhile.
      selectContainer(relaxContainer);
      refreshActivePanels(); // rebuild the Trajectory panel for the new container
    } catch { /* non-fatal: leave selection as-is */ }
  }
}

/**
 * Energy, forces and stress of the selected structure, shown as the window
 * shows them (force arrows, current EFS). Shared by the EFS button and the
 * host's compute_energy; the caller gets the potential ready first.
 */
export async function computeCurrentEFS(runner) {
  const nepStruct = buildNEPStructure(runner, fileBrowser.selectedStructure);
  const out = await runner.compute(nepStruct);
  setCurrentEFS(out, nepStruct.keptIndices);
  return {
    out,
    maxForce: maxForce(out.forces),
    pressureGPa: runner.supportsStress === false ? null : pressureGPaFromStress(out.stress.matrix3x3),
  };
}

async function runLocalEFS(shell, metricsEl, potential) {
  const runner = await ensureCalculatorReady(potential, shell);
  const { out, maxForce: mF, pressureGPa } = await computeCurrentEFS(runner);
  metricsEl.innerHTML = `
    <div>energy / atom: ${Number(out.energy_per_atom).toFixed(6)} eV</div>
    <div>max force: ${mF.toFixed(5)} eV/Å</div>
    <div>pressure: ${pressureGPa === null ? 'n/a' : `${pressureGPa.toFixed(2)} GPa`}</div>
  `;
  shell.resultEl.textContent = '';
}

function bindRelaxBody(panel, shell, potential) {
  renderRelaxBody(shell.bodyEl, potential);
  showPotentialSizeNotice(shell, potential);
  const metricsEl = shell.bodyEl.querySelector('#relaxEfsMetrics');
  const efsCard = shell.bodyEl.querySelector('#relaxEfsCard');
  const relaxBtn = shell.bodyEl.querySelector('#relaxBtn');
  const relaxStopBtn = shell.bodyEl.querySelector('#relaxStopBtn');

  efsCard.addEventListener('click', async () => {
    try {
      shell.resultEl.textContent = '';
      assertOrderedStructure();
      assertStructureFitsPotential(potential);
      await runLocalEFS(shell, metricsEl, potential);
    } catch (error) {
      shell.resultEl.textContent = `EFS failed: ${error.message || String(error)}`;
    }
  });

  // A relaxation is a job (host/jobs.js), as the host's run_relax: one
  // calculation at a time, whoever starts it (syncRunButtons locks Relax), and
  // Stop ends the running one after the current step, keeping the trajectory so far.
  const failed = (error) => { shell.resultEl.textContent = `Relax failed: ${error.message || String(error)}`; };
  relaxBtn.addEventListener('click', () => {
    try {
      const params = readRelaxParams(shell.bodyEl);
      shell.resultEl.textContent = '';
      assertOrderedStructure();
      assertStructureFitsPotential(potential);
      startJob('relax', async (job) => {
        try {
          return relaxJobResult(params, potential, await runLocalRelax(shell, params, potential, job));
        } catch (error) {
          failed(error);
          throw error;
        }
      });
    } catch (error) {
      failed(error);
    }
  });
  relaxStopBtn?.addEventListener('click', () => {
    const job = runningJob('relax');
    if (!job) return;
    cancelJob(job.id);
    shell.statusEl.textContent = 'Stopping the relaxation after the current step...';
  });
  syncRunButtons();

  const rattleBtn = shell.bodyEl.querySelector('#relaxRattleBtn');
  rattleBtn?.addEventListener('click', () => {
    try {
      const amp = Number(shell.bodyEl.querySelector('#relaxRattleAmpInput')?.value || 0.1);
      const doLattice = !!shell.bodyEl.querySelector('#relaxRattleLatticeChk')?.checked;
      const pctVal = Number(shell.bodyEl.querySelector('#relaxRattleLatticePctInput')?.value);
      const latticePct = (Number.isFinite(pctVal) ? pctVal : RATTLE_LATTICE_PCT * 100) / 100;
      rattleSelectedStructure(amp, doLattice, latticePct);
      shell.resultEl.textContent = `Rattled atoms ±${amp} Å${doLattice ? `, cell ±${(latticePct * 100).toFixed(1)}%` : ''}.`;
    } catch (error) {
      shell.resultEl.textContent = `Rattle failed: ${error.message || String(error)}`;
    }
  });
}

function bindMDBody(panel, shell, potential) {
  renderMDBody(shell.bodyEl, potential);
  renderMDAnnealSummary(shell.bodyEl);
  showPotentialSizeNotice(shell, potential);

  const annealHeader = shell.bodyEl.querySelector('#mdAnnealHeader');
  const annealControls = shell.bodyEl.querySelector('#mdAnnealControls');
  const startBtn = shell.bodyEl.querySelector('#mdStartBtn');
  const stopBtn = shell.bodyEl.querySelector('#mdStopBtn');

  annealHeader?.addEventListener('click', () => {
    annealControls.classList.toggle('hidden');
    renderMDAnnealSummary(shell.bodyEl);
  });
  ['#mdAnnealMinInput', '#mdAnnealMaxInput', '#mdAnnealPeakPctInput', '#mdTemperatureInput']
    .forEach((sel) => shell.bodyEl.querySelector(sel)
      ?.addEventListener('input', () => renderMDAnnealSummary(shell.bodyEl)));

  // MD's progress under its buttons, and in the window's title bar: visible
  // while the Trajectory window (live plot) or this window is collapsed.
  const mdProgressBox = shell.bodyEl.querySelector('[data-role="md-progress"]');
  stopBtn?.addEventListener('click', () => {
    const job = runningJob('md');
    if (!job) return;
    cancelJob(job.id);
    shell.statusEl.textContent = 'Stopping MD after current step...';
    // The bar shows only for a run started here.
    if (mdProgressBox && !mdProgressBox.hidden) showProgress(mdProgressBox, 'MD: stopping after the current step …');
  });

  // Ensemble: NVT (thermostat, fixed cell) or NPT (thermostat + barostat, cell
  // free to change volume). A segmented control rather than a checkbox — it
  // matches the Relax/MD and potential switches above it, and "NPT" needs the
  // one-line explanation underneath more than it needs a tick box. The word
  // "relax" is deliberately avoided here: this panel's other mode is called
  // Relax and means something completely different.
  const ensembleSwitch = shell.bodyEl.querySelector('#mdEnsembleSwitch');
  const ensembleHint = shell.bodyEl.querySelector('#mdEnsembleHint');
  const pressureInput = shell.bodyEl.querySelector('#mdPressureInput');
  const tauTInput = shell.bodyEl.querySelector('#mdTauTInput');
  const tauPInput = shell.bodyEl.querySelector('#mdTauPInput');
  const couplingHint = shell.bodyEl.querySelector('#mdCouplingHint');
  const isNpt = () => ensembleSwitch?.querySelector('button.active')?.dataset.ensemble === 'npt';

  const syncEnsembleControls = () => {
    const npt = isNpt();
    if (pressureInput) pressureInput.disabled = !npt;
    if (tauPInput) tauPInput.disabled = !npt;
    if (ensembleHint) {
      ensembleHint.textContent = npt
        ? 'constant temperature and pressure — cell volume follows the target pressure (shape fixed)'
        : 'constant temperature — cell held fixed';
    }
    if (couplingHint) {
      const tauT = Number(tauTInput?.value) || DEFAULT_THERMOSTAT_TAU_FS;
      const tauP = Number(tauPInput?.value) || DEFAULT_BAROSTAT_TAU_FS;
      // A barostat comparable in speed to the thermostat fights it: the cell
      // does work on the atoms faster than the bath can absorb it.
      couplingHint.textContent = npt && tauP < tauT * MIN_BAROSTAT_TAU_RATIO
        ? `barostat τ should be at least ${MIN_BAROSTAT_TAU_RATIO}× the thermostat τ (≥ ${tauT * MIN_BAROSTAT_TAU_RATIO} fs) — the two will fight otherwise`
        : 'τ is how fast T and P are corrected, not how accurate the run is — that is the timestep. Loosen the thermostat for undistorted sampling, tighten it to tame a hot start.';
    }
  };

  ensembleSwitch?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-ensemble]') : null;
    if (!button) return;
    ensembleSwitch.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
    syncEnsembleControls();
  });
  tauTInput?.addEventListener('input', syncEnsembleControls);
  tauPInput?.addEventListener('input', syncEnsembleControls);
  syncEnsembleControls();

  const couplingHeader = shell.bodyEl.querySelector('#mdCouplingHeader');
  const couplingControls = shell.bodyEl.querySelector('#mdCouplingControls');
  const couplingIcon = shell.bodyEl.querySelector('#mdCouplingIcon');
  couplingHeader?.addEventListener('click', () => {
    const hidden = couplingControls?.classList.toggle('hidden');
    if (couplingIcon) couplingIcon.textContent = hidden ? '▸' : '▾';
  });

  // An MD run is a job (host/jobs.js), as the host's run_md: see bindRelaxBody.
  const failed = (error) => { shell.resultEl.textContent = `MD failed: ${error.message || String(error)}`; };
  startBtn?.addEventListener('click', () => {
    try {
      assertOrderedStructure();
      assertStructureFitsPotential(potential);
      startJob('md', async (job) => {
        try {
          shell.resultEl.textContent = '';
          showProgress(mdProgressBox, 'MD: getting the potential ready …');
          setAtomisticTitleStatus('MD …');
          const runner = await ensureCalculatorReady(potential, shell);
          const value = (sel, fallback) => Number(shell.bodyEl.querySelector(sel)?.value || fallback);
          const result = await runMD({
            steps: value('#mdStepsInput', 500),
            dtFs: value('#mdTimestepInput', 1),
            startTemperatureK: value('#mdTemperatureInput', 300),
            useAnneal: !annealControls.classList.contains('hidden'),
            useNpt: shell.bodyEl.querySelector('#mdEnsembleSwitch button.active')?.dataset.ensemble === 'npt',
            targetPressureGPa: value('#mdPressureInput', 0),
            thermostatTauFs: Number(shell.bodyEl.querySelector('#mdTauTInput')?.value),
            barostatTauFs: Number(shell.bodyEl.querySelector('#mdTauPInput')?.value),
            minTemperatureK: value('#mdAnnealMinInput', 100),
            maxTemperatureK: value('#mdAnnealMaxInput', 1200),
            peakFraction: value('#mdAnnealPeakPctInput', 30) / 100,
            saveStride: value('#mdSaveStrideInput', general.backendTrajectorySaveStride || 4),
          }, {
            runner,
            potential,
            shouldStop: () => job.cancelled,
            onProgress: (progress) => {
              const { step, steps, timeFs, text } = progress;
              job.progress = mdProgress(progress);
              shell.statusEl.textContent = text;
              if (!job.cancelled) {
                showProgress(mdProgressBox, `MD: step ${step} of ${steps} · ${timeFs.toFixed(1)} fs`, step / steps);
              }
            },
          });
          shell.statusEl.textContent = '';
          shell.resultEl.textContent = result.stopped ? `Stopped at step ${result.finalStep}.` : `Finished at step ${result.finalStep}.`;
          return mdJobResult(potential, result);
        } catch (error) {
          failed(error);
          throw error;
        } finally {
          hideProgress(mdProgressBox);
          setAtomisticTitleStatus(null);
        }
      });
    } catch (error) {
      failed(error);
    }
  });
  syncRunButtons();
}

// Relax / MD and Stop follow the job list (host/jobs.js), whoever started the
// run: Relax and MD are locked while any calculation runs, and Stop is on
// while a run of its kind runs and has not been asked to stop.
function syncRunButtons() {
  const busy = runningJob();
  const sync = (startId, stopId, kind) => {
    const start = /** @type {HTMLButtonElement|null} */ (document.getElementById(startId));
    const stop = /** @type {HTMLButtonElement|null} */ (document.getElementById(stopId));
    if (start) start.disabled = !!busy;
    if (stop) stop.disabled = !(busy?.kind === kind && !busy.cancelled);
  };
  sync('relaxBtn', 'relaxStopBtn', 'relax');
  sync('mdStartBtn', 'mdStopBtn', 'md');
}

/**
 * One MD run on the selected structure, recorded into a new trajectory row
 * (or, from an MD trajectory's last frame, continuing it). The MD window's
 * start button and the host's run_md job both call this; the caller gets the
 * potential ready (ensureCalculatorReady / ensureActiveCalculator) first.
 * Settings are the MD window's: steps, dtFs, startTemperatureK, useAnneal
 * (min/maxTemperatureK, peakFraction), useNpt (targetPressureGPa),
 * thermostatTauFs, barostatTauFs, saveStride.
 * @param {any} params
 * @param {{ runner: any, potential: string, shouldStop?: () => boolean,
 *   onProgress?: (p: {step: number, steps: number, timeFs: number, temperatureK: number, text: string}) => void }} ctx
 * @returns {Promise<{ container: any, finalStep: number, stopped: boolean, frames: number }>}
 */
export async function runMD(params, { runner, potential, shouldStop = () => false, onProgress = () => {} }) {
  // Declared out here (not inside the try) so the finally block can see them
  // for the restore/switch even if the run throws before/after assigning.
  let originalStructure = /** @type {any} */ (null);
  let mdContainer = /** @type {any} */ (null);
  let seedFrame = /** @type {any} */ (null);
  let isContinuation = false;
  let mdTitlePct = -1;
  try {
    const { steps, dtFs, startTemperatureK, useAnneal, useNpt, targetPressureGPa,
      minTemperatureK, maxTemperatureK } = params;
    const thermostatTauFs = Math.max(1, Number(params.thermostatTauFs) || DEFAULT_THERMOSTAT_TAU_FS);
    // Clamped rather than merely warned about: a barostat running as fast as
    // the thermostat is unstable, and silently producing a bad trajectory is
    // worse than quietly slowing the cell down.
    const barostatTauFs = Math.max(
      thermostatTauFs * MIN_BAROSTAT_TAU_RATIO,
      Number(params.barostatTauFs) || DEFAULT_BAROSTAT_TAU_FS);
    const peakFraction = Math.max(0.01, Math.min(0.99, Number(params.peakFraction ?? 0.3)));
    const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
    const saveStride = Math.max(1, Number(params.saveStride) || 4);
    general.backendTrajectorySaveStride = saveStride;
    let lastSavedStep = 0;
    let lastStepMetrics = /** @type {any} */ (null);
    const srcContainer = structureShip.container[fileBrowser.selectedRowIndex];
    // MD animates this structure in place for live viewer feedback; keep the
    // reference so it can be restored (from the seed frame) once the run ends.
    originalStructure = fileBrowser.selectedStructure;

    // "Continue MD": resume with the selected frame's own velocities and grow
    // its container in place, instead of a fresh start — but only when that
    // frame is genuinely the trajectory's tip (compared by reference, the
    // same way this file already tracks "the" selected structure) and it was
    // actually produced by MD (relax/rattle null out .velocities, so a relaxed
    // or rattled tip always falls through to the fresh-start branch below).
    const isLastFrame = !!srcContainer
      && srcContainer.structures[srcContainer.structures.length - 1] === originalStructure;
    const resumeVelocities = (isLastFrame && originalStructure.velocities) || null;
    isContinuation = !!resumeVelocities;

    const mdLabel = `md_${potential}_${srcContainer?.fileName ?? 'run'}`;
    let mdRow;
    if (isContinuation) {
      mdContainer = srcContainer;
      seedFrame = originalStructure;
      mdRow = fileBrowser.selectedRow;
    } else {
      seedFrame = snapshotCurrentStructure();
      // Store-backed: frames pack into the trajectory store as the run saves them.
      mdContainer = TrajectoryContainer.fromStructures(mdLabel, [seedFrame]);
      // Persist the plotted series on the container so the trajectory plot can be
      // rebuilt (e.g. after a panel rebuild from a structure-table interaction)
      // long after the live run's in-memory plot was torn down. Seed one NaN gap
      // for the initial (pre-run) frame so the series stays index-aligned with
      // mdContainer.structures.
      // No pressure series: NEP/PET-MAD/ASE MD here runs at fixed cell, so the
      // stress trace is not a meaningful pressure to plot. `step` records the
      // real MD step per saved frame so the plot's x-axis reads steps (a
      // multiple of the save stride), not the frame index; seed frame = step 0.
      mdContainer.plotSeries = {
        step: [0], temperatureK: [NaN], targetTemperatureK: [NaN], etotEv: [NaN], pressure: [NaN],
      };
      structureShip.container.push(mdContainer);
      mdRow = createRow({ name: mdLabel, traj: 1, step: 1 });
      tableBody.appendChild(mdRow);
    }
    // Continuing picks the step/time clock up from the trajectory's own
    // record, so the plot's x-axis and the on-screen step counter don't snap
    // back to 0 partway through an otherwise-continuous run.
    const resumeStep = isContinuation
      ? (mdContainer.plotSeries?.step?.[mdContainer.plotSeries.step.length - 1] ?? 0)
      : 0;
    lastSavedStep = resumeStep;

    resetLivePlot();
    ensureTrajectoryPanelForLive();
    // Evaluate the potential off-thread when we can: it is by far the longest
    // part of a step, and on the main thread it blocks paint, so the render of
    // one frame and the compute of the next serialise instead of overlapping.
    // Falls back to the in-thread runner if the worker cannot start (and for
    // MLIP/ASE, which have their own transports).
    let forceEvaluator = createNEPForceEvaluator(runner);
    // PET-MAD's runner is already worker-backed when it could be
    // (ensureMLIPReady), and ASE computes on its server; the loop only needs
    // to know so it yields with a macrotask instead of waiting for a paint it
    // does not block.
    let offThreadForces = (potential === 'mlip' || potential === 'ase') && runner.offThread === true;
    if (potential === 'nep' && general.mdWorker !== false && typeof Worker !== 'undefined') {
      try {
        await ensureWorkerNEPReady();
        forceEvaluator = createWorkerNEPForceEvaluator();
        offThreadForces = true;
      } catch (workerError) {
        console.warn('NEP worker unavailable, running the potential on the main thread:', workerError);
      }
    }
    const integrator = createVelocityVerletIntegrator();
    const targetTemperatureSchedule = useAnneal
      ? createCosineAnnealingSchedule({
          startTemperatureK,
          peakTemperatureK: maxTemperatureK,
          minTemperatureK,
          peakFraction,
          totalSteps: steps,
        })
      : startTemperatureK;
    // CSVR rather than the old Berendsen rescale: same cost, but it samples
    // the canonical ensemble instead of merely holding the mean temperature.
    const thermostat = createBussiThermostat({
      targetTemperatureK: /** @type {any} */ (targetTemperatureSchedule),
      tauFs: thermostatTauFs,
    });
    const barostat = useNpt
      ? createStochasticCellBarostat({ targetPressureGPa, tauFs: barostatTauFs })
      : createNoBarostat();

    // Animate a throwaway working copy of the source structure, not the
    // source itself: the MD loop mutates fileBrowser.selectedStructure in
    // place every step for live viewer feedback, and we do NOT want that to
    // alter the user's starting structure. With a working copy the source row
    // stays exactly as provided and only MD_… holds the trajectory. (The
    // end-of-run restoreStructureInPlace remains as a belt-and-suspenders.)
    const workingStructure = snapshotCurrentStructure();
    fileBrowser.selectedStructure = workingStructure;

    const state = await initializeMDState({
      nepRunner: runner,
      structure: fileBrowser.selectedStructure,
      temperatureTargetK: startTemperatureK,
      forceEvaluator,
      initialVelocities: resumeVelocities,
    });
    if (isContinuation) {
      state.step = resumeStep;
      state.timeFs = resumeStep * dtFs;
    }

    await runMDSimulation({
      state,
      steps,
      dtFs,
      forceEvaluator,
      integrator,
      thermostat,
      barostat,
      offThreadForces,
      shouldStop,
      onStep: ({ step, timeFs, temperatureK, targetTemperatureK, epotEv, ekinEv, etotEv,
                 pressureGPa, volumeA3, state: mdState }) => {
        // snapshotCurrentStructure copies the viewer structure, so a save-step
        // must also apply the current state to the viewer first. Bond-topology
        // refresh is handled inside applyMDStateToViewer (BOND_TOPOLOGY_STRIDE);
        // the old forceRerender-every-5-steps full rebuild is gone.
        const shouldSave = step % saveStride === 0;
        const shouldUpdateViewer = step === 1 || shouldSave || step % viewerStride === 0;
        if (shouldUpdateViewer) {
          mdProfileMeasure('viewerMs', () => {
            applyMDStateToViewer(mdState, fileBrowser.selectedStructure);
            setCurrentEFS({
              forces: mdState.forces,
              total_energy: mdState.potentialEnergyEv,
              stress: { matrix3x3: mdState.stress },
            });
          });
        }

        // Fixed-cell MD: no pressure series (see plotSeries seed above).
        lastStepMetrics = {
          step, temperatureK, targetTemperatureK, etotEv, epotEv, ekinEv, pressure: pressureGPa,
        };
        if (shouldSave) {
          mdProfileMeasure('saveMs', () => {
            const frame = snapshotCurrentStructure();
            frame.energy = epotEv;
            mdContainer.appendFrame(frame);
            lastSavedStep = step;
          });
          // Feed the plot exactly once per SAVED trajectory frame so the plot's
          // sample count stays 1:1 with the scrubber's frames — this is what
          // keeps the frame cursor aligned with the slider (feeding every step
          // would desync the cursor from the 1..N frame index).
          mdProfileMeasure('plotMs', () => {
            feedLiveStep(lastStepMetrics);
            mdContainer.plotSeries.step.push(step);
            mdContainer.plotSeries.temperatureK.push(temperatureK);
            mdContainer.plotSeries.targetTemperatureK.push(Number.isFinite(targetTemperatureK) ? targetTemperatureK : NaN);
            mdContainer.plotSeries.etotEv.push(etotEv);
            mdContainer.plotSeries.pressure.push(Number.isFinite(pressureGPa) ? pressureGPa : NaN);
          });
        }
        const tLabel = Number.isFinite(targetTemperatureK)
          ? `T=${temperatureK.toFixed(0)} K → ${targetTemperatureK.toFixed(0)} K`
          : `T=${temperatureK.toFixed(0)} K`;
        const pvLabel = useNpt && Number.isFinite(pressureGPa)
          ? `  ·  P=${pressureGPa.toFixed(2)} GPa  ·  V=${volumeA3.toFixed(1)} A^3`
          : '';
        onProgress({ step, steps, timeFs, temperatureK,
          text: `step ${step} / ${steps}  ·  t=${timeFs.toFixed(1)} fs  ·  ${tLabel}${pvLabel}` });
        const pct = Math.floor((100 * step) / steps);
        if (pct !== mdTitlePct) {
          mdTitlePct = pct;
          setAtomisticTitleStatus(`MD ${pct}%`);
        }
      },
    });

    // Run-end full apply: rebuild bond topology + refresh polyhedra one last time.
    applyMDStateToViewer(state, fileBrowser.selectedStructure, { full: true });
    setCurrentEFS({
      forces: state.forces,
      total_energy: state.potentialEnergyEv,
      stress: { matrix3x3: state.stress },
    }, state.keptIndices);

    // Always keep the final state in the trajectory, even off-stride.
    if (state.step !== lastSavedStep) {
      const frame = snapshotCurrentStructure();
      frame.energy = state.potentialEnergyEv;
      mdContainer.appendFrame(frame);
      // Keep the plot 1:1 with frames: feed this final frame too, reusing the
      // last step's computed metrics (state carries no temperature/KE fields).
      if (lastStepMetrics) {
        feedLiveStep({ ...lastStepMetrics, step: state.step });
        mdContainer.plotSeries.step.push(state.step);
        mdContainer.plotSeries.temperatureK.push(lastStepMetrics.temperatureK);
        mdContainer.plotSeries.targetTemperatureK.push(Number.isFinite(lastStepMetrics.targetTemperatureK) ? lastStepMetrics.targetTemperatureK : NaN);
        mdContainer.plotSeries.etotEv.push(lastStepMetrics.etotEv);
        mdContainer.plotSeries.pressure.push(
          Number.isFinite(lastStepMetrics.pressure) ? lastStepMetrics.pressure : NaN);
      }
    }

    const count = mdContainer.structures.length;
    // Continuation keeps the row's existing name — it's the same container,
    // not a freshly labeled one.
    updateRow(mdRow, { name: isContinuation ? mdContainer.fileName : mdLabel, traj: count, step: count });
    return { container: mdContainer, finalStep: state.step, stopped: shouldStop(), frames: count };
  } finally {
    setAtomisticTitleStatus(null);
    // Live run is over: hand ownership of the plot back to the container's
    // persisted series so scrubbing/replay survives later panel rebuilds.
    endLiveFeed();
    // Safety-net restore of the source structure (it's normally untouched now
    // that MD animates a working copy). SEPARATE try/catch from the row switch
    // below: a restore hiccup must not prevent switching to MD_…. seedFrame is
    // the frame the run actually started from — mdContainer.structures[0] for
    // a fresh run, but the (unmoved) resumed frame itself when continuing.
    try {
      restoreStructureInPlace(originalStructure, seedFrame);
    } catch { /* safety net only */ }
    // Auto-select the recorded trajectory so the viewer refreshes to the new
    // frame(s). refreshActivePanels() rebuilds the Trajectory panel (selection
    // alone doesn't, so the scrubber otherwise stayed put until a manual row
    // click).
    try {
      // By container, not by position: the user may have selected or
      // reordered rows while the run was going.
      if (isContinuation) {
        // Same row as before the run — jump it to the newly appended tip.
        selectStructure(structureShip.container.indexOf(mdContainer), mdContainer.structures.length - 1);
      } else {
        selectContainer(mdContainer);
      }
      refreshActivePanels();
    } catch { /* non-fatal: leave selection as-is */ }
  }
}

// Reflect the current general.atomisticPotential in the selector's own widgets
// (button highlight, ASE/MLIP sub-controls, one-line hint). Pure UI — no body.
function updatePotentialUI(shell) {
  const potential = general.atomisticPotential || 'nep';
  shell.toggle?.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.potential === potential);
  });
  refreshBackendTheme();
  shell.aseConnectorsEl?.classList.toggle('hidden', potential !== 'ase');
  shell.mlipSourceEl?.classList.toggle('hidden', potential !== 'mlip');
  if (potential === 'ase') {
    if (shell.sourceStateEl) {
      shell.sourceStateEl.textContent = aseRunner?.connected
        ? `ASE ready: ${aseRunner.modelInfo?.name ?? ''}`
        : 'ASE: start python backend/server.py on your machine, then Connect (runs connect on first use too).';
    }
  } else if (potential === 'mlip') {
    if (shell.sourceStateEl) shell.sourceStateEl.textContent = 'PET-MAD selected: load a model, then compute in-browser.';
  } else if (shell.sourceStateEl) {
    shell.sourceStateEl.textContent = '';
  }
}

// Render the body for whichever action is active (general.backendState), using
// the currently chosen potential. Called both when the action changes (Relax/MD
// switch) and when the potential changes under a fixed action.
function renderActiveBody() {
  const shell = getShellBindings();
  if (!shell.bodyEl) return;
  const potential = general.atomisticPotential || 'nep';
  if (general.backendState === 'md') {
    bindMDBody(null, shell, potential);
  } else {
    bindRelaxBody(null, shell, potential);
  }
}

/**
 * Choose the potential ('nep' | 'mlip' | 'ase'), as a click on "Choose
 * potential" does: the shared state, the picker's own widgets, the active
 * action's body (re-rendered in place) and the other windows' notices follow.
 * The picker and the host's run_* potential argument.
 * @param {'nep'|'mlip'|'ase'} potential
 */
export function selectPotential(potential) {
  const shell = getShellBindings();
  general.atomisticPotential = potential;
  // resultEl is the hint line itself (source-state): updatePotentialUI
  // replaces an earlier run's result with the new potential's hint (empty
  // for NEP). Clearing it afterwards wiped the ASE and PET-MAD hints.
  updatePotentialUI(shell);
  renderActiveBody();
  notifyPotentialChange();
}

/** Whether the ASE server is connected with a model (ensureASEReady has run). */
export function aseConnected() {
  return Boolean(aseRunner?.connected && aseRunner.modelInfo);
}

// Wire the persistent potential picker ONCE. Selecting a potential never
// rebuilds (or resets) the selector itself.
function bindPotentialToggle() {
  const shell = getShellBindings();

  shell.toggle?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-potential]');
    if (button) selectPotential(button.dataset.potential);
  });

  if (shell.aseUrlInput) shell.aseUrlInput.value = aseServerUrl(null);
  shell.aseConnectorsEl?.querySelector('[data-role="connect-ase"]')?.addEventListener('click', async () => {
    try {
      const runner = await ensureASEReady(shell);
      if (shell.sourceStateEl) shell.sourceStateEl.textContent = `ASE ready: ${runner.modelInfo.name}`;
    } catch (error) {
      if (shell.sourceStateEl) shell.sourceStateEl.textContent = `ASE: ${error.message || String(error)}`;
    }
  });

  shell.aseConnectorsEl?.querySelector('[data-role="disconnect-ase"]')?.addEventListener('click', () => {
    disconnectASE(shell);
  });
  shell.aseModelSelect?.addEventListener('change', () => {
    switchASEModel(shell, shell.aseModelSelect.value);
  });

  // Multi-threaded PET-MAD: the threaded wasm needs SharedArrayBuffer, i.e. a
  // cross-origin isolated page. Served isolated already (desktop host, dev
  // server --coi) the box is on and locked; otherwise it drives the opt-in
  // service worker (host/coi.js), which reloads the page either way.
  bindMultithreadToggle(shell);
  bindThreadsSelect(shell);
  // The model list: built-in PET-MAD, catalogues, links (PetModelList.js).
  bindPetModelList(shell, {
    setStatus: (text) => setMLIPStatus(shell, text),
    loadSelected: () => ensureMLIPReady(shell),
  });

  // Which model each potential runs, for the notices in this and the other
  // windows that compute with it (EOS, Order Structure, phonon mode maps),
  // and the accuracy caveat with the NEP high-pressure warning here.
  setPotentialLabel('mlip', () => mlipModelLabel(shell));
  setPotentialLabel('ase', () => aseModelLabel(shell));
  shell.mlipModelSelect?.addEventListener('change', notifyPotentialChange);
  shell.mlipFileInput?.addEventListener('change', notifyPotentialChange);
  if (shell.potentialNoticeHost) {
    // The collapsed ⚠ sits after "Choose potential", not on a row of its own.
    const notice = mountPotentialNotice(shell.potentialNoticeHost, { showPotential: false, pressures: atomisticPressures,
      inline: shell.potentialLabel });
    // The relax / NPT target pressures live in the action body, rebuilt on
    // every Relax/MD switch: listen on its persistent container.
    const calc = document.getElementById('BackendCalcPanel');
    for (const type of ['input', 'change', 'click']) calc?.addEventListener(type, () => notice.update());
  }

  // Eager model load: the same ensureMLIPReady path the EFS/Relax/MD entry
  // points use, so whatever is loaded here is reused by later runs.
  shell.mlipLoadBtn?.addEventListener('click', async () => {
    const btn = shell.mlipLoadBtn;
    try {
      btn.disabled = true;
      await ensureMLIPReady(shell);
    } catch (error) {
      setMLIPStatus(shell, `Load failed: ${error.message || String(error)}`);
    } finally {
      btn.disabled = false;
    }
  });

  updatePotentialUI(shell);
}

function bindMultithreadToggle(shell) {
  const input = shell.mlipMultithreadInput;
  if (!input) return;
  const isolated = isIsolated();
  const requested = isMultithreadRequested();
  input.checked = isolated || requested;
  if (isolated && !requested) {
    // Headers come from the server: nothing for the page to toggle.
    input.disabled = true;
    shell.mlipMultithreadRow?.setAttribute('title', 'This page is cross-origin isolated: the threaded build is used.');
    return;
  }
  if (!canRequestIsolation()) {
    input.disabled = true;
    shell.mlipMultithreadRow?.setAttribute('title',
      'Multi-threading needs a secure context with service workers (https or localhost).');
    return;
  }
  input.addEventListener('change', async () => {
    const enabled = input.checked;
    // The reload loses everything held only in this page: ask first.
    input.disabled = true;
    const go = await confirmAppReload(enabled ? 'Turning multi-threading on' : 'Turning multi-threading off');
    if (!go) {
      input.checked = !enabled;
      input.disabled = false;
      return;
    }
    setMLIPStatus(shell, enabled
      ? 'reloading to enable multi-threaded PET-MAD …'
      : 'reloading to disable multi-threaded PET-MAD …');
    let reloading = false;
    let reason = 'this browser cannot register the service worker it needs';
    try {
      reloading = await setMultithreadEnabled(enabled);
    } catch (error) {
      reason = error.message || String(error);
    }
    if (!reloading) {
      reloadAbandoned();
      input.checked = !enabled;
      input.disabled = false;
      setMLIPStatus(shell, `multi-threading unavailable: ${reason}`);
    }
  });
}

// PET-MAD CPU threads: 'auto' (per system size the fastest of all cores, one
// and half, timed on the first evaluation; MLIPRunner) or a fixed count, to
// leave cores free for other work. Remembered across reloads (the
// multi-threaded switch reloads the page); a loaded model takes the new count
// from its next evaluation.
function bindThreadsSelect(shell) {
  const select = shell.mlipThreadsSelect;
  if (!select) return;
  // At most 16: the threaded wasm starts min(cores, 16) workers and clamps to
  // that (external/mlip_wasm/README.md "Threads").
  const cores = Math.min(16, Math.max(1, Number(navigator.hardwareConcurrency) || 1));
  select.innerHTML = ['auto', ...Array.from({ length: cores }, (_, i) => String(i + 1))]
    .map((v) => `<option value="${v}">${v}</option>`).join('');
  const stored = Number(getPanelPref('mlipThreads'));
  select.value = stored >= 1 ? String(Math.min(cores, Math.round(stored))) : 'auto';
  // general.mlipThreads is typed by its 'auto' default; it also takes a count.
  general.mlipThreads = /** @type {any} */ (select.value === 'auto' ? 'auto' : Number(select.value));

  const refresh = () => {
    const threaded = isIsolated();
    const gpu = shell.mlipBackendSelect?.value === 'webgpu';
    select.disabled = !threaded || gpu;
    shell.mlipThreadsRow?.setAttribute('title', !threaded
      ? 'CPU threads for PET-MAD: turn on "multi-threaded" first (one thread until then).'
      : gpu
        ? 'The webgpu backend runs on the GPU; this sets the threads of the cpu backend.'
        : 'CPU threads for PET-MAD. auto: per system size the fastest of all cores, one and half (timed on the first evaluation).');
  };
  refresh();
  shell.mlipBackendSelect?.addEventListener('change', refresh);

  select.addEventListener('change', async () => {
    setPanelPref('mlipThreads', select.value);
    general.mlipThreads = /** @type {any} */ (select.value === 'auto' ? 'auto' : Number(select.value));
    const runner = mlipState?.runner;
    if (!runner || typeof runner.setThreads !== 'function') return;
    try {
      await runner.setThreads(general.mlipThreads);
      const name = runner.modelInfo?.name;
      setMLIPStatus(shell, name ? `PET-MAD ready: ${name} (${mlipRuntimeLabel(runner)})` : `PET-MAD: ${mlipRuntimeLabel(runner)}`);
    } catch (error) {
      setMLIPStatus(shell, `threads not changed: ${error.message || error}`);
    }
  });
}

// Build the persistent potential selector once, above the Relax/MD switch.
// Idempotent: safe to call on every panel entry.
export function initAtomisticSelector() {
  const selector = document.getElementById('BackendPotentialSelector');
  if (!selector || selector.dataset.ready === '1') return;
  general.atomisticPotential = general.atomisticPotential || 'nep';
  selector.innerHTML = buildSourcePanel();
  selector.dataset.ready = '1';
  bindPotentialToggle();
  document.addEventListener(JOBS_CHANGED, syncRunButtons);
}

function addAtomisticPanel(mode) {
  initAtomisticSelector();
  document.getElementById('BackendPotentialSelector')?.classList.remove('hidden');
  general.backendState = mode;
  const panel = document.getElementById('BackendCalcPanel');
  panel.innerHTML = buildBodyShell();
  renderActiveBody();
}

export function addRelaxPanel() {
  addAtomisticPanel('relax');
}

export function addMDPanel() {
  addAtomisticPanel('md');
}

export function removeAtomisticPanel() {
  const panel = document.getElementById('BackendCalcPanel');
  if (panel) panel.innerHTML = '';
  // Hide the (persistent) selector while no action is open — it has nothing to
  // drive until a mode is picked again.
  const selector = document.getElementById('BackendPotentialSelector');
  if (selector) selector.classList.add('hidden');
}
