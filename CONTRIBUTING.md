# Contributing

## Scope

This repository contains Rust backend services and a React/Tauri desktop client for Ethereum validator operations.

## Development Setup

1. Install Rust stable and Node.js 20+.
2. Copy config: `cp config/beaconops.example.toml config/beaconops.toml`.
3. Start daemon: `cargo run -p beaconops-daemon -- --config config/beaconops.toml`.
4. Start desktop dev app:
   - `cd apps/desktop`
   - `npm install`
   - `npm run dev` or `npm run tauri:dev`

## Quality Requirements

Before opening a PR, run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

```bash
cd apps/desktop
npm run lint
npm run typecheck
npm run test
npm run build
```

Recommended additional gates:

- `./scripts/quality/smoke.sh`
- `./scripts/quality/chaos.sh`
- `./scripts/quality/perf.sh`
- `./scripts/quality/frontend.sh`

## Pull Request Rules

- Keep PRs focused and reviewable.
- Update docs when behavior/API changes.
- Add or update tests for changed logic.
- Do not commit runtime artifacts (`data/`, logs, local configs, secrets).
- Do not introduce plaintext secret handling in persistence.

## Commit Style

Use clear, imperative commit titles.

Examples:

- `fix: handle keymanager endpoint timeout in startup checks`
- `feat: add execution-action preflight reason surface in UI`
- `docs: update API contracts for keymanager routes`
