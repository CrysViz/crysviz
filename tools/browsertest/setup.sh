#!/usr/bin/env bash
# One-time setup for the browser test environment (see README.md here).
# Installs, entirely without root, into tools/browsertest/env/ (gitignored):
#   - playwright-core + pngjs (npm)
#   - playwright's Firefox build (the only browser whose WebGL works in
#     sandboxed/headless agent environments — via Xvfb; Chrome's V8 cannot
#     start under a capped virtual address space at all)
#   - Xvfb, extracted from the Ubuntu package (no install, no root) — SKIPPED
#     when the machine already has an Xvfb on PATH, which is how this works on
#     a non-Debian distro, where `apt-get download` does not exist.
# Total download is ~180 MB. Idempotent: safe to re-run.
#
# Playwright's Firefox is dynamically linked against the ordinary GTK3 desktop
# stack, which a minimal container may not have. This script does NOT install
# those (they need root and they are distro-specific) — it checks for them at
# the end and prints the one command that fixes it. On Fedora that is:
#   sudo dnf install -y xorg-x11-server-Xvfb gtk3 alsa-lib dbus-libs \
#        mesa-libGL mesa-libEGL mesa-dri-drivers dejavu-sans-fonts
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p env
cd env

if [ ! -f package.json ]; then
  npm init -y >/dev/null
fi
npm install --no-fund --no-audit playwright-core@1.49.1 pngjs@7 >/dev/null
echo "setup: npm packages ready (playwright-core, pngjs)"

if [ ! -d pw-browsers ] || ! ls pw-browsers/firefox-* >/dev/null 2>&1; then
  # Playwright's host check names the apt packages it wants, so it is right on
  # a Debian machine and wrong everywhere else — it reports every non-Debian
  # machine as broken. Leave it on where it means something; skip it only where
  # it cannot be right, and let the ldd check below cover that case instead.
  if command -v apt-get >/dev/null 2>&1; then
    PLAYWRIGHT_BROWSERS_PATH="$PWD/pw-browsers" \
      node node_modules/playwright-core/cli.js install firefox
  else
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
    PLAYWRIGHT_BROWSERS_PATH="$PWD/pw-browsers" \
      node node_modules/playwright-core/cli.js install firefox
  fi
fi
echo "setup: playwright Firefox ready"

# Vendoring first, exactly as before: on an apt machine this takes the same
# branch it always did, whether or not the distro also has an Xvfb installed.
# The system fallback is only reached where `apt-get download` cannot run.
if [ -x xvfb-root/usr/bin/Xvfb ]; then
  echo "setup: Xvfb ready (vendored)"
elif command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
  apt-get download xvfb
  dpkg -x xvfb_*.deb xvfb-root
  rm -f xvfb_*.deb
  echo "setup: Xvfb ready (vendored)"
elif command -v Xvfb >/dev/null 2>&1; then
  echo "setup: Xvfb ready (system $(command -v Xvfb))"
else
  echo "setup: no Xvfb, and no apt-get to vendor one — install it with your" >&2
  echo "       package manager (Fedora: sudo dnf install xorg-x11-server-Xvfb)" >&2
  exit 1
fi

# Firefox links against the desktop GTK3 stack; a minimal container has none of
# it and the launch dies with 'XPCOMGlueLoad error ... libgtk-3.so.0'. Catch
# that here, where the fix is one command, rather than inside a test run.
FIREFOX_BIN="$( { ls -d pw-browsers/firefox-*/firefox/firefox 2>/dev/null | head -1; } || true)"
if [ -n "$FIREFOX_BIN" ]; then
  FIREFOX_DIR="$(dirname "$FIREFOX_BIN")"
  # Scan the shipped libraries, not just the launcher: the launcher itself has
  # eight dependencies and GTK is not among them — libmozgtk.so and libxul.so
  # are what pull it in, and libmozgtk.so is precisely what the failing launch
  # names. The browser's own directory goes on LD_LIBRARY_PATH so the libs it
  # bundles resolve (they would otherwise all read as "not found"), leaving
  # only genuine system gaps.
  # `|| true`: awk/sort exit non-zero on an empty pipe under `set -o pipefail`,
  # which would abort the script exactly when nothing is wrong.
  MISSING="$( { LD_LIBRARY_PATH="$FIREFOX_DIR" ldd "$FIREFOX_BIN" "$FIREFOX_DIR"/*.so 2>/dev/null \
    | awk '/not found/ {print $1}' | sort -u | tr '\n' ' '; } || true)"
  if [ -n "$MISSING" ]; then
    # A warning, not a failure. ldd walks every DT_NEEDED of every shipped
    # library, including ones an X11-only run never loads, so a hard exit here
    # could fail CI over a library nothing actually needs. The launch itself is
    # the authority; this just names the fix before you go read a stack trace.
    echo "setup: WARNING — Firefox may be missing system libraries: $MISSING" >&2
    echo "       If the browser fails to launch, install them:" >&2
    echo "       Fedora: sudo dnf install -y gtk3 alsa-lib dbus-libs \\" >&2
    echo "               mesa-libGL mesa-libEGL mesa-dri-drivers dejavu-sans-fonts" >&2
    echo "       Debian/Ubuntu: sudo npx playwright install-deps firefox" >&2
  else
    echo "setup: Firefox system libraries present"
  fi
fi

echo "browsertest environment ready — run tests with: make browsertest"
