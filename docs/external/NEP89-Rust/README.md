# NEP89 (Rust reference)

Rust source/reference for the NEP89 machine-learned potential (NEP —
neuroevolution potential). Kept as reference material for the in-browser NEP
implementation in `../nep_wasm/`.

- Related upstream: GPUMD / NEP — https://github.com/brucefan1983/GPUMD
- The NEP89 weights originate from GPUMD and are **GPL-3.0**; see `LICENSE-GPUMD`
  and `LICENSE-NEP_CPU` in `../nep_wasm/`.

## Files
- `NEP89.rs` — Rust source.
- `Cargo.toml`, `javascript_example/` — build config + a JS usage example.

> Note: this is reference/build material (not imported by the app). If it is
> better understood as CrysViz-native porting scaffolding than as vendored
> third-party code, it could move out of `external/`.
