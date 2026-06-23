import { fileBrowser } from '../state/store.js';
import { updatePolyhedra } from '../render/index.js';

function getSelectedStructureSettings() {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return null;
  structure.polyhedraSettings ||= { useChemicalFilter: true };
  if (structure.polyhedraSettings.useChemicalFilter === undefined) {
    structure.polyhedraSettings.useChemicalFilter = true;
  }
  return structure.polyhedraSettings;
}

function createToggleRow({ id, label, checked, onChange }) {
  const row = document.createElement('label');
  row.className = 'toggle_row toggle_container';

  const switchWrap = document.createElement('span');
  switchWrap.className = 'toggle_switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;

  const slider = document.createElement('span');
  slider.className = 'toggle_slider';

  const text = document.createElement('span');
  text.className = 'toggle_text';
  text.textContent = label;

  input.addEventListener('change', onChange);

  switchWrap.appendChild(input);
  switchWrap.appendChild(slider);
  row.appendChild(switchWrap);
  row.appendChild(text);
  return row;
}

export function addPolyhedraPanel(target = 'BondLatticeContainer') {
  const targetPanel = document.getElementById(target);
  if (!targetPanel) return;

  removePolyhedraPanel(target);

  const structure = fileBrowser.selectedStructure;
  const settings = getSelectedStructureSettings();

  const group = document.createElement('div');
  group.id = 'polyhedraSettingsGroup';
  group.style.padding = '10px';

  const panel = document.createElement('div');
  panel.id = 'polyhedraSettingsPanel';
  panel.style.marginBottom = '10px';

  const toggle = document.createElement('div');
  toggle.className = 'bond-toggle';
  toggle.setAttribute('role', 'button');
  toggle.setAttribute('tabindex', '0');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-controls', 'polyhedraSettingsContent');

  const title = document.createElement('h4');
  title.textContent = 'Calculation Settings';

  const icon = document.createElement('div');
  icon.className = 'toggle-icon';
  icon.textContent = '−';

  toggle.appendChild(title);
  toggle.appendChild(icon);

  const content = document.createElement('div');
  content.id = 'polyhedraSettingsContent';
  content.className = 'collapsible-content open';
  content.setAttribute('aria-hidden', 'false');

  const body = document.createElement('div');
  body.className = 'toggle_group';
  body.style.marginTop = '10px';

  if (structure && settings) {
    body.appendChild(createToggleRow({
      id: 'polyhedraChemicalFilterToggle',
      label: 'Use Chemical Filter',
      checked: settings.useChemicalFilter !== false,
      onChange: (e) => {
        structure.polyhedraSettings.useChemicalFilter = e.target.checked;
        updatePolyhedra();
      },
    }));
  } else {
    const empty = document.createElement('div');
    empty.textContent = 'Load a structure to edit polyhedra settings.';
    empty.style.opacity = '0.8';
    body.appendChild(empty);
  }

  function setOpen(open) {
    if (open) {
      content.classList.add('open');
      content.setAttribute('aria-hidden', 'false');
      icon.textContent = '−';
      toggle.setAttribute('aria-expanded', 'true');
    } else {
      content.classList.remove('open');
      content.setAttribute('aria-hidden', 'true');
      icon.textContent = '+';
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  toggle.addEventListener('click', () => setOpen(!content.classList.contains('open')));
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(!content.classList.contains('open'));
    }
  });

  content.appendChild(body);
  panel.appendChild(toggle);
  panel.appendChild(content);
  group.appendChild(panel);
  targetPanel.appendChild(group);
}

export function removePolyhedraPanel(target = 'BondLatticeContainer') {
  const targetPanel = document.getElementById(target);
  const existing = document.getElementById('polyhedraSettingsGroup');
  if (targetPanel && existing && existing.parentNode === targetPanel) {
    targetPanel.removeChild(existing);
  } else if (existing?.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

export function refreshPolyhedraPanel(target = 'BondLatticeContainer') {
  if (!document.getElementById('polyhedraSettingsGroup')) return;
  addPolyhedraPanel(target);
}