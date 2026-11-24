// Average Structure's warning (Files window ▸ ≡ ▸ Average Structure,
// ui/FileBrowswerPanel.js): some atoms move more than a tenth of a cell axis
// away from where they are in the first frame (model/averageFrames.js
// LARGE_DISPLACEMENT), so their mean can fall between sites. Built like the
// CIF symmetry dialog (CifSymmetryModal.js) and sharing its styling: the
// `.lock-confirm-modal` card, its title and message, and the stacked
// `.confirm-choice` buttons with the recommended one first. Added: the list
// of those atoms, each a button that shows the atom in the 3D view (the
// caller switches to its structure and frame and highlights it). The overlay
// sits the card at the left over the sidebar with a light scrim
// (#averageMovesModal in styles/styles.css), so that atom stays in sight.
//
// Resolves true for "Average anyway", false for "Cancel"; Escape and a click
// on the backdrop cancel. `onClose` runs first either way, so the caller can
// put the view back before whatever comes next.

let modal = null;
let titleEl = null;
let messageEl = null;
let listEl = null;
let actionsEl = null;
let previousFocus = null;
let resolveCurrent = null;
let closeCurrent = null;

function build() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'averageMovesModal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="lock-confirm-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="averageMovesTitle">
      <h3 id="averageMovesTitle"></h3>
      <p id="averageMovesMessage"></p>
      <div id="averageMovesList" class="avg-moves-list"></div>
      <div class="paste-modal-actions confirm-choices" id="averageMovesActions"></div>
    </div>
  `;
  document.body.appendChild(modal);

  titleEl = document.getElementById('averageMovesTitle');
  messageEl = document.getElementById('averageMovesMessage');
  listEl = document.getElementById('averageMovesList');
  actionsEl = document.getElementById('averageMovesActions');

  modal.addEventListener('click', (e) => { if (e.target === modal) finish(false); });
}

/** Escape cancels wherever the focus is (a click on the card's text leaves
 *  it on <body>), and goes no further: the app's own Escape (clear the
 *  selection, close a menu) must not run too. */
function onKey(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  e.preventDefault();
  finish(false);
}

function finish(value) {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.removeEventListener('keydown', onKey, true);
  const close = closeCurrent;
  closeCurrent = null;
  if (close) close();
  // The focus goes back now, not on a timer as the CIF dialog does it: the
  // name prompt that "Average anyway" opens next takes it after this and
  // must keep it.
  const target = previousFocus;
  previousFocus = null;
  if (target && target.isConnected && typeof target.focus === 'function') {
    target.focus({ preventScroll: true });
  }
  const resolve = resolveCurrent;
  resolveCurrent = null;
  if (resolve) resolve(value);
}

/** One choice button, as the CIF dialog draws them. */
function choiceButton(label, description, value) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'confirm-choice';
  const labelEl = document.createElement('span');
  labelEl.className = 'confirm-choice-label';
  labelEl.textContent = label;
  const descEl = document.createElement('span');
  descEl.className = 'confirm-choice-desc';
  descEl.textContent = description;
  button.append(labelEl, descEl);
  button.addEventListener('click', () => finish(value));
  return button;
}

/** "1.20 Å · 0.30 of a" */
export function formatMove({ distance, fraction, axis }) {
  return `${distance.toFixed(2)} Å · ${fraction.toFixed(2)} of ${axis}`;
}

/**
 * @param {object} opts
 * @param {number} opts.frameCount  frames being averaged
 * @param {number} opts.threshold   the fraction of a cell axis that counts as far
 * @param {Array<{name: string, distance: number, fraction: number, axis: string, where: string}>} opts.items
 *   every atom over the threshold, largest move first: its name, its largest
 *   move (Å, fraction of `axis`) and the row and frame it happens in
 * @param {number} [opts.listed]    how many to list by name; the rest are counted
 * @param {(index: number) => void} opts.onShow   show items[index] in the 3D view
 * @param {() => void} opts.onClose put the view back (runs once, before resolving)
 * @returns {Promise<boolean>} true: average anyway
 */
export function promptAverageMoves({ frameCount, threshold, items, listed = 20, onShow, onClose }) {
  build();
  if (resolveCurrent) finish(false);

  const n = items.length;
  titleEl.textContent = n === 1 ? 'An atom moves far between frames' : 'Atoms move far between frames';
  messageEl.textContent = `${n === 1 ? 'One atom moves' : `${n} atoms move`} more than ${threshold} of a cell axis `
    + `away from where ${n === 1 ? 'it is' : 'they are'} in the first of the ${frameCount} frames, so `
    + `${n === 1 ? 'its average position' : 'their average positions'} can fall between sites. `
    + 'Click an atom to see it in its structure, in the frame where it is farthest.';

  listEl.innerHTML = '';
  const rows = [];
  items.slice(0, listed).forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'avg-moves-row';
    row.setAttribute('aria-pressed', 'false');
    row.title = `Show ${item.name} in ${item.where}`;
    const cells = [
      ['avg-moves-name', item.name],
      ['avg-moves-amount', formatMove(item)],
      ['avg-moves-where', item.where],
      ['avg-moves-show', 'Show'],
    ];
    for (const [cls, text] of cells) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      row.appendChild(span);
    }
    row.addEventListener('click', () => {
      rows.forEach((r) => {
        r.classList.toggle('is-shown', r === row);
        r.setAttribute('aria-pressed', String(r === row));
      });
      onShow(index);
    });
    rows.push(row);
    listEl.appendChild(row);
  });
  if (n > listed) {
    const more = document.createElement('div');
    more.className = 'avg-moves-more';
    more.textContent = `and ${n - listed} more`;
    listEl.appendChild(more);
  }

  actionsEl.innerHTML = '';
  const proceed = choiceButton('Average anyway',
    'Make the average structure with these atoms at their mean positions.', true);
  actionsEl.appendChild(proceed);
  actionsEl.appendChild(choiceButton('Cancel', 'Make nothing.', false));

  return new Promise((resolve) => {
    resolveCurrent = resolve;
    closeCurrent = onClose;
    previousFocus = document.activeElement;
    modal.hidden = false;
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => proceed.focus({ preventScroll: true }), 0);
  });
}
