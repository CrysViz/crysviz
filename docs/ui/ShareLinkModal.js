// Share-link dialog: the URL as selectable text, plus a QR code so a phone can
// pick the current view up without anyone having to send (or retype) a
// multi-kilobyte link.
//
// Replaces the old prompt() — a prompt truncates, can't be styled, and gives
// nowhere to put the QR.
//
// The encoder is loaded lazily from a CDN so the dialog's URL half keeps working
// with no network (offline use, and the browsertest sandbox): only the QR panel
// degrades, to a note. Point QR_LIB_URL at a vendored copy when the library
// moves in-tree — nothing else in this file changes.

// downloadBlob/currentBaseName live in SavePanel because that is where every
// other export in the app gets its file from. SavePanel imports ShareModule,
// which imports this file, so the three form a cycle — harmless here because
// nothing is called at module-evaluation time, only from click handlers.
import { downloadBlob, currentBaseName } from './SavePanel.js';

// Nayuki's qrcodegen, MIT, zero dependencies, one self-contained file.
// Annotated as `string` (not the literal) so tsc treats the dynamic import as an
// unresolvable-at-build-time module instead of failing to find it on disk.
/** @type {string} */
const QR_LIB_URL = 'https://cdn.jsdelivr.net/npm/nayuki-qr-code-generator@1.8.0/+esm';

// Quiet zone, in modules. The spec asks for 4; scanners need it to find the
// symbol against the surrounding page.
const QR_BORDER = 4;

// Floor for the exported PNG's edge, in pixels. A dense symbol is ~150 modules
// across, so this keeps every module at least 6px — enough to survive being
// pasted into a slide and reprinted.
const PNG_MIN_EDGE = 1024;

let modal = null;
let urlField = null;
let qrBox = null;
let qrNote = null;
let copyBtn = null;
let qrActions = null;
let previousFocus = null;
let lockRow = null;
let passwordField = null;
let lockNote = null;

// Set each showing: the plaintext ?state=/?z= link, and a closure that turns a
// password into the encrypted ?e= link (null when the origin can't do crypto,
// which hides the password field). See ShareModule.shareStructure.
let plainURL = '';
let encryptURL = null;
// Bumped on every password change so a slow PBKDF2 encrypt from a stale
// keystroke can't overwrite the field after a newer one has resolved.
let encryptSeq = 0;
let encryptDebounce = 0;

// The symbol currently on screen, kept so the PNG export can rasterise from the
// module grid rather than re-encoding or scraping the rendered SVG. Null while
// there is no QR (link too long, or the encoder never loaded).
let currentQR = null;

// Resolves to the library namespace, or null once we know it can't be had.
// Cached across showings so a second Share doesn't re-fetch.
let qrLibPromise = null;

const MODAL_HTML = `
  <div class="share-link-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="shareLinkTitle">
    <h3 id="shareLinkTitle">Share link</h3>
    <div class="share-qr" id="shareLinkQr"></div>
    <div class="share-qr-actions" id="shareLinkQrActions" hidden>
      <button type="button" id="shareLinkQrPng">Download PNG</button>
      <button type="button" id="shareLinkQrSvg">Download SVG</button>
    </div>
    <p class="png-note" id="shareLinkQrNote">Generating QR code…</p>
    <textarea class="share-link-url" id="shareLinkUrl" readonly rows="3" aria-label="Share URL"></textarea>
    <div class="share-link-lock" id="shareLinkLock" hidden>
      <label for="shareLinkPassword">Password (optional)</label>
      <input type="password" id="shareLinkPassword" autocomplete="new-password"
             placeholder="Leave empty for an unprotected link">
      <p class="png-note" id="shareLinkLockNote"></p>
    </div>
    <div class="paste-modal-actions">
      <button type="button" class="png-primary" id="shareLinkCopy">Copy link</button>
      <button type="button" id="shareLinkClose">Close</button>
    </div>
  </div>
`;

