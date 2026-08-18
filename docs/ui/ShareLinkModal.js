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

/** Open the dialog on `url` and kick off QR generation. */
export function showShareLink(url) {
  initShareLinkModal();
  urlField.value = url;
  previousFocus = document.activeElement;
  modal.hidden = false;
  copyBtn.textContent = 'Copy link';
  renderQR(url);
  setTimeout(() => { copyBtn.focus({ preventScroll: true }); }, 0);
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
