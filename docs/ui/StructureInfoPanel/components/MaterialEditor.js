// Shared "Material (ray/path tracing)" editor block for the Structure-window
// group editors (per-species atoms / per-pair bonds / per-category polyhedra).
// Materials only affect the raytrace/pathtrace pipelines: the caller's
// setMaterial writes the material into the owning style store and the tracer
// SceneEncoder's fingerprint picks the change up on the next requested frame
// (re-encode + accumulation reset). Under raster pipelines the controls are
// intentionally inert (the label says so).
//
// Material object shape (see model/Structure.js atomMaterials):
//   { type: 'standard'|'metal'|'glass'|'emissive', roughness?, ior?, intensity? }
// Selecting "Standard" clears the stored entry (standard is the default).

import { requestRender } from '../../../render/index.js';

const TYPES = [
  { value: 'standard', label: 'Standard' },
  { value: 'metal', label: 'Metal' },
  { value: 'glass', label: 'Glass' },
  { value: 'emissive', label: 'Emissive (light)' },
];

/**
 * @param {() => ({type?: string, roughness?: number, ior?: number, intensity?: number} | null | undefined)} getMaterial
 * @param {(material: object | null) => void} setMaterial write to the owning store (null = clear)
 */
export function createMaterialEditor(getMaterial, setMaterial) {
  const block = document.createElement('div');
  block.className = 'material-editor';
  block.style.cssText = 'margin-top:10px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.08);';

  const current = getMaterial() ?? {};
  const state = {
    type: current.type ?? 'standard',
    roughness: current.roughness ?? 0.2,
    ior: current.ior ?? 1.5,
    intensity: current.intensity ?? 5,
  };

  const header = document.createElement('div');
  header.textContent = 'Material (ray/path tracing)';
  header.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.6); margin-bottom:6px;';
  block.appendChild(header);

  const typeRow = document.createElement('div');
  typeRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
  const typeLabel = document.createElement('span');
  typeLabel.textContent = 'Type';
  typeLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const typeSelect = document.createElement('select');
  typeSelect.className = 'material-type-select';
  typeSelect.style.cssText = 'flex:1; height:28px; font-size:11px;';
  for (const t of TYPES) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    if (t.value === state.type) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeRow.appendChild(typeLabel);
  typeRow.appendChild(typeSelect);
  block.appendChild(typeRow);

  // one property slider row per material type that has a knob
  const makePropRow = (labelText, cls, min, max, step, value, onInput) => {
    const row = document.createElement('div');
    row.className = cls;
    row.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:6px;';
    const label = document.createElement('span');
    label.textContent = labelText;
    label.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);
    slider.style.cssText = 'flex:1;';
    const valueSpan = document.createElement('span');
    valueSpan.textContent = Number(value).toFixed(2);
    valueSpan.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.7); min-width: 34px; text-align:right;';
    slider.addEventListener('input', () => {
      valueSpan.textContent = Number(slider.value).toFixed(2);
      onInput(parseFloat(slider.value));
    });
    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(valueSpan);
    return row;
  };

  const commit = () => {
    if (state.type === 'standard') {
      setMaterial(null); // standard is the default — clear the entry
    } else {
      setMaterial({
        type: state.type,
        roughness: state.roughness,
        ior: state.ior,
        intensity: state.intensity,
      });
    }
    requestRender();
  };

  const roughRow = makePropRow('Rough', 'material-roughness-row', 0, 1, 0.05, state.roughness,
    (v) => { state.roughness = v; commit(); });
  const iorRow = makePropRow('IoR', 'material-ior-row', 1.0, 2.5, 0.05, state.ior,
    (v) => { state.ior = v; commit(); });
  const intensityRow = makePropRow('Glow', 'material-intensity-row', 0, 20, 0.5, state.intensity,
    (v) => { state.intensity = v; commit(); });
  block.appendChild(roughRow);
  block.appendChild(iorRow);
  block.appendChild(intensityRow);

  const syncPropVisibility = () => {
    roughRow.style.display = state.type === 'metal' ? 'flex' : 'none';
    iorRow.style.display = state.type === 'glass' ? 'flex' : 'none';
    intensityRow.style.display = state.type === 'emissive' ? 'flex' : 'none';
  };
  syncPropVisibility();

  typeSelect.addEventListener('change', () => {
    state.type = typeSelect.value;
    syncPropVisibility();
    commit();
  });

  return block;
}
