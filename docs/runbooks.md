# Runbooks

## RB-01 Daemon startup validation

1. Start daemon with target config.
2. Check `GET /api/v1/status` responds.
3. Verify mode is `healthy` or `degraded`, not `initializing` for prolonged time.
4. Validate at least one Beacon and one Execution endpoint score > 50.

## RB-02 RPC provider outage

1. Confirm `RPC_HEALTH_DEGRADED` incident appears.
2. Validate failover switched request flow to backup endpoint.
3. Remove or replace degraded provider in config.
4. Re-run manual retry.

## RB-03 Missed attestation investigation

1. Find `MISSED_ATTESTATION` incident code.
2. Check epoch/validator index in details.
3. Correlate with CL/EL provider latency and peer count.
4. Validate next liveness cycle clears repeated noise.

## RB-04 Alerting not delivered

1. Confirm `[telegram].enabled = true` and credentials are valid.
2. Check anti-spam window did not suppress duplicates.
3. Check quiet hours policy.
4. Trigger manual retry and inspect logs.

## RB-05 Restore from restart

1. Stop daemon.
2. Start daemon with same DB path.
3. Confirm incidents and endpoint health history are preserved.
4. Confirm zero duplicate alerts for unchanged fingerprints.
