use anyhow::Context;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use beaconops_core::{
    config::{AppConfig, ValidatorTarget},
    keymanager::{
        KeymanagerDeleteKeystoresRequest, KeymanagerDeleteRemoteKeysRequest, KeymanagerEngine,
        KeymanagerImportKeystoresRequest, KeymanagerImportRemoteKeysRequest,
    },
    monitor::{
        BlsToExecutionBatchSignRequest, BlsToExecutionSignRequest, ExecutionActionSubmitRequest,
        ValidatorKeygenRequest, VoluntaryExitSignRequest,
    },
    AlertEngine, AppError, MonitorEngine, Storage,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::{path::Path as FsPath, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    signal,
    sync::Mutex,
    time::{sleep, timeout},
};
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

#[derive(Debug, Parser)]
#[command(
    name = "beaconops-daemon",
    about = "Beaconcha Tools headless monitoring daemon"
)]
struct Cli {
    #[arg(short, long, default_value = "config/beaconops.example.toml")]
    config: String,
}

#[derive(Clone)]
struct AppState {
    monitor: Arc<MonitorEngine>,
    keymanager: Option<Arc<KeymanagerEngine>>,
    alert_engine: Arc<AlertEngine>,
    tick_lock: Arc<Mutex<()>>,
    tick_timeout: Duration,
    log_directory: String,
}

#[derive(Debug, Serialize)]
struct ErrorSheet {
    title: String,
    message: String,
    error_code: String,
    technical_details: String,
    retryable: bool,
    actions: Vec<String>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    title: String,
    message: String,
    error_code: String,
    technical_details: String,
    retryable: bool,
}

impl ApiError {
    fn internal(
        error_code: &str,
        message: &str,
        technical_details: String,
        retryable: bool,
    ) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            title: "Beaconcha Tools System Error".to_string(),
            message: message.to_string(),
            error_code: error_code.to_string(),
            technical_details,
            retryable,
        }
    }

    fn bad_request(error_code: &str, message: &str, technical_details: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            title: "Beaconcha Tools Validation Error".to_string(),
            message: message.to_string(),
            error_code: error_code.to_string(),
            technical_details,
            retryable: false,
        }
    }

    fn not_found(error_code: &str, message: &str, technical_details: String) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            title: "Beaconcha Tools Validation Error".to_string(),
            message: message.to_string(),
            error_code: error_code.to_string(),
            technical_details,
            retryable: false,
        }
    }

    fn service_unavailable(error_code: &str, message: &str, technical_details: String) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            title: "Beaconcha Tools Service Unavailable".to_string(),
            message: message.to_string(),
            error_code: error_code.to_string(),
            technical_details,
            retryable: false,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(ErrorSheet {
            title: self.title,
            message: self.message,
            error_code: self.error_code,
            technical_details: self.technical_details,
            retryable: self.retryable,
            actions: vec![
                "retry".to_string(),
                "copy_diagnostics".to_string(),
                "open_logs".to_string(),
                "reset_state".to_string(),
                "report_issue".to_string(),
            ],
        });

        (self.status, body).into_response()
    }
}

