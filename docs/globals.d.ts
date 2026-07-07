// Project-wide type relaxations for this untyped, browser-only codebase.
//
// CrysViz constantly looks up its fixed DOM scaffold (defined in index.html) by
// id and by selector. The DOM lib types those lookups as HTMLElement / Element,
// so practically every `.value` / `.checked` / `.style` / `.getContext()` access
// would be a false-positive type error. Rather than litter the code with
// hundreds of `/** @type {HTMLInputElement} */ (...)` casts, we type these
// lookups as `any`. This is a deliberate, localized loosening; remove it (and
// add per-site casts) if stricter DOM typing is ever wanted.
interface Document {
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
}
interface Element {
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
  closest(selectors: string): any;
}

// Ambient globals defined at runtime in crystal-viewer.js / index.html (and
// listed as globals in eslint.config.js). Declared here so tsc resolves them.
declare var view: any;
declare var errorPanel: any;

// Remote ESM imported directly by URL (resolved by the browser, not tsc).
declare module "https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.esm.min.js";

// Expando properties CrysViz attaches to `window` at runtime.
interface Window {
  NEPWasmRunner: any;
  clearAtomHighlight: any;
  InstanceMeshManager: any;
}
