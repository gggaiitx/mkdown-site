use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};

pub struct DetectedText {
    pub content: String,
    /// "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | chardetng 猜测名（如 "GBK"）
    pub encoding: String,
    pub had_bom: bool,
    /// 内容是否本来就是 UTF-8 可无损写回（含 BOM）
    pub is_utf8: bool,
}

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 读取文本文件并做编码探测：
/// 1) UTF-8 BOM / UTF-16 BOM 直接识别；
/// 2) 无 BOM 先按 UTF-8 校验；
/// 3) 非法 UTF-8 时用 chardetng 猜测（GBK 等），转 UTF-8 供前端编辑。
pub fn read_text(path: &Path) -> AppResult<DetectedText> {
    let bytes = fs::read(path)?;

    if bytes.starts_with(&UTF8_BOM) {
        let (cow, _, _) = encoding_rs::UTF_8.decode(&bytes[UTF8_BOM.len()..]);
        return Ok(DetectedText {
            content: cow.into_owned(),
            encoding: "utf-8-bom".into(),
            had_bom: true,
            is_utf8: true,
        });
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return Ok(DetectedText {
            content: cow.into_owned(),
            encoding: "utf-16le".into(),
            had_bom: true,
            is_utf8: false,
        });
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return Ok(DetectedText {
            content: cow.into_owned(),
            encoding: "utf-16be".into(),
            had_bom: true,
            is_utf8: false,
        });
    }

    match std::str::from_utf8(&bytes) {
        Ok(s) => Ok(DetectedText {
            content: s.to_owned(),
            encoding: "utf-8".into(),
            had_bom: false,
            is_utf8: true,
        }),
        Err(_) => {
            let mut det = chardetng::EncodingDetector::new();
            det.feed(&bytes, true);
            let enc = det.guess(None, false);
            let (cow, _, _) = enc.decode(&bytes);
            Ok(DetectedText {
                content: cow.into_owned(),
                encoding: enc.name().to_string(),
                had_bom: false,
                is_utf8: false,
            })
        }
    }
}

/// 原子写：同目录临时文件 → 写入 → sync → persist(rename 覆盖)。
/// 保证「写到一半崩溃不毁原文件」。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::InvalidArg(format!("路径没有父目录: {}", path.display())))?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".mkdown-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    // PersistError 内核是 io::Error，转成 Io 变体保留语义
    tmp.persist(path)
        .map_err(|e| AppError::Io(format!("原子写落盘失败: {}", e.error)))?;
    Ok(())
}

