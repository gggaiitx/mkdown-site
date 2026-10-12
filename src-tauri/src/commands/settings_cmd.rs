use tauri::AppHandle;

use crate::commands::file_cmd::spawn_io;
use crate::error::AppResult;
use crate::models::AppSettings;
use crate::services::settings_service;

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> AppResult<AppSettings> {
    // settings.json 读写是同步 IO：放 blocking 池，避免占用 async runtime（P1-5）
    spawn_io(move || settings_service::load(&app)).await
}

#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: AppSettings) -> AppResult<()> {
    spawn_io(move || settings_service::save(&app, &settings)).await
}
