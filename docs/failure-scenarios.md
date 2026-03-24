# Failure Scenarios

## Scenario: Full Beacon API outage

Expected:

- Critical incident `CL_HEAD_UNAVAILABLE`
- Runtime mode `degraded`
- UI remains responsive with stale last known data

## Scenario: Single endpoint outage

Expected:

- Endpoint score falls below threshold
- Failover routes requests to backup endpoint in <= 5 seconds
- Warning incident `RPC_HEALTH_DEGRADED`

## Scenario: Execution RPC lag/rate limit

Expected:

- Warning incident `EL_UNAVAILABLE`
- CL-derived data remains available

## Scenario: Restart during incident storm

Expected:

- Persisted incidents reloaded from SQLite
- No duplicate Telegram alerts inside anti-spam window
- Monitoring resumes from last liveness checkpoint

## Scenario: Telegram temporarily unreachable

Expected:

- Monitoring continues
- Send failure appears in logs
- Next interval retries normally

## Scenario: Desktop API errors

Expected:

- No screen crash
- Single system error sheet appears
- Recovery actions are available
