// Generic reach into every labelled control, window and action of the app,
// for the host commands search_controls / get_control / set_control /
// click_control (commands.js). It drives the feature search's own entries
// (ui/FeatureSearch.js: the generated control index, live harvest, concept
// vocabulary), and acts on a control the way a user would, so the control's
// own handlers run and nothing here duplicates what a control does.
//
// FeatureSearch pulls in the whole UI, so it is imported on first use: this
// module stays importable in Node for the unit tests.

import { commandError } from './commands.js';

const featureSearch = () => import('../ui/FeatureSearch.js');

function nextFrames(n = 2) {
  return new Promise((resolve) => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

/**
 * A stable handle for a feature-search entry: what search_controls returns
 * and the other control commands take.
 * @param {any} entry
 * @returns {string}
 */
export function entryRef(entry) {
  if (entry.type === 'window') return `window:${entry.panelId}`;
  if (entry.type === 'action') return `action:${entry.label}`;
  if (entry.type === 'structure') return `structure:${entry.kind}:${entry.label}`;
  const where = entry.id ? `#${entry.id}` : [entry.section, entry.label].filter(Boolean).join(' › ');
  return `control:${entry.panelId}:${where}`;
}

/** The entry a ref names, from the entries as they are now. */
async function resolve(ref) {
  if (typeof ref !== 'string' || !ref) throw commandError('INVALID_ARGS', 'ref must be a ref from search_controls');
  const { collectEntries } = await featureSearch();
  const entry = collectEntries().find((e) => entryRef(e) === ref);
  if (!entry) throw commandError('CONTROL_NOT_FOUND', `No control, window or action ${ref}; search again with search_controls`);
  return entry;
}

/** The control's element, opening its window (and tabs) when it is not built. */
async function elementFor(entry) {
  if (entry.type !== 'control') throw commandError('NOT_A_CONTROL', `${entryRef(entry)} is not a control; use click_control`);
  let el = entry.el?.isConnected ? entry.el : (entry.id && document.getElementById(entry.id));
  if (!el) el = await (await featureSearch()).goToControl(entry);
  if (!el) throw commandError('CONTROL_UNAVAILABLE', `${entry.label} is not available now (its window may need a structure or other data)`);
  return /** @type {HTMLElement} */ (el);
}

const isToggle = (el) => (el.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (el).type === 'checkbox')
  || el.getAttribute('role') === 'switch';

/** What a control shows now. */
export function describe(entry, el) {
  const out = { ref: entryRef(entry), kind: entry.kind, label: entry.label, path: entry.path || '' };
  if (!el) return out;
  const input = /** @type {HTMLInputElement} */ (el);
  out.disabled = !!input.disabled || el.getAttribute('aria-disabled') === 'true';
  if (isToggle(el)) {
    out.on = el.tagName === 'INPUT' ? input.checked : el.getAttribute('aria-checked') === 'true';
  } else if (el.tagName === 'SELECT') {
    const select = /** @type {HTMLSelectElement} */ (el);
    out.value = select.value;
    out.options = [...select.options].map((o) => ({ value: o.value, label: o.textContent?.trim() || o.value }));
  } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const numeric = input.type === 'range' || input.type === 'number';
    out.value = numeric && input.value !== '' ? Number(input.value) : input.value;
    if (numeric) {
      for (const key of ['min', 'max', 'step']) if (input[key] !== '') out[key] = Number(input[key]);
    }
  } else if (el.hasAttribute('aria-pressed')) {
    out.pressed = el.getAttribute('aria-pressed') === 'true';
  }
  return out;
}

/** search_controls: the feature search's results for a query. */
export async function searchControls(query, limit) {
  const { collectEntries, searchEntries } = await featureSearch();
  const seen = new Set();
  const out = [];
  for (const { entry } of searchEntries(query, collectEntries())) {
    // A "bonds off" switch result stands for its toggle; set_control does the switching.
    const target = entry.switchOf || entry;
    if (target.supercell) continue; // build_supercell does this
    const ref = entryRef(target);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, type: target.type, kind: target.kind, label: target.label, path: target.path || '' });
    if (out.length >= limit) break;
  }
  return out;
}

