use crate::{
    cache::JsonCache,
    config::RpcEndpointConfig,
    error::{AppError, AppResult},
    models::EndpointHealth,
};
use chrono::Utc;
use dashmap::DashMap;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    cmp::Ordering,
    sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
    time::{Duration, Instant},
};
use tokio::time::sleep;
use tracing::warn;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcKind {
    Beacon,
    Execution,
}

impl RpcKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Beacon => "beacon",
            Self::Execution => "execution",
        }
    }
}

#[derive(Debug, Clone)]
struct RpcEndpoint {
    name: String,
    url: String,
}

#[derive(Debug, Clone)]
struct EndpointState {
    score: f64,
    success_count: u64,
    failure_count: u64,
    latency_ms: u64,
    last_error: Option<String>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

impl Default for EndpointState {
    fn default() -> Self {
        Self {
            score: 75.0,
            success_count: 0,
            failure_count: 0,
            latency_ms: 0,
            last_error: None,
            updated_at: Utc::now(),
        }
    }
}

#[derive(Debug)]
pub struct RpcPool {
    kind: RpcKind,
    client: reqwest::Client,
    endpoints: Vec<RpcEndpoint>,
    max_retries: usize,
    request_timeout: Duration,
    state: DashMap<String, EndpointState>,
    cache: JsonCache,
    sequence: AtomicU64,
}

impl RpcPool {
    pub fn new(
        kind: RpcKind,
        endpoints: &[RpcEndpointConfig],
        request_timeout_ms: u64,
        max_retries: usize,
        cache_ttl_seconds: u64,
    ) -> AppResult<Self> {
        // Keep daemon responsive on public RPC even when endpoints degrade.
        let effective_timeout_ms = request_timeout_ms.clamp(1_500, 3_000);
        let _configured_retries = max_retries;
        let effective_retries = 0;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(effective_timeout_ms))
            .connect_timeout(Duration::from_millis(effective_timeout_ms))
            .http1_only()
            .pool_max_idle_per_host(0)
            .user_agent("Beaconcha Tools/0.1")
            .build()?;

        let mapped = endpoints
            .iter()
            .map(|endpoint| RpcEndpoint {
                name: endpoint.name.clone(),
                url: endpoint.url.trim_end_matches('/').to_string(),
            })
            .collect::<Vec<_>>();

        Ok(Self {
            kind,
            client,
            endpoints: mapped,
            max_retries: effective_retries,
            request_timeout: Duration::from_millis(effective_timeout_ms),
            state: DashMap::new(),
            cache: JsonCache::new(cache_ttl_seconds),
            sequence: AtomicU64::new(1),
        })
    }

    pub fn restore_health(&self, health: &[EndpointHealth]) {
        for endpoint in health {
            self.state.insert(
                endpoint.name.clone(),
                EndpointState {
                    score: endpoint.score,
                    success_count: endpoint.success_count,
                    failure_count: endpoint.failure_count,
                    latency_ms: endpoint.latency_ms,
                    last_error: endpoint.last_error.clone(),
                    updated_at: endpoint.updated_at,
                },
            );
        }
    }

    pub fn cache_stats(&self) -> (u64, u64) {
        self.cache.stats()
    }

    pub fn clear_cache(&self) {
        self.cache.clear();
    }

    pub fn health_snapshot(&self) -> Vec<EndpointHealth> {
        self.endpoints
            .iter()
            .map(|endpoint| {
                let state = self
                    .state
                    .get(&endpoint.name)
                    .map(|entry| entry.clone())
                    .unwrap_or_default();

                EndpointHealth {
                    name: endpoint.name.clone(),
                    url: endpoint.url.clone(),
                    kind: self.kind.as_str().to_string(),
                    score: state.score,
                    success_count: state.success_count,
                    failure_count: state.failure_count,
                    latency_ms: state.latency_ms,
                    last_error: state.last_error,
                    updated_at: state.updated_at,
                }
            })
            .collect()
    }

    pub fn has_failover(&self) -> bool {
        let health = self.health_snapshot();
        if health.len() < 2 {
            return false;
        }

        let mut sorted = health.iter().map(|h| h.score).collect::<Vec<_>>();
        sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(Ordering::Equal));
        if let (Some(first), Some(second)) = (sorted.first(), sorted.get(1)) {
            return (first - second).abs() > 5.0;
        }

