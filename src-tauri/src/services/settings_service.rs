use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::models::AppSettings;

const FILE_NAME: &str = "settings.json";

/// 设置文件路径：`$APPCONFIG/settings.json`（Windows: %APPDATA%\<identifier>\settings.json）。
/// 注：MVP 未引入 tauri-plugin-store，由本服务直接读写（字段简单、无并发写场景），
/// 行为与 ADR-08 等价（落 app config 目录），后续如需迁移到 store 插件仅改本文件。
pub fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::error::AppError::Internal(format!("无法定位配置目录: {e}")))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(FILE_NAME))
}

pub fn load(app: &AppHandle) -> AppResult<AppSettings> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(&path)?;
    match serde_json::from_str::<AppSettings>(&raw) {
        Ok(s) => Ok(s),
        Err(e) => {
            // 损坏的设置文件不致命：回默认值并保留原文件供排查
            log_warn(format!("settings.json 解析失败，使用默认值: {e}"));
            Ok(AppSettings::default())
        }
    }
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> AppResult<()> {
    let path = config_path(app)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::Internal(format!("设置序列化失败: {e}")))?;
    crate::services::fs_service::write_atomic(&path, &json)?;
    Ok(())
}

fn log_warn(msg: String) {
    eprintln!("[mkdown][warn] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RecentFile;

    #[test]
    fn default_settings_shape() {
        let s = AppSettings::default();
        assert_eq!(s.theme, "light");
        assert_eq!(s.editor_mode, "split");
        assert_eq!(s.auto_save_delay_ms, 800);
        assert!(s.recent_files.is_empty());
    }

    #[test]
    fn settings_json_roundtrip() {
        let s = AppSettings {
            theme: "dark".into(),
            font_size: 17,
            last_workspace: Some("D:\\资料".into()),
            recent_files: vec![RecentFile {
                path: "D:\\资料\\a.md".into(),
                opened_at_ms: 1727078400000,
            }],
            ..AppSettings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.theme, "dark");
        assert_eq!(back.font_size, 17);
        assert_eq!(back.recent_files.len(), 1);
        // camelCase 字段名
        assert!(json.contains("\"fontSize\""));
        assert!(json.contains("\"lastWorkspace\""));
    }
}
