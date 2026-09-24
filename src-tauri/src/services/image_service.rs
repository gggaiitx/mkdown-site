use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::error::{AppError, AppResult};
use crate::models::SavedImage;
use crate::services::fs_service;

const ALLOWED_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

/// 粘贴图片落盘：写入当前文档同级 `assets/` 目录，文件名 `img-<uuid>.<ext>`，原子写。
/// 返回绝对路径与相对路径（相对当前 md，保证文档可整体搬迁）。
pub fn save_pasted_image(doc_path: &Path, data_base64: &str, ext: &str) -> AppResult<SavedImage> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(AppError::Unsupported(format!("不支持的图片格式: {ext}")));
    }
    let doc_path = doc_path
        .parent()
        .ok_or_else(|| AppError::InvalidArg("文档没有父目录，请先保存文档".into()))?;

    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|e| AppError::InvalidArg(format!("图片数据 Base64 解码失败: {e}")))?;
    if bytes.is_empty() {
        return Err(AppError::InvalidArg("图片数据为空".into()));
    }

    let assets_dir = doc_path.join("assets");
    let file_name = format!("img-{}.{}", uuid::Uuid::new_v4().simple(), ext);
    let abs = assets_dir.join(&file_name);
    fs_service::write_atomic(&abs, &bytes)?;

    Ok(SavedImage {
        abs_path: abs.to_string_lossy().into_owned(),
        rel_path: format!("./assets/{file_name}"),
        file_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn saves_png_and_returns_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("方案.md");
        fs::write(&doc, "x").unwrap();
        // 1x1 PNG 的最小合法 base64
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let saved = save_pasted_image(&doc, png_b64, "png").unwrap();
        assert!(saved.rel_path.starts_with("./assets/img-"));
        assert!(saved.rel_path.ends_with(".png"));
        assert!(Path::new(&saved.abs_path).exists());
    }

    #[test]
    fn rejects_bad_ext_and_bad_base64() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("a.md");
        fs::write(&doc, "x").unwrap();
        assert!(save_pasted_image(&doc, "aaaa", "exe").is_err());
        assert!(save_pasted_image(&doc, "!!!!not-base64!!!", "png").is_err());
    }
}
