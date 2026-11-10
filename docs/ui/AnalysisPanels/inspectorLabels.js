// The label controls both inspectors share (PolyhedronInspector.js and
// SelectionInspector.js): Lengths and Angles switches that hide a whole kind,
// a small × on a label to hide just that one (as on the main view's
// measurement labels), "Show all labels" to bring them back, "Move labels"
// to drag labels clear of each other (a thin leader keeps each one tied to
// its bond or angle; the view does not turn meanwhile), and the label colours — value text
// (the inspected structure's, and a compared structure's), the length and
// angle label backgrounds and the angle arcs — for figures. Each window keeps
// its own state, so hiding a label in one never hides it in the other.
// Colours are picked with the app's own picker (ui/SwatchColorPicker.js), as
// everywhere else in the app.

import { openSwatchColorPicker } from '../SwatchColorPicker.js';
import { app } from '../../state/store.js';
import { colorToCss } from '../../render/ImageExportModule.js';

/** The mini view's own label colours (PolyhedronMiniRenderer.js uses these
 *  for any colour left at null), as hex. */
export const DEFAULT_LABEL_COLORS = Object.freeze({
  lengthText: '#ffffff',
  angleText: '#1a1300',
  valueB: '#e0303a',
  lengthBg: '#000000',
  angleBg: '#ffcc44',
  arc: '#ffcc44',
});

/**
 * @typedef {{ valueA: string|null, valueB: string, lengthBg: string|null,
 *   angleBg: string|null, arc: string|null, background: string|null }} LabelColors
 *   valueA: the inspected structure's values (null = each label's own text
 *   colour: light on a length label, dark on an angle label); valueB: a
 *   compared structure's values.
 * @typedef {{ showLengths: boolean, showAngles: boolean, hidden: Set<string>,
 *   colors: LabelColors, offsets: Map<string, {r: number, u: number}>, placing: boolean }} LabelState
 *   offsets: labels the user moved (PolyhedronMiniRenderer.js setPlacing);
 *   placing: the Move labels mode is on.
 */

function defaultColors() {
  return { valueA: null, valueB: DEFAULT_LABEL_COLORS.valueB, lengthBg: null, angleBg: null, arc: null, background: null };
}

/** @returns {LabelState} */
export function createLabelState() {
  return { showLengths: true, showAngles: true, hidden: new Set(), colors: defaultColors(), offsets: new Map(), placing: false };
}

const COLOR_INPUTS = [
  ['valueA', 'Values', 'Colour of the values'],
  ['valueB', 'Compared', 'Colour of the compared structure\'s values (shown while comparing)'],
  ['lengthBg', 'Lengths', 'Background of the length labels'],
  ['angleBg', 'Angles', 'Background of the angle labels'],
  ['arc', 'Arcs', 'Colour of the angle arcs'],
];

/** The colour a swatch shows: the chosen one, or the default it stands for. */
export function shownColor(key, colors) {
  if (colors[key]) return colors[key];
  // The view's background: the main view's own, until one is chosen.
  if (key === 'background') return colorToCss(app.scene?.background);
  return { valueA: DEFAULT_LABEL_COLORS.lengthText, valueB: DEFAULT_LABEL_COLORS.valueB,
    lengthBg: DEFAULT_LABEL_COLORS.lengthBg, angleBg: DEFAULT_LABEL_COLORS.angleBg, arc: DEFAULT_LABEL_COLORS.arc }[key];
}

/** Toolbar markup; ids are prefixed per window (`pi`, `si`). */
export function labelToolbarHtml(prefix, state) {
  return `
    <div class="pi-ctl-row pi-toolbar">
      <label class="eos-mini-toggle toggle_row toggle_container" title="Show bond-length labels">
        <span class="toggle_switch">
          <input type="checkbox" id="${prefix}LengthsToggle" ${state.showLengths ? 'checked' : ''}>
          <span class="toggle_slider"></span>
        </span>
        <span class="toggle_text">Lengths</span>
      </label>
      <label class="eos-mini-toggle toggle_row toggle_container" title="Show bond-angle arcs and labels">
        <span class="toggle_switch">
          <input type="checkbox" id="${prefix}AnglesToggle" ${state.showAngles ? 'checked' : ''}>
          <span class="toggle_slider"></span>
        </span>
        <span class="toggle_text">Angles</span>
      </label>
      <button type="button" class="btn-mini pi-btn pi-tool-btn" id="${prefix}PlaceLabels" aria-pressed="false"
        title="Move labels: drag a label to place it — a thin line leads back to its bond or angle. The view does not turn meanwhile; press again to rotate it.">Move labels</button>
      <button type="button" class="btn-mini pi-btn pi-show-labels" id="${prefix}ShowLabels" title="Bring back every label you hid">Show all labels</button>
      <button type="button" class="btn-mini pi-btn" id="${prefix}ResetPlaces" hidden title="Put every moved label back on its bond or angle">Reset positions</button>
    </div>
    <div class="pi-ctl-row pi-colors" id="${prefix}Colors">
      <span class="pi-colors-text">Colours</span>
      ${COLOR_INPUTS.map(([key, text, title]) => `
        <button type="button" class="pi-color" data-color-key="${key}" title="${title}"${key === 'valueB' ? ' hidden' : ''}>
          <span class="color-swatch-btn pi-color-swatch" id="${prefix}Color-${key}"></span>
          <span>${text}</span>
        </button>`).join('')}
      <button type="button" class="btn-mini pi-btn pi-colors-reset" id="${prefix}ColorsReset" title="Back to the default colours">Reset</button>
    </div>
  `;
}

