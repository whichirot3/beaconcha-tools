#!/usr/bin/env bash
set -euo pipefail

PORT_PIDS="$(lsof -ti tcp:5174 || true)"
if [[ -n "${PORT_PIDS}" ]]; then
  kill ${PORT_PIDS} || true
fi

env -i \
  HOME="${HOME}" \
  USER="${USER:-}" \
  LOGNAME="${LOGNAME:-}" \
  PATH="${HOME}/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  DISPLAY="${DISPLAY:-}" \
  XAUTHORITY="${XAUTHORITY:-}" \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
  SHELL="/bin/bash" \
  npm run tauri:dev
