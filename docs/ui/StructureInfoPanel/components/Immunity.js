import { areAllAtomsCutPlaneImmune, setCutPlaneImmunityForAtoms } from './utils.js';

/**
 * The small round on/off toggle used in the tab category headers (visual core
 * of the cut-plane immunity toggles; also reused with other state stores,
 * e.g. the Bonds tab's per-pair cut immunity).
 * @param {{title?: string, checked?: boolean, onChange?: ((on: boolean) => void)|null}} [options]
 * @returns {{wrapper: HTMLElement, toggle: HTMLInputElement}}
 */
export function createTinyToggle({ title = '', checked = false, onChange = null } = {}) {
  const wrapper = document.createElement('label');
  wrapper.className = 'cv-tiny-toggle-wrap';
  wrapper.title = title;

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = checked;
  toggle.className = 'cv-tiny-toggle'; // on/off look: :checked (sceneWidgets.css)
  toggle.addEventListener('click', (e) => e.stopPropagation());
  toggle.addEventListener('change', (e) => {
    e.stopPropagation();
    onChange?.(toggle.checked);
  });

  wrapper.appendChild(toggle);
  return { wrapper, toggle };
}

export function createTinyImmunityToggle(atomIndices, title = 'Keep visible across cut planes') {
  return createTinyToggle({
    title,
    checked: areAllAtomsCutPlaneImmune(atomIndices),
    onChange: (on) => setCutPlaneImmunityForAtoms(atomIndices, on),
  });
}
