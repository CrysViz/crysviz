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
  toggle.className = 'cv-tiny-toggle';
  // background/border-color/box-shadow are set unconditionally by
  // updateVisual() below (called right after this), so the class above
  // deliberately carries no default for them — nothing else can flash the
  // wrong state first.
  const updateVisual = () => {
    if (toggle.checked) {
      toggle.style.background = 'rgba(255,255,255,0.96)';
      toggle.style.borderColor = 'rgba(255,255,255,0.96)';
      toggle.style.boxShadow = '0 0 0 2px rgba(255,255,255,0.08)';
    } else {
      toggle.style.background = 'rgba(255,255,255,0.08)';
      toggle.style.borderColor = 'rgba(255,255,255,0.5)';
      toggle.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,0.18)';
    }
  };
  updateVisual();
  toggle.addEventListener('click', (e) => e.stopPropagation());
  toggle.addEventListener('change', (e) => {
    e.stopPropagation();
    onChange?.(toggle.checked);
    updateVisual();
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
