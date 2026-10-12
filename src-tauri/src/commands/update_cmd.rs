//! 应用内更新：检查 → 下载 → 静默安装重启。
//!
//! **安全边界与已知限制（P2-3，风险记录在案）**：
//! 安装包**无签名校验、无完整性校验（哈希/大小均不验）**，传输层仅依赖
//! 「HTTPS + GitHub 官方域名白名单（github.com / objects.githubusercontent.com）」
//! 双重约束。这意味着能控制 GitHub Release 资产、或对该白名单域名持有有效
//! 证书实施中间人的攻击者，可投放任意安装包并被本模块直接执行。
//! 后续工作：发布流水线引入 minisign 签名、应用内下载后验签再执行；
//! 该项落地前，以上风险以本文档明示，不再静默。
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
    /// 适用于当前平台的安装包下载地址（Windows x64 = setup.exe；macOS = 当前架构 dmg）；未找到则为 null
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

/// HTTP 非 2xx 按状态码分类（P2-11）：4xx = 地址/参数问题（InvalidArg），
/// 5xx = 服务端故障（Io）。旧代码一律映射 InvalidArg，服务端抖动被误报成参数错误。
fn http_status_error(what: &str, status: reqwest::StatusCode) -> AppError {
    if status.is_client_error() {
        AppError::InvalidArg(format!("{what} 返回状态 {status}"))
    } else {
        AppError::Io(format!("{what} 返回状态 {status}"))
    }
}

/// 下载 URL 白名单校验（P0-1/P1-4）：仅 https 协议 + GitHub 官方域名。
/// host 取 `://` 与下一个 `/` 之间（端口/用户信息形态白名单域不存在，自然被拒）。
/// 按**域边界**匹配而非裸后缀：`evilgithub.com` 也以 `github.com` 结尾，
/// 裸 `ends_with` 会放行，故要求 host 等于白名单域本身、或以 `.` + 白名单域结尾。
/// 手写字符串解析，不引 url crate：判定只需要协议与 host 两段。
fn validate_download_url(url: &str) -> AppResult<()> {
    const ALLOWED_HOSTS: [&str; 2] = ["github.com", "objects.githubusercontent.com"];

    // scheme 大小写不敏感（RFC 3986），先归一再判协议
    if !url[..url.len().min(8)].eq_ignore_ascii_case("https://") {
        return Err(AppError::InvalidArg(format!(
            "下载地址仅支持 https 协议: {url}"
        )));
    }
    let rest = &url["https://".len()..];
    let host = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
    let allowed = ALLOWED_HOSTS.iter().any(|d| {
        host == *d
            || (host.len() > d.len()
                && host.ends_with(d)
                && host.as_bytes()[host.len() - d.len() - 1] == b'.')
    });
    if !allowed {
        return Err(AppError::InvalidArg(format!(
            "下载地址不在允许的 GitHub 域名白名单内: {url}"
        )));
    }
    Ok(())
}

/// 下载安装包的固定文件名（按平台区分）：Windows=NSIS exe / macOS=dmg。
/// download_update 写、apply_update 认，两侧共用同一函数，避免路径口径漂移。
fn update_installer_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "mkdown-update.dmg"
    } else {
        "mkdown-update-setup.exe"
    }
}

/// 本次下载的固定目标路径（apply_update 的合法入参有且仅有这一个）
fn expected_installer_path() -> std::path::PathBuf {
    std::env::temp_dir().join(update_installer_name())
}

