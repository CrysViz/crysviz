import { areAllAtomsCutPlaneImmune, setCutPlaneImmunityForAtoms } from './utils.js';

export function createTinyImmunityToggle(atomIndices, title = 'Keep visible across cut planes') {
  const wrapper = document.createElement('label');
  wrapper.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; cursor:pointer; width:10px; height:10px; flex:0 0 auto;';
  wrapper.title = title;

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = areAllAtomsCutPlaneImmune(atomIndices);
  toggle.style.cssText = `
    width:10px;
    height:10px;
    margin:0;
    cursor:pointer;
    appearance:none;
    -webkit-appearance:none;
    border-radius:50%;
    border:1px solid rgba(255,255,255,0.5);
    background: rgba(255,255,255,0.08);
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.18);
  `;
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
    setCutPlaneImmunityForAtoms(atomIndices, toggle.checked);
    updateVisual();
  });

  wrapper.appendChild(toggle);
  return { wrapper, toggle };
}
