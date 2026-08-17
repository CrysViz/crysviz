// Shared "lock/unlock" icon toggle button — a single padlock glyph; clicking
// draws a diagonal strike through it rather than swapping to a different
// icon, so "locked"/"unlocked" reads as one glyph's state, not two icons.
// The button is used by the camera panel's per-structure camera lock
// (WindowAndSceneControls.js). FeatureLockModule.js reuses this module's icon
// factory for its in-panel shared-view switch, with a normal checkbox carrying
// the feature flag's own behavior.

import { confirmDialog } from './ConfirmModal.js';

/** Create the shared padlock glyph. The feature shared-view switch uses the
 * same lock body without the strike; the camera button keeps the strike to
 * show its unlocked state. */
export function createLockIcon({ strike = true } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <rect x="5" y="11" width="14" height="10" rx="2.5"></rect>
    <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
    ${strike ? '<line class="lock-strike" x1="3" y1="21" x2="21" y2="3"></line>' : ''}
  `;
  return svg;
}

export function createLockToggleButton({
  className = '', titleLocked, titleUnlocked, locked = true, onChange, confirmOnLock,
}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `lock-toggle-btn ${className}`.trim();
  btn.appendChild(createLockIcon());

  let isLocked = locked;
  const sync = () => {
    btn.classList.toggle('locked', isLocked);
    btn.classList.toggle('unlocked', !isLocked);
    btn.title = isLocked ? titleLocked : titleUnlocked;
    btn.setAttribute('aria-pressed', String(!isLocked));
  };
  sync();

  btn.addEventListener('click', async () => {
    const next = !isLocked;
    // Locking (not unlocking) is the destructive direction: every structure
    // reverts to following this one shared view/settings going forward, so
    // whatever the other structures had drifted to independently stops being
    // used. Confirm before committing to that — a custom modal (ConfirmModal.js),
    // not window.confirm(), which always prefixes its message with the
    // page's own origin ("localhost:8792 says...").
    if (next && confirmOnLock) {
      const ok = await confirmDialog(confirmOnLock, { title: 'Lock this setting?', okLabel: 'Lock' });
      if (!ok) return;
    }
    isLocked = next;
    sync();
    onChange(isLocked);
  });

  return btn;
}
