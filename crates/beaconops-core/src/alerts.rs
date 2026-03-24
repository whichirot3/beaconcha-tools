use crate::{
    config::TelegramConfig,
    error::AppResult,
    models::{DashboardPayload, Incident, Severity},
    storage::Storage,
};
use chrono::{Datelike, Timelike, Utc};
use std::sync::{Arc, Mutex};
use tracing::{error, info};

pub struct AlertEngine {
    storage: Storage,
    config: TelegramConfig,
    client: reqwest::Client,
    queued_digest: Arc<Mutex<Vec<Incident>>>,
}

impl AlertEngine {
    pub fn new(storage: Storage, config: TelegramConfig) -> AppResult<Self> {
        let client = reqwest::Client::builder()
            .user_agent("Beaconcha Tools/0.1")
            .build()?;

        Ok(Self {
            storage,
            config,
            client,
            queued_digest: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub async fn process(&self, incidents: &[Incident], payload: &DashboardPayload) {
        self.process_incidents(incidents).await;
        self.process_heartbeat(payload).await;
        self.process_digest().await;
    }

    async fn process_incidents(&self, incidents: &[Incident]) {
        for incident in incidents {
            if incident.severity < self.min_severity() {
                continue;
            }

            if self
                .storage
                .was_alert_sent_recently(
                    &incident.fingerprint,
                    self.config.anti_spam_window_seconds,
                )
                .unwrap_or(false)
            {
                continue;
            }

            if self.in_quiet_hours() && incident.severity != Severity::Critical {
                self.queued_digest
                    .lock()
                    .expect("digest mutex poisoned")
                    .push(incident.clone());
                continue;
            }

            if let Err(err) = self.send_incident(incident).await {
                error!(error = %err, "failed to send telegram incident");
            } else {
                let _ = self.storage.record_alert_sent(
                    &incident.fingerprint,
                    incident.severity,
                    "telegram",
                );
            }
        }
    }

    async fn process_heartbeat(&self, payload: &DashboardPayload) {
        if !self.config.enabled {
            return;
        }

        let now = Utc::now();
        let heartbeat_interval = self.config.heartbeat_minutes.max(1) * 60;

        let next_allowed = self
            .storage
            .get_state("heartbeat_last_sent")
            .ok()
            .flatten()
            .and_then(|raw| raw.parse::<i64>().ok())
            .unwrap_or(0)
            + heartbeat_interval as i64;

        if now.timestamp() < next_allowed {
            return;
        }

        let critical = payload
            .incidents
            .iter()
            .filter(|incident| incident.severity == Severity::Critical)
            .count();
        let warning = payload
            .incidents
            .iter()
            .filter(|incident| incident.severity == Severity::Warning)
            .count();

        let text = format!(
            "Beaconcha Tools heartbeat\nmode: {}\nvalidators: {}\ncritical: {}\nwarning: {}\nupdated: {}",
            payload.runtime.mode,
            payload.validators.len(),
            critical,
            warning,
            payload.runtime.updated_at
        );

        match self.send_message(&text).await {
            Ok(_) => {
                let _ = self
                    .storage
                    .set_state("heartbeat_last_sent", &now.timestamp().to_string());
            }
            Err(err) => error!(error = %err, "heartbeat send failed"),
        }
    }

    async fn process_digest(&self) {
        if !self.config.enabled {
            return;
        }

        let now = Utc::now();
        if now.hour() as u8 != self.config.digest_hour_utc {
            return;
        }

        let key = format!(
            "digest_last_sent_{}-{}-{}",
            now.year(),
            now.month(),
            now.day()
        );
        if self.storage.get_state(&key).ok().flatten().is_some() {
            return;
        }

        let queued_snapshot = {
            let queued = self.queued_digest.lock().expect("digest mutex poisoned");
            if queued.is_empty() {
                return;
            }
            queued.clone()
        };

        let mut critical = 0usize;
        let mut warning = 0usize;
        let mut info_count = 0usize;
        for incident in queued_snapshot.iter() {
            match incident.severity {
                Severity::Critical => critical += 1,
                Severity::Warning => warning += 1,
                Severity::Info => info_count += 1,
            }
        }

        let mut lines = vec![
            "Beaconcha Tools digest".to_string(),
            format!("critical: {critical}"),
            format!("warning: {warning}"),
            format!("info: {info_count}"),
        ];

        for incident in queued_snapshot.iter().take(15) {
            lines.push(format!(
                "- [{}] {} ({})",
                incident.severity.as_str(),
                incident.message,
                incident.code
            ));
        }

        let text = lines.join("\n");
        match self.send_message(&text).await {
            Ok(_) => {
                self.queued_digest
                    .lock()
                    .expect("digest mutex poisoned")
                    .clear();
                let _ = self.storage.set_state(&key, "sent");
            }
            Err(err) => error!(error = %err, "digest send failed"),
        }
    }

    async fn send_incident(&self, incident: &Incident) -> AppResult<()> {
        let text = format!(
            "Beaconcha Tools alert\nseverity: {}\ncode: {}\nmessage: {}\ndetails: {}\nfingerprint: {}",
            incident.severity.as_str(),
            incident.code,
            incident.message,
            incident.details,
            incident.fingerprint,
        );
        self.send_message(&text).await
    }

    async fn send_message(&self, text: &str) -> AppResult<()> {
        if !self.config.enabled {
            info!("telegram disabled, skipping outbound message");
            return Ok(());
        }

        let url = format!(
            "https://api.telegram.org/bot{}/sendMessage",
            self.config.bot_token
        );

        self.client
            .post(url)
            .json(&serde_json::json!({
                "chat_id": self.config.chat_id,
                "text": text,
                "disable_web_page_preview": true,
            }))
            .send()
            .await?
            .error_for_status()?;

        Ok(())
    }

    fn min_severity(&self) -> Severity {
        Severity::parse(&self.config.min_severity)
    }

    fn in_quiet_hours(&self) -> bool {
        let hour = Utc::now().hour() as u8;
        let start = self.config.quiet_hours_start;
        let end = self.config.quiet_hours_end;

        if start == end {
            return false;
        }

        if start < end {
            (start..end).contains(&hour)
        } else {
            hour >= start || hour < end
        }
    }
}
