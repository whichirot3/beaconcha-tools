use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Critical => "critical",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value.to_lowercase().as_str() {
            "critical" => Self::Critical,
            "warning" => Self::Warning,
            _ => Self::Info,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorMeta {
    pub label: Option<String>,
    pub node: Option<String>,
    pub cluster: Option<String>,
    pub operator: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorRecord {
    pub validator_index: u64,
    pub pubkey: String,
    pub withdrawal_address: Option<String>,
    pub withdrawal_credentials: Option<String>,
    pub withdrawal_credentials_type: Option<String>,
    pub status: String,
    pub slashed: bool,
    pub activation_eligibility_epoch: Option<u64>,
    pub activation_epoch: Option<u64>,
    pub exit_epoch: Option<u64>,
    pub withdrawable_epoch: Option<u64>,
    pub effective_balance_gwei: u64,
    pub current_balance_gwei: u64,
    pub next_proposer_slot: Option<u64>,
    pub in_current_sync_committee: bool,
    pub in_next_sync_committee: bool,
    pub meta: ValidatorMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorSnapshot {
    pub observed_at: DateTime<Utc>,
    pub epoch: u64,
    pub record: ValidatorRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Incident {
    pub id: String,
    pub occurred_at: DateTime<Utc>,
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub details: String,
    pub fingerprint: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointHealth {
    pub name: String,
    pub url: String,
    pub kind: String,
    pub score: f64,
    pub success_count: u64,
    pub failure_count: u64,
    pub latency_ms: u64,
    pub last_error: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainHead {
    pub slot: u64,
    pub epoch: u64,
    pub finalized_epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionHead {
    pub block_number: u64,
    pub peer_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub mode: String,
    pub updated_at: DateTime<Utc>,
    pub rpc_failover_active: bool,
    pub cache_hits: u64,
    pub cache_misses: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardPayload {
    pub runtime: RuntimeStatus,
    pub chain_head: Option<ChainHead>,
    pub execution_head: Option<ExecutionHead>,
    pub tracked_validator_count: u64,
    pub tracked_validator_indices: Vec<u64>,
    pub validators: Vec<ValidatorSnapshot>,
    pub incidents: Vec<Incident>,
    pub endpoint_health: Vec<EndpointHealth>,
}

impl DashboardPayload {
    pub fn empty() -> Self {
        Self {
            runtime: RuntimeStatus {
                mode: "initializing".to_string(),
                updated_at: Utc::now(),
                rpc_failover_active: false,
                cache_hits: 0,
                cache_misses: 0,
            },
            chain_head: None,
            execution_head: None,
            tracked_validator_count: 0,
            tracked_validator_indices: Vec::new(),
            validators: Vec::new(),
            incidents: Vec::new(),
            endpoint_health: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DutySnapshot {
    pub validator_index: u64,
    pub status: String,
    pub next_proposer_slot: Option<u64>,
    pub slots_until_proposal: Option<i64>,
    pub eta_seconds_until_proposal: Option<u64>,
    pub in_current_sync_committee: bool,
    pub in_next_sync_committee: bool,
    pub current_balance_gwei: u64,
    pub effective_balance_gwei: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DutiesPayload {
    pub generated_at: DateTime<Utc>,
    pub current_slot: Option<u64>,
    pub current_epoch: Option<u64>,
    pub slot_duration_seconds: u64,
    pub safe_maintenance_slots: Option<u64>,
    pub safe_maintenance_until_slot: Option<u64>,
    pub validators: Vec<DutySnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalancePoint {
    pub observed_at: DateTime<Utc>,
    pub balance_gwei: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewardsPayload {
    pub generated_at: DateTime<Utc>,
    pub validator_index: u64,
    pub history_window_hours: u32,
    pub status: String,
    pub withdrawal_address: Option<String>,
    pub current_balance_gwei: u64,
    pub effective_balance_gwei: u64,
    pub delta_1h_gwei: i64,
    pub delta_24h_gwei: i64,
    pub delta_7d_gwei: i64,
    pub projection_state: String,
    pub projection_basis_hours: Option<f64>,
    pub projection_daily_gwei: Option<i64>,
    pub missed_attestations_24h: u64,
    pub missed_attestations_7d: u64,
    pub missed_attestation_streak: u64,
    pub history: Vec<BalancePoint>,
}
