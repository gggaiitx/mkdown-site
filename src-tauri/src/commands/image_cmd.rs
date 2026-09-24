use std::path::PathBuf;

use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::models::SavedImage;
use crate::services::image_service;
use crate::state::AppState;

#[tauri::command]
pub async fn save_pasted_image(
    doc_path: String,
    data: String,
    ext: String,
    state: State<'_, AppState>,
) -> AppResult<SavedImage> {
    if doc_path.is_empty() {
        return Err(AppError::InvalidArg("请先保存文档后再粘贴图片".into()));
    }
    let p = PathBuf::from(&doc_path);
    state.ensure_allowed(&p)?;
    // Base64 解码 + 落盘都在 blocking 池里做，不占 async runtime
    spawn_blocking(move || image_service::save_pasted_image(&p, &data, &ext))
        .await
        .map_err(|e| AppError::Internal(format!("图片落盘线程异常: {e}")))?
}

/// 打开工作区时，运行时把该目录加入 asset 协议授权范围（ADR-05/06），
/// 使预览中的本地图片可通过 asset:// 加载而非被拦截的 file://。
///
/// 同时它是 ADR-01 的**核心授权点**：用户显式打开的目录即进入路径白名单，
/// 其下所有条目才允许被读写命令访问。
#[tauri::command]
pub async fn allow_asset_dir(
    app: AppHandle,
    dir: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let p = PathBuf::from(&dir);
    if !p.is_dir() {
        return Err(AppError::NotFound(format!("目录不存在: {dir}")));
    }
    state.grant_root(&p);
    app.asset_protocol_scope()
        .allow_directory(&p, true)
        .map_err(|e| AppError::Internal(format!("asset scope 授权失败: {e}")))?;
    Ok(())
}
