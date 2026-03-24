import type { ValidatorSnapshot } from '../types';

export type ActionSigner =
  | 'bls_withdrawal_key'
  | 'withdrawal_address_wallet'
  | 'validator_signing_key_or_vc';

export type ValidatorActionId =
  | 'bls_to_execution_0x00_to_0x01'
  | 'convert_0x01_to_0x02'
  | 'consolidate'
  | 'top_up'
  | 'execution_exit'
  | 'partial_withdraw'
  | 'consensus_exit';

export interface ActionEligibility {
  id: ValidatorActionId;
  label: string;
  eligible: boolean;
  reason: string;
  signer: ActionSigner;
}

export interface QueueState {
  state: string;
  details: string;
  etaSeconds?: number;
}

export interface InventoryDerived {
  withdrawalType: '0x00' | '0x01' | '0x02' | 'unknown';
  lifecycle: 'active' | 'pending' | 'exiting' | 'exited' | 'slashed' | 'unknown';
  queue: QueueState;
  actions: ActionEligibility[];
}

const EPOCH_SECONDS = 384;

function toEth(gwei: number): number {
  return gwei / 1_000_000_000;
}

function parseWithdrawalType(raw?: string | null): InventoryDerived['withdrawalType'] {
  const normalized = (raw ?? '').toLowerCase();
  if (normalized.startsWith('0x00')) {
    return '0x00';
  }
  if (normalized.startsWith('0x01')) {
    return '0x01';
  }
  if (normalized.startsWith('0x02')) {
    return '0x02';
  }
  return 'unknown';
}

function deriveLifecycle(snapshot: ValidatorSnapshot): InventoryDerived['lifecycle'] {
  const status = snapshot.record.status.toLowerCase();
  if (snapshot.record.slashed || status.includes('slashed')) {
    return 'slashed';
  }
  if (status.includes('pending')) {
    return 'pending';
  }
  if (status.includes('exiting')) {
    return 'exiting';
  }
  if (status.includes('exited') || status.includes('withdrawal_done')) {
    return 'exited';
  }
  if (status.includes('active')) {
    return 'active';
  }
  return 'unknown';
}

function etaFromEpoch(targetEpoch: number | null | undefined, currentEpoch?: number | null): number | undefined {
  if (targetEpoch === null || targetEpoch === undefined || currentEpoch === null || currentEpoch === undefined) {
    return undefined;
  }
  if (targetEpoch <= currentEpoch) {
    return 0;
  }
  return (targetEpoch - currentEpoch) * EPOCH_SECONDS;
}

function deriveQueue(snapshot: ValidatorSnapshot, currentEpoch?: number | null): QueueState {
  const record = snapshot.record;
  const lifecycle = deriveLifecycle(snapshot);

  if (lifecycle === 'pending') {
    const eta = etaFromEpoch(record.activation_epoch, currentEpoch);
    return {
      state: 'activation_queue',
      details:
        record.activation_epoch !== null && record.activation_epoch !== undefined
          ? `Activation epoch ${record.activation_epoch}`
          : 'Awaiting activation',
      etaSeconds: eta,
    };
  }

  if (lifecycle === 'exiting') {
    const eta = etaFromEpoch(record.withdrawable_epoch, currentEpoch);
    return {
      state: 'exit_queue',
      details:
        record.withdrawable_epoch !== null && record.withdrawable_epoch !== undefined
          ? `Withdrawable epoch ${record.withdrawable_epoch}`
          : 'Exit in progress',
      etaSeconds: eta,
    };
  }

  if (lifecycle === 'exited') {
    return {
      state: 'completed',
      details: 'Exited / withdrawal completed',
      etaSeconds: 0,
    };
  }

  return {
    state: 'none',
    details: 'No queue for current lifecycle',
  };
}

function check(
  id: ValidatorActionId,
  label: string,
  signer: ActionSigner,
  eligible: boolean,
  reason: string
): ActionEligibility {
  return { id, label, signer, eligible, reason };
}

