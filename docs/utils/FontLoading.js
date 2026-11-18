let crysVizFontsPromise;
let labelFontsPromise;
let boundedCrysVizFontsPromise;

const loadSamples = (samples) => Promise.all([
  ...samples.map((sample) => document.fonts.load("400 12px 'CrysViz Sans'", sample)),
  ...samples.map((sample) => document.fonts.load("700 12px 'CrysViz Sans'", sample)),
]);

/** Every bundled face: each script subset of CrysViz Sans and the math face. */
function getCrysVizFontsPromise() {
  if (!crysVizFontsPromise) {
    crysVizFontsPromise = Promise.all([
      getLabelFontsPromise(),
      loadSamples(['ł', 'α', 'ἀ', 'я', 'ѻ']),
      document.fonts.load("400 12px 'CrysViz Sans Math'", '∫'),
    ]).then(() => undefined);
  }
  return crysVizFontsPromise;
}

/** The faces the 3D view's own text uses (axis letters, atom labels, charge
 *  badges): Latin and the super/subscripts. Loading every subset here pulled
 *  ~0.6 MB of Greek, Cyrillic and math fonts into the start-up, competing with
 *  the app's own files for the connection; exports still wait for them all. */
function getLabelFontsPromise() {
  if (!labelFontsPromise) labelFontsPromise = loadSamples(['Aa', '₀']).then(() => undefined);
  return labelFontsPromise;
}

/**
 * Wait briefly for the faces the 3D view's labels use, without making startup
 * depend on a font request completing. The promise is shared so concurrent
 * callers do not duplicate the font-load work.
 *
 * @returns {Promise<void>}
 */
export function loadCrysVizFonts() {
  if (!boundedCrysVizFontsPromise) {
    const loads = getLabelFontsPromise();
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    boundedCrysVizFontsPromise = Promise.race([loads, timeout]).then(() => undefined, () => undefined);
  }
  return boundedCrysVizFontsPromise;
}

/**
 * Wait for every bundled face without a timeout. Use only where capturing
 * fallback text would be worse than waiting for a same-origin font request.
 *
 * @returns {Promise<void>}
 */
export function crysVizFontsLoaded() {
  return getCrysVizFontsPromise();
}
