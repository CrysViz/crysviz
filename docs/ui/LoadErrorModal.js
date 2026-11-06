// File-load feedback modals.
//
// Two floating, informational dialogs sharing one card:
//   showLoadErrorModal   — a load that FAILED (any format). Fired from the single
//                          catch in core/crystal-viewer.js's loadStructure(), so
//                          a parser that throws surfaces a visible warning
//                          instead of failing silently.
//   showLoadWarningModal — a load that SUCCEEDED but dropped something (e.g. an
//                          aims.out that is spin-polarised but whose per-atom
//                          moments could not be parsed). The structure still
//                          loads; this tells the user what was left out.
//
// Both are informational: OK / Escape / backdrop click close them. Reuses the
// modal card styles (.png-export-modal + .paste-modal-actions).

let modal = null;
let okBtn = null;
let titleEl = null;
let messageEl = null;
let detailEl = null;
let previousFocus = null;

const MODAL_HTML = `
  <div class="png-export-modal load-error-modal" role="alertdialog" aria-modal="true" aria-labelledby="loadErrorTitle" aria-describedby="loadErrorMessage">
    <h3 id="loadErrorTitle"></h3>
    <p id="loadErrorMessage" class="load-error-message"></p>
    <p id="loadErrorDetail" class="load-error-detail" hidden></p>
    <div class="paste-modal-actions">
      <button type="button" id="loadErrorOk" class="png-primary">OK</button>
    </div>
  </div>
`;

/** Build the modal DOM once, hidden. Idempotent. */
function initModal() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'loadErrorModal';
  modal.hidden = true;
  modal.innerHTML = MODAL_HTML;
  document.body.appendChild(modal);

  okBtn = document.getElementById('loadErrorOk');
  titleEl = document.getElementById('loadErrorTitle');
  messageEl = document.getElementById('loadErrorMessage');
  detailEl = document.getElementById('loadErrorDetail');

  okBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

function close() {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  const target = previousFocus;
  previousFocus = null;
  if (target && typeof target.focus === 'function') {
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
}

/** Open the shared modal with the given title/message/detail and tone class. */
function openModal({ title, message, detail, tone }) {
  initModal();
  titleEl.textContent = title;
  messageEl.textContent = message;
  if (detail) {
    detailEl.textContent = detail;
    detailEl.hidden = false;
  } else {
    detailEl.textContent = '';
    detailEl.hidden = true;
  }
  modal.classList.toggle('load-modal-warning', tone === 'warning');
  previousFocus = document.activeElement;
  modal.hidden = false;
  setTimeout(() => { if (okBtn) okBtn.focus({ preventScroll: true }); }, 0);
}

/** Quote a file name into a sentence fragment, or fall back to "The file". */
function subject(fileName, capitalized) {
  const name = String(fileName || '').trim();
  if (name) return `“${name}”`;
  return capitalized ? 'The file' : 'the file';
}

/**
 * Show the load-FAILED warning.
 * @param {{ fileName?: string, message?: string }} [info]
 *   fileName — the file that failed; message — the technical reason (optional).
 */
export function showLoadErrorModal({ fileName = '', message = '' } = {}) {
  const name = String(fileName || '').trim();
  openModal({
    title: 'This file could not be loaded',
    message: name
      ? `${subject(name, true)} could not be read. It may be corrupt, empty, or not in a supported format.`
      : 'The file could not be read. It may be corrupt, empty, or not in a supported format.',
    detail: String(message || '').trim(),
    tone: 'error',
  });
}

/**
 * Show a load-SUCCEEDED-with-a-warning notice (the structure loaded, but part of
 * it was dropped).
 * @param {{ fileName?: string, message?: string, detail?: string }} [info]
 *   message — what was dropped and why; detail — optional extra context.
 */
export function showLoadWarningModal({ fileName = '', message = '', detail = '' } = {}) {
  openModal({
    title: 'Loaded with a warning',
    message: message || `${subject(fileName, true)} loaded, but some data could not be read.`,
    detail: String(detail || '').trim(),
    tone: 'warning',
  });
}
