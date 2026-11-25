# mlip_wasm — vendored mlip.js (mlip.cpp) WASM bindings

## What this is

JavaScript/WebAssembly bindings for **mlip.cpp** — a runtime for Machine Learning
Interatomic Potentials (PET, MACE, …). Used here to run **PET-MAD** in the browser
with no native dependencies, as an in-browser calculator alongside the existing NEP
WASM path.

- Upstream repo: https://github.com/peterspackman/mlip.cpp
- Version: **0.1.2** (built from upstream `main` source — see provenance below;
  previously the npm `@peterspackman/mlip.js` 0.1.1 tarball).
- License: **BSD-3-Clause** — kept in this directory as `LICENSE`. See "Licences"
  below for everything else compiled into the builds.

### Licences

What the vendored builds contain, and where each licence text is kept:

| Component | Licence | Text |
|---|---|---|
| mlip.cpp (Peter Spackman) | BSD-3-Clause | `LICENSE` |
| ggml (the ggml authors), incl. tinyBLAS `sgemm.cpp` (Mozilla Foundation) | MIT | `LICENSE-ggml` |
| nlohmann/json 3.11.3 | MIT | `LICENSE-nlohmann-json` |
| emdawnwebgpu (Dawn, `gpu/` only) | BSD-3-Clause; its JS part MIT or UIUC/NCSA | `LICENSE-emdawnwebgpu` |

All are permissive and allow modification and redistribution inside AGPL-3.0
CrysViz, provided these notices travel with the files. The PET-MAD weights are
not vendored: they are downloaded at run time from Hugging Face (BSD-3-Clause,
see "Model weights" below).

Written for CrysViz, and licensed AGPL-3.0 with the rest of CrysViz: the
`crysviz-*.patch` changes to mlip.cpp and ggml, `rebuild.sh`, `mlip_runner.js`,
`canvas_readback.js` and the local edits to `index.browser.js` / `index.d.ts`.
The patches change BSD-3 and MIT code, which those licences permit; the built
`.wasm` files combine both.

`index.browser.js` is the ESM loader; it dynamic-imports `./cpu/mlipcpp_wasm.js`
(single-threaded CPU build), `./cpu-mt/mlipcpp_wasm.js` (CPU build with
pthreads — picked instead of `cpu/` when the page is cross-origin isolated and
`threads !== false`; see "Threads" below) or `./gpu/mlipcpp_wasm.js` (WebGPU +
ASYNCIFY build) depending on the requested backend. The relative `cpu/`,
`cpu-mt/` and `gpu/` layout must be preserved so those dynamic imports resolve,
and each glue `.js` locates its sibling `.wasm` next to it (the pthreads glue
also spawns its worker threads from its own URL).

`mlip_runner.js` (not from upstream — written for this repo) is the ES-module
adapter `MLIPRunner`, mirroring `NEPWasmRunner` from `../nep_wasm/nep_simple.js`.

## Threads (local patch, 2026-10-17)

ggml runs the graph on `n_threads`; upstream hard-codes 1 under Emscripten
(`src/core/backend.cpp`). The `cpu/` and `cpu-mt/` builds here carry a local
patch that makes the count configurable and exposes it through embind:
`getNumThreads()`, `getMaxThreads()` (logical cores, at most 16; 1 on the
single-threaded build), `setNumThreads(n)` (clamped, returns the value
applied, takes effect from the next prediction) and `hasThreads()`. `cpu-mt/`
is linked with `-pthread -sPTHREAD_POOL_SIZE=<min(logical cores, 16)>
-sPTHREAD_POOL_SIZE_STRICT=0`: a worker per thread `getMaxThreads()` allows
is started with the module. (Until 2026-10-29 the pool was 8 workers while
`getMaxThreads()` reported all cores; where a browser reports more than 8 —
Chrome on a 14-core Mac — the threads beyond the pool waited for workers that
could only start once ggml stopped waiting for them, and PET-MAD hung at its
first evaluation.) It needs
SharedArrayBuffer (a cross-origin isolated page: the desktop host and
`tools/devserver.py --coi` send the headers, the static site opts in through
`docs/coi-serviceworker.js`). The default count is `min(cores, 8)`.

Measured (node 22, 4 cores, random-weight PET with the PET-MAD-S/-XS layer
sizes; energies/forces/stress bit-identical between the builds):

| model | atoms | 1 thread | 4 threads |
|-------|-------|----------|-----------|
| xs    | 8     | 117 ms   | 372 ms    |
| xs    | 64    | 607 ms   | 277 ms    |
| s     | 8     | 203 ms   | 94 ms     |
| s     | 64    | 1492 ms  | 694 ms    |

