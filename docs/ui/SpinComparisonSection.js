// "Comparison Spins" (experimental, `?experimental`): a second spin set loaded
// from a plain vector file and drawn next to the structure's own spins, so two
// magnetic configurations (e.g. two codes, two SCF runs) can be compared on
// one structure. Built into the Spins panel by ui/SpinPanel.js.
//
// Stored as structure.spins2 (index-aligned with structure.atoms, like
// structure.spins) and drawn by render/SpinModule.js's updateSpins() into its
// own mesh pair. Every LENGTH control (global scaling, log length, arrowhead
// length) is shared with the primary set; colormap, colour range and arrow
// diameter are this set's own (general.spin2*). Vectors go through the same
// reference frame / visual rotation as the primary spins (utils/spinFrame.js).

import { fileBrowser, general } from '../state/store.js';
import { Spin } from '../model/index.js';
import { createColorBar } from './ColorBarWidget.js';
import { registerColorBarSource } from './ColorBarRegistry.js';
import { computeAutoRange } from '../utils/index.js';

const SPIN2_COLORBAR_FLOATING_ID = 'spin2ColorBarFloating';
const SPIN2_LEGEND = 'Comparison spin (μB)';
const NON_SCALAR_MAPS = new Set(['none', 'direction', 'plusminus', 'element']);

// Module scope for the same reason as SpinPanel.js's spinColorBarInstance:
// removeSpinComparisonSection() must reach the live bar to dispose it.
let spin2ColorBarInstance = null;

registerColorBarSource('spin2', SPIN2_LEGEND, () => spin2ColorBarInstance);

/**
 * Parse a comparison-spin file: one `x y z [scale]` line per atom, in atom
 * order. Blank lines and `#` / `!` comments are skipped.
 *
 * @param {string} text
 * @param {number} atomCount
 * @returns {{vectors:number[][], scalings:number[]} | {error:string}}
 */
export function parseSpinVectorFile(text, atomCount) {
  const vectors = [];
  const scalings = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/[#!].*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/[\s,]+/);
    const nums = parts.slice(0, 4).map(Number);
    if (parts.length < 3 || !nums.slice(0, 3).every(Number.isFinite)) {
      return { error: `Line ${i + 1}: expected "x y z [scale]", got "${lines[i].trim()}"` };
    }
    vectors.push(nums.slice(0, 3));
    scalings.push(parts.length > 3 && Number.isFinite(nums[3]) ? nums[3] : 1.0);
  }
  if (vectors.length !== atomCount) {
    return { error: `Found ${vectors.length} vectors, but the structure has ${atomCount} atoms (one vector per atom is required).` };
  }
  return { vectors, scalings };
}

/**
 * Replace structure.spins2 with the parsed vectors. The vectors are stored as
 * rawVector; the caller re-projects through applySpinFrame().
 */
export function setComparisonSpins(structure, { vectors, scalings }, label = '') {
  structure.spins2 = vectors.map((v, i) => new Spin({
    vector: [...v],
    rawVector: [...v],
    scaling: scalings?.[i] ?? 1.0,
    atomIndex: i,
    element: structure.elements[i],
    position: structure.atoms[i]?.position ? [...structure.atoms[i].position] : null,
  }));
  structure.spins2Label = label;
}

export function removeSpinComparisonSection() {
  spin2ColorBarInstance?.remove();
  spin2ColorBarInstance = null;
  document.getElementById(SPIN2_COLORBAR_FLOATING_ID)?.remove();
}

/**
 * Build the section's body into `body`.
 *
 * @param {HTMLElement} body
 * @param {{colorMapOptions: HTMLSelectElement, redraw: () => void, reproject: () => void}} deps
 *   colorMapOptions: the primary Color Map select, whose options are copied so
 *   both sets always offer the same maps. redraw: updateSpins() with the
 *   panel's current primary arguments. reproject: re-apply the spin frame to
 *   both sets, then redraw.
 */
