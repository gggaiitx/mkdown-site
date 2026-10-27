//! MkDown 本地 Markdown 编辑与阅读器（Tauri 2 后端入口）。

mod commands;
mod error;
mod models;
mod services;
mod state;

use std::path::Path;

use tauri::utils::config::Color;
use tauri::{Emitter, Manager};

use crate::models::AppSettings;

/// 从命令行参数里筛出"真实存在的文件"路径（跳过 argv[0] 与开关项）。
/// Windows「打开方式」/ 双击关联文件时，路径作为普通参数传入。
/// 仅要求存在且是文件——扩展名分流（md/docx/图片/其它）交给前端 openFilePath。
fn collect_file_args(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| Path::new(a).is_file())
        .cloned()
        .collect()
}

/// 把「用…打开」递交的 URL 转成本地文件路径。
/// macOS 经 Apple Event（RunEvent::Opened）给的是 file:// URL；
/// 非本地文件 URL 一律忽略，不存在的路径也丢弃（与命令行参数口径一致）。
#[cfg(any(target_os = "macos", test))]
fn file_urls_to_paths(urls: &[tauri::Url]) -> Vec<String> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// 把文件所在目录加入授权白名单（点击关联文件 = 用户显式意图，ADR-01 授权点之一）
fn grant_for_files(app: &tauri::AppHandle, files: &[String]) {
    let st = app.state::<state::AppState>();
    for f in files {
        if let Some(dir) = Path::new(f).parent() {
            st.grant_root(dir);
        }
    }
}

/// 「打开方式」文件的统一派发：Windows 的命令行 / 单实例转发、macOS 的 Apple Event
/// 共用这一条。前端监听器还没注册时先入队（挂载后经 take_pending_open_args 取走），
/// 否则启动瞬间到达的文件会被事件循环静默丢弃。
fn dispatch_open_files(app: &tauri::AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    grant_for_files(app, &files);
    if app.state::<state::AppState>().stage_open_files(files.clone()) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("open-file-args", files);
        }
    }
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 恢复上次会话的目录授权：上次工作区 + 最近文件所在目录。
/// 没有这一步，重启后点"最近文件"会被白名单拒绝（PERMISSION_DENIED），
/// 等于用安全缺口换功能性回退。
///
/// ★ 整包跑在后台线程（启动提速 P2）：`grant_root` 内的 `canonicalize()` 对失效网络盘、
/// 拔掉的移动硬盘会走到 Windows 路径解析超时，单条就能卡住数秒，而它原先在 `setup` 里
/// ——窗口显示之前。用户看到的不是"慢"，是"双击图标后毫无反应"。
/// 授权是尽力而为、且晚到几百毫秒不影响功能：前端打开任何文件都另有
/// `allow_asset_dir` / 对话框授权通路。
fn grant_session_roots(app: &tauri::AppHandle, settings: Option<&AppSettings>) {
    let Some(settings) = settings else {
        return;
    };
    let st = app.state::<state::AppState>();
    if let Some(ws) = &settings.last_workspace {
        st.grant_root(Path::new(ws));
    }
    for rf in &settings.recent_files {
        if let Some(dir) = Path::new(&rf.path).parent() {
            st.grant_root(dir);
        }
    }
}

/// 主题对应的窗口底色（与 `global.css` 的 `--mk-bg` 同源：亮 #fff / 暗 rgb(19,20,22)）。
///
/// 窗口配置改成 `visible: false`（启动提速 P2）：WebView 出首帧之前那一层由窗口底色占位，
/// 不预设就是系统白底——暗色用户每次启动先挨一下白闪，而主题要等前端 `settings.load()`
/// 的 IPC 往返回来才写进 `documentElement`。`setup` 里本就读过 settings，
/// 顺手按主题把底色钉好再 `show`，不额外等任何一环。
fn theme_background(theme: &str) -> Color {
    match theme {
        "dark" => Color(19, 20, 22, 255),
        _ => Color(255, 255, 255, 255),
    }
}

