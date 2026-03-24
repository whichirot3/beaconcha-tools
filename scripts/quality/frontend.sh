#!/usr/bin/env bash
set -euo pipefail

pushd apps/desktop >/dev/null
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
popd >/dev/null
