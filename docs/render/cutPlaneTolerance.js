// A leaf module (no imports) so the shaders' MaterialStyles.js and the CPU cut
// tests can share it without an import cycle.

/** How far (Å) past a cut plane an atom's centre must lie to be cut away. An
 *  atom ON the plane (a cut through an atomic layer) is kept, and kept whole:
 *  the shaders tested the centre per pixel with no margin, and float noise
 *  left such atoms speckled, half cut. Every cut test shares it (the WASM
 *  polyhedra build keeps its own exact test). */
export const CUT_PLANE_TOLERANCE = 1e-4;

/** The same, as a GLSL float literal. */
export const CUT_PLANE_TOLERANCE_GLSL = CUT_PLANE_TOLERANCE.toFixed(6);
