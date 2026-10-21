// Load-time dialog offering what to do with a CIF's declared symmetry, styled
// like the app's other confirm dialogs (ConfirmModal.js) and used the same way
// the phonon length-unit picker (phonon/phononSession.js) is: a single awaited
// choice presented as the file is loaded. It reuses the `.lock-confirm-modal`
// styling (stacked `.confirm-choice` buttons, `.confirm-detail` block) that
// ConfirmModal already defines, and adds a tolerance input for the symmetrise
// path — so the user can choose the symprec the cell is snapped to.
//
// Resolves to { action, tolerance }: action is 'keep' (lock in the CIF's own
// setting), 'symmetrize' (snap onto the symmetry Moyo detects at `tolerance`),
// or 'normal' (load as plain, editable atoms). Escape / backdrop click resolve
// the same value the modal was opened with as its cancel default.

let modal = null;
let titleEl = null;
let messageEl = null;
let detailEl = null;
let tolRowEl = null;
let tolInputEl = null;
let actionsEl = null;
let previousFocus = null;
let resolveCurrent = null;
let cancelValueCurrent = null;

function build() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'cifSymmetryModal';
  modal.hidden = true;
  // Overlay/card/tolerance-row styling lives in styles/styles.css
  // (#cifSymmetryModal, .cif-sym-tol-row) next to the #confirmModal rules.
  modal.innerHTML = `
    <div class="lock-confirm-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="cifSymmetryModalTitle">
      <h3 id="cifSymmetryModalTitle"></h3>
      <p id="cifSymmetryModalMessage"></p>
      <pre id="cifSymmetryModalDetail" class="confirm-detail" hidden></pre>
      <div id="cifSymmetryModalTolRow" class="cif-sym-tol-row" hidden>
        <label for="cifSymmetryModalTol">Symmetrise tolerance (Å)</label>
        <input type="number" id="cifSymmetryModalTol" min="0" step="0.001">
      </div>
      <div class="paste-modal-actions confirm-choices" id="cifSymmetryModalActions"></div>
    </div>
  `;
  document.body.appendChild(modal);

  titleEl = document.getElementById('cifSymmetryModalTitle');
  messageEl = document.getElementById('cifSymmetryModalMessage');
  detailEl = document.getElementById('cifSymmetryModalDetail');
  tolRowEl = document.getElementById('cifSymmetryModalTolRow');
  tolInputEl = /** @type {HTMLInputElement} */ (document.getElementById('cifSymmetryModalTol'));
  actionsEl = document.getElementById('cifSymmetryModalActions');

  modal.addEventListener('click', (e) => { if (e.target === modal) finish(cancelValueCurrent); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(cancelValueCurrent); });
}