/**
 * Open the app's colour picker for one label colour, next to `anchor`; its
 * Reset puts that colour back to the default.
 * @param {HTMLElement} anchor
 * @param {LabelState} state
 * @param {keyof LabelColors} key
 * @param {(key: keyof LabelColors, value: string|null) => void} set
 */
function pickLabelColor(anchor, state, key, set) {
  // The picker also paints its anchor in the picked colour: right for a
  // swatch; a legend key is repainted in its own colours by `set` right after.
  openSwatchColorPicker(anchor, shownColor(key, state.colors), (hex) => set(key, hex), {
    onReset: () => set(key, defaultColors()[key]),
  });
}

/**
 * Wire the toolbar to a mini renderer, and clicks on its labels to hiding.
 * @param {HTMLElement} body the window body holding the toolbar
 * @param {string} prefix the toolbar's id prefix
 * @param {LabelState} state
 * @param {ReturnType<typeof import('./PolyhedronMiniRenderer.js').createPolyhedronMiniRenderer>} mini
 * @param {() => void} [onColors] after any colour change (e.g. to repaint a legend)
 * @param {(placing: boolean) => void} [onPlacing] after Move labels is turned on or off (e.g. the hint)
 * @returns {{ refresh(): void, setColor(key: keyof LabelColors, value: string|null): void,
 *   showCompareColor(on: boolean): void }}
 *   refresh: the "Show all labels (n hidden)" button; setColor: change one
 *   colour from elsewhere and keep the toolbar in step; showCompareColor: the
 *   Compared swatch, only while a structure is compared
 */
export function wireLabelToolbar(body, prefix, state, mini, onColors = () => {}, onPlacing = () => {}) {
  const showBtn = /** @type {HTMLButtonElement} */ (body.querySelector(`#${prefix}ShowLabels`));
  const placeBtn = /** @type {HTMLButtonElement} */ (body.querySelector(`#${prefix}PlaceLabels`));
  const resetPlacesBtn = /** @type {HTMLButtonElement} */ (body.querySelector(`#${prefix}ResetPlaces`));
  // Every colour swatch of the window: the Colours row, and any elsewhere
  // that keeps its colour in the same state (the view's Background).
  const colorButtons = /** @type {HTMLButtonElement[]} */ ([...body.querySelectorAll('.pi-color[data-color-key]')]);
  const refresh = () => {
    const n = state.hidden.size;
    showBtn.disabled = n === 0;
    showBtn.textContent = n ? `Show all labels (${n} hidden)` : 'Show all labels';
    resetPlacesBtn.hidden = state.offsets.size === 0;
  };
  // Move labels is a mode, not a setting: it starts off each time a window opens.
  const setPlacing = (on, notify = true) => {
    state.placing = on;
    mini.setPlacing(on);
    placeBtn.classList.toggle('active', on);
    placeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (notify) onPlacing(on);
  };
  // The one property that isn't chrome: a swatch's fill IS its value.
  const syncSwatches = () => {
    for (const btn of colorButtons) {
      /** @type {HTMLElement} */ (btn.firstElementChild).style.background = shownColor(btn.dataset.colorKey, state.colors);
    }
  };
  const applyColors = () => {
    syncSwatches();
    mini.setLabelColors(state.colors);
    onColors();
  };
  const setColor = (key, value) => {
    state.colors[key] = value;
    applyColors();
  };
  mini.setShowLengths(state.showLengths);
  mini.setShowAngles(state.showAngles);
  mini.setHiddenLabels(state.hidden);
  mini.setLabelColors(state.colors);
  mini.setLabelOffsets(state.offsets);
  setPlacing(false, false); // the window is still being built: nothing to tell yet
  placeBtn.addEventListener('click', () => setPlacing(!state.placing));
  resetPlacesBtn.addEventListener('click', () => {
    state.offsets.clear();
    refresh();
  });

  body.querySelector(`#${prefix}LengthsToggle`).addEventListener('change', (e) => {
    state.showLengths = /** @type {HTMLInputElement} */ (e.target).checked;
    mini.setShowLengths(state.showLengths);
  });
  body.querySelector(`#${prefix}AnglesToggle`).addEventListener('change', (e) => {
    state.showAngles = /** @type {HTMLInputElement} */ (e.target).checked;
    mini.setShowAngles(state.showAngles);
  });
  showBtn.addEventListener('click', () => {
    state.hidden.clear();
    mini.setHiddenLabels(state.hidden);
    refresh();
  });
  for (const btn of colorButtons) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      pickLabelColor(/** @type {HTMLElement} */ (btn.firstElementChild), state,
        /** @type {keyof LabelColors} */ (btn.dataset.colorKey), setColor);
    });
  }
  body.querySelector(`#${prefix}ColorsReset`).addEventListener('click', () => {
    Object.assign(state.colors, defaultColors());
    applyColors();
  });
  mini.setHandlers({
    onLabelHide(key) {
      state.hidden.add(key);
      mini.setHiddenLabels(state.hidden);
      refresh();
    },
    onLabelMoved: refresh,
  });
  syncSwatches();
  refresh();
  const compareBtn = colorButtons.find((b) => b.dataset.colorKey === 'valueB');
  return {
    refresh,
    setColor,
    showCompareColor(on) { if (compareBtn) compareBtn.hidden = !on; },
  };
}
