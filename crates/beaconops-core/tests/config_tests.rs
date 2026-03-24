use beaconops_core::{config::ValidatorIdentity, AppConfig};

#[test]
fn validator_identity_parses_supported_formats() {
    assert!(matches!(
        ValidatorIdentity::from_input("12345").unwrap(),
        ValidatorIdentity::Index(12345)
    ));

    assert!(matches!(
        ValidatorIdentity::from_input(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
        .unwrap(),
        ValidatorIdentity::Pubkey(_)
    ));

    assert!(matches!(
        ValidatorIdentity::from_input("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap(),
        ValidatorIdentity::WithdrawalAddress(_)
    ));
}

#[test]
fn config_loads_example() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../config/beaconops.example.toml");
    let config = AppConfig::load(path).unwrap();
    assert!(!config.beacon.endpoints.is_empty());
    assert!(!config.execution.endpoints.is_empty());
}
