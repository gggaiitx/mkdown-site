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
    // 非法值兜底（与 TS DEFAULT_SETTINGS 语义一致）：editor_engine 只认 markdown/wangeditor；
    // word 引擎/管线只认各自枚举值（2026-10-13 新增）
    let mut settings = settings.clone();
    if settings.editor_engine != "markdown" && settings.editor_engine != "wangeditor" {
        settings.editor_engine = "markdown".into();
    }
    if settings.word_export_engine != "builtin" && settings.word_export_engine != "community" {
        settings.word_export_engine = "builtin".into();
    }
    if settings.word_import_fidelity != "semantic" && settings.word_import_fidelity != "fidelity" {
        settings.word_import_fidelity = "semantic".into();
    }
    // 导出留白夹进滑块同区间（0~40px）：手改 settings.json 塞个几千会把导出的图撑成一圈空白
    settings.export_padding = settings.export_padding.min(40);
    // 预览浮块工具条：档位只认三档，其余退回默认「auto」（和上面几组枚举同一个口径）。
    // 落位只粗夹——真正的贴边夹取由前端按面板实时尺寸做（面板宽会被分栏拖变，
    // 这里存死的 px 反而会把浮块顶到看不见的位置）
    if !matches!(settings.preview_bar_mode.as_str(), "auto" | "shown" | "hidden") {
        settings.preview_bar_mode = "auto".into();
    }
    settings.preview_bar_x = settings.preview_bar_x.clamp(0.0, 1.0);
    settings.preview_bar_bottom = settings.preview_bar_bottom.clamp(4.0, 2000.0);
    let json = serde_json::to_vec_pretty(&settings)
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
        assert_eq!(s.editor_engine, "markdown");
        assert_eq!(s.outline_style, "fresh");
        assert!(s.recent_files.is_empty());
    }

    /// 老配置文件（升级前写的）没有 outline_style 这个键：必须落到出厂默认，
    /// 而不是反序列化失败把整份设置丢回默认值
    #[test]
    fn missing_key_falls_back_to_default() {
        let s: AppSettings = serde_json::from_str(r#"{"theme":"dark","fontSize":14}"#).unwrap();
        assert_eq!(s.theme, "dark");
        assert_eq!(s.font_size, 14.0);
        assert_eq!(s.outline_style, "fresh");
        assert!(s.sibling_nav, "旧 settings.json 没有该字段时左右键切换默认开启");
        assert!(!s.dialog_close_on_mask, "旧 settings.json 没有该字段时点弹窗外不关闭");
    }

    #[test]
    fn theme_mode_and_palettes_roundtrip() {
        // 旧配置（本版之前只有 theme）：themeMode 读出空串 → 前端据此按 theme 迁移成手动模式，
        // 两套配色落到出厂值（素白 / 石墨），升级后外观与升级前完全一致
        let old: AppSettings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(old.theme_mode, "", "旧配置没有 themeMode 时必须是空串哨兵，不能默认成 system");
        assert_eq!(old.theme_palette_light, "paper");
        assert_eq!(old.theme_palette_dark, "graphite");

        // 新配置：三字段 camelCase 存回读出
        let s: AppSettings = serde_json::from_str(
            r#"{"themeMode":"system","themePaletteLight":"sepia","themePaletteDark":"midnight"}"#,
        )
        .unwrap();
        assert_eq!(s.theme_mode, "system");
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"themeMode\":\"system\""));
        assert!(json.contains("\"themePaletteLight\":\"sepia\""));
        assert!(json.contains("\"themePaletteDark\":\"midnight\""));
    }

    #[test]
    fn outline_style_roundtrips_camel_case() {
        let s: AppSettings = serde_json::from_str(r#"{"outlineStyle":"classic"}"#).unwrap();
        assert_eq!(s.outline_style, "classic");
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"outlineStyle\":\"classic\""));
    }

    #[test]
    fn settings_json_roundtrip() {
        let s = AppSettings {
            theme: "dark".into(),
            font_size: 15.5, // 半档字号：必须能原样存回读出（u32 时代这里会直接反序列化失败）
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
        assert_eq!(back.font_size, 15.5);
        assert_eq!(back.recent_files.len(), 1);
        // camelCase 字段名
        assert!(json.contains("\"fontSize\""));
        assert!(json.contains("\"lastWorkspace\""));
    }
}
