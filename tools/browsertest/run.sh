#!/usr/bin/env bash
# Run browser tests: serves docs/, starts a private Xvfb, runs each test file
# with node, and tears everything down. With no arguments runs every
# tests/*.test.js; pass specific test files to run a subset:
#   tools/browsertest/run.sh tests/celoutline.test.js
# Requires tools/browsertest/env/ (make browsertest-setup / setup.sh).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d env/node_modules/playwright-core ] || [ ! -x env/xvfb-root/usr/bin/Xvfb ]; then
  echo "browsertest env missing — run 'make browsertest-setup' first" >&2
  exit 1
fi

PORT="${PORT:-8123}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"

# Both the port and the X display must be private to THIS checkout. A second
# working tree (git worktree) running its own tests otherwise wins the race for
# :99 / 8123 and this run silently tests the OTHER tree's docs/ — every
# assertion still executes, against the wrong source. Probe upward instead.
port_free() {
  python3 -c "import socket, sys; s = socket.socket(); s.settimeout(0.2); busy = s.connect_ex(('127.0.0.1', $1)) == 0; s.close(); sys.exit(1 if busy else 0)"
}
for _ in $(seq 20); do
  # `if`, not `&&`: under `set -e` a bare failing command at the end of an
  # AND-list still aborts the script.
  if port_free "$PORT"; then break; fi
  PORT=$(( PORT + 1 ))
done
if ! port_free "$PORT"; then
  echo "no free port for the app server near ${PORT}" >&2
  exit 1
fi
while [ -e "/tmp/.X${DISPLAY_NUM}-lock" ] && [ "$DISPLAY_NUM" -lt 120 ]; do
  DISPLAY_NUM=$(( DISPLAY_NUM + 1 ))
done

# devserver.py also sends Cache-Control: no-store — plain http.server sends
# none, so Firefox can execute the PREVIOUS version of a just-edited module.
python3 ../devserver.py "$PORT" --bind 127.0.0.1 --directory ../../docs >/dev/null 2>&1 &
SERVER_PID=$!
env/xvfb-root/usr/bin/Xvfb ":$DISPLAY_NUM" -screen 0 1400x900x24 -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
trap 'kill "$SERVER_PID" "$XVFB_PID" 2>/dev/null || true' EXIT
sleep 1.5

export DISPLAY=":$DISPLAY_NUM"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/env/pw-browsers"
export NODE_PATH="$PWD/env/node_modules"
export CRYSVIZ_URL="http://localhost:$PORT/index.html"
# Firefox's own sandboxes crash (signal 11) inside agent sandboxes; WebGL must
# come from Mesa software rendering on the Xvfb display.
export MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GMP_SANDBOX=1
export MOZ_DISABLE_RDD_SANDBOX=1 MOZ_DISABLE_SOCKET_PROCESS_SANDBOX=1
export LIBGL_ALWAYS_SOFTWARE=1

if ! curl -sf -o /dev/null "$CRYSVIZ_URL"; then
  echo "app server failed to start on port $PORT" >&2
  exit 1
fi

declare -a TESTS
if [ "$#" -gt 0 ]; then
  TESTS=("$@")
else
  TESTS=(tests/*.test.js)
fi

FAILED=0
for t in "${TESTS[@]}"; do
  echo "== $t"
  if ! node "$t"; then
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "browsertest: FAILURES (screenshots in tools/browsertest/artifacts/)" >&2
else
  echo "browsertest: all tests passed"
fi
exit "$FAILED"