export function buildSpinComparisonSection(body, { colorMapOptions, redraw, reproject }) {
  removeSpinComparisonSection();

  const note = document.createElement('div');
  note.className = 'control-note';
  note.textContent = 'Load a second spin set to compare: a text file with one "x y z [scale]" line per atom, in atom order. It uses the global length, arrowhead and reference frame settings above.';
  body.appendChild(note);

  // --- Load (drop zone, click to browse) / Clear ---
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'spin2FileInput';
  fileInput.className = 'cv-force-hidden';
  body.appendChild(fileInput);

  const dropZone = document.createElement('div');
  dropZone.id = 'spin2DropZone';
  dropZone.className = 'cv-spin-drop-zone';
  dropZone.tabIndex = 0;
  dropZone.setAttribute('role', 'button');
  dropZone.textContent = 'Drop a spin vector file here, or click to browse';
  body.appendChild(dropZone);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'cv-spin-button-row';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.id = 'spin2ClearBtn';
  clearBtn.textContent = 'Clear';
  clearBtn.className = 'btn-mini highlight';
  buttonRow.appendChild(clearBtn);
  body.appendChild(buttonRow);

  const status = document.createElement('div');
  status.id = 'spin2Status';
  status.className = 'control-note';
  body.appendChild(status);

  // --- Show checkbox ---
  const showRow = document.createElement('div');
  showRow.className = 'cv-force-row';
  const showLabel = document.createElement('label');
  showLabel.className = 'cv-force-check';
  const showCheckbox = document.createElement('input');
  showCheckbox.type = 'checkbox';
  showCheckbox.id = 'spin2ShowCheckbox';
  showCheckbox.checked = general.spin2Visible !== false;
  showLabel.appendChild(showCheckbox);
  showLabel.appendChild(document.createTextNode('Show comparison spins'));
  showRow.appendChild(showLabel);
  body.appendChild(showRow);

  // --- Highlight all arrows of one set (one toggle per set) ---
  const highlightLabel = document.createElement('div');
  highlightLabel.className = 'cv-force-subheading';
  highlightLabel.textContent = 'Highlight:';
  body.appendChild(highlightLabel);
  const highlightRow = document.createElement('div');
  highlightRow.className = 'cv-spin-button-row';
  const makeHighlightToggle = (id, text, key) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.textContent = text;
    btn.className = 'btn-mini cv-spin-highlight-btn';
    const sync = () => {
      btn.classList.toggle('is-active', general[key] === true);
      btn.setAttribute('aria-pressed', String(general[key] === true));
    };
    btn.addEventListener('click', () => {
      general[key] = general[key] !== true;
      sync();
      redraw();
    });
    sync();
    highlightRow.appendChild(btn);
  };
  makeHighlightToggle('spinHighlightAllBtn', 'Structure spins', 'spinHighlightAll');
  makeHighlightToggle('spin2HighlightAllBtn', 'Comparison spins', 'spin2HighlightAll');
  body.appendChild(highlightRow);

  // --- Arrow size (per set) ---
  const sizeRow = document.createElement('div');
  sizeRow.className = 'cv-force-row';
  const sizeLabel = document.createElement('label');
  sizeLabel.textContent = 'Arrow Size (Diameter): ';
  const sizeValue = document.createElement('span');
  sizeValue.className = 'cv-force-value';
  sizeValue.textContent = (general.spin2Radius ?? 0.08).toFixed(2);
  const sizeSlider = /** @type {any} */ (document.createElement('input'));
  sizeSlider.type = 'range';
  sizeSlider.id = 'spin2SizeSlider';
  sizeSlider.min = 0.01;
  sizeSlider.max = 0.15;
  sizeSlider.step = 0.01;
  sizeSlider.value = general.spin2Radius ?? 0.08;
  sizeRow.appendChild(sizeLabel);
  sizeRow.appendChild(sizeValue);
  sizeRow.appendChild(sizeSlider);
  body.appendChild(sizeRow);

  // --- Color map (per set; same options as the primary select) ---
  const cmapLabel = document.createElement('label');
  cmapLabel.textContent = 'Color Map: ';
  cmapLabel.className = 'cv-force-label-block';
  const cmapSelect = document.createElement('select');
  cmapSelect.id = 'spin2ColorMapSelect';
  cmapSelect.className = 'cv-scene-select cv-scene-select--block cv-spin-colormap-select';
  for (const opt of colorMapOptions.options) {
    cmapSelect.appendChild(/** @type {HTMLOptionElement} */ (opt.cloneNode(true)));
  }
  cmapSelect.value = general.spin2ColorMap ?? 'none';
  body.appendChild(cmapLabel);
  body.appendChild(cmapSelect);

  const barControlsRow = document.createElement('div');
  barControlsRow.className = 'cv-force-bar-controls cv-force-bar-controls--spin';
  const logLabel = document.createElement('label');
  logLabel.className = 'cv-force-check';
  const logCheckbox = document.createElement('input');
  logCheckbox.type = 'checkbox';
  logCheckbox.id = 'spin2LogScaleCheckbox';
  logCheckbox.checked = general.spin2ColorScale === 'log';
  logLabel.appendChild(logCheckbox);
  logLabel.appendChild(document.createTextNode('Log Scale'));
  const autoRangeBtn = document.createElement('button');
  autoRangeBtn.type = 'button';
  autoRangeBtn.textContent = 'Auto Range';
  autoRangeBtn.className = 'file-action-btn cv-auto-range-btn';
  barControlsRow.appendChild(logLabel);
  barControlsRow.appendChild(autoRangeBtn);
  body.appendChild(barControlsRow);

  const colorBarContainer = document.createElement('div');
  colorBarContainer.id = 'spin2ColorBarContainer';
  colorBarContainer.className = 'cv-force-colorbar-container cv-force-row cv-force-hidden';
  body.appendChild(colorBarContainer);

  // --- Behaviour ---
  function spins2() {
    return fileBrowser.selectedStructure?.spins2 ?? [];
  }

  function updateStatus(message = null) {
    if (message) {
      status.textContent = message;
      return;
    }
    const structure = fileBrowser.selectedStructure;
    status.textContent = structure?.spins2?.length
      ? `Loaded ${structure.spins2.length} vectors${structure.spins2Label ? ` from ${structure.spins2Label}` : ''}.`
      : 'No comparison spins loaded.';
  }

  function applyAutoRange() {
    const magnitudes = spins2().map((spin) => {
      const v = spin?.vector;
      return v ? Math.hypot(v[0], v[1], v[2]) * (spin.scaling ?? 1.0) : NaN;
    });
    const range = computeAutoRange(magnitudes, 0.2, { clampMinAtZero: true });
    if (!range) return;
    let { min, max } = range;
    if (general.spin2ColorScale === 'log' && min <= 0) min = 0.01;
    general.spin2Min = min;
    general.spin2Max = max;
    spin2ColorBarInstance?.setRange(min, max);
    redraw();
  }

  function applyLogScale(isLog) {
    general.spin2ColorScale = isLog ? 'log' : 'linear';
    if (isLog && general.spin2Min <= 0) {
      general.spin2Min = 0.01;
      spin2ColorBarInstance?.setRange(general.spin2Min, general.spin2Max);
    }
    logCheckbox.checked = isLog;
    spin2ColorBarInstance?.update(cmapSelect.value, general.spin2ColorScale);
    redraw();
  }

  function refreshColorBar() {
    const cmap = cmapSelect.value;
    const isScalar = !NON_SCALAR_MAPS.has(cmap);
    barControlsRow.classList.toggle('cv-force-hidden', !isScalar);
    spin2ColorBarInstance?.remove();
    spin2ColorBarInstance = null;
    colorBarContainer.innerHTML = '';
    colorBarContainer.classList.toggle('cv-force-hidden', !isScalar);
    if (!isScalar) return;
    const min = general.spin2Min ?? 0;
    const max = general.spin2Max ?? 2;
    spin2ColorBarInstance = createColorBar(colorBarContainer, cmap, min, max, {
      floatingId: SPIN2_COLORBAR_FLOATING_ID,
      fallbackMin: min,
      fallbackMax: max,
      legend: SPIN2_LEGEND,
      scale: general.spin2ColorScale,
      size: general.colorBarSize,
      onLimitsCommit: (lo, hi) => {
        general.spin2Min = lo;
        general.spin2Max = hi;
        redraw();
      },
      onScaleChange: (scale) => applyLogScale(scale === 'log'),
      onAutoRange: () => applyAutoRange(),
    });
  }

  // The first scalar map picked in this panel build derives its range from
  // the loaded data (same idea as SpinPanel.js's spinRangeInitialized).
  let rangeInitialized = false;

  async function loadFile(file) {
    const structure = fileBrowser.selectedStructure;
    if (!file || !structure) return;
    const parsed = parseSpinVectorFile(await file.text(), structure.atoms.length);
    if ('error' in parsed) {
      updateStatus(`Could not load ${file.name}: ${parsed.error}`);
      return;
    }
    setComparisonSpins(structure, parsed, file.name);
    rangeInitialized = false;
    if (!NON_SCALAR_MAPS.has(cmapSelect.value)) {
      rangeInitialized = true;
      applyAutoRange();
    }
    updateStatus();
    reproject();
  }

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  // stopPropagation keeps the drop away from ui/StructureInputModule.js's
  // body-level handler, which would otherwise try to open the file as a
  // new structure.
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('highlight');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('highlight'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('highlight');
    loadFile(e.dataTransfer?.files?.[0]);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    loadFile(file);
  });

  clearBtn.addEventListener('click', () => {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;
    structure.spins2 = [];
    structure.spins2Label = '';
    updateStatus();
    redraw();
  });

  showCheckbox.addEventListener('change', () => {
    general.spin2Visible = showCheckbox.checked;
    redraw();
  });

  sizeSlider.addEventListener('input', () => {
    const val = parseFloat(sizeSlider.value);
    sizeValue.textContent = val.toFixed(2);
    general.spin2Radius = val;
    redraw();
  });

  cmapSelect.addEventListener('change', () => {
    general.spin2ColorMap = cmapSelect.value;
    if (cmapSelect.value === 'none') {
      // Back to each spin's own colour (the colormap pass overwrote it).
      spins2().forEach((spin) => { if (spin?.original) spin.color = spin.original.color; });
    }
    refreshColorBar();
    if (!rangeInitialized && !NON_SCALAR_MAPS.has(cmapSelect.value) && spins2().length) {
      rangeInitialized = true;
      applyAutoRange();
    }
    redraw();
  });

  logCheckbox.addEventListener('change', () => applyLogScale(logCheckbox.checked));
  autoRangeBtn.addEventListener('click', applyAutoRange);

  refreshColorBar();
  updateStatus();
}
