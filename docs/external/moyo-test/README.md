# moyo (crystal symmetry, WASM)

WebAssembly build of [moyo](https://github.com/spglib/moyo), a crystal-symmetry
library (space-group detection / Wyckoff analysis), used by the in-browser
symmetry features (`ui/BackendPanel/MoyoWASM.js`, `ui/SymmetryEditModule.js`).

- Upstream: https://github.com/spglib/moyo
- License: **MIT / Apache-2.0** — see `LICENSE` in this directory.

## Files
- `moyo_wasm.js`, `moyo_wasm_bg.wasm` — wasm-bindgen output + JS glue.
- `index.html` — standalone WASM test page.
- `Archive.zip` — source/build archive.

The cargo registry paths in `moyo_wasm_bg.wasm` (Rust panic locations, also in
the copy in `Archive.zip`) were rewritten from the build machine's home
directory to `/build/./././.` of the same length. A rebuild keeps them out
with `RUSTFLAGS="--remap-path-prefix=$HOME=/build" wasm-pack build ...`.
