// The one factory for pill-style toggle switches. The pill itself is
// styles/toggle_styles.css's .toggle_switch/.toggle_slider pair (the knob is
// the slider's ::before); size variants are extra classes on the .toggle_switch
// element (toggle_switch--sm, cv-species-toggle). Panels that used to ship
// their own copy of this markup — each with its own drift in size, knob and
// track colours — build through here now, so the markup and the themed
// track/knob tokens (--switch-off / --switch-knob / --highlight-color) can't
// fragment again.

/**
 * Bare pill switch: <tag class="toggle_switch"><input><span.toggle_slider>.
 * `tag: 'label'` makes the switch itself a label around its own checkbox, so
 * clicking anywhere on it toggles natively without an outer label row.
 * @param {{ id?: string, checked?: boolean, small?: boolean, tag?: 'span'|'label' }} [opts]
 * @returns {{ switchEl: HTMLElement, input: HTMLInputElement }}
 */
export function createToggleSwitch({ id = '', checked = false, small = false, tag = 'span' } = {}) {
  const switchEl = document.createElement(tag);
  switchEl.className = small ? 'toggle_switch toggle_switch--sm' : 'toggle_switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  if (id) input.id = id;
  input.checked = checked;
  const slider = document.createElement('span');
  slider.className = 'toggle_slider';
  switchEl.appendChild(input);
  switchEl.appendChild(slider);
  return { switchEl, input };
}

/**
 * Labeled toggle row: <label class=rowClass> pill + <span class=textClass>.
 * The row is a <label>, so a click on the text toggles the checkbox natively.
 * rowClass/textClass exist for callers whose row spacing/label styling is
 * panel-specific (e.g. cmp-toggle-row) — the pill inside stays stock.
 * @param {{ id?: string, label: string, checked?: boolean,
 *           onChange?: (checked: boolean, e: Event) => void,
 *           rowClass?: string, textClass?: string }} opts
 * @returns {{ row: HTMLLabelElement, input: HTMLInputElement }}
 */
export function createToggleRow({ id = '', label, checked = false, onChange,
                                  rowClass = 'toggle_row toggle_container',
                                  textClass = 'toggle_text' }) {
  const row = document.createElement('label');
  row.className = rowClass;
  const { switchEl, input } = createToggleSwitch({ id, checked });
  const text = document.createElement('span');
  text.className = textClass;
  text.textContent = label;
  if (onChange) input.addEventListener('change', (e) => onChange(input.checked, e));
  row.appendChild(switchEl);
  row.appendChild(text);
  return { row, input };
}