export function deriveInventory(snapshot: ValidatorSnapshot, currentEpoch?: number | null): InventoryDerived {
  const record = snapshot.record;
  const withdrawalType = parseWithdrawalType(
    record.withdrawal_credentials_type ?? record.withdrawal_credentials ?? undefined
  );
  const lifecycle = deriveLifecycle(snapshot);
  const balanceEth = toEth(record.current_balance_gwei);
  const isActiveLike = lifecycle === 'active';
  const isNotSlashed = lifecycle !== 'slashed';
  const isExited = lifecycle === 'exited';
  const inExitFlow = lifecycle === 'exiting';

  const actions: ActionEligibility[] = [
    check(
      'bls_to_execution_0x00_to_0x01',
      '0x00 -> 0x01',
      'bls_withdrawal_key',
      withdrawalType === '0x00' && isNotSlashed && !isExited,
      withdrawalType !== '0x00'
        ? `Requires 0x00 credentials (current ${withdrawalType})`
        : !isNotSlashed
          ? 'Slashed validator'
          : isExited
            ? 'Validator already exited'
            : 'Eligible'
    ),
    check(
      'convert_0x01_to_0x02',
      '0x01 -> 0x02',
      'withdrawal_address_wallet',
      withdrawalType === '0x01' && isActiveLike && isNotSlashed,
      withdrawalType !== '0x01'
        ? `Requires 0x01 credentials (current ${withdrawalType})`
        : !isActiveLike
          ? 'Validator must be active'
          : !isNotSlashed
            ? 'Slashed validator'
            : 'Eligible (pending manual-withdrawal check on submit)'
    ),
    check(
      'consolidate',
      'Consolidate',
      'withdrawal_address_wallet',
      (withdrawalType === '0x01' || withdrawalType === '0x02') && isActiveLike && isNotSlashed,
      !(withdrawalType === '0x01' || withdrawalType === '0x02')
        ? `Requires 0x01/0x02 credentials (current ${withdrawalType})`
        : !isActiveLike
          ? 'Source validator must be active'
          : !isNotSlashed
            ? 'Slashed validator'
            : 'Eligible as source (target must be active 0x02)'
    ),
    check(
      'top_up',
      'Top-up',
      'withdrawal_address_wallet',
      isActiveLike && isNotSlashed && !inExitFlow && !isExited,
      !isActiveLike
        ? 'Validator must be active'
        : !isNotSlashed
          ? 'Slashed validator'
          : inExitFlow
            ? 'Already in exit queue'
            : isExited
              ? 'Already exited'
              : withdrawalType === '0x02'
                ? 'Eligible'
                : `Eligible, but compounding 0x02 credentials are recommended (current ${withdrawalType})`
    ),
    check(
      'execution_exit',
      'EL full exit',
      'withdrawal_address_wallet',
      (withdrawalType === '0x01' || withdrawalType === '0x02') && isNotSlashed && !inExitFlow && !isExited,
      !(withdrawalType === '0x01' || withdrawalType === '0x02')
        ? `Requires 0x01/0x02 credentials (current ${withdrawalType})`
        : inExitFlow
          ? 'Already in exit queue'
          : isExited
            ? 'Already exited'
            : !isNotSlashed
              ? 'Slashed validator'
              : 'Eligible'
    ),
    check(
      'partial_withdraw',
      'Manual partial',
      'withdrawal_address_wallet',
      withdrawalType === '0x02' && balanceEth > 32,
      withdrawalType !== '0x02'
        ? `Requires 0x02 credentials (current ${withdrawalType})`
        : balanceEth <= 32
          ? 'Balance must remain above 32 ETH'
          : 'Eligible (amount validation on submit)'
    ),
    check(
      'consensus_exit',
      'Consensus voluntary exit',
      'validator_signing_key_or_vc',
      isActiveLike && !inExitFlow && !isExited,
      !isActiveLike
        ? 'Validator must be active'
        : inExitFlow
          ? 'Already in exit queue'
          : isExited
            ? 'Already exited'
            : 'Eligible'
    ),
  ];

  return {
    withdrawalType,
    lifecycle,
    queue: deriveQueue(snapshot, currentEpoch),
    actions,
  };
}

export function formatEta(seconds?: number): string {
  if (seconds === undefined) {
    return '—';
  }
  if (seconds <= 0) {
    return 'now';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
