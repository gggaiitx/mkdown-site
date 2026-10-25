use std::fs;
use std::path::PathBuf;

use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::models::{DirBrowse, DirEntry, FileContent, FileMeta, SaveResult};
use crate::services::fs_service;
use crate::state::AppState;

/// 把阻塞型文件 IO 挪出 async runtime，避免网络盘/大目录操作把整个 runtime 拖住。
/// pub(crate)：settings/session 等命令的同步 IO 同样经此入 blocking 池（P1-5）。
pub(crate) async fn spawn_io<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("IO 线程异常: {e}")))?
}

/// 用户经选择器显式选中的位置即视为授权：把目标所在目录加入白名单，
/// 后续读写不必重复授权（ADR-01 所说的"用户显式意图"授权点）。
/// pub(crate)：export_html 等导出路径保存后同样需要补登记（P2-9）。
pub(crate) fn grant_picked(state: &State<'_, AppState>, picked: &std::path::Path) {
    if let Some(dir) = picked.parent() {
        state.grant_root(dir);
    }
}

#[tauri::command]
pub async fn read_file(path: String, state: State<'_, AppState>) -> AppResult<FileContent> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    spawn_io(move || {
        use std::io::Read;
        if !p.is_file() {
            return Err(AppError::NotFound(format!("文件不存在: {path}")));
        }
        // 与 is_text_file 同一闸门：超限文件不该被整读进编辑器（ADR-02 降级策略）。
        // 实现用「限量读」而非「metadata 检查 + 全量 read」：后者是 check-then-read
        // 竞态，活跃追加的日志文件在两步之间增长即可越过闸门被整读进内存（P1-6）。
        // 多读 1 字节用于区分「恰好等于上限」与「超出上限」。
        let f = fs::File::open(&p)?;
        let mut buf = Vec::new();
        f.take(fs_service::MAX_TEXT_BYTES + 1).read_to_end(&mut buf)?;
        if buf.len() as u64 > fs_service::MAX_TEXT_BYTES {
            return Err(AppError::Unsupported(format!(
                "文件过大（超过 {} 字节）：请用系统默认程序打开",
                fs_service::MAX_TEXT_BYTES
            )));
        }
        let det = fs_service::detect_text(&buf);
        let meta = fs::metadata(&p)?;
        Ok(FileContent {
            path,
            content: det.content,
            encoding: det.encoding,
            had_bom: det.had_bom,
            is_utf8: det.is_utf8,
            had_decode_errors: det.had_decode_errors,
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
    // 原文件编码（`read_file` 报出的名字）。省略 / null 时按 UTF-8 写；
    // 传了就按原编码回写，GBK / UTF-16 文档因此可以就地保存。
    // 注意：函数的参数位置只放行 allow/cfg 一类属性，此处不能用 /// 文档注释。
    encoding: Option<String>,
    // `read_file` 报出的「解码时出现过非法字节」标记。这种文档的正文里已经混入
    // U+FFFD，原字节无法还原，就地写回等于永久丢掉那部分内容 → 直接拒绝，引导另存为 UTF-8。
    had_decode_errors: Option<bool>,
    state: State<'_, AppState>,
) -> AppResult<SaveResult> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    spawn_io(move || {
        if had_decode_errors.unwrap_or(false) {
            return Err(AppError::Encoding(
                "原文件包含当前编码无法解码的字节，就地保存会丢失内容；请另存为 UTF-8".into(),
            ));
        }
        let bytes = fs_service::encode_text(
            &content,
            encoding.as_deref().unwrap_or("utf-8"),
            keep_bom,
        )?;
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

/// 按用户在选择器里选定的路径写入（另存为 / Word 反转直接保存）。
/// 选择结果本身就是授权依据：先登记目标目录再写，后续就地保存、粘贴图片才有权限。
#[tauri::command]
pub async fn save_text_at(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> AppResult<SaveResult> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(AppError::InvalidArg("请输入完整路径".into()));
    }
    if p.is_dir() {
        return Err(AppError::InvalidArg("目标是一个文件夹".into()));
    }
    grant_picked(&state, &p);
    spawn_io(move || {
        fs_service::write_atomic(&p, content.as_bytes())?;
        let meta = fs::metadata(&p)?;
        Ok(SaveResult {
            path: p.to_string_lossy().into_owned(),
            size: meta.len(),
            mtime_ms: fs_service::mtime_ms(&p),
        })
    })
    .await
}

/// 应用内文件选择器：默认只列子目录（供「打开工作区」与「新建工作区-更改位置」）；
/// `include_files` 打开后同时列出当前目录文件，供打开文件 / 另存为 / 导出共用。
///
/// 这里刻意不套工作区白名单：选择器需要浏览任意位置才能找到目标目录；
/// 选中确认后仍由打开工作区的 `list_workspace_tree`、打开文件的目录授权、
/// 保存命令的 `grant_picked` 授权，边界没有放宽。
///
/// `allow_missing`：保存模式下允许输入尚不存在的文件路径——后端退回其父目录，
/// 并把该路径作为 `selected` 回填，前端据此预填文件名。
#[tauri::command]
pub async fn browse_dirs(
    app: AppHandle,
    path: Option<String>,
    include_files: Option<bool>,
    allow_missing: Option<bool>,
) -> AppResult<DirBrowse> {
    let places = quick_places(&app);
    let fallback = app
        .path()
        .document_dir()
        .ok()
        .filter(|p| p.is_dir())
        .or_else(|| app.path().home_dir().ok().filter(|p| p.is_dir()))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(system_root);
    let requested = path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    spawn_io(move || {
        browse_dir(
            requested,
            fallback,
            places,
            include_files.unwrap_or(false),
            allow_missing.unwrap_or(false),
        )
    })
    .await
}

/// 单次浏览的条目上限：超大目录（System32、node_modules）没必要全量搬到前端
const MAX_BROWSE_ENTRIES: usize = 1000;

fn browse_dir(
    requested: Option<PathBuf>,
    fallback: PathBuf,
    places: Vec<DirEntry>,
    include_files: bool,
    allow_missing: bool,
) -> AppResult<DirBrowse> {
    let mut selected = None;
    let dir = match requested {
        Some(p) => {
            if !p.is_absolute() {
                return Err(AppError::InvalidArg("请输入完整路径".into()));
            }
            let p = normalize_dir(p);
            if p.is_dir() {
                p
            } else if include_files && p.is_file() {
                // 打开文件模式：路径指到文件本身 → 列父目录并预选该文件
                selected = Some(p.to_string_lossy().into_owned());
                p.parent().map(PathBuf::from).unwrap_or(p)
            } else if allow_missing && p.parent().map(|d| d.is_dir()).unwrap_or(false) {
                // 保存模式：尚不存在的目标文件 → 落到父目录，路径回填给前端预填文件名
                selected = Some(p.to_string_lossy().into_owned());
                p.parent().map(PathBuf::from).unwrap_or(p)
            } else {
                return Err(AppError::NotFound(format!("路径不存在: {}", p.display())));
            }
        }
        None => normalize_dir(fallback),
    };

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in fs::read_dir(&dir)?.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        // 符号链接/联接点：file_type 指向链接本身，需跟一次才能判断真实类型
        let is_dir = if ft.is_symlink() {
            entry.path().is_dir()
        } else {
            ft.is_dir()
        };
        let is_file = if ft.is_symlink() {
            entry.path().is_file()
        } else {
            ft.is_file()
        };
        if !is_dir && !(include_files && is_file) {
            continue;
        }
        let item = DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            kind: None,
            hidden: is_hidden(&entry),
        };
        if is_dir {
            dirs.push(item);
        } else {
            files.push(item);
        }
    }
    let by_name = |a: &DirEntry, b: &DirEntry| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    };
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    let mut truncated = false;
    if dirs.len() > MAX_BROWSE_ENTRIES {
        dirs.truncate(MAX_BROWSE_ENTRIES);
        truncated = true;
    }
    if files.len() > MAX_BROWSE_ENTRIES {
        files.truncate(MAX_BROWSE_ENTRIES);
        truncated = true;
    }

    Ok(DirBrowse {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        dirs,
        files,
        selected,
        places,
        roots: list_roots(),
        truncated,
    })
}

