import { fileBrowser, general } from '../state/store.js';
import { updatePolyhedra } from '../render/index.js';
import { makeSectionHeadline } from './panels/sectionHeadline.js';
import { addPolyhedraTypeHistogramPanel } from './AnalysisPanels/PolyhedraTypeHistogram.js';
import { addPolyhedronInspectorPanel } from './AnalysisPanels/PolyhedronInspector.js';
import { addPolyhedraConnectivityHistogramPanel } from './AnalysisPanels/PolyhedraConnectivityHistogram.js';

function getSelectedStructureSettings() {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return null;
  structure.polyhedraSettings ||= { useChemicalFilter: true, detectCages: true };
  if (structure.polyhedraSettings.useChemicalFilter === undefined) {
    structure.polyhedraSettings.useChemicalFilter = true;
  }
  if (structure.polyhedraSettings.detectCages === undefined) {
    structure.polyhedraSettings.detectCages = true;
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

export function addPolyhedraPanel(target = 'cvPanelBody-polyhedra') {
  const targetPanel = document.getElementById(target);
  if (!targetPanel) return;

  removePolyhedraPanel(target);

  const structure = fileBrowser.selectedStructure;
  const settings = getSelectedStructureSettings();

  // The hosting panel window (ui/panels/) provides the title bar and
  // collapse, so no header is built here.
  const group = document.createElement('div');
  group.id = 'polyhedraSettingsGroup';

  // --- Histograms ---
  // Same idiom as the Bonds panel's histograms (BondPanel.js): one button per
  // analysis, each opening ONE ordinary panel window that defaults to the
  // right dock (drag its tab out to float, or into the left bar). See
  // AnalysisPanels/PolyhedraTypeHistogram.js, PolyhedronInspector.js,
  // PolyhedraConnectivityHistogram.js.
  if (structure) {
    const histogramsPanel = document.createElement('div');
    histogramsPanel.id = 'polyhedraHistogramsPanel';
    histogramsPanel.style.marginBottom = '10px';
    histogramsPanel.appendChild(makeSectionHeadline('Histograms'));

    function addHistogramRow(label, buttonId, openWindow) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;';

      const nameLabel = document.createElement('span');
      nameLabel.textContent = label;
      nameLabel.style.cssText = 'font-size:12px; color:#ccc;';

      const openBtn = document.createElement('button');
      openBtn.id = buttonId;
      openBtn.className = 'btn-mini highlight';
      openBtn.textContent = 'Open';
      openBtn.title = `Open the ${label} window`;
      openBtn.style.fontSize = '12px';
      openBtn.onclick = openWindow;

      row.append(nameLabel, openBtn);
      histogramsPanel.appendChild(row);
    }

    addHistogramRow('Type', 'openPolyhedraTypeHistogram', addPolyhedraTypeHistogramPanel);
    addHistogramRow('Inspector', 'openPolyhedronInspector', addPolyhedronInspectorPanel);
    addHistogramRow('Connectivity', 'openPolyhedraConnectivityHistogram', addPolyhedraConnectivityHistogramPanel);

    group.appendChild(histogramsPanel);
  }

  const panel = document.createElement('div');
  panel.id = 'polyhedraSettingsPanel';
  panel.style.marginBottom = '10px';

  const content = document.createElement('div');
  content.id = 'polyhedraSettingsContent';

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
    body.appendChild(createToggleRow({
      id: 'polyhedraDetectCagesToggle',
      label: 'Detect Cages (slower)',
      checked: settings.detectCages !== false,
      onChange: (e) => {
        structure.polyhedraSettings.detectCages = e.target.checked;
        updatePolyhedra();
      },
    }));
    body.appendChild(createToggleRow({
      id: 'polyhedraUseWasmToggle',
      label: 'Use WASM (faster)',
      checked: general.useWasmPolyhedra !== false,
      onChange: (e) => {
        general.useWasmPolyhedra = e.target.checked;
        updatePolyhedra();
      },
    }));
  } else {
    const empty = document.createElement('div');
    empty.textContent = 'Load a structure to edit polyhedra settings.';
    empty.style.opacity = '0.8';
    body.appendChild(empty);
  }

  content.appendChild(body);
  panel.appendChild(content);
  group.appendChild(panel);
  targetPanel.appendChild(group);
}

export function removePolyhedraPanel(target = 'cvPanelBody-polyhedra') {
  const targetPanel = document.getElementById(target);
  const existing = document.getElementById('polyhedraSettingsGroup');
  if (targetPanel && existing && existing.parentNode === targetPanel) {
    targetPanel.removeChild(existing);
  } else if (existing?.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

export function refreshPolyhedraPanel(target = 'cvPanelBody-polyhedra') {
  if (!document.getElementById('polyhedraSettingsGroup')) return;
  addPolyhedraPanel(target);
}