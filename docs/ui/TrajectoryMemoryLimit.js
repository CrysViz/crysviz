// Settings ▸ Memory ▸ "Trajectory memory": how much memory a loaded
// trajectory's frames may take. A trajectory that would take more asks what to
// load — every n-th frame, the first frames that fit, or everything (this
// once, or raising the limit to fit) — before it is parsed where the reader
// can estimate it (.xyz), else right after (io/trajectoryLoadPlan.js).

import { getPanelPref, setPanelPref } from './panels/PanelManager.js';
import { choiceDialog } from './ConfirmModal.js';
import { setTrajectoryLoadPlanner, LOAD_ALL } from '../io/trajectoryLoadPlan.js';

export const TRAJECTORY_MEMORY_MIN_GIB = 0.5;
export const TRAJECTORY_MEMORY_MAX_GIB = 16;
export const TRAJECTORY_MEMORY_STEP_GIB = 0.5;
const GIB = 2 ** 30;

/** The limit in GiB (clamped, so a corrupted pref cannot disable it). */
export function trajectoryMemoryGiB() {
  const gib = Number(getPanelPref('trajectoryMemoryGiB'));
  return Math.min(TRAJECTORY_MEMORY_MAX_GIB, Math.max(TRAJECTORY_MEMORY_MIN_GIB, Number.isFinite(gib) && gib > 0 ? gib : 2));
}

function formatBytes(bytes) {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(2)} GiB` : `${Math.max(1, Math.round(bytes / 2 ** 20))} MiB`;
}

const ordinal = (n) => {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/**
 * The planner: everything when it fits, else the user's choice.
 * @param {import('../io/trajectoryLoadPlan.js').TrajectoryEstimate} est
 * @returns {Promise<import('../io/trajectoryLoadPlan.js').TrajectoryPlan | null>}
 */
async function planLoad(est) {
  const limitGiB = trajectoryMemoryGiB();
  const budget = limitGiB * GIB;
  if (!(est.bytes > budget) || !(est.bytesPerFrame > 0)) return LOAD_ALL;
  const about = est.estimated ? 'about ' : '';
  const fit = Math.max(1, Math.min(est.frames, Math.floor(budget / est.bytesPerFrame)));
  const stride = Math.max(2, Math.ceil(est.frames / fit));
  const strideFrames = Math.ceil(est.frames / stride);
  const raiseGiB = Math.min(TRAJECTORY_MEMORY_MAX_GIB,
    Math.ceil(est.bytes / GIB / TRAJECTORY_MEMORY_STEP_GIB) * TRAJECTORY_MEMORY_STEP_GIB);
  const frames = (n) => `${n.toLocaleString()} frame${n === 1 ? '' : 's'}`;
  const choice = await choiceDialog(
    `"${est.fileName}" has ${about}${frames(est.frames)} of ${est.atoms.toLocaleString()} atoms: `
    + `${about}${formatBytes(est.bytes)} in memory, above the trajectory memory limit of ${limitGiB} GiB `
    + '(Settings ▸ Memory). What should be loaded?',
    {
      title: 'Trajectory above the memory limit',
      choices: [
        { value: 'stride', id: 'trajMemStride', label: `Every ${ordinal(stride)} frame`, description: `${about}${frames(strideFrames)}, ${formatBytes(strideFrames * est.bytesPerFrame)}` },
        { value: 'first', id: 'trajMemFirst', label: `The first ${frames(fit)}`, description: formatBytes(fit * est.bytesPerFrame) },
        { value: 'raise', id: 'trajMemRaise', label: `Everything, and raise the limit to ${raiseGiB} GiB`, description: `${about}${formatBytes(est.bytes)}` },
        { value: 'all', id: 'trajMemAll', label: 'Everything, this time', description: `${about}${formatBytes(est.bytes)}; the limit stays ${limitGiB} GiB` },
        { value: null, id: 'trajMemCancel', label: 'Cancel' },
      ],
      cancelValue: null,
    });
  if (choice === 'stride') return { stride, maxFrames: Infinity };
  if (choice === 'first') return { stride: 1, maxFrames: fit };
  if (choice === 'raise') {
    setPanelPref('trajectoryMemoryGiB', raiseGiB);
    document.dispatchEvent(new CustomEvent('crysviz:trajectory-memory-changed', { detail: { gib: raiseGiB } }));
    return LOAD_ALL;
  }
  if (choice === 'all') return LOAD_ALL;
  return null;
}

/** Register the planner (the full app; embeds load everything). */
export function installTrajectoryMemoryLimit() {
  setTrajectoryLoadPlanner(planLoad);
}
