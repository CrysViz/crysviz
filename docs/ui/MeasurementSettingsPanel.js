// MeasurementSettingsPanel.js
//
// The "Measurements" section of the Settings window (see the settings panel in
// ui/panels/defaultPanels.js, which calls buildMeasurementSettings). Controls
// how distance/angle measurements are drawn: the value-label size, the atom
// highlight marker style, and the accent colour used for each measurement
// type. Everything here writes to `general` and asks MeasurementModule to
// restyle the measurements already on screen, so changes apply live rather
// than only to the next measurement.

import { general } from '../state/store.js';
import { requestRender } from '../render/index.js';
import { refreshMeasureLabelSizes, refreshMeasurementStyling } from '../render/MeasurementModule.js';
import { openSwatchColorPicker } from './SwatchColorPicker.js';
import { makeSectionHeadline } from './panels/sectionHeadline.js';

const LINE_STYLES = [
  ['dashed', 'Dashed'],
  ['solid', 'Solid'],
];

const MARKER_STYLES = [
  ['shell', 'Shell (sphere)'],
  ['ring', 'Rings'],
  ['none', 'None'],
];

/** A titled sub-group, so the seven controls read as three small clusters
 *  (label / atom highlight / connecting line) instead of one flat list. */
function makeSubgroup(title) {
  const wrap = document.createElement('div');
  wrap.className = 'measure-settings-subgroup';
  const head = document.createElement('div');
  head.className = 'measure-settings-subhead';
  head.textContent = title;
  wrap.appendChild(head);
  return wrap;
}

/** A label + control row matching the other panel rows' layout. */
function makeRow(labelText, control) {
  const row = document.createElement('label');
  row.className = 'control-row-pair measure-settings-row';
  const span = document.createElement('span');
  span.textContent = labelText;
  row.appendChild(span);
  row.appendChild(control);
  return row;
}

/** A 0..1 slider row (opacity controls). */
function makeOpacityRow(labelText, get, set) {
  const wrap = document.createElement('span');
  wrap.className = 'measure-settings-slider';
  const readout = document.createElement('span');
  readout.className = 'slider-value';
  readout.textContent = get().toFixed(2);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.05';
  slider.max = '1';
  slider.step = '0.05';
  slider.value = String(get());
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    if (Number.isFinite(v)) set(v);
    readout.textContent = get().toFixed(2);
    refreshMeasurementStyling();
    requestRender();
  });
  wrap.appendChild(readout);
  wrap.appendChild(slider);
  return makeRow(labelText, wrap);
}

/** A colour swatch button that opens the app's own picker (same one the atom
 *  table and background use) rather than the browser's native colour dialog. */
function makeColorRow(labelText, getHex, setHex) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'color-swatch-btn';
  swatch.style.background = getHex();
  swatch.dataset.hex = getHex();
  swatch.title = `${labelText} colour`;
  swatch.addEventListener('click', (e) => {
    e.preventDefault();
    openSwatchColorPicker(swatch, getHex(), (newHex) => {
      setHex(newHex);
      swatch.style.background = newHex;
      refreshMeasurementStyling();
      requestRender();
    });
  });
  return makeRow(labelText, swatch);
}

/**
 * Build the Measurements section into `body` (the Settings window's body).
 * @param {HTMLElement} body
 */
export function buildMeasurementSettings(body) {
  body.appendChild(makeSectionHeadline('Measurements'));
  const group = document.createElement('div');
  group.className = 'toggle_group measure-settings-group';

  // --- value-label size ----------------------------------------------------
  const sizeWrap = document.createElement('span');
  sizeWrap.className = 'measure-settings-slider';
  const sizeValue = document.createElement('span');
  sizeValue.className = 'slider-value';
  sizeValue.id = 'measureLabelSizeValue';
  sizeValue.textContent = (general.measureLabelScale ?? 1).toFixed(2);
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.id = 'measureLabelSize';
  sizeSlider.min = '0.4';
  sizeSlider.max = '2.5';
  sizeSlider.step = '0.05';
  sizeSlider.value = String(general.measureLabelScale ?? 1);
  sizeSlider.addEventListener('input', () => {
    const v = parseFloat(sizeSlider.value);
    if (Number.isFinite(v)) general.measureLabelScale = v;
    sizeValue.textContent = (general.measureLabelScale ?? 1).toFixed(2);
    refreshMeasureLabelSizes();
    requestRender();
  });
  sizeWrap.appendChild(sizeValue);
  sizeWrap.appendChild(sizeSlider);
  const labelGroup = makeSubgroup('Label');
  labelGroup.appendChild(makeRow('Size', sizeWrap));
  group.appendChild(labelGroup);

  // --- atom highlight marker style ----------------------------------------
  const styleSelect = document.createElement('select');
  styleSelect.id = 'measureMarkerStyle';
  for (const [value, text] of MARKER_STYLES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    styleSelect.appendChild(option);
  }
  styleSelect.value = general.measureMarkerStyle ?? 'shell';
  styleSelect.addEventListener('change', () => {
    general.measureMarkerStyle = styleSelect.value;
    refreshMeasurementStyling();
    requestRender();
  });
  const markerGroup = makeSubgroup('Atom highlight');
  markerGroup.appendChild(makeRow('Style', styleSelect));

  // --- per-measurement-type accent colours ---------------------------------
  markerGroup.appendChild(makeOpacityRow('Opacity',
    () => general.measureMarkerOpacity ?? 0.32,
    (v) => { general.measureMarkerOpacity = v; }));
  group.appendChild(markerGroup);

  const lineGroup = makeSubgroup('Connecting line');

  // --- connecting line style + opacities -----------------------------------
  const lineSelect = document.createElement('select');
  lineSelect.id = 'measureLineStyle';
  for (const [value, text] of LINE_STYLES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    lineSelect.appendChild(option);
  }
  lineSelect.value = general.measureLineStyle ?? 'dashed';
  lineSelect.addEventListener('change', () => {
    general.measureLineStyle = lineSelect.value;
    refreshMeasurementStyling();
    requestRender();
  });
  lineGroup.appendChild(makeRow('Style', lineSelect));

  lineGroup.appendChild(makeOpacityRow('Opacity',
    () => general.measureLineOpacity ?? 1,
    (v) => { general.measureLineOpacity = v; }));
  group.appendChild(lineGroup);

  // Accent colours apply to a whole measurement type (line, highlight, arc,
  // label outline), so they sit on their own rather than under one sub-group.
  const colorGroup = makeSubgroup('Colors');
  colorGroup.appendChild(makeColorRow('Distance',
    () => general.measureDistanceColor ?? '#0066ff',
    (hex) => { general.measureDistanceColor = hex; }));
  colorGroup.appendChild(makeColorRow('Angle',
    () => general.measureAngleColor ?? '#ff6600',
    (hex) => { general.measureAngleColor = hex; }));
  group.appendChild(colorGroup);

  body.appendChild(group);
}
