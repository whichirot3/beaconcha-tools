# Incident Playbooks

## IPC-001 `CL_HEAD_UNAVAILABLE`

Symptoms:

- Chain head missing
- Dashboard runtime degraded

Actions:

1. Verify Beacon endpoints reachability from host.
2. Inspect endpoint health scores and last error text.
3. Add alternate Beacon provider if pool is too small.

## IPC-002 `EL_UNAVAILABLE`

Symptoms:

- Missing execution head
- Reduced diagnostics quality

Actions:

1. Validate Execution RPC connectivity.
2. Check provider rate limits.
3. Confirm fallback endpoint works.

## IPC-003 `RPC_HEALTH_DEGRADED`

Symptoms:

- Endpoint score < 35
- High failure_count/latency

Actions:

1. Remove unstable endpoint from pool.
2. Add at least one additional backup endpoint.
3. Re-run health check after 2-3 polling cycles.

## IPC-004 `MISSED_ATTESTATION`

Symptoms:

- Validator liveness false for previous epoch

Actions:

1. Validate validator client/node uptime externally.
2. Validate CL data source consistency.
3. Confirm issue is not caused by temporary RPC outage.
4. Escalate to validator infra owner if repeated.
