use axum::{http::StatusCode, routing::get, Json, Router};
use beaconops_core::{
    config::RpcEndpointConfig,
    rpc::{RpcKind, RpcPool},
};
use serde_json::json;
use tokio::net::TcpListener;

async fn spawn(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn rpc_pool_fails_over_to_healthy_endpoint() {
    let bad_url = spawn(Router::new().route(
        "/eth/v1/beacon/headers/head",
        get(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "oops") }),
    ))
    .await;

    let good_url = spawn(Router::new().route(
        "/eth/v1/beacon/headers/head",
        get(|| async {
            Json(json!({
                "data": {
                    "header": {
                        "message": {
                            "slot": "1"
                        }
                    }
                }
            }))
        }),
    ))
    .await;

    let pool = RpcPool::new(
        RpcKind::Beacon,
        &[
            RpcEndpointConfig {
                name: "bad".to_string(),
                url: bad_url,
            },
            RpcEndpointConfig {
                name: "good".to_string(),
                url: good_url,
            },
        ],
        3_000,
        1,
        1,
    )
    .unwrap();

    let value: serde_json::Value = pool
        .beacon_get("/eth/v1/beacon/headers/head", false)
        .await
        .unwrap();

    assert_eq!(value["data"]["header"]["message"]["slot"], "1");

    let health = pool.health_snapshot();
    let bad = health.iter().find(|item| item.name == "bad").unwrap();
    let good = health.iter().find(|item| item.name == "good").unwrap();

    assert!(bad.failure_count > 0);
    assert!(good.success_count > 0);
}
