use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{fmt, fs, path::Path};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppConfig {
    pub daemon: DaemonConfig,
    pub beacon: RpcGroupConfig,
    pub execution: RpcGroupConfig,
    #[serde(default)]
    pub keymanager: KeymanagerConfig,
    #[serde(default)]
    pub telegram: TelegramConfig,
    #[serde(default)]
    pub observability: ObservabilityConfig,
    #[serde(default)]
    pub validators: Vec<ValidatorTarget>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DaemonConfig {
    pub bind_addr: String,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_seconds: u64,
    #[serde(default = "default_timeout")]
    pub request_timeout_ms: u64,
    #[serde(default = "default_retries")]
    pub max_retries: usize,
    #[serde(default = "default_cache_ttl")]
    pub cache_ttl_seconds: u64,
    pub database_path: String,
    #[serde(default = "default_log_dir")]
    pub log_directory: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RpcGroupConfig {
    pub endpoints: Vec<RpcEndpointConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RpcEndpointConfig {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub struct KeymanagerConfig {
    pub endpoints: Vec<KeymanagerEndpointConfig>,
    #[serde(default = "default_keymanager_timeout")]
    pub request_timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KeymanagerEndpointConfig {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub auth_token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ValidatorTarget {
    pub id: String,
    pub label: Option<String>,
    pub node: Option<String>,
    pub cluster: Option<String>,
    pub operator: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct TelegramConfig {
    pub enabled: bool,
    pub bot_token: String,
    pub chat_id: String,
    pub min_severity: String,
    pub quiet_hours_start: u8,
    pub quiet_hours_end: u8,
    pub heartbeat_minutes: u64,
    pub digest_hour_utc: u8,
    pub anti_spam_window_seconds: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ObservabilityConfig {
    pub telemetry_opt_in: bool,
    pub crash_reporting_opt_in: bool,
    pub telemetry_endpoint: Option<String>,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bot_token: String::new(),
            chat_id: String::new(),
            min_severity: "warning".to_string(),
            quiet_hours_start: 23,
            quiet_hours_end: 7,
            heartbeat_minutes: 30,
            digest_hour_utc: 6,
            anti_spam_window_seconds: 300,
        }
    }
}

fn default_poll_interval() -> u64 {
    12
}

fn default_timeout() -> u64 {
    5_000
}

fn default_retries() -> usize {
    2
}

fn default_cache_ttl() -> u64 {
    8
}

fn default_keymanager_timeout() -> u64 {
    5_000
}

fn default_log_dir() -> String {
    "./data/logs".to_string()
}

impl AppConfig {
    pub fn load(path: impl AsRef<Path>) -> AppResult<Self> {
        let raw = fs::read_to_string(path)?;
        let cfg: Self = toml::from_str(&raw).map_err(|err| AppError::Config(err.to_string()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.beacon.endpoints.is_empty() {
            return Err(AppError::Config("beacon endpoints are required".into()));
        }

        if self.execution.endpoints.is_empty() {
            return Err(AppError::Config("execution endpoints are required".into()));
        }

        if self.daemon.bind_addr.trim().is_empty() {
            return Err(AppError::Config("daemon.bind_addr is required".into()));
        }

        for endpoint in self
            .beacon
            .endpoints
            .iter()
            .chain(self.execution.endpoints.iter())
        {
            if endpoint.name.trim().is_empty() {
                return Err(AppError::Config("endpoint name cannot be empty".into()));
            }

            let parsed = url::Url::parse(&endpoint.url)?;
            match parsed.scheme() {
                "https" | "http" => {}
                _ => {
                    return Err(AppError::Config(format!(
                        "unsupported RPC scheme for {}: {}",
                        endpoint.name,
                        parsed.scheme()
                    )))
                }
            }
        }

        for endpoint in &self.keymanager.endpoints {
            if endpoint.name.trim().is_empty() {
                return Err(AppError::Config(
                    "keymanager endpoint name cannot be empty".into(),
                ));
            }

            let parsed = url::Url::parse(&endpoint.url)?;
            match parsed.scheme() {
                "https" | "http" => {}
                _ => {
                    return Err(AppError::Config(format!(
                        "unsupported keymanager RPC scheme for {}: {}",
                        endpoint.name,
                        parsed.scheme()
                    )))
                }
            }
        }

        for validator in &self.validators {
            let _ = ValidatorIdentity::from_input(&validator.id)?;
        }

        if self.telegram.enabled
            && (self.telegram.bot_token.trim().is_empty()
                || self.telegram.chat_id.trim().is_empty())
        {
            return Err(AppError::Config(
                "telegram.bot_token and telegram.chat_id must be set when enabled".into(),
            ));
        }

        if self.telegram.quiet_hours_start > 23 || self.telegram.quiet_hours_end > 23 {
            return Err(AppError::Config("quiet hours must be in 0..=23".into()));
        }

        if !self.observability.telemetry_opt_in && self.observability.telemetry_endpoint.is_some() {
            return Err(AppError::Config(
                "observability.telemetry_endpoint requires telemetry_opt_in = true".into(),
            ));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidatorIdentity {
    Index(u64),
    Pubkey(String),
    WithdrawalAddress(String),
}

impl ValidatorIdentity {
    pub fn from_input(input: &str) -> AppResult<Self> {
        let normalized = input.trim().to_lowercase();
        if normalized.is_empty() {
            return Err(AppError::Config("validator id cannot be empty".into()));
        }

        if normalized.starts_with("0x") {
            match normalized.len() {
                42 => return Ok(Self::WithdrawalAddress(normalized)),
                98 => return Ok(Self::Pubkey(normalized)),
                _ => {
                    return Err(AppError::Config(format!(
                        "unsupported hex validator id format: {input}"
                    )))
                }
            }
        }

        let index = normalized
            .parse::<u64>()
            .map_err(|_| AppError::Config(format!("invalid validator index: {input}")))?;
        Ok(Self::Index(index))
    }
}

impl fmt::Display for ValidatorIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Index(index) => write!(f, "{index}"),
            Self::Pubkey(pubkey) | Self::WithdrawalAddress(pubkey) => write!(f, "{pubkey}"),
        }
    }
}
