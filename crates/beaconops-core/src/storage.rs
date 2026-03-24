use crate::{
    error::AppResult,
    models::{EndpointHealth, Incident, Severity, ValidatorRecord, ValidatorSnapshot},
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct Storage {
    conn: Arc<Mutex<Connection>>,
}

impl Storage {
    pub fn open(path: &str) -> AppResult<Self> {
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }

        let conn = Connection::open(path)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            ",
        )?;

        let storage = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        storage.run_migrations()?;
        Ok(storage)
    }

    fn run_migrations(&self) -> AppResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS validator_registry (
                validator_index INTEGER PRIMARY KEY,
                pubkey TEXT NOT NULL,
                withdrawal_address TEXT,
                label TEXT,
                node_name TEXT,
                cluster_name TEXT,
                operator_name TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS validator_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                observed_at TEXT NOT NULL,
                epoch INTEGER NOT NULL,
                validator_index INTEGER NOT NULL,
                pubkey TEXT NOT NULL,
                status TEXT NOT NULL,
                effective_balance_gwei INTEGER NOT NULL,
                current_balance_gwei INTEGER NOT NULL,
                next_proposer_slot INTEGER,
                in_current_sync_committee INTEGER NOT NULL,
                in_next_sync_committee INTEGER NOT NULL,
                label TEXT,
                node_name TEXT,
                cluster_name TEXT,
                operator_name TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_validator_snapshots_time
            ON validator_snapshots(observed_at DESC);

            CREATE TABLE IF NOT EXISTS incidents (
                id TEXT PRIMARY KEY,
                occurred_at TEXT NOT NULL,
                severity TEXT NOT NULL,
                code TEXT NOT NULL,
                message TEXT NOT NULL,
                details TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                resolved INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_incidents_time
            ON incidents(occurred_at DESC);

            CREATE TABLE IF NOT EXISTS alerts_sent (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sent_at TEXT NOT NULL,
                dedupe_key TEXT NOT NULL,
                severity TEXT NOT NULL,
                target TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_alerts_sent_dedupe
            ON alerts_sent(dedupe_key, sent_at DESC);

            CREATE TABLE IF NOT EXISTS endpoint_health (
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                kind TEXT NOT NULL,
                score REAL NOT NULL,
                success_count INTEGER NOT NULL,
                failure_count INTEGER NOT NULL,
                latency_ms INTEGER NOT NULL,
                last_error TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(name, kind)
            );

            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS validator_liveness (
                epoch INTEGER NOT NULL,
                validator_index INTEGER NOT NULL,
                is_live INTEGER NOT NULL,
                observed_at TEXT NOT NULL,
                PRIMARY KEY(epoch, validator_index)
            );
            ",
        )?;
        Ok(())
    }

    pub fn upsert_registry(&self, records: &[ValidatorRecord]) -> AppResult<()> {
        let mut conn = self.conn.lock().expect("storage mutex poisoned");
        let tx = conn.transaction()?;
        for record in records {
            tx.execute(
                "
                INSERT INTO validator_registry (
                    validator_index, pubkey, withdrawal_address, label, node_name, cluster_name, operator_name, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(validator_index) DO UPDATE SET
                    pubkey = excluded.pubkey,
                    withdrawal_address = excluded.withdrawal_address,
                    label = excluded.label,
                    node_name = excluded.node_name,
                    cluster_name = excluded.cluster_name,
                    operator_name = excluded.operator_name,
                    updated_at = excluded.updated_at
                ",
                params![
                    record.validator_index,
                    record.pubkey,
                    record.withdrawal_address,
                    record.meta.label,
                    record.meta.node,
                    record.meta.cluster,
                    record.meta.operator,
                    Utc::now().to_rfc3339(),
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn insert_snapshots(&self, snapshots: &[ValidatorSnapshot]) -> AppResult<()> {
        if snapshots.is_empty() {
            return Ok(());
        }

        let mut conn = self.conn.lock().expect("storage mutex poisoned");
        let tx = conn.transaction()?;
        for snapshot in snapshots {
            tx.execute(
                "
                INSERT INTO validator_snapshots (
                    observed_at,
                    epoch,
                    validator_index,
                    pubkey,
                    status,
                    effective_balance_gwei,
                    current_balance_gwei,
                    next_proposer_slot,
                    in_current_sync_committee,
                    in_next_sync_committee,
                    label,
                    node_name,
                    cluster_name,
                    operator_name
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ",
                params![
                    snapshot.observed_at.to_rfc3339(),
                    snapshot.epoch,
                    snapshot.record.validator_index,
                    snapshot.record.pubkey,
                    snapshot.record.status,
                    snapshot.record.effective_balance_gwei,
                    snapshot.record.current_balance_gwei,
                    snapshot.record.next_proposer_slot,
                    if snapshot.record.in_current_sync_committee {
                        1_i64
                    } else {
                        0_i64
                    },
                    if snapshot.record.in_next_sync_committee {
                        1_i64
                    } else {
                        0_i64
                    },
                    snapshot.record.meta.label,
                    snapshot.record.meta.node,
                    snapshot.record.meta.cluster,
                    snapshot.record.meta.operator,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn insert_incidents(&self, incidents: &[Incident]) -> AppResult<()> {
        if incidents.is_empty() {
            return Ok(());
        }

        let mut conn = self.conn.lock().expect("storage mutex poisoned");
        let tx = conn.transaction()?;
        for incident in incidents {
            tx.execute(
                "
                INSERT OR REPLACE INTO incidents (
                    id, occurred_at, severity, code, message, details, fingerprint, resolved
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ",
                params![
                    incident.id,
                    incident.occurred_at.to_rfc3339(),
                    incident.severity.as_str(),
                    incident.code,
                    incident.message,
                    incident.details,
                    incident.fingerprint,
                    if incident.resolved { 1_i64 } else { 0_i64 },
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn recent_incidents(&self, limit: usize) -> AppResult<Vec<Incident>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn.prepare(
            "
            SELECT id, occurred_at, severity, code, message, details, fingerprint, resolved
            FROM incidents
            ORDER BY occurred_at DESC
            LIMIT ?1
            ",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| {
            let occurred: String = row.get(1)?;
            let occurred_at = DateTime::parse_from_rfc3339(&occurred)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());

            Ok(Incident {
                id: row.get(0)?,
                occurred_at,
                severity: Severity::parse(&row.get::<_, String>(2)?),
                code: row.get(3)?,
                message: row.get(4)?,
                details: row.get(5)?,
                fingerprint: row.get(6)?,
                resolved: row.get::<_, i64>(7)? == 1,
            })
        })?;

        let mut incidents = Vec::new();
        for row in rows {
            incidents.push(row?);
        }
        Ok(incidents)
    }

    pub fn save_endpoint_health(&self, healths: &[EndpointHealth]) -> AppResult<()> {
        let mut conn = self.conn.lock().expect("storage mutex poisoned");
        let tx = conn.transaction()?;
        for health in healths {
            tx.execute(
                "
                INSERT INTO endpoint_health (
                    name, url, kind, score, success_count, failure_count, latency_ms, last_error, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(name, kind) DO UPDATE SET
                    url = excluded.url,
                    score = excluded.score,
                    success_count = excluded.success_count,
                    failure_count = excluded.failure_count,
                    latency_ms = excluded.latency_ms,
                    last_error = excluded.last_error,
                    updated_at = excluded.updated_at
                ",
                params![
                    health.name,
                    health.url,
                    health.kind,
                    health.score,
                    health.success_count,
                    health.failure_count,
                    health.latency_ms,
                    health.last_error,
                    health.updated_at.to_rfc3339(),
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_endpoint_health(&self, kind: &str) -> AppResult<Vec<EndpointHealth>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn.prepare(
            "
            SELECT name, url, kind, score, success_count, failure_count, latency_ms, last_error, updated_at
            FROM endpoint_health
            WHERE kind = ?1
            ",
        )?;

        let rows = stmt.query_map(params![kind], |row| {
            let updated_at_raw: String = row.get(8)?;
            let updated_at = DateTime::parse_from_rfc3339(&updated_at_raw)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());

            Ok(EndpointHealth {
                name: row.get(0)?,
                url: row.get(1)?,
                kind: row.get(2)?,
                score: row.get(3)?,
                success_count: row.get(4)?,
                failure_count: row.get(5)?,
                latency_ms: row.get(6)?,
                last_error: row.get(7)?,
                updated_at,
            })
        })?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn record_alert_sent(
        &self,
        dedupe_key: &str,
        severity: Severity,
        target: &str,
    ) -> AppResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "
            INSERT INTO alerts_sent (sent_at, dedupe_key, severity, target)
            VALUES (?1, ?2, ?3, ?4)
            ",
            params![
                Utc::now().to_rfc3339(),
                dedupe_key,
                severity.as_str(),
                target
            ],
        )?;
        Ok(())
    }

    pub fn was_alert_sent_recently(
        &self,
        dedupe_key: &str,
        window_seconds: u64,
    ) -> AppResult<bool> {
        let cutoff = Utc::now() - chrono::Duration::seconds(window_seconds as i64);
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let exists: Option<i64> = conn
            .query_row(
                "
                SELECT 1
                FROM alerts_sent
                WHERE dedupe_key = ?1 AND sent_at >= ?2
                LIMIT 1
                ",
                params![dedupe_key, cutoff.to_rfc3339()],
                |row| row.get(0),
            )
            .optional()?;

        Ok(exists.is_some())
    }

    pub fn set_state(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "
            INSERT INTO app_state (key, value, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            ",
            params![key, value, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn get_state(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let result = conn
            .query_row(
                "SELECT value FROM app_state WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(result)
    }

    pub fn save_liveness(&self, epoch: u64, validator_index: u64, is_live: bool) -> AppResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "
            INSERT INTO validator_liveness (epoch, validator_index, is_live, observed_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(epoch, validator_index) DO UPDATE SET
                is_live = excluded.is_live,
                observed_at = excluded.observed_at
            ",
            params![
                epoch,
                validator_index,
                if is_live { 1_i64 } else { 0_i64 },
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn validators_by_withdrawal(&self, address: &str) -> AppResult<Vec<u64>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn.prepare(
            "
            SELECT validator_index
            FROM validator_registry
            WHERE lower(withdrawal_address) = lower(?1)
            ORDER BY validator_index ASC
            ",
        )?;

        let rows = stmt.query_map(params![address], |row| row.get(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn latest_snapshot_for_validator(
        &self,
        validator_index: u64,
    ) -> AppResult<Option<ValidatorSnapshot>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn.prepare(
            "
            SELECT observed_at, epoch, validator_index, pubkey, status,
                   effective_balance_gwei, current_balance_gwei, next_proposer_slot,
                   in_current_sync_committee, in_next_sync_committee,
                   label, node_name, cluster_name, operator_name
            FROM validator_snapshots
            WHERE validator_index = ?1
            ORDER BY observed_at DESC
            LIMIT 1
            ",
        )?;

        let snapshot = stmt
            .query_row(params![validator_index], map_snapshot_row)
            .optional()?;
        Ok(snapshot)
    }

    pub fn snapshot_before(
        &self,
        validator_index: u64,
        cutoff: DateTime<Utc>,
    ) -> AppResult<Option<ValidatorSnapshot>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn.prepare(
            "
            SELECT observed_at, epoch, validator_index, pubkey, status,
                   effective_balance_gwei, current_balance_gwei, next_proposer_slot,
                   in_current_sync_committee, in_next_sync_committee,
                   label, node_name, cluster_name, operator_name
            FROM validator_snapshots
            WHERE validator_index = ?1
              AND observed_at <= ?2
            ORDER BY observed_at DESC
            LIMIT 1
            ",
        )?;

        let snapshot = stmt
            .query_row(
                params![validator_index, cutoff.to_rfc3339()],
                map_snapshot_row,
            )
            .optional()?;
        Ok(snapshot)
    }

    pub fn snapshot_history_since(
        &self,
        validator_index: u64,
        hours: i64,
        limit: usize,
    ) -> AppResult<Vec<ValidatorSnapshot>> {
        let since = Utc::now() - Duration::hours(hours.max(1));
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn.prepare(
            "
            SELECT observed_at, epoch, validator_index, pubkey, status,
                   effective_balance_gwei, current_balance_gwei, next_proposer_slot,
                   in_current_sync_committee, in_next_sync_committee,
                   label, node_name, cluster_name, operator_name
            FROM validator_snapshots
            WHERE validator_index = ?1
              AND observed_at >= ?2
            ORDER BY observed_at ASC
            LIMIT ?3
            ",
        )?;

        let rows = stmt.query_map(
            params![validator_index, since.to_rfc3339(), limit as i64],
            map_snapshot_row,
        )?;

        let mut snapshots = Vec::new();
        for row in rows {
            snapshots.push(row?);
        }
        Ok(snapshots)
    }

    pub fn oldest_snapshot_since(
        &self,
        validator_index: u64,
        hours: i64,
    ) -> AppResult<Option<ValidatorSnapshot>> {
        let since = Utc::now() - Duration::hours(hours.max(1));
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn.prepare(
            "
            SELECT observed_at, epoch, validator_index, pubkey, status,
                   effective_balance_gwei, current_balance_gwei, next_proposer_slot,
                   in_current_sync_committee, in_next_sync_committee,
                   label, node_name, cluster_name, operator_name
            FROM validator_snapshots
            WHERE validator_index = ?1
              AND observed_at >= ?2
            ORDER BY observed_at ASC
            LIMIT 1
            ",
        )?;

        let snapshot = stmt
            .query_row(
                params![validator_index, since.to_rfc3339()],
                map_snapshot_row,
            )
            .optional()?;
        Ok(snapshot)
    }

    pub fn count_missed_attestations_since(
        &self,
        validator_index: u64,
        hours: i64,
    ) -> AppResult<u64> {
        let since = Utc::now() - Duration::hours(hours.max(1));
        let pattern = format!("%validator {validator_index} %");
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let count: Option<i64> = conn
            .query_row(
                "
                SELECT COUNT(1)
                FROM incidents
                WHERE code = 'MISSED_ATTESTATION'
                  AND occurred_at >= ?1
                  AND lower(details) LIKE lower(?2)
                ",
                params![since.to_rfc3339(), pattern],
                |row| row.get(0),
            )
            .optional()?;

        Ok(count.unwrap_or(0).max(0) as u64)
    }

    pub fn missed_attestation_streak(&self, validator_index: u64) -> AppResult<u64> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn.prepare(
            "
            SELECT is_live
            FROM validator_liveness
            WHERE validator_index = ?1
            ORDER BY epoch DESC
            LIMIT 128
            ",
        )?;
        let rows = stmt.query_map(params![validator_index], |row| row.get::<_, i64>(0))?;

        let mut streak = 0_u64;
        for row in rows {
            let is_live = row? == 1;
            if is_live {
                break;
            }
            streak += 1;
        }
        Ok(streak)
    }
}

fn map_snapshot_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ValidatorSnapshot> {
    let observed_raw: String = row.get(0)?;
    let observed_at = DateTime::parse_from_rfc3339(&observed_raw)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());

    Ok(ValidatorSnapshot {
        observed_at,
        epoch: row.get(1)?,
        record: ValidatorRecord {
            validator_index: row.get(2)?,
            pubkey: row.get(3)?,
            status: row.get(4)?,
            slashed: false,
            activation_eligibility_epoch: None,
            activation_epoch: None,
            exit_epoch: None,
            withdrawable_epoch: None,
            effective_balance_gwei: row.get(5)?,
            current_balance_gwei: row.get(6)?,
            next_proposer_slot: row.get(7)?,
            in_current_sync_committee: row.get::<_, i64>(8)? == 1,
            in_next_sync_committee: row.get::<_, i64>(9)? == 1,
            withdrawal_address: None,
            withdrawal_credentials: None,
            withdrawal_credentials_type: None,
            meta: crate::models::ValidatorMeta {
                label: row.get(10)?,
                node: row.get(11)?,
                cluster: row.get(12)?,
                operator: row.get(13)?,
            },
        },
    })
}
