# Release and Update Checklists

## Release Candidate Checklist

1. Rust checks pass: `fmt`, `clippy`, `test`.
2. Frontend checks pass: `lint`, `typecheck`, `test`, `build`.
3. Smoke startup check passes on Linux/macOS/Windows.
4. RPC failover test passes.
5. DB migration compatibility test passes.
6. Alert dedupe/quiet-hours tests pass.
7. Accessibility and visual regression checks pass.
8. Security scans (`cargo audit`, `npm audit`) reviewed.
9. Release artifacts signed.

## Update Checklist

1. Backup existing SQLite DB.
2. Roll out new binary/package.
3. Verify daemon starts and migrations are successful.
4. Verify desktop launch checks complete.
5. Verify endpoint health and incident pipeline after upgrade.

## Rollback Checklist

1. Stop current daemon.
2. Restore previous binary/package.
3. Restore DB backup if migration rollback requires it.
4. Validate API endpoints and alert delivery.
