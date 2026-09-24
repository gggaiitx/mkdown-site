use std::fs;
use std::path::PathBuf;

use tauri::async_runtime::spawn_blocking;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{FileContent, FileMeta, SaveResult};
use crate::services::fs_service;
use crate::state::AppState;

/// 把阻塞型文件 IO 挪出 async runtime，避免网络盘/大目录操作把整个 runtime 拖住。
async fn spawn_io<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("IO 线程异常: {e}")))?
}

async fn spawn_dialog<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    // rfd 对话框不能阻塞主线程，放到 blocking 线程池执行
    spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("对话框线程异常: {e}")))?
}

/// 用户经对话框显式选中的位置即视为授权：把目标所在目录加入白名单，
/// 后续读写不必重复授权（ADR-01 所说的"用户显式意图"授权点）。
fn grant_picked(state: &State<'_, AppState>, picked: &std::path::Path) {
    if let Some(dir) = picked.parent() {
        state.grant_root(dir);
    }
}

#[tauri::command]
pub async fn read_file(path: String, state: State<'_, AppState>) -> AppResult<FileContent> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    spawn_io(move || {
        if !p.is_file() {
            return Err(AppError::NotFound(format!("文件不存在: {path}")));
        }
        let meta = fs::metadata(&p)?;
        // 与 is_text_file 同一闸门：超限文件不该被整读进编辑器（ADR-02 降级策略）
        if meta.len() > fs_service::MAX_TEXT_BYTES {
            return Err(AppError::Unsupported(format!(
                "文件过大（{} 字节，上限 {} 字节）：请用系统默认程序打开",
                meta.len(),
                fs_service::MAX_TEXT_BYTES
            )));
        }
        let det = fs_service::read_text(&p)?;
        Ok(FileContent {
            path,
            content: det.content,
            encoding: det.encoding,
            had_bom: det.had_bom,
            is_utf8: det.is_utf8,
            size: meta.len(),
            mtime_ms: fs_service::mtime_ms(&p),
        })
    })
    .await
}

#[tauri::command]
pub async fn write_file_atomic(
    path: String,
    content: String,
    keep_bom: bool,
    state: State<'_, AppState>,
) -> AppResult<SaveResult> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    spawn_io(move || {
        let mut bytes = Vec::with_capacity(content.len() + 3);
        if keep_bom {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        bytes.extend_from_slice(content.as_bytes());
        fs_service::write_atomic(&p, &bytes)?;
        let meta = fs::metadata(&p)?;
        Ok(SaveResult {
            path,
            size: meta.len(),
            mtime_ms: fs_service::mtime_ms(&p),
        })
    })
    .await
}

#[tauri::command]
pub async fn save_as(
    default_name: String,
    content: String,
    state: State<'_, AppState>,
) -> AppResult<Option<SaveResult>> {
    let res = spawn_dialog(move || {
        let Some(mut picked) = rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter("Markdown (*.md)", &["md"])
            .save_file()
        else {
            return Ok(None);
        };
        if picked.extension().is_none() {
            picked.set_extension("md");
        }
        fs_service::write_atomic(&picked, content.as_bytes())?;
        Ok(Some(SaveResult {
            path: picked.to_string_lossy().into_owned(),
            size: fs::metadata(&picked)?.len(),
            mtime_ms: fs_service::mtime_ms(&picked),
        }))
    })
    .await?;
    // 对话框结果本身即授权依据，写完后补登记，后续就地保存 / 粘贴图片才有权限
    if let Some(r) = &res {
        grant_picked(&state, std::path::Path::new(&r.path));
    }
    Ok(res)
}

