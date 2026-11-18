#!/usr/bin/env bash
# Rebuild the vendored mlip.js WASM artifacts from mlip.cpp source.
#
# Prereqs: emsdk activated (emcmake on PATH), cmake, ninja, node, git.
# Usage:
#   ./rebuild.sh [git-ref]          # default: main
# Env:
#   WORK=/path                      # build workspace (default: mktemp -d;
#                                   #   use /dev/shm when the disk is tight)
#   MODEL=/path/pet-mad-xs.gguf     # enables the post-build smoke test
#
# After a successful run: merge index.d.ts.upstream into index.d.ts by hand
# (ours carries local doc additions), paste the printed sha256 list + commit
# sha + emcc version into README.md, run `make check`, and browser-verify.
set -euo pipefail

REF=${1:-main}
DEST="$(cd "$(dirname "$0")" && pwd)"
WORK=${WORK:-$(mktemp -d)}

command -v emcmake >/dev/null || { echo "emcmake not found — source emsdk_env.sh first"; exit 1; }

echo "== workspace: $WORK"
[ -d "$WORK/mlip.cpp" ] || git clone --depth 1 --branch "$REF" \
    https://github.com/peterspackman/mlip.cpp.git "$WORK/mlip.cpp"
cd "$WORK/mlip.cpp"
echo "== mlip.cpp commit: $(git rev-parse HEAD)"

# --- local thread patch (also carries the compute_stress line) -------------
# Configurable ggml CPU thread count + getNumThreads/getMaxThreads/
# setNumThreads/hasThreads bindings; see README "Threads".
if grep -q 'set_wasm_cpu_threads' src/core/backend.cpp; then
    echo "== thread patch already applied"
else
    git apply "$DEST/crysviz-threads.patch" || { echo "!! thread patch failed — rebase crysviz-threads.patch"; exit 1; }
    echo "== applied thread patch"
fi

# --- local stress patch --------------------------------------------------
# Upstream's embind wrapper never sets compute_stress, so its has_stress()
# output branch is dead code and predict() emits no stress. Drop this block
# once upstream sets it themselves (the grep below detects that).
BIND=src/api/wasm/mlipcpp_wasm.cpp
if grep -q 'options.compute_stress' "$BIND"; then
    echo "== upstream already sets compute_stress — patch skipped"
else
    sed -i -E 's/^([[:space:]]*)options\.compute_forces = true;/\1options.compute_forces = true;\n\1options.compute_stress = system.isPeriodic();/' "$BIND"
    grep -q 'compute_stress = system.isPeriodic' "$BIND" || { echo "!! patch failed — check $BIND"; exit 1; }
    echo "== applied compute_stress patch"
fi

# --- local graph allocator patch -----------------------------------------
# GraphModel (the architecture of the published pet-graph GGUFs) gave every
# tensor of the forward + backward graph its own memory on every prediction:
# GBs at a few hundred atoms (the 4 GB wasm limit), and a fresh zero-filled
# buffer per call on WebGPU. A persistent ggml_gallocr reuses memory; see
# README "Graph allocator".
if grep -q 'compute_galloc_' src/runtime/graph_model.h; then
    echo "== graph allocator patch already applied"
else
    git apply "$DEST/crysviz-graph-alloc.patch" || { echo "!! graph allocator patch failed — rebase crysviz-graph-alloc.patch"; exit 1; }
    echo "== applied graph allocator patch"
fi

# --- local adaptive-cutoff forces patch ---------------------------------------
# The published models pick per-atom cutoffs from the neighbour distances (in
# C++, outside the model graph). Upstream adds that dependence to the virial
# but not to the forces, which were then not the gradient of the energy (off
# by up to 0.4 eV/Å from upet on YBCO); see README "Adaptive-cutoff forces".
if grep -q 'adaptive_coef' src/runtime/graph_model.cpp; then
    echo "== adaptive-cutoff forces patch already applied"
else
    git apply "$DEST/crysviz-adaptive-forces.patch" || { echo "!! adaptive-cutoff forces patch failed — rebase crysviz-adaptive-forces.patch"; exit 1; }
    echo "== applied adaptive-cutoff forces patch"
fi

