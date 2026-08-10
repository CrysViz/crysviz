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

# --- build both variants -------------------------------------------------
# Build dirs are the ones packages/mlip.js/scripts/build.js expects.
# GPU uses ASYNCIFY (not JSPI) for broader browser compat — same as the
# variant npm 0.1.1 shipped.
BUILD_DIR=wasm-cpu bash scripts/build_wasm.sh
BUILD_DIR=wasm-gpu bash scripts/build_wasm.sh --webgpu --asyncify

# --- assemble the npm-style dist/ layout ----------------------------------
node packages/mlip.js/scripts/build.js

# --- vendor into this directory -------------------------------------------
DIST=packages/mlip.js/dist
cp "$DIST/index.browser.js" "$DEST/"
mkdir -p "$DEST/cpu" "$DEST/gpu"
cp "$DIST/cpu/mlipcpp_wasm.js" "$DIST/cpu/mlipcpp_wasm.wasm" "$DEST/cpu/"
cp "$DIST/gpu/mlipcpp_wasm.js" "$DIST/gpu/mlipcpp_wasm.wasm" "$DEST/gpu/"
# index.d.ts has local doc additions — dropped next to it for manual merge.
cp "$DIST/index.d.ts" "$DEST/index.d.ts.upstream"

echo "== sha256 (paste into README.md):"
(cd "$DEST" && sha256sum index.browser.js index.browser.d.ts index.d.ts LICENSE \
    cpu/mlipcpp_wasm.js cpu/mlipcpp_wasm.wasm gpu/mlipcpp_wasm.js gpu/mlipcpp_wasm.wasm)

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
