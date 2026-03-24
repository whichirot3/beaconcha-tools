# Beaconcha Tools

Beaconcha Tools is an Ethereum validator operations stack with two deliverables:

- `beaconops-daemon` (Rust): 24/7 monitoring, incident pipeline, Telegram alerting, local API.
- Desktop app (React/TypeScript + optional Tauri shell): onboarding, dashboards, operations, diagnostics.

## Platform Availability

- Official desktop support: **Windows** and **Linux**.
- This repository may run checks on other environments for portability, but release target is Windows/Linux desktop systems.

## What It Does

- Monitors validator runtime via public Beacon API + Execution JSON-RPC (heads, epochs, health, incidents).
- Maintains validator inventory: identity, balance, status, withdrawal credentials, and action eligibility.
- Provides operational workflows: `0x00 -> 0x01`, voluntary exit, execution-layer preflight/submit.
- Integrates with Keymanager API for keystore and remote signer lifecycle operations.
- Provides diagnostics, incident timeline, and Telegram alerting with anti-spam controls.
- Exposes a local daemon API for desktop UI and automation.

<img width="1197" height="757" alt="image" src="https://github.com/user-attachments/assets/5e6df29d-93b1-47e0-9a10-10194cdeb108" />

Official domain: [beaconchatools.in](https://beaconchatools.in)


## Why It Is Useful

- Replaces fragmented scripts and dashboards with one operator control plane.
- Reduces risk during validator operations through preflight checks, dry-run flows, and explicit error handling.
- Works in public-infrastructure mode, without mandatory self-hosted nodes.
- Improves incident response with unified timelines, endpoint health visibility, and actionable diagnostics.
- Supports scaling from single-validator setups to grouped fleet operations (node/cluster/operator contexts).

## Scope

- Public-infra mode: works with public Beacon API and Execution JSON-RPC, no mandatory self-hosted node.
- Multi-RPC reliability: failover, health scoring, retries, cache, degraded-mode rendering.
- Validator operations: inventory, duties/rewards, action center, keymanager integration, incident timeline.
- Security model: no persistent storage of signing secrets in app DB, opt-in telemetry/crash reporting.

## Architecture

- `crates/beaconops-core`: domain logic, RPC pools, storage, alerting, action preflight/signing.
- `crates/beaconops-daemon`: scheduler + HTTP API (`/api/v1/*`) for desktop and automation.
- `apps/desktop`: React client.
- `apps/desktop/src-tauri`: native shell and packaging.
- `config/beaconops.example.toml`: production-oriented config template.
- `docs/`: user/operator/API/runbook/quality documentation.

## Local Run

### Prerequisites

- Rust stable
- Node.js 20+

### 1) Configure daemon

```bash
cp config/beaconops.example.toml config/beaconops.toml
```

### 2) Start daemon

```bash
cargo run -p beaconops-daemon -- --config config/beaconops.toml
```

API default: `http://127.0.0.1:8742/api/v1`

### 3) Start desktop (web dev mode)

```bash
cd apps/desktop
npm install
npm run dev
```

### 4) Start desktop (native window, Tauri)

```bash
cd apps/desktop
npm run tauri:dev
```

For Linux dependencies see [docs/quick-start.md](docs/quick-start.md).

## Key and Signing Flows

- `0x00 -> 0x01` and consensus exit can require BLS private key input for signing step.
- Execution-layer actions use a signed raw transaction (wallet/SAFE/external signer), not raw key input.
- Keymanager tab supports list/import/delete keystores and remote signer keys via configured endpoints.

## Quality Gates

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

Additional scripts:

- `./scripts/quality/smoke.sh`
- `./scripts/quality/chaos.sh`
- `./scripts/quality/perf.sh`
- `./scripts/quality/frontend.sh`

## CI

GitHub Actions workflow includes:

- Rust format/lint/tests
- Frontend lint/typecheck/tests/build
- Smoke, chaos, perf gates
- Security scan (`cargo audit`, `npm audit`)
- Multi-OS packaging smoke checks

See `.github/workflows/ci.yml`.

## Documentation

- [Quick Start](docs/quick-start.md)
- [User Guide](docs/user-guide.md)
- [Operator Guide](docs/operator-guide.md)
- [API Contracts](docs/api-contracts.md)
- [Runbooks](docs/runbooks.md)
- [Incident Playbooks](docs/incident-playbooks.md)
- [Architecture](docs/architecture.md)
- [Quality Matrix](docs/quality-matrix.md)
- [FAQ](docs/faq.md)

## Contributing and Security

- Contribution process: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`

## License

MIT (`LICENSE`).
