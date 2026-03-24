use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone)]
struct CacheEntry {
    value: Value,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Default)]
pub struct JsonCache {
    ttl_seconds: u64,
    map: DashMap<String, CacheEntry>,
    hits: AtomicU64,
    misses: AtomicU64,
}

impl JsonCache {
    pub fn new(ttl_seconds: u64) -> Self {
        Self {
            ttl_seconds,
            map: DashMap::new(),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        let now = Utc::now();
        let mut expired = false;

        if let Some(entry) = self.map.get(key) {
            if entry.expires_at > now {
                self.hits.fetch_add(1, Ordering::Relaxed);
                return Some(entry.value.clone());
            }

            expired = true;
        }

        if expired {
            // Drop read guard before attempting remove to avoid DashMap shard deadlock.
            self.map.remove(key);
        }

        self.misses.fetch_add(1, Ordering::Relaxed);
        None
    }

    pub fn put(&self, key: impl Into<String>, value: Value) {
        let expires_at = Utc::now() + Duration::seconds(self.ttl_seconds as i64);
        self.map
            .insert(key.into(), CacheEntry { value, expires_at });
    }

    pub fn clear(&self) {
        self.map.clear();
    }

    pub fn stats(&self) -> (u64, u64) {
        (
            self.hits.load(Ordering::Relaxed),
            self.misses.load(Ordering::Relaxed),
        )
    }
}