/// 是否应在「显示隐藏文件夹」关闭时隐藏：Windows 看隐藏/系统属性；
/// 点开头的名字也算（.git/.idea 这类开发目录不一定带隐藏属性）。
fn is_hidden(entry: &fs::DirEntry) -> bool {
    if entry.file_name().to_string_lossy().starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        if let Ok(meta) = entry.metadata() {
            return meta.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0;
        }
    }
    false
}

/// 归一化 `.` / `..`（用户可能手输路径）；不做 canonicalize，
/// 避免 Windows 的 `\\?\` 前缀与网络路径超时污染展示值。
fn normalize_dir(p: PathBuf) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 快捷位置：主目录 / 文档 / 桌面 / 下载（只返回真实存在的）。
/// 显示名由前端按 kind 本地化，name 仅作未知 kind 的兜底。
fn quick_places(app: &AppHandle) -> Vec<DirEntry> {
    let paths = app.path();
    let mut out = Vec::new();
    for (kind, dir) in [
        ("home", paths.home_dir().ok()),
        ("documents", paths.document_dir().ok()),
        ("desktop", paths.desktop_dir().ok()),
        ("downloads", paths.download_dir().ok()),
    ] {
        let Some(p) = dir.filter(|p| p.is_dir()) else {
            continue;
        };
        out.push(DirEntry {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.to_string_lossy().into_owned()),
            path: p.to_string_lossy().into_owned(),
            kind: Some(kind.into()),
            hidden: false,
        });
    }
    out
}

