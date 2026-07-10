// Type stub shadowing the vendored index.browser.js loader.
//
// mlip_runner.js dynamic-imports './index.browser.js', which in turn dynamic-
// imports the emscripten glue (cpu|gpu/mlipcpp_wasm.js). Those glue files are
// minified vendor output and are not type-clean under `tsc --checkJs`; without
// this stub tsc follows the import chain into them and reports dozens of
// false-positive errors. Mirroring the three.module.d.ts approach, this .d.ts
// takes precedence over the .js so tsc stops at the loader boundary.
export { default, createMlipcpp } from './index';