/// 系统打开文件对话框（.md 过滤），返回选中路径
#[tauri::command]
pub async fn pick_open_file(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let picked = spawn_dialog(|| {
        Ok(rfd::FileDialog::new()
            .add_filter("Markdown (*.md)", &["md", "markdown"])
            .add_filter("所有文件", &["*"])
            .pick_file()
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await?;
    if let Some(p) = &picked {
        grant_picked(&state, std::path::Path::new(p));
    }
    Ok(picked)
}

/// 系统选择文件夹对话框（选工作区根目录）
#[tauri::command]
pub async fn pick_workspace_dir(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let picked = spawn_dialog(|| {
        Ok(rfd::FileDialog::new()
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await?;
    if let Some(p) = &picked {
        state.grant_root(std::path::Path::new(p));
    }
    Ok(picked)
}

#[tauri::command]
pub async fn get_file_meta(path: String, state: State<'_, AppState>) -> AppResult<FileMeta> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    spawn_io(move || {
        let md = fs::metadata(&p)?;
        Ok(FileMeta {
            path,
            size: md.len(),
            mtime_ms: fs_service::mtime_ms(&p),
            is_dir: md.is_dir(),
            is_readonly: md.permissions().readonly(),
        })
    })
    .await
}

/// 判断文件能否在编辑器里以文本方式打开（扩展名 + 内容嗅探，见 `fs_service::is_text_file`）。
/// UI 据此分流：true → 右侧内容区打开；false → 交系统默认程序。
#[tauri::command]
pub async fn probe_text_file(path: String, state: State<'_, AppState>) -> AppResult<bool> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    // 只在"未知扩展名"时读盘，且最多 8KB；仍放 blocking 池避免网络盘卡顿拖住 runtime
    spawn_blocking(move || Ok(fs_service::is_text_file(&p)))
        .await
        .map_err(|e| AppError::Internal(format!("探测线程异常: {e}")))?
}

/// 判断文件能否在应用内预览（见 `fs_service::preview_kind`）。
/// 返回 "docx" | "xlsx" | "image"；None → 走原有分流（文本编辑器 / 系统默认程序）。
#[tauri::command]
pub async fn probe_preview_kind(
    path: String,
    state: State<'_, AppState>,
) -> AppResult<Option<&'static str>> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    // 纯扩展名判定，零 IO；仍走 blocking 池保持与 probe_text_file 同构
    spawn_blocking(move || Ok(fs_service::preview_kind(&p)))
        .await
        .map_err(|e| AppError::Internal(format!("探测线程异常: {e}")))?
}

/// 用系统默认程序打开文件（Office/PDF/图片/音视频/压缩包等），
/// 目录则在文件管理器中显示。
#[tauri::command]
pub async fn open_in_system(path: String, state: State<'_, AppState>) -> AppResult<()> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    if !p.exists() {
        return Err(AppError::NotFound(format!("路径不存在: {path}")));
    }
    // 不阻塞 async runtime：ShellExecute/xdg-open 属于进程外调用，但 spawn 仍走系统调用
    spawn_blocking(move || open_with_default_app(&p))
        .await
        .map_err(|e| AppError::Internal(format!("打开线程异常: {e}")))?
}

/// Windows：`cmd /C start "" "path"` 走 ShellExecute，按扩展名关联的默认程序打开。
/// 第一个 `""` 是 start 必填的窗口标题占位；路径加引号使空格与 `&` 安全；
/// CREATE_NO_WINDOW 避免闪出黑框控制台。
#[cfg(target_os = "windows")]
fn open_with_default_app(p: &std::path::Path) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let target = p.to_string_lossy().into_owned();
    let mut cmd = std::process::Command::new("cmd");
    // args 数组元素同类型：全部取 &str
    cmd.args(["/C", "start", "", target.as_str()]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
        .map_err(|e| AppError::Io(format!("用默认程序打开失败: {e}")))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_with_default_app(p: &std::path::Path) -> AppResult<()> {
    std::process::Command::new("open")
        .arg(p)
        .spawn()
        .map_err(|e| AppError::Io(format!("用默认程序打开失败: {e}")))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_default_app(p: &std::path::Path) -> AppResult<()> {
    std::process::Command::new("xdg-open")
        .arg(p)
        .spawn()
        .map_err(|e| AppError::Io(format!("用默认程序打开失败: {e}")))?;
    Ok(())
}

/// 用系统默认程序打开 URL（预览区外链专用）。
/// Windows 走 rundll32 FileProtocolHandler（等价 ShellExecute，不经过 cmd 解析，
/// URL 含 `&` 等字符安全；explorer 打开 URL 的行为不可靠，cmd start 会被 & 截断）。
#[tauri::command]
pub async fn open_url(url: String) -> AppResult<()> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err(AppError::InvalidArg(format!(
            "仅支持 http/https/mailto 链接: {url}"
        )));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| AppError::Io(format!("打开浏览器失败: {e}")))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| AppError::Io(format!("打开浏览器失败: {e}")))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| AppError::Io(format!("打开浏览器失败: {e}")))?;
        Ok(())
    }
}

/// 取走「打开方式」启动参数解析出的待打开文件（取后即清）。
/// 前端挂载完成时调用一次；规避了 setup 阶段 emit 事件而前端尚未注册监听的竞态。
#[tauri::command]
pub fn take_pending_open_args(state: State<'_, AppState>) -> Vec<String> {
    state.take_pending_open()
}
