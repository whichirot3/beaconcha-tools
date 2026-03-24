# Architecture

## High-Level

Beaconcha Tools is a dual-delivery architecture over one shared core:

1. `beaconops-core` (Rust): domain logic, RPC failover, monitoring, storage, alerting.
2. `beaconops-daemon` (Rust): long-running service, scheduler loops, local HTTP API.
3. Desktop UI (React/TS + optional Tauri): presentation layer over daemon API.

## Data Flow

1. Poll cycle requests Beacon + Execution public endpoints.
2. RPC pool selects endpoint by health score and failover ranking.
3. Parsed metrics become `ValidatorSnapshot` + incidents.
4. Data persisted in SQLite and exposed through daemon API.
5. Alert engine sends Telegram notifications with dedupe + policy.
6. UI consumes API and renders diagnostics/dashboards.

## Reliability Patterns

- Endpoint health scoring (`score`, `latency`, `failures`, `last_error`)
- Retries with backoff
- In-memory API cache for read-heavy endpoints
- Graceful partial payload when one subsystem is degraded
- WAL-backed SQLite for restart durability

## Error Model

- Incident objects for runtime events
- API errors normalized to structured payload
- Desktop routes all errors through one branded system sheet

## Security and Privacy

- No persistent storage of validator/withdrawal signing secrets in daemon storage.
- Signing flows are explicit action endpoints and use transient request payloads or external signed transactions.
- Keymanager/external signer integrations are optional and endpoint-scoped.
- Telemetry and crash reporting are disabled by default (opt-in only).