export async function getControl(ref) {
  const entry = await resolve(ref);
  if (entry.type !== 'control') return describe(entry, null);
  return describe(entry, await elementFor(entry));
}

export async function setControl(ref, value) {
  const entry = await resolve(ref);
  const el = await elementFor(entry);
  const input = /** @type {HTMLInputElement} */ (el);
  if (input.disabled) throw commandError('CONTROL_DISABLED', `${entry.label} is disabled now`);
  if (isToggle(el)) {
    if (typeof value !== 'boolean') throw commandError('INVALID_ARGS', `${entry.label} is a toggle: value must be true or false`);
    const { setToggle } = await featureSearch();
    if (!(await setToggle(entry, value))) throw commandError('CONTROL_FAILED', `${entry.label} could not be switched ${value ? 'on' : 'off'}`);
  } else if (el.tagName === 'SELECT') {
    const select = /** @type {HTMLSelectElement} */ (el);
    const wanted = String(value).trim().toLowerCase();
    const option = [...select.options].find((o) => o.value.toLowerCase() === wanted)
      || [...select.options].find((o) => o.textContent?.trim().toLowerCase() === wanted);
    if (!option) throw commandError('INVALID_ARGS', `${entry.label}: no option ${value}; see get_control for the options`);
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const numeric = input.type === 'range' || input.type === 'number';
    if (numeric) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw commandError('INVALID_ARGS', `${entry.label} takes a number`);
      if ((input.min !== '' && value < Number(input.min)) || (input.max !== '' && value > Number(input.max))) {
        throw commandError('INVALID_ARGS', `${entry.label} takes ${input.min} to ${input.max}`);
      }
    } else if (typeof value !== 'string') {
      throw commandError('INVALID_ARGS', `${entry.label} takes text`);
    }
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    throw commandError('NOT_SETTABLE', `${entry.label} is a ${entry.kind}; use click_control`);
  }
  await nextFrames(2);
  return describe(entry, el);
}

export async function clickControl(ref) {
  const entry = await resolve(ref);
  if (entry.type !== 'control') {
    await (await featureSearch()).activateEntry(entry);
    await nextFrames(2);
    return { ref, done: true };
  }
  const el = await elementFor(entry);
  if (/** @type {HTMLButtonElement} */ (el).disabled) throw commandError('CONTROL_DISABLED', `${entry.label} is disabled now`);
  el.click();
  await nextFrames(2);
  return describe(entry, el);
}

/** read_window: a window's status line and visible text, so a result shown only there can be read. */
export const MAX_WINDOW_TEXT = 4000;

export async function readWindow(panelId) {
  if (typeof panelId !== 'string' || !panelId) throw commandError('INVALID_ARGS', 'panel must be a window id, e.g. "eos" (see search_controls)');
  const { getPanel, listPanels } = await import('../ui/panels/PanelManager.js');
  const info = listPanels().find((p) => p.id === panelId);
  if (!info) throw commandError('CONTROL_NOT_FOUND', `No window ${panelId}; search_controls lists windows as window:<id>`);
  let panel = getPanel(panelId);
  if (!panel?.built || panel.closed || panel.collapsed) {
    // Open it the way choosing the window in the feature search does.
    await (await featureSearch()).activateEntry({ type: 'window', panelId });
    await nextFrames(2);
    panel = getPanel(panelId);
  }
  const status = panel?.statusEl && !panel.statusEl.hidden ? panel.statusEl.textContent?.trim() || '' : '';
  const text = (panel?.body?.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    panel: panelId,
    title: info.title,
    status,
    text: text.slice(0, MAX_WINDOW_TEXT),
    ...(text.length > MAX_WINDOW_TEXT ? { truncated: true } : {}),
  };
}
