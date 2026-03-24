# Modules

## `beaconops-core`

- `config`: typed config loading and validation
- `rpc`: multi-endpoint pools, scoring, retries, failover, cache
- `monitor`: validator resolution, chain polling, incident generation
- `storage`: SQLite migrations and persistence
- `alerts`: Telegram integration with anti-spam, quiet hours, heartbeat, digest
- `models`: shared payload contracts

## `beaconops-daemon`

- Runtime bootstrap
- Monitoring loop orchestration
- Alert engine orchestration
- Local API routes for status/dashboard/actions/import
- Unified API error contract

## Desktop UI (`apps/desktop`)

- Launch/splash validation sequence
- Dashboard, Health, Incidents, Settings, Help screens
- Virtualized validator table
- Unified error sheet UX
- Lazy loaded help center

## Desktop shell (`apps/desktop/src-tauri`)

- Optional native packaging wrapper
- Command bridge for daemon base URL
