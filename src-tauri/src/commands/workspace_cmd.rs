use std::path::{Path, PathBuf};

use tauri::async_runtime::spawn_blocking;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{NodeKind, WorkspaceNode};
use crate::services::workspace_service;
use crate::state::AppState;

/// 目录树构建要 stat 上万个条目，属阻塞型 IO：挪出 async runtime。
async fn spawn_io<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("工作区线程异常: {e}")))?
}

#[tauri::command]
pub async fn list_workspace_tree(
    root: String,
    max_depth: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceNode> {
    let p = PathBuf::from(&root);
    // 打开工作区＝用户显式授权该根，其下所有条目随之放行
    state.grant_root(&p);
    // 默认 12 层：方案类工作区（项目/年份/阶段/子模块…）层级较深，
    // 太浅会让深层目录"展开却是空的"，看起来像文件没扫出来
    let depth = max_depth.unwrap_or(12).clamp(1, 16);
    spawn_io(move || workspace_service::build_tree(&p, depth)).await
}

#[tauri::command]
pub async fn create_entry(
    parent: String,
    name: String,
    kind: NodeKind,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceNode> {
    let p = PathBuf::from(&parent);
    state.ensure_allowed(&p)?;
    spawn_io(move || workspace_service::create_entry(Path::new(&parent), &name, kind)).await
}

#[tauri::command]
pub async fn rename_entry(
    path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceNode> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    spawn_io(move || workspace_service::rename_entry(Path::new(&path), &new_name)).await
}

#[tauri::command]
pub async fn delete_entry(path: String, state: State<'_, AppState>) -> AppResult<()> {
    let p = PathBuf::from(&path);
    // 删除是唯一的破坏性操作，白名单必须卡在最前面
    state.ensure_allowed(&p)?;
    spawn_io(move || workspace_service::delete_entry(Path::new(&path))).await
}