function readTolerance(fallback) {
  const value = parseFloat(tolInputEl?.value ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

/** One space group as "H-M (No. N)", falling back gracefully when a field is
 *  missing. `hm` is shown unspaced ("Fm-3m", not "F m -3 m"). */
function formatGroup({ number = null, hm = null } = {}) {
  const parts = [];
  if (hm) parts.push(String(hm).replace(/\s+/g, ''));
  if (Number.isFinite(number)) parts.push(`No. ${number}`);
  return parts.length ? parts.join(' · ') : 'unknown';
}

/**
 * @param {object} opts
 * @param {string} opts.fileName
 * @param {{number:number|null, hm:string|null}} opts.cif        declared in the CIF
 * @param {{number:number|null, hm:string|null}|null} opts.detected  Moyo's finding
 * @param {boolean|null} opts.match   true = agree, false = differ, null = could not compare
 * @param {boolean} opts.hasCifOps    the CIF carried explicit operations that close on the loaded atoms, so they can be kept
 * @param {string} [opts.detectError] Moyo failure message, when detection failed
 * @param {number} opts.tolerance     symprec Moyo was run at / the input's default
 * @returns {Promise<{action:'keep'|'symmetrize'|'normal', tolerance:number}>}
 */
export function promptCifSymmetry({ fileName, cif, detected, match, hasCifOps, detectError = '', tolerance }) {
  build();
  if (resolveCurrent) finish(cancelValueCurrent);

  const name = fileName || 'This CIF';
  const cifLabel = formatGroup(cif);
  const detectedLabel = detectError ? 'analysis failed' : formatGroup(detected ?? {});

  // The cancel default (Escape / backdrop) is the least-surprising outcome: keep
  // the symmetry when it was confirmed to match, otherwise load plain.
  const cancelAction = match === true ? 'keep' : 'normal';

  /** @type {Array<{action:'keep'|'symmetrize'|'normal', label:string, description:string}>} */
  const choices = [];
  let title;
  let message;
  let showTol = false;

  if (detectError) {
    title = 'Symmetry could not be verified';
    message = `${name} declares ${cifLabel}, but its symmetry could not be detected from the geometry.`;
    if (hasCifOps) {
      choices.push({ action: 'keep', label: 'Keep CIF symmetry as declared',
        description: "Trust the file's operations and lock the cell in its own setting." });
    }
    choices.push({ action: 'symmetrize', label: 'Try to symmetrise at a tolerance',
      description: 'Re-run symmetry detection at the tolerance below and snap the cell to it.' });
    showTol = true;
  } else if (match === true) {
    title = 'Keep symmetry from the CIF?';
    message = `${name} declares ${cifLabel}, which matches the symmetry detected from the full structure.`;
    choices.push({ action: 'keep', label: 'Keep symmetry (Wyckoff editor)',
      description: "Load in the CIF's setting with symmetry locked and orbit editing on." });
  } else if (match === null) {
    // Detection worked but the file gave nothing comparable (operations only,
    // no name or number) — say so rather than claiming a mismatch.
    title = 'Declared symmetry could not be compared';
    message = `${name} lists symmetry operations but no space-group name or number; the symmetry detected from the full structure is ${detectedLabel}.`;
    if (hasCifOps) {
      choices.push({ action: 'keep', label: 'Keep CIF symmetry as declared',
        description: "Trust the file's operations and lock the cell in its own setting." });
    }
    choices.push({ action: 'symmetrize', label: 'Symmetrise to the detected symmetry',
      description: 'Snap atoms onto the detected sites at the tolerance below, then lock.' });
    showTol = true;
  } else {
    title = 'Symmetry does not match';
    message = `${name} declares ${cifLabel}, but the symmetry detected from the full structure is ${detectedLabel}.`;
    choices.push({ action: 'symmetrize', label: `Symmetrise to the detected symmetry`,
      description: 'Snap atoms onto the detected sites at the tolerance below, then lock.' });
    if (hasCifOps) {
      choices.push({ action: 'keep', label: 'Keep CIF symmetry as declared',
        description: "Trust the file's operations even though they differ from the geometry." });
    }
    showTol = true;
  }

  choices.push({ action: 'normal', label: 'Load as a normal structure',
    description: 'Discard symmetry; every atom is independently editable.' });

  return new Promise((resolve) => {
    resolveCurrent = resolve;
    cancelValueCurrent = { action: cancelAction, tolerance };

    titleEl.textContent = title;
    messageEl.textContent = message;

    const detailLines = [
      `CIF declared : ${cifLabel}`,
      `Detected     : ${detectError ? `analysis failed (${detectError})` : detectedLabel}`,
    ];
    detailEl.textContent = detailLines.join('\n');
    detailEl.hidden = false;

    tolRowEl.hidden = !showTol;
    if (showTol) tolInputEl.value = String(tolerance);

    actionsEl.innerHTML = '';
    let firstButton = null;
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'confirm-choice';
      const label = document.createElement('span');
      label.className = 'confirm-choice-label';
      label.textContent = choice.label;
      button.appendChild(label);
      const description = document.createElement('span');
      description.className = 'confirm-choice-desc';
      description.textContent = choice.description;
      button.appendChild(description);
      button.addEventListener('click', () => finish({ action: choice.action, tolerance: readTolerance(tolerance) }));
      actionsEl.appendChild(button);
      if (!firstButton) firstButton = button;
    }

    previousFocus = document.activeElement;
    modal.hidden = false;
    if (firstButton) setTimeout(() => firstButton.focus({ preventScroll: true }), 0);
  });
}
