// In-panel equivalents of the floating camera view-axis + measurement toolbars.
//
// These live inside the side panel (#ui) and reuse the exact same handlers as
// the floating toolbars. They are hidden by default (see #panelToolsContainer in
// styles.css) and revealed by themes that hide the floaters — notably the
// "minimal" theme, which collects all controls into the side panel.

import * as THREE from '../external/three/three.module.js';
import { app } from '../state/store.js';
import { latticeDirs } from '../render/index.js';
import { setViewDirection, resetView } from './WindowAndSceneControls.js';
import { setMeasureMode, clearAllMeasureMode } from './MeasurementToolbar.js';

function makeButton(label, title, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.className = className;
  return b;
}

function makeRow(labelText) {
  const row = document.createElement('div');
  row.className = 'panel-tools-row';
  const label = document.createElement('span');
  label.className = 'panel-tools-label';
  label.textContent = labelText;
  row.appendChild(label);
  return row;
}

export function addPanelToolbars(target = 'panelToolsContainer') {
  const host = document.getElementById(target);
  if (!host || document.getElementById('panelToolsSection')) return;

  const section = document.createElement('div');
  section.id = 'panelToolsSection';
  section.className = 'panel-tools-section';

  // --- View axes (mirrors #cameraTools) ---
  const viewRow = makeRow('View');
  /** @type {[string, () => any][]} */
  const axes = [
    ['X', () => new THREE.Vector3(1, 0, 0)],
    ['Y', () => new THREE.Vector3(0, 1, 0)],
    ['Z', () => new THREE.Vector3(0, 0, 1)],
    ['a', () => latticeDirs().a],
    ['b', () => latticeDirs().b],
    ['c', () => latticeDirs().c],
  ];
  axes.forEach(([label, dirFn]) => {
    const btn = makeButton(label, `View ${label} axis`, 'panel-tool-btn');
    btn.addEventListener('click', () => { app.controls.reset(); setViewDirection(dirFn()); });
    viewRow.appendChild(btn);
  });
  const resetBtn = makeButton('⟲', 'Reset camera view', 'panel-tool-btn');
  resetBtn.addEventListener('click', () => resetView());
  viewRow.appendChild(resetBtn);

  // --- Measurement (mirrors #measurementTools) ---
  const measRow = makeRow('Measure');
  const modes = [['Dist', 'distance'], ['Angle', 'angle'], ['Del', 'delete']];
  modes.forEach(([label, m]) => {
    // `measure-tool-btn` so the shared clear/active logic in MeasurementToolbar
    // also tracks these buttons.
    const btn = makeButton(label, `${label} measurement`, 'panel-tool-btn measure-tool-btn');
    btn.addEventListener('click', () => setMeasureMode(m, btn));
    measRow.appendChild(btn);
  });
  const clearBtn = makeButton('Clear', 'Clear all measurements', 'panel-tool-btn');
  clearBtn.addEventListener('click', () => clearAllMeasureMode());
  measRow.appendChild(clearBtn);

  section.appendChild(viewRow);
  section.appendChild(measRow);
  host.appendChild(section);
}
