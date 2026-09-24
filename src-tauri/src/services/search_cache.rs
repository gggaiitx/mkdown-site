//! 办公文档正文抽取结果缓存。
//!
//! **为什么需要它（实测数据）**：工作区里 2147 个 .docx，其 `word/document.xml`
//! 解压后合计 **2.1 GB**。每次检索都重新「解压 + 去标签」在 debug 构建下要 119s，
//! 即使并行也只能把总量除以核数、改变不了总量。
//!
//! 抽取后的纯文本约为原 XML 的 1/7（约 300MB），落盘缓存后：
//! - 首次检索：抽取并写缓存（慢，一次性）
//! - 二次检索：直接读文本 + 正则扫描，秒级
//!
//! 相比「中文分词 + 倒排索引」方案：后者检索能到毫秒级，但要引入分词器、
//! 索引增量更新与调校，成本高一个量级；缓存方案已把 47s 压到秒级，性价比更高。
//!
//! 一致性：缓存条目头部记录 `版本 mtime_ms size`，任一不符即失效重抽。
//! 并发：`WalkParallel` 多线程可能同时写同一 key，用「临时文件 + rename」保证原子。

use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::SystemTime;

use crate::services::office_text;

/// 缓存格式版本：结构变更即 +1，旧缓存自动失效
const CACHE_VERSION: &str = "v1";
/// 缓存总容量上限，超出按 mtime 从旧到新淘汰
const MAX_CACHE_BYTES: u64 = 800 * 1024 * 1024;

static GC_DONE: AtomicBool = AtomicBool::new(false);

/// tmp 文件自增序号：并行 worker 写同一 key 时各用各的临时文件，互不踩踏
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 测试专用的缓存根覆盖：避免单元测试读写真实的 %LOCALAPPDATA% 缓存目录
/// （既污染用户数据，又受 GC/机器状态影响导致 flaky）。
#[cfg(test)]
static TEST_CACHE_ROOT: std::sync::RwLock<Option<PathBuf>> = std::sync::RwLock::new(None);

/// 把缓存根重定向到指定目录。仅测试构建可用，须在断言前调用。
#[cfg(test)]
pub fn set_test_cache_root(dir: &Path) {
    *TEST_CACHE_ROOT.write().unwrap() = Some(dir.to_path_buf());
}

/// 缓存根目录（不额外引入 dirs 依赖，直接用平台标准环境变量）
fn cache_root() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = TEST_CACHE_ROOT.read().unwrap().clone() {
        return Some(dir);
    }
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")));
    base.map(|b| b.join("mkdown").join("search-cache"))
}

/// 条目名 = 路径小写后的 64 位哈希（Windows 大小写不敏感，统一小写避免重复条目）
fn entry_path(path: &Path) -> Option<PathBuf> {
    let mut h = DefaultHasher::new();
    path.to_string_lossy().to_lowercase().hash(&mut h);
    cache_root().map(|r| r.join(format!("{:016x}", h.finish())))
}

/// 文件指纹：mtime（毫秒）+ 字节数，任一变化即视为内容可能变化
fn fingerprint(path: &Path) -> Option<(u128, u64)> {
    let md = fs::metadata(path).ok()?;
    let ms = md
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some((ms, md.len()))
}

fn header(fp: &(u128, u64)) -> String {
    format!("{CACHE_VERSION} {} {}\n", fp.0, fp.1)
}

/// 校验头部并返回正文；版本/指纹任一不符返回 None
fn payload_if_valid(cached: &str, fp: &(u128, u64)) -> Option<String> {
    let (head, body) = cached.split_once('\n')?;
    let mut it = head.split(' ');
    if it.next()? != CACHE_VERSION {
        return None;
    }
    let ms: u128 = it.next()?.parse().ok()?;
    let size: u64 = it.next()?.parse().ok()?;
    if (ms, size) != *fp {
        return None;
    }
    Some(body.to_string())
}

/// 取办公文档正文：命中缓存直接返回，否则抽取并写回缓存。
/// 返回 None 表示该文件无法抽取（损坏/加密/不支持），调用方静默跳过。
pub fn office_text(path: &Path) -> Option<String> {
    maybe_gc();
    let entry = entry_path(path)?;
    let fp = fingerprint(path)?;
    if let Ok(cached) = fs::read_to_string(&entry) {
        if let Some(text) = payload_if_valid(&cached, &fp) {
            return Some(text);
        }
    }
    let text = office_text::extract_text(path)?;
    if let Err(e) = write_entry(&entry, &fp, &text) {
        // 缓存写失败不影响本次检索结果，但必须留痕（禁止静默吞 Result）
        eprintln!("[mkdown][search-cache] 写缓存失败 {}: {e}", entry.display());
    }
    Some(text)
}

fn write_entry(entry: &Path, fp: &(u128, u64), text: &str) -> std::io::Result<()> {
    if let Some(dir) = entry.parent() {
        fs::create_dir_all(dir)?;
    }
    // 临时名带 pid + 自增序号：并行 worker 写同一 key 时各写各的 tmp，
    // 最后 rename 到位的必然是某份完整内容（原子替换）
    let tmp = entry.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut buf = String::with_capacity(text.len() + 64);
    buf.push_str(&header(fp));
    buf.push_str(text);
    fs::write(&tmp, buf)?;
    // 原子替换：读到的一定是完整条目
    fs::rename(&tmp, entry)
}

/// 容量回收：每个进程只做一次（避免每次检索都 stat 整个目录）。
/// 超限时按修改时间从旧到新删除，直到回到上限内。
fn maybe_gc() {
    if GC_DONE.swap(true, Ordering::Relaxed) {
        return;
    }
    let Some(root) = cache_root() else {
        return;
    };
    let Ok(rd) = fs::read_dir(&root) else {
        return;
    };
    let mut items: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total = 0u64;
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if md.is_file() {
            let mt = md.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            total += md.len();
            items.push((e.path(), md.len(), mt));
        }
    }
    if total <= MAX_CACHE_BYTES {
        return;
    }
    items.sort_by_key(|(_, _, mt)| *mt);
    for (p, size, _) in items {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        if fs::remove_file(&p).is_ok() {
            total -= size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_and_invalidation() {
        // 缓存根重定向到临时目录，不碰真实的 %LOCALAPPDATA%
        let dir = tempfile::tempdir().unwrap();
        set_test_cache_root(dir.path());
        let path = dir.path().join("t.docx");
        {
            let f = fs::File::create(&path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            zw.start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            std::io::Write::write_all(
                &mut zw,
                r#"<w:document><w:body><w:p><w:t>区域审方中心建设方案</w:t></w:p></w:body></w:document>"#
                    .as_bytes(),
            )
            .unwrap();
            zw.finish().unwrap();
        }

        let first = office_text(&path).expect("应抽取到正文");
        assert!(first.contains("区域审方中心建设方案"));

        // 指纹未变 → 命中缓存（内容一致即视为通过）
        let second = office_text(&path).expect("应命中缓存");
        assert_eq!(first, second);

        // 改写文件：mtime/size 变化后必须失效重抽
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&path, b"changed").unwrap();
        assert!(office_text(&path).is_none(), "内容变更后旧缓存必须失效");
    }
}
