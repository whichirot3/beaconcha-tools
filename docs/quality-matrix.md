# Quality Matrix

| Category | Current Implementation | Command/Path |
| --- | --- | --- |
| Unit tests | Rust unit + module tests | `cargo test --workspace` |
| Integration tests | RPC failover, storage persistence/migration | `crates/beaconops-core/tests/*` |
| Smoke tests | Daemon CLI + storage checks | `scripts/quality/smoke.sh` |
| Regression tests | Workspace tests + frontend test suite | CI `rust-quality` + `frontend-quality` |
| Visual regression baseline | UI build artifact gate (expandable with Playwright snapshots) | `apps/desktop/dist` |
| Performance gate | Release test budget check | `scripts/quality/perf.sh` |
| Chaos/fault injection | Failover integration test with failing endpoint | `scripts/quality/chaos.sh` |
| Network outage/failover | Endpoint outage simulation in tests | `rpc_failover_tests.rs` |
| DB migration | Reopen existing DB schema test | `storage_migration_tests.rs` |
| Startup/shutdown | Daemon startup smoke (CLI/API bootstrap) | `scripts/quality/smoke.sh` |
| Cross-platform packaging smoke | Matrix build Linux/macOS/Windows | `.github/workflows/ci.yml` |
| Static analysis | clippy + eslint | CI `rust-quality` + `frontend-quality` |
| Type-checking | TypeScript + Rust compile gates | `npm run typecheck`, `cargo check` |
| Security scan | `cargo audit`, `npm audit` | CI `security-scan` |
| Release signing | Cosign availability gate for tag builds | CI `release-signing-dry-run` |

## Planned Extensions

- Automated visual diff tests via Playwright screenshot baselines.
- Soak tests with long-running monitor loop against mock RPC cluster.
- Accessibility automation with `axe-core` integration.