# --- local graph reuse patch ---------------------------------------------------
# GraphModel's inputs live in one buffer kept across predictions (a new one per
# call gave new buffer handles, defeating ggml-webgpu's bind group cache), and
# on GPU backends the neighbour count is rounded up to a multiple of 8 so MD
# steps keep the same tensor shapes.
if grep -q 'input_buffer_' src/runtime/graph_model.h; then
    echo "== graph reuse patch already applied"
else
    git apply "$DEST/crysviz-graph-reuse.patch" || { echo "!! graph reuse patch failed — rebase crysviz-graph-reuse.patch"; exit 1; }
    echo "== applied graph reuse patch"
fi

# --- ggml: backward ops not computed in place ------------------------------
# The ggml fork's allocator may compute RMS_NORM_BACK / SOFT_MAX_BACK /
# SILU_BACK / ROPE_BACK in place, which their CPU kernels and WebGPU bindings
# do not support. With the graph allocator that corrupted forces and stress,
# so build against a checkout of the pinned fork commit with those ops off its
# in-place list.
GGML_TAG=$(grep -A2 'GITHUB_REPOSITORY peterspackman/ggml' CMakeLists.txt | sed -n 's/.*GIT_TAG *\([0-9a-f]*\).*/\1/p')
[ -n "$GGML_TAG" ] || { echo "!! ggml GIT_TAG not found in CMakeLists.txt"; exit 1; }
[ -d "$WORK/ggml" ] || git clone https://github.com/peterspackman/ggml.git "$WORK/ggml"
if grep -q 'Not in place: the CPU kernels' "$WORK/ggml/src/ggml-alloc.c"; then
    echo "== ggml in-place patch already applied"
else
    git -C "$WORK/ggml" checkout -q "$GGML_TAG"
    git -C "$WORK/ggml" apply "$DEST/crysviz-ggml-inplace.patch" || { echo "!! ggml patch failed — rebase crysviz-ggml-inplace.patch"; exit 1; }
    echo "== applied ggml in-place patch (ggml $GGML_TAG)"
fi

# --- ggml: blocked matrix products in WebAssembly ----------------------------
# ggml's CPU backend multiplies f32 matrices row by row with dot products;
# its blocked tinyBLAS GEMM (GGML_LLAMAFILE) has x86/ARM/PPC/RISC-V paths only.
# This patch adds a WebAssembly SIMD path, multiplies a weight matrix against
# all atoms' rows in one call, and adds a runtime off switch
# (crysviz-gemm.patch binds it as setBlockedGemm); see README "Matrix kernel".
if grep -q 'llamafile_sgemm_disabled' "$WORK/ggml/src/ggml-cpu/llamafile/sgemm.cpp"; then
    echo "== ggml wasm GEMM patch already applied"
else
    git -C "$WORK/ggml" apply "$DEST/crysviz-ggml-wasm-sgemm.patch" || { echo "!! ggml GEMM patch failed — rebase crysviz-ggml-wasm-sgemm.patch"; exit 1; }
    echo "== applied ggml wasm GEMM patch"
fi
# --- ggml: WebGPU fixes ------------------------------------------------------
# GET_ROWS_BACK zeroed its output with a separate submit, which runs before the
# kernels already encoded in the current batch; with memory reuse one of them
# can be the previous user of that memory (forces off by up to 2 eV/Å on
# WebGPU). See README "WebGPU".
if grep -q 'encoder.ClearBuffer(ggml_webgpu_tensor_buf(dst)' "$WORK/ggml/src/ggml-webgpu/ggml-webgpu.cpp"; then
    echo "== ggml WebGPU patch already applied"
else
    git -C "$WORK/ggml" apply "$DEST/crysviz-ggml-webgpu.patch" || { echo "!! ggml WebGPU patch failed — rebase crysviz-ggml-webgpu.patch"; exit 1; }
    echo "== applied ggml WebGPU patch"
fi
if grep -q 'setBlockedGemm' "$BIND"; then
    echo "== GEMM switch patch already applied"
else
    git apply "$DEST/crysviz-gemm.patch" || { echo "!! GEMM switch patch failed — rebase crysviz-gemm.patch"; exit 1; }
    echo "== applied GEMM switch patch"
