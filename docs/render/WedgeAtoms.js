// Per-instance "pie wedge" data for partially occupied / mixed-species sites.
//
// A disordered site is drawn as one sphere whose surface is split into wedges
// sized by occupancy, rather than as several overlapping spheres. The split is
// computed in the fragment shader from the fragment's azimuth around the *view*
// axis, which has two consequences worth stating plainly:
//
//   * The pie always faces the camera, so the proportions on screen are always
//     the true occupancies. A partition fixed to the crystal axes would only be
//     honest from two angles - viewed from the side, a 50/50 sphere would read
//     as pure A from one direction and pure B from the other.
//   * It costs nothing per frame. The camera-facing behaviour falls out of
//     working in view space; there is no per-instance rotation to rewrite when
//     the camera moves.
//
// The data rides on the existing atoms InstancedMesh so UUID picking, selection
// glow, cut planes and per-instance opacity keep working untouched. It is
// carried in a DataTexture rather than instance attributes because the mesh is
// already at 14 of the GPU's 16 vertex attributes (instanceMatrix alone costs
// four), and spending the last two here would leave the shader with no headroom
// at all. The texture is indexed by the instance id the shader already has to
// hand as vInstanceElementIndex, so this costs zero attributes.

import * as THREE from '../external/three/three.module.js';
import { getElementDefaultColor } from '../defaults/color_texture_defaults.js';

/** Wedge slots per site. Sites with more species merge the tail (see below). */
export const MAX_WEDGES = 4;

/** Texels per instance: one of boundaries, one of packed colours. */
const TEXELS_PER_INSTANCE = 2;

/** Texture width; height grows to fit. */
const TEX_WIDTH = 2048;

/** Colour used for the unoccupied fraction of a site. */
const VACANCY_COLOR = 0x2a2a30;

/** Occupancy below which a wedge is not worth drawing. */
const MIN_WEDGE = 1e-3;

/**
 * Pack an 0xRRGGBB colour into a single float. Exact: the value never exceeds
 * 2^24, which float32's mantissa represents without loss.
 *
 * @param {number} hex
 * @returns {number}
 */
function packColor(hex) {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return r * 65536 + g * 256 + b;
}

/**
 * Colour for a vacancy wedge. The hatch marks it as absence regardless, but the
 * fill colour underneath is user-settable so a vacancy can be tinted to stand
 * out (or blend in): an explicit per-species colour wins, then — on a site that
 * is nothing BUT a vacancy — the atom's own userColor (what the single-dot
 * element picker in ColorEditor.js sets), and otherwise the neutral default.
 *
 * @param {any} atom
 * @param {{color:number|null}} s the vacancy species slot
 * @param {boolean} pureVacancy the whole site is one "Va" species, nothing else
 * @returns {number}
 */
function vacancyWedgeColor(atom, s, pureVacancy) {
  if (Number.isFinite(s.color)) return s.color;
  if (pureVacancy && atom.userColor != null) {
    const n = typeof atom.userColor === 'number'
      ? atom.userColor
      : parseInt(String(atom.userColor).replace('#', ''), 16);
    if (Number.isFinite(n)) return n;
  }
  return VACANCY_COLOR;
}

/**
 * Build the wedge description for one atom.
 *
 * Returns null for an ordinary fully-occupied single-species site, which is the
 * overwhelmingly common case and stays on the existing flat-colour path.
 *
 * @param {any} atom
 * @returns {{fracs: number[], packed: number[], slots: Array<{color: number, occupancy: number, vacancy: boolean, element: string}>}|null}
 */
