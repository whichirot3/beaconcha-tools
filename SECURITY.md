# Security Policy

## Supported Versions

Security fixes are applied to the latest `main` branch state.

## Reporting a Vulnerability

Do not open public issues for security-sensitive findings.

Report by email with:

- Affected component (`beaconops-core`, `beaconops-daemon`, desktop UI, Tauri shell)
- Reproduction steps
- Impact assessment
- Suggested mitigation (if available)

Contact: `security@beaconcha.tools`

## Security Posture

- Telemetry and crash reporting are opt-in.
- Local runtime data is persisted to SQLite.
- Signing secrets must not be persisted in app storage.
- Keymanager/external signer flows are preferred for custody separation.
- CI runs `cargo audit` and `npm audit`.
