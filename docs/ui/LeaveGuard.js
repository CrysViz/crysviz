// Reload guard: loaded structures live only in this page's memory — nothing
// saves them in the browser — so a stray Cmd+R / Ctrl+R / F5 throws them all
// away. Two layers, armed only while there is something to lose (any structure
// beyond the untouched demo the app loads at start-up):
//
//   - Keyboard reloads (Cmd/Ctrl+R, Cmd/Ctrl+Shift+R, F5, Ctrl+F5) are caught
//     before the browser acts on them and answered with CrysViz's own dialog,
//     which can say what is at stake. "Stay" is the focused default and what
//     Escape means, so a second stray key never reloads.
//   - Everything else that leaves the page (the toolbar reload button, closing
//     the tab, typing a URL) gets the browser's own "Leave site?" prompt via
//     beforeunload. Browsers do not let a page word that prompt. Not armed
//     inside the desktop app's window (pywebview), whose closing it must not
//     get in the way of.
//
// Settings ▸ Warnings ▸ "Disable reload warning" switches both off.

import { structureShip } from '../state/store.js';
import { choiceDialog } from './ConfirmModal.js';
import { getPanelPref } from './panels/PanelManager.js';

let leaving = false; // set once the user chose to reload: let it through
let dialogOpen = false;

/** Is there anything a reload would lose? */
export function hasStructuresToLose() {
  const containers = structureShip.container || [];
  // The start-up demo (crystal-viewer.js loadStructure(..., isDefault))
  // carries isBootDefault; anything else was loaded, pasted, built or run.
  return containers.some((c) => c && !c.isBootDefault);
}

function armed() {
  return !leaving && !getPanelPref('hideLeaveWarning') && hasStructuresToLose();
}

function isReloadKey(e) {
  if (e.key === 'F5') return true;
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyR' || e.key?.toLowerCase() === 'r');
}

async function confirmReload() {
  dialogOpen = true;
  const n = (structureShip.container || []).filter((c) => c && !c.isBootDefault).length;
  const choice = await choiceDialog(
    `${n === 1 ? 'The loaded structure' : `All ${n} loaded structures`} will be lost: CrysViz does not save structures in the browser. `
      + 'To keep them, download them first (Files ▸ Download ▸ CrysViz keeps everything in one file).',
    {
      title: 'Reload CrysViz?',
      choices: [
        { value: 'stay', label: 'Stay', id: 'leaveGuardStay' },
        { value: 'reload', label: 'Reload and lose them', id: 'leaveGuardReload' },
      ],
      cancelValue: 'stay',
    },
  );
  dialogOpen = false;
  if (choice === 'reload') {
    leaving = true;
    window.location.reload();
  }
}

/**
 * Ask before a reload the app itself needs (switching multi-threaded PET-MAD
 * on or off: host/coi.js). Unlike a stray Cmd+R this is asked even with only
 * the start-up demo loaded: a reload also stops calculations still running
 * and drops results nobody downloaded. It is asked even with Settings ▸
 * Warnings ▸ "Disable reload warning" on: that switch silences the guard
 * against reloads by accident, and this one is a click whose reload is easy
 * to miss. Cancel is the focused default and what Escape means. Answering
 * "Reload" lets the reload through without the browser's own "Leave site?"
 * prompt on top; a caller whose reload then does not happen calls
 * reloadAbandoned().
 * @param {string} action what reloads, e.g. "Turning multi-threading on"
 * @returns {Promise<boolean>} true to go ahead with the reload
 */
export async function confirmAppReload(action) {
  const n = (structureShip.container || []).filter((c) => c && !c.isBootDefault).length;
  const lost = [];
  if (n > 0) {
    lost.push(`${n === 1 ? 'the loaded structure' : `all ${n} loaded structures`} `
      + '(to keep them, download them first: Files ▸ Download ▸ CrysViz keeps everything in one file)');
  }
  lost.push('relaxations, MD runs, scans and benchmarks still running');
  lost.push('results not downloaded: plots, benchmark tables, the loaded potential model');
  dialogOpen = true;
  const choice = await choiceDialog(
    `${action} reloads CrysViz. Everything held only in this page is lost:`,
    {
      title: 'Reload CrysViz?',
      detail: lost.map((line) => `• ${line}`).join('\n'),
      choices: [
        { value: 'cancel', label: 'Cancel', id: 'appReloadCancel' },
        { value: 'reload', label: 'Reload', id: 'appReloadOk' },
      ],
      cancelValue: 'cancel',
    },
  );
  dialogOpen = false;
  if (choice !== 'reload') return false;
  leaving = true;
  return true;
}

/** The reload confirmAppReload() let through did not happen: guard again. */
export function reloadAbandoned() {
  leaving = false;
}

/** Wire the guard. Full app only (fullApp.js). */
export function initLeaveGuard() {
  // Capture phase on window: ahead of every other key handler.
  window.addEventListener('keydown', (e) => {
    if (!isReloadKey(e) || !armed()) return;
    e.preventDefault();
    e.stopPropagation();
    if (!dialogOpen) confirmReload();
  }, true);

  window.addEventListener('beforeunload', (e) => {
    if (!armed() || window.pywebview) return;
    e.preventDefault();
    e.returnValue = ''; // older browsers need it set to show the prompt
  });
}
