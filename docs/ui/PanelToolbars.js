// In-panel equivalents of the floating camera view-axis + measurement toolbars.
//
// These live inside the side panel (#ui) and reuse the exact same handlers as
// the floating toolbars. Each set sits in its own grey ".control-group" box, the
// same as the other side-panel groups. They are hidden by default (see
// #panelToolsContainer in controlPanel.css) and revealed by themes that hide the
// floaters — notably "minimal", which collects all controls into the side panel.
//
// The measure buttons use the same icons as the floating panel, supplied via CSS
// variables (--icon-measure-*, see themes/default/theme.css) so a theme can swap
// them by overriding those variables with files from its own themes/<id>/icons/.

import * as THREE from '../external/three/three.module.js';
import { app } from '../state/store.js';
import { latticeDirs } from '../render/index.js';
import { setViewDirection, resetView } from './WindowAndSceneControls.js';
import { setMeasureMode, clearAllMeasureMode } from './MeasurementToolbar.js';

function makeGroup(titleText) {
  const group = document.createElement('div');
  group.className = 'control-group panel-tools-group';
  const h = document.createElement('h3');
  h.textContent = titleText;
  group.appendChild(h);
  const row = document.createElement('div');
  row.className = 'panel-tools-row';
  group.appendChild(row);
  return { group, row };
}

function makeTextButton(label, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.className = 'panel-tool-btn';
  b.textContent = label;
  return b;
}

function makeIconButton(label, title, iconKey, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.className = `panel-tool-btn panel-tool-btn-icon ${extraClass}`.trim();
  const ico = document.createElement('span');
  ico.className = 'panel-tool-ico';
  ico.dataset.icon = iconKey; // CSS maps this to var(--icon-measure-<key>)
  const text = document.createElement('span');
  text.textContent = label;
  b.append(ico, text);
  return b;
}

export function addPanelToolbars(target = 'panelToolsContainer') {
  const host = document.getElementById(target);
  if (!host || document.getElementById('panelToolsSection')) return;

  const section = document.createElement('div');
  section.id = 'panelToolsSection';

  // --- View axes (mirrors #cameraTools) ---
  const view = makeGroup('View');
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
    const btn = makeTextButton(label, `View ${label} axis`);
    btn.addEventListener('click', () => { app.controls.reset(); setViewDirection(dirFn()); });
    view.row.appendChild(btn);
  });
  const resetBtn = makeTextButton('⟲', 'Reset camera view');
  resetBtn.addEventListener('click', () => resetView());
  view.row.appendChild(resetBtn);

  // --- Measurement (mirrors #measurementTools, same icons) ---
  const measure = makeGroup('Measure');
  /** @type {[string, string, string][]} */ // [label, mode, icon key]
  const measureModes = [
    ['Distance', 'distance', 'distance'],
    ['Angle', 'angle', 'angle'],
    ['Delete', 'delete', 'delete'],
  ];
  measureModes.forEach(([label, m, icon]) => {
    // `measure-tool-btn` so the shared clear/active logic in MeasurementToolbar
    // also tracks these buttons.
    const btn = makeIconButton(label, `${label} measurement`, icon, 'measure-tool-btn');
    btn.addEventListener('click', () => setMeasureMode(m, btn));
    measure.row.appendChild(btn);
  });
  const clearBtn = makeIconButton('Clear', 'Clear all measurements', 'clear');
  clearBtn.addEventListener('click', () => clearAllMeasureMode());
  measure.row.appendChild(clearBtn);

  section.appendChild(view.group);
  section.appendChild(measure.group);
  host.appendChild(section);
}