#[tokio::main(worker_threads = 4)]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = AppConfig::load(&cli.config)
        .with_context(|| format!("failed to load config: {}", cli.config))?;

    init_tracing(&config.daemon.log_directory)?;
    info!("starting Beaconcha Tools daemon");

    let storage = Storage::open(&config.daemon.database_path)
        .with_context(|| "failed to initialize SQLite storage")?;

    let beacon_pool = Arc::new(beaconops_core::rpc::RpcPool::new(
        beaconops_core::rpc::RpcKind::Beacon,
        &config.beacon.endpoints,
        config.daemon.request_timeout_ms,
        config.daemon.max_retries,
        config.daemon.cache_ttl_seconds,
    )?);

    let execution_pool = Arc::new(beaconops_core::rpc::RpcPool::new(
        beaconops_core::rpc::RpcKind::Execution,
        &config.execution.endpoints,
        config.daemon.request_timeout_ms,
        config.daemon.max_retries,
        config.daemon.cache_ttl_seconds,
    )?);

    let monitor = Arc::new(MonitorEngine::new(
        config.clone(),
        storage.clone(),
        beacon_pool,
        execution_pool,
    ));
    monitor.bootstrap().await?;
    let keymanager = KeymanagerEngine::new(&config.keymanager)?.map(Arc::new);

    let alert_engine = Arc::new(AlertEngine::new(storage.clone(), config.telegram.clone())?);
    let tick_lock = Arc::new(Mutex::new(()));
    let timeout_units = (config.daemon.request_timeout_ms / 1_000).max(4);
    let tick_timeout = Duration::from_secs((timeout_units * 4).max(20));

    let monitor_loop = monitor.clone();
    let alert_loop = alert_engine.clone();
    let tick_lock_loop = tick_lock.clone();
    let tick_timeout_loop = tick_timeout;
    let interval_seconds = config.daemon.poll_interval_seconds.max(5);
    tokio::spawn(async move {
        loop {
            let _guard = tick_lock_loop.lock().await;
            match timeout(tick_timeout_loop, monitor_loop.tick()).await {
                Ok(Ok(incidents)) => {
                    let payload = monitor_loop.latest_payload();
                    alert_loop.process(&incidents, &payload).await;
                }
                Ok(Err(err)) => {
                    error!(error = %err, "monitor tick failed");
                }
                Err(_) => {
                    error!(
                        timeout_seconds = tick_timeout_loop.as_secs(),
                        "monitor tick timed out"
                    );
                }
            }
            drop(_guard);

            sleep(Duration::from_secs(interval_seconds)).await;
        }
    });

    let state = AppState {
        monitor,
        keymanager,
        alert_engine,
        tick_lock,
        tick_timeout,
        log_directory: config.daemon.log_directory.clone(),
    };

    let app = Router::new()
        .route("/api/v1/status", get(status_handler))
        .route("/api/v1/dashboard", get(dashboard_handler))
        .route("/api/v1/duties", get(duties_handler))
        .route("/api/v1/rewards/{validator_index}", get(rewards_handler))
        .route("/api/v1/validators", get(validators_handler))
        .route(
            "/api/v1/validators/resolve/{id}",
            get(resolve_validator_handler),
        )
        .route("/api/v1/incidents", get(incidents_handler))
        .route("/api/v1/health", get(health_handler))
        .route("/api/v1/help", get(help_handler))
        .route("/api/v1/import", post(import_handler))
        .route("/api/v1/actions/retry", post(retry_handler))
        .route("/api/v1/actions/reset-state", post(reset_state_handler))
        .route(
            "/api/v1/ops/bls-change/sign-submit",
            post(bls_change_sign_submit_handler),
        )
        .route(
            "/api/v1/ops/bls-change/batch-sign-submit",
            post(bls_change_batch_sign_submit_handler),
        )
        .route(
            "/api/v1/ops/consensus-exit/sign-submit",
            post(consensus_exit_sign_submit_handler),
        )
        .route(
            "/api/v1/ops/execution-action/submit",
            post(execution_action_submit_handler),
        )
        .route(
            "/api/v1/ops/validator-keys/generate",
            post(validator_keys_generate_handler),
        )
        .route(
            "/api/v1/keymanager/endpoints",
            get(keymanager_endpoints_handler),
        )
        .route(
            "/api/v1/keymanager/keystores",
            get(keymanager_keystores_handler),
        )
        .route(
            "/api/v1/keymanager/keystores/import",
            post(keymanager_keystores_import_handler),
        )
        .route(
            "/api/v1/keymanager/keystores/delete",
            post(keymanager_keystores_delete_handler),
        )
        .route(
            "/api/v1/keymanager/remotekeys",
            get(keymanager_remotekeys_handler),
        )
        .route(
            "/api/v1/keymanager/remotekeys/import",
            post(keymanager_remotekeys_import_handler),
        )
        .route(
            "/api/v1/keymanager/remotekeys/delete",
            post(keymanager_remotekeys_delete_handler),
        )
        .route("/api/v1/logs", get(logs_handler))
        .layer(
            CorsLayer::new()
                .allow_methods(Any)
                .allow_headers(Any)
                .allow_origin(Any),
        )
        .with_state(state);

    let listener = TcpListener::bind(&config.daemon.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", config.daemon.bind_addr))?;

    info!(address = %config.daemon.bind_addr, "daemon API listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("axum server failed")?;

    Ok(())
}

async fn status_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let payload = state.monitor.latest_payload();
    Json(serde_json::json!({
        "runtime": payload.runtime,
        "chain_head": payload.chain_head,
        "execution_head": payload.execution_head,
        "validators_count": payload.tracked_validator_count,
        "validators_with_metrics_count": payload.validators.len(),
        "incidents_count": payload.incidents.len(),
    }))
}

