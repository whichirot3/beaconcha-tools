#!/usr/bin/env bash
set -euo pipefail

# Fault injection: first endpoint fails, second endpoint succeeds
cargo test -p beaconops-core rpc_pool_fails_over_to_healthy_endpoint -- --nocapture
