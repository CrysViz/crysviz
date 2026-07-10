# mlip_wasm — vendored mlip.js (mlip.cpp) WASM bindings

## What this is

JavaScript/WebAssembly bindings for **mlip.cpp** — a runtime for Machine Learning
Interatomic Potentials (PET, MACE, …). Used here to run **PET-MAD** in the browser
with no native dependencies, as an in-browser calculator alongside the existing NEP
WASM path.

- Upstream repo: https://github.com/peterspackman/mlip.cpp
- Version: **0.1.2** (built from upstream `main` source — see provenance below;
  previously the npm `@peterspackman/mlip.js` 0.1.1 tarball).
- License: **BSD-3-Clause** — kept in this directory as `LICENSE`.

`index.browser.js` is the ESM loader; it dynamic-imports `./cpu/mlipcpp_wasm.js`
(single-threaded CPU build) or `./gpu/mlipcpp_wasm.js` (WebGPU + ASYNCIFY build)
depending on the requested backend. The relative `cpu/` and `gpu/` layout must be
preserved so those dynamic imports resolve, and each glue `.js` locates its sibling
`.wasm` next to it.

`mlip_runner.js` (not from upstream — written for this repo) is the ES-module
adapter `MLIPRunner`, mirroring `NEPWasmRunner` from `../nep_wasm/nep_simple.js`.

## Source (built from mlip.cpp source, 2026-07-04)

Rebuilt from source to pick up two post-0.1.1 upstream fixes:

1. **WebGPU dispatch splitting** (ggml fork rev `9be7b7f8`,
   `compute_2d_workgroups` in `src/ggml-webgpu/ggml-webgpu.cpp`) — fixes the
   field-reported `Each current dispatch group size dimension ([66080, 1, 1])
   must be less or equal to 65535` device error on larger systems. The 0.1.1
   npm build pinned an older ggml (`6e5a7f0e34cc…`) without it.
2. **PET adaptive cutoff + chain-rule stress correction / virial stress**
   (upstream commits `4bffcf8`, `72b2d73`) — 0.1.1 emitted no stress and its
   energies deviated from the reference upet implementation.

Provenance:

- mlip.cpp commit: `35fb4b049eae4a975712121a995288c91102b8ed` (upstream `main`)
- ggml fork: `peterspackman/ggml` @ `9be7b7f82242e487a59df8b63efa412b7aac161d`
  (pinned by mlip.cpp `CMakeLists.txt`, fetched via CPM at configure time)
- Emscripten: emcc **4.0.15** (09f52557f0d48b65b8c724853ed8f4e8bf80e669)
- Build (per upstream `scripts/build_wasm.sh`, CMake Release, Ninja):
  - `cpu/`: `./scripts/build_wasm.sh` (no flags — single-threaded, no WebGPU)
  - `gpu/`: `./scripts/build_wasm.sh --webgpu --asyncify` (WebGPU via
    emdawnwebgpu, ASYNCIFY rather than JSPI for broader browser compat —
    same as 0.1.1 shipped)
- WASM memory (both variants): initial 16 MB, **max 4096 MB**, non-shared
  (unchanged vs 0.1.1).
- `index.browser.js` / layout assembled with upstream
  `packages/mlip.js/scripts/build.js` (loader byte-identical to 0.1.1).
- **Local patch** applied before building (upstream unpatched builds emit no
  stress because the embind wrapper never requests it — its `has_stress()`
  branch is dead code). In `src/api/wasm/mlipcpp_wasm.cpp`,
  `PredictorWrapper::predictWithOptions`:

  ```cpp
  options.compute_stress = system.isPeriodic();
  ```

  Not upstreamed at build time; re-check on the next rebuild whether upstream
  has fixed this and drop the patch.

`index.d.ts` carries local additions on top of the upstream-generated one:
embind `delete()` methods, `predictWithActivations` (new upstream export,
unused here), and doc comments noting that `forces`/`stress` are actually
`Float32Array` at runtime (they stay declared as `Float64Array` to match
upstream's d.ts and `mlip_runner.js`'s type expectations — element access is
interchangeable). `index.browser.d.ts` is a local tsc boundary stub (see its
header comment).