/** Build the dialog once, hidden. Idempotent. */
function initShareLinkModal() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'shareLinkModal';
  modal.hidden = true;
  modal.innerHTML = MODAL_HTML;
  document.body.appendChild(modal);

  urlField = /** @type {HTMLTextAreaElement} */ (document.getElementById('shareLinkUrl'));
  qrBox = document.getElementById('shareLinkQr');
  qrNote = document.getElementById('shareLinkQrNote');
  copyBtn = document.getElementById('shareLinkCopy');
  qrActions = document.getElementById('shareLinkQrActions');
  lockRow = document.getElementById('shareLinkLock');
  passwordField = /** @type {HTMLInputElement} */ (document.getElementById('shareLinkPassword'));
  lockNote = document.getElementById('shareLinkLockNote');

  passwordField.addEventListener('input', onPasswordInput);

  copyBtn.addEventListener('click', copyLink);
  document.getElementById('shareLinkQrPng').addEventListener('click', downloadQRPNG);
  document.getElementById('shareLinkQrSvg').addEventListener('click', downloadQRSVG);
  document.getElementById('shareLinkClose').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // Clicking the field hands the whole URL over for a manual copy, which is the
  // fallback when the Clipboard API is unavailable (non-secure origin).
  urlField.addEventListener('focus', () => urlField.select());
}

/**
 * Open the dialog on `url` and kick off QR generation.
 * @param {string} url the plaintext share URL
 * @param {{ encryptURL?: ((password: string) => Promise<string>) | null }} [opts]
 *   encryptURL turns a password into the encrypted variant; when present the
 *   dialog shows an optional password field. Omitted/null hides it.
 */
export function showShareLink(url, { encryptURL: enc = null } = {}) {
  initShareLinkModal();
  plainURL = url;
  encryptURL = enc;
  encryptSeq++;                 // invalidate any in-flight encrypt from last showing
  clearTimeout(encryptDebounce);
  passwordField.value = '';
  lockNote.textContent = '';
  lockRow.hidden = !enc;        // no crypto (insecure origin) -> no field
  urlField.value = url;
  previousFocus = document.activeElement;
  modal.hidden = false;
  copyBtn.textContent = 'Copy link';
  renderQR(url);
  setTimeout(() => { copyBtn.focus({ preventScroll: true }); }, 0);
}

/** Password field changed: debounce (PBKDF2 is deliberately slow), then swap
 *  the URL/QR between the plaintext and encrypted forms. */
function onPasswordInput() {
  clearTimeout(encryptDebounce);
  const seq = ++encryptSeq;
  const password = passwordField.value;
  if (!password || !encryptURL) {
    // Back to the unprotected link, immediately.
    lockNote.textContent = '';
    urlField.value = plainURL;
    renderQR(plainURL);
    return;
  }
  lockNote.textContent = 'Encrypting…';
  encryptDebounce = setTimeout(async () => {
    try {
      const url = await encryptURL(password);
      if (seq !== encryptSeq) return; // a newer keystroke won
      urlField.value = url;
      lockNote.textContent = 'Encrypted — recipients need this password to open the link. Share it separately.';
      renderQR(url);
    } catch (e) {
      if (seq !== encryptSeq) return;
      console.error('Failed to encrypt share link:', e);
      lockNote.textContent = 'Could not encrypt the link.';
    }
  }, 300);
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

function copyLink() {
  const text = urlField.value;
  const done = () => {
    copyBtn.textContent = 'Copied';
    setTimeout(() => { if (copyBtn) copyBtn.textContent = 'Copy link'; }, 1500);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => { urlField.focus(); });
  } else {
    urlField.focus(); // selects; the user copies by hand
  }
}

function loadQRLib() {
  if (!qrLibPromise) {
    qrLibPromise = import(QR_LIB_URL).then(mod => mod.default ?? mod, () => null);
  }
  return qrLibPromise;
}

/** Draw the QR for `url`, or explain why there isn't one. Late replies are
 *  dropped if a newer showing has already replaced the URL. */
async function renderQR(url) {
  qrBox.innerHTML = '';
  currentQR = null;
  qrActions.hidden = true;
  qrNote.textContent = 'Generating QR code…';

  const qrcodegen = await loadQRLib();
  if (urlField.value !== url) return;
  if (!qrcodegen) {
    qrNote.textContent = 'QR code unavailable (the encoder could not be loaded — offline?). Copy the link instead.';
    return;
  }

  let qr;
  try {
    // LOW error correction: these URLs run right up against the format's byte
    // ceiling, and the redundancy buys nothing on a screen that isn't smudged.
    qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.LOW);
  } catch {
    qrNote.textContent =
      `Link is ${url.length} characters — too long for a QR code (the format holds about 2950). `
      + 'Copy the link instead.';
    return;
  }

  currentQR = qr;
  qrBox.innerHTML = qrSVG(qr);
  qrActions.hidden = false;
  qrNote.textContent = 'Scan to open this view on another device.';
}

/** `<structure>-qr`, matching what the PNG/POSCAR exports name their files. */
function qrFileBase() {
  return `${currentBaseName()}-qr`;
}

