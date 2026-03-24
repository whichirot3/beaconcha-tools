use beaconops_core::{
    models::{Incident, Severity, ValidatorMeta, ValidatorRecord, ValidatorSnapshot},
    Storage,
};
use chrono::Utc;
use uuid::Uuid;

#[test]
fn storage_persists_snapshots_and_incidents() {
    let db_path = format!("/tmp/beaconops-test-{}.db", Uuid::new_v4());
    let storage = Storage::open(&db_path).unwrap();

    let record = ValidatorRecord {
        validator_index: 42,
        pubkey: "0xabc".to_string(),
        withdrawal_address: Some("0x1111111111111111111111111111111111111111".to_string()),
        withdrawal_credentials: Some(
            "0x0100000000000000000000001111111111111111111111111111111111111111".to_string(),
        ),
        withdrawal_credentials_type: Some("0x01".to_string()),
        status: "active_ongoing".to_string(),
        slashed: false,
        activation_eligibility_epoch: Some(0),
        activation_epoch: Some(1),
        exit_epoch: None,
        withdrawable_epoch: None,
        effective_balance_gwei: 32_000_000_000,
        current_balance_gwei: 32_000_100_000,
        next_proposer_slot: Some(123456),
        in_current_sync_committee: true,
        in_next_sync_committee: false,
        meta: ValidatorMeta {
            label: Some("test".to_string()),
            node: Some("node-a".to_string()),
            cluster: Some("cluster-a".to_string()),
            operator: Some("ops".to_string()),
        },
    };

    let snapshot = ValidatorSnapshot {
        observed_at: Utc::now(),
        epoch: 100,
        record: record.clone(),
    };

    storage.upsert_registry(&[record]).unwrap();
    storage.insert_snapshots(&[snapshot]).unwrap();

    let incident = Incident {
        id: Uuid::new_v4().to_string(),
        occurred_at: Utc::now(),
        severity: Severity::Warning,
        code: "TEST_INCIDENT".to_string(),
        message: "test".to_string(),
        details: "details".to_string(),
        fingerprint: "test_fingerprint".to_string(),
        resolved: false,
    };

    storage.insert_incidents(&[incident]).unwrap();
    let recent = storage.recent_incidents(10).unwrap();
    assert!(!recent.is_empty());

    std::fs::remove_file(db_path).ok();
}
