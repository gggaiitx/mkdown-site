use std::path::{Path, PathBuf};

use tauri::async_runtime::spawn_blocking;
use tauri::State;

use crate::commands::file_cmd::grant_picked;
use crate::error::{AppError, AppResult};
use crate::services::fs_service;
use crate::state::AppState;

/// 导出 HTML：弹出保存对话框 → 原子写。返回写入路径；用户取消返回 None。
#[tauri::command]
pub async fn export_html(
    doc_path: String,
    html: String,
    state: State<'_, AppState>,
) -> AppResult<Option<String>> {
    let default_name = default_export_name(&doc_path, "html");
    let res = spawn_blocking(move || {
        let Some(mut picked) = rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter("HTML (*.html)", &["html"])
            .save_file()
        else {
            return Ok(None);
        };
        if picked.extension().is_none() {
            picked.set_extension("html");
        }
        fs_service::write_atomic(&picked, html.as_bytes())?;
        Ok(Some(picked.to_string_lossy().into_owned()))
    })
    .await
    // 此处的 ? 只剥 blocking 池的 JoinError 层；闭包自身仍是 Result<Option<String>, AppError>，
    // 由函数尾部直接返回（与原尾部表达式结构一致，同时让闭包错误类型被返回值钉死为 AppError）
    .map_err(|e| AppError::Internal(format!("导出线程异常: {e}")))?;
    // 与 save_as 同构：对话框选中的目录即授权依据，导出到新目录后补登记白名单，
    // 否则该目录内的文件后续读写会被 ADR-01 白名单拒（P2-9）。
    // 仅在实际写出成功时登记；用户取消（Ok(None)）与写失败（Err）都不放行。
    if let Ok(Some(p)) = &res {
        grant_picked(&state, Path::new(p));
    }
    res
}

fn default_export_name(doc_path: &str, ext: &str) -> String {
    PathBuf::from(doc_path)
        .file_stem()
        .map(|s| format!("{}.{}", s.to_string_lossy(), ext))
        .unwrap_or_else(|| format!("export.{}", ext))
}
