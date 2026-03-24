use crate::{
    config::{AppConfig, ValidatorIdentity, ValidatorTarget},
    error::{AppError, AppResult},
    models::{
        BalancePoint, ChainHead, DashboardPayload, DutiesPayload, DutySnapshot, ExecutionHead,
        Incident, RewardsPayload, RuntimeStatus, Severity, ValidatorMeta, ValidatorRecord,
        ValidatorSnapshot,
    },
    rpc::RpcPool,
    storage::Storage,
};
use blst::min_pk::SecretKey;
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::time::timeout;
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Clone)]
struct TrackedValidator {
    index: u64,
    withdrawal_address: Option<String>,
    meta: ValidatorMeta,
}

const TRACKED_TARGETS_STATE_KEY: &str = "tracked_targets_v1";

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedValidatorIdentity {
    pub index: u64,
    pub pubkey: String,
    pub status: String,
    pub withdrawal_address: Option<String>,
    pub withdrawal_credentials: String,
    pub withdrawal_credentials_type: String,
    pub slashed: bool,
    pub effective_balance_gwei: u64,
    pub current_balance_gwei: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlsToExecutionSignRequest {
    pub validator_index: u64,
    pub from_bls_pubkey: String,
    pub to_execution_address: String,
    pub bls_private_key: String,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlsToExecutionSignResult {
    pub validator_index: u64,
    pub from_bls_pubkey: String,
    pub to_execution_address: String,
    pub signing_root: String,
    pub domain: String,
    pub signature: String,
    pub submitted: bool,
    pub submitted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlsToExecutionBatchSignItem {
    pub validator_index: u64,
    pub from_bls_pubkey: String,
    pub bls_private_key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlsToExecutionBatchSignRequest {
    pub to_execution_address: String,
    pub items: Vec<BlsToExecutionBatchSignItem>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlsToExecutionBatchSignItemResult {
    pub validator_index: u64,
    pub from_bls_pubkey: String,
    pub signing_root: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlsToExecutionBatchSignResult {
    pub to_execution_address: String,
    pub domain: String,
    pub submitted: bool,
    pub submitted_at: DateTime<Utc>,
    pub items: Vec<BlsToExecutionBatchSignItemResult>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VoluntaryExitSignRequest {
    pub validator_index: u64,
    pub validator_pubkey: String,
    pub validator_private_key: String,
    pub epoch: Option<u64>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoluntaryExitSignResult {
    pub validator_index: u64,
    pub validator_pubkey: String,
    pub epoch: u64,
    pub signing_root: String,
    pub domain: String,
    pub signature: String,
    pub submitted: bool,
    pub submitted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionActionType {
    ConvertToCompounding,
    Consolidate,
    TopUp,
    FullExit,
    PartialWithdraw,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExecutionActionSubmitRequest {
    pub action: ExecutionActionType,
    pub validator_index: u64,
    pub target_validator_index: Option<u64>,
    pub amount_eth: Option<f64>,
    pub raw_transaction: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecutionActionSubmitResult {
    pub action: ExecutionActionType,
    pub validator_index: u64,
    pub target_validator_index: Option<u64>,
    pub signer: String,
    pub eligible: bool,
    pub preflight_reason: String,
    pub submitted: bool,
    pub tx_hash: Option<String>,
    pub submitted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ValidatorKeygenRequest {
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GeneratedValidatorKeypair {
    pub index: u32,
    pub pubkey: String,
    pub private_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidatorKeygenResult {
    pub generated_at: DateTime<Utc>,
    pub count: u32,
    pub keypairs: Vec<GeneratedValidatorKeypair>,
}

pub struct MonitorEngine {
    storage: Storage,
    beacon_pool: Arc<RpcPool>,
    execution_pool: Arc<RpcPool>,
    payload: Arc<RwLock<DashboardPayload>>,
    targets: Arc<RwLock<Vec<ValidatorTarget>>>,
    tracked: Arc<RwLock<Vec<TrackedValidator>>>,
}

impl MonitorEngine {
    pub fn new(
        config: AppConfig,
        storage: Storage,
        beacon_pool: Arc<RpcPool>,
        execution_pool: Arc<RpcPool>,
    ) -> Self {
        Self {
            targets: Arc::new(RwLock::new(config.validators.clone())),
            tracked: Arc::new(RwLock::new(Vec::new())),
            payload: Arc::new(RwLock::new(DashboardPayload::empty())),
            storage,
            beacon_pool,
            execution_pool,
        }
    }

    pub async fn bootstrap(&self) -> AppResult<()> {
        let beacon_health = self.storage.load_endpoint_health("beacon")?;
        self.beacon_pool.restore_health(&beacon_health);

        let execution_health = self.storage.load_endpoint_health("execution")?;
        self.execution_pool.restore_health(&execution_health);

        if let Some(saved_targets) = self.load_persisted_targets()? {
            *self.targets.write().expect("targets lock poisoned") = saved_targets;
        }

        let resolved = self.resolve_targets().await?;
        info!(count = resolved.len(), "validator targets resolved");
        let tracked_indices = resolved.iter().map(|item| item.index).collect::<Vec<_>>();
        {
            let mut payload = self.payload.write().expect("payload lock poisoned");
            // Keep daemon API startup non-blocking: initial heads are hydrated by the first tick.
            payload.chain_head = None;
            payload.execution_head = None;
            payload.tracked_validator_count = tracked_indices.len() as u64;
            payload.tracked_validator_indices = tracked_indices;
        }

        Ok(())
    }

    pub async fn tick(&self) -> AppResult<Vec<Incident>> {
        let now = Utc::now();
        let mut incidents = Vec::new();
        let critical_step_timeout = Duration::from_secs(14);
        let optional_step_timeout = Duration::from_secs(8);
        let snapshot_timeout = Duration::from_secs(10);

        let head = match timeout(critical_step_timeout, self.fetch_chain_head()).await {
            Ok(Ok(head)) => Some(head),
            Ok(Err(err)) => {
                incidents.push(self.make_incident(
                    Severity::Critical,
                    "CL_HEAD_UNAVAILABLE",
                    "Beacon head is unavailable",
                    err.to_string(),
                    "beacon_head_unavailable",
                ));
                self.latest_payload().chain_head
            }
            Err(_) => {
                incidents.push(self.make_incident(
                    Severity::Critical,
                    "CL_HEAD_TIMEOUT",
                    "Beacon head request timed out",
                    format!(
                        "chain head fetch exceeded {}s",
                        critical_step_timeout.as_secs()
                    ),
                    "beacon_head_timeout",
                ));
                self.latest_payload().chain_head
            }
        };

        let execution_head = match timeout(critical_step_timeout, self.fetch_execution_head()).await
        {
            Ok(Ok(exec)) => Some(exec),
            Ok(Err(err)) => {
                incidents.push(self.make_incident(
                    Severity::Warning,
                    "EL_UNAVAILABLE",
                    "Execution RPC degraded",
                    err.to_string(),
                    "execution_unavailable",
                ));
                self.latest_payload().execution_head
            }
            Err(_) => {
                incidents.push(self.make_incident(
                    Severity::Warning,
                    "EL_TIMEOUT",
                    "Execution RPC timed out",
                    format!(
                        "execution head fetch exceeded {}s",
                        critical_step_timeout.as_secs()
                    ),
                    "execution_timeout",
                ));
                self.latest_payload().execution_head
            }
        };

        let tracked = self.tracked.read().expect("tracked lock poisoned").clone();
        let tracked_validator_indices = tracked.iter().map(|item| item.index).collect::<Vec<_>>();
        let mut fresh_snapshots = Vec::new();
        let mut proposer_slots = HashMap::new();
        let mut in_current_sync = HashSet::new();
        let mut in_next_sync = HashSet::new();

        let epoch_for_snapshots = if let Some(chain_head) = &head {
            proposer_slots = timeout(
                optional_step_timeout,
                self.fetch_next_proposer_slots(chain_head.epoch, tracked.iter().map(|v| v.index)),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();

            if let Ok(Ok((current_sync, next_sync))) = timeout(
                optional_step_timeout,
                self.fetch_sync_committee_membership(
                    chain_head.epoch,
                    tracked.iter().map(|v| v.index),
                ),
            )
            .await
            {
                in_current_sync = current_sync;
                in_next_sync = next_sync;
            }

            let liveness_incidents = timeout(
                optional_step_timeout,
                self.check_previous_epoch_liveness(
                    chain_head.epoch,
                    tracked.iter().map(|v| v.index),
                ),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_else(|| {
                warn!("liveness endpoint failed or timed out");
                Vec::new()
            });
            incidents.extend(liveness_incidents);

            chain_head.epoch
        } else {
            0
        };

        for tracked_validator in tracked.clone() {
            match timeout(
                snapshot_timeout,
                self.fetch_validator_snapshot(
                    &tracked_validator,
                    epoch_for_snapshots,
                    proposer_slots.get(&tracked_validator.index).copied(),
                    in_current_sync.contains(&tracked_validator.index),
                    in_next_sync.contains(&tracked_validator.index),
                ),
            )
            .await
            {
                Ok(Ok(snapshot)) => fresh_snapshots.push(snapshot),
                Ok(Err(err)) => {
                    incidents.push(self.make_incident(
                        Severity::Warning,
                        "VALIDATOR_FETCH_FAILED",
                        "Failed to fetch validator state",
                        err.to_string(),
                        "validator_fetch_failed",
                    ));
                }
                Err(_) => {
                    incidents.push(self.make_incident(
                        Severity::Warning,
                        "VALIDATOR_FETCH_TIMEOUT",
                        "Validator state fetch timed out",
                        format!(
                            "validator {} fetch exceeded {}s",
                            tracked_validator.index,
                            snapshot_timeout.as_secs()
                        ),
                        "validator_fetch_timeout",
                    ));
                }
            }
        }

        incidents.extend(self.detect_rpc_degradation());

        self.storage.upsert_registry(
            &fresh_snapshots
                .iter()
                .map(|snapshot| snapshot.record.clone())
                .collect::<Vec<_>>(),
        )?;
        self.storage.insert_snapshots(&fresh_snapshots)?;
        self.storage.insert_incidents(&incidents)?;

        let mut endpoint_health = self.beacon_pool.health_snapshot();
        endpoint_health.extend(self.execution_pool.health_snapshot());
        self.storage.save_endpoint_health(&endpoint_health)?;

        let (hits, misses) = self.beacon_pool.cache_stats();
        let runtime = RuntimeStatus {
            mode: if incidents
                .iter()
                .any(|incident| incident.severity == Severity::Critical)
            {
                "degraded".to_string()
            } else {
                "healthy".to_string()
            },
            updated_at: now,
            rpc_failover_active: self.beacon_pool.has_failover()
                || self.execution_pool.has_failover(),
            cache_hits: hits,
            cache_misses: misses,
        };

        let recent_incidents = self.storage.recent_incidents(100)?;
        let previous_payload = self.latest_payload();
        let payload_snapshots = Self::merge_snapshots_with_previous(
            &tracked,
            &fresh_snapshots,
            &previous_payload.validators,
        );

        let payload = DashboardPayload {
            runtime,
            chain_head: head,
            execution_head,
            tracked_validator_count: tracked_validator_indices.len() as u64,
            tracked_validator_indices,
            validators: payload_snapshots,
            incidents: recent_incidents,
            endpoint_health,
        };

        *self.payload.write().expect("payload lock poisoned") = payload;

        Ok(incidents)
    }

    pub fn latest_payload(&self) -> DashboardPayload {
        self.payload.read().expect("payload lock poisoned").clone()
    }

    pub fn duties_payload(&self) -> DutiesPayload {
        const SLOT_DURATION_SECONDS: u64 = 12;

        let payload = self.latest_payload();
        let current_slot = payload.chain_head.as_ref().map(|head| head.slot);
        let current_epoch = payload.chain_head.as_ref().map(|head| head.epoch);

        let validators = payload
            .validators
            .iter()
            .map(|snapshot| {
                let slots_until_proposal = match (current_slot, snapshot.record.next_proposer_slot)
                {
                    (Some(slot), Some(next)) => Some(next as i64 - slot as i64),
                    _ => None,
                };

                let eta_seconds_until_proposal = slots_until_proposal.and_then(|slots| {
                    if slots > 0 {
                        Some((slots as u64) * SLOT_DURATION_SECONDS)
                    } else {
                        None
                    }
                });

                DutySnapshot {
                    validator_index: snapshot.record.validator_index,
                    status: snapshot.record.status.clone(),
                    next_proposer_slot: snapshot.record.next_proposer_slot,
                    slots_until_proposal,
                    eta_seconds_until_proposal,
                    in_current_sync_committee: snapshot.record.in_current_sync_committee,
                    in_next_sync_committee: snapshot.record.in_next_sync_committee,
                    current_balance_gwei: snapshot.record.current_balance_gwei,
                    effective_balance_gwei: snapshot.record.effective_balance_gwei,
                }
            })
            .collect::<Vec<_>>();

        let safe_maintenance_slots = validators
            .iter()
            .filter_map(|snapshot| snapshot.slots_until_proposal)
            .filter(|slots| *slots > 0)
            .map(|slots| slots as u64)
            .min();

        let safe_maintenance_until_slot = match (current_slot, safe_maintenance_slots) {
            (Some(slot), Some(safe_slots)) => Some(slot + safe_slots),
            _ => None,
        };

        DutiesPayload {
            generated_at: Utc::now(),
            current_slot,
            current_epoch,
            slot_duration_seconds: SLOT_DURATION_SECONDS,
            safe_maintenance_slots,
            safe_maintenance_until_slot,
            validators,
        }
    }

    pub fn rewards_payload(
        &self,
        validator_index: u64,
        history_window_hours: u32,
    ) -> AppResult<RewardsPayload> {
        let history_window_hours = history_window_hours.clamp(1, 24 * 7);
        let payload = self.latest_payload();
        let from_payload = payload
            .validators
            .iter()
            .find(|snapshot| snapshot.record.validator_index == validator_index)
            .cloned();

        let latest = if let Some(snapshot) = from_payload {
            snapshot
        } else if let Some(snapshot) = self
            .storage
            .latest_snapshot_for_validator(validator_index)?
        {
            snapshot
        } else {
            return Err(AppError::NotFound(format!(
                "no snapshot found for validator {validator_index}"
            )));
        };

        let one_hour_before = self
            .storage
            .snapshot_before(validator_index, Utc::now() - chrono::Duration::hours(1))?;
        let twenty_four_before = self
            .storage
            .snapshot_before(validator_index, Utc::now() - chrono::Duration::hours(24))?;
        let seven_days_before = self.storage.snapshot_before(
            validator_index,
            Utc::now() - chrono::Duration::hours(24 * 7),
        )?;
        let projection_baseline = self.storage.oldest_snapshot_since(validator_index, 24)?;

        let history_limit = (history_window_hours as usize * 60).clamp(120, 1200);

        let history = self
            .storage
            .snapshot_history_since(validator_index, history_window_hours as i64, history_limit)?
            .into_iter()
            .map(|snapshot| BalancePoint {
                observed_at: snapshot.observed_at,
                balance_gwei: snapshot.record.current_balance_gwei,
            })
            .collect::<Vec<_>>();

        let missed_attestations_24h = self
            .storage
            .count_missed_attestations_since(validator_index, 24)?;
        let missed_attestations_7d = self
            .storage
            .count_missed_attestations_since(validator_index, 24 * 7)?;
        let missed_attestation_streak = self.storage.missed_attestation_streak(validator_index)?;

        let projection_status = latest.record.status.to_lowercase();
        let projection_is_active =
            projection_status.contains("active") && !projection_status.contains("exiting");
        let projection_is_unavailable =
            !projection_is_active || latest.record.current_balance_gwei == 0;

        let (projection_state, projection_basis_hours, projection_daily_gwei) =
            if projection_is_unavailable {
                ("unavailable".to_string(), None, None)
            } else if let Some(baseline) = projection_baseline.as_ref() {
                let basis_seconds = (latest.observed_at - baseline.observed_at).num_seconds();
                let basis_hours = (basis_seconds.max(0) as f64) / 3600.0;

                if basis_hours >= 6.0 {
                    let delta_gwei =
                        latest.record.current_balance_gwei as f64 - baseline.record.current_balance_gwei as f64;
                    let projected_daily_gwei =
                        ((delta_gwei / basis_hours) * 24.0).round() as i64;
                    let state = if basis_hours >= 24.0 {
                        "stable"
                    } else {
                        "preliminary"
                    };
                    (state.to_string(), Some(basis_hours), Some(projected_daily_gwei))
                } else {
                    ("warming_up".to_string(), Some(basis_hours), None)
                }
            } else {
                ("warming_up".to_string(), None, None)
            };

        Ok(RewardsPayload {
            generated_at: Utc::now(),
            validator_index,
            history_window_hours,
            status: latest.record.status.clone(),
            withdrawal_address: latest.record.withdrawal_address.clone(),
            current_balance_gwei: latest.record.current_balance_gwei,
            effective_balance_gwei: latest.record.effective_balance_gwei,
            delta_1h_gwei: gwei_delta(
                latest.record.current_balance_gwei,
                one_hour_before
                    .as_ref()
                    .map(|snapshot| snapshot.record.current_balance_gwei),
            ),
            delta_24h_gwei: gwei_delta(
                latest.record.current_balance_gwei,
                twenty_four_before
                    .as_ref()
                    .map(|snapshot| snapshot.record.current_balance_gwei),
            ),
            delta_7d_gwei: gwei_delta(
                latest.record.current_balance_gwei,
                seven_days_before
                    .as_ref()
                    .map(|snapshot| snapshot.record.current_balance_gwei),
            ),
            projection_state,
            projection_basis_hours,
            projection_daily_gwei,
            missed_attestations_24h,
            missed_attestations_7d,
            missed_attestation_streak,
            history,
        })
    }

    pub async fn import_validator(&self, target: ValidatorTarget) -> AppResult<()> {
        {
            let mut targets = self.targets.write().expect("targets lock poisoned");
            if !target.id.trim().eq_ignore_ascii_case("12345") {
                targets.retain(|existing| !is_seed_placeholder(existing));
            }

            let mut replaced = false;
            for existing in targets.iter_mut() {
                if existing.id.trim().eq_ignore_ascii_case(target.id.trim()) {
                    *existing = target.clone();
                    replaced = true;
                    break;
                }
            }

            if !replaced {
                targets.push(target);
            }
        }
        self.persist_targets()?;

        let resolved = self.resolve_targets().await?;
        let tracked_indices = resolved.iter().map(|item| item.index).collect::<Vec<_>>();
        {
            let mut payload = self.payload.write().expect("payload lock poisoned");
            payload.tracked_validator_count = tracked_indices.len() as u64;
            payload.tracked_validator_indices = tracked_indices;
        }
        Ok(())
    }

    pub async fn resolve_validator_input(
        &self,
        input: &str,
    ) -> AppResult<ResolvedValidatorIdentity> {
        let identity = ValidatorIdentity::from_input(input)?;
        let query = match identity {
            ValidatorIdentity::Index(index) => index.to_string(),
            ValidatorIdentity::Pubkey(pubkey) => pubkey,
            ValidatorIdentity::WithdrawalAddress(_) => {
                return Err(AppError::Config(
                    "onboarding supports validator index or validator pubkey only".to_string(),
                ))
            }
        };

        let endpoint = format!("/eth/v1/beacon/states/head/validators/{query}");
        let response: BeaconValidatorResponse =
            self.beacon_pool.beacon_get(&endpoint, true).await?;

        Ok(ResolvedValidatorIdentity {
            index: parse_u64(&response.data.index)?,
            pubkey: response.data.validator.pubkey,
            status: response.data.status,
            withdrawal_address: withdrawal_address_from_credentials(
                &response.data.validator.withdrawal_credentials,
            ),
            withdrawal_credentials: response.data.validator.withdrawal_credentials.clone(),
            withdrawal_credentials_type: withdrawal_credentials_type(
                &response.data.validator.withdrawal_credentials,
            ),
            slashed: response.data.validator.slashed,
            effective_balance_gwei: parse_u64(&response.data.validator.effective_balance)?,
            current_balance_gwei: parse_u64(&response.data.balance)?,
        })
    }

    pub fn generate_validator_keypairs(&self, count: u32) -> AppResult<ValidatorKeygenResult> {
        let requested = count.clamp(1, 16);
        let mut keypairs = Vec::with_capacity(requested as usize);

        for index in 0..requested {
            let mut ikm = [0_u8; 32];
            OsRng.fill_bytes(&mut ikm);

            let secret_key = SecretKey::key_gen(&ikm, &[]).map_err(|_| {
                AppError::UnexpectedResponse("failed to generate BLS secret key".to_string())
            })?;
            let pubkey = secret_key.sk_to_pk();

            keypairs.push(GeneratedValidatorKeypair {
                index: index + 1,
                pubkey: hex_prefixed(&pubkey.to_bytes()),
                private_key: hex_prefixed(&secret_key.to_bytes()),
            });
        }

        Ok(ValidatorKeygenResult {
            generated_at: Utc::now(),
            count: keypairs.len() as u32,
            keypairs,
        })
    }

    pub async fn sign_and_submit_bls_to_execution_change(
        &self,
        request: BlsToExecutionSignRequest,
    ) -> AppResult<BlsToExecutionSignResult> {
        let from_pubkey = parse_hex_fixed::<48>(&request.from_bls_pubkey, "from_bls_pubkey")?;
        let to_execution_address =
            parse_hex_fixed::<20>(&request.to_execution_address, "to_execution_address")?;
        let mut private_key_bytes =
            parse_hex_fixed::<32>(&request.bls_private_key, "bls_private_key")?;

        let validator_endpoint = format!(
            "/eth/v1/beacon/states/head/validators/{}",
            request.validator_index
        );
        let validator: BeaconValidatorResponse = self
            .beacon_pool
            .beacon_get(&validator_endpoint, false)
            .await?;
        let validator_pubkey = validator.data.validator.pubkey.to_lowercase();
        let requested_pubkey = hex_prefixed(&from_pubkey);

        if validator_pubkey != requested_pubkey {
            return Err(AppError::Config(format!(
                "from_bls_pubkey does not match validator {} beacon record",
                request.validator_index
            )));
        }

        let withdrawal_credentials = validator
            .data
            .validator
            .withdrawal_credentials
            .to_lowercase();
        if !withdrawal_credentials.starts_with("0x00") {
            return Err(AppError::Config(
                "validator withdrawal credentials are not 0x00, change already applied or not eligible"
                    .to_string(),
            ));
        }

        let genesis: BeaconGenesisResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/beacon/genesis", true)
            .await?;
        let genesis_fork_version =
            parse_hex_fixed::<4>(&genesis.data.genesis_fork_version, "genesis_fork_version")?;
        let genesis_validators_root = parse_hex_fixed::<32>(
            &genesis.data.genesis_validators_root,
            "genesis_validators_root",
        )?;

        let message_root = bls_to_execution_change_root(
            request.validator_index,
            &from_pubkey,
            &to_execution_address,
        );
        let domain = bls_to_execution_domain(genesis_fork_version, genesis_validators_root);
        let signing_root = signing_root(message_root, domain);

        let secret_key = SecretKey::from_bytes(&private_key_bytes)
            .map_err(|_| AppError::Config("invalid BLS private key bytes".to_string()))?;
        private_key_bytes.fill(0);

        let derived_pubkey = secret_key.sk_to_pk().to_bytes();
        if derived_pubkey != from_pubkey {
            return Err(AppError::Config(
                "private key does not match from_bls_pubkey".to_string(),
            ));
        }

        let signature = secret_key.sign(
            &signing_root,
            b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_",
            &[],
        );
        let signature_bytes = signature.to_bytes();

        if !request.dry_run {
            let body = json!({
                "changes": [
                    {
                        "message": {
                            "validator_index": request.validator_index.to_string(),
                            "from_bls_pubkey": requested_pubkey.clone(),
                            "to_execution_address": hex_prefixed(&to_execution_address),
                        },
                        "signature": hex_prefixed(&signature_bytes),
                    }
                ]
            });

            let _: Value = self
                .beacon_pool
                .beacon_post("/eth/v1/beacon/pool/bls_to_execution_changes", body)
                .await?;
        }

        Ok(BlsToExecutionSignResult {
            validator_index: request.validator_index,
            from_bls_pubkey: requested_pubkey,
            to_execution_address: hex_prefixed(&to_execution_address),
            signing_root: hex_prefixed(&signing_root),
            domain: hex_prefixed(&domain),
            signature: hex_prefixed(&signature_bytes),
            submitted: !request.dry_run,
            submitted_at: Utc::now(),
        })
    }

    pub async fn sign_and_submit_bls_to_execution_change_batch(
        &self,
        request: BlsToExecutionBatchSignRequest,
    ) -> AppResult<BlsToExecutionBatchSignResult> {
        if request.items.is_empty() {
            return Err(AppError::Config("batch items cannot be empty".to_string()));
        }
        if request.items.len() > 64 {
            return Err(AppError::Config(
                "batch size cannot exceed 64 operations".to_string(),
            ));
        }

        let normalized_to_execution_address = hex_prefixed(&parse_hex_fixed::<20>(
            &request.to_execution_address,
            "to_execution_address",
        )?);

        let mut signed_items = Vec::with_capacity(request.items.len());
        let mut domain = String::new();

        for item in request.items {
            let signed = self
                .sign_and_submit_bls_to_execution_change(BlsToExecutionSignRequest {
                    validator_index: item.validator_index,
                    from_bls_pubkey: item.from_bls_pubkey,
                    to_execution_address: normalized_to_execution_address.clone(),
                    bls_private_key: item.bls_private_key,
                    dry_run: true,
                })
                .await?;

            if domain.is_empty() {
                domain = signed.domain.clone();
            } else if domain != signed.domain {
                return Err(AppError::UnexpectedResponse(
                    "domain mismatch detected while building batch bls change".to_string(),
                ));
            }

            signed_items.push(signed);
        }

        if !request.dry_run {
            let changes = signed_items
                .iter()
                .map(|item| {
                    json!({
                        "message": {
                            "validator_index": item.validator_index.to_string(),
                            "from_bls_pubkey": item.from_bls_pubkey,
                            "to_execution_address": normalized_to_execution_address,
                        },
                        "signature": item.signature,
                    })
                })
                .collect::<Vec<_>>();

            let _: Value = self
                .beacon_pool
                .beacon_post(
                    "/eth/v1/beacon/pool/bls_to_execution_changes",
                    json!({ "changes": changes }),
                )
                .await?;
        }

        Ok(BlsToExecutionBatchSignResult {
            to_execution_address: normalized_to_execution_address,
            domain,
            submitted: !request.dry_run,
            submitted_at: Utc::now(),
            items: signed_items
                .into_iter()
                .map(|item| BlsToExecutionBatchSignItemResult {
                    validator_index: item.validator_index,
                    from_bls_pubkey: item.from_bls_pubkey,
                    signing_root: item.signing_root,
                    signature: item.signature,
                })
                .collect(),
        })
    }

    pub async fn sign_and_submit_consensus_exit(
        &self,
        request: VoluntaryExitSignRequest,
    ) -> AppResult<VoluntaryExitSignResult> {
        let validator_pubkey =
            parse_hex_fixed::<48>(&request.validator_pubkey, "validator_pubkey")?;
        let mut private_key_bytes =
            parse_hex_fixed::<32>(&request.validator_private_key, "validator_private_key")?;
        let normalized_validator_pubkey = hex_prefixed(&validator_pubkey);

        let validator_endpoint = format!(
            "/eth/v1/beacon/states/head/validators/{}",
            request.validator_index
        );
        let validator: BeaconValidatorResponse = self
            .beacon_pool
            .beacon_get(&validator_endpoint, false)
            .await?;

        if validator.data.validator.pubkey.to_lowercase() != normalized_validator_pubkey {
            return Err(AppError::Config(format!(
                "validator_pubkey does not match validator {} beacon record",
                request.validator_index
            )));
        }

        let status = validator.data.status.to_lowercase();
        if status.contains("exiting") {
            return Err(AppError::Config(
                "validator is already in exit queue".to_string(),
            ));
        }
        if status.contains("exited") || status.contains("withdrawal_done") {
            return Err(AppError::Config("validator is already exited".to_string()));
        }
        if !status.contains("active") {
            return Err(AppError::Config(format!(
                "validator status {} is not eligible for voluntary exit",
                validator.data.status
            )));
        }
        if validator.data.validator.slashed {
            return Err(AppError::Config(
                "validator is slashed and cannot perform voluntary exit".to_string(),
            ));
        }

        let chain_head: BeaconHeadResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/beacon/headers/head", false)
            .await?;
        let spec: BeaconSpecResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/config/spec", true)
            .await?;
        let slots_per_epoch = spec_u64(&spec.data, "SLOTS_PER_EPOCH")?;
        let chain_slot = parse_u64(&chain_head.data.header.message.slot)?;
        let chain_epoch = chain_slot / slots_per_epoch;

        let target_epoch = request.epoch.unwrap_or(chain_epoch);
        if target_epoch > chain_epoch + 2 {
            return Err(AppError::Config(format!(
                "target exit epoch {target_epoch} is too far in the future (chain epoch {chain_epoch})"
            )));
        }

        let activation_epoch = parse_epoch_optional(&validator.data.validator.activation_epoch)?
            .ok_or_else(|| {
                AppError::Config(
                    "validator activation epoch is unknown, cannot validate exit eligibility"
                        .to_string(),
                )
            })?;
        let shard_committee_period =
            spec_u64_optional(&spec.data, "SHARD_COMMITTEE_PERIOD").unwrap_or(256);
        if target_epoch < activation_epoch.saturating_add(shard_committee_period) {
            return Err(AppError::Config(format!(
                "validator must be active for at least {shard_committee_period} epochs before voluntary exit (activation_epoch={activation_epoch}, target_epoch={target_epoch})"
            )));
        }

        let fork: BeaconForkResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/beacon/states/head/fork", true)
            .await?;
        let current_fork_version =
            parse_hex_fixed::<4>(&fork.data.current_version, "current_fork_version")?;

        let genesis: BeaconGenesisResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/beacon/genesis", true)
            .await?;
        let genesis_validators_root = parse_hex_fixed::<32>(
            &genesis.data.genesis_validators_root,
            "genesis_validators_root",
        )?;

        let message_root = voluntary_exit_root(target_epoch, request.validator_index);
        let domain = voluntary_exit_domain(current_fork_version, genesis_validators_root);
        let signing_root = signing_root(message_root, domain);

        let secret_key = SecretKey::from_bytes(&private_key_bytes)
            .map_err(|_| AppError::Config("invalid validator private key bytes".to_string()))?;
        private_key_bytes.fill(0);

        let derived_pubkey = secret_key.sk_to_pk().to_bytes();
        if derived_pubkey != validator_pubkey {
            return Err(AppError::Config(
                "private key does not match validator_pubkey".to_string(),
            ));
        }

        let signature = secret_key.sign(
            &signing_root,
            b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_",
            &[],
        );
        let signature_bytes = signature.to_bytes();

        if !request.dry_run {
            let _: Value = self
                .beacon_pool
                .beacon_post(
                    "/eth/v1/beacon/pool/voluntary_exits",
                    json!({
                        "message": {
                            "epoch": target_epoch.to_string(),
                            "validator_index": request.validator_index.to_string(),
                        },
                        "signature": hex_prefixed(&signature_bytes),
                    }),
                )
                .await?;
        }

        Ok(VoluntaryExitSignResult {
            validator_index: request.validator_index,
            validator_pubkey: normalized_validator_pubkey,
            epoch: target_epoch,
            signing_root: hex_prefixed(&signing_root),
            domain: hex_prefixed(&domain),
            signature: hex_prefixed(&signature_bytes),
            submitted: !request.dry_run,
            submitted_at: Utc::now(),
        })
    }

    pub async fn submit_execution_action(
        &self,
        request: ExecutionActionSubmitRequest,
    ) -> AppResult<ExecutionActionSubmitResult> {
        let source_endpoint = format!(
            "/eth/v1/beacon/states/head/validators/{}",
            request.validator_index
        );
        let source: BeaconValidatorResponse =
            self.beacon_pool.beacon_get(&source_endpoint, false).await?;
        let source_status = source.data.status.to_lowercase();
        let source_withdrawal_type =
            withdrawal_credentials_type(&source.data.validator.withdrawal_credentials);
        let source_slashed = source.data.validator.slashed;
        let source_balance_gwei = parse_u64(&source.data.balance)?;

        let is_active_like = source_status.contains("active") && !source_status.contains("exiting");
        let is_exited =
            source_status.contains("exited") || source_status.contains("withdrawal_done");
        let in_exit_flow = source_status.contains("exiting");

        let (eligible, preflight_reason) = match request.action {
            ExecutionActionType::ConvertToCompounding => {
                if source_withdrawal_type != "0x01" {
                    (
                        false,
                        format!("requires 0x01 credentials (current {source_withdrawal_type})"),
                    )
                } else if source_slashed {
                    (false, "validator is slashed".to_string())
                } else if !is_active_like {
                    (
                        false,
                        format!(
                            "validator status {} is not active_ongoing",
                            source.data.status
                        ),
                    )
                } else {
                    (
                        true,
                        "eligible; pending-manual-withdrawal check is performed on-chain"
                            .to_string(),
                    )
                }
            }
            ExecutionActionType::Consolidate => {
                let Some(target_index) = request.target_validator_index else {
                    return Err(AppError::Config(
                        "target_validator_index is required for consolidate".to_string(),
                    ));
                };
                if target_index == request.validator_index {
                    return Err(AppError::Config(
                        "target_validator_index must differ from validator_index".to_string(),
                    ));
                }

                let target_endpoint =
                    format!("/eth/v1/beacon/states/head/validators/{target_index}");
                let target: BeaconValidatorResponse =
                    self.beacon_pool.beacon_get(&target_endpoint, false).await?;
                let target_withdrawal_type =
                    withdrawal_credentials_type(&target.data.validator.withdrawal_credentials);

                if source_withdrawal_type != "0x01" && source_withdrawal_type != "0x02" {
                    (
                        false,
                        format!(
                            "source requires 0x01/0x02 credentials (current {source_withdrawal_type})"
                        ),
                    )
                } else if target_withdrawal_type != "0x02" {
                    (
                        false,
                        format!(
                            "target validator #{target_index} must be 0x02 (current {target_withdrawal_type})"
                        ),
                    )
                } else if source_slashed {
                    (false, "source validator is slashed".to_string())
                } else if !is_active_like {
                    (
                        false,
                        format!("source status {} is not active_ongoing", source.data.status),
                    )
                } else {
                    (
                        true,
                        format!(
                            "eligible; source #{} -> target #{}",
                            request.validator_index, target_index
                        ),
                    )
                }
            }
            ExecutionActionType::TopUp => {
                if source_slashed {
                    (false, "validator is slashed".to_string())
                } else if !is_active_like {
                    (
                        false,
                        format!("validator status {} is not active_ongoing", source.data.status),
                    )
                } else {
                    (
                        true,
                        "eligible; top-up is accepted when execution tx is valid".to_string(),
                    )
                }
            }
            ExecutionActionType::FullExit => {
                if source_withdrawal_type != "0x01" && source_withdrawal_type != "0x02" {
                    (
                        false,
                        format!(
                            "requires 0x01/0x02 credentials (current {source_withdrawal_type})"
                        ),
                    )
                } else if source_slashed {
                    (false, "validator is slashed".to_string())
                } else if in_exit_flow {
                    (false, "validator is already in exit queue".to_string())
                } else if is_exited {
                    (false, "validator is already exited".to_string())
                } else {
                    (
                        true,
                        "eligible; execution-layer full exit will enter queue".to_string(),
                    )
                }
            }
            ExecutionActionType::PartialWithdraw => {
                let requested_eth = request.amount_eth.unwrap_or(0.0);
                let requested_gwei = (requested_eth * 1_000_000_000.0).round() as i64;
                let remaining_gwei = source_balance_gwei as i64 - requested_gwei;

                if source_withdrawal_type != "0x02" {
                    (
                        false,
                        format!("requires 0x02 credentials (current {source_withdrawal_type})"),
                    )
                } else if source_slashed {
                    (false, "validator is slashed".to_string())
                } else if requested_gwei <= 0 {
                    (
                        false,
                        "amount_eth must be > 0 for partial withdraw".to_string(),
                    )
                } else if remaining_gwei < 32_000_000_000 {
                    (
                        false,
                        format!(
                            "insufficient post-withdraw balance: {} gwei (< 32 ETH)",
                            remaining_gwei.max(0)
                        ),
                    )
                } else if in_exit_flow {
                    (false, "validator is already in exit queue".to_string())
                } else if is_exited {
                    (false, "validator is already exited".to_string())
                } else {
                    (
                        true,
                        "eligible; partial withdraw will execute through EL queue".to_string(),
                    )
                }
            }
        };

        if !eligible {
            return Err(AppError::Config(preflight_reason));
        }

        let mut tx_hash = None;
        if !request.dry_run {
            let raw_tx = request.raw_transaction.as_deref().ok_or_else(|| {
                AppError::Config("raw_transaction is required when dry_run=false".to_string())
            })?;
            let normalized = raw_tx.trim();
            if !normalized.starts_with("0x") || normalized.len() < 4 {
                return Err(AppError::Config(
                    "raw_transaction must be 0x-prefixed hex".to_string(),
                ));
            }

            let sent_hash: String = self
                .execution_pool
                .execution_rpc("eth_sendRawTransaction", json!([normalized]))
                .await?;
            tx_hash = Some(sent_hash);
        }

        Ok(ExecutionActionSubmitResult {
            action: request.action,
            validator_index: request.validator_index,
            target_validator_index: request.target_validator_index,
            signer: "withdrawal_address_wallet_or_safe".to_string(),
            eligible,
            preflight_reason,
            submitted: !request.dry_run,
            tx_hash,
            submitted_at: Utc::now(),
        })
    }

    pub fn reset_state(&self) {
        self.beacon_pool.clear_cache();
    }

    fn persist_targets(&self) -> AppResult<()> {
        let targets = self.targets.read().expect("targets lock poisoned").clone();
        let encoded = serde_json::to_string(&targets)?;
        self.storage
            .set_state(TRACKED_TARGETS_STATE_KEY, &encoded)?;
        Ok(())
    }

    fn load_persisted_targets(&self) -> AppResult<Option<Vec<ValidatorTarget>>> {
        let Some(raw) = self.storage.get_state(TRACKED_TARGETS_STATE_KEY)? else {
            return Ok(None);
        };

        if raw.trim().is_empty() {
            return Ok(None);
        }

        match serde_json::from_str::<Vec<ValidatorTarget>>(&raw) {
            Ok(decoded) => Ok(Some(decoded)),
            Err(err) => {
                warn!(
                    error = %err,
                    "stored tracked targets are corrupted, falling back to config targets"
                );
                Ok(None)
            }
        }
    }

    async fn resolve_targets(&self) -> AppResult<Vec<TrackedValidator>> {
        let targets = self.targets.read().expect("targets lock poisoned").clone();
        let mut tracked = Vec::new();

        for target in targets {
            match ValidatorIdentity::from_input(&target.id)? {
                ValidatorIdentity::Index(index) => {
                    // Index targets are already fully addressable for snapshot polling.
                    // Keep import/bootstrap fast and resilient even when Beacon RPC is degraded.
                    tracked.push(TrackedValidator {
                        index,
                        withdrawal_address: None,
                        meta: ValidatorMeta {
                            label: target.label.clone(),
                            node: target.node.clone(),
                            cluster: target.cluster.clone(),
                            operator: target.operator.clone(),
                        },
                    });
                }
                ValidatorIdentity::Pubkey(pubkey) => {
                    if let Ok(record) = self.fetch_validator_by_identity(&pubkey, &target).await {
                        tracked.push(record);
                    }
                }
                ValidatorIdentity::WithdrawalAddress(address) => {
                    let mut indices = self
                        .storage
                        .validators_by_withdrawal(&address)
                        .unwrap_or_default();
                    if indices.is_empty() {
                        match self.rebuild_withdrawal_index(&address).await {
                            Ok(found) => {
                                indices = found;
                            }
                            Err(err) => {
                                warn!(
                                    withdrawal_address = %address,
                                    error = %err,
                                    "failed to resolve withdrawal address, continuing without it"
                                );
                                continue;
                            }
                        }
                    }

                    for index in indices {
                        if let Ok(record) = self
                            .fetch_validator_by_identity(&index.to_string(), &target)
                            .await
                        {
                            tracked.push(record);
                        }
                    }
                }
            }
        }

        tracked.sort_by_key(|item| item.index);
        tracked.dedup_by_key(|item| item.index);

        *self.tracked.write().expect("tracked lock poisoned") = tracked.clone();
        Ok(tracked)
    }

    async fn rebuild_withdrawal_index(&self, address: &str) -> AppResult<Vec<u64>> {
        let response: BeaconAllValidatorsResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/beacon/states/head/validators", true)
            .await?;

        let normalized = address.to_lowercase();
        let mut indices = Vec::new();

        for entry in response.data {
            if let Some(found) =
                withdrawal_address_from_credentials(&entry.validator.withdrawal_credentials)
            {
                if found == normalized {
                    indices.push(parse_u64(&entry.index)?);
                }
            }
        }

        if indices.is_empty() {
            return Err(AppError::NotFound(format!(
                "no validators found for withdrawal address {address}"
            )));
        }

        Ok(indices)
    }

    async fn fetch_validator_by_identity(
        &self,
        identity: &str,
        meta: &ValidatorTarget,
    ) -> AppResult<TrackedValidator> {
        let endpoint = format!("/eth/v1/beacon/states/head/validators/{identity}");
        let response: BeaconValidatorResponse =
            self.beacon_pool.beacon_get(&endpoint, true).await?;

        Ok(TrackedValidator {
            index: parse_u64(&response.data.index)?,
            withdrawal_address: withdrawal_address_from_credentials(
                &response.data.validator.withdrawal_credentials,
            ),
            meta: ValidatorMeta {
                label: meta.label.clone(),
                node: meta.node.clone(),
                cluster: meta.cluster.clone(),
                operator: meta.operator.clone(),
            },
        })
    }

    async fn fetch_chain_head(&self) -> AppResult<ChainHead> {
        let header: BeaconHeadResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/beacon/headers/head", false)
            .await?;

        let checkpoints: BeaconFinalityResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/beacon/states/head/finality_checkpoints", false)
            .await?;

        let spec: BeaconSpecResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/config/spec", true)
            .await?;
        let slots_per_epoch = spec_u64(&spec.data, "SLOTS_PER_EPOCH")?;

        let slot = parse_u64(&header.data.header.message.slot)?;
        let epoch = slot / slots_per_epoch;

        Ok(ChainHead {
            slot,
            epoch,
            finalized_epoch: parse_u64(&checkpoints.data.finalized.epoch)?,
        })
    }

    async fn fetch_execution_head(&self) -> AppResult<ExecutionHead> {
        let block_hex: String = self
            .execution_pool
            .execution_rpc("eth_blockNumber", json!([]))
            .await?;
        let peers_hex: String = self
            .execution_pool
            .execution_rpc("net_peerCount", json!([]))
            .await?;

        Ok(ExecutionHead {
            block_number: parse_hex_u64(&block_hex)?,
            peer_count: parse_hex_u64(&peers_hex)?,
        })
    }

    async fn fetch_validator_snapshot(
        &self,
        tracked: &TrackedValidator,
        epoch: u64,
        next_proposer_slot: Option<u64>,
        in_current_sync_committee: bool,
        in_next_sync_committee: bool,
    ) -> AppResult<ValidatorSnapshot> {
        let endpoint = format!("/eth/v1/beacon/states/head/validators/{}", tracked.index);
        let response: BeaconValidatorResponse =
            self.beacon_pool.beacon_get(&endpoint, true).await?;

        Ok(ValidatorSnapshot {
            observed_at: Utc::now(),
            epoch,
            record: ValidatorRecord {
                validator_index: parse_u64(&response.data.index)?,
                pubkey: response.data.validator.pubkey,
                withdrawal_address: withdrawal_address_from_credentials(
                    &response.data.validator.withdrawal_credentials,
                )
                .or_else(|| tracked.withdrawal_address.clone()),
                withdrawal_credentials: Some(
                    response.data.validator.withdrawal_credentials.clone(),
                ),
                withdrawal_credentials_type: Some(withdrawal_credentials_type(
                    &response.data.validator.withdrawal_credentials,
                )),
                status: response.data.status,
                slashed: response.data.validator.slashed,
                activation_eligibility_epoch: parse_epoch_optional(
                    &response.data.validator.activation_eligibility_epoch,
                )?,
                activation_epoch: parse_epoch_optional(&response.data.validator.activation_epoch)?,
                exit_epoch: parse_epoch_optional(&response.data.validator.exit_epoch)?,
                withdrawable_epoch: parse_epoch_optional(
                    &response.data.validator.withdrawable_epoch,
                )?,
                effective_balance_gwei: parse_u64(&response.data.validator.effective_balance)?,
                current_balance_gwei: parse_u64(&response.data.balance)?,
                next_proposer_slot,
                in_current_sync_committee,
                in_next_sync_committee,
                meta: tracked.meta.clone(),
            },
        })
    }

    async fn fetch_next_proposer_slots(
        &self,
        epoch: u64,
        indices: impl Iterator<Item = u64>,
    ) -> AppResult<HashMap<u64, u64>> {
        let tracked = indices.collect::<HashSet<_>>();
        if tracked.is_empty() {
            return Ok(HashMap::new());
        }

        let mut out = HashMap::new();
        for candidate_epoch in [epoch, epoch + 1] {
            let endpoint = format!("/eth/v1/validator/duties/proposer/{candidate_epoch}");
            let response = self
                .beacon_pool
                .beacon_get::<BeaconProposerDutiesResponse>(&endpoint, false)
                .await;

            if let Ok(payload) = response {
                for duty in payload.data {
                    let index = parse_u64(&duty.validator_index)?;
                    if tracked.contains(&index) {
                        let slot = parse_u64(&duty.slot)?;
                        out.entry(index)
                            .and_modify(|existing| {
                                if slot < *existing {
                                    *existing = slot;
                                }
                            })
                            .or_insert(slot);
                    }
                }
            }
        }

        Ok(out)
    }

    async fn fetch_sync_committee_membership(
        &self,
        epoch: u64,
        indices: impl Iterator<Item = u64>,
    ) -> AppResult<(HashSet<u64>, HashSet<u64>)> {
        let tracked = indices.collect::<HashSet<_>>();
        if tracked.is_empty() {
            return Ok((HashSet::new(), HashSet::new()));
        }

        let spec: BeaconSpecResponse = self
            .beacon_pool
            .beacon_get("/eth/v1/config/spec", true)
            .await?;
        let period =
            spec_u64_optional(&spec.data, "EPOCHS_PER_SYNC_COMMITTEE_PERIOD").unwrap_or(256);
        let current_period_epoch = (epoch / period) * period;
        let next_period_epoch = current_period_epoch + period;

        let current = self
            .sync_members_for_epoch(current_period_epoch)
            .await
            .unwrap_or_default();
        let next = self
            .sync_members_for_epoch(next_period_epoch)
            .await
            .unwrap_or_default();

        Ok((
            tracked.intersection(&current).copied().collect(),
            tracked.intersection(&next).copied().collect(),
        ))
    }

    async fn sync_members_for_epoch(&self, epoch: u64) -> AppResult<HashSet<u64>> {
        let endpoint = format!("/eth/v1/beacon/states/head/sync_committees?epoch={epoch}");
        let response: BeaconSyncCommitteeResponse =
            self.beacon_pool.beacon_get(&endpoint, true).await?;

        let mut indices = HashSet::new();
        for index in response.data.validators {
            indices.insert(parse_u64(&index)?);
        }
        Ok(indices)
    }

    async fn check_previous_epoch_liveness(
        &self,
        current_epoch: u64,
        indices: impl Iterator<Item = u64>,
    ) -> AppResult<Vec<Incident>> {
        if current_epoch == 0 {
            return Ok(Vec::new());
        }

        let previous_epoch = current_epoch - 1;
        let checkpoint = self
            .storage
            .get_state("last_liveness_epoch")?
            .and_then(|raw| raw.parse::<u64>().ok());

        if checkpoint == Some(previous_epoch) {
            return Ok(Vec::new());
        }

        let validator_ids = indices.map(|index| index.to_string()).collect::<Vec<_>>();
        if validator_ids.is_empty() {
            return Ok(Vec::new());
        }

        let endpoint = format!("/eth/v1/validator/liveness/{previous_epoch}");
        let response: BeaconLivenessResponse = self
            .beacon_pool
            .beacon_post(
                &endpoint,
                Value::Array(validator_ids.into_iter().map(Value::String).collect()),
            )
            .await?;

        let mut incidents = Vec::new();
        for entry in response.data {
            let index = parse_u64(&entry.index)?;
            self.storage
                .save_liveness(previous_epoch, index, entry.is_live)?;

            if !entry.is_live {
                incidents.push(self.make_incident(
                    Severity::Warning,
                    "MISSED_ATTESTATION",
                    "Validator liveness check failed",
                    format!(
                        "validator {index} was not live in epoch {previous_epoch}; likely missed attestation"
                    ),
                    &format!("missed_attestation_{index}_{previous_epoch}"),
                ));
            }
        }

        self.storage
            .set_state("last_liveness_epoch", &previous_epoch.to_string())?;

        Ok(incidents)
    }

    fn detect_rpc_degradation(&self) -> Vec<Incident> {
        let mut incidents = Vec::new();

        for health in self
            .beacon_pool
            .health_snapshot()
            .into_iter()
            .chain(self.execution_pool.health_snapshot().into_iter())
        {
            if health.score < 35.0 {
                incidents.push(self.make_incident(
                    Severity::Warning,
                    "RPC_HEALTH_DEGRADED",
                    "RPC endpoint degraded",
                    format!(
                        "{} ({}) score {:.1}, failures {}, last_error {}",
                        health.name,
                        health.kind,
                        health.score,
                        health.failure_count,
                        health.last_error.unwrap_or_else(|| "unknown".to_string())
                    ),
                    &format!("rpc_degraded_{}_{}", health.kind, health.name),
                ));
            }
        }

        incidents
    }

    fn merge_snapshots_with_previous(
        tracked: &[TrackedValidator],
        fresh_snapshots: &[ValidatorSnapshot],
        previous_snapshots: &[ValidatorSnapshot],
    ) -> Vec<ValidatorSnapshot> {
        let tracked_indices = tracked
            .iter()
            .map(|item| item.index)
            .collect::<HashSet<_>>();
        let mut by_index = previous_snapshots
            .iter()
            .filter(|snapshot| tracked_indices.contains(&snapshot.record.validator_index))
            .cloned()
            .map(|snapshot| (snapshot.record.validator_index, snapshot))
            .collect::<HashMap<_, _>>();

        for snapshot in fresh_snapshots {
            by_index.insert(snapshot.record.validator_index, snapshot.clone());
        }

        tracked
            .iter()
            .filter_map(|validator| by_index.remove(&validator.index))
            .collect()
    }

    fn make_incident(
        &self,
        severity: Severity,
        code: &str,
        message: &str,
        details: String,
        fingerprint: &str,
    ) -> Incident {
        Incident {
            id: Uuid::new_v4().to_string(),
            occurred_at: Utc::now(),
            severity,
            code: code.to_string(),
            message: message.to_string(),
            details,
            fingerprint: fingerprint.to_string(),
            resolved: false,
        }
    }
}

const DOMAIN_BLS_TO_EXECUTION_CHANGE: [u8; 4] = [10, 0, 0, 0];
const DOMAIN_VOLUNTARY_EXIT: [u8; 4] = [4, 0, 0, 0];

fn parse_hex_fixed<const N: usize>(input: &str, field: &str) -> AppResult<[u8; N]> {
    let trimmed = input.trim();
    let normalized = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    if normalized.len() != N * 2 {
        return Err(AppError::Config(format!(
            "{field} must be {expected} bytes hex",
            expected = N
        )));
    }

    let decoded = hex::decode(normalized)
        .map_err(|_| AppError::Config(format!("{field} must be valid hex")))?;
    let mut out = [0_u8; N];
    out.copy_from_slice(&decoded);
    Ok(out)
}

fn hex_prefixed(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn hash(input: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(input);
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn hash_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut buffer = [0_u8; 64];
    buffer[..32].copy_from_slice(&left);
    buffer[32..].copy_from_slice(&right);
    hash(&buffer)
}

fn merkleize(chunks: &[[u8; 32]]) -> [u8; 32] {
    if chunks.is_empty() {
        return [0_u8; 32];
    }

    let mut level = chunks.to_vec();
    let target_len = level.len().next_power_of_two();
    level.resize(target_len, [0_u8; 32]);

    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks_exact(2) {
            next.push(hash_pair(pair[0], pair[1]));
        }
        level = next;
    }

    level[0]
}

fn bytes_root(bytes: &[u8]) -> [u8; 32] {
    let chunk_count = bytes.len().div_ceil(32);
    if chunk_count == 0 {
        return [0_u8; 32];
    }

    let mut chunks = Vec::with_capacity(chunk_count);
    for chunk in bytes.chunks(32) {
        let mut padded = [0_u8; 32];
        padded[..chunk.len()].copy_from_slice(chunk);
        chunks.push(padded);
    }

    merkleize(&chunks)
}

fn uint64_root(value: u64) -> [u8; 32] {
    let mut out = [0_u8; 32];
    out[..8].copy_from_slice(&value.to_le_bytes());
    out
}

fn bls_to_execution_change_root(
    validator_index: u64,
    from_bls_pubkey: &[u8; 48],
    to_execution_address: &[u8; 20],
) -> [u8; 32] {
    merkleize(&[
        uint64_root(validator_index),
        bytes_root(from_bls_pubkey),
        bytes_root(to_execution_address),
    ])
}

fn bls_to_execution_domain(
    genesis_fork_version: [u8; 4],
    genesis_validators_root: [u8; 32],
) -> [u8; 32] {
    compute_domain(
        DOMAIN_BLS_TO_EXECUTION_CHANGE,
        genesis_fork_version,
        genesis_validators_root,
    )
}

fn voluntary_exit_root(epoch: u64, validator_index: u64) -> [u8; 32] {
    merkleize(&[uint64_root(epoch), uint64_root(validator_index)])
}

fn voluntary_exit_domain(
    current_fork_version: [u8; 4],
    genesis_validators_root: [u8; 32],
) -> [u8; 32] {
    compute_domain(
        DOMAIN_VOLUNTARY_EXIT,
        current_fork_version,
        genesis_validators_root,
    )
}

fn compute_domain(
    domain_type: [u8; 4],
    fork_version: [u8; 4],
    genesis_validators_root: [u8; 32],
) -> [u8; 32] {
    let mut version_chunk = [0_u8; 32];
    version_chunk[..4].copy_from_slice(&fork_version);
    let fork_data_root = hash_pair(version_chunk, genesis_validators_root);

    let mut domain = [0_u8; 32];
    domain[..4].copy_from_slice(&domain_type);
    domain[4..].copy_from_slice(&fork_data_root[..28]);
    domain
}

fn signing_root(message_root: [u8; 32], domain: [u8; 32]) -> [u8; 32] {
    hash_pair(message_root, domain)
}

fn parse_u64(input: &str) -> AppResult<u64> {
    input
        .parse::<u64>()
        .map_err(|_| AppError::UnexpectedResponse(format!("invalid u64 string: {input}")))
}

fn parse_epoch_optional(input: &str) -> AppResult<Option<u64>> {
    let value = parse_u64(input)?;
    if value >= u64::MAX - 1_000 {
        return Ok(None);
    }
    Ok(Some(value))
}

fn gwei_delta(current: u64, previous: Option<u64>) -> i64 {
    match previous {
        Some(value) => current as i64 - value as i64,
        None => 0,
    }
}

fn parse_spec_u64(value: &Value) -> Option<u64> {
    match value {
        Value::String(raw) => raw.parse::<u64>().ok(),
        Value::Number(raw) => raw.as_u64(),
        _ => None,
    }
}

fn spec_u64(spec: &HashMap<String, Value>, key: &str) -> AppResult<u64> {
    spec.get(key)
        .and_then(parse_spec_u64)
        .ok_or_else(|| AppError::UnexpectedResponse(format!("missing or invalid {key} in spec")))
}

fn spec_u64_optional(spec: &HashMap<String, Value>, key: &str) -> Option<u64> {
    spec.get(key).and_then(parse_spec_u64)
}

fn parse_hex_u64(input: &str) -> AppResult<u64> {
    let sanitized = input.strip_prefix("0x").unwrap_or(input);
    u64::from_str_radix(sanitized, 16)
        .map_err(|_| AppError::UnexpectedResponse(format!("invalid hex number: {input}")))
}

fn withdrawal_address_from_credentials(credentials: &str) -> Option<String> {
    let normalized = credentials.to_lowercase();
    if (normalized.starts_with("0x01") || normalized.starts_with("0x02")) && normalized.len() == 66
    {
        let addr = &normalized[26..];
        return Some(format!("0x{addr}"));
    }
    None
}

fn withdrawal_credentials_type(credentials: &str) -> String {
    let normalized = credentials.to_lowercase();
    if normalized.len() >= 4 {
        return normalized[..4].to_string();
    }
    "unknown".to_string()
}

fn is_seed_placeholder(target: &ValidatorTarget) -> bool {
    let id = target.id.trim();
    if !id.eq_ignore_ascii_case("12345") {
        return false;
    }

    let label = target.label.as_deref().unwrap_or_default().trim();
    let node = target.node.as_deref().unwrap_or_default().trim();
    let cluster = target.cluster.as_deref().unwrap_or_default().trim();
    let operator = target.operator.as_deref().unwrap_or_default().trim();

    (label.is_empty() || label.eq_ignore_ascii_case("Validator #12345"))
        && (node.is_empty() || node.eq_ignore_ascii_case("Main Node"))
        && (cluster.is_empty() || cluster.eq_ignore_ascii_case("Cluster A"))
        && (operator.is_empty() || operator.eq_ignore_ascii_case("Ops Team"))
}

#[derive(Debug, Deserialize)]
struct BeaconHeadResponse {
    data: BeaconHeadData,
}

#[derive(Debug, Deserialize)]
struct BeaconHeadData {
    header: BeaconHeader,
}

#[derive(Debug, Deserialize)]
struct BeaconHeader {
    message: BeaconHeaderMessage,
}

#[derive(Debug, Deserialize)]
struct BeaconHeaderMessage {
    slot: String,
}

#[derive(Debug, Deserialize)]
struct BeaconFinalityResponse {
    data: BeaconFinalityData,
}

#[derive(Debug, Deserialize)]
struct BeaconFinalityData {
    finalized: BeaconEpochRef,
}

#[derive(Debug, Deserialize)]
struct BeaconEpochRef {
    epoch: String,
}

#[derive(Debug, Deserialize)]
struct BeaconSpecResponse {
    data: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
struct BeaconGenesisResponse {
    data: BeaconGenesisData,
}

#[derive(Debug, Deserialize)]
struct BeaconGenesisData {
    genesis_fork_version: String,
    genesis_validators_root: String,
}

#[derive(Debug, Deserialize)]
struct BeaconForkResponse {
    data: BeaconForkData,
}

#[derive(Debug, Deserialize)]
struct BeaconForkData {
    current_version: String,
}

#[derive(Debug, Deserialize)]
struct BeaconValidatorResponse {
    data: BeaconValidatorData,
}

#[derive(Debug, Deserialize)]
struct BeaconAllValidatorsResponse {
    data: Vec<BeaconValidatorData>,
}

#[derive(Debug, Deserialize)]
struct BeaconValidatorData {
    index: String,
    balance: String,
    status: String,
    validator: BeaconValidator,
}

#[derive(Debug, Deserialize)]
struct BeaconValidator {
    pubkey: String,
    withdrawal_credentials: String,
    effective_balance: String,
    slashed: bool,
    activation_eligibility_epoch: String,
    activation_epoch: String,
    exit_epoch: String,
    withdrawable_epoch: String,
}

#[derive(Debug, Deserialize)]
struct BeaconProposerDutiesResponse {
    data: Vec<BeaconProposerDuty>,
}

#[derive(Debug, Deserialize)]
struct BeaconProposerDuty {
    validator_index: String,
    slot: String,
}

#[derive(Debug, Deserialize)]
struct BeaconSyncCommitteeResponse {
    data: BeaconSyncCommitteeData,
}

#[derive(Debug, Deserialize)]
struct BeaconSyncCommitteeData {
    validators: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct BeaconLivenessResponse {
    data: Vec<BeaconLivenessEntry>,
}

#[derive(Debug, Deserialize)]
struct BeaconLivenessEntry {
    index: String,
    is_live: bool,
}
