use fuser::Errno;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("filesystem is still initializing")]
    Initializing,
    #[error("writer lease is fenced")]
    Fenced,
    #[error("not found")]
    NotFound,
    #[error("already exists")]
    Exists,
    #[error("not a directory")]
    NotDirectory,
    #[error("is a directory")]
    IsDirectory,
    #[error("directory not empty")]
    NotEmpty,
    #[error("invalid filesystem request: {0}")]
    Invalid(String),
    #[error("operation is not supported")]
    Unsupported,
    #[error("database error: {0}")]
    Database(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("internal error: {0}")]
    Internal(String),
}

impl Error {
    #[must_use]
    pub fn database(operation: &str, error: tokio_postgres::Error) -> Self {
        let detail = if let Some(server) = error.as_db_error() {
            let mut parts = vec![format!(
                "{} [SQLSTATE {}]",
                server.message(),
                server.code().code()
            )];
            if let Some(value) = server.detail() {
                parts.push(format!("detail: {value}"));
            }
            if let Some(value) = server.hint() {
                parts.push(format!("hint: {value}"));
            }
            if let Some(value) = server.table() {
                parts.push(format!("table: {value}"));
            }
            if let Some(value) = server.constraint() {
                parts.push(format!("constraint: {value}"));
            }
            parts.join("; ")
        } else {
            error.to_string()
        };
        Self::Database(format!("{operation}: {detail}"))
    }

    #[must_use]
    pub fn errno(&self) -> Errno {
        match self {
            Self::NotFound => Errno::ENOENT,
            Self::Exists => Errno::EEXIST,
            Self::NotDirectory => Errno::ENOTDIR,
            Self::IsDirectory => Errno::EISDIR,
            Self::NotEmpty => Errno::ENOTEMPTY,
            Self::Invalid(_) => Errno::EINVAL,
            Self::Unsupported => Errno::ENOTSUP,
            Self::Initializing
            | Self::Fenced
            | Self::Database(_)
            | Self::Io(_)
            | Self::Json(_)
            | Self::Internal(_) => Errno::EIO,
        }
    }
}

impl From<tokio_postgres::Error> for Error {
    fn from(error: tokio_postgres::Error) -> Self {
        Self::database("PostgreSQL operation", error)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
