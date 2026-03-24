export type Severity = 'info' | 'warning' | 'critical';

export interface RuntimeStatus {
  mode: string;
  updated_at: string;
  rpc_failover_active: boolean;
  cache_hits: number;
  cache_misses: number;
}

export interface ChainHead {
  slot: number;
  epoch: number;
  finalized_epoch: number;
}

export interface ExecutionHead {
  block_number: number;
  peer_count: number;
}

export interface ValidatorMeta {
  label?: string;
  node?: string;
  cluster?: string;
  operator?: string;
}

export interface ValidatorRecord {
  validator_index: number;
  pubkey: string;
  withdrawal_address?: string | null;
  withdrawal_credentials?: string | null;
  withdrawal_credentials_type?: string | null;
  status: string;
  slashed?: boolean;
  activation_eligibility_epoch?: number | null;
  activation_epoch?: number | null;
  exit_epoch?: number | null;
  withdrawable_epoch?: number | null;
  effective_balance_gwei: number;
  current_balance_gwei: number;
  next_proposer_slot?: number | null;
  in_current_sync_committee: boolean;
  in_next_sync_committee: boolean;
  meta: ValidatorMeta;
}

export interface ValidatorSnapshot {
  observed_at: string;
  epoch: number;
  record: ValidatorRecord;
}

export interface Incident {
  id: string;
  occurred_at: string;
  severity: Severity;
  code: string;
  message: string;
  details: string;
  fingerprint: string;
  resolved: boolean;
}

export interface EndpointHealth {
  name: string;
  url: string;
  kind: string;
  score: number;
  success_count: number;
  failure_count: number;
  latency_ms: number;
  last_error?: string | null;
  updated_at: string;
}

export interface DashboardPayload {
  runtime: RuntimeStatus;
  chain_head?: ChainHead | null;
  execution_head?: ExecutionHead | null;
  tracked_validator_count: number;
  tracked_validator_indices: number[];
  validators: ValidatorSnapshot[];
  incidents: Incident[];
  endpoint_health: EndpointHealth[];
}

export interface DutySnapshot {
  validator_index: number;
  status: string;
  next_proposer_slot?: number | null;
  slots_until_proposal?: number | null;
  eta_seconds_until_proposal?: number | null;
  in_current_sync_committee: boolean;
  in_next_sync_committee: boolean;
  current_balance_gwei: number;
  effective_balance_gwei: number;
}

export interface DutiesPayload {
  generated_at: string;
  current_slot?: number | null;
  current_epoch?: number | null;
  slot_duration_seconds: number;
  safe_maintenance_slots?: number | null;
  safe_maintenance_until_slot?: number | null;
  validators: DutySnapshot[];
}

export interface BalancePoint {
  observed_at: string;
  balance_gwei: number;
}

export interface RewardsPayload {
  generated_at: string;
  validator_index: number;
  history_window_hours: number;
  status: string;
  withdrawal_address?: string | null;
  current_balance_gwei: number;
  effective_balance_gwei: number;
  delta_1h_gwei: number;
  delta_24h_gwei: number;
  delta_7d_gwei: number;
  projection_state: 'stable' | 'preliminary' | 'warming_up' | 'unavailable';
  projection_basis_hours?: number | null;
  projection_daily_gwei?: number | null;
  missed_attestations_24h: number;
  missed_attestations_7d: number;
  missed_attestation_streak: number;
  history: BalancePoint[];
}

export interface ErrorSheetPayload {
  title: string;
  message: string;
  error_code: string;
  technical_details: string;
  retryable: boolean;
  actions: string[];
}

export interface ValidatorImportPayload {
  id: string;
  label?: string;
  node?: string;
  cluster?: string;
  operator?: string;
}

export interface ResolvedValidatorIdentity {
  index: number;
  pubkey: string;
  status: string;
  withdrawal_address?: string | null;
  withdrawal_credentials?: string;
  withdrawal_credentials_type?: string;
  slashed?: boolean;
  effective_balance_gwei: number;
  current_balance_gwei: number;
}

