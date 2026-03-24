# Quick Start

## Prerequisites

- Rust toolchain `1.93+`
- Node.js `20+`
- Internet access to public Beacon/Execution RPC endpoints
- Free local port for daemon API (default `127.0.0.1:8742`)

## 1. Configure Beaconcha Tools

Copy the sample config:

```bash
cp config/beaconops.example.toml config/beaconops.toml
```

Set at least:

- Two Beacon API endpoints
- Two Execution RPC endpoints
- Validator targets (`index`, `pubkey`, or `withdrawal address`)
- Telegram fields if alerting is enabled
- Optional Keymanager endpoints for custody flows (`[keymanager].endpoints`)

## 2. Start daemon

```bash
cargo run -p beaconops-daemon -- --config config/beaconops.toml
```

Daemon API defaults to `127.0.0.1:8742`.

Sanity check:

```bash
curl -sS http://127.0.0.1:8742/api/v1/status
```

## 3. Start desktop UI

```bash
cd apps/desktop
npm install
npm run dev
```

Open `http://localhost:5174`.

## 4. First-run onboarding checklist

1. Verify launch checks complete (`RPC`, `cache`, `config`, `updates`).
2. Open `Health Center` and ensure endpoint score >= 70 for at least one Beacon and one Execution source.
3. Import validator groups with `node/cluster/operator` metadata.
4. Trigger `Manual retry` in Settings.
5. Confirm incidents and health reflect real chain state.
6. Set auto-lock timeout and test lock/unlock once.

## 5. Telegram alert smoke

1. Enable `[telegram]` in config.
2. Cause controlled degradation (disable one RPC endpoint).
3. Verify warning alert arrives once (no duplicates in anti-spam window).
4. Restore endpoint and verify heartbeat keeps running.

## 6. Common startup failures

- `Address already in use`: another daemon is already listening on `127.0.0.1:8742`.
- `DAEMON_TIMEOUT`: daemon not running, wrong base URL, or endpoint loop stalled.
- `HTTP_404` on new routes: stale daemon binary; restart from current repo sources.
- `KEYMANAGER_NOT_CONFIGURED`: missing `[keymanager].endpoints` in config.
