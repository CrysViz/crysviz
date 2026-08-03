#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

python_bin=${PYTHON:-python3}
setup_dependencies=${CI_SETUP:-1}
skip_browser=${CI_SKIP_BROWSER:-0}
temp_base=${TMPDIR:-/tmp}
ci_temp=$(mktemp -d "$temp_base/crysviz-ci.XXXXXX")
marker_name="ci-must-not-package-${ci_temp##*/}.txt"

generated_target="$repo_root/docs/compiled/periodic_wasm_src/target/$marker_name"
generated_pkg="$repo_root/docs/compiled/periodic_wasm_src/pkg/$marker_name"
generated_report="$repo_root/docs/report/$marker_name"

cleanup() {
    rm -f -- "$generated_target" "$generated_pkg" "$generated_report"
    rmdir -- "$repo_root/docs/compiled/periodic_wasm_src/target" 2>/dev/null || true
    rmdir -- "$repo_root/docs/compiled/periodic_wasm_src/pkg" 2>/dev/null || true
    rmdir -- "$repo_root/docs/report" 2>/dev/null || true
    case "$ci_temp" in
        "$temp_base"/crysviz-ci.*) rm -rf -- "$ci_temp" ;;
        *) echo "Refusing to remove unexpected temporary path: $ci_temp" >&2 ;;
    esac
}
trap cleanup EXIT

if [[ "$setup_dependencies" == "1" ]]; then
    npm ci
    "$python_bin" -m pip install build
    "$python_bin" -m pip install -e .
fi

make checks
"$python_bin" -m unittest discover -s tests -v

mkdir -p "$(dirname "$generated_target")" "$(dirname "$generated_pkg")" "$(dirname "$generated_report")"
touch "$generated_target" "$generated_pkg" "$generated_report"

distribution_dir="$ci_temp/dist"
"$python_bin" -m build --outdir "$distribution_dir"
"$python_bin" tools/ci/inspect_distributions.py "$distribution_dir"

wheel=$(find "$distribution_dir" -maxdepth 1 -type f -name '*.whl' -print -quit)
sdist=$(find "$distribution_dir" -maxdepth 1 -type f -name '*.tar.gz' -print -quit)
test -n "$wheel"
test -n "$sdist"

wheel_venv="$ci_temp/wheel-venv"
"$python_bin" -m venv "$wheel_venv"
"$wheel_venv/bin/python" -m pip install "$wheel"
(
    cd "$ci_temp"
    "$wheel_venv/bin/python" -c 'import importlib.resources, crysviz; assert crysviz.__version__ == "0.1.0"; assert importlib.resources.files("crysviz.web").joinpath("index.html").is_file()'
    "$wheel_venv/bin/crysviz" --help >/dev/null
    "$wheel_venv/bin/crysviz" --version
)

sdist_venv="$ci_temp/sdist-venv"
"$python_bin" -m venv "$sdist_venv"
"$sdist_venv/bin/python" -m pip install "$sdist"
(
    cd "$ci_temp"
    "$sdist_venv/bin/python" -c 'import importlib.resources, crysviz; assert importlib.resources.files("crysviz.web").joinpath("compiled/periodic_wasm_bg.wasm").is_file()'
    "$sdist_venv/bin/crysviz" --version
)

if [[ "$skip_browser" != "1" ]]; then
    if [[ "$setup_dependencies" == "1" ]]; then
        make browsertest-setup
    fi
    CRYSVIZ_COMMAND="$wheel_venv/bin/crysviz" \
        tools/browsertest/run.sh tests/hostfacade.test.js tests/packagecli.test.js
fi
