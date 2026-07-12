// Shared "Material (ray/path tracing)" editor block for the Structure-window
// group editors (per-species atoms / per-pair bonds / per-category polyhedra).
// Materials only affect the raytrace/pathtrace pipelines: the caller's
// setMaterial writes the material into the owning style store and the tracer
// SceneEncoder's fingerprint picks the change up on the next requested frame
// (re-encode + accumulation reset). Under raster pipelines the controls are
// intentionally inert (the label says so).
//
// Material object shape (see model/Structure.js atomMaterials):
//   { type: 'standard'|'metal'|'glass'|'emissive'|'translucent',
//     gloss?, tint?, roughness?, frost?, ior?, tintDepth?, intensity?,
//     scatterDepth?, reflectivity? }
// Per-type knobs: standard = Gloss + Tint + Reflect; metal = Rough + Reflect;
// glass = Frost + IoR + Tint depth; emissive = Glow; translucent = Depth.
// The standard Tint colors the coat/specular reflections by the surface color
// (0.6 default = the current raster-metalness-parity look; 0 = the original
// untinted white "billiard ball" coat).
// reflectivity overrides the global "Reflectivity" slider (standard) or is
// the mirrored fraction (metal). Selecting "Standard" with every knob
// untouched clears the stored entry (that IS the default).

import { general } from '../../../state/store.js';
import { requestRender } from '../../../render/index.js';

const TYPES = [
  { value: 'standard', label: 'Standard' },
  { value: 'metal', label: 'Metal' },
  { value: 'glass', label: 'Glass' },
  { value: 'emissive', label: 'Emissive (light)' },
  { value: 'translucent', label: 'Translucent (waxy)' },
];

// The full type list, exported so callers (e.g. FieldPanel) can build a
// restricted subset (the field surface excludes 'glass').
export const MATERIAL_TYPES = TYPES;

/**
 * @param {() => ({type?: string, gloss?: number, tint?: number, roughness?: number, frost?: number, ior?: number, tintDepth?: number, intensity?: number, scatterDepth?: number, reflectivity?: number} | null | undefined)} getMaterial
 * @param {(material: object | null) => void} setMaterial write to the owning store (null = clear)
 * @param {{ types?: Array<{value: string, label: string}> }} [options] optional type-list override (e.g. glass-free for the field surface)
 */
export function createMaterialEditor(getMaterial, setMaterial, { types } = {}) {
  const typeList = types ?? TYPES;
  const block = document.createElement('div');
  block.className = 'material-editor';
  block.style.cssText = 'margin-top:10px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.08);';

  const current = getMaterial() ?? {};
  const state = {
    type: current.type ?? 'standard',
    gloss: current.gloss ?? 0.6,
    tint: current.tint ?? 0.6,
    roughness: current.roughness ?? 0.2,
    frost: current.frost ?? 0,
    ior: current.ior ?? 1.5,
    tintDepth: current.tintDepth ?? 0.2,
    intensity: current.intensity ?? 5,
    scatterDepth: current.scatterDepth ?? 0.5,
    reflectivity: current.reflectivity ?? null, // null = follow the type default
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
  for (const t of typeList) {
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
    if (state.type === 'standard' && state.reflectivity == null
        && Math.abs(state.gloss - 0.6) < 1e-9 && Math.abs(state.tint - 0.6) < 1e-9) {
      setMaterial(null); // fully default — clear the entry
    } else {
      setMaterial({
        type: state.type,
        gloss: state.gloss,
        tint: state.tint,
        roughness: state.roughness,
        frost: state.frost,
        ior: state.ior,
        tintDepth: state.tintDepth,
        intensity: state.intensity,
        scatterDepth: state.scatterDepth,
        ...(state.reflectivity != null ? { reflectivity: state.reflectivity } : {}),
      });
    }
    requestRender();
  };

  const glossRow = makePropRow('Gloss', 'material-gloss-row', 0, 1, 0.05, state.gloss,
    (v) => { state.gloss = v; commit(); });
  // standard-only: how strongly coat/specular reflections take the surface
  // color (0 = untinted white — the original "billiard ball" coat)
  const coatTintRow = makePropRow('Tint', 'material-tint-row', 0, 1, 0.05, state.tint,
    (v) => { state.tint = v; commit(); });
  const roughRow = makePropRow('Rough', 'material-roughness-row', 0, 1, 0.05, state.roughness,
    (v) => { state.roughness = v; commit(); });
  const frostRow = makePropRow('Frost', 'material-frost-row', 0, 1, 0.05, state.frost,
    (v) => { state.frost = v; commit(); });
  const iorRow = makePropRow('IoR', 'material-ior-row', 1.0, 2.5, 0.05, state.ior,
    (v) => { state.ior = v; commit(); });
  const tintRow = makePropRow('Tint', 'material-tintdepth-row', 0, 2, 0.05, state.tintDepth,
    (v) => { state.tintDepth = v; commit(); });
  const intensityRow = makePropRow('Glow', 'material-intensity-row', 0, 20, 0.5, state.intensity,
    (v) => { state.intensity = v; commit(); });
  const scatterRow = makePropRow('Depth', 'material-scatter-row', 0.05, 2, 0.05, state.scatterDepth,
    (v) => { state.scatterDepth = v; commit(); });
  // Per-object reflectivity: for STANDARD surfaces it overrides the global
  // "Reflectivity" slider once touched (shown at the global value until then);
  // for METAL it is the mirrored fraction (1 = ideal mirror, lower blends
  // toward diffuse — brushed/dull metal).
  const defaultReflectivity = () => (state.type === 'metal' ? 1 : (general.rtReflectivity ?? 0.15));
  const reflectRow = makePropRow('Reflect', 'material-reflectivity-row', 0, 1, 0.05,
    state.reflectivity ?? defaultReflectivity(),
    (v) => { state.reflectivity = v; commit(); });
  block.appendChild(glossRow);
  block.appendChild(coatTintRow);
  block.appendChild(roughRow);
  block.appendChild(frostRow);
  block.appendChild(iorRow);
  block.appendChild(tintRow);
  block.appendChild(intensityRow);
  block.appendChild(scatterRow);
  block.appendChild(reflectRow);

  const syncPropVisibility = () => {
    glossRow.style.display = state.type === 'standard' ? 'flex' : 'none';
    coatTintRow.style.display = state.type === 'standard' ? 'flex' : 'none';
    roughRow.style.display = state.type === 'metal' ? 'flex' : 'none';
    frostRow.style.display = state.type === 'glass' ? 'flex' : 'none';
    iorRow.style.display = state.type === 'glass' ? 'flex' : 'none';
    tintRow.style.display = state.type === 'glass' ? 'flex' : 'none';
    intensityRow.style.display = state.type === 'emissive' ? 'flex' : 'none';
    scatterRow.style.display = state.type === 'translucent' ? 'flex' : 'none';
    reflectRow.style.display = (state.type === 'standard' || state.type === 'metal') ? 'flex' : 'none';
    // an untouched Reflect slider tracks the type's default (global / mirror)
    if (state.reflectivity == null) {
      const slider = reflectRow.querySelector('input');
      const span = reflectRow.querySelector('span:last-child');
      if (slider) slider.value = String(defaultReflectivity());
      if (span) span.textContent = defaultReflectivity().toFixed(2);
    }
  };
  syncPropVisibility();

  typeSelect.addEventListener('change', () => {
    state.type = typeSelect.value;
    syncPropVisibility();
    commit();
  });

  return block;
}
