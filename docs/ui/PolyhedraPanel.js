import { fileBrowser, general } from '../state/store.js';
import { updatePolyhedra } from '../render/index.js';
import { makeSectionHeadline } from './panels/sectionHeadline.js';
import { addPolyhedraTypeHistogramPanel } from './AnalysisPanels/PolyhedraTypeHistogram.js';
import { addPolyhedronInspectorPanel } from './AnalysisPanels/PolyhedronInspector.js';
import { addPolyhedraConnectivityHistogramPanel } from './AnalysisPanels/PolyhedraConnectivityHistogram.js';
import { createToggleRow } from './ToggleSwitch.js';

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
    histogramsPanel.className = 'cv-histogram-section';
    histogramsPanel.appendChild(makeSectionHeadline('Histograms'));

    function addHistogramRow(label, buttonId, openWindow) {
      const row = document.createElement('div');
      row.className = 'cv-histogram-row';

      const nameLabel = document.createElement('span');
      nameLabel.textContent = label;
      nameLabel.className = 'cv-histogram-row-label';

      const openBtn = document.createElement('button');
      openBtn.id = buttonId;
      openBtn.className = 'btn-mini highlight cv-histogram-row-btn';
      openBtn.textContent = 'Open';
      openBtn.title = `Open the ${label} window`;
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
  panel.className = 'cv-polyhedra-settings-panel';

  const content = document.createElement('div');
  content.id = 'polyhedraSettingsContent';

  const body = document.createElement('div');
  body.className = 'toggle_group cv-polyhedra-settings-body';

  if (structure && settings) {
    body.appendChild(createToggleRow({
      id: 'polyhedraChemicalFilterToggle',
      label: 'Use Chemical Filter',
      checked: settings.useChemicalFilter !== false,
      onChange: (checked) => {
        structure.polyhedraSettings.useChemicalFilter = checked;
        updatePolyhedra();
      },
    }).row);
    body.appendChild(createToggleRow({
      id: 'polyhedraDetectCagesToggle',
      label: 'Detect Cages (slower)',
      checked: settings.detectCages !== false,
      onChange: (checked) => {
        structure.polyhedraSettings.detectCages = checked;
        updatePolyhedra();
      },
    }).row);
    body.appendChild(createToggleRow({
      id: 'polyhedraUseWasmToggle',
      label: 'Use WASM (faster)',
      checked: general.useWasmPolyhedra !== false,
      onChange: (checked) => {
        general.useWasmPolyhedra = checked;
        updatePolyhedra();
      },
    }).row);
  } else {
    const empty = document.createElement('div');
    empty.textContent = 'Load a structure to edit polyhedra settings.';
    empty.className = 'cv-polyhedra-empty-msg';
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