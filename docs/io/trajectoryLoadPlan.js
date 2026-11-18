// How much of a large trajectory to load. A trajectory's frames live in
// memory (8 bytes per coordinate, forces and spins alike): 100k atoms over
// 200 frames with forces is about 1 GB. The app registers a planner that
// holds that against Settings ▸ Memory ▸ "Trajectory memory" and asks the
// user what to load when it does not fit (ui/TrajectoryMemoryLimit.js).
// Readers that can estimate a trajectory before parsing it (ReadeXYZModule.js)
// ask here first and load only the planned frames; other readers' results are
// trimmed after parsing (planLoadedTrajectory). Without a planner (embeds,
// headless use) everything is loaded.

/** The user cancelled a load (not a failure: no error is shown). */
export class LoadCancelledError extends Error {
  constructor(message = 'Load cancelled') {
    super(message);
    this.name = 'LoadCancelledError';
  }
}

/**
 * @typedef {{fileName: string, frames: number, atoms: number,
 *   bytesPerFrame: number, bytes: number, estimated: boolean}} TrajectoryEstimate
 * @typedef {{stride: number, maxFrames: number}} TrajectoryPlan
 *   load frames 0, stride, 2·stride, ... — at most maxFrames of them
 */

/** @type {((estimate: TrajectoryEstimate) => Promise<TrajectoryPlan | null>) | null} */
let planner = null;

/** @param {((estimate: TrajectoryEstimate) => Promise<TrajectoryPlan | null>) | null} fn */
export function setTrajectoryLoadPlanner(fn) {
  planner = fn;
}

export const LOAD_ALL = Object.freeze({ stride: 1, maxFrames: Infinity });

/**
 * The frames to load of a trajectory of this estimated size.
 * @param {TrajectoryEstimate} estimate
 * @returns {Promise<TrajectoryPlan>}
 * @throws {LoadCancelledError} when the user cancels
 */
export async function planTrajectoryLoad(estimate) {
  if (!planner || !(estimate.frames > 1)) return LOAD_ALL;
  const plan = await planner(estimate);
  if (!plan) throw new LoadCancelledError();
  return plan;
}

/** Bytes a frame record holds (shared buffers counted once). */
function frameBytes(frame) {
  const seen = new Set();
  let bytes = 0;
  for (const arr of [frame.positions, frame.forces, frame.spinVectors, frame.spinRaw]) {
    if (!arr || seen.has(arr.buffer)) continue;
    seen.add(arr.buffer);
    bytes += arr.byteLength;
  }
  return bytes;
}

/**
 * Hold a freshly parsed trajectory (not yet shown) against the planner and
 * keep only the planned frames. A no-op for anything already planned before
 * parsing (container.loadPlanned), a single structure, or no planner.
 * @param {any} container
 * @returns {Promise<void>}
 * @throws {LoadCancelledError} when the user cancels
 */
export async function planLoadedTrajectory(container) {
  const store = container?.store;
  if (!planner || container.loadPlanned || !store || store.frameCount < 2) return;
  let bytes = 0;
  for (const frame of store.frames) bytes += frameBytes(frame);
  const frames = store.frameCount;
  const plan = await planTrajectoryLoad({
    fileName: container.fileName ?? '',
    frames,
    atoms: store.frames[0].positions.length / 3,
    bytesPerFrame: bytes / frames,
    bytes,
    estimated: false,
  });
  const steps = [];
  for (let i = 0; i < frames && steps.length < plan.maxFrames; i += plan.stride) steps.push(i);
  if (steps.length < frames) container.keepFrames(steps);
  container.loadPlanned = true;
}