fi
# --- local timings patch -------------------------------------------------------
# getLastTimings(): where the last prediction spent its time (phases; on WebGPU
# encode / wait / read-back, counted by the ggml WebGPU patch). Applied last:
# it extends the bindings the GEMM switch patch adds to.
if grep -q 'getLastTimings' "$BIND"; then
    echo "== timings patch already applied"
else
    git apply "$DEST/crysviz-timings.patch" || { echo "!! timings patch failed — rebase crysviz-timings.patch"; exit 1; }
    echo "== applied timings patch"
fi
# --- local one-sync patch ------------------------------------------------------
# GraphModel computes the graph asynchronously and queues its three output
# reads, then synchronizes once (ggml WebGPU patch: get_tensor_async +
# synchronize): each wait for a GPU costs a browser round trip (~100 ms
# measured), four per prediction before.
if grep -q 'ggml_backend_graph_compute_async(compute_backend_' src/runtime/graph_model.cpp; then
    echo "== one-sync patch already applied"
else
    git apply "$DEST/crysviz-one-sync.patch" || { echo "!! one-sync patch failed — rebase crysviz-one-sync.patch"; exit 1; }
    echo "== applied one-sync patch"
fi
# --- local weight-transpose patch ----------------------------------------------
# ggml's backward of MUL_MAT transposes every weight matrix on every prediction
# (PET-MAD-XS 16 MB, PET-MAD-S 94 MB); GraphModel now makes those copies once
# and the backward graph reads them. Results bit-identical; see README
# "Transposed weights".
if grep -q 'substitute_weight_transposes' src/runtime/graph_model.cpp; then
    echo "== weight-transpose patch already applied"
else
    git apply "$DEST/crysviz-weight-transpose.patch" || { echo "!! weight-transpose patch failed — rebase crysviz-weight-transpose.patch"; exit 1; }
    echo "== applied weight-transpose patch"
fi
# --- local fast-inputs patch ---------------------------------------------------
# The neighbour list computes each atom's bin once, and the adaptive cutoffs
# evaluate each edge's bump only at the few probes where it is neither 0 nor 1
# (it was every probe: 56 x ~130 edges per atom). The chain-rule Jacobian is
# computed before the sync, while a GPU runs the graph. Results bit-identical;
# see README "Inputs".
if grep -q 'bump_window' src/runtime/graph_model.cpp; then
    echo "== fast-inputs patch already applied"
else
    git apply "$DEST/crysviz-fast-inputs.patch" || { echo "!! fast-inputs patch failed — rebase crysviz-fast-inputs.patch"; exit 1; }
    echo "== applied fast-inputs patch"
fi
GGML_OPTS=("-DMLIPCPP_GGML_SOURCE_DIR=$WORK/ggml" -DGGML_LLAMAFILE=ON)
# build_wasm.sh takes no extra CMake options: seed each build dir's cache.
for dir in wasm-cpu wasm-gpu; do emcmake cmake . -B"$dir" -GNinja "${GGML_OPTS[@]}" > /dev/null; done

# --- build both variants -------------------------------------------------
# Build dirs are the ones packages/mlip.js/scripts/build.js expects.
# GPU uses ASYNCIFY (not JSPI) for broader browser compat — same as the
# variant npm 0.1.1 shipped.
BUILD_DIR=wasm-cpu bash scripts/build_wasm.sh
BUILD_DIR=wasm-gpu bash scripts/build_wasm.sh --webgpu --asyncify
# Threaded CPU variant (cpu-mt/): pthreads + SharedArrayBuffer. emcmake's
# FindThreads probe fails for wasm, so the result is supplied by hand. The
# worker pool is started at load with min(logical cores, 16) workers, the
# most threads getMaxThreads() allows (crysviz-threads.patch): ggml cannot
# wait for a worker started on demand (deadlock). A ternary, not
# Math.min(a,b): emcc may split -s values at commas.
emcmake cmake . -Bwasm-mt -DCMAKE_BUILD_TYPE=Release -DMLIPCPP_USE_WEBGPU=OFF \
    -DMLIPCPP_WASM_ASYNCIFY=OFF -GNinja \
    -DCMAKE_C_FLAGS=-pthread -DCMAKE_CXX_FLAGS=-pthread \
    -DCMAKE_EXE_LINKER_FLAGS="-pthread '-sPTHREAD_POOL_SIZE=(navigator.hardwareConcurrency>16?16:navigator.hardwareConcurrency)' -sPTHREAD_POOL_SIZE_STRICT=0" \
    -DTHREADS_PREFER_PTHREAD_FLAG=ON -DCMAKE_THREAD_LIBS_INIT=-pthread \
    -DCMAKE_HAVE_THREADS_LIBRARY=1 -DCMAKE_USE_PTHREADS_INIT=1 -DThreads_FOUND=TRUE \
    "${GGML_OPTS[@]}"
