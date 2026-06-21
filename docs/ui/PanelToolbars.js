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

// Mirrors a floating .measure-tool-btn. `iconKey` draws an icon via CSS var;
// `glyph` (e.g. ❌) is used instead for buttons that have no image icon.
function measureButton({ label, title, iconKey = null, glyph = null, extraClass = '', onClick = null }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.className = `measure-tool-btn ${extraClass}`.trim();
  const ico = document.createElement('div');
  ico.className = 'tool-icon';
  if (iconKey) ico.dataset.icon = iconKey;
  if (glyph) ico.textContent = glyph;
  const span = document.createElement('span');
  span.textContent = label;
  b.append(ico, span);
  if (onClick) b.addEventListener('click', onClick);
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
  axes.forEach(([letter, dirFn], i) => {
    if (i === 3) {
      // Spacer between z and a, like the floating panel's .camera-separator.
      const sep = document.createElement('div');
      sep.className = 'camera-separator';
      view.row.appendChild(sep);
    }
    const btn = cameraButton(letter, `View ${letter} axis`, 'camera-tool-btn');
    btn.addEventListener('click', () => { app.controls.reset(); setViewDirection(dirFn()); });
    view.row.appendChild(btn);
  });
  // Reset button: empty .reset-icon + a "Reset" label (mirrors the floating one).
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.title = 'Reset Camera View';
  resetBtn.className = 'camera-tool-reset-btn';
  const resetIco = document.createElement('div');
  resetIco.className = 'reset-icon';
  const resetSpan = document.createElement('span');
  resetSpan.textContent = 'Reset';
  resetBtn.append(resetIco, resetSpan);
  resetBtn.addEventListener('click', () => resetView());
  view.row.appendChild(resetBtn);

  // --- Measurement (mirrors #measurementTools exactly: order, icons, labels) ---
  const measure = makeGroup();
  const distanceBtn = measureButton({ label: 'Distance', title: 'Distance Measurement', iconKey: 'distance' });
  distanceBtn.addEventListener('click', () => setMeasureMode('distance', distanceBtn));
  const angleBtn = measureButton({ label: 'Angle', title: 'Angle Measurement', iconKey: 'angle' });
  angleBtn.addEventListener('click', () => setMeasureMode('angle', angleBtn));
  const clearBtn = measureButton({ label: 'Clear', title: 'Clear All Measurements', iconKey: 'clear',
    onClick: () => clearAllMeasureMode() });
  const deleteBtn = measureButton({ label: 'Delete', title: 'Delete Atom', glyph: '❌' });
  deleteBtn.addEventListener('click', () => setMeasureMode('delete', deleteBtn));
  // Restore mirrors the floating button (icon + clear-btn styling); the floating
  // one has no click handler either, so neither does this.
  const restoreBtn = measureButton({ label: 'Restore', title: 'Restore Atom', iconKey: 'restore', extraClass: 'clear-btn' });
  measure.row.append(distanceBtn, angleBtn, clearBtn, deleteBtn, restoreBtn);

  section.appendChild(view.group);
  section.appendChild(measure.group);
  host.appendChild(section);
}
