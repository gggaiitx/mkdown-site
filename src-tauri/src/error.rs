use serde::{ser::SerializeStruct, Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)] // 错误码为 IPC 契约的一部分，预留变体保留
pub enum AppError {
    #[error("path not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("encoding error: {0}")]
    Encoding(String),
    #[error("invalid argument: {0}")]
    InvalidArg(String),
    #[error("name conflict: {0}")]
    Conflict(String),
    #[error("operation cancelled")]
    Cancelled,
    #[error("unsupported operation: {0}")]
    Unsupported(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    /// 稳定错误码，前端据此做文案与行为分支（禁止依赖 message 文本）
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::PermissionDenied(_) => "PERMISSION_DENIED",
            AppError::Io(_) => "IO_ERROR",
            AppError::Encoding(_) => "ENCODING_ERROR",
            AppError::InvalidArg(_) => "INVALID_ARG",
            AppError::Conflict(_) => "CONFLICT",
            AppError::Cancelled => "CANCELLED",
            AppError::Unsupported(_) => "UNSUPPORTED",
            AppError::Internal(_) => "INTERNAL",
        }
    }
}

/// 统一 IPC 错误形状：{ code, message }
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound(e.to_string()),
            std::io::ErrorKind::PermissionDenied => AppError::PermissionDenied(e.to_string()),
            _ => AppError::Io(e.to_string()),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(AppError::NotFound("x".into()).code(), "NOT_FOUND");
        assert_eq!(AppError::Conflict("x".into()).code(), "CONFLICT");
        assert_eq!(AppError::Cancelled.code(), "CANCELLED");
    }

    #[test]
    fn serialize_shape_is_code_message() {
        let e = AppError::NotFound("缺失.md".into());
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "NOT_FOUND");
        assert!(v["message"].as_str().unwrap().contains("缺失.md"));
    }

    #[test]
    fn io_error_kind_mapping() {
        let e: AppError = std::io::Error::new(std::io::ErrorKind::NotFound, "gone").into();
        assert!(matches!(e, AppError::NotFound(_)));
    }
}
