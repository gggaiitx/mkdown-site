use serde::Serialize;
use tauri::Emitter;

use crate::error::{AppError, AppResult};

/// camelCase：前端 UpdateApiResult 按 downloadUrl 读取，字段名必须对齐
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 远端最新 Release 的 tag（可能含前导 v，如 "v0.2.0"），版本比较交给前端
    pub latest: String,
    /// 该 Release 的网页地址，供前端用系统浏览器打开
    pub url: String,
    /// 适用于当前平台（Windows x64）的安装包下载地址；未找到则为 null
    pub download_url: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

const RELEASES_API: &str =
    "https://api.github.com/repos/gggaiitx/mkdown-site/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/gggaiitx/mkdown-site/releases";

/// 查询 GitHub 仓库最新 Release。
///
/// webview 的 CSP 仅放行 ipc:/asset:，前端无法直连 api.github.com，
/// 故由 Rust 侧发起请求；只回传 tag 与链接，版本比较逻辑留在前端，
/// 避免 Rust 侧硬编码版本解析口径。失败向上返回错误，由前端降级为可点击跳转发布页。
#[tauri::command]
pub async fn check_update() -> AppResult<UpdateInfo> {
    let client = reqwest::Client::builder()
        .user_agent("mkdown-app")
        .build()
        .map_err(|e| AppError::Io(format!("创建请求客户端失败: {e}")))?;

    let resp = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Io(format!("检查更新失败: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::InvalidArg(format!(
            "GitHub 返回状态 {}",
            resp.status()
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Io(format!("解析更新信息失败: {e}")))?;

    let latest = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_PAGE)
        .to_string();

    // 在 Release 的 assets 中挑出 Windows x64 安装包（命名含 x64-setup 或以 setup.exe 结尾）
    let download_url = json
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|a| {
                let name = a.get("name").and_then(|n| n.as_str())?;
                let lower = name.to_ascii_lowercase();
                if lower.contains("x64-setup") || lower.ends_with("setup.exe") {
                    a.get("browser_download_url")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
        });

    Ok(UpdateInfo {
        latest,
        url,
        download_url,
    })
}

/// 后台下载安装包到系统临时目录，并通过 `update-progress` 事件实时回报进度。
///
/// 返回下载完成的本地路径。前端拿到路径后再调用 `apply_update` 完成静默安装与重启。
/// 下载体量约数 MB，整体放入内存后一次性落盘，逻辑简单且避免引入异步文件写依赖。
#[tauri::command]
pub async fn download_update(download_url: String, app: tauri::AppHandle) -> AppResult<String> {
    let client = reqwest::Client::builder()
        .user_agent("mkdown-updater")
        .build()
        .map_err(|e| AppError::Io(format!("创建下载客户端失败: {e}")))?;

    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("开始下载失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::InvalidArg(format!(
            "下载地址返回状态 {}",
            resp.status()
        )));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut data: Vec<u8> = Vec::with_capacity(total as usize);
    let mut downloaded: u64 = 0;

    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Io(format!("下载中断: {e}")))?;
        downloaded += chunk.len() as u64;
        data.extend_from_slice(&chunk);
        // 进度事件仅用于刷新 UI，发送失败忽略，不影响下载本身
        let _ = app.emit(
            "update-progress",
            DownloadProgress { downloaded, total },
        );
    }

    let tmp = std::env::temp_dir().join("mkdown-update-setup.exe");
    std::fs::write(&tmp, &data).map_err(AppError::from)?;
    Ok(tmp.to_string_lossy().to_string())
}

/// 应用更新：用已下载的安装包静默重装当前目录，并在安装完成后重新拉起应用。
///
/// 关键约束：
/// 1. NSIS 安装器无法覆盖正在运行的 exe → 本命令先退出当前进程，再由脱钩的 bat
///    （DETACHED）顺序执行「静默安装 → 重新拉起应用」。
/// 2. NSIS 的 /D= 值不能带引号（引号会成为目录名的一部分）→ bat 内用 %~2 展开，不加引号。
/// 3. cmd 按 OEM 码表（中文系统为 GBK）读取 bat 文件 → bat 内容必须是纯 ASCII，
///    路径一律经 %~1/%~2/%~3 由 UTF-16 命令行传入，避免编码乱码。
#[tauri::command]
pub fn apply_update(installer_path: String) -> AppResult<()> {
    if !std::path::Path::new(&installer_path).exists() {
        return Err(AppError::InvalidArg(format!(
            "安装包不存在: {installer_path}"
        )));
    }

    let exe = std::env::current_exe().map_err(AppError::from)?;
    let dir = exe
        .parent()
        .ok_or_else(|| AppError::Internal("无法获取安装目录".into()))?
        .to_string_lossy()
        .to_string();
    let app_exe = exe.to_string_lossy().to_string();

    // 纯 ASCII 启动脚本：同步运行安装器（bat 命令天然等待其结束），
    // 完成后重新拉起应用并清理临时安装包。/D= 必须是安装器的最后一个参数且值不带引号。
    let bat = std::env::temp_dir().join("mkdown-update-apply.bat");
    std::fs::write(
        &bat,
        "@echo off\r\n\"%~1\" /S /D=%~2\r\nstart \"\" \"%~3\"\r\ndel /f /q \"%~1\"\r\n",
    )
    .map_err(AppError::from)?;

    let bat_str = bat.to_string_lossy().to_string();
    let mut cmd = std::process::Command::new("cmd");
    cmd.args([
        "/C",
        bat_str.as_str(),
        installer_path.as_str(),
        dir.as_str(),
        app_exe.as_str(),
    ]);
    // 脱离父进程的作业对象/控制台，确保应用退出后脚本仍能完成安装与重启
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    cmd.spawn().map_err(AppError::from)?;

    // 退出当前进程，把控制权交给安装器接管更新
    std::process::exit(0);
}