fn contains_cyrillic(value: &str) -> bool {
    value.chars().any(|ch| {
        matches!(
            ch,
            '\u{0400}'..='\u{04FF}'
                | '\u{0500}'..='\u{052F}'
                | '\u{2DE0}'..='\u{2DFF}'
                | '\u{A640}'..='\u{A69F}'
                | '\u{1C80}'..='\u{1C8F}'
        )
    })
}

fn sanitize_incident_for_output(mut incident: beaconops_core::Incident) -> beaconops_core::Incident {
    if contains_cyrillic(&incident.message) {
        incident.message = format!("Legacy localized incident message ({})", incident.code);
    }

    if contains_cyrillic(&incident.details) {
        incident.details =
            "Legacy localized incident details were sanitized. Trigger a fresh refresh cycle to regenerate diagnostics."
                .to_string();
    }

    incident
}

async fn dashboard_handler(
    State(state): State<AppState>,
) -> Json<beaconops_core::DashboardPayload> {
    let mut payload = state.monitor.latest_payload();
    payload.incidents = payload
        .incidents
        .into_iter()
        .map(sanitize_incident_for_output)
        .collect();
    info!(
        validators = payload.validators.len(),
        incidents = payload.incidents.len(),
        tracked = payload.tracked_validator_count,
        runtime_mode = %payload.runtime.mode,
        "dashboard payload served"
    );
    Json(payload)
}

async fn duties_handler(State(state): State<AppState>) -> Json<beaconops_core::DutiesPayload> {
    let payload = state.monitor.duties_payload();
    info!(
        current_slot = payload.current_slot,
        validators = payload.validators.len(),
        "duties payload served"
    );
    Json(payload)
}

async fn rewards_handler(
    Path(validator_index): Path<u64>,
    Query(query): Query<RewardsQuery>,
    State(state): State<AppState>,
) -> Result<Json<beaconops_core::RewardsPayload>, ApiError> {
    let window_hours = query.window_hours.unwrap_or(24);
    let payload = state
        .monitor
        .rewards_payload(validator_index, window_hours)
        .map_err(|err| match err {
            AppError::NotFound(message) => {
                ApiError::not_found("REWARDS_NOT_FOUND", "No validator data found", message)
            }
            other => ApiError::internal(
                "REWARDS_UNAVAILABLE",
                "Failed to collect reward metrics",
                other.to_string(),
                true,
            ),
        })?;

    info!(
        validator_index,
        window_hours,
        history_points = payload.history.len(),
        delta_1h_gwei = payload.delta_1h_gwei,
        delta_24h_gwei = payload.delta_24h_gwei,
        "rewards payload served"
    );
    Ok(Json(payload))
}

