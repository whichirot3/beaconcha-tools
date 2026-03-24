# API Contracts

Base URL: `http://127.0.0.1:8742/api/v1`

## `GET /status`

Returns runtime summary and counters.

## `GET /dashboard`

Returns full `DashboardPayload`:

- runtime
- chain_head
- execution_head
- validators
- incidents
- endpoint_health

## `GET /validators`

Returns `ValidatorSnapshot[]`.

## `GET /incidents`

Returns `Incident[]`.

## `GET /health`

Returns `EndpointHealth[]`.

## `POST /import`

Body:

```json
{
  "id": "12345",
  "label": "Validator #12345",
  "node": "Node A",
  "cluster": "Cluster A",
  "operator": "Ops"
}
```

## `POST /actions/retry`

Triggers immediate monitor tick.

## `POST /actions/reset-state`

Clears runtime cache state.

## `GET /logs`

Returns path to daemon logs.

## Operations API

### `POST /ops/bls-change/sign-submit`

Signs and optionally submits a single BLS-to-execution change (`0x00 -> 0x01`).

### `POST /ops/bls-change/batch-sign-submit`

Signs and optionally submits multiple BLS-to-execution changes in one batch.

### `POST /ops/consensus-exit/sign-submit`

Signs and optionally submits consensus-layer voluntary exit.

### `POST /ops/execution-action/submit`

Runs eligibility preflight and optionally broadcasts signed raw execution transaction for:
`convert_to_compounding`, `consolidate`, `top_up`, `full_exit`, `partial_withdraw`.

### `POST /ops/validator-keys/generate`

Generates BLS keypairs for operational workflows (no persistence in daemon storage).

## Keymanager API

These routes are active when `[keymanager].endpoints` are configured.

### `GET /keymanager/endpoints`

Lists configured Keymanager endpoints.

### `GET /keymanager/keystores?endpoint=<name>`

Lists keystores from one endpoint or all endpoints.

### `POST /keymanager/keystores/import`

Imports EIP-2335 keystores (+ optional slashing protection payload) through Keymanager API.

### `POST /keymanager/keystores/delete`

Deletes keystores by pubkey through Keymanager API.

### `GET /keymanager/remotekeys?endpoint=<name>`

Lists remote signer keys (external signer registry).

### `POST /keymanager/remotekeys/import`

Imports remote signer keys (`pubkey + url`).

### `POST /keymanager/remotekeys/delete`

Deletes remote signer keys by pubkey.

## Error Contract

Non-2xx responses return a structured system sheet payload:

```json
{
  "title": "Beaconcha Tools System Error",
  "message": "Human-readable message",
  "error_code": "CODE",
  "technical_details": "...",
  "retryable": true,
  "actions": ["retry", "copy_diagnostics", "open_logs", "reset_state", "report_issue"]
}
```