/// 无盘符可列时的兜底根目录
fn system_root() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("SystemDrive")
            .map(|d| PathBuf::from(format!("{}\\", d.to_string_lossy())))
            .unwrap_or_else(|| PathBuf::from("C:\\"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/")
    }
}

#[cfg(windows)]
fn list_roots() -> Vec<DirEntry> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    // DRIVE_NO_ROOT_DIR；GetLogicalDrives 的位掩码本身不探测网络盘，GetDriveTypeW
    // 取不到根目录的盘（空读卡器槽等）直接跳过，避免点进去卡死
    const DRIVE_NO_ROOT_DIR: u32 = 1;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        if unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_NO_ROOT_DIR {
            continue;
        }
        out.push(DirEntry {
            name: format!("{letter}:"),
            path: root,
            kind: Some("root".into()),
            hidden: false,
        });
    }
    out
}

#[cfg(not(windows))]
fn list_roots() -> Vec<DirEntry> {
    let mut out = vec![DirEntry {
        name: "/".into(),
        path: "/".into(),
        kind: Some("root".into()),
        hidden: false,
    }];
    // macOS 的外接卷挂在 /Volumes 下，也放进根列表（取不到就当只有 /）
    if cfg!(target_os = "macos") {
        if let Ok(rd) = fs::read_dir("/Volumes") {
            for entry in rd.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                out.push(DirEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path().to_string_lossy().into_owned(),
                    kind: Some("root".into()),
                    hidden: false,
                });
            }
        }
    }
    out
}

