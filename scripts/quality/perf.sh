#!/usr/bin/env bash
set -euo pipefail

start_ts=$(date +%s)
cargo test -p beaconops-core --release -- --nocapture
elapsed=$(( $(date +%s) - start_ts ))

echo "[perf] core release test elapsed: ${elapsed}s"
if [[ $elapsed -gt 120 ]]; then
  echo "[perf] exceeded performance budget"
  exit 1
fi
