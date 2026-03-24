# User Guide

## 1. What Beaconcha Tools Is

Beaconcha Tools is an operator workstation for Ethereum validators:

- runtime monitoring (Beacon + Execution heads, duties, rewards, incidents)
- validator inventory and action eligibility
- action workflows (`0x00 -> 0x01`, convert, consolidate, exits, partial withdraw preflight)
- key management integration through Keymanager API
- unified diagnostics and incident timeline

The product is designed to work with public RPC providers and without running your own node.

## 2. Startup and Access

### 2.1 Startup flow

On first launch, the access window verifies:

- daemon connectivity
- local cache storage access
- runtime payload validity
- release channel reachability

`Next` is enabled only after required checks are successful.

### 2.2 Identity and local password

During onboarding:

1. Enter validator index or validator pubkey.
2. Verify validator identity against Beacon API.
3. Set a local password for lock/unlock.

The local password protects UI access and is independent from validator signing/withdrawal secrets.

## 3. Main Navigation

## Overview

Core operational dashboard with:

- Beacon/Execution heads
- runtime mode and failover status
- incident pulse trend
- full validator inventory cards

Inventory cards expose:

- validator index and pubkey
- withdrawal credentials type (`0x00/0x01/0x02`)
- withdrawal address
- current and effective balances
- lifecycle state (`active/pending/exiting/exited/slashed`)
- action eligibility with block reasons

## Duties

Shows proposer and sync committee context:

- next proposer slot
- ETA to duty
- safe maintenance window

Use this screen before maintenance/restarts.

## Rewards

Shows:

- balance deltas (`1h/24h/7d`)
- missed attestation counters and streak
- balance history curve for selectable interval

## Operations

Action Center for:

- `0x00 -> 0x01` sign/submit
- batch `0x00 -> 0x01`
- consensus voluntary exit
- execution-layer action submit with preflight (`convert`, `consolidate`, `top_up`, `full_exit`, `partial_withdraw`)
- validator keypair generation for operational testing flows

Always run dry-run first before any live submit.

## Key Mgmt

Keymanager API section for:

- list/import/delete keystores
- list/import/delete remote signer keys

Requires `[keymanager].endpoints` configured in daemon config.

## RPC Health

Endpoint health matrix:

- score
- latency
- success/failure counters
- last error

Use it to decide endpoint rotation and failover remediation.

## Incidents

Unified incident stream:

- severity (`info`, `warning`, `critical`)
- code
- details and timeline

Use incident codes with `docs/incident-playbooks.md`.

## Settings

Runtime and access controls:

- theme switch
- auto-lock timeout
- lock now
- reset access
- manual retry
- cache reset

## Help

Built-in searchable instructions:

- quick start runbooks
- monitoring interpretation
- action safety guides
- key management guides
- troubleshooting
- FAQ and glossary
- interactive first-run checklist

## 4. Error Handling Model

All operational failures should be shown via one system sheet:

- clear human message
- error code
- technical details (expandable)
- recovery actions (`retry`, `copy diagnostics`, `open logs`, `reset state`, `report issue`)

If an API request fails, the UI must stay recoverable and never dead-end on a blank screen.

## 5. Recommended Daily Routine

1. Check runtime mode and heads in `Overview`.
2. Confirm no fresh critical incidents.
3. Review endpoint score trend in `RPC Health`.
4. Check upcoming duties before planned maintenance.
5. Review rewards deltas and missed-attestation streak.
6. Only then execute Action Center operations with dry-run first.

## 6. Security Notes

- Do not store withdrawal/validator private keys in plain text.
- Keep custody domains separated where possible.
- Export slashing protection before key migration/delete operations.
- Keep auto-lock enabled on shared or unattended workstations.
