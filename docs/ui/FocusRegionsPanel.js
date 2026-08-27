import { fileBrowser } from '../state/store.js';
import {
  applyFocusRegions, createFocusRegion, getFocusRegions, prepareFocusRegions,
  removeFocusRegion, resetFocusRegionCenter, setFocusRegionCenterFractional,
} from '../render/index.js';
import { getSelectedAtoms, subscribeToAtomSelection } from './SelectAndHighlightModule.js';
import { createToggleRow } from './ToggleSwitch.js';

let unsubscribeSelection = null;

function atomLabel(atom) {
  return `${atom.element ?? '?'} ${Number(atom.sourceIndex) + 1}`;
}

function button(label, className, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function rangeRow(label, value, min, max, step, onInput) {
  const row = document.createElement('label');
  row.className = 'focus-regions-range';
  const heading = document.createElement('span');
  heading.className = 'focus-regions-range-heading';
  const text = document.createElement('span');
  text.textContent = label;
  const output = document.createElement('output');
  const isOpacity = max === 1;
  output.textContent = isOpacity ? `${Math.round(value * 100)}%` : `${Number(value).toFixed(1)} Å`;
  heading.append(text, output);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const next = Number(input.value);
    output.textContent = isOpacity ? `${Math.round(next * 100)}%` : `${next.toFixed(1)} Å`;
    onInput(next);
  });
  row.append(heading, input);
  return row;
}

function describeSources(indices, structure) {
  return indices.map((index) => `${structure.elements?.[index] ?? '?'} ${index + 1}`).join(', ');
}

function centerEditor(region, rerender) {
  const wrap = document.createElement('div');
  wrap.className = 'focus-regions-center';
  const label = document.createElement('span');
  label.textContent = 'Center (fractional)';
  const coordinates = document.createElement('div');
  coordinates.className = 'focus-regions-center-coordinates';
  const values = region.centerFractional ?? [0, 0, 0];
  const inputs = ['x', 'y', 'z'].map((axis, index) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.001';
    input.value = Number(values[index] ?? 0).toFixed(5);
    input.setAttribute('aria-label', `Center ${axis} fractional coordinate`);
    input.addEventListener('change', () => {
      const next = inputs.map((entry) => Number(entry.value));
      if (!setFocusRegionCenterFractional(region, next)) rerender();
    });
    return input;
  });
  const reset = button('Reset', 'btn-mini', () => {
    resetFocusRegionCenter(region);
    rerender();
  });
  coordinates.append(...inputs, reset);
  wrap.append(label, coordinates);
  return wrap;
}

function renderRegionCard(region, index, rerender) {
  const structure = fileBrowser.selectedStructure;
  const card = document.createElement('section');
  card.className = 'focus-regions-card';
  card.dataset.regionId = region.id;

  const header = document.createElement('div');
  header.className = 'focus-regions-card-header';
  const title = document.createElement('strong');
  const centers = describeSources(region.centerSourceIndices ?? [], structure);
  title.textContent = `Region ${index + 1}${centers ? ` — ${centers}` : ''}`;
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = region.enabled !== false;
  enabled.title = 'Enable focus region';
  enabled.setAttribute('aria-label', `Enable Region ${index + 1}`);
  enabled.addEventListener('change', () => { region.enabled = enabled.checked; applyFocusRegions(); });
  header.append(enabled, title, button('×', 'btn-mini focus-regions-delete', () => {
    removeFocusRegion(region.id);
    rerender();
  }));
  card.appendChild(header);

  const centerLine = document.createElement('div');
  centerLine.className = 'focus-regions-summary';
  centerLine.textContent = centers ? `Focus: ${centers}` : 'Focus atoms unavailable';
  card.appendChild(centerLine);

  const innerToggle = createToggleRow({
    id: `focusInner-${region.id}`,
    label: 'Inner region',
    checked: region.innerEnabled !== false,
    onChange(on) { region.innerEnabled = on; rerender(); applyFocusRegions(); },
  });
  card.appendChild(innerToggle.row);
  if (region.innerEnabled !== false) {
    prepareFocusRegions(structure);
    card.appendChild(centerEditor(region, rerender));
    card.appendChild(rangeRow('Inner radius', region.innerRadius, 0, 20, 0.1, (value) => {
      region.innerRadius = value;
      applyFocusRegions();
    }));
    card.appendChild(rangeRow('Inner opacity', region.innerOpacity, 0, 1, 0.01, (value) => {
      region.innerOpacity = value;
      applyFocusRegions();
    }));
  }
  card.appendChild(rangeRow('Outer opacity', region.outerOpacity, 0, 1, 0.01, (value) => {
    region.outerOpacity = value;
    applyFocusRegions();
  }));

  const exceptions = document.createElement('div');
  exceptions.className = 'focus-regions-exceptions';
  const exceptionText = document.createElement('span');
  const refreshExceptionText = () => {
    const labels = describeSources(region.excludedSourceIndices ?? [], structure);
    exceptionText.textContent = labels ? `Exceptions: ${labels}` : 'Exceptions: none';
  };
  refreshExceptionText();
  const addExceptions = button('Exclude selection', 'btn-mini', () => {
    const selected = getSelectedAtoms();
    region.excludedSourceIndices = [...new Set([
      ...(region.excludedSourceIndices ?? []),
      ...selected.map((atom) => atom.sourceIndex).filter(Number.isInteger),
    ])];
    refreshExceptionText();
    applyFocusRegions();
  });
  const clearExceptions = button('Clear', 'btn-mini', () => {
    region.excludedSourceIndices = [];
    refreshExceptionText();
    applyFocusRegions();
  });
  exceptions.append(exceptionText, addExceptions, clearExceptions);
  card.appendChild(exceptions);
  return card;
}

export function addFocusRegionsPanel(containerId) {
  const body = document.getElementById(containerId);
  if (!body) return;
  body.classList.add('focus-regions-panel');

  const selectionHint = document.createElement('p');
  selectionHint.className = 'focus-regions-hint';
  const cards = document.createElement('div');
  cards.className = 'focus-regions-list';
  const actions = document.createElement('div');
  actions.className = 'focus-regions-actions';

  const render = () => {
    cards.replaceChildren();
    const regions = getFocusRegions();
    if (!regions.length) {
      const empty = document.createElement('p');
      empty.className = 'focus-regions-empty';
      empty.textContent = 'Select one or more atoms, then add a focus region.';
      cards.appendChild(empty);
    } else {
      regions.forEach((region, index) => cards.appendChild(renderRegionCard(region, index, render)));
    }
  };
  const updateSelection = (selected = getSelectedAtoms()) => {
    selectionHint.textContent = selected.length
      ? `Current selection: ${selected.map(atomLabel).join(', ')}`
      : 'Select atoms in the structure or atom list to define a focus.';
    add.disabled = selected.length === 0;
  };
  const add = button('+ Add from selection', 'btn-mini highlight focus-regions-add', () => {
    if (createFocusRegion(getSelectedAtoms())) render();
  });
  actions.appendChild(add);
  body.append(selectionHint, actions, cards);
  unsubscribeSelection?.();
  unsubscribeSelection = subscribeToAtomSelection(({ selectedAtoms }) => updateSelection(selectedAtoms),
    { emitCurrent: true });
  render();
}

export function removeFocusRegionsPanel() {
  unsubscribeSelection?.();
  unsubscribeSelection = null;
}
