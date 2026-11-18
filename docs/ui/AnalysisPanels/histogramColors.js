// Series colours for the analysis histograms. The palette is the eight colours
// the histograms have always used, a dark-navy-to-light-yellow map. Series
// come in FAMILIES: an element pair in the Bond Length Histogram ("Cu-O"), an
// element in the Force Histogram. Families are spread evenly over the map
// (paletteSlot): two species take its two ends rather than its first two,
// nearly identical, navy colours; eight or more use every colour in order. A
// single species is teal (SINGLE_FAMILY_COLOR), outside the map.
// When a family has several series ("Group by Wyckoff": Cu1 (2q) – O2 (2s),
// Cu1 (2q) – O3 (2r), ...), they share the family's colour in lighter and
// darker shades. So Cu–O keeps its
// colour when the grouping changes, and Wyckoff grouping does not run through
// the eight colours the way one colour per site pair would.
//
// Pure functions (no DOM, no app state), so tools/unittest can test them.

export const HISTOGRAM_COLORS = [
  '#00202e', '#2c4875', '#8a508f', '#bc5090',
  '#ff6361', '#ff8531', '#ffa600', '#ffd380',
];

// OKLab lightness between neighbouring shades (when they fit), and the band
// every shade stays in: below 0.30 a shade is black on the dark card, and
// above 0.80 the shades wash out towards white.
const SHADE_STEP = 0.09;
const SHADE_MIN_L = 0.30;
const SHADE_MAX_L = 0.80;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

/** '#rrggbb' -> OKLab [L, a, b]. */
export function hexToOklab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** OKLab [L, a, b] -> '#rrggbb'. A colour outside sRGB loses chroma (not
 *  lightness) until it fits, so a light shade of a vivid colour keeps the
 *  lightness it was given instead of being clipped darker. */
export function oklabToHex([L, a, b]) {
  const fits = (k) => oklabToLinear([L, a * k, b * k]).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let k = 1;
  if (!fits(1)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    k = lo;
  }
  const rgb = oklabToLinear([L, a * k, b * k]);
  return `#${rgb.map((v) => Math.round(linearToSrgb(v) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** `count` shades of `base`, dark to light, inside the SHADE_MIN_L–
 *  SHADE_MAX_L lightness band: SHADE_STEP apart while they fit, closer
 *  together for a large family (a C–N pair with twelve site pairs) rather
 *  than running out of the band into white. Centred on the base's lightness
 *  where the band allows (an odd count then includes the base itself). A
 *  single shade is the base. */
export function shadesOf(base, count) {
  if (count <= 1) return [base];
  const [L, a, b] = hexToOklab(base);
  const span = Math.min(SHADE_STEP * (count - 1), SHADE_MAX_L - SHADE_MIN_L);
  const step = span / (count - 1);
  const lo = Math.max(SHADE_MIN_L, Math.min(L - span / 2, SHADE_MAX_L - span));
  return Array.from({ length: count }, (_, j) => oklabToHex([lo + j * step, a, b]));
}

// A lone family's colour: a mid-light teal, which reads on the dark card and
// the light chart alike and shades from dark teal to light aqua. Not from the
// map, whose middle (coral) shaded into dark reds and whose purple was not
// liked for this.
export const SINGLE_FAMILY_COLOR = '#2a9d8f';

/** Palette index for the `rank`-th of `count` (two or more) families: evenly
 *  spread over the map, both ends included, so few families get colours far
 *  apart. From eight families on, the palette is used in order and wraps. */
export function paletteSlot(rank, count) {
  const n = HISTOGRAM_COLORS.length;
  if (count >= n) return rank % n;
  if (count <= 1) return 0;
  return Math.round((rank * (n - 1)) / (count - 1));
}

/** The colour for the `rank`-th of `count` families: teal for a lone family,
 *  else its paletteSlot. */
export function paletteColor(rank, count) {
  return count <= 1 ? SINGLE_FAMILY_COLOR : HISTOGRAM_COLORS[paletteSlot(rank, count)];
}

/**
 * One colour per series. `families[i]` is series i's family; `familyOrder`
 * lists the families in palette order (a family missing from it goes after
 * them), spread over the map by paletteSlot. Series of one family get its
 * shades in the order they appear.
 * @param {string[]} families
 * @param {string[]} familyOrder
 * @returns {string[]}
 */
export function seriesColors(families, familyOrder) {
  const order = [...new Set([...familyOrder, ...families])];
  const members = new Map();
  families.forEach((family, i) => {
    if (!members.has(family)) members.set(family, []);
    members.get(family).push(i);
  });
  const colors = new Array(families.length);
  for (const [family, indices] of members) {
    const base = paletteColor(order.indexOf(family), order.length);
    shadesOf(base, indices.length).forEach((color, j) => { colors[indices[j]] = color; });
  }
  return colors;
}
