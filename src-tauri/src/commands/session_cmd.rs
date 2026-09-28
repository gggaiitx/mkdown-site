use tauri::AppHandle;

use crate::error::AppResult;
use crate::services::session_service;

/// 读取会话快照（None = 无快照或快照无效，调用方按"无会话"处理）。
#[tauri::command]
pub async fn get_session(app: AppHandle) -> AppResult<Option<serde_json::Value>> {
    session_service::load(&app)
}

/// 写入会话快照；传 None 清除（快照为空时前端主动清文件，避免残留陈旧状态）。
/// 结构由前端定义并透传（serde_json::Value），Rust 侧不做 schema 约束。
#[tauri::command]
pub async fn set_session(app: AppHandle, snapshot: Option<serde_json::Value>) -> AppResult<()> {
    match snapshot {
        Some(v) => session_service::save(&app, &v),
        None => session_service::clear(&app),
    }
}
