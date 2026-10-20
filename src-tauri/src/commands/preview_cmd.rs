use std::fs;
use std::path::PathBuf;

use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// HTML 预览文档的落盘目录：`$APPCONFIG/preview`。
///
/// 预览必须走真实 URL 而不是 iframe srcdoc：srcdoc 文档继承主窗口 CSP
/// （`script-src 'self'`），页面自带的脚本会被静默拦掉，只有独立 policy
/// container 的 URL 加载才允许执行。该目录天然在 asset 协议 scope 内
/// （tauri.conf.json 的 `$APPCONFIG/**`），无需额外授权。
fn preview_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Internal(format!("无法定位配置目录: {e}")))?
        .join("preview");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 校验前端给的预览名：只允许文件名安全字符，杜绝 `../` 与路径分隔符穿越。
fn checked_name(name: &str) -> AppResult<String> {
    if name.is_empty()
        || name.len() > 96
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(AppError::InvalidArg(format!("预览名不合法: {name}")));
    }
    Ok(format!("{name}.html"))
}

/// 写入一份预览文档，返回绝对路径（前端据此拼 asset 协议 URL）。
///
/// 每次重建都换一个文件名，而不是原地覆盖：asset 协议的响应不带缓存校验头，
/// 同名覆盖会被 webview 的 HTTP 缓存吃掉，预览停在旧内容。
#[tauri::command]
pub async fn write_preview_doc(app: AppHandle, name: String, html: String) -> AppResult<String> {
    let file = checked_name(&name)?;
    let dir = preview_dir(&app)?;
    spawn_blocking(move || {
        let path = dir.join(file);
        fs::write(&path, html)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::Internal(format!("预览写盘线程异常: {e}")))?
}

/// 删除上一份预览文档（换页、关标签、重建成功之后调用）。
/// 删不掉不报错：临时文件本就允许因崩溃残留，启动时统一清理。
#[tauri::command]
pub async fn delete_preview_doc(app: AppHandle, name: String) -> AppResult<()> {
    let file = checked_name(&name)?;
    let dir = preview_dir(&app)?;
    spawn_blocking(move || {
        let _ = fs::remove_file(dir.join(file));
    })
    .await
    .map_err(|e| AppError::Internal(format!("预览删除线程异常: {e}")))
}

/// 启动清理：整个 preview 目录删掉重建。
///
/// 里面是用户文档的明文副本，不该跨会话留着；崩溃残留也靠这一步收掉。
/// 目录不存在时静默返回，此时前端尚未挂载，不存在正在使用的预览文件。
pub fn prune_at_startup(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let dir = dir.join("preview");
    if let Err(e) = fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[mkdown][warn] 清理预览临时目录失败: {e}");
        }
    }
}
