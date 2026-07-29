// Generic confirm-style modal — same "png-export-modal card + paste-modal-actions
// row" convention as the app's other confirm dialogs (RaytraceWarningModal.js,
// KeyboardShortcuts.js's confirmResetAllShortcuts), used here because it's
// needed from two places (the camera lock and the Features lock, see
// LockToggleButton.js) rather than being a single-use dialog. Native
// window.confirm() was the original choice but always prefixes the message
// with the page's own origin ("localhost:8792 says", or whatever the real
// deployed domain is) — not something a page can suppress or restyle, so a
// custom modal is the only way to drop it.

// Built once (lazily) and reused; hidden between shows.
let modal = null;
let titleEl = null;
let messageEl = null;
let okBtn = null;
let cancelBtn = null;
let previousFocus = null;
let resolveCurrent = null;

function build() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'confirmModal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="lock-confirm-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="confirmModalTitle">
      <h3 id="confirmModalTitle"></h3>
      <p id="confirmModalMessage"></p>
      <div class="paste-modal-actions">
        <button type="button" id="confirmModalOk"></button>
        <button type="button" id="confirmModalCancel"></button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  titleEl = document.getElementById('confirmModalTitle');
  messageEl = document.getElementById('confirmModalMessage');
  okBtn = document.getElementById('confirmModalOk');
  cancelBtn = document.getElementById('confirmModalCancel');

  okBtn.addEventListener('click', () => finish(true));
  cancelBtn.addEventListener('click', () => finish(false));
  modal.addEventListener('click', (e) => { if (e.target === modal) finish(false); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(false); });
}

function finish(confirmed) {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  const target = previousFocus;
  previousFocus = null;
  if (target && typeof target.focus === 'function') {
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
  const resolve = resolveCurrent;
  resolveCurrent = null;
  if (resolve) resolve(confirmed);
}

/** Show the modal and resolve true/false on Ok/Cancel (Escape and a backdrop
 *  click both count as Cancel). Only one instance is ever open at a time —
 *  showing again while one is pending resolves the previous one as
 *  cancelled first. */
export function confirmDialog(message, { title = 'Are you sure?', okLabel = 'Continue', cancelLabel = 'Cancel' } = {}) {
  build();
  if (resolveCurrent) finish(false);
  return new Promise((resolve) => {
    resolveCurrent = resolve;
    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    previousFocus = document.activeElement;
    modal.hidden = false;
    setTimeout(() => okBtn.focus({ preventScroll: true }), 0);
  });
}