export function wedgeDataForAtom(atom) {
  // "Va" is a real, tracked species like any other element string (it just
  // isn't a real element) so it shows up everywhere a species does -
  // composition, the atom tables - without a parallel bookkeeping system.
  // Rendering is the one place it needs to be told apart from a real
  // element: a plain single-species "Va" site is not disordered by
  // isDisordered()'s definition (one species, full occupancy), but it still
  // needs the hatch, not the ordinary flat-colour path a normal ordered atom
  // gets.
  const hasVacancySpecies = atom?.species?.some((s) => s.element === 'Va');
  if (!atom?.species || (!atom.isDisordered?.() && !hasVacancySpecies)) return null;

  // Largest first: the dominant species then reads as the sphere's "main"
  // colour, and any merged tail lands in the least significant wedge.
  const species = atom.species
    .filter((s) => s.occupancy > MIN_WEDGE)
    .slice()
    .sort((a, b) => (b.occupancy - a.occupancy) || (a.element < b.element ? -1 : 1));

  const pureVacancy = atom.species.length === 1 && atom.species[0].element === 'Va';
  /** @type {Array<{color: number, occupancy: number, vacancy: boolean, element: string}>} */
  const slots = species.map((s) => (s.element === 'Va'
    ? { color: vacancyWedgeColor(atom, s, pureVacancy), occupancy: s.occupancy, vacancy: true, element: 'Va' }
    : {
      // A species the user has explicitly recoloured wins over the element
      // default, same precedence as atom.userColor over atom.color.
      color: Number.isFinite(s.color) ? s.color : getElementDefaultColor(s.element),
      occupancy: s.occupancy,
      vacancy: false,
      element: s.element,
    }));

  // The IMPLICIT unoccupied fraction (species don't sum to 1, with no
  // explicit "Va" entry accounting for the shortfall) gets the same
  // treatment as an explicit one, folded into its own slot alongside it if
  // both are present.
  const vacancy = atom.getVacancyFraction();
  if (vacancy > MIN_WEDGE) {
    slots.push({ color: VACANCY_COLOR, occupancy: vacancy, vacancy: true, element: 'Va' });
  }
  // A single real species with no vacancy at all is the ordinary flat-colour
  // case. A single slot that IS vacancy (a pure "Va" site, nothing else at
  // that position) still needs the hatch even though there's only one of it
  // - the hatch, not a wedge split, is the whole point there.
  if (slots.length < 2 && !slots.some((s) => s.vacancy)) return null;

  // More species than slots is vanishingly rare; fold the tail into the last
  // wedge rather than dropping it, so the occupancies still sum correctly.
  while (slots.length > MAX_WEDGES) {
    const tail = slots.pop();
    slots[slots.length - 1].occupancy += tail.occupancy;
  }

  const total = slots.reduce((sum, s) => sum + s.occupancy, 0) || 1;
  const fracs = [];
  const packed = [];
  let acc = 0;
  for (const s of slots) {
    acc += s.occupancy / total;
    fracs.push(acc);
    // Negative marks the vacancy wedge, which the shader hatches. Avoids
    // needing a separate mask channel.
    packed.push(s.vacancy ? -packColor(s.color) : packColor(s.color));
  }
  // Pad so the shader can index all four slots unconditionally. Padding
  // boundaries sit at 1.0 so they are never selected.
  while (fracs.length < MAX_WEDGES) {
    fracs.push(1.0);
    packed.push(packed[packed.length - 1]);
  }
  fracs[MAX_WEDGES - 1] = 1.0;

  // `slots` rides along (unpadded, in wedge order) so UI that mirrors the
  // wedge sphere — the composition legend — draws from the exact colours,
  // occupancies and vacancy flags the shader gets, not a re-derivation.
  return { fracs, packed, slots };
}

/**
 * Build the wedge DataTexture for a set of instances.
 *
 * @param {any[]} atoms structure.atoms
 * @param {number[]} srcIndex wrapped.srcIndex — instance -> atom index
 * @returns {{texture: any, size: [number, number], any: boolean}}
 */
