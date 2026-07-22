#!/usr/bin/env bash
# Rebuild the vendored NEP wasm module from the PyNEP / NEP_CPU sources.
#
#   PYNEP_DIR=/path/to/PyNEP EMSDK_DIR=/path/to/emsdk ./rebuild.sh
#
# Flags match PyNEP's own wasm/build_wasm.sh, plus ENVIRONMENT=...,worker so the
# module can also be instantiated inside docs/workers/nepWorker.js.
#
# Two things NOT to waste time re-discovering (both measured on an i7-8550U,
# NEP89, 1331 atoms — see ../../../MD_improvements.md):
#
#   -msimd128        No effect whatsoever (833 ms vs 807 ms, i.e. noise). NEP's
#                    inner loops do not auto-vectorise. Left out.
#
#   -fopenmp         Does not compile: Emscripten ships no omp.h. This is why
#                    NEP_CPU's three `#pragma omp parallel for` are dead in every
#                    wasm build — they are guarded by `#if defined(_OPENMP)`.
#                    Rewriting them into a std::thread fan-out does work and is
#                    where the remaining ~4x lives, but threads need
#                    SharedArrayBuffer, which needs COOP/COEP headers, which
#                    GitHub Pages cannot send. Since this app is hosted there,
#                    that route is closed — do not re-open it without changing
#                    hosting first.
#
# Licensing: the NEP implementation is GPL-3.0 (LICENSE-NEP_CPU), the NEP89
# weights are GPL-3.0 (LICENSE-GPUMD). Both licenses are kept in this directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYNEP_DIR="${PYNEP_DIR:-$HERE/../../../../compiled_stuff/PyNEP}"
EMSDK_DIR="${EMSDK_DIR:-$HERE/../../../../../standalone/devel/spglib_transpile/emsdk}"

[ -f "$PYNEP_DIR/nep_cpu/src/nep.cpp" ] || { echo "no nep.cpp under PYNEP_DIR=$PYNEP_DIR" >&2; exit 1; }
[ -f "$EMSDK_DIR/emsdk_env.sh" ] || { echo "no emsdk_env.sh under EMSDK_DIR=$EMSDK_DIR" >&2; exit 1; }

# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1

emcc -O3 -std=c++17 \
  "$PYNEP_DIR/nep_cpu/src/nep.cpp" \
  "$PYNEP_DIR/wasm/nep_wasm.cpp" \
  -I"$PYNEP_DIR/nep_cpu/src" \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="NEPModule" \
  -s EXPORTED_FUNCTIONS="['_malloc','_free','_nep_create','_nep_destroy','_nep_set_atoms','_nep_compute','_nep_total_energy','_nep_get_forces','_nep_get_virial']" \
  -s EXPORTED_RUNTIME_METHODS="['cwrap','ccall','FS','stringToUTF8','lengthBytesUTF8']" \
  -s EXPORT_ALL=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s FORCE_FILESYSTEM=1 \
  -s ENVIRONMENT=web,node,worker \
  -o "$HERE/nep_wasm.js"

echo "built $HERE/nep_wasm.js and $HERE/nep_wasm.wasm"
echo "re-run tools/browsertest/run.sh tests/nepscaling.bench.js to check for regressions"
