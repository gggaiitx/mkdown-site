use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const FILE_NAME: &str = "session.json";

/// 会话快照文件路径：`$APPCONFIG/session.json`（与 settings.json 同目录）。
/// 快照属易变运行状态，独立于 settings.json，避免污染用户显式偏好。
/// NSIS 覆盖安装 / macOS 替换 .app 均不触碰该目录，更新重启后可完整恢复。
fn session_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Internal(format!("无法定位配置目录: {e}")))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(FILE_NAME))
}

/// 读取会话快照；不存在或解析失败一律返回 None（恢复是尽力而为，不致命）。
/// 结构由前端定义（serde_json::Value 透传），Rust 侧不做 schema 约束，
/// 快照格式演进只动前端，避免 Rust model 连带升级。
pub fn load(app: &AppHandle) -> AppResult<Option<serde_json::Value>> {
    let path = session_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            log_warn(format!("session.json 解析失败，忽略本次会话恢复: {e}"));
            Ok(None)
        }
    }
}

/// 原子写入快照（tmp + rename，见 fs_service::write_atomic）：
/// 更新重启/崩溃前的最后一次写入不落半截文件。
pub fn save(app: &AppHandle, snapshot: &serde_json::Value) -> AppResult<()> {
    let path = session_path(app)?;
    let json = serde_json::to_vec(snapshot)
        .map_err(|e| AppError::Internal(format!("会话快照序列化失败: {e}")))?;
    crate::services::fs_service::write_atomic(&path, &json)?;
    Ok(())
}

/// 清除快照（快照为空时由前端以 null 调用，保持文件不存在即"无会话"语义）。
pub fn clear(app: &AppHandle) -> AppResult<()> {
    let path = session_path(app)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

fn log_warn(msg: String) {
    eprintln!("[mkdown][warn] {msg}");
}
