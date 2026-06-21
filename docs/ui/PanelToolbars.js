// In-panel equivalents of the floating camera view-axis + measurement toolbars.
//
// These live inside the side panel (#ui) and reuse the exact same handlers AND
// button markup/classes as the floating toolbars, so they look the same. Each
// set sits in its own grey ".control-group" box (no heading). They are hidden by
// default (see #panelToolsContainer in controlPanel.css) and revealed by themes
// that hide the floaters — notably "docked", which collects controls into #ui.
//
// Measure icons come from CSS variables (--icon-measure-*, themes/default/
// theme.css) so a theme can swap them via its own themes/<id>/icons/.

import * as THREE from '../external/three/three.module.js';
import { app } from '../state/store.js';
import { latticeDirs } from '../render/index.js';
import { setViewDirection, resetView } from './WindowAndSceneControls.js';
import { setMeasureMode, clearAllMeasureMode } from './MeasurementToolbar.js';

function makeGroup() {
  const group = document.createElement('div');
  group.className = 'control-group panel-tools-group';
  const row = document.createElement('div');
  row.className = 'panel-tools-row';
  group.appendChild(row);
  return { group, row };
}

// Mirrors a floating #cameraTools button: a .camera-icon letter + a (hidden) span.
function cameraButton(letter, title, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.className = className;
  const ico = document.createElement('div');
  ico.className = 'camera-icon';
  ico.textContent = letter;
  const span = document.createElement('span');
  span.textContent = letter;
  b.append(ico, span);
  return b;
}

// Mirrors a floating .measure-tool-btn: a .tool-icon (icon via CSS var) + a label.
function measureButton(label, title, iconKey) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.className = 'measure-tool-btn';
  const ico = document.createElement('div');
  ico.className = 'tool-icon';
  ico.dataset.icon = iconKey;
  const span = document.createElement('span');
  span.textContent = label;
  b.append(ico, span);
  return b;
}

export function addPanelToolbars(target = 'panelToolsContainer') {
  const host = document.getElementById(target);
  if (!host || document.getElementById('panelToolsSection')) return;

  const section = document.createElement('div');
  section.id = 'panelToolsSection';

  // --- View axes (mirrors #cameraTools) ---
  const view = makeGroup();
  /** @type {[string, () => any][]} */
  const axes = [
    ['x', () => new THREE.Vector3(1, 0, 0)],
    ['y', () => new THREE.Vector3(0, 1, 0)],
    ['z', () => new THREE.Vector3(0, 0, 1)],
    ['a', () => latticeDirs().a],
    ['b', () => latticeDirs().b],
    ['c', () => latticeDirs().c],
  ];
  axes.forEach(([letter, dirFn]) => {
    const btn = cameraButton(letter, `View ${letter} axis`, 'camera-tool-btn');
    btn.addEventListener('click', () => { app.controls.reset(); setViewDirection(dirFn()); });
    view.row.appendChild(btn);
  });
  const resetBtn = cameraButton('⟲', 'Reset camera view', 'camera-tool-reset-btn');
  resetBtn.addEventListener('click', () => resetView());
  view.row.appendChild(resetBtn);

  // --- Measurement (mirrors #measurementTools) ---
  const measure = makeGroup();
  /** @type {[string, string, string][]} */ // [label, mode, icon key]
  const modes = [
    ['Distance', 'distance', 'distance'],
    ['Angle', 'angle', 'angle'],
    ['Delete', 'delete', 'delete'],
  ];
  modes.forEach(([label, m, icon]) => {
    const btn = measureButton(label, `${label} measurement`, icon);
    btn.addEventListener('click', () => setMeasureMode(m, btn));
    measure.row.appendChild(btn);
  });
  const clearBtn = measureButton('Clear', 'Clear all measurements', 'clear');
  clearBtn.addEventListener('click', () => clearAllMeasureMode());
  measure.row.appendChild(clearBtn);

  section.appendChild(view.group);
  section.appendChild(measure.group);
  host.appendChild(section);
}
