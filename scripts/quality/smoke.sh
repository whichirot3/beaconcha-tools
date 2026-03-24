#!/usr/bin/env bash
set -euo pipefail

cargo run -p beaconops-daemon -- --help >/dev/null
cargo test -p beaconops-core storage_reopens_with_existing_schema -- --nocapture
cargo test -p beaconops-core storage_persists_snapshots_and_incidents -- --nocapture
