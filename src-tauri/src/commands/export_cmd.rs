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

/// 导出 Word（docx）：二进制 payload 版 export_html——弹出保存对话框 → 原子写。
/// 返回写入路径；用户取消返回 None。doc_path 仅用于推导默认文件名（stem + .docx）。
#[tauri::command]
pub async fn export_docx(
    doc_path: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> AppResult<Option<String>> {
    let default_name = default_export_name(&doc_path, "docx");
    let res = spawn_blocking(move || {
        let Some(mut picked) = rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter("Word (*.docx)", &["docx"])
            .save_file()
        else {
            return Ok(None);
        };
        if picked.extension().is_none() {
            picked.set_extension("docx");
        }
        fs_service::write_atomic(&picked, &data)?;
        Ok(Some(picked.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::Internal(format!("导出线程异常: {e}")))?;
    // 与 export_html 同构：仅在实际写出成功时补登记白名单（P2-9）
    if let Ok(Some(p)) = &res {
        grant_picked(&state, Path::new(p));
    }
    res
}

/// 导出 PDF：前端传入自包含 HTML 文档（printDoc.ts 产物）→ 写临时文件 →
/// **先弹保存对话框拿目标路径**（秒级响应，避免用户面对无反馈空窗）→
/// 调系统 Edge headless `--print-to-pdf`（Chromium 打印引擎：矢量文字型 PDF、
/// CSS 完整保真、智能分页）→ 写入目标。返回写入路径；用户取消返回 None。
/// 未检测到 Edge 时返回明确错误（调用方引导改用「打印 PDF」）。
#[tauri::command]
pub async fn export_pdf(
    doc_path: String,
    html: String,
    state: State<'_, AppState>,
) -> AppResult<Option<String>> {
    let default_name = default_export_name(&doc_path, "pdf");
    let res = spawn_blocking(move || {
        // ① 定位系统 Edge（Windows 常见安装路径，按序探测）
        let edge = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .ok_or_else(|| {
            AppError::Internal(
                "未检测到 Microsoft Edge（导出 PDF 依赖系统 Edge 浏览器）。请改用顶栏「打印 PDF」。"
                    .into(),
            )
        })?;

        // ② 先弹保存对话框：路径未定不打印，用户取消即整体放弃（无空窗等待）
        let Some(mut picked) = rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter("PDF (*.pdf)", &["pdf"])
            .save_file()
        else {
            return Ok(None);
        };
        if picked.extension().is_none() {
            picked.set_extension("pdf");
        }

        // ③ 临时 HTML（temp 目录 ASCII 路径，file:// URL 免编码）
        let tmp_dir = std::env::temp_dir().join(format!("mkdown-pdf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir)?;
        let html_path = tmp_dir.join("print.html");
        let pdf_path = tmp_dir.join("print.pdf");
        fs_service::write_atomic(&html_path, html.as_bytes())?;

        // ④ headless 打印：--no-pdf-header-footer 去页眉页脚（新版参数）；
        //    virtual-time-budget 等字体/图片/Mermaid 渲染完成
        let file_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));
        let ok = std::process::Command::new(&edge)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--no-pdf-header-footer",
                "--virtual-time-budget=12000",
                &format!("--print-to-pdf={}", pdf_path.to_string_lossy()),
                &file_url,
            ])
            .output()
            .map(|_| pdf_path.exists() && std::fs::metadata(&pdf_path).map(|m| m.len() > 0).unwrap_or(false))
            .unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(AppError::Internal("PDF 生成失败（Edge 打印无产出）".into()));
        }
        let pdf_bytes = std::fs::read(&pdf_path)?;
        let _ = std::fs::remove_dir_all(&tmp_dir);

        // ⑤ 写入目标（原子写）
        fs_service::write_atomic(&picked, &pdf_bytes)?;
        Ok(Some(picked.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::Internal(format!("导出线程异常: {e}")))?;
    // 与 export_html 同构：仅在实际写出成功时补登记白名单（P2-9）
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
