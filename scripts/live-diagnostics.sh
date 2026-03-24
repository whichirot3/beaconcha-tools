#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/data/logs"
TODAY="$(date +%F)"
DAEMON_LOG="${LOG_DIR}/beaconops.log.${TODAY}"
UI_LOG="${LOG_DIR}/desktop-ui.log"
OUT_LOG="${LOG_DIR}/live-diagnostics.log"

mkdir -p "${LOG_DIR}"
touch "${DAEMON_LOG}" "${UI_LOG}" "${OUT_LOG}"

echo "Writing merged live diagnostics to: ${OUT_LOG}"
echo "Sources:"
echo "  daemon: ${DAEMON_LOG}"
echo "  ui:     ${UI_LOG}"

tail -n 0 -F "${DAEMON_LOG}" "${UI_LOG}" | awk '
  /==> .* <==/ {
    source = $0;
    gsub(/^==> /, "", source);
    gsub(/ <==$/, "", source);
    next;
  }
  {
    prefix = (source ~ /desktop-ui\.log$/) ? "[UI]" : "[DAEMON]";
    print strftime("%Y-%m-%dT%H:%M:%S%z"), prefix, $0;
    fflush();
  }
' >> "${OUT_LOG}"