/// 「新建工作区」弹窗的默认存放位置：优先文档目录，取不到再退到用户主目录。
#[tauri::command]
pub fn default_workspace_parent(app: AppHandle) -> Option<String> {
    let paths = app.path();
    paths
        .document_dir()
        .or_else(|_| paths.home_dir())
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
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

/// 左右键同目录切换用：列出与 path 同族的全部文件（图片/PDF/Word/Excel 按预览种类，
/// 文本按 md/mh/html/svg/同扩展名分组，文件名自然排序）。
/// 只读目录项，不读文件内容；目录本身同样要过白名单。
#[tauri::command]
pub async fn list_sibling_files(
    path: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<String>> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    spawn_io(move || fs_service::sibling_files(&p)).await
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

/// 在系统文件管理器中显示文件/目录（定位并选中该项，等价 VS Code 的 Reveal in Explorer）。
/// Windows 用 `explorer /select`；macOS 用 `open -R`；Linux 无统一选中接口，打开所在目录。
#[tauri::command]
pub async fn reveal_in_explorer(path: String, state: State<'_, AppState>) -> AppResult<()> {
    let p = PathBuf::from(&path);
    state.ensure_allowed(&p)?;
    if !p.exists() {
        return Err(AppError::NotFound(format!("路径不存在: {path}")));
    }
    spawn_blocking(move || reveal_in_fm(&p))
        .await
        .map_err(|e| AppError::Internal(format!("定位线程异常: {e}")))?
}

/// Windows：`explorer /select,"path"` 打开所在目录并选中该项。
/// /select 仅接受反斜杠路径，统一归一；注意 explorer 正常打开也常返回非零退出码，
/// 因此只 spawn 不检查 exit status。
#[cfg(target_os = "windows")]
fn reveal_in_fm(p: &std::path::Path) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let target = p.to_string_lossy().replace('/', "\\");
    // 引号必须原样出现在命令行里：.arg() 会因参数含引号再包一层 `\"` 转义，
    // explorer 不按标准 argv 规则解析，会解析失败落到默认位置（实测打开位置错误）；
    // 必须用 raw_arg 逐字传递 `/select,"路径"`
    let arg = format!("/select,\"{target}\"");
    std::process::Command::new("explorer")
        .raw_arg(arg)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| AppError::Io(format!("打开资源管理器失败: {e}")))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn reveal_in_fm(p: &std::path::Path) -> AppResult<()> {
    std::process::Command::new("open")
        .args(["-R"])
        .arg(p)
        .spawn()
        .map_err(|e| AppError::Io(format!("在 Finder 中显示失败: {e}")))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_in_fm(p: &std::path::Path) -> AppResult<()> {
    let dir = p.parent().unwrap_or(p);
    std::process::Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map_err(|e| AppError::Io(format!("打开所在目录失败: {e}")))?;
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

/// 取走「打开方式」递交的待打开文件（取后即清），并标记前端监听已就绪。
/// 前端挂载完成时调用一次；规避事件先于监听注册的竞态，此后到达的文件改走事件派发。
#[tauri::command]
pub fn take_pending_open_args(state: State<'_, AppState>) -> Vec<String> {
    state.take_pending_open()
}

/// 应用内独立 WebView 窗口打开 URL（文档内超链接专用）。
/// 真 WebView2 实例，不受目标站 X-Frame-Options/CSP 限制（iframe 内嵌方案被大量网站拒绝）。
/// 新窗口仅加载远程页面：远程 origin 默认无任何应用 API 权限，与主窗口能力天然隔离。
#[tauri::command]
pub async fn open_web_window(app: tauri::AppHandle, url: String) -> AppResult<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(AppError::InvalidArg(format!(
            "仅支持 http/https 链接: {url}"
        )));
    }
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| AppError::InvalidArg(format!("URL 解析失败: {e}")))?;
    let host = parsed.host_str().unwrap_or("web").to_string();
    // label 全局唯一（时间戳毫秒 + host），重复点击同一链接各开一窗，互不干扰
    let label = format!(
        "web-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        host.replace(['.', ':'], "-")
    );
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(&host)
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| AppError::Io(format!("创建 Web 窗口失败: {e}")))?;
    Ok(())
}
