#!/usr/bin/env bash
# One-time setup for the browser test environment (see README.md here).
# Installs, entirely without root, into tools/browsertest/env/ (gitignored):
#   - playwright-core + pngjs (npm)
#   - playwright's Firefox build (the only browser whose WebGL works in
#     sandboxed/headless agent environments — via Xvfb; Chrome's V8 cannot
#     start under a capped virtual address space at all)
#   - Xvfb, extracted from the Ubuntu package (no install, no root)
# Total download is ~180 MB. Idempotent: safe to re-run.
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
  PLAYWRIGHT_BROWSERS_PATH="$PWD/pw-browsers" \
    node node_modules/playwright-core/cli.js install firefox
fi
echo "setup: playwright Firefox ready"

if [ ! -x xvfb-root/usr/bin/Xvfb ]; then
  apt-get download xvfb
  dpkg -x xvfb_*.deb xvfb-root
  rm -f xvfb_*.deb
fi
echo "setup: Xvfb ready"

echo "browsertest environment ready — run tests with: make browsertest"
