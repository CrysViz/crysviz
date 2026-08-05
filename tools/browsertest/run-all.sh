#!/usr/bin/env bash
# Run the whole browsertest suite in parallel by sharding tests/*.test.js across
# N independent run.sh instances, each on its own auto-probed port + X display
# (run.sh honours PORT/DISPLAY_NUM). Tests render through Mesa software GL and
# are CPU-bound, so 4-way is the sweet spot on an 8-core box — going wider
# oversubscribes the CPU, slows every render, and can flake the "pixels drawn"
# assertions. Round-robin sharding spreads the few minutes-long tracer tests
# across shards instead of piling them on one.
#
#   tools/browsertest/run-all.sh                 # every test, 4 shards
#   tools/browsertest/run-all.sh 6               # every test, 6 shards
#   tools/browsertest/run-all.sh 4 tests/wyckoff*.test.js   # a subset, 4 shards
set -uo pipefail
cd "$(dirname "$0")"

N=4
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then N="$1"; shift; fi
mapfile -t ALL < <({ if [ "$#" -gt 0 ]; then printf '%s\n' "$@"; else ls tests/*.test.js; fi; } | sort)
[ "${#ALL[@]}" -eq 0 ] && { echo "no test files matched" >&2; exit 1; }

LOGDIR="$(mktemp -d)"
pids=()
for i in $(seq 0 $((N - 1))); do
  shard=()
  for ((j = i; j < ${#ALL[@]}; j += N)); do shard+=("${ALL[j]}"); done
  [ "${#shard[@]}" -eq 0 ] && continue
  echo "shard $i: ${#shard[@]} tests -> port $((8300 + i * 40)) display :$((110 + i))"
  PORT=$((8300 + i * 40)) DISPLAY_NUM=$((110 + i)) \
    ./run.sh "${shard[@]}" >"$LOGDIR/shard_$i.log" 2>&1 &
  pids+=("$!")
done

rc=0
for p in "${pids[@]}"; do wait "$p" || rc=1; done

echo "===================== SUMMARY ====================="
awk '/^  PASS /{p++} /^  FAIL /{f++} END{printf "checks: %d passed, %d failed\n", p, f}' "$LOGDIR"/shard_*.log
echo "files run: $(grep -hcE '^== tests/' "$LOGDIR"/shard_*.log | awk '{s+=$1} END{print s}')"
fails=$(grep -hE '^  FAIL |crash|browsertest: FAILURES' "$LOGDIR"/shard_*.log | sort -u || true)
if [ -n "$fails" ]; then
  echo
  echo "--- FAILURES ---"
  echo "$fails"
fi
echo "per-shard logs: $LOGDIR"
exit "$rc"
