let crysVizFontsPromise;
let boundedCrysVizFontsPromise;

function getCrysVizFontsPromise() {
  if (!crysVizFontsPromise) {
    const sansSamples = ['Aa', 'ł', 'α', 'ἀ', 'я', 'ѻ', '₀'];
    crysVizFontsPromise = Promise.all([
      ...sansSamples.map((sample) => document.fonts.load("400 12px 'CrysViz Sans'", sample)),
      ...sansSamples.map((sample) => document.fonts.load("700 12px 'CrysViz Sans'", sample)),
      document.fonts.load("400 12px 'CrysViz Sans Math'", '∫'),
    ]).then(() => undefined);
  }
  return crysVizFontsPromise;
}

/**
 * Wait briefly for the bundled faces without making startup/export depend on
 * a font request completing. The promise is shared so concurrent callers do
 * not duplicate the font-load work.
 *
 * @returns {Promise<void>}
 */
export function loadCrysVizFonts() {
  if (!boundedCrysVizFontsPromise) {
    const loads = getCrysVizFontsPromise();
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