/// 路径等价判定：Windows 大小写不敏感且 `/`/`\` 两种分隔符并存，归一后比较；
/// Unix 语义下精确比较。
fn same_installer_path(got: &std::path::Path, expected: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        let norm = |p: &std::path::Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
        norm(got) == norm(expected)
    }
    #[cfg(not(windows))]
    {
        got == expected
    }
}

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
        return Err(http_status_error("GitHub", resp.status()));
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

    // 在 Release 的 assets 中挑出当前平台的安装包：
    // Windows x64：命名含 x64-setup 或以 setup.exe 结尾（NSIS 安装包）
    // macOS：以 .dmg 结尾且文件名含当前构建架构（CI 产物 Mkdown_{VER}_{aarch64|x86_64}.dmg）
    let download_url = json
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|a| {
                let name = a.get("name").and_then(|n| n.as_str())?;
                let lower = name.to_ascii_lowercase();
                let matched = if cfg!(target_os = "macos") {
                    lower.ends_with(".dmg") && lower.contains(std::env::consts::ARCH)
                } else {
                    lower.contains("x64-setup") || lower.ends_with("setup.exe")
                };
                if matched {
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
    // 供应链前置校验：仅放行 https 的 GitHub 官方域名（P0-1/P1-4）。
    // 必须在发起请求前完成，避免把用户流量带向任意主机。
    validate_download_url(&download_url)?;

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
        return Err(http_status_error("下载地址", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    // 不信任 Content-Length 预分配：异常/恶意响应头（如声明数 GB）可致
    // 分配失败直接 abort（capacity overflow，release 下同样致命），
    // 改 Vec::new() 渐进 extend，由实际流量决定增长（P1-4）。
    let mut data: Vec<u8> = Vec::new();
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

    // 临时文件名按平台区分（Windows=NSIS exe / macOS=dmg），apply_update 依赖该产物类型
    let tmp = expected_installer_path();
    std::fs::write(&tmp, &data).map_err(AppError::from)?;
    Ok(tmp.to_string_lossy().to_string())
}

/// 应用更新入口：按平台分发静默安装与重启。
/// 两个平台共用同一契约：先脱钩执行「安装 → 重启」脚本，再退出当前进程。
#[tauri::command]
pub fn apply_update(installer_path: String) -> AppResult<()> {
    // ADR-01：前端不可借 IPC 触达任意路径。installer_path 必须恰好等于本次
    // download_update 写出的固定临时路径，否则拒绝执行——否则"前端可控路径
    // → 直接执行任意本地 exe"即成立（P0-1）。
    let expected = expected_installer_path();
    if !same_installer_path(std::path::Path::new(&installer_path), &expected) {
        return Err(AppError::InvalidArg(format!(
            "安装包路径不合法：仅允许应用内更新下载的 {}",
            expected.display()
        )));
    }
    if !std::path::Path::new(&installer_path).exists() {
        return Err(AppError::InvalidArg(format!(
            "安装包不存在: {installer_path}"
        )));
    }

    #[cfg(windows)]
    return apply_update_windows(installer_path);
    #[cfg(target_os = "macos")]
    return apply_update_macos(installer_path);
    #[cfg(not(any(windows, target_os = "macos")))]
    return Err(AppError::Internal("当前平台不支持应用内更新".into()));
}

/// Windows：用已下载的 NSIS 安装包静默重装当前目录，并在安装完成后重新拉起应用。
///
/// 关键约束：
/// 1. NSIS 安装器无法覆盖正在运行的 exe → 本命令先退出当前进程，再由脱钩的 bat
///    （DETACHED）顺序执行「静默安装 → 重新拉起应用」。
/// 2. NSIS 的 /D= 值不能带引号（引号会成为目录名的一部分）→ bat 内用 %~2 展开，不加引号。
/// 3. cmd 按 OEM 码表（中文系统为 GBK）读取 bat 文件 → bat 内容必须是纯 ASCII，
///    路径一律经 %~1/%~2/%~3 由 UTF-16 命令行传入，避免编码乱码。
#[cfg(windows)]
fn apply_update_windows(installer_path: String) -> AppResult<()> {
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
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    cmd.spawn().map_err(AppError::from)?;

    // 退出当前进程，把控制权交给安装器接管更新
    std::process::exit(0);
}

/// macOS：挂载 dmg → 替换现有 .app → 清除隔离属性 → 重新拉起应用。
///
/// 关键约束：
/// 1. 安装目标不是硬编码 /Applications，而是从 current_exe 反推当前 .app 路径
///    （/Applications/码克.app/Contents/MacOS/mkdown → /Applications/码克.app），
///    用户装在哪儿就更新哪儿。
/// 2. 应用未做 Apple 签名/公证，更新替换后的新 .app 会带 quarantine 隔离属性
///    （下载的 dmg 本身带，cp -R 会继承）→ **必须 xattr -cr 清除**，否则用户更新后
///    应用打不开（Gatekeeper 拦截）。这一步是未签名分发下 mac 自动更新的核心。
/// 3. rm -rf 替换正在运行的 .app 在 unix 语义下安全（运行中文件的 inode 已打开），
///    脚本仍 sleep 1 等主进程退出后再操作，规避极端竞态。
/// 4. 脚本经 /bin/sh 脱钩（process_group(0)）执行，主进程 exit 后流程继续；
///    路径一律经 $1/$2 位置参数传入，避免脚本内引号拼接出错。
#[cfg(target_os = "macos")]
fn apply_update_macos(installer_path: String) -> AppResult<()> {
    let exe = std::env::current_exe().map_err(AppError::from)?;
    let app_path = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")))
        .ok_or_else(|| {
            AppError::Internal("未在 .app 包内运行，无法定位安装目标（dev 模式请手动测试）".into())
        })?
        .to_path_buf();
    let app_path_str = app_path.to_string_lossy().to_string();

    let script = std::env::temp_dir().join("mkdown-update-apply.sh");
    std::fs::write(
        &script,
        concat!(
            "#!/bin/sh\n",
            "sleep 1\n",
            "MNT=$(mktemp -d)\n",
            "hdiutil attach \"$1\" -readonly -nobrowse -mountpoint \"$MNT\" || exit 1\n",
            "SRC=$(find \"$MNT\" -maxdepth 2 -name '*.app' | head -n 1)\n",
            "if [ -z \"$SRC\" ]; then hdiutil detach \"$MNT\" -force; exit 1; fi\n",
            "rm -rf \"$2\"\n",
            "cp -R \"$SRC\" \"$2\"\n",
            "xattr -cr \"$2\"\n",
            "hdiutil detach \"$MNT\" || hdiutil detach \"$MNT\" -force\n",
            "rm -f \"$1\"\n",
            "open \"$2\"\n",
        ),
    )
    .map_err(AppError::from)?;

    let script_str = script.to_string_lossy().to_string();
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.args([script_str.as_str(), installer_path.as_str(), app_path_str.as_str()]);
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // 脱离父进程组，主进程退出后脚本继续执行
    }
    cmd.spawn().map_err(AppError::from)?;

    // 退出当前进程，控制权交给脚本完成替换与重启
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_url_whitelist_accepts_github_official_hosts() {
        let ok = [
            "https://github.com/gggaiitx/mkdown-site/releases/download/v0.5.5/Mkdown_0.5.5_x64-setup.exe",
            "https://objects.githubusercontent.com/gh/gggaiitx/mkdown-site/x.exe",
            "https://GITHUB.COM/x", // scheme/host 大小写不敏感
        ];
        for u in ok {
            assert!(validate_download_url(u).is_ok(), "应放行: {u}");
        }
    }

    #[test]
    fn download_url_whitelist_rejects_non_github_and_plain_http() {
        let bad = [
            "http://github.com/x",           // 明文协议
            "https://evil.com/github.com/x", // 路径伪装
            "https://github.com.evil.com/x", // 后缀形似非本域
            "https://evilgithub.com/x",      // 裸 ends_with 会误放的陷阱
            "https://user@github.com/x",     // 用户信息形态
            "ftp://github.com/x",
            "github.com/x",
            "",
        ];
        for u in bad {
            assert!(validate_download_url(u).is_err(), "应拒绝: {u}");
        }
    }

    #[test]
    fn installer_path_must_equal_fixed_download_path() {
        let expected = expected_installer_path();
        assert!(same_installer_path(&expected, &expected));
        assert!(!same_installer_path(
            std::path::Path::new("/tmp/evil-setup.exe"),
            &expected
        ));
        #[cfg(windows)]
        {
            // Windows：大小写与分隔符差异不拒（前端回传可能被规范化）
            let weird = expected
                .to_string_lossy()
                .to_lowercase()
                .replace('/', "\\");
            assert!(same_installer_path(std::path::Path::new(&weird), &expected));
        }
    }

    #[test]
    fn http_status_error_classifies_4xx_and_5xx() {
        let e4 = http_status_error("下载地址", reqwest::StatusCode::NOT_FOUND);
        assert!(matches!(e4, AppError::InvalidArg(_)));
        let e5 = http_status_error("下载地址", reqwest::StatusCode::BAD_GATEWAY);
        assert!(matches!(e5, AppError::Io(_)));
    }
}