#[derive(Debug, Deserialize, Default)]
struct RewardsQuery {
    window_hours: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
struct EndpointQuery {
    endpoint: Option<String>,
}

async fn validators_handler(
    State(state): State<AppState>,
) -> Json<Vec<beaconops_core::models::ValidatorSnapshot>> {
    Json(state.monitor.latest_payload().validators)
}

#[derive(Debug, Serialize)]
struct ResolvedValidatorPayload {
    index: u64,
    pubkey: String,
    status: String,
    withdrawal_address: Option<String>,
    withdrawal_credentials: String,
    withdrawal_credentials_type: String,
    slashed: bool,
    effective_balance_gwei: u64,
    current_balance_gwei: u64,
}

async fn resolve_validator_handler(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<ResolvedValidatorPayload>, ApiError> {
    let resolved = state
        .monitor
        .resolve_validator_input(&id)
        .await
        .map_err(|err| match err {
            AppError::Config(message) => {
                ApiError::bad_request("VALIDATOR_ID_INVALID", "Invalid validator id", message)
            }
            AppError::NotFound(message) => {
                ApiError::not_found("VALIDATOR_NOT_FOUND", "Validator not found", message)
            }
            AppError::RpcFailed { reason, .. } if reason.contains("404") => {
                ApiError::not_found("VALIDATOR_NOT_FOUND", "Validator not found", reason)
            }
            other => ApiError::internal(
                "VALIDATOR_RESOLVE_FAILED",
                "Failed to resolve validator",
                other.to_string(),
                true,
            ),
        })?;

    Ok(Json(ResolvedValidatorPayload {
        index: resolved.index,
        pubkey: resolved.pubkey,
        status: resolved.status,
        withdrawal_address: resolved.withdrawal_address,
        withdrawal_credentials: resolved.withdrawal_credentials,
        withdrawal_credentials_type: resolved.withdrawal_credentials_type,
        slashed: resolved.slashed,
        effective_balance_gwei: resolved.effective_balance_gwei,
        current_balance_gwei: resolved.current_balance_gwei,
    }))
}

async fn incidents_handler(State(state): State<AppState>) -> Json<Vec<beaconops_core::Incident>> {
    Json(
        state
            .monitor
            .latest_payload()
            .incidents
            .into_iter()
            .map(sanitize_incident_for_output)
            .collect(),
    )
}

async fn health_handler(
    State(state): State<AppState>,
) -> Json<Vec<beaconops_core::models::EndpointHealth>> {
    Json(state.monitor.latest_payload().endpoint_health)
}

async fn help_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "user_guide": "docs/user-guide.md",
        "operator_guide": "docs/operator-guide.md",
        "runbooks": "docs/runbooks.md",
        "troubleshooting": "docs/incident-playbooks.md"
    }))
}

fn spawn_tick(
    monitor: Arc<MonitorEngine>,
    alert_engine: Arc<AlertEngine>,
    tick_lock: Arc<Mutex<()>>,
    tick_timeout: Duration,
) {
    tokio::spawn(async move {
        let _guard = tick_lock.lock().await;
        match timeout(tick_timeout, monitor.tick()).await {
            Ok(Ok(incidents)) => {
                let payload = monitor.latest_payload();
                alert_engine.process(&incidents, &payload).await;
            }
            Ok(Err(err)) => {
                error!(error = %err, "monitor tick failed");
            }
            Err(_) => {
                error!(
                    timeout_seconds = tick_timeout.as_secs(),
                    "manual monitor tick timed out"
                );
            }
        }
    });
}

async fn import_handler(
    State(state): State<AppState>,
    Json(payload): Json<ValidatorTarget>,
) -> Result<StatusCode, ApiError> {
    info!(validator_id = %payload.id, "import validator request");
    state
        .monitor
        .import_validator(payload)
        .await
        .map_err(|err| {
            ApiError::internal(
                "IMPORT_VALIDATOR_FAILED",
                "Failed to import validator",
                err.to_string(),
                true,
            )
        })?;

    spawn_tick(
        state.monitor.clone(),
        state.alert_engine.clone(),
        state.tick_lock.clone(),
        state.tick_timeout,
    );

    info!("import validator accepted and tick scheduled");

    Ok(StatusCode::ACCEPTED)
}

async fn retry_handler(State(state): State<AppState>) -> StatusCode {
    info!("manual retry requested");
    spawn_tick(
        state.monitor.clone(),
        state.alert_engine.clone(),
        state.tick_lock.clone(),
        state.tick_timeout,
    );

    StatusCode::ACCEPTED
}

async fn reset_state_handler(State(state): State<AppState>) -> StatusCode {
    info!("reset state requested");
    state.monitor.reset_state();
    StatusCode::OK
}

async fn logs_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "path": state.log_directory,
    }))
}

