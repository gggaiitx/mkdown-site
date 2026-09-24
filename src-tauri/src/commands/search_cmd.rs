use std::path::Path;

use tauri::async_runtime::spawn_blocking;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{SearchHit, SearchQuery};
use crate::services::search_service;
use crate::state::AppState;

/// 全文搜索：命中经 Channel 流式推送，命令返回命中总数。
#[tauri::command]
pub async fn search_in_files(
    query: SearchQuery,
    on_hit: Channel<SearchHit>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    // 搜索结果是内容外泄通道，根目录必须在已授权范围内（ADR-01）
    state.ensure_allowed(Path::new(&query.root))?;
    // 新一轮开始即置停上一轮全库扫描，避免连续输入时多轮 WalkParallel 叠加
    let cancel = state.begin_search();
    // 遍历+匹配为 CPU 密集（WalkParallel 多线程），放 blocking 线程避免卡 UI
    spawn_blocking(move || {
        // Channel: Clone + Send + Sync，move 进闭包满足搜索内核的 Send + Sync + 'static 约束；
        // send 失败只意味着前端已关闭/跳转，丢弃即可
        search_service::search(&query, cancel, move |hit| {
            let _ = on_hit.send(hit);
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("搜索线程异常: {e}")))?
}

/// 后台建索引（预热 Office 正文缓存）。工作区打开时调用一次即可，失败不影响使用。
#[tauri::command]
pub async fn warm_search_cache(root: String, state: State<'_, AppState>) -> AppResult<usize> {
    state.ensure_allowed(Path::new(&root))?;
    spawn_blocking(move || search_service::warm(&root))
        .await
        .map_err(|e| AppError::Internal(format!("建索引线程异常: {e}")))?
}
