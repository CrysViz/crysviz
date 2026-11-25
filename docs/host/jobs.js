// The running calculations, one list for the host and the windows: a run_*
// command (run_md, run_relax, run_energy, run_eos, run_ordering) starts a job
// and returns it at once (or once it ends within its waitS), and wait_job
// (waitS 0 is a status check) / cancel_job follow it, so no single host
// command outlives the controller's command timeout. A run started from a
// window (Relax, MD, EOS) is a job too, and its Stop button is cancelJob: the
// assistant sees and stops the user's runs, the user's Stop stops the
// assistant's. One at a time. Jobs live for the page's lifetime.

import { commandError, safeError } from './commands.js';
import { getActiveStructure, getContainerForStructure, getContainerId } from '../state/structures.js';

/** The structure and frame on show: what the next command acts on. */
function activeNow() {
  const structure = getActiveStructure();
  const container = structure ? getContainerForStructure(structure) : null;
  if (!container) return null;
  return { structure: getContainerId(container), name: String(container.fileName), frame: container.structures.indexOf(structure) };
}

/** @type {Map<string, any>} */
const jobs = new Map();
let nextId = 1;

/** Fired on document when a job starts, is asked to stop or ends: windows sync their Run / Stop buttons. */
export const JOBS_CHANGED = 'crysviz:jobs-changed';
const changed = () => { if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(JOBS_CHANGED)); };

/** What a caller sees of a job. */
export function jobView(job) {
  const end = job.finishedAt ?? Date.now();
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    elapsedS: Math.round((end - job.startedAt) / 100) / 10,
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    // A run may switch rows (a new trajectory); say what is active now it ended.
    ...(job.active ? { active: job.active } : {}),
  };
}

/**
 * Start `run(job)` as a job. `run` reports through job.progress and stops
 * early when job.cancelled turns true; what it resolves to is the result.
 * @param {string} kind
 * @param {(job: any) => Promise<any>} run
 */
export function startJob(kind, run) {
  assertNoJob();
  const job = {
    id: `${kind}-${nextId++}`, kind, status: 'running', progress: null,
    result: undefined, error: null, cancelled: false,
    startedAt: Date.now(), finishedAt: null, waiters: [],
  };
  jobs.set(job.id, job);
  Promise.resolve()
    .then(() => run(job))
    .then((result) => { job.result = result; job.status = job.cancelled ? 'cancelled' : 'done'; },
      (error) => { job.error = safeError(error, 'JOB_FAILED'); job.status = 'failed'; })
    .finally(() => {
      job.finishedAt = Date.now();
      job.active = activeNow();
      for (const wake of job.waiters.splice(0)) wake();
      changed();
    });
  changed();
  return job;
}

export function getJob(id) {
  const job = typeof id === 'string' ? jobs.get(id) : undefined;
  if (!job) throw commandError('JOB_NOT_FOUND', `No job ${id}`);
  return job;
}

/** The running job (of `kind`, or of any kind), if any. */
export function runningJob(kind = null) {
  for (const job of jobs.values()) if ((!kind || job.kind === kind) && job.status === 'running') return job;
  return null;
}

/** One calculation at a time: they share the potential and the selected structure. */
export function assertNoJob() {
  const busy = runningJob();
  if (busy) throw commandError('JOB_BUSY', `Job ${busy.id} is still running; wait for it or cancel_job`);
}

/** Every job, briefly; wait_job gives one job's progress and result. */
export function listJobs() {
  return [...jobs.values()].map((job) => ({ jobId: job.id, kind: job.kind, status: job.status }));
}

/** Resolves when the job ends or after waitS, whichever is first. */
export async function waitJob(id, waitS) {
  const job = getJob(id);
  if (job.status === 'running') {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitS * 1000);
      job.waiters.push(() => { clearTimeout(timer); resolve(undefined); });
    });
  }
  return jobView(job);
}

/** Ask a running job to stop; it ends after its current step. */
export function cancelJob(id) {
  const job = getJob(id);
  if (job.status === 'running' && !job.cancelled) {
    job.cancelled = true;
    changed();
  }
  return jobView(job);
}