Per-node barriers are expensive in wasm, so threads lose on tiny graphs;
`MLIPRunner` with `threads: 'auto'` therefore times the candidates once per
atom count and keeps the fastest (`_predictCalibrated`).

The `cpu/` build was rebuilt from the same source (plus the thread patch, which
compiles to a no-op without pthreads) so both expose the same bindings; its
numbers are bit-identical to the previous vendored build. `gpu/` is unchanged
and does not have the thread bindings (the runner feature-detects them).

Build: `rebuild.sh` with emcc 4.0.15; `cpu-mt/` adds
`-DCMAKE_C_FLAGS=-pthread -DCMAKE_CXX_FLAGS=-pthread` and the linker flags
above (CMake's FindThreads needs `-DThreads_FOUND=TRUE
-DCMAKE_THREAD_LIBS_INIT=-pthread -DCMAKE_HAVE_THREADS_LIBRARY=1
-DCMAKE_USE_PTHREADS_INIT=1` under emcmake).

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
  (pinned by mlip.cpp `CMakeLists.txt`), built from a local checkout with
  `crysviz-ggml-inplace.patch` and `crysviz-ggml-wasm-sgemm.patch` applied
  (`-DMLIPCPP_GGML_SOURCE_DIR`, `-DGGML_LLAMAFILE=ON`; see "Graph allocator"
  and "Matrix kernel" below)
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

## Graph allocator (local patches, 2026-10-25)

The published PET-MAD GGUFs (`pet-mad-xs.gguf`, `pet-mad-s.gguf`) use the
`pet-graph` architecture, which mlip.cpp runs through `GraphModel`. Upstream
`GraphModel` gives every tensor of the forward + backward graph its own memory
on every prediction (`ggml_backend_alloc_ctx_tensors`, no reuse): a few GB at a
few hundred atoms, beyond the 4 GB wasm limit (the field report: PET-MAD-S
failed at 351 atoms trying to allocate 1.4 GB), plus a fresh zero-filled
buffer per call on WebGPU.

- `crysviz-graph-alloc.patch` (mlip.cpp, `src/runtime/graph_model.{h,cpp}`):
  a persistent `ggml_gallocr` that reuses memory once a tensor is dead,
  reallocating only when the graph grows; the tensors read after compute are
  marked outputs. The capture hook (`predict_with_capture`) keeps the old
  allocation.
- `crysviz-ggml-inplace.patch` (ggml fork, `src/ggml-alloc.c`): the
  allocator's in-place list included `RMS_NORM_BACK`, `SOFT_MAX_BACK`,
  `SILU_BACK` and `ROPE_BACK`. The CPU kernel of `RMS_NORM_BACK` copies `x`
  into dst before reading the incoming gradient, and `SOFT_MAX_BACK`
  overwrites `y` before multiplying by it; the WebGPU backend binds these
  ops' inputs and output separately (a writable binding may not alias a
  read-only one). With memory reuse, `RMS_NORM_BACK` computed in place lost
  its gradient term: energies were right, forces and stress wrong. These ops
  are now never computed in place. (Upstream's own allocation never reused
  memory, so it did not hit this.)

Checked on random-weight PET models exported by mlip.cpp's own
`scripts/export_pytorch/export_pet_gguf.py` at the published sizes (4.4 M
parameters / 16.8 MB like XS: metatrain PET defaults with 3 GNN layers;
25.0 M / 95.3 MB like S: `d_pet` 384, `d_node` 768, `d_head` 384, feed-forward
512) on the CrysViz benchmark cells (YBCO 1×1×1, 2×2×2, 3×3×3), because the
published files were not reachable from the build sandbox:

- energies, forces and stress are bit-identical to the unpatched code
  wherever that ran (native: all six cases; wasm: XS 13/104, S 13 atoms, one
  and four threads), and agree with the native unpatched run to float32
  precision where only the patched wasm runs (forces within 2.3e-5 eV/Å);
- the hand-written `pet` architecture (`PETModel`) is bit-identical before
  and after;
- the WebGPU build is rebuilt with both patches but untested (the sandbox's
  SwiftShader has no `shader-f16`).

wasm, node 22, 4-core sandbox (median per prediction; process peak RSS):

| model | atoms | 1 thread, old | 1 thread, new | 4 threads, old | 4 threads, new |
|-------|------:|--------------:|--------------:|---------------:|---------------:|
| XS    | 13    | 1196 ms, 638 MB  | 665 ms, 361 MB    | 1356 ms, 845 MB  | 1141 ms, 631 MB  |
| XS    | 104   | 4545 ms, 2325 MB | 4877 ms, 652 MB   | 7676 ms, 2534 MB | 1707 ms, 866 MB  |
| XS    | 351   | aborted (OOM)    | 15813 ms, 1339 MB | aborted (OOM)    | 6968 ms, 1543 MB |
| S     | 13    | 2375 ms, 1270 MB | 2177 ms, 945 MB   | 1185 ms, 1603 MB | 845 ms, 1102 MB  |
| S     | 104   | failed (OOM)     | 15303 ms, 1215 MB | failed (OOM)     | 5979 ms, 1564 MB |
| S     | 351   | failed (OOM)     | 51173 ms, 2423 MB | failed (OOM)     | 18810 ms, 2743 MB |

The stand-in models are only size-matched (random weights; exact layer
widths of the published checkpoints unknown), so absolute times on the real
files will differ; the published S failed at 351 atoms, not at 104 as the
stand-in did.

## Adaptive-cutoff forces (local patch, 2026-10-25)

The published models (`pet-mad-xs.gguf`, `pet-mad-s.gguf` on Hugging Face =
upet PET-MAD **v1.5.0**; upet's default is now v1.6.0) choose a cutoff per
atom from its neighbour distances (`pet.num_neighbors_adaptive` 8 / 16). That
choice is computed in C++, outside the model graph, so autograd misses it.
Upstream adds the missing term to the virial (stress) but not to the forces:
energies and stress matched upet, forces did not (up to 0.38 eV/Å on the YBCO
cells, 0.12 eV/Å on a free cluster), and they were not the gradient of the
energy — NVE MD drifted 12–17 meV/atom in 100 fs (104 atoms, 600 K).

`crysviz-adaptive-forces.patch` (`src/runtime/graph_model.cpp`) computes the
per-edge term ∂E/∂r_e = ½ J[e] S[k] r_e / d_e once and adds it to both the
forces and the virial (also for non-periodic systems). Checked against upet
v1.5.0 (PyTorch): forces within 2e-5 eV/Å (13 / 104 / 351 atoms, periodic;
free 13-atom cluster 3e-6), energies identical, stress within 2e-7 eV/Å³;
finite differences of the wasm energy agree; NVE drift ≤ 0.06 meV/atom over
the same 100 fs. See `mlip.cc-bug-report.md` in the repository root.

## WebGPU (local patch, 2026-10-25)

Checked in Node on Dawn (`webgpu` npm package) with Mesa's lavapipe, a
software Vulkan device with `shader-f16`, against the CPU build and the real
PET-MAD-XS:

- `crysviz-ggml-webgpu.patch` (ggml fork, `src/ggml-webgpu/ggml-webgpu.cpp`):
  `GET_ROWS_BACK` zeroed its output with a separate queue submit. That submit
  runs before the kernels already encoded in the current batch (32 per
  submit), and with the graph allocator one of them can be the previous user
  of that memory. Forces were off by up to 2.3 eV/Å on WebGPU since the
  graph-allocator patch. The output is now cleared in the same command encoder
  (`ClearBuffer`, exact byte range). Upstream's allocation (fresh memory per
  call) hid it.
- Same patch: the tiled matrix product (`mul_mat_reg_tile.wgsl`) staged its
  inputs **and accumulated** in f16, also for f32 weights: energies were off by
  2–4 meV/atom and forces by 0.02–0.04 eV/Å against the CPU build (in the
  upstream build too). f32 weights now get f32 tiles and accumulators
  (`SHMEM_SCALAR=f32`, 16 KB workgroup memory, the WebGPU minimum) and skip the
  f16-only subgroup-matrix variant. WebGPU now agrees with the CPU build and
  upet to float precision (forces within 2e-5 eV/Å).
- Same patch, fewer WebGPU calls per kernel (each one crosses into the
  browser's GPU process): bind groups are cached across graph computes (keyed
  by pipeline + buffer ranges; dropped when a buffer is freed), bind group
  layouts per pipeline, one compute pass and one parameter upload per batch
  instead of per kernel, repeated `setPipeline` skipped. PET-MAD-XS, 13
  atoms, per prediction: 566 → 31 `createBindGroup`, 566 → 0
  `getBindGroupLayout`, 603 → 55 `writeBuffer`, 566 → 20 compute passes; time
  inside WebGPU calls in Node/Dawn 45 → 17 ms (browsers pay more per call).
- Same patch: `SOFT_MAX` and `SUM_ROWS` run one workgroup per row and sized
  it to the device maximum (256–1024 threads) even for PET's attention rows
  of ~17 elements; the workgroup now follows the row length (power of two,
  ≥ 32). On lavapipe at 104 atoms `SOFT_MAX` went from 28 % of GPU time
  (2.2 s for 2 calls) to under 1 %, all ops 7.8 → 5.0 s.
- Same patch: a product of one 2D weight matrix with a batched, contiguous
  input runs as a single matrix product over all batches' rows. PET's
  per-atom layers were 104 (atoms) separate products of 16–17 rows or single
  vectors, each filling a fraction of a 64×64 tile. Lavapipe, 104 atoms: all
  ops 5.0 → 3.1 s.
- Overall on lavapipe (PET-MAD-XS, per prediction, this build vs before the
  WebGPU work): 13 atoms 1239 → 472 ms, 104 atoms 6561 → 2038 ms (lavapipe
  runs shaders on the CPU: absolute numbers say nothing about a real GPU).
  Against upet v1.5.0: forces within 2.2e-5 eV/Å, energies within 6e-5 eV.
- Same patch (2026-10-29): `SOFT_MAX` and `SOFT_MAX_BACK` dispatched one
  workgroup per row along x only, and WebGPU allows 65535 per dimension.
  PET-MAD-XS attention has 136 rows per atom, so from ~480 atoms the dispatch
  was invalid and the module aborted after a 30 s map timeout (seen at 832
  atoms in Firefox). Rows past the limit now go to y, and the shaders fold
  y back in. 832 atoms on lavapipe matches the CPU build: same energy, forces
  within 1.7e-5 eV/Å, stress within 7e-8 eV/Å³. Other ops stay under 25 000
  workgroups per dimension up to the 1000-atom PET-MAD limit.
- `crysviz-graph-reuse.patch` (mlip.cpp, `graph_model.{h,cpp}`): the input
  tensors live in one buffer kept across predictions; a new buffer per call
  meant new handles and a missed bind group for every kernel reading an
  input. Steady state now creates no bind groups or buffers per prediction
  (was 31 + 1). CPU results unchanged (bit-identical). On GPU backends the
  neighbour count is also rounded up to a multiple of 8, so MD steps keep
  the same shapes (allocation and bind groups reused; 113 bind groups per
  step before with MD-like moves, now none); padded slots are masked,
  results unchanged.

## Timings (local patch, 2026-10-26)

`crysviz-timings.patch` (mlip.cpp: `graph_model.cpp`, the bindings) adds
`getLastTimings()`: where the last prediction spent its time, in ms. The
fields are neighbour list + inputs, graph build, allocation, graph compute,
reading the results and total. On the WebGPU build it also reports
encoding + submitting, waiting for the GPU and read-backs (counters in
`crysviz-ggml-webgpu.patch`). `MLIPRunner.lastTimings` and the worker pass it
on, and the Debug window's benchmark records it per run (CSV columns
`wasm*Ms`, `gpu*Ms`, `roundTripMs`). It exists to find fixed per-step costs
in a real browser, which Node/Dawn does not reproduce: a user-measured
~500 ms per WebGPU step at 13 atoms stayed after the call-count reductions
above.

## One GPU synchronisation per prediction (local patches, 2026-10-26)

The timings above, measured in a user's browser (PET-MAD-XS, WebGPU, 13 and
104 atoms), put the ~500 ms per step in waiting: about 100 ms per wait for the
GPU, whatever the work. There were four waits per prediction: the graph, then
three separate output reads. Encoding was under 10 ms and the graph build
under 10 ms.

- `crysviz-ggml-webgpu.patch` gives the WebGPU backend `get_tensor_async`
  (records the read) and `synchronize` (copies all pending reads into one
  staging buffer and maps it once; with none pending it waits on the queue).
  Graph compute no longer waits at its end; `ggml_backend_graph_compute`
  still synchronizes right after.
- `crysviz-one-sync.patch` (mlip.cpp, `graph_model.cpp`): compute with
  `ggml_backend_graph_compute_async`, queue the three output reads, synchronize
  once. On the CPU the reads happen at once and synchronize does nothing
  (results bit-identical).

Per prediction now: one `mapAsync`, no `onSubmittedWorkDone`, 4 → 1 waits.
Measured by the user (Firefox 158, macOS, PET-MAD-XS): 13 atoms ~560 → ~208
ms per MD step, 104 atoms ~620 → ~309, 351 atoms ~930 → ~521. The round-trip
probe (Debug → Benchmark) shows why one wait still costs that much there:
a tiny copy + `mapAsync` takes ~104 ms in Firefox (page and worker alike;
0.09 ms on Dawn), i.e. Firefox resolves GPU completion on a ~100 ms timer.
Kernels per submit are now 1024 (was 32): a graph goes out in one submit
plus one for the reads, instead of ~19.

## Canvas readback (local patch + `canvas_readback.js`, 2026-10-29)

A WebGPU canvas snapshot does not wait for that timer. In the user's Firefox
158 (Debug → Benchmark probe), 256 × 128 pixels copied into an
OffscreenCanvas and read back with `drawImage` + `getImageData` came back
exact in 0.8 ms (page) / 1.2 ms (worker). `mapAsync` took 104 ms. Firefox
serves the snapshot with a blocking map in its GPU process
(`WebGPUParent::GetFrontBufferSnapshot`).

- `crysviz-ggml-webgpu.patch`: `synchronize` and `get_tensor` first offer
  their reads to `Module.ggmlWebgpuReadback(device, [{ buffer, offset, size }])`
  (`EM_JS ggml_webgpu_host_readback`, JS GPU objects via
  `WebGPU.getJsObject`). It returns one `Uint8Array` per read, copied into
  wasm memory, or null to decline, in which case ggml maps as before. A hook
  that throws is dropped for good.
- `canvas_readback.js` (installed by `mlip_runner.js` on the gpu variant
  unless `gpuReadback: 'map'`) copies the reads into one buffer and packs them
  3 bytes per pixel with a compute shader: the canvas is opaque, so alpha is
  not kept. It copies the pixels into a 1024-wide canvas texture, snapshots
  it and unpacks.
  On first use it reads known bytes back. If they are blank or wrong (headless
  Chromium snapshots WebGPU canvases blank), it declines from then on.
  The runner first times a tiny `mapAsync` (`mapRoundTripMs`) and declines
  the hook where that takes 20 ms or less (Chrome ~1 ms), so those browsers
  never touch a WebGPU canvas: headless Chromium loses its WebGPU instance
  after such a snapshot.
  `hook.info` / `describe().gpuReadback` / timings `gpuReadback` say which
  path is in use: 'canvas', 'map' or 'pending'.

Verified here: on Dawn (Node), a hook replaying recorded bytes gives
bit-identical energies, forces and stress with no `mapAsync`, and garbage
from the hook changes them. The pack/unpack round trip is byte-exact for
rgba and bgra textures (`tests/gpureadback.test.js`). Without OffscreenCanvas
or with blank snapshots the hook declines and results are unchanged. A
PET-MAD-XS step reads 3.4 KB at 13 atoms and 27 KB at 104 atoms, a few
pixel rows.

Measured by the user (Firefox 158, macOS, PET-MAD-XS, `gpuReadback` canvas):
13 atoms 209 → 200 ms per step, 104 atoms 313 → 259 ms. The wait is no longer
rounded up to Firefox's 100 ms ticks, but ~190 ms per step remain, now spent
waiting for the GPU work itself. Debug → Benchmark's kernel-launch probe
times 512 ggml-like kernels to see whether that is per-kernel cost (a step
launches ~560). It is not: 6–9 µs per launch in Firefox, 2–6 µs in Safari,
3–5 µs in Chrome. The time is GPU execution, and it depends on the browser
on the same Apple GPU. Per step at 13 / 104 / 351 atoms: Chrome 51 / 62 /
116 ms, Safari 172 / 198 ms, Firefox 194 / 244 / ~480 ms.

## Kernel profile (local patch, 2026-10-29)

`crysviz-ggml-webgpu.patch`: with `Module.ggmlWebgpuProfileOps` set, graph
compute submits every kernel on its own, waits for it (through the host
readback hook where present, else the queue), and pushes `{ op, name, ne, ms }`
to `Module.ggmlWebgpuOpProfile`, after three `(wait)` entries that time an
empty wait. `MLIPRunner.setOpProfile` / `takeOpProfile` drive it. Debug →
Benchmark profiles one evaluation per WebGPU potential and cell size where a
wait is quick, and puts the per-op totals in the JSON (`gpuOpProfile`) and
CSV (`gpuProfileTop`). Results are bit-identical with profiling on. On
lavapipe at 13 atoms the largest shares are MUL_MAT (35%) and CONT (28%): 109
copies per step, many of them transposed weight matrices (backward of
MUL_MAT) that are the same every step.

## f32 matrix kernel (local patch, 2026-10-29)

The kernel profile in the user's Firefox (PET-MAD-XS, 13 / 104 / 351 atoms)
put 199 of 227 ms, 239 of 259 ms and 420 of 435 ms of GPU time per step in
`MUL_MAT`: 75 products of ~4.5 ms each, whatever their size (a 128 × 13 product
as slow as a 2048 × 13 one, and as slow at 351 atoms as at 13). Chrome on the
same Apple GPU runs the whole step in 50 ms. The products used upstream's
`mul_mat_reg_tile.wgsl`: an 8 × 8 accumulator array and an 8-element tile per
thread, indexed in loops and passed by value. Firefox's and Safari's WGSL
compilers bound every loop against running forever, which keeps the Metal
compiler from unrolling them, so the arrays likely end up in per-thread
memory: a load and a store per multiply-add. Its 64 × 64 output tiles also
give few workgroups on these narrow matrices (8 for 2048 × 13).

`crysviz-ggml-webgpu.patch` adds `mul_mat_f32_tile4.wgsl` for f32 × f32
products: 64 threads, 32 × 32 output tiles, each thread a 4 × 4 block in four
named `vec4` accumulators, inner loop two `vec4` reads from workgroup memory,
no per-thread arrays. Same parameters, bindings and batching as the reg-tile
kernel. Default; `Module.ggmlWebgpuMatmul = 'reg_tile'` (runner
`gpuMatmul` / `setGpuMatmul`, Debug → Benchmark "PET-MAD WebGPU matrix
kernel") runs the old one for A/B. On Dawn/lavapipe it matches the CPU build
as before (forces within 8e-6 eV/Å; identical to the reg-tile results, same
summation order), all 74 products per step use it, and lavapipe times are
13 atoms 405 → 330 ms, 104 atoms unchanged.

Measured in the user's Firefox (Apple GPU, Debug → Benchmark, both kernels,
canvas readback), PET-MAD-XS ms per MD step at 13 / 104 / 351 atoms: reg-tile
201 / 262 / 514, vec4 tiles 17.7 / 32.8 / 83.4, i.e. 11× / 8× / 6× faster
(56 / 30 / 12 steps per second). The profile's `MUL_MAT` share went from 157
of 162 ms (13 atoms) to about 1 ms. Firefox WebGPU now outruns the CPU build on
all threads from about 100 atoms. Chrome (same Mac, with the faster inputs
of "Inputs" below): XS 47 / 37 / 17 and S 35 / 14 / 5.5 steps per second at
13 / 104 / 351 atoms, 1.2–1.5× Firefox's.

## Transposed weights (local patch, 2026-10-29)

`crysviz-weight-transpose.patch` (mlip.cpp, `graph_model.{h,cpp}`): ggml's
backward of `MUL_MAT` computes the input gradient as
`mul_mat(cont(transpose(W)), grad)`, a transposed copy of every weight matrix
on every prediction: PET-MAD-XS 42 matrices (16 MB), PET-MAD-S 60 (94 MB).
`substitute_weight_transposes` makes those copies once, into a buffer of their
own, with one small copy graph on the compute backend. The `CONT` nodes become
plain tensors on the copies (op `NONE`, data set), which the graph allocator
leaves alone and both backends skip. Results are bit-identical (energies,
forces, stress; CPU and WebGPU, XS at 13 and 104 atoms, S at 13). Measured in
Node: CPU single thread XS 13 atoms 119 → 70 ms, 104 atoms 526 → 515 ms;
S 13 atoms 696 → 531 ms. WebGPU on lavapipe: XS 13 atoms 419 → 379 ms, S
1713 → 1445 ms. Extra memory: the copies, 16 / 94 MB.

## Inputs (local patch, 2026-10-29)

With the vec4 kernel, Firefox at 351 atoms spent 22 ms per step before the
graph (`inputsMs`, the same in Chrome and on the CPU build) and 13 ms after the
GPU wait, out of 83 ms. Timed in Node: the neighbour list 18 ms (45 682 pairs
within PET-MAD's 7.5 Å), the adaptive cutoffs 21–28 ms, and the adaptive
chain rule after the graph 17 ms. Both adaptive loops evaluated every edge's
bump at all 56 probes, though it is 0 or 1 at all but about four of them.

`crysviz-fast-inputs.patch` (mlip.cpp, `neighbor_list.cpp`, `graph_model.cpp`):
the periodic neighbour list computes each atom's bin and in-bin position once
instead of for every candidate pair; `bump_window` finds an edge's few probes
(binary search, one probe of margin each side), the adaptive cutoffs evaluate
those and count the ones; the chain-rule Jacobian ∂cutoff/∂d per edge, which
needs only the inputs, is computed before the sync, i.e. while a GPU runs the
graph. Results are bit-identical (energies, all forces and stresses; XS and S
at 13 / 104 / 351 atoms). Node, 351 atoms: neighbour list 18 → 6 ms,
adaptive cutoffs 21–28 → 10 ms, after the graph 17 → 0.6 ms plus the
Jacobian's 12 ms, which a WebGPU step hides behind the GPU wait.

## Matrix kernel (local patches, 2026-10-25)

Matrix products are about three quarters of a PET-MAD evaluation (callgrind,
native, XS stand-in, 104 atoms), and ggml's CPU backend computed every f32
product as dot products, one output element at a time (`ggml_vec_dot_f32`,
re-reading a whole row of each input per element). ggml carries a blocked
GEMM (llamafile's tinyBLAS, `GGML_LLAMAFILE`) that computes register tiles of
the output, but only for x86 / ARM / POWER / RISC-V.

- `crysviz-ggml-wasm-sgemm.patch` (ggml fork,
  `src/ggml-cpu/llamafile/sgemm.cpp`, `src/ggml-cpu/ggml-cpu.c`):
  - a WebAssembly SIMD128 path for tinyBLAS (4 floats per vector; multiply +
    add rather than FMA, which needs relaxed-simd, not in every browser);
  - `mul_mat` multiplies one 2D weight matrix against all of a contiguous
    src1's rows in one call: per (i12, i13) slice the per-atom layers (one row
    per atom per slice) were matrix–vector products, which the kernel declines;
  - `llamafile_sgemm_disabled`, a runtime switch that makes the kernel decline
    every product, so ggml's own dot-product path runs exactly as before.
- `crysviz-gemm.patch` (mlip.cpp, `src/api/wasm/mlipcpp_wasm.cpp`): the
  embind functions `hasBlockedGemm()`, `getBlockedGemm()`,
  `setBlockedGemm(on)` (from the next prediction). `MLIPRunner({ blockedGemm })`
  / `setBlockedGemm()` (and the worker), `general.mlipBlockedGemm` and the
  Debug window's Benchmark tab ("PET-MAD CPU matrix kernel") use them for A/B
  comparisons; the default is on.

All three builds use `-DGGML_LLAMAFILE=ON` (rebuild.sh). Numerics: with the
switch off a build gives bit-identical results to the previous one; on and
off differ by float32 rounding (summation order), forces within 1e-6 eV/Å
on the stand-in models.

The attention products over a neighbour list still go the dot-product way
(their token count, neighbours + 1 = 35 on the benchmark cell, is not a
multiple of 4). Padding the token count to a multiple of 4 was tried — the
padded slots masked like those of an atom with fewer neighbours, results
unchanged — and gained 0–4 %, so it is not applied.

`index.browser.js` carries the `threads` option and the `cpu-mt/` selection
(no longer byte-identical to upstream's loader), and the thread patch above is
applied to `src/core/backend.cpp` and `src/api/wasm/mlipcpp_wasm.cpp`.

`index.d.ts` carries local additions on top of the upstream-generated one:
embind `delete()` methods, `predictWithActivations` (new upstream export,
unused here), and doc comments noting that `forces`/`stress` are actually
`Float32Array` at runtime (they stay declared as `Float64Array` to match
upstream's d.ts and `mlip_runner.js`'s type expectations — element access is
interchangeable). `index.browser.d.ts` is a local tsc boundary stub (see its
header comment).

## sha256

```
745adf2e89bcd695b21e7e533dd23f09d0c2fe590d03194edaa907d05a5ab686  index.browser.js
d00e1e400fdd10c6b756815256aae4162ec9a15e9a9d59de28eb73e5a7fc23f7  index.browser.d.ts
2981f287c783a97ca0640618d7e2812e1560b080068044840e76f9993f51598a  index.d.ts
951880c4c0fc05699dcfc33ac9054f6b84195ff505b5021a29503633c39dc97f  LICENSE
fde397177eaf3056619a7ea60ec7e97459c4f4e520d70a5a48d1b8260ca38b11  cpu/mlipcpp_wasm.js
958c033484284c01dbb35bbbc3f1d3e082322567d70341eb4317b871bb0bd8af  cpu/mlipcpp_wasm.wasm
b7d2f11dd29e054d73fb0c0d5d17b41b65a424b23ee2772fac5c89448a3843c3  cpu-mt/mlipcpp_wasm.js
90874276f750dc44cae3a4b283458e6bdd48b90a0bc5f8523503ee06f5896c80  cpu-mt/mlipcpp_wasm.wasm
3ac0b78cd02592a2b244c3d8b55a161c3c76cfa441bdc5e8adf5b97d2ce6e319  gpu/mlipcpp_wasm.js
ac79f890874b39b2dc2f4d54fd1d71631a201f89a9b223563b47a84763a78d76  gpu/mlipcpp_wasm.wasm
```

The three `.wasm` files had the build workspace path in their source-file
names (ggml assertion messages) overwritten after the build with
`/mlip-build/./././…` of the same length; nothing else changed. `rebuild.sh`
now maps the workspace to `/mlip-build` itself (`-ffile-prefix-map`) and stops
if a path is left.

Sizes: `cpu/mlipcpp_wasm.js` 105111 B, `cpu/mlipcpp_wasm.wasm` 1321309 B,
`cpu-mt/mlipcpp_wasm.js` 121962 B, `cpu-mt/mlipcpp_wasm.wasm` 1337971 B,
`gpu/mlipcpp_wasm.js` 159635 B, `gpu/mlipcpp_wasm.wasm` 3179464 B.

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

## Custom and fine-tuned models (exporter patch, 2026-11-01)

Any PET model that mlip.cpp's exporter turns into a `pet-graph` GGUF runs in
CrysViz: the graph and weights travel in the file, so a fine-tuned model needs
no change to the wasm. Load it with **local .gguf**, or put its URL in the
model list. Upstream, the exporter (`scripts/export_pytorch/export_pet_gguf.py`)
only resolves uPET names from Hugging Face; `crysviz-export-checkpoint.patch`
(applied by hand, not by `rebuild.sh`, since the wasm does not use it) makes
it:

- take a local metatrain checkpoint: `--model path/to/model.ckpt`;
- fold LoRA adapters into the weights they wrap (W + scaling · B·A) before
  export. The graph and weight names are then those of the base model, so a
  LoRA fine-tune runs exactly as fast as the base model. Unmerged, LoRA weight
  names are longer than ggml's 64-character tensor-name limit and the file
  does not load;
- write a description into the file: `--name`, `--description`, `--license`,
  `--author`, `--url`, `--version`, `--base-model` (GGUF `general.*` keys)
  and `--training-elements` (`pet.training_species`). CrysViz shows these for
  a model loaded from a file or a link, and `tools/pet_catalogue/make_entry.py`
  turns them into a catalogue entry. mlip.cpp ignores them; the numbers are
  unchanged.

Catalogues of such models, hosted anywhere, and how to make one:
`tools/pet_catalogue/README.md`.

```bash
cd mlip.cpp && git apply /path/to/crysviz-export-checkpoint.patch
python scripts/export_pytorch/export_pet_gguf.py --model finetuned.ckpt -o finetuned-xs.gguf
```

Checked by fine-tuning PET-MAD-XS v1.5.0 (metatrain 2026.2.1, 3 epochs on 32
EMT-labelled Cu/Ni cells) with `method: full` and `method: lora` (rank 4).
On a 32-atom Ni cell, metatomic/PyTorch vs mlip.cpp:

| model | ΔE (eV) | max \|ΔF\| (eV/Å) |
|---|---|---|
| base v1.5.0 (via `--model` checkpoint) | 5e-10 | 3e-6 |
| full fine-tune | 5e-5 | 1e-5 (browser worker: 1.3e-5) |
| LoRA fine-tune | 3e-10 | 3e-5 (browser worker: 1.8e-5) |

The base checkpoint converted this way reproduces the Hugging Face
`pet-mad-xs.gguf` above to the last printed digit. A full fine-tune refits the
per-element energies, which travel in the file (`pet.composition_*`), so its
total energies are on the fine-tuning data's reference, not PET-MAD's.
Without `--name`, `general.name` is the checkpoint's file name.

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

- The `cpu/` build is single-threaded (~2× slower than native) and needs no
  COOP/COEP headers; `cpu-mt/` needs them (see "Threads").
- The WebGPU build is young; the app defaults to the `cpu` backend and exposes
  `auto`/`webgpu` as opt-in. The GPU glue was import-sanity-checked in Node only
  (no WebGPU there) — browser-verify before relying on it.
- This build is pinned via the sha256 sums above; re-verify conventions on any bump,
  and re-check whether the local `compute_stress` patch is still needed.