export interface BlsToExecutionSignRequest {
  validator_index: number;
  from_bls_pubkey: string;
  to_execution_address: string;
  bls_private_key: string;
  dry_run?: boolean;
}

export interface BlsToExecutionSignResult {
  validator_index: number;
  from_bls_pubkey: string;
  to_execution_address: string;
  signing_root: string;
  domain: string;
  signature: string;
  submitted: boolean;
  submitted_at: string;
}

export interface BlsToExecutionBatchSignItem {
  validator_index: number;
  from_bls_pubkey: string;
  bls_private_key: string;
}

export interface BlsToExecutionBatchSignRequest {
  to_execution_address: string;
  items: BlsToExecutionBatchSignItem[];
  dry_run?: boolean;
}

export interface BlsToExecutionBatchSignItemResult {
  validator_index: number;
  from_bls_pubkey: string;
  signing_root: string;
  signature: string;
}

export interface BlsToExecutionBatchSignResult {
  to_execution_address: string;
  domain: string;
  submitted: boolean;
  submitted_at: string;
  items: BlsToExecutionBatchSignItemResult[];
}

export interface VoluntaryExitSignRequest {
  validator_index: number;
  validator_pubkey: string;
  validator_private_key: string;
  epoch?: number | null;
  dry_run?: boolean;
}

export interface VoluntaryExitSignResult {
  validator_index: number;
  validator_pubkey: string;
  epoch: number;
  signing_root: string;
  domain: string;
  signature: string;
  submitted: boolean;
  submitted_at: string;
}

export type ExecutionActionType =
  | 'convert_to_compounding'
  | 'consolidate'
  | 'top_up'
  | 'full_exit'
  | 'partial_withdraw';

export interface ExecutionActionSubmitRequest {
  action: ExecutionActionType;
  validator_index: number;
  target_validator_index?: number | null;
  amount_eth?: number | null;
  raw_transaction?: string | null;
  dry_run?: boolean;
}

export interface ExecutionActionSubmitResult {
  action: ExecutionActionType;
  validator_index: number;
  target_validator_index?: number | null;
  signer: string;
  eligible: boolean;
  preflight_reason: string;
  submitted: boolean;
  tx_hash?: string | null;
  submitted_at: string;
}

export interface ValidatorKeygenRequest {
  count?: number;
}

export interface GeneratedValidatorKeypair {
  index: number;
  pubkey: string;
  private_key: string;
}

export interface ValidatorKeygenResult {
  generated_at: string;
  count: number;
  keypairs: GeneratedValidatorKeypair[];
}

export interface KeymanagerEndpointInfo {
  name: string;
  url: string;
}

export interface KeymanagerKeystoreRecord {
  endpoint: string;
  validating_pubkey: string;
  derivation_path?: string | null;
  readonly?: boolean | null;
}

export interface KeymanagerRemoteKeyRecord {
  endpoint: string;
  pubkey: string;
  url: string;
  readonly?: boolean | null;
}

export interface KeymanagerListKeystoresResult {
  generated_at: string;
  records: KeymanagerKeystoreRecord[];
}

export interface KeymanagerListRemoteKeysResult {
  generated_at: string;
  records: KeymanagerRemoteKeyRecord[];
}

export interface KeymanagerMutationItem {
  endpoint: string;
  status: string;
  message?: string | null;
}

export interface KeymanagerMutationResult {
  generated_at: string;
  applied: KeymanagerMutationItem[];
}

export interface KeymanagerImportKeystoresRequest {
  endpoint?: string | null;
  keystores: string[];
  passwords: string[];
  slashing_protection?: string | null;
}

export interface KeymanagerDeleteKeystoresRequest {
  endpoint?: string | null;
  pubkeys: string[];
}

export interface KeymanagerRemoteKeyInput {
  pubkey: string;
  url: string;
  readonly?: boolean;
}

export interface KeymanagerImportRemoteKeysRequest {
  endpoint?: string | null;
  remote_keys: KeymanagerRemoteKeyInput[];
}

export interface KeymanagerDeleteRemoteKeysRequest {
  endpoint?: string | null;
  pubkeys: string[];
}
