use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(String),

    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("url parse error: {0}")]
    Url(#[from] url::ParseError),

    #[error("rpc request failed for {kind} {path}: {reason}")]
    RpcFailed {
        kind: &'static str,
        path: String,
        reason: String,
    },

    #[error("not found: {0}")]
    NotFound(String),

    #[error("unexpected response: {0}")]
    UnexpectedResponse(String),
}