fn require_keymanager(state: &AppState) -> Result<Arc<KeymanagerEngine>, ApiError> {
    state.keymanager.clone().ok_or_else(|| {
        ApiError::service_unavailable(
            "KEYMANAGER_NOT_CONFIGURED",
            "Keymanager API endpoints are not configured",
            "Configure [keymanager].endpoints in beaconops.toml".to_string(),
        )
    })
}

async fn keymanager_endpoints_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<beaconops_core::keymanager::KeymanagerEndpointInfo>>, ApiError> {
    let engine = require_keymanager(&state)?;
    Ok(Json(engine.endpoint_infos()))
}

async fn keymanager_keystores_handler(
    Query(query): Query<EndpointQuery>,
    State(state): State<AppState>,
) -> Result<Json<beaconops_core::keymanager::KeymanagerListKeystoresResult>, ApiError> {
    let engine = require_keymanager(&state)?;
    let payload = engine
        .list_keystores(query.endpoint.as_deref())
        .await
        .map_err(|err| match err {
            AppError::NotFound(message) => ApiError::not_found(
                "KEYMANAGER_ENDPOINT_NOT_FOUND",
                "Keymanager endpoint not found",
                message,
            ),
            AppError::Config(message) => ApiError::bad_request(
                "KEYMANAGER_VALIDATION",
                "Invalid keymanager request",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "KEYMANAGER_RPC_FAILED",
                "Failed to fetch keystores via Keymanager API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "KEYMANAGER_FAILED",
                "Keymanager operation failed",
                other.to_string(),
                true,
            ),
        })?;
    Ok(Json(payload))
}

async fn keymanager_keystores_import_handler(
    State(state): State<AppState>,
    Json(payload): Json<KeymanagerImportKeystoresRequest>,
) -> Result<Json<beaconops_core::keymanager::KeymanagerMutationResult>, ApiError> {
    let engine = require_keymanager(&state)?;
    let result = engine
        .import_keystores(payload)
        .await
        .map_err(|err| match err {
            AppError::NotFound(message) => ApiError::not_found(
                "KEYMANAGER_ENDPOINT_NOT_FOUND",
                "Keymanager endpoint not found",
                message,
            ),
            AppError::Config(message) => ApiError::bad_request(
                "KEYMANAGER_IMPORT_VALIDATION",
                "Invalid keystores import payload",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "KEYMANAGER_IMPORT_RPC_FAILED",
                "Failed to import keystores via Keymanager API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "KEYMANAGER_IMPORT_FAILED",
                "Keystore import failed",
                other.to_string(),
                true,
            ),
        })?;
    Ok(Json(result))
}

async fn keymanager_keystores_delete_handler(
    State(state): State<AppState>,
    Json(payload): Json<KeymanagerDeleteKeystoresRequest>,
) -> Result<Json<beaconops_core::keymanager::KeymanagerMutationResult>, ApiError> {
    let engine = require_keymanager(&state)?;
    let result = engine
        .delete_keystores(payload)
        .await
        .map_err(|err| match err {
            AppError::NotFound(message) => ApiError::not_found(
                "KEYMANAGER_ENDPOINT_NOT_FOUND",
                "Keymanager endpoint not found",
                message,
            ),
            AppError::Config(message) => ApiError::bad_request(
                "KEYMANAGER_DELETE_VALIDATION",
                "Invalid keystores delete payload",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "KEYMANAGER_DELETE_RPC_FAILED",
                "Failed to delete keystores via Keymanager API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "KEYMANAGER_DELETE_FAILED",
                "Keystore deletion failed",
                other.to_string(),
                true,
            ),
        })?;
    Ok(Json(result))
}

