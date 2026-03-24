# Operator Guide

## Deployment Model

Beaconcha Tools daemon is a single-process service with local SQLite persistence and an HTTP API consumed by desktop UI.

Recommended topology:

- 1 daemon instance per operator workstation or monitoring host
- Public Beacon + Execution RPC pools configured with at least two providers each

## Configuration Policy

- Keep config under change control (`git`, secrets manager for Telegram token)
- No private key material in config
- Enable telemetry/crash reporting only through explicit opt-in
- Configure `keymanager.endpoints` only for trusted local/secured validator clients

## Runtime Guarantees

- DB durability: SQLite WAL mode
- Endpoint failover: score-based rank + retry loop
- Incident persistence across restart
- Alert dedupe by fingerprint + anti-spam window

## Operational Tasks

## Add validators

1. Update config and restart daemon, or
2. Use API `POST /api/v1/import` from desktop settings

## Rotate RPC providers

1. Add new endpoint.
2. Keep old and new in pool for overlap.
3. Observe Health Center score convergence.
4. Remove degraded provider.

## Keymanager / External signer operations

- Add validator-client Keymanager endpoints in `[keymanager].endpoints`.
- If endpoint requires auth, set per-endpoint `auth_token`.
- Use UI `Key Mgmt` tab for:
  - list/import/delete keystores
  - list/import/delete remote signer keys
- Keep slashing protection interchange backups before key move/delete actions.

## Telegram maintenance

- Validate bot token/chat ID
- Verify quiet hours and heartbeat interval
- Test with controlled warning condition

## Backups

- Persist and back up `database_path` from config
- Include `app_state` and incident history in backup scope

## Security Baseline

- Run behind host firewall where possible
- Restrict daemon bind address to loopback unless remote UI is required
- Keep dependencies up to date and review security scans in CI
