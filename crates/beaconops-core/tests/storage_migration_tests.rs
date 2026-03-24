use beaconops_core::Storage;
use uuid::Uuid;

#[test]
fn storage_reopens_with_existing_schema() {
    let db_path = format!("/tmp/beaconops-migration-{}.db", Uuid::new_v4());

    let storage = Storage::open(&db_path).unwrap();
    storage.set_state("migration_probe", "ok").unwrap();

    let reopened = Storage::open(&db_path).unwrap();
    let probe = reopened.get_state("migration_probe").unwrap();
    assert_eq!(probe.as_deref(), Some("ok"));

    std::fs::remove_file(db_path).ok();
}
