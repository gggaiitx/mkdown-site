use tauri::AppHandle;

use crate::error::AppResult;
use crate::models::AppSettings;
use crate::services::settings_service;

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> AppResult<AppSettings> {
    settings_service::load(&app)
}

#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: AppSettings) -> AppResult<()> {
    settings_service::save(&app, &settings)
}
