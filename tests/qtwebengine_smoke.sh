#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

python_bin=${PYTHON:-python3}
xvfb_root="$repo_root/tools/browsertest/env/xvfb-root"
xvfb_run="$xvfb_root/usr/bin/xvfb-run"
platform=$(uname -s)

smoke=(
    env -u QTWEBENGINE_CHROMIUM_FLAGS
    CRYSVIZ_PYWEBVIEW_SMOKE=1 LIBGL_ALWAYS_SOFTWARE=1 QTWEBENGINE_DISABLE_SANDBOX=1
    "$python_bin" -m unittest tests/test_pywebview_smoke.py -v
)

# macOS has no Xvfb/XCB layer. pywebview's Qt backend uses the native window
# system, so run the same smoke directly (the CI user owns its GUI session).
if [[ "$platform" == "Darwin" ]]; then
    "${smoke[@]}"
    exit
fi

# PyQt 6.5+ requires libxcb-cursor to load its X11 platform plugin. Keep this
# rootless: reuse the system copy when present, otherwise vendor the distro's
# package beside the already-vendored Xvfb environment.
has_local_xcb() {
    find "$xvfb_root/usr/lib64" "$xvfb_root/usr/lib" \
        -name 'libxcb-cursor.so.0' -print -quit 2>/dev/null | grep -q .
}
has_system_xcb() {
    find /usr/lib /usr/lib64 /lib /lib64 -name 'libxcb-cursor.so.0' -print -quit 2>/dev/null | grep -q .
}

if ! has_local_xcb && ! has_system_xcb; then
    env_dir="$repo_root/tools/browsertest/env"
    if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
        (
            cd "$env_dir"
            apt-get download libxcb-cursor0
            dpkg -x libxcb-cursor0_*.deb xvfb-root
            rm -f libxcb-cursor0_*.deb
        )
    elif command -v dnf >/dev/null 2>&1 && command -v rpm2cpio >/dev/null 2>&1 \
            && command -v cpio >/dev/null 2>&1; then
        rpm_dir="$env_dir/rpm-download"
        mkdir -p "$rpm_dir" "$xvfb_root"
        rpm_arch=$(rpm --eval '%{_arch}')
        dnf download --destdir "$rpm_dir" "xcb-util-cursor.$rpm_arch"
        for rpm in "$rpm_dir"/*.rpm; do
            (cd "$xvfb_root" && rpm2cpio "$rpm" | cpio -idm --quiet)
            rm -f "$rpm"
        done
        rmdir "$rpm_dir" 2>/dev/null || true
    else
        echo "libxcb-cursor.so.0 is missing and no supported rootless package downloader was found." >&2
        echo "Install libxcb-cursor0 (Debian/Ubuntu) or xcb-util-cursor (Fedora), then retry." >&2
        exit 1
    fi
fi

# Fedora installs native 64-bit libraries under usr/lib64 and may also make
# multilib packages available. Prefer lib64 so a downloaded i686 copy can
# never shadow the native Qt dependency on x86-64 hosts.
local_lib=$(find "$xvfb_root/usr/lib64" "$xvfb_root/usr/lib" \
    -name 'libxcb-cursor.so.0' -print -quit 2>/dev/null)
local_lib=${local_lib%/*}
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