pub fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t: SystemTime| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn mtime_from_meta(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 明确是纯文本的扩展名：命中即进编辑器，无需嗅探
const TEXT_EXTS: [&str; 46] = [
    "md",
    "markdown",
    "mdx",
    "txt",
    "text",
    "log",
    "csv",
    "tsv",
    "json",
    "jsonc",
    "json5",
    "yml",
    "yaml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "properties",
    "env",
    "xml",
    "xsd",
    "xsl",
    "html",
    "htm",
    "css",
    "scss",
    "less",
    "sass",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "vue",
    "svelte",
    "rs",
    "py",
    "rb",
    "go",
    "java",
    "sql",
    "sh",
    "bat",
    "ps1",
    "gitignore",
];

/// 明确不是文本的扩展名：直接交系统默认程序，不读内容
// 用切片而非定长数组：声明长度写死后每次增删条目都要同步改数字，
// 一旦漏改就是编译错误（历史上这里曾声明 52 而实际 76 项）。
const BINARY_EXTS: &[&str] = &[
    // Office
    "doc", "docx", "dot", "dotx", "docm", "xls", "xlsx", "xlsm", "xlsb", "ppt", "pptx", "pps",
    "ppsx", "pdf", "rtf", "odt", "ods", "odp", "wps", "et", "dps", // 图片 / 字体
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff", "emf", "wmf", "heic", "psd",
    "ttf", "otf", "woff", "woff2", "eot", // 音视频
    "mp3", "wav", "ogg", "flac", "mp4", "avi", "mov", "mkv", "wmv", "flv",
    // 归档 / 可执行 / 二进制
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "exe", "msi", "dll", "so", "dylib",
    "class", "jar", "node", "pyc", "o", "obj", "lib", "wasm", "db", "sqlite", "sqlite3", "dat",
    "bin", "pdb",
    // 图表源文件（mxfile XML）：内容是文本但语义是绘图，编辑器里看 XML 源码没有意义，
    // 直接交本机默认程序（draw.io 桌面版等）
    "drawio",
];

/// 无扩展名但确实是文本的常见文件名
const TEXT_NAMES: [&str; 7] = [
    "makefile",
    "dockerfile",
    "license",
    "readme",
    "changelog",
    "authors",
    "copying",
];

/// 嗅探读取上限：判定"是不是文本"只需开头一小段
const SNIFF_BYTES: usize = 8 * 1024;
/// 超过此大小一律按非文本处理，避免把 GB 级文件读进编辑器。
/// 同时作为 `read_file` 的硬闸门：与探测结果保持一致，探测判"非文本"的文件
/// 不会因为绕过探测（如从最近文件直接打开）而被整读进内存。
pub const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;

/// 判断文件能否作为文本在编辑器里打开。
///
/// 判定顺序：大小闸门 → 扩展名黑名单 → 扩展名白名单 → 无扩展名的常见文本名 → 内容嗅探。
/// 只有"未知扩展名"才真正读盘，白/黑名单命中时零 IO——这是文件树全量展示后
/// 仍要保持点击响应顺滑的关键。
pub fn is_text_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > MAX_TEXT_BYTES {
        return false;
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let lower_name = name.to_lowercase();
    match path.extension() {
        Some(ext) => {
            let ext = ext.to_string_lossy().to_lowercase();
            if BINARY_EXTS.contains(&ext.as_str()) {
                return false;
            }
            if TEXT_EXTS.contains(&ext.as_str()) {
                return true;
            }
        }
        None if TEXT_NAMES.contains(&lower_name.as_str()) => return true,
        None => {}
    }
    sniff_text(path)
}

/// 判断文件是否可在应用内预览（probe_preview_kind 命令的唯一真相源）。
///
/// 路由语义：命中 → 前端右侧内容区开"预览标签"（不进编辑器、不交系统程序）；
/// None → 维持原分流（文本进编辑器 / 其余交系统默认程序）。
///
/// 名单刻意从紧：
/// - docx：docx-preview（纯前端渲染 OOXML）；遗留 OLE 的 .doc 无可靠前端解析器，不收；
/// - xlsx/xlsm：SheetJS 解析 + HTML 表格渲染；.xls 同为 OLE，不收；
/// - image：仅收 WebView2（Chromium）原生可解码的格式；
///   tiff/heic/emf/wmf/psd 浏览器不能渲染，交系统查看器。
///
/// 文件本体不读盘，纯扩展名判定（与 is_text_file 同级的零 IO 闸门）。
pub fn preview_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    match ext.as_str() {
        "docx" => Some("docx"),
        "xlsx" | "xlsm" => Some("xlsx"),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "svg" | "ico" => Some("image"),
        _ => None,
    }
}