function downloadQRSVG() {
  if (!currentQR) return;
  downloadBlob(`${qrFileBase()}.svg`,
    new Blob([qrSVG(currentQR)], { type: 'image/svg+xml' }));
}

function downloadQRPNG() {
  if (!currentQR) return;
  // Rasterised straight from the module grid — going via the on-screen SVG
  // would inherit its CSS size and resample the modules into grey edges that
  // scanners struggle with.
  const span = currentQR.size + QR_BORDER * 2;
  const scale = Math.max(4, Math.ceil(PNG_MIN_EDGE / span));
  const canvas = document.createElement('canvas');
  canvas.width = span * scale;
  canvas.height = span * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < currentQR.size; y++) {
    for (let x = 0; x < currentQR.size; x++) {
      if (currentQR.getModule(x, y)) {
        ctx.fillRect((x + QR_BORDER) * scale, (y + QR_BORDER) * scale, scale, scale);
      }
    }
  }
  canvas.toBlob((blob) => { if (blob) downloadBlob(`${qrFileBase()}.png`, blob); }, 'image/png');
}

/** The symbol as an inline SVG string. Black-on-white regardless of theme —
 *  scanners want the polarity the spec assumes, and an inverted or tinted code
 *  is a support ticket. */
function qrSVG(qr) {
  const span = qr.size + QR_BORDER * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) d += `M${x + QR_BORDER},${y + QR_BORDER}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" `
    + `shape-rendering="crispEdges" role="img" aria-label="QR code for the share link">`
    + `<rect width="${span}" height="${span}" fill="#ffffff"/>`
    + `<path d="${d}" fill="#000000"/></svg>`;
}


// ---------------------------------------------------------------------------
// Password prompt (opening an encrypted ?e= link)
// ---------------------------------------------------------------------------
// A styled replacement for prompt(): built lazily, resolves to the entered
// password or null if the user cancels. ShareModule loops on it, passing
// retry:true after a wrong password.

let promptModal = null;
let promptInput = null;
let promptError = null;
let promptResolve = null;
let promptPrevFocus = null;

const PROMPT_HTML = `
  <div class="share-link-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="sharePwTitle">
    <h3 id="sharePwTitle">Password required</h3>
    <p class="png-note" id="sharePwIntro">This shared link is password-protected. Enter the password to open it.</p>
    <input type="password" id="sharePwInput" autocomplete="current-password" aria-label="Password">
    <p class="png-note share-pw-error" id="sharePwError" hidden>Wrong password \u2014 try again.</p>
    <div class="paste-modal-actions">
      <button type="button" class="png-primary" id="sharePwOpen">Open</button>
      <button type="button" id="sharePwCancel">Cancel</button>
    </div>
  </div>
`;

function initPromptModal() {
  if (promptModal) return;
  promptModal = document.createElement('div');
  promptModal.id = 'sharePasswordModal';
  promptModal.hidden = true;
  promptModal.innerHTML = PROMPT_HTML;
  document.body.appendChild(promptModal);

  promptInput = /** @type {HTMLInputElement} */ (document.getElementById('sharePwInput'));
  promptError = document.getElementById('sharePwError');

  document.getElementById('sharePwOpen').addEventListener('click', () => settlePrompt(promptInput.value));
  document.getElementById('sharePwCancel').addEventListener('click', () => settlePrompt(null));
  promptModal.addEventListener('click', (e) => { if (e.target === promptModal) settlePrompt(null); });
  promptModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') settlePrompt(null);
    else if (e.key === 'Enter') { e.preventDefault(); settlePrompt(promptInput.value); }
  });
}

/** Show the prompt and resolve with the password, or null if cancelled.
 *  @param {{ retry?: boolean }} [opts] retry:true shows the wrong-password note. */
export function promptSharePassword({ retry = false } = {}) {
  initPromptModal();
  promptError.hidden = !retry;
  promptInput.value = '';
  promptPrevFocus = document.activeElement;
  promptModal.hidden = false;
  setTimeout(() => promptInput.focus({ preventScroll: true }), 0);
  return new Promise((resolve) => { promptResolve = resolve; });
}

function settlePrompt(value) {
  if (!promptResolve) return;
  const resolve = promptResolve;
  promptResolve = null;
  promptModal.hidden = true;
  const target = promptPrevFocus;
  promptPrevFocus = null;
  if (target && typeof target.focus === 'function') {
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
  resolve(value);
}