async fn keymanager_remotekeys_handler(
    Query(query): Query<EndpointQuery>,
    State(state): State<AppState>,
) -> Result<Json<beaconops_core::keymanager::KeymanagerListRemoteKeysResult>, ApiError> {
    let engine = require_keymanager(&state)?;
    let payload = engine
        .list_remote_keys(query.endpoint.as_deref())
        .await
        .map_err(|err| match err {
            AppError::NotFound(message) => ApiError::not_found(
                "KEYMANAGER_ENDPOINT_NOT_FOUND",
                "Keymanager endpoint not found",
                message,
            ),
            AppError::Config(message) => ApiError::bad_request(
                "KEYMANAGER_VALIDATION",
                "Invalid keymanager request",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "KEYMANAGER_RPC_FAILED",
                "Failed to fetch remote keys via Keymanager API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "KEYMANAGER_FAILED",
                "Keymanager operation failed",
                other.to_string(),
                true,
            ),
        })?;
    Ok(Json(payload))
}

async fn keymanager_remotekeys_import_handler(
    State(state): State<AppState>,
    Json(payload): Json<KeymanagerImportRemoteKeysRequest>,
) -> Result<Json<beaconops_core::keymanager::KeymanagerMutationResult>, ApiError> {
    let engine = require_keymanager(&state)?;
    let result = engine
        .import_remote_keys(payload)
        .await
        .map_err(|err| match err {
            AppError::NotFound(message) => ApiError::not_found(
                "KEYMANAGER_ENDPOINT_NOT_FOUND",
                "Keymanager endpoint not found",
                message,
            ),
            AppError::Config(message) => ApiError::bad_request(
                "KEYMANAGER_REMOTE_IMPORT_VALIDATION",
                "Invalid remote keys import payload",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "KEYMANAGER_REMOTE_IMPORT_RPC_FAILED",
                "Failed to import remote keys via Keymanager API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "KEYMANAGER_REMOTE_IMPORT_FAILED",
                "Remote keys import failed",
                other.to_string(),
                true,
            ),
        })?;
    Ok(Json(result))
}

async fn keymanager_remotekeys_delete_handler(
    State(state): State<AppState>,
    Json(payload): Json<KeymanagerDeleteRemoteKeysRequest>,
) -> Result<Json<beaconops_core::keymanager::KeymanagerMutationResult>, ApiError> {
    let engine = require_keymanager(&state)?;
    let result = engine
        .delete_remote_keys(payload)
        .await
        .map_err(|err| match err {
            AppError::NotFound(message) => ApiError::not_found(
                "KEYMANAGER_ENDPOINT_NOT_FOUND",
                "Keymanager endpoint not found",
                message,
            ),
            AppError::Config(message) => ApiError::bad_request(
                "KEYMANAGER_REMOTE_DELETE_VALIDATION",
                "Invalid remote keys delete payload",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "KEYMANAGER_REMOTE_DELETE_RPC_FAILED",
                "Failed to delete remote keys via Keymanager API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "KEYMANAGER_REMOTE_DELETE_FAILED",
                "Remote keys deletion failed",
                other.to_string(),
                true,
            ),
        })?;
    Ok(Json(result))
}

async fn bls_change_sign_submit_handler(
    State(state): State<AppState>,
    Json(payload): Json<BlsToExecutionSignRequest>,
) -> Result<Json<beaconops_core::monitor::BlsToExecutionSignResult>, ApiError> {
    info!(
        validator_index = payload.validator_index,
        dry_run = payload.dry_run,
        "bls-to-execution change sign/submit requested"
    );

    let result = state
        .monitor
        .sign_and_submit_bls_to_execution_change(payload)
        .await
        .map_err(|err| match err {
            AppError::Config(message) => ApiError::bad_request(
                "BLS_CHANGE_VALIDATION",
                "Invalid BLS change parameters",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "BLS_CHANGE_RPC_FAILED",
                "Failed to submit BLS change to Beacon API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "BLS_CHANGE_FAILED",
                "BLS change operation failed",
                other.to_string(),
                true,
            ),
        })?;

    Ok(Json(result))
}

async fn validator_keys_generate_handler(
    State(state): State<AppState>,
    Json(payload): Json<ValidatorKeygenRequest>,
) -> Result<Json<beaconops_core::monitor::ValidatorKeygenResult>, ApiError> {
    let requested = payload.count.unwrap_or(1);
    info!(requested, "validator keypair generation requested");

    let result = state
        .monitor
        .generate_validator_keypairs(requested)
        .map_err(|err| match err {
            AppError::Config(message) => ApiError::bad_request(
                "KEYGEN_VALIDATION",
                "Invalid key generation parameters",
                message,
            ),
            other => ApiError::internal(
                "KEYGEN_FAILED",
                "Failed to generate validator keys",
                other.to_string(),
                true,
            ),
        })?;

    Ok(Json(result))
}