## sha256

```
a24d32b6d7ad237a7c4ee24a9e3c50e7052a6c40a7b0b9cbbf634b0898764988  index.browser.js
d00e1e400fdd10c6b756815256aae4162ec9a15e9a9d59de28eb73e5a7fc23f7  index.browser.d.ts
85336c7788dc2a227b95222bbfb913dc060e65d9b7f22453a228705290e6f507  index.d.ts
951880c4c0fc05699dcfc33ac9054f6b84195ff505b5021a29503633c39dc97f  LICENSE
c9f5cf052e36637a4e304e47b2b6bb8ed17133e500668140b42a864f6cfcb87d  cpu/mlipcpp_wasm.js
8f18236e51e96431c7ebd01e9e8bc9192f7618e7a0936cab33322869d519d238  cpu/mlipcpp_wasm.wasm
163581115ebb3a68af3ddea3d25a32d53cab7a281412a6c7e4839c1f0527886a  gpu/mlipcpp_wasm.js
85c9979a2e5275b22da5e7710d6211a5b85f1d8bf6dc81095a2ed15898d461c3  gpu/mlipcpp_wasm.wasm
```

Sizes: `cpu/mlipcpp_wasm.js` 105111 B, `cpu/mlipcpp_wasm.wasm` 1294600 B,
`gpu/mlipcpp_wasm.js` 157446 B, `gpu/mlipcpp_wasm.wasm` 3110453 B.

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

Established by a node smoke test (`Model.loadFromBufferWithBackend` + `predict`,
2-atom diamond-Si primitive fcc cell, a=5.43 Å); model reports `PET-Graph`,
cutoff 7.5 Å (unchanged vs 0.1.1).

- **positions & forces**: flat, row-major per atom `[x0,y0,z0, x1,y1,z1, …]`
  (central finite-difference `-dE/dx`, ±1e-3 Å, matched `forces[3]` to 4.2e-4 eV/Å
  at the ideal cell and 7.0e-4 eV/Å at a +0.1 Å off-equilibrium displacement).
- **cell**: row-major, rows = lattice vectors `a,b,c` in the same cartesian frame as
  positions, flat `[a0,a1,a2, b0,b1,b2, c0,c1,c2]` (convention verified for 0.1.1;
  binding signature unchanged).
- **energies shifted vs 0.1.1** (adaptive cutoff, upstream `72b2d73` — "brings
  energies, forces, and virial stress into f32 agreement with upet"): diamond-Si
  primitive cell now −5.8932 eV/atom (0.1.1: −5.0075) with near-zero forces and
  ~0.2 GPa residual pressure — physically consistent, unlike 0.1.1 which gave
  ~−18 GPa at the same geometry. The old sparse-cubic-cell smoke reference
  −2.7207 eV/atom now evaluates to −2.8524. Treat 0.1.1 energies as superseded,
  not as a regression baseline.
- **stress**: `predict()` now returns a 6-component **Float32Array Voigt**
  `[xx, yy, zz, yz, xz, xy]` in **eV/Å³** for periodic systems (via the local
  `compute_stress` patch above; absent for non-periodic systems). Sign
  convention verified against `-dE/dV` under ±0.2 % isotropic strain:
  **tension-positive**, `P = -tr(σ)/3` (matched `-dE/dV` to 2.4e-6 eV/Å³) —
  i.e. **the same convention as the repo's NEP path**, so
  `MLIPRunner.compute()`'s stress passthrough and the relaxer's
  cell-deformation step work unchanged.

## Notes / risks

- Single-threaded CPU WASM (~2× slower than native); no COOP/COEP headers required.
- The WebGPU build is young; the app defaults to the `cpu` backend and exposes
  `auto`/`webgpu` as opt-in. The GPU glue was import-sanity-checked in Node only
  (no WebGPU there) — browser-verify before relying on it.
- This build is pinned via the sha256 sums above; re-verify conventions on any bump,
  and re-check whether the local `compute_stress` patch is still needed.
