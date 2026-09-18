// "Quantum ESPRESSO input" modal.
//
// CrysViz only knows the structure, not the calculation (namelists,
// pseudopotentials, k-points), so a full scf.in cannot be written. Instead of
// downloading an incomplete file, this shows the STRUCTURAL cards
// (ATOMIC_SPECIES / CELL_PARAMETERS / ATOMIC_POSITIONS) as selectable text with
// a Copy button, to paste into an existing pw.x input. Informational: Copy,
// Close, Escape or a backdrop click dismiss it. Reuses the modal card styles.

let modal = null;
let textArea = null;
let copyBtn = null;
let previousFocus = null;

const MODAL_HTML = `
  <div class="png-export-modal qe-input-modal" role="dialog" aria-modal="true" aria-labelledby="qeInputTitle">
    <h3 id="qeInputTitle">Quantum ESPRESSO input</h3>
    <p class="qe-input-note">
      CrysViz knows the structure, not the calculation, so it can't write a whole
      <code>scf.in</code>. Copy these structural cards into your pw.x input —
      below the <code>&amp;CONTROL</code> / <code>&amp;SYSTEM</code> /
      <code>&amp;ELECTRONS</code> namelists — and add pseudopotentials and a
      <code>K_POINTS</code> card.
    </p>
    <textarea class="qe-input-text" id="qeInputText" readonly rows="14" spellcheck="false" aria-label="Quantum ESPRESSO structural cards"></textarea>
    <div class="paste-modal-actions">
      <button type="button" id="qeInputCopy" class="png-primary">Copy</button>
      <button type="button" id="qeInputClose">Close</button>
    </div>
  </div>
`;

function initModal() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'qeInputModal';
  modal.hidden = true;
  modal.innerHTML = MODAL_HTML;
  document.body.appendChild(modal);

  textArea = document.getElementById('qeInputText');
  copyBtn = document.getElementById('qeInputCopy');
  const closeBtn = document.getElementById('qeInputClose');

  copyBtn.addEventListener('click', copy);
  closeBtn.addEventListener('click', close);
  // Clicking the field selects it all for a manual copy.
  textArea.addEventListener('focus', () => textArea.select());
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

function copy() {
  const text = textArea.value;
  const done = () => {
    copyBtn.textContent = 'Copied';
    setTimeout(() => { if (copyBtn) copyBtn.textContent = 'Copy'; }, 1500);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => { textArea.focus(); });
  } else {
    textArea.focus(); // selects; the user copies by hand
  }
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

/** Show the QE structural cards for copying. @param {string} text */
export function showQEInputModal(text) {
  initModal();
  textArea.value = String(text || '');
  previousFocus = document.activeElement;
  modal.hidden = false;
  setTimeout(() => { if (copyBtn) copyBtn.focus({ preventScroll: true }); }, 0);
}
