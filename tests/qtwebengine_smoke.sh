#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

python_bin=${PYTHON:-python3}
xvfb_root="$repo_root/tools/browsertest/env/xvfb-root"
xvfb_run="$xvfb_root/usr/bin/xvfb-run"

# PyQt 6.5+ requires libxcb-cursor to load its X11 platform plugin. Keep the
# opt-in smoke rootless without adding this native dependency to regular CI.
if ! find "$xvfb_root/usr/lib" -name 'libxcb-cursor.so.0' -print -quit 2>/dev/null | grep -q .; then
    (
        cd "$repo_root/tools/browsertest/env"
        apt-get download libxcb-cursor0
        dpkg -x libxcb-cursor0_*.deb xvfb-root
        rm -f libxcb-cursor0_*.deb
    )
fi

local_lib=$(find "$xvfb_root/usr/lib" -type d -name '*-linux-gnu' -print -quit)
smoke=(
    env -u QTWEBENGINE_CHROMIUM_FLAGS
    CRYSVIZ_PYWEBVIEW_SMOKE=1 LIBGL_ALWAYS_SOFTWARE=1 QTWEBENGINE_DISABLE_SANDBOX=1
    "$python_bin" -m unittest tests/test_pywebview_smoke.py -v
)

if [[ -x "$xvfb_run" && -n "$local_lib" ]]; then
    PATH="$xvfb_root/usr/bin:$PATH" \
        LD_LIBRARY_PATH="$local_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
        "$xvfb_run" -a "${smoke[@]}"
elif command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run -a "${smoke[@]}"
else
    echo "xvfb-run is unavailable; run 'make browsertest-setup' first" >&2
    exit 1
fi
