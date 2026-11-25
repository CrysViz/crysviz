/**
 * Which potential a computation runs with, and how far to trust it.
 *
 * The Atomistic window chooses the potential (general.atomisticPotential) and
 * reports the model behind it here (setPotentialLabel); every window that
 * computes with it (EOS, Order Structure, phonon mode maps, and the Atomistic
 * window itself) mounts a notice that names it and carries the accuracy
 * caveat, plus a warning when NEP meets high pressure. The caveat can be
 * collapsed to a small orange ⚠ that expands it again (its Collapse button,
 * Settings ▸ Warnings); the pressure warning always shows in full.
 */
import { general } from '../state/store.js';
import { getPanelPref, setPanelPref } from '../ui/panels/PanelManager.js';

const CHANGE_EVENT = 'crysviz:potential-change';

/** Pressure (GPa, compression positive) from which a NEP run gets the high-pressure warning. */
export const NEP_HIGH_PRESSURE_GPA = 5;

/** What every potential carries. */
export const ACCURACY_CAVEAT = 'Machine-learned potentials come with their own errors, which can be large '
  + 'for structures unlike their training data. Check the results that matter against DFT before using them '
  + 'in production runs.';

/** Per potential, after the general caveat (NEP's pressure limit is its own warning, below). */
const SPECIFIC_CAVEAT = {
  nep: '',
  mlip: '',
  ase: 'How accurate it is depends on the model the server runs.',
};

const NAMES = { nep: 'NEP', mlip: 'PET-MAD', ase: 'ASE' };

/**
 * The model behind each potential: a string, or a function the Atomistic
 * window registers to read its current state at render time.
 * @type {Record<string, string | (() => string)>}
 */
const labels = {
  nep: 'NEP89 (in your browser)',
  mlip: 'PET-MAD xs (in your browser)',
  ase: 'a model on your ASE server (not connected)',
};

/**
 * @param {unknown} p
 * @returns {'nep'|'mlip'|'ase'}
 */
function normalize(p) {
  return p === 'mlip' || p === 'ase' ? p : 'nep';
}

/** @returns {'nep'|'mlip'|'ase'} */
export function activePotential() {
  return normalize(general.atomisticPotential);
}

function modelOf(potential) {
  const label = labels[potential];
  try {
    return typeof label === 'function' ? label() : label;
  } catch {
    return '';
  }
}

/**
 * "PET-MAD: PET-MAD xs (in your browser)" for the active (or a given) potential.
 * @param {string} [potential]
 */
export function potentialLabel(potential = activePotential()) {
  const p = normalize(potential);
  return `${NAMES[p]}: ${modelOf(p)}`;
}

/**
 * The model a result computed with this potential came from, short, for the
 * Parameters section's "Source:" (model/dataSource.js): "PET-MAD xs",
 * "NEP89", "my-model.pt (local file)", "<model> (ASE server)" — never the
 * server's address (a .crysviz session carries it).
 * @param {string} [potential]
 */
export function potentialSource(potential = activePotential()) {
  const p = normalize(potential);
  const model = modelOf(p).trim();
  if (p === 'ase') {
    const connected = /^(.*\S) on \S+$/.exec(model);
    return connected && !/\(not connected\)$/.test(model) ? `${connected[1]} (ASE server)` : 'ASE server';
  }
  const short = model
    .replace(/\s*\(local file, in your browser\)$/, ' (local file)')
    .replace(/\s*\(in your browser\)$/, '');
  return short || NAMES[p];
}

/**
 * The Atomistic window reports the model behind a potential (the selected
 * PET-MAD model, the ASE server's model), as text or as a function read
 * whenever a notice renders.
 * @param {'nep'|'mlip'|'ase'} potential
 * @param {string | (() => string)} label
 */
export function setPotentialLabel(potential, label) {
  labels[potential] = label;
  notifyPotentialChange();
}

/**
 * Call `listener` whenever the notices re-render (the potential, its model or
 * the hidden-caveat preference changed). Returns a function that stops it.
 * @param {() => void} listener
 */