export function buildWedgeTexture(atoms, srcIndex) {
  const count = srcIndex.length;
  const texels = Math.max(1, count * TEXELS_PER_INSTANCE);
  const height = Math.max(1, Math.ceil(texels / TEX_WIDTH));
  const data = new Float32Array(TEX_WIDTH * height * 4);

  let any = false;
  for (let i = 0; i < count; i++) {
    const wedge = wedgeDataForAtom(atoms[srcIndex[i]]);
    if (!wedge) continue;   // leaves fracs at 0 — the shader's "ordered" sentinel
    any = true;
    const base = i * TEXELS_PER_INSTANCE * 4;
    for (let k = 0; k < 4; k++) {
      data[base + k] = wedge.fracs[k];
      data[base + 4 + k] = wedge.packed[k];
    }
  }

  const texture = new THREE.DataTexture(
    data, TEX_WIDTH, height, THREE.RGBAFormat, THREE.FloatType
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, size: [TEX_WIDTH, height], any };
}

/** Vertex-shader additions: view-space centre and fragment position. */
export const WEDGE_VERTEX_DECL = `
  varying vec3 vWedgeViewCenter;
  varying vec3 vWedgeViewPos;
`;

export const WEDGE_VERTEX_BODY = `
  vWedgeViewCenter = (modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vWedgeViewPos = (modelViewMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
`;

export const WEDGE_FRAGMENT_DECL = `
  uniform sampler2D uWedgeTex;
  uniform vec2 uWedgeTexSize;
  uniform float uWedgeEnabled;
  varying vec3 vWedgeViewCenter;
  varying vec3 vWedgeViewPos;

  vec4 wedgeTexel(float idx) {
    float x = mod(idx, uWedgeTexSize.x);
    float y = floor(idx / uWedgeTexSize.x);
    vec2 uv = (vec2(x, y) + 0.5) / uWedgeTexSize;
    return texture2D(uWedgeTex, uv);
  }

  // Unpacks to the renderer's working (linear) space. The packed bytes are
  // sRGB, the same as the hex the rest of the app feeds through THREE.Color,
  // which converts on the way in — skipping the transfer here would make wedge
  // colours visibly washed out next to ordinary atoms of the same element.
  vec3 wedgeUnpack(float c) {
    float v = abs(c);
    float r = floor(v / 65536.0);
    float g = floor(mod(v, 65536.0) / 256.0);
    float b = mod(v, 256.0);
    vec3 srgb = vec3(r, g, b) / 255.0;
    return mix(
      pow((srgb + 0.055) / 1.055, vec3(2.4)),
      srgb / 12.92,
      step(srgb, vec3(0.04045))
    );
  }
`;

// A bond-half variant of this (splitting each cylinder half by the composition
// of its endpoint) was tried and then dropped: on a thin cylinder the split
// aliases and is not reliably legible, unlike on a sphere with real screen
// area to work with. Bonds go back to a flat colour per half, taken from each
// endpoint's representative species — see BondsFracUpdateModule.js.

// Selects the wedge colour for this fragment. The vacancy wedge is additionally
// hatched: a flat dark fill alone reads as "some dark element", whereas stripes
// read as absence. Hatching by brightness rather than by discarding keeps it
// out of the depth-peeling pipeline's way.
export const WEDGE_FRAGMENT_BODY = `
  if (uWedgeEnabled > 0.5) {
    float wIdx = vInstanceElementIndex * 2.0;
    vec4 wFrac = wedgeTexel(wIdx);
    if (wFrac.x > 0.0) {
      vec4 wCol = wedgeTexel(wIdx + 1.0);
      vec3 wd = vWedgeViewPos - vWedgeViewCenter;
      float wt = (atan(wd.y, wd.x) + 3.14159265) / 6.28318531;
      float packedSel = wCol.x;
      if (wt >= wFrac.x) packedSel = wCol.y;
      if (wt >= wFrac.y) packedSel = wCol.z;
      if (wt >= wFrac.z) packedSel = wCol.w;
      vec3 wedgeCol = wedgeUnpack(packedSel);
      if (packedSel < 0.0) {
        float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.14));
        wedgeCol = mix(wedgeCol, wedgeCol * 2.2 + 0.16, hatch);
      }
      diffuseColor.rgb = wedgeCol;
    }
  }
`;
