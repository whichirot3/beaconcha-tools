use crate::{
    config::{KeymanagerConfig, KeymanagerEndpointConfig},
    error::{AppError, AppResult},
};
use chrono::{DateTime, Utc};
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone)]
struct KeymanagerEndpoint {
    name: String,
    url: String,
    auth_token: String,
}

#[derive(Debug, Clone)]
pub struct KeymanagerEngine {
    client: reqwest::Client,
    endpoints: Vec<KeymanagerEndpoint>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeymanagerEndpointInfo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeymanagerKeystoreRecord {
    pub endpoint: String,
    pub validating_pubkey: String,
    pub derivation_path: Option<String>,
    pub readonly: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeymanagerRemoteKeyRecord {
    pub endpoint: String,
    pub pubkey: String,
    pub url: String,
    pub readonly: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeymanagerListKeystoresResult {
    pub generated_at: DateTime<Utc>,
    pub records: Vec<KeymanagerKeystoreRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeymanagerListRemoteKeysResult {
    pub generated_at: DateTime<Utc>,
    pub records: Vec<KeymanagerRemoteKeyRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeymanagerMutationItem {
    pub endpoint: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeymanagerMutationResult {
    pub generated_at: DateTime<Utc>,
    pub applied: Vec<KeymanagerMutationItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeymanagerImportKeystoresRequest {
    pub endpoint: Option<String>,
    pub keystores: Vec<String>,
    pub passwords: Vec<String>,
    pub slashing_protection: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeymanagerDeleteKeystoresRequest {
    pub endpoint: Option<String>,
    pub pubkeys: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeymanagerImportRemoteKeysRequest {
    pub endpoint: Option<String>,
    pub remote_keys: Vec<KeymanagerRemoteKeyInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeymanagerRemoteKeyInput {
    pub pubkey: String,
    pub url: String,
    pub readonly: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeymanagerDeleteRemoteKeysRequest {
    pub endpoint: Option<String>,
    pub pubkeys: Vec<String>,
}

impl KeymanagerEngine {
    pub fn new(config: &KeymanagerConfig) -> AppResult<Option<Self>> {
        if config.endpoints.is_empty() {
            return Ok(None);
        }

        let timeout_ms = config.request_timeout_ms.clamp(1_500, 10_000);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .connect_timeout(Duration::from_millis(timeout_ms))
            .build()?;

        let endpoints = config
            .endpoints
            .iter()
            .map(map_endpoint)
            .collect::<Vec<_>>();

        Ok(Some(Self { client, endpoints }))
    }

    pub fn endpoint_infos(&self) -> Vec<KeymanagerEndpointInfo> {
        self.endpoints
            .iter()
            .map(|endpoint| KeymanagerEndpointInfo {
                name: endpoint.name.clone(),
                url: endpoint.url.clone(),
            })
            .collect()
    }

    pub async fn list_keystores(
        &self,
        endpoint_name: Option<&str>,
    ) -> AppResult<KeymanagerListKeystoresResult> {
        let targets = self.select_endpoints(endpoint_name)?;
        let mut records = Vec::new();

        for endpoint in targets {
            let payload: KeymanagerDataList<KeymanagerKeystoreItem> = self
                .send(endpoint, Method::GET, "/eth/v1/keystores", None)
                .await?;

            for item in payload.data {
                records.push(KeymanagerKeystoreRecord {
                    endpoint: endpoint.name.clone(),
                    validating_pubkey: item.validating_pubkey,
                    derivation_path: item.derivation_path,
                    readonly: item.readonly,
                });
            }
        }

        Ok(KeymanagerListKeystoresResult {
            generated_at: Utc::now(),
            records,
        })
    }

    pub async fn import_keystores(
        &self,
        request: KeymanagerImportKeystoresRequest,
    ) -> AppResult<KeymanagerMutationResult> {
        if request.keystores.is_empty() {
            return Err(AppError::Config(
                "keystores payload cannot be empty".to_string(),
            ));
        }
        if request.keystores.len() != request.passwords.len() {
            return Err(AppError::Config(
                "keystores/passwords counts must match".to_string(),
            ));
        }

        let targets = self.select_endpoints(request.endpoint.as_deref())?;
        let body = json!({
            "keystores": request.keystores,
            "passwords": request.passwords,
            "slashing_protection": request.slashing_protection.unwrap_or_default(),
        });

        let mut applied = Vec::new();
        for endpoint in targets {
            let response: KeymanagerMutationResponse = self
                .send(
                    endpoint,
                    Method::POST,
                    "/eth/v1/keystores",
                    Some(body.clone()),
                )
                .await?;
            for item in response.data {
                applied.push(KeymanagerMutationItem {
                    endpoint: endpoint.name.clone(),
                    status: item.status,
                    message: item.message,
                });
            }
        }

        Ok(KeymanagerMutationResult {
            generated_at: Utc::now(),
            applied,
        })
    }

    pub async fn delete_keystores(
        &self,
        request: KeymanagerDeleteKeystoresRequest,
    ) -> AppResult<KeymanagerMutationResult> {
        if request.pubkeys.is_empty() {
            return Err(AppError::Config("pubkeys cannot be empty".to_string()));
        }

        let targets = self.select_endpoints(request.endpoint.as_deref())?;
        let body = json!({ "pubkeys": request.pubkeys });
        let mut applied = Vec::new();

        for endpoint in targets {
            let response: KeymanagerMutationResponse = self
                .send(
                    endpoint,
                    Method::DELETE,
                    "/eth/v1/keystores",
                    Some(body.clone()),
                )
                .await?;
            for item in response.data {
                applied.push(KeymanagerMutationItem {
                    endpoint: endpoint.name.clone(),
                    status: item.status,
                    message: item.message,
                });
            }
        }

        Ok(KeymanagerMutationResult {
            generated_at: Utc::now(),
            applied,
        })
    }

    pub async fn list_remote_keys(
        &self,
        endpoint_name: Option<&str>,
    ) -> AppResult<KeymanagerListRemoteKeysResult> {
        let targets = self.select_endpoints(endpoint_name)?;
        let mut records = Vec::new();

        for endpoint in targets {
            let payload: KeymanagerDataList<KeymanagerRemoteKeyItem> = self
                .send(endpoint, Method::GET, "/eth/v1/remotekeys", None)
                .await?;

            for item in payload.data {
                records.push(KeymanagerRemoteKeyRecord {
                    endpoint: endpoint.name.clone(),
                    pubkey: item.pubkey,
                    url: item.url,
                    readonly: item.readonly,
                });
            }
        }

        Ok(KeymanagerListRemoteKeysResult {
            generated_at: Utc::now(),
            records,
        })
    }

    pub async fn import_remote_keys(
        &self,
        request: KeymanagerImportRemoteKeysRequest,
    ) -> AppResult<KeymanagerMutationResult> {
        if request.remote_keys.is_empty() {
            return Err(AppError::Config(
                "remote_keys payload cannot be empty".to_string(),
            ));
        }

        let targets = self.select_endpoints(request.endpoint.as_deref())?;
        let body = json!({
            "remote_keys": request
                .remote_keys
                .into_iter()
                .map(|item| {
                    json!({
                        "pubkey": item.pubkey,
                        "url": item.url,
                        "readonly": item.readonly.unwrap_or(false),
                    })
                })
                .collect::<Vec<_>>()
        });

        let mut applied = Vec::new();
        for endpoint in targets {
            let response: KeymanagerMutationResponse = self
                .send(
                    endpoint,
                    Method::POST,
                    "/eth/v1/remotekeys",
                    Some(body.clone()),
                )
                .await?;
            for item in response.data {
                applied.push(KeymanagerMutationItem {
                    endpoint: endpoint.name.clone(),
                    status: item.status,
                    message: item.message,
                });
            }
        }

        Ok(KeymanagerMutationResult {
            generated_at: Utc::now(),
            applied,
        })
    }

    pub async fn delete_remote_keys(
        &self,
        request: KeymanagerDeleteRemoteKeysRequest,
    ) -> AppResult<KeymanagerMutationResult> {
        if request.pubkeys.is_empty() {
            return Err(AppError::Config("pubkeys cannot be empty".to_string()));
        }

        let targets = self.select_endpoints(request.endpoint.as_deref())?;
        let body = json!({ "pubkeys": request.pubkeys });
        let mut applied = Vec::new();

        for endpoint in targets {
            let response: KeymanagerMutationResponse = self
                .send(
                    endpoint,
                    Method::DELETE,
                    "/eth/v1/remotekeys",
                    Some(body.clone()),
                )
                .await?;
            for item in response.data {
                applied.push(KeymanagerMutationItem {
                    endpoint: endpoint.name.clone(),
                    status: item.status,
                    message: item.message,
                });
            }
        }

        Ok(KeymanagerMutationResult {
            generated_at: Utc::now(),
            applied,
        })
    }

    fn select_endpoints(&self, endpoint_name: Option<&str>) -> AppResult<Vec<&KeymanagerEndpoint>> {
        if self.endpoints.is_empty() {
            return Err(AppError::Config(
                "keymanager endpoints are not configured".to_string(),
            ));
        }

        if let Some(name) = endpoint_name {
            let target = name.trim().to_lowercase();
            let matched = self
                .endpoints
                .iter()
                .find(|endpoint| endpoint.name.to_lowercase() == target)
                .ok_or_else(|| {
                    AppError::NotFound(format!("keymanager endpoint not found: {name}"))
                })?;
            return Ok(vec![matched]);
        }

        Ok(self.endpoints.iter().collect())
    }

    async fn send<T: DeserializeOwned>(
        &self,
        endpoint: &KeymanagerEndpoint,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> AppResult<T> {
        let url = format!("{}/{}", endpoint.url, path.trim_start_matches('/'));
        let mut request = self.client.request(method, url);
        if !endpoint.auth_token.is_empty() {
            request = request.bearer_auth(&endpoint.auth_token);
        }
        if let Some(payload) = body {
            request = request.json(&payload);
        }

        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            return Err(AppError::RpcFailed {
                kind: "keymanager",
                path: path.to_string(),
                reason: format!("{} {} @ {}", status, text, endpoint.name),
            });
        }

        let body_text = response.text().await.unwrap_or_default();
        if body_text.trim().is_empty() {
            return serde_json::from_value(Value::Object(serde_json::Map::new()))
                .map_err(AppError::from);
        }

        serde_json::from_str(&body_text).map_err(AppError::from)
    }
}

fn map_endpoint(endpoint: &KeymanagerEndpointConfig) -> KeymanagerEndpoint {
    KeymanagerEndpoint {
        name: endpoint.name.clone(),
        url: endpoint.url.trim_end_matches('/').to_string(),
        auth_token: endpoint.auth_token.clone(),
    }
}

#[derive(Debug, Deserialize)]
struct KeymanagerDataList<T> {
    data: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct KeymanagerKeystoreItem {
    validating_pubkey: String,
    derivation_path: Option<String>,
    readonly: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct KeymanagerRemoteKeyItem {
    pubkey: String,
    url: String,
    readonly: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct KeymanagerMutationResponse {
    #[serde(default)]
    data: Vec<KeymanagerMutationStatus>,
}

#[derive(Debug, Deserialize)]
struct KeymanagerMutationStatus {
    status: String,
    message: Option<String>,
}
