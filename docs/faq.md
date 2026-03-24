# FAQ

## Does Beaconcha Tools require my own Ethereum node?

No. Core functionality is designed for public Beacon API + Execution JSON-RPC.

## Are private keys stored?

By design, private key storage is not a target architecture for Beaconcha Tools.
Operational flows should rely on external custody/signers where possible.

## How is duplicate alert spam prevented?

Alert dedupe uses incident fingerprint + configurable anti-spam time window.

## What happens if one RPC provider fails?

Requests are retried and rerouted to higher-score endpoints automatically.

## Why do I see a warning but no Telegram message during quiet hours?

Non-critical alerts are deferred into digest during quiet hours.

## How do I recover from inconsistent local state?

Use `Reset cache state` and run `Manual retry` from Settings.

## What does `KEYMANAGER_NOT_CONFIGURED` mean?

Daemon has no `[keymanager].endpoints` configured.
Add endpoints in `config/beaconops.toml` and restart daemon.

## Why does UI show `DAEMON_TIMEOUT` if daemon seems running?

Most common causes:

- wrong daemon base URL
- stale daemon process on old binary
- API loop blocked by severe RPC degradation

Verify `GET /api/v1/status`, then restart daemon from current source build.

## Why can metrics be zero temporarily?

During endpoint degradation or startup bootstrap, some snapshots may be unavailable.
The UI keeps rendering last known state and updates once fresh snapshots arrive.

## Can I run several validators in one app?

Yes. Import multiple validator targets and switch active context in the left rail.
Inventory and incidents can then be analyzed per selected validator.

## Is telemetry enabled by default?

No. Telemetry and crash reporting are explicit opt-in.
