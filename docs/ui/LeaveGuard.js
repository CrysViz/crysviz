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
