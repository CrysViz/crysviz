# mlip_wasm — vendored mlip.js (mlip.cpp) WASM bindings

## What this is

JavaScript/WebAssembly bindings for **mlip.cpp** — a runtime for Machine Learning
Interatomic Potentials (PET, MACE, …). Used here to run **PET-MAD** in the browser
with no native dependencies, as an in-browser calculator alongside the existing NEP
WASM path.

- Upstream repo: https://github.com/peterspackman/mlip.cpp
- npm package: `@peterspackman/mlip.js` **v0.1.1**
- License: **BSD-3-Clause** — kept in this directory as `LICENSE`.

`index.browser.js` is the ESM loader; it dynamic-imports `./cpu/mlipcpp_wasm.js`
(single-threaded CPU build) or `./gpu/mlipcpp_wasm.js` (WebGPU + ASYNCIFY build)
depending on the requested backend. The relative `cpu/` and `gpu/` layout must be
preserved so those dynamic imports resolve, and each glue `.js` locates its sibling
`.wasm` next to it.

`mlip_runner.js` (not from upstream — written for this repo) is the ES-module
adapter `MLIPRunner`, mirroring `NEPWasmRunner` from `../nep_wasm/nep_simple.js`.

## Source (jsDelivr, pinned @0.1.1)

Vendored from `https://cdn.jsdelivr.net/npm/@peterspackman/mlip.js@0.1.1/`:

- `index.browser.js`      ← `dist/index.browser.js`
- `index.d.ts`            ← `dist/index.d.ts`
- `cpu/mlipcpp_wasm.js`   ← `dist/cpu/mlipcpp_wasm.js`
- `cpu/mlipcpp_wasm.wasm` ← `dist/cpu/mlipcpp_wasm.wasm`
- `gpu/mlipcpp_wasm.js`   ← `dist/gpu/mlipcpp_wasm.js`
- `gpu/mlipcpp_wasm.wasm` ← `dist/gpu/mlipcpp_wasm.wasm`
- `LICENSE`               ← package `LICENSE`

The CPU files were taken from the npm tarball; the GPU files were downloaded from
the jsDelivr URLs above. `mlip_runner.js` and this `README.md` are local additions.

## sha256

```
a24d32b6d7ad237a7c4ee24a9e3c50e7052a6c40a7b0b9cbbf634b0898764988  index.browser.js
5ff861d2febf0637235811f08e19aa86032e9bab3b8d7d73840fe27c6fe2d9f2  index.d.ts
951880c4c0fc05699dcfc33ac9054f6b84195ff505b5021a29503633c39dc97f  LICENSE
22a7d7fa7bfb3d2f5d6cca6b61618d52c8bb49689cf613d55b0f081559835717  cpu/mlipcpp_wasm.js
7d0e527909748c532c0e03918919d9f479d61b6d31a6b81e9c5382b284fb461d  cpu/mlipcpp_wasm.wasm
2a177654fa476ad399820f176f3e24d57a98591c3f1a114441e4d38ed2562e88  gpu/mlipcpp_wasm.js
7f12d2ec4b34a2b68c87f21930c67a9acd322b3dc54dd251880ffcc09a3de5e1  gpu/mlipcpp_wasm.wasm
```

## Model weights (NOT vendored)

PET-MAD GGUF weights are **fetched at runtime** from Hugging Face and cached in the
browser (Cache API, `crysviz-mlip-models`). They are not committed — 100 MB files
break git/GH-Pages, and even the 17 MB file would bloat the repo for weights that
update upstream. Offline users can supply a local `.gguf` via the file input.

- Repo: https://huggingface.co/peterspackman/mlip-gguf (license: **BSD-3-Clause**)
  - `pet-mad-xs.gguf` — ~16.3 MB (default)
  - `pet-mad-s.gguf`  — ~95.4 MB (option)
  - Base URL: `https://huggingface.co/peterspackman/mlip-gguf/resolve/main/`
    (serves CORS `access-control-allow-origin: *`).
- These are GGUF conversions of the uPET / PET-MAD potentials; the original
  PyTorch weights come from https://huggingface.co/lab-cosmo/upet
  (license: **BSD-3-Clause**).

## Verified runtime conventions (node smoke test, CPU build, PET-MAD-xs)

Established by a node smoke test (`Model.loadFromBufferWithBackend` + `predict` on a
2-atom diamond-Si cell); see the header comment in `mlip_runner.js` for details.

- **positions & forces**: flat, row-major per atom `[x0,y0,z0, x1,y1,z1, …]`
  (central finite-difference `-dE/dx` on atom 1 matched `forces[3]` to ~5e-4 eV/Å).
- **cell**: row-major, rows = lattice vectors `a,b,c` in the same cartesian frame as
  positions, flat `[a0,a1,a2, b0,b1,b2, c0,c1,c2]` (rigid-rotation energy invariance
  held to ~4e-3 eV, while feeding the transpose shifted the energy by ~1.4e-1 eV).
- **stress**: mlip.js@0.1.1 does **not** emit stress for PET-MAD — `predict()`
  returns only `{ energy, forces }` (the string "stress" never appears in the CPU
  glue). `MLIPRunner.compute()` therefore returns a **zero** stress tensor for API
  parity, which makes the relaxer's cell-deformation step a no-op (atoms relax, cell
  stays fixed). If a future mlip build emits stress, its sign vs the repo's
  tension-positive convention must be re-verified against `-dE/dV`.

## Notes / risks

- Single-threaded CPU WASM (~2× slower than native); no COOP/COEP headers required.
- The WebGPU build is young; the app defaults to the `cpu` backend and exposes
  `auto`/`webgpu` as opt-in.
- v0.1.1 is pinned via the sha256 sums above; re-verify conventions on any bump.
