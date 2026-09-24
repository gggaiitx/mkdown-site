//! MkDown 本地 Markdown 编辑与阅读器（Tauri 2 后端入口）。

mod commands;
mod error;
mod models;
mod services;
mod state;

use std::path::Path;

use tauri::Manager;

pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .manage(state::AppState::default())
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