/// 内容嗅探：读前 8KB——有 BOM 或合法 UTF-8 即文本；含 NUL 字节即二进制；
/// 其余交给 chardetng，仅当能无损解码才认作文本（保底的 GBK 日志/配置）。
fn sniff_text(path: &Path) -> bool {
    use std::io::Read;

    let Ok(f) = fs::File::open(path) else {
        return false;
    };
    let mut buf = Vec::with_capacity(SNIFF_BYTES);
    let n = f
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut buf)
        .unwrap_or(0);
    if n == 0 {
        return true; // 空文件当文本，编辑器里就是一份空文档
    }
    buf.truncate(n);

    // 带 BOM 的一律按文本：UTF-16 内容里大量 NUL，不能走 NUL 判二进制
    if buf.starts_with(&UTF8_BOM)
        || buf.starts_with(&[0xFF, 0xFE])
        || buf.starts_with(&[0xFE, 0xFF])
    {
        return true;
    }
    if buf.contains(&0) {
        return false;
    }
    if std::str::from_utf8(&buf).is_ok() {
        return true;
    }

    let mut det = chardetng::EncodingDetector::new();
    det.feed(&buf, false);
    let enc = det.guess(None, false);
    if enc.name() == "UTF-8" {
        return false; // 猜回 UTF-8 说明上面校验已判非法
    }
    let (text, _, replaced) = enc.decode(&buf);
    !replaced && !text.contains('\u{FFFD}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, "# 标题\n内容").unwrap();
        let det = read_text(&p).unwrap();
        assert!(det.is_utf8 && !det.had_bom);
        assert_eq!(det.encoding, "utf-8");
        assert_eq!(det.content, "# 标题\n内容");
    }

    #[test]
    fn bom_is_detected_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("b.md");
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice("BOM 文档".as_bytes());
        fs::write(&p, &bytes).unwrap();
        let det = read_text(&p).unwrap();
        assert!(det.had_bom && det.is_utf8);
        assert_eq!(det.encoding, "utf-8-bom");
        assert_eq!(det.content, "BOM 文档");
    }

    #[test]
    fn gbk_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("c.md");
        let (bytes, _, _) = encoding_rs::GBK.encode("这是一份 GBK 编码的文档");
        fs::write(&p, bytes).unwrap();
        let det = read_text(&p).unwrap();
        assert!(!det.is_utf8);
        assert_eq!(det.content, "这是一份 GBK 编码的文档");
    }

    #[test]
    fn atomic_write_overwrites_and_no_tmp_left() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("d.md");
        fs::write(&p, "old").unwrap();
        write_atomic(&p, "新内容".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "新内容");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn text_file_detection() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "# 标题").unwrap();
        fs::write(dir.path().join("b.docx"), b"PK\x03\x04junk\x00\x01").unwrap();
        fs::write(dir.path().join("noext"), "plain text here").unwrap();
        fs::write(dir.path().join("raw.bin"), [0u8, 1, 2, 3]).unwrap();
        fs::write(dir.path().join("big.log"), "x".repeat(64)).unwrap();

        assert!(is_text_file(&dir.path().join("a.md")), "md 应为文本");
        assert!(
            !is_text_file(&dir.path().join("b.docx")),
            "docx 应走系统默认程序"
        );
        assert!(
            is_text_file(&dir.path().join("noext")),
            "无扩展名靠嗅探判为文本"
        );
        assert!(
            !is_text_file(&dir.path().join("raw.bin")),
            "含 NUL 应判二进制"
        );
        assert!(
            is_text_file(&dir.path().join("big.log")),
            "log 是已知文本扩展名"
        );
        assert!(
            !is_text_file(&dir.path().join("missing.md")),
            "不存在的文件不算文本"
        );
    }

    #[test]
    fn preview_kind_detection() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            preview_kind(&dir.path().join("a.docx")),
            Some("docx"),
            "docx 应进应用内预览"
        );
        assert_eq!(
            preview_kind(&dir.path().join("b.XLSX")),
            Some("xlsx"),
            "扩展名大小写不敏感"
        );
        assert_eq!(
            preview_kind(&dir.path().join("c.png")),
            Some("image"),
            "WebView2 可解码图片应进预览"
        );
        assert_eq!(
            preview_kind(&dir.path().join("d.tiff")),
            None,
            "浏览器不能渲染的格式不进预览"
        );
        assert_eq!(
            preview_kind(&dir.path().join("e.doc")),
            None,
            "遗留 OLE 格式维持系统打开"
        );
        assert_eq!(
            preview_kind(&dir.path().join("noext")),
            None,
            "无扩展名不预览"
        );
    }

    #[test]
    fn oversized_file_is_not_text() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("huge.md");
        // 超过 MAX_TEXT_BYTES：即便扩展名是 md 也不往编辑器里读
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(&vec![b'a'; (MAX_TEXT_BYTES + 1) as usize])
            .unwrap();
        drop(f);
        assert!(!is_text_file(&p));
    }

    #[test]
    fn atomic_write_to_new_nested_dir() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x/y/e.md");
        write_atomic(&p, "hi".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "hi");
    }
}
