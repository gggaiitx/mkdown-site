use std::path::PathBuf;

use tauri::async_runtime::spawn_blocking;

use crate::error::{AppError, AppResult};
use crate::services::fs_service;

/// 导出 HTML：弹出保存对话框 → 原子写。返回写入路径；用户取消返回 None。
#[tauri::command]
pub async fn export_html(doc_path: String, html: String) -> AppResult<Option<String>> {
    let default_name = default_export_name(&doc_path, "html");
    spawn_blocking(move || {
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
    .map_err(|e| AppError::Internal(format!("导出线程异常: {e}")))?
}

fn default_export_name(doc_path: &str, ext: &str) -> String {
    PathBuf::from(doc_path)
        .file_stem()
        .map(|s| format!("{}.{}", s.to_string_lossy(), ext))
        .unwrap_or_else(|| format!("export.{}", ext))
}
