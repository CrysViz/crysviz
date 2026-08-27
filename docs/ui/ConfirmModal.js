// Generic confirm-style modal — same "png-export-modal card + paste-modal-actions
// row" convention as the app's other confirm dialogs (RaytraceWarningModal.js,
// KeyboardShortcuts.js's confirmResetAllShortcuts), used here because it's
// needed from two places (the camera lock and the Features lock, see
// LockToggleButton.js) rather than being a single-use dialog. Native
// window.confirm() was the original choice but always prefixes the message
// with the page's own origin ("localhost:8792 says", or whatever the real
// deployed domain is) — not something a page can suppress or restyle, so a
// custom modal is the only way to drop it.
//
// Two shapes are offered. `confirmDialog` is the original yes/no. `choiceDialog`
// takes an arbitrary list of options and is used where the answer genuinely is
// not binary — opening a WAVECAR whose cell does not match the loaded structure
// gives the user three real alternatives (cancel, attach anyway, load
// standalone), and collapsing that into Ok/Cancel would hide one of them.

// Built once (lazily) and reused; hidden between shows.
let modal = null;
let titleEl = null;
let messageEl = null;
let detailEl = null;
let actionsEl = null;
let previousFocus = null;
let resolveCurrent = null;
let cancelValueCurrent = false;

function build() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'confirmModal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="lock-confirm-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="confirmModalTitle">
      <h3 id="confirmModalTitle"></h3>
      <p id="confirmModalMessage"></p>
      <pre id="confirmModalDetail" class="confirm-detail" hidden></pre>
      <div class="paste-modal-actions" id="confirmModalActions"></div>
    </div>
  `;
  document.body.appendChild(modal);

  titleEl = document.getElementById('confirmModalTitle');
  messageEl = document.getElementById('confirmModalMessage');
  detailEl = document.getElementById('confirmModalDetail');
  actionsEl = document.getElementById('confirmModalActions');

  modal.addEventListener('click', (e) => { if (e.target === modal) finish(cancelValueCurrent); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(cancelValueCurrent); });
}

function finish(value) {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  const target = previousFocus;
  previousFocus = null;
  if (target && typeof target.focus === 'function') {
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
  const resolve = resolveCurrent;
  resolveCurrent = null;
  if (resolve) resolve(value);
}

/**
 * Shared show path. Escape and a backdrop click both resolve `cancelValue`.
 * Only one instance is ever open at a time — showing again while one is pending
 * resolves the previous one as cancelled first.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} spec.message
 * @param {string} [spec.detail] preformatted extra context, rendered in a <pre>
 *   so newlines and column alignment survive
 * @param {Array<{value: any, label: string, description?: string, id?: string}>} spec.choices
 * @param {any} spec.cancelValue
 * @param {boolean} [spec.stacked] one full-width button per row, with descriptions
 */
function show({ title, message, detail, choices, cancelValue, stacked = false }) {
  build();
  if (resolveCurrent) finish(cancelValueCurrent);

  return new Promise((resolve) => {
    resolveCurrent = resolve;
    cancelValueCurrent = cancelValue;

    titleEl.textContent = title;
    messageEl.textContent = message;

    if (detail) {
      detailEl.textContent = detail;
      detailEl.hidden = false;
    } else {
      detailEl.textContent = '';
      detailEl.hidden = true;
    }

    actionsEl.innerHTML = '';
    actionsEl.classList.toggle('confirm-choices', stacked);

    let firstButton = null;
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      if (choice.id) button.id = choice.id;
      if (stacked) {
        button.className = 'confirm-choice';
        const label = document.createElement('span');
        label.className = 'confirm-choice-label';
        label.textContent = choice.label;
        button.appendChild(label);
        if (choice.description) {
          const description = document.createElement('span');
          description.className = 'confirm-choice-desc';
          description.textContent = choice.description;
          button.appendChild(description);
        }
      } else {
        button.textContent = choice.label;
      }
      button.addEventListener('click', () => finish(choice.value));
      actionsEl.appendChild(button);
      if (!firstButton) firstButton = button;
    }

    previousFocus = document.activeElement;
    modal.hidden = false;
    if (firstButton) setTimeout(() => firstButton.focus({ preventScroll: true }), 0);
  });
}

/** Show the modal and resolve true/false on Ok/Cancel (Escape and a backdrop
 *  click both count as Cancel). Only one instance is ever open at a time —
 *  showing again while one is pending resolves the previous one as
 *  cancelled first. */
export function confirmDialog(message, { title = 'Are you sure?', okLabel = 'Continue', cancelLabel = 'Cancel' } = {}) {
  return show({
    title,
    message,
    choices: [
      // The ids carry the existing per-button styling in docs/styles/styles.css.
      { value: true, label: okLabel, id: 'confirmModalOk' },
      { value: false, label: cancelLabel, id: 'confirmModalCancel' },
    ],
    cancelValue: false,
  });
}

/**
 * Show a message with a single dismiss button.
 *
 * For telling the user something happened that they did not ask for and cannot
 * undo — the wavefunction cache freeing older bands to stay inside the browser's
 * memory limits, for instance. There is no decision to make, so offering
 * Ok/Cancel would invent one.
 *
 * @param {string} message
 * @param {{title?: string, okLabel?: string, detail?: string}} [options]
 * @returns {Promise<void>}
 */
export function noticeDialog(message, { title = 'Notice', okLabel = 'OK', detail = '' } = {}) {
  return show({
    title,
    message,
    detail,
    choices: [{ value: undefined, label: okLabel, id: 'confirmModalOk' }],
    cancelValue: undefined,
  }).then(() => undefined);
}

/**
 * Show a modal offering several named choices, resolving the chosen `value`.
 * Escape and a backdrop click resolve `cancelValue` (null by default).
 *
 * @param {string} message
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {Array<{value: any, label: string, description?: string}>} [options.choices]
 * @param {string} [options.detail] preformatted extra context shown above the buttons
 * @param {any} [options.cancelValue]
 * @returns {Promise<any>}
 */
export function choiceDialog(message, { title = 'Choose an option', choices = [], detail = '', cancelValue = null } = {}) {
  return show({ title, message, detail, choices, cancelValue, stacked: true });
}