async fn bls_change_batch_sign_submit_handler(
    State(state): State<AppState>,
    Json(payload): Json<BlsToExecutionBatchSignRequest>,
) -> Result<Json<beaconops_core::monitor::BlsToExecutionBatchSignResult>, ApiError> {
    info!(
        operations = payload.items.len(),
        dry_run = payload.dry_run,
        "batch bls-to-execution change sign/submit requested"
    );

    let result = state
        .monitor
        .sign_and_submit_bls_to_execution_change_batch(payload)
        .await
        .map_err(|err| match err {
            AppError::Config(message) => ApiError::bad_request(
                "BLS_CHANGE_BATCH_VALIDATION",
                "Invalid batch BLS change parameters",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "BLS_CHANGE_BATCH_RPC_FAILED",
                "Failed to submit batch BLS change to Beacon API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "BLS_CHANGE_BATCH_FAILED",
                "Batch BLS change operation failed",
                other.to_string(),
                true,
            ),
        })?;

    Ok(Json(result))
}

async fn consensus_exit_sign_submit_handler(
    State(state): State<AppState>,
    Json(payload): Json<VoluntaryExitSignRequest>,
) -> Result<Json<beaconops_core::monitor::VoluntaryExitSignResult>, ApiError> {
    info!(
        validator_index = payload.validator_index,
        epoch = payload.epoch,
        dry_run = payload.dry_run,
        "consensus voluntary exit sign/submit requested"
    );

    let result = state
        .monitor
        .sign_and_submit_consensus_exit(payload)
        .await
        .map_err(|err| match err {
            AppError::Config(message) => ApiError::bad_request(
                "VOLUNTARY_EXIT_VALIDATION",
                "Invalid consensus exit parameters",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "VOLUNTARY_EXIT_RPC_FAILED",
                "Failed to submit consensus exit to Beacon API",
                reason,
                true,
            ),
            other => ApiError::internal(
                "VOLUNTARY_EXIT_FAILED",
                "Consensus exit operation failed",
                other.to_string(),
                true,
            ),
        })?;

    Ok(Json(result))
}

async fn execution_action_submit_handler(
    State(state): State<AppState>,
    Json(payload): Json<ExecutionActionSubmitRequest>,
) -> Result<Json<beaconops_core::monitor::ExecutionActionSubmitResult>, ApiError> {
    info!(
        validator_index = payload.validator_index,
        action = ?payload.action,
        dry_run = payload.dry_run,
        "execution-layer action submit requested"
    );

    let result = state
        .monitor
        .submit_execution_action(payload)
        .await
        .map_err(|err| match err {
            AppError::Config(message) => ApiError::bad_request(
                "EXECUTION_ACTION_VALIDATION",
                "Invalid execution action parameters",
                message,
            ),
            AppError::RpcFailed { reason, .. } => ApiError::internal(
                "EXECUTION_ACTION_RPC_FAILED",
                "Failed to submit execution action",
                reason,
                true,
            ),
            other => ApiError::internal(
                "EXECUTION_ACTION_FAILED",
                "Execution action failed",
                other.to_string(),
                true,
            ),
        })?;

    Ok(Json(result))
}

async fn shutdown_signal() {
    let _ = signal::ctrl_c().await;
    info!("shutdown signal received");
}

fn init_tracing(log_directory: &str) -> anyhow::Result<()> {
    let path = FsPath::new(log_directory);
    if !path.exists() {
        std::fs::create_dir_all(path)
            .with_context(|| format!("failed to create log directory: {}", path.display()))?;
    }

    let file_appender = rolling::daily(path, "beaconops.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _ = LOG_GUARD.set(guard);

    tracing_subscriber::registry()
        .with(EnvFilter::from_default_env().add_directive("info".parse()?))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false),
        )
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .init();

    Ok(())
}
