use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

/// 定位系统 Edge（Windows 常见安装路径，按序探测）。`hint` 拼进错误信息，
/// 说明是哪项导出在依赖它、可以改走什么替代路径。
fn find_edge(hint: &str) -> AppResult<PathBuf> {
    [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
    .ok_or_else(|| AppError::Internal(format!("未检测到 Microsoft Edge（{hint}）")))
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
        // ① 定位系统 Edge
        let edge = find_edge("导出 PDF 依赖系统 Edge 浏览器。请改用顶栏「打印 PDF」。")?;

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

/// 长图高度上限（CSS px）。再高就建议拆文件：位图内存 ≈ 宽 × 高 × 4 × DPR²，
/// 4 万 CSS px 已在数百 MB 量级，再放就不是"导出一张图"该有的代价。
const MAX_SHOT_H: u32 = 40_000;
const MIN_SHOT_H: u32 = 200;
/// 测量趟只读 stdout 头部：`<title>` 在 `<head>` 里，几 KB 就能命中；
/// 整份 dump 里带着 base64 图片，没必要全读进内存。
const MEASURE_READ_LIMIT: usize = 512 * 1024;

/// 从 `--dump-dom` 的输出里取 `<title>MKSHOT:<高度></title>` 的高度。
fn parse_shot_height(buf: &[u8]) -> Option<u32> {
    const NEEDLE: &[u8] = b"MKSHOT:";
    let pos = buf.windows(NEEDLE.len()).position(|w| w == NEEDLE)?;
    let mut val: u32 = 0;
    let mut got = false;
    for &b in &buf[pos + NEEDLE.len()..] {
        if b.is_ascii_digit() {
            got = true;
            val = val.saturating_mul(10).saturating_add(u32::from(b - b'0'));
            if val > MAX_SHOT_H * 2 {
                return Some(val);
            }
        } else if got {
            break;
        } else {
            return None;
        }
    }
    got.then_some(val)
}

/// 导出长图：前端传自包含 HTML（convert/longImage.ts 产物，body 已定宽）+ 该宽度。
/// 两趟 Edge headless：
/// ① `--dump-dom` 让页面把 scrollHeight 写进 `<title>`（脚本由前端注入），据此定高度——
///    应用内量出来的高度与 headless 排版可能差几个像素，直接问同一个引擎最稳；
/// ② `--screenshot` 按「宽 × 高」整页截图，DPR 随高度下调（2 / 1.5 / 1）控制位图内存。
#[tauri::command]
pub async fn export_long_image(
    html: String,
    width: u32,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let picked = target_path(&path, "png")?;
    let w = width.clamp(320, 2400);
    let out = spawn_blocking(move || {
        let edge = find_edge("导出长图依赖系统 Edge 浏览器。")?;
        let tmp_dir = std::env::temp_dir().join(format!("mkdown-shot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir)?;
        let html_path = tmp_dir.join("shot.html");
        let png_path = tmp_dir.join("shot.png");
        fs_service::write_atomic(&html_path, html.as_bytes())?;
        let file_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));

        let produced = (|| -> AppResult<Vec<u8>> {
            // ① 量高度：dump-dom 只在 stdout 头部读，命中即杀进程
            let mut child = Command::new(&edge)
                .args([
                    "--headless=new",
                    "--disable-gpu",
                    "--hide-scrollbars",
                    &format!("--window-size={w},1000"),
                    "--virtual-time-budget=10000",
                    "--dump-dom",
                    &file_url,
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| AppError::Internal(format!("长图测量启动失败: {e}")))?;
            let mut height = None;
            if let Some(mut stdout) = child.stdout.take() {
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 16 * 1024];
                while buf.len() < MEASURE_READ_LIMIT {
                    match stdout.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if let Some(h) = parse_shot_height(&buf) {
                                height = Some(h);
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            let measured = height.ok_or_else(|| {
                AppError::Internal("长图尺寸测量失败（Edge 未返回页面高度）".into())
            })?;
            if measured > MAX_SHOT_H {
                return Err(AppError::Internal(format!(
                    "文档过长（约 {measured}px），单张长图上限 {MAX_SHOT_H}px。请拆分为多个文件后分别导出。"
                )));
            }
            let h = measured.max(MIN_SHOT_H) + 2;
            let dpr = if h <= 6_000 {
                "2"
            } else if h <= 15_000 {
                "1.5"
            } else {
                "1"
            };

            // ② 截图：窗口尺寸即出图尺寸，hide-scrollbars 避免右侧留一条栏
            let ok = Command::new(&edge)
                .args([
                    "--headless=new",
                    "--disable-gpu",
                    "--hide-scrollbars",
                    &format!("--force-device-scale-factor={dpr}"),
                    &format!("--window-size={w},{h}"),
                    "--virtual-time-budget=10000",
                    &format!("--screenshot={}", png_path.to_string_lossy()),
                    &file_url,
                ])
                .output()
                .map(|_| {
                    png_path.exists()
                        && std::fs::metadata(&png_path).map(|m| m.len() > 0).unwrap_or(false)
                })
                .unwrap_or(false);
            if !ok {
                return Err(AppError::Internal("长图生成失败（Edge 截图无产出）".into()));
            }
            std::fs::read(&png_path).map_err(AppError::from)
        })();

        let _ = std::fs::remove_dir_all(&tmp_dir);
        write_out(picked, &produced?)
    })
    .await
    .map_err(spawn_err)??;
    grant_picked(&state, Path::new(&out));
    Ok(out)
}
