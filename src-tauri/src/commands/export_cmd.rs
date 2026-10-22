use std::path::{Path, PathBuf};

use tauri::async_runtime::spawn_blocking;
use tauri::State;

use crate::commands::file_cmd::grant_picked;
use crate::error::{AppError, AppResult};
use crate::services::fs_service;
use crate::state::AppState;

/// 目标路径由应用内选择器给定：补默认扩展名（前端一般已带），拒绝目录与相对路径。
fn target_path(path: &str, ext: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(AppError::InvalidArg("请输入完整路径".into()));
    }
    if p.is_dir() {
        return Err(AppError::InvalidArg("目标是一个文件夹".into()));
    }
    let mut p = p;
    if p.extension().is_none() {
        p.set_extension(ext);
    }
    Ok(p)
}

/// 写盘 + 选中路径即授权（选择器替代了系统对话框，授权点随之前移）。
fn write_out(picked: PathBuf, bytes: &[u8]) -> AppResult<String> {
    fs_service::write_atomic(&picked, bytes)?;
    Ok(picked.to_string_lossy().into_owned())
}

fn spawn_err(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(format!("导出线程异常: {e}"))
}

/// 导出 HTML：写选择器给定的目标路径。
#[tauri::command]
pub async fn export_html(
    html: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let picked = target_path(&path, "html")?;
    let out = spawn_blocking(move || write_out(picked, html.as_bytes()))
        .await
        .map_err(spawn_err)??;
    grant_picked(&state, Path::new(&out));
    Ok(out)
}

/// 导出 PNG：前端把 SVG 栅格化成 PNG 字节后传进来，写选择器给定的目标路径。
#[tauri::command]
pub async fn export_png(
    data: Vec<u8>,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let picked = target_path(&path, "png")?;
    let out = spawn_blocking(move || write_out(picked, &data))
        .await
        .map_err(spawn_err)??;
    grant_picked(&state, Path::new(&out));
    Ok(out)
}

/// 导出 Word（docx）：二进制 payload 版 export_html，写选择器给定的目标路径。
#[tauri::command]
pub async fn export_docx(
    data: Vec<u8>,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let picked = target_path(&path, "docx")?;
    let out = spawn_blocking(move || write_out(picked, &data))
        .await
        .map_err(spawn_err)??;
    grant_picked(&state, Path::new(&out));
    Ok(out)
}

/// 导出 PDF：前端传入自包含 HTML 文档（printDoc.ts 产物）→ 写临时文件 →
/// 调系统 Edge headless `--print-to-pdf`（Chromium 打印引擎：矢量文字型 PDF、
/// CSS 完整保真、智能分页）→ 写入选择器给定的目标路径。
/// 未检测到 Edge 时返回明确错误（调用方引导改用「打印 PDF」）。
#[tauri::command]
pub async fn export_pdf(
    html: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let picked = target_path(&path, "pdf")?;
    let out = spawn_blocking(move || {
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

        // ② 临时 HTML（temp 目录 ASCII 路径，file:// URL 免编码）
        let tmp_dir = std::env::temp_dir().join(format!("mkdown-pdf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir)?;
        let html_path = tmp_dir.join("print.html");
        let pdf_path = tmp_dir.join("print.pdf");
        fs_service::write_atomic(&html_path, html.as_bytes())?;

        // ③ headless 打印：--no-pdf-header-footer 去页眉页脚（新版参数）；
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

        // ④ 写入目标（原子写）
        write_out(picked, &pdf_bytes)
    })
    .await
    .map_err(spawn_err)??;
    grant_picked(&state, Path::new(&out));
    Ok(out)
}