pub fn run() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .manage(state::AppState::default())
        // 单实例：应用已运行时再次点击关联文件，不再拉起第二个空窗口，
        // 而是把文件路径转发给主窗口并聚焦。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_main_window(app);
            dispatch_open_files(app, collect_file_args(&argv));
        }))
        // 拖放 = 用户在操作系统层面的显式意图（ADR-01 授权点之一）：
        // 把拖入文件所在目录 / 拖入目录本身加入运行时白名单。
        // 前端 onDragDropEvent 照常收到事件，两者互不影响。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let st = window.app_handle().state::<state::AppState>();
                for p in paths {
                    if p.is_dir() {
                        st.grant_root(p);
                    } else if let Some(dir) = p.parent() {
                        st.grant_root(dir);
                    }
                }
            }
        })
        .setup(|app| {
            let settings = services::settings_service::load(app.handle()).ok();

            // 底色按主题预设好之后再显示窗口（配置里 visible:false，见 theme_background 注释）
            match app.get_webview_window("main") {
                Some(win) => {
                    let theme = settings
                        .as_ref()
                        .map(|s| s.theme.as_str())
                        .unwrap_or("light");
                    if let Err(e) = win.set_background_color(Some(theme_background(theme))) {
                        eprintln!("[mkdown][warn] 设置窗口底色失败: {e}");
                    }
                    if let Err(e) = win.show() {
                        eprintln!("[mkdown][warn] 显示主窗口失败: {e}");
                    }
                }
                // 理论上到不了这里：配置窗口在 setup 之前就已创建
                None => eprintln!("[mkdown][warn] 未找到 main 窗口，跳过显示"),
            }

            // 会话目录授权挪到后台线程（见 grant_session_roots 注释）
            let handle = app.handle().clone();
            let restored = settings.clone();
            match std::thread::Builder::new()
                .name("grant-restore".into())
                .spawn(move || grant_session_roots(&handle, restored.as_ref()))
            {
                Ok(_) => {}
                // 起线程失败（系统资源耗尽）：宁可同步跑完，也不能让最近文件全部失去授权
                Err(e) => {
                    eprintln!("[mkdown][warn] 授权线程启动失败，改同步执行: {e}");
                    grant_session_roots(app.handle(), settings.as_ref());
                }
            }

            // 「打开方式」/ 双击关联文件：解析启动参数里的文件路径。
            // 这一批保持同步：授权必须赶在前端 take_pending_open_args 取件之前落定，
            // 且参数里的文件由资源管理器递交、必然存在，不会踩路径解析超时。
            // 前端挂载后经 take_pending_open_args 取走，不在 setup 里直接 emit——
            // webview 页面此时多半还没注册监听。
            let files = collect_file_args(&std::env::args().collect::<Vec<String>>());
            grant_for_files(app.handle(), &files);
            app.state::<state::AppState>().set_pending_open(files);

            // 预览临时文档（HTML 预览落盘的明文副本）不跨会话留存；目录不存在时只是一次 stat
            commands::preview_cmd::prune_at_startup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 文件
            commands::file_cmd::read_file,
            commands::file_cmd::write_file_atomic,
            commands::file_cmd::save_text_at,
            commands::file_cmd::browse_dirs,
            commands::file_cmd::default_workspace_parent,
            commands::file_cmd::get_file_meta,
            commands::file_cmd::probe_text_file,
            commands::file_cmd::probe_preview_kind,
            commands::file_cmd::list_sibling_files,
            commands::file_cmd::open_in_system,
            commands::file_cmd::open_url,
            commands::file_cmd::open_web_window,
            commands::file_cmd::reveal_in_explorer,
            commands::file_cmd::take_pending_open_args,
            // 工作区
            commands::workspace_cmd::list_workspace_tree,
            commands::workspace_cmd::create_workspace,
            commands::workspace_cmd::create_entry,
            commands::workspace_cmd::rename_entry,
            commands::workspace_cmd::move_entry,
            commands::workspace_cmd::delete_entry,
            // 渲染层错误日志（白屏/半白界面的现场）
            commands::log_cmd::log_renderer_error,
            // 搜索
            commands::search_cmd::search_in_files,
            commands::search_cmd::warm_search_cache,
            // 图片 / asset 授权
            commands::image_cmd::save_pasted_image,
            commands::image_cmd::allow_asset_dir,
            // HTML 预览临时文档
            commands::preview_cmd::write_preview_doc,
            commands::preview_cmd::delete_preview_doc,
            // 导出
            commands::export_cmd::export_html,
            commands::export_cmd::export_docx,
            commands::export_cmd::export_pdf,
            commands::export_cmd::export_png,
            commands::export_cmd::export_long_image,
            // 更新检测
            commands::update_cmd::check_update,
            commands::update_cmd::download_update,
            commands::update_cmd::apply_update,
            // 设置
            commands::settings_cmd::get_settings,
            commands::settings_cmd::set_settings,
            // 系统字体（设置-外观「字体」下拉）
            commands::system_fonts::list_system_fonts,
            // 会话快照（标签页 + 未保存草稿，更新重启/崩溃恢复）
            commands::session_cmd::get_session,
            commands::session_cmd::set_session,
        ])
        .build(tauri::generate_context!())?;

    app.run(|app, event| {
        // macOS「用…打开」/ 双击关联文件走 Apple Event，文件以 file:// URL 递交。
        // 默认的 Builder::run 用空回调把它丢掉——窗口照开、文件不开，正是这个 bug。
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            focus_main_window(app);
            dispatch_open_files(app, file_urls_to_paths(&urls));
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_urls_become_local_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("demo.py");
        std::fs::write(&file, "print(1)").unwrap();

        let url = tauri::Url::from_file_path(&file).unwrap();
        assert_eq!(
            file_urls_to_paths(&[url]),
            vec![file.to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn non_file_urls_and_missing_paths_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let urls = [
            tauri::Url::parse("https://example.com/a.py").unwrap(),
            tauri::Url::from_file_path(dir.path().join("gone.py")).unwrap(),
        ];
        assert!(file_urls_to_paths(&urls).is_empty());
    }
}
