// Long-running host work (MD first; relaxation and phonons can use the same):
// a command starts a job and returns its id at once, and job_status /
// wait_job / cancel_job follow it, so no single host command outlives the
// controller's command timeout. Jobs live for the page's lifetime.

import { commandError, safeError } from './commands.js';

/** @type {Map<string, any>} */
const jobs = new Map();
let nextId = 1;

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
  };
}

/**
 * Start `run(job)` as a job. `run` reports through job.progress and stops
 * early when job.cancelled turns true; what it resolves to is the result.
 * @param {string} kind
 * @param {(job: any) => Promise<any>} run
 */
export function startJob(kind, run) {
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
      for (const wake of job.waiters.splice(0)) wake();
    });
  return job;
}

export function getJob(id) {
  const job = typeof id === 'string' ? jobs.get(id) : undefined;
  if (!job) throw commandError('JOB_NOT_FOUND', `No job ${id}`);
  return job;
}

/** The running job of a kind, if any. */
export function runningJob(kind) {
  for (const job of jobs.values()) if (job.kind === kind && job.status === 'running') return job;
  return null;
}

export function listJobs() {
  return [...jobs.values()].map(jobView);
}

/** Resolves when the job ends or after timeoutS, whichever is first. */
export async function waitJob(id, timeoutS) {
  const job = getJob(id);
  if (job.status === 'running') {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutS * 1000);
      job.waiters.push(() => { clearTimeout(timer); resolve(undefined); });
    });
  }
  return jobView(job);
}

/** Ask a running job to stop; it ends after its current step. */
export function cancelJob(id) {
  const job = getJob(id);
  if (job.status === 'running') job.cancelled = true;
  return jobView(job);
}
