// ESLint flat config (eslint v9) for CrysViz.
// Scope: the app sources in docs/ only. Vendored/compiled/dead code is ignored.
// The ruleset is intentionally lean — focused on real-bug rules (undefined refs,
// duplicate object keys, unreachable code) rather than style — so `make lint`
// stays high-signal on this established codebase. Tighten over time as desired.
import globals from "globals";

export default [
  {
    ignores: [
      "docs/external/**",   // vendored three.js, Lut, moyo/nep wasm, gpu.js …
      "docs/compiled/**",   // emscripten/wasm-bindgen build output
      "old/**",             // pre-refactor monolith kept for reference
      "node_modules/**",
    ],
  },
  {
    files: ["docs/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.worker,
        // App-defined globals attached to window at runtime:
        clearAtomHighlight: "readonly",
        // Elements with these `id`s are exposed by the browser as window
        // properties (named-element globals), so referencing them bare is not
        // actually "undefined". Declared here to keep no-undef high-signal.
        view: "readonly",
        errorPanel: "readonly",
        ControlPanelAnalysisSwitch: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "warn",
      "no-redeclare": "warn",
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
];