cmake --build wasm-mt --target mlipcpp_wasm

# --- assemble the npm-style dist/ layout ----------------------------------
node packages/mlip.js/scripts/build.js

# --- vendor into this directory -------------------------------------------
DIST=packages/mlip.js/dist
# index.browser.js: ours carries local changes, see below.
mkdir -p "$DEST/cpu" "$DEST/gpu"
cp "$DIST/cpu/mlipcpp_wasm.js" "$DIST/cpu/mlipcpp_wasm.wasm" "$DEST/cpu/"
cp "$DIST/gpu/mlipcpp_wasm.js" "$DIST/gpu/mlipcpp_wasm.wasm" "$DEST/gpu/"
mkdir -p "$DEST/cpu-mt"
cp wasm-mt/bin/mlipcpp_wasm.js wasm-mt/bin/mlipcpp_wasm.wasm "$DEST/cpu-mt/"
chmod 644 "$DEST/cpu-mt/mlipcpp_wasm.wasm"
# index.browser.js has the local `threads`/cpu-mt selection — keep ours and
# diff against upstream's by hand.
cp "$DIST/index.browser.js" "$DEST/index.browser.js.upstream"
# index.d.ts has local doc additions — dropped next to it for manual merge.
cp "$DIST/index.d.ts" "$DEST/index.d.ts.upstream"

echo "== sha256 (paste into README.md):"
(cd "$DEST" && sha256sum index.browser.js index.browser.d.ts index.d.ts LICENSE \
    cpu/mlipcpp_wasm.js cpu/mlipcpp_wasm.wasm cpu-mt/mlipcpp_wasm.js cpu-mt/mlipcpp_wasm.wasm \
    gpu/mlipcpp_wasm.js gpu/mlipcpp_wasm.wasm)

# --- smoke test: energy + stress sanity on 2-atom diamond Si --------------
if [[ -n "${MODEL:-}" && -f "$MODEL" ]]; then
    node --input-type=module - "$DEST" "$MODEL" <<'EOF'
import { readFileSync } from 'node:fs';
const [dest, model] = process.argv.slice(2);
const { default: createMlipcpp } = await import(`${dest}/index.browser.js`);
const M = await createMlipcpp({ backend: 'cpu' });
const buf = readFileSync(model);
const m = await M.Model.loadFromBufferWithBackend(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'cpu');
const a = 5.43;
const cell = new Float64Array([0, a / 2, a / 2, a / 2, 0, a / 2, a / 2, a / 2, 0]);
const pos = new Float64Array([0, 0, 0, a / 4, a / 4, a / 4]);
const sys = await M.AtomicSystem.create(pos, Int32Array.from([14, 14]), cell, true);
const r = await m.predict(sys);
const epa = r.energy / 2;
const stressOK = r.stress && r.stress.length === 6 && [...r.stress].some((x) => x !== 0);
console.log(`smoke: E/atom=${epa.toFixed(4)} eV (expect ~-5.89), stress ${stressOK ? 'present' : 'MISSING'}`);
if (Math.abs(epa + 5.89) > 0.05 || !stressOK) { console.error('SMOKE TEST FAILED'); process.exit(1); }
console.log('smoke: OK');
EOF
else
    echo "== smoke test skipped (set MODEL=/path/pet-mad-xs.gguf to enable)"
fi

echo "== done. Remaining manual steps: merge index.d.ts.upstream, update README"
echo "   (commit sha above, emcc: $(emcc --version | head -1)), make check, browser-verify."