export function onPotentialChange(listener) {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/** Re-render every mounted notice (the potential or its model changed). */
export function notifyPotentialChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Whether the accuracy caveat is collapsed to its ⚠ (Collapse on a notice; Settings ▸ Warnings). */
export function isPotentialCaveatCollapsed() {
  return !!getPanelPref('collapsePotentialCaveat');
}

/**
 * Collapse the accuracy caveat to its ⚠, or expand it, in every notice. The
 * NEP high-pressure warning is not affected: it only appears when the
 * pressure is in play, and then in full.
 * @param {boolean} collapsed
 */
export function setPotentialCaveatCollapsed(collapsed) {
  setPanelPref('collapsePotentialCaveat', !!collapsed);
  notifyPotentialChange();
}

/**
 * The caveat for a potential: the general one plus its own.
 * @param {string} [potential]
 */
export function potentialCaveat(potential = activePotential()) {
  return [ACCURACY_CAVEAT, SPECIFIC_CAVEAT[normalize(potential)]].filter(Boolean).join(' ');
}

/**
 * A warning when NEP is asked for, or sits at, high pressure; '' otherwise.
 * @param {string} potential
 * @param {{ label: string, gpa: number }[]} pressures  compression positive
 */
export function highPressureWarning(potential, pressures) {
  if (potential !== 'nep') return '';
  const high = pressures.filter((p) => Number.isFinite(p.gpa) && p.gpa >= NEP_HIGH_PRESSURE_GPA);
  if (!high.length) return '';
  const where = high.map((p) => `${p.label} ${Number(p.gpa.toFixed(1))} GPa`).join(', ');
  return `${where.charAt(0).toUpperCase()}${where.slice(1)}. For pressures above ${NEP_HIGH_PRESSURE_GPA} GPa, `
    // A non-breaking hyphen: "PET-" / "MAD" split across lines in narrow windows.
    + 'PET\u2011MAD models are recommended.';
}

/**
 * A notice in a window that computes with the active potential: which one it
 * is (unless `showPotential` is false), the caveat, and the high-pressure
 * warning for the pressures `pressures()` returns. Re-renders when the
 * potential or its model changes; call `update()` when the pressures do.
 * @param {HTMLElement} host  appended to, or `before` it when given
 * @param {{ pressures?: () => { label: string, gpa: number }[], showPotential?: boolean,
 *           before?: Element|null, where?: string, inline?: Element|null }} [options]
 *   `inline`: where the collapsed ⚠ goes when there is no "Runs with …" line
 *   (the Atomistic window's "Choose potential" label); the notice otherwise.
 * @returns {{ element: HTMLElement, update: () => void }}
 */
export function mountPotentialNotice(host, { pressures = () => [], showPotential = true, before = null,
  where = 'the Atomistic window', inline = null } = {}) {
  const el = document.createElement('div');
  el.className = 'potential-notice';
  el.dataset.role = 'potential-notice';
  if (before) host.insertBefore(el, before);
  else host.appendChild(el);

  // Stop listening once the notice has been in the page and left it (its
  // window was rebuilt); one built in a detached container waits.
  let wasConnected = false;
  /** @type {HTMLButtonElement|null} */
  let expand = null;
  const render = () => {
    if (el.isConnected) wasConnected = true;
    else if (wasConnected) {
      window.removeEventListener(CHANGE_EVENT, render);
      return;
    }
    const potential = activePotential();
    el.dataset.potential = potential;
    el.replaceChildren();
    expand?.remove(); // it may sit outside the notice (`inline`)
    expand = null;
    let line = null;
    if (showPotential) {
      line = document.createElement('div');
      line.className = 'potential-notice-line';
      line.dataset.role = 'potential-notice-line';
      line.append('Runs with ');
      const strong = document.createElement('strong');
      strong.textContent = NAMES[potential];
      line.append(strong, ` — ${modelOf(potential)}. Change it in ${where}.`);
      el.appendChild(line);
    }
    const caveatText = potentialCaveat(potential);
    if (isPotentialCaveatCollapsed()) {
      // The caveat folded to a small orange ⚠: still there, one click away.
      // At the end of the "Runs with …" line when there is one.
      expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'potential-notice-expand';
      expand.dataset.role = 'potential-notice-expand';
      expand.dataset.searchSkip = ''; // search finds Settings ▸ Warnings' switch instead
      expand.textContent = '⚠';
      expand.setAttribute('aria-expanded', 'false');
      expand.setAttribute('aria-label', 'Show the accuracy warning');
      expand.title = `${caveatText} Click to show this warning again.`;
      expand.addEventListener('click', () => setPotentialCaveatCollapsed(false));
      (line ?? inline ?? el).appendChild(expand);
    } else {
      const caveat = document.createElement('div');
      caveat.className = 'potential-notice-caveat';
      caveat.dataset.role = 'potential-notice-caveat';
      const text = document.createElement('span');
      text.textContent = `⚠ ${caveatText}`;
      const collapse = document.createElement('button');
      collapse.type = 'button';
      collapse.className = 'potential-notice-collapse';
      collapse.dataset.role = 'potential-notice-collapse';
      collapse.dataset.searchSkip = '';
      collapse.textContent = 'Collapse';
      collapse.setAttribute('aria-expanded', 'true');
      collapse.title = 'Fold this warning to a small ⚠ in every window; click the ⚠ to show it again.';
      collapse.addEventListener('click', () => setPotentialCaveatCollapsed(true));
      caveat.append(text, collapse);
      el.appendChild(caveat);
    }
    const warning = highPressureWarning(potential, pressures());
    if (warning) {
      const alert = document.createElement('div');
      alert.className = 'potential-notice-alert';
      alert.dataset.role = 'potential-notice-alert';
      alert.setAttribute('role', 'alert');
      alert.textContent = `⚠ ${warning}`;
      el.appendChild(alert);
    }
  };
  window.addEventListener(CHANGE_EVENT, render);
  render();
  return { element: el, update: render };
}
