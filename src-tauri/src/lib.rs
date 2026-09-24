//! MkDown 本地 Markdown 编辑与阅读器（Tauri 2 后端入口）。

mod commands;
mod error;
mod models;
mod services;
mod state;

use std::path::Path;

use tauri::{Emitter, Manager};

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

/// 把文件所在目录加入授权白名单（点击关联文件 = 用户显式意图，ADR-01 授权点之一）
fn grant_for_files(app: &tauri::AppHandle, files: &[String]) {
    let st = app.state::<state::AppState>();
    for f in files {
        if let Some(dir) = Path::new(f).parent() {
            st.grant_root(dir);
        }
    }
}

pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .manage(state::AppState::default())
        // 单实例：应用已运行时再次点击关联文件，不再拉起第二个空窗口，
        // 而是把文件路径转发给主窗口并聚焦。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = collect_file_args(&argv);
            grant_for_files(app, &files);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
                if !files.is_empty() {
                    // 主窗口前端早已挂载、监听已注册，事件直达
                    let _ = win.emit("open-file-args", files);
                }
            }
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
            // 恢复上次会话授权：上次工作区 + 最近文件所在目录。
            // 没有这一步，重启后点"最近文件"会被白名单拒绝（PERMISSION_DENIED），
            // 等于用安全缺口换功能性回退。
            let st = app.state::<state::AppState>();
            if let Ok(settings) = services::settings_service::load(app.handle()) {
                if let Some(ws) = &settings.last_workspace {
                    st.grant_root(Path::new(ws));
                }
                for rf in &settings.recent_files {
                    if let Some(dir) = Path::new(&rf.path).parent() {
                        st.grant_root(dir);
                    }
                }
            }
            // 「打开方式」/ 双击关联文件：解析启动参数里的文件路径。
            // 授权 + 存入待打开队列；前端挂载后经 take_pending_open_args 取走，
            // 不在 setup 里直接 emit——webview 页面此时多半还没注册监听。
            let files = collect_file_args(&std::env::args().collect::<Vec<String>>());
            grant_for_files(app.handle(), &files);
            st.set_pending_open(files);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 文件
            commands::file_cmd::read_file,
            commands::file_cmd::write_file_atomic,
            commands::file_cmd::save_as,
            commands::file_cmd::pick_open_file,
            commands::file_cmd::pick_workspace_dir,
            commands::file_cmd::get_file_meta,
            commands::file_cmd::probe_text_file,
            commands::file_cmd::probe_preview_kind,
            commands::file_cmd::open_in_system,
            commands::file_cmd::open_url,
            commands::file_cmd::take_pending_open_args,
            // 工作区
            commands::workspace_cmd::list_workspace_tree,
            commands::workspace_cmd::create_entry,
            commands::workspace_cmd::rename_entry,
            commands::workspace_cmd::delete_entry,
            // 搜索
            commands::search_cmd::search_in_files,
            commands::search_cmd::warm_search_cache,
            // 图片 / asset 授权
            commands::image_cmd::save_pasted_image,
            commands::image_cmd::allow_asset_dir,
            // 导出
            commands::export_cmd::export_html,
            // 设置
            commands::settings_cmd::get_settings,
            commands::settings_cmd::set_settings,
        ])
        .run(tauri::generate_context!())
}