        false
    }

    pub async fn beacon_get<T: DeserializeOwned>(
        &self,
        path: &str,
        cacheable: bool,
    ) -> AppResult<T> {
        let cache_key = format!("beacon:get:{path}");
        if cacheable {
            if let Some(cached) = self.cache.get(&cache_key) {
                return serde_json::from_value(cached).map_err(AppError::from);
            }
        }

        let payload = self.beacon_get_value(path).await?;

        if cacheable {
            self.cache.put(cache_key, payload.clone());
        }

        serde_json::from_value(payload).map_err(AppError::from)
    }

    pub async fn beacon_post<T: DeserializeOwned>(&self, path: &str, body: Value) -> AppResult<T> {
        let payload = self.beacon_post_value(path, body).await?;
        serde_json::from_value(payload).map_err(AppError::from)
    }

    pub async fn execution_rpc<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> AppResult<T> {
        let payload = self.execution_value(method, params).await?;
        serde_json::from_value(payload).map_err(AppError::from)
    }

    async fn beacon_get_value(&self, path: &str) -> AppResult<Value> {
        let mut last_error = "unknown failure".to_string();

        for attempt in 0..=self.max_retries {
            let endpoints = self.ranked_endpoints();

            for endpoint in &endpoints {
                let url = build_url(endpoint, path);
                let started = Instant::now();

                match self
                    .client
                    .get(url)
                    .timeout(self.request_timeout)
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => {
                        let value = response.json::<Value>().await?;
                        self.mark_success(endpoint, started.elapsed());
                        return Ok(value);
                    }
                    Ok(response) => {
                        let status = response.status();
                        let body = response
                            .text()
                            .await
                            .unwrap_or_else(|_| "<unreadable body>".to_string());
                        let reason = format!("{} {}", status.as_u16(), body);
                        self.mark_failure(endpoint, started.elapsed(), &reason);
                        last_error = reason;
                    }
                    Err(err) => {
                        let reason = err.to_string();
                        self.mark_failure(endpoint, started.elapsed(), &reason);
                        last_error = reason;
                    }
                }
            }

            if attempt < self.max_retries {
                sleep(Duration::from_millis(200 * (attempt as u64 + 1))).await;
            }
        }

        Err(AppError::RpcFailed {
            kind: self.kind.as_str(),
            path: path.to_string(),
            reason: last_error,
        })
    }

    async fn beacon_post_value(&self, path: &str, body: Value) -> AppResult<Value> {
        let mut last_error = "unknown failure".to_string();

        for attempt in 0..=self.max_retries {
            let endpoints = self.ranked_endpoints();

            for endpoint in &endpoints {
                let url = build_url(endpoint, path);
                let started = Instant::now();

                match self
                    .client
                    .post(url)
                    .timeout(self.request_timeout)
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => {
                        let body_text = response.text().await.unwrap_or_default();
                        let value = if body_text.trim().is_empty() {
                            Value::Object(serde_json::Map::new())
                        } else {
                            serde_json::from_str::<Value>(&body_text)?
                        };
                        self.mark_success(endpoint, started.elapsed());
                        return Ok(value);
                    }
                    Ok(response) => {
                        let status = response.status();
                        let text = response
                            .text()
                            .await
                            .unwrap_or_else(|_| "<unreadable body>".to_string());
                        let reason = format!("{} {}", status.as_u16(), text);
                        self.mark_failure(endpoint, started.elapsed(), &reason);
                        last_error = reason;
                    }
                    Err(err) => {
                        let reason = err.to_string();
                        self.mark_failure(endpoint, started.elapsed(), &reason);
                        last_error = reason;
                    }
                }
            }

            if attempt < self.max_retries {
                sleep(Duration::from_millis(200 * (attempt as u64 + 1))).await;
            }
        }

        Err(AppError::RpcFailed {
            kind: self.kind.as_str(),
            path: path.to_string(),
            reason: last_error,
        })
    }

    async fn execution_value(&self, method: &str, params: Value) -> AppResult<Value> {
        let request_id = self.sequence.fetch_add(1, AtomicOrdering::Relaxed);
        let mut last_error = "unknown failure".to_string();

        for attempt in 0..=self.max_retries {
            let endpoints = self.ranked_endpoints();

            for endpoint in &endpoints {
                let started = Instant::now();
                match self
                    .client
                    .post(endpoint.url.clone())
                    .timeout(self.request_timeout)
                    .json(&json!({
                        "jsonrpc": "2.0",
                        "method": method,
                        "params": params,
                        "id": request_id,
                    }))
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => {
                        let value = response.json::<Value>().await?;
                        if let Some(err) = value.get("error") {
                            let reason = err.to_string();
                            self.mark_failure(endpoint, started.elapsed(), &reason);
                            last_error = reason;
                            continue;
                        }

                        let result = value.get("result").cloned().ok_or_else(|| {
                            AppError::UnexpectedResponse(
                                "JSON-RPC response missing `result`".to_string(),
                            )
                        })?;

                        self.mark_success(endpoint, started.elapsed());
                        return Ok(result);
                    }
                    Ok(response) => {
                        let status = response.status();
                        let text = response
                            .text()
                            .await
                            .unwrap_or_else(|_| "<unreadable body>".to_string());
                        let reason = format!("{} {}", status.as_u16(), text);
                        self.mark_failure(endpoint, started.elapsed(), &reason);
                        last_error = reason;
                    }
                    Err(err) => {
                        let reason = err.to_string();
                        self.mark_failure(endpoint, started.elapsed(), &reason);
                        last_error = reason;
                    }
                }
            }

            if attempt < self.max_retries {
                sleep(Duration::from_millis(200 * (attempt as u64 + 1))).await;
            }
        }

        Err(AppError::RpcFailed {
            kind: self.kind.as_str(),
            path: method.to_string(),
            reason: last_error,
        })
    }

    fn ranked_endpoints(&self) -> Vec<RpcEndpoint> {
        let mut ranked = self.endpoints.clone();
        ranked.sort_by(|a, b| {
            let state_a = self
                .state
                .get(&a.name)
                .map(|entry| entry.clone())
                .unwrap_or_default();
            let state_b = self
                .state
                .get(&b.name)
                .map(|entry| entry.clone())
                .unwrap_or_default();

            state_b
                .score
                .partial_cmp(&state_a.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| state_a.latency_ms.cmp(&state_b.latency_ms))
        });
        ranked
    }

    fn mark_success(&self, endpoint: &RpcEndpoint, latency: Duration) {
        let mut state = self
            .state
            .get(&endpoint.name)
            .map(|entry| entry.clone())
            .unwrap_or_default();

        state.success_count += 1;
        state.latency_ms = latency.as_millis() as u64;
        state.updated_at = Utc::now();
        state.last_error = None;

        let latency_penalty = (state.latency_ms as f64 / 1_000.0).min(3.0);
        state.score = (state.score + 4.5 - latency_penalty).clamp(1.0, 100.0);

        self.state.insert(endpoint.name.clone(), state);
    }

    fn mark_failure(&self, endpoint: &RpcEndpoint, latency: Duration, reason: &str) {
        warn!(
            endpoint = %endpoint.name,
            kind = %self.kind.as_str(),
            reason = %reason,
            "rpc request failed"
        );

        let mut state = self
            .state
            .get(&endpoint.name)
            .map(|entry| entry.clone())
            .unwrap_or_default();

        state.failure_count += 1;
        state.latency_ms = latency.as_millis() as u64;
        state.updated_at = Utc::now();
        state.last_error = Some(reason.to_string());
        let severe_network_failure = reason.contains("timed out")
            || reason.contains("error sending request")
            || reason.contains("connection");
        let penalty = if severe_network_failure { 45.0 } else { 25.0 };
        state.score = (state.score - penalty).clamp(0.0, 100.0);

        self.state.insert(endpoint.name.clone(), state);
    }
}

fn build_url(endpoint: &RpcEndpoint, path: &str) -> String {
    let base = endpoint.url.trim_end_matches('/');
    let mut tail = path.trim_start_matches('/').to_string();

    // Some providers expose Beacon API under a base path that already includes /eth/v1.
    // Avoid duplicated segments when user configured that variant.
    if base.ends_with("/eth/v1") && tail.starts_with("eth/v1/") {
        tail = tail.trim_start_matches("eth/v1/").to_string();
    }

    format!("{base}/{tail}")
}
