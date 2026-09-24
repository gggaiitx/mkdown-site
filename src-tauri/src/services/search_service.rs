use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::UTF8, SearcherBuilder};
use ignore::WalkState;

use crate::error::{AppError, AppResult};
use crate::models::{SearchHit, SearchQuery};
use crate::services::{fs_service, search_cache};

const LINE_TEXT_MAX_CHARS: usize = 300;

/// 无条件跳过的目录名。按「名称」排除而非「隐藏」属性 / gitignore：
/// Windows 文档库里点开头目录（如 .NET 文档目录）是正常业务目录，
/// ignore crate 的 hidden 过滤会把它整棵跳过导致"明明有内容却搜不到"。
/// 只排除真正的版本库/依赖目录：.workbuddy 之类应用数据目录里常有用户
/// 正在编辑的文档（本仓库就有 400+ 个 md），排除会让用户"搜什么都无命中"。
const EXCLUDED_DIRS: &[&str] = &[".git", "node_modules"];

/// 纯文本类扩展名（快路径：ripgrep 内核；非 UTF-8 走编码探测慢路径）
const TEXT_EXTS: &[&str] = &[
    "md", "markdown", "txt", "text", "log", "csv", "json", "yaml", "yml", "toml", "ini", "conf",
    "xml", "html", "htm", "css", "js", "ts", "vue", "sql", "py", "sh", "bat", "ps1",
];
/// OOXML 办公文档（zip + XML，需 office_text 还原正文）
const OOXML_EXTS: &[&str] = &["docx", "xlsx", "pptx"];
/// 遗留 OLE 办公文档（UTF-16LE 启发式抽取，尽力而为）
const OLE_EXTS: &[&str] = &["doc", "xls", "ppt"];

/// 检索类别：决定单文件走哪条读取路径
#[derive(Clone, Copy, PartialEq)]
enum FileKind {
    Text,
    Office,
}

/// 是否进入检索 + 走哪条路径。`include_glob` 仅为兼容旧语义保留：
/// 传 "*.md" 表示"仅 Markdown"；传 None 表示"全部可检索类型"。
/// 未列入的类型（dll/png/class 等二进制）一律跳过，避免无意义 IO。
fn classify(path: &Path, glob: Option<&str>) -> Option<FileKind> {
    if let Some(g) = glob {
        let suffix = g.trim_start_matches('*').to_lowercase();
        let name = path.file_name()?.to_string_lossy().to_lowercase();
        return if name.ends_with(&suffix) {
            Some(FileKind::Text)
        } else {
            None
        };
    }
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    let ext = ext.as_str();
    if OOXML_EXTS.contains(&ext) || OLE_EXTS.contains(&ext) {
        return Some(FileKind::Office);
    }
    if TEXT_EXTS.contains(&ext) {
        return Some(FileKind::Text);
    }
    None
}

/// 工作区全文检索（ripgrep 内核）：
/// - `ignore::WalkParallel` 多线程遍历（不启用 hidden/gitignore 过滤，仅按名称排除
///   .git / node_modules，Windows 点开头业务目录可搜）；
/// - 纯文本快路径 `grep-searcher`（ripgrep 同款逐文件匹配内核）；
/// - 非 UTF-8 文本文件（GBK 等）快路径报错后回退 `fs_service::read_text`（chardetng）
///   解码逐行匹配，与"打开文件"编码行为一致；
/// - Office 文档（docx/xlsx/pptx/doc/xls/ppt）先由 `office_text` 还原正文再匹配 ——
///   这类文件按字节 grep 必然 0 命中，是本仓库"搜什么都搜不到"的主因；
/// - 命中经 `emit` 即时抛出（前端 Channel 流式渲染），返回命中总数。MVP 不建索引（ADR-03）；
/// - `cancel` 为本轮取消令牌：新一轮搜索置停旧一轮，避免连续输入时
///   多轮全库扫描叠加（ADR-03 的轻量取消方案）。
pub fn search<F>(query: &SearchQuery, cancel: Arc<AtomicBool>, on_hit: F) -> AppResult<usize>
where
    F: Fn(SearchHit) + Send + Sync + 'static,
{
    if query.query.is_empty() {
        return Err(AppError::InvalidArg("搜索词不能为空".into()));
    }
    let root = Path::new(&query.root);
    if !root.is_dir() {
        return Err(AppError::NotFound(format!("目录不存在: {}", query.root)));
    }

    let pattern = if query.is_regex {
        query.query.clone()
    } else {
        regex::escape(&query.query)
    };
    let matcher = Arc::new(
        RegexMatcherBuilder::new()
            .case_insensitive(!query.case_sensitive)
            .build(&pattern)
            .map_err(|e| AppError::InvalidArg(format!("正则无效: {e}")))?,
    );

    let max_results = query.max_results.unwrap_or(2000).max(1);
    let glob = query.include_glob.clone();
    let total = Arc::new(AtomicUsize::new(0));
    let stop = cancel;
    let root_buf = Arc::new(root.to_path_buf());
    let on_hit = Arc::new(on_hit);

    ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .build_parallel()
        .run(|| {
            let matcher = Arc::clone(&matcher);
            let total = Arc::clone(&total);
            let stop = Arc::clone(&stop);
            let glob = glob.clone();
            let root = Arc::clone(&root_buf);
            let on_hit = Arc::clone(&on_hit);
            Box::new(move |entry| {
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if stop.load(Ordering::Relaxed) {
                    return WalkState::Quit; // 达到上限：本 worker 退出（其余 worker 自行检测 stop）
                }
                let path = entry.path();
                // 名称排除：路径任一段命中依赖/版本库/应用数据目录即跳过
                if path
                    .components()
                    .any(|c| EXCLUDED_DIRS.iter().any(|name| c.as_os_str() == *name))
                {
                    return WalkState::Continue;
                }
                if !path.is_file() {
                    return WalkState::Continue;
                }
                // 类型过滤：二进制资源（dll/png/class…）不进入检索
                let Some(kind) = classify(path, glob.as_deref()) else {
                    return WalkState::Continue;
                };
                // 大文件保护：文本 8MB / Office 32MB（内含图片时体积偏大）
                let size_cap = match kind {
                    FileKind::Text => 8 * 1024 * 1024,
                    FileKind::Office => 32 * 1024 * 1024,
                };
                if let Ok(md) = path.metadata() {
                    if md.len() > size_cap {
                        return WalkState::Continue;
                    }
                }
                let ctx = ScanCtx {
                    matcher: &matcher,
                    max_results,
                    total: &total,
                    stop: &stop,
                    emit: on_hit.as_ref(),
                };
                search_file(path, kind, &root, &ctx);
                WalkState::Continue
            })
        });

    Ok(total.load(Ordering::Relaxed))
}

/// 后台建索引：只做「抽取正文 + 写缓存」，不做匹配。
///
/// 冷缓存时首次检索要解压全库 docx（实测 62s）。工作区打开后在后台跑一遍，
/// 把这笔成本提前消化掉，用户真正按下搜索时读缓存即可（实测 4s / 高频词 40ms）。
/// 返回已缓存的文档数；并发安全（缓存写入走临时文件 + rename）。
pub fn warm(root: &str) -> AppResult<usize> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(AppError::NotFound(format!("目录不存在: {root}")));
    }
    let cached = Arc::new(AtomicUsize::new(0));

    ignore::WalkBuilder::new(root_path)
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .build_parallel()
        .run(|| {
            let cached = Arc::clone(&cached);
            Box::new(move |entry| {
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                let path = entry.path();
                if path
                    .components()
                    .any(|c| EXCLUDED_DIRS.iter().any(|name| c.as_os_str() == *name))
                {
                    return WalkState::Continue;
                }
                if !path.is_file() {
                    return WalkState::Continue;
                }
                // 只缓存办公文档：纯文本读取本身很快，缓存收益不足以抵消写盘成本
                if classify(path, None) != Some(FileKind::Office) {
                    return WalkState::Continue;
                }
                if let Ok(md) = path.metadata() {
                    if md.len() > 32 * 1024 * 1024 {
                        return WalkState::Continue;
                    }
                }
                if search_cache::office_text(path).is_some() {
                    cached.fetch_add(1, Ordering::Relaxed);
                }
                WalkState::Continue
            })
        });

    Ok(cached.load(Ordering::Relaxed))
}

/// 单次检索的共享上下文：matcher / 上限 / 计数 / 停止位 / 回调打包传递，
/// 避免 `search_file` / `scan_text` 参数列表膨胀（clippy too_many_arguments）。
struct ScanCtx<'a, F: Fn(SearchHit)> {
    matcher: &'a grep_regex::RegexMatcher,
    max_results: usize,
    total: &'a AtomicUsize,
    stop: &'a AtomicBool,
    emit: &'a F,
}

/// 记录一次命中；若达到结果上限则置停止位（其余 worker 自行检测后退出）
fn record_hit(ctx_total: &AtomicUsize, ctx_stop: &AtomicBool, max_results: usize) {
    if ctx_total.fetch_add(1, Ordering::Relaxed) + 1 >= max_results {
        ctx_stop.store(true, Ordering::Relaxed);
    }
}

/// 单文件检索。前置编码预判：整文件字节合法 UTF-8 → grep-searcher（ripgrep 内核）；
/// 否则（GBK 等）→ read_text 编码探测解码后逐行匹配，与"打开文件"行为一致。
/// 必须前置预判的原因：grep-searcher 的 sink 只回调"匹配的行"，GBK 字节行与 UTF-8
/// 模式天然不匹配，sink 内无法感知编码（lossy/Bytes 均不触发回调）。
fn search_file<F: Fn(SearchHit)>(path: &Path, kind: FileKind, root: &Path, ctx: &ScanCtx<'_, F>) {
    let rel = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let path_str = path.to_string_lossy().into_owned();

    match kind {
        // Office 文档：正文来自持久缓存（首次抽取后落盘，二次检索直接读文本）。
        // 全库 docx 正文 XML 合计 2.1GB，不缓存则每次都要重新解压。
        FileKind::Office => {
            if let Some(text) = search_cache::office_text(path) {
                scan_text(&text, &path_str, &rel, ctx);
            }
        }
        FileKind::Text => {
            let Ok(bytes) = fs::read(path) else { return };
            if std::str::from_utf8(&bytes).is_ok() {
                // ---- 快路径：ripgrep 内核 ----
                let mut searcher = SearcherBuilder::new().line_number(true).build();
                let matcher = ctx.matcher;
                let stop = ctx.stop;
                let sink = UTF8(|line_num: u64, line: &str| {
                    if stop.load(Ordering::Relaxed) {
                        return Ok(false);
                    }
                    let line = line.trim_end_matches(['\r', '\n']);
                    let Some(m) = matcher.find(line.as_bytes()).ok().flatten() else {
                        return Ok(true);
                    };
                    // 字节偏移 → 字符列（前端按字符定位）
                    let cs = line[..m.start()].chars().count();
                    let ce = line[..m.end()].chars().count();
                    let hit = make_hit(&path_str, &rel, line_num as usize, line, cs, ce);
                    record_hit(ctx.total, ctx.stop, ctx.max_results);
                    (ctx.emit)(hit);
                    if stop.load(Ordering::Relaxed) {
                        return Ok(false);
                    }
                    Ok(true)
                });
                // 单文件 IO 失败（被占用/权限变化/正在保存）不中断整体检索，
                // 但要留痕而非静默吞掉 Result
                if let Err(e) = searcher.search_path(matcher, path, sink) {
                    eprintln!("[mkdown][search] 跳过 {}: {e}", path.display());
                }
            } else if let Ok(det) = fs_service::read_text(path) {
                // ---- 慢路径：编码探测解码（GBK/UTF-16 等）后按整文匹配 ----
                scan_text(&det.content, &path_str, &rel, ctx);
            }
        }
    }
}

/// 整文一次匹配（而非逐行调用 matcher）。
///
/// 关键性能差异：逐行 `matcher.find` 的调用次数 = 行数（全库百万级），
/// 而整文 `find_at` 循环只有「命中数 + 1」次。命中偏移再映射回行号/列号。
fn scan_text<F: Fn(SearchHit)>(text: &str, path_str: &str, rel: &str, ctx: &ScanCtx<'_, F>) {
    let bytes = text.as_bytes();
    let mut at = 0usize;
    let mut line_start = 0usize;
    let mut line_no = 1usize;

    while at < bytes.len() {
        if ctx.stop.load(Ordering::Relaxed) {
            break;
        }
        let Ok(Some(m)) = ctx.matcher.find_at(bytes, at) else {
            break;
        };
        // 匹配有序，行游标线性推进即可（整体 O(n)）
        while let Some(p) = text[line_start..m.start()].find('\n') {
            line_start += p + 1;
            line_no += 1;
        }
        let line_end = text[line_start..]
            .find('\n')
            .map(|p| line_start + p)
            .unwrap_or(text.len());
        let raw = &text[line_start..line_end];
        let line = raw.trim();
        // 前导空白被 trim 掉的字符数（列号需相应扣减）
        let lead_bytes = raw.len() - raw.trim_start().len();
        let lead = raw[..lead_bytes].chars().count();
        let cs = text[line_start..m.start()].chars().count() - lead;
        let ce = text[line_start..m.end()].chars().count() - lead;
        let hit = make_hit(path_str, rel, line_no, line, cs, ce);
        record_hit(ctx.total, ctx.stop, ctx.max_results);
        (ctx.emit)(hit);
        if ctx.stop.load(Ordering::Relaxed) {
            break;
        }
        // 空匹配（如正则 `a*`）会让 at 不前进，按字符边界强制推进一位
        at = if m.end() > m.start() {
            m.end()
        } else {
            match text[m.end()..].chars().next() {
                Some(c) => m.end() + c.len_utf8(),
                None => break,
            }
        };
    }
}

/// 命中构造：行文本截断到 300 字符。列与命中区间均按**字符**计（前端按字符定位）。
fn make_hit(
    path_str: &str,
    rel: &str,
    line_no: usize,
    line: &str,
    char_start: usize,
    char_end: usize,
) -> SearchHit {
    let mut text: String = line.chars().take(LINE_TEXT_MAX_CHARS).collect();
    if line.chars().count() > LINE_TEXT_MAX_CHARS {
        text.push('…');
    }
    SearchHit {
        path: path_str.to_string(),
        rel_path: rel.to_string(),
        line: line_no,
        column: char_start + 1,
        line_text: text,
        match_start: char_start,
        match_end: char_end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    /// 运行一次搜索并收集命中（并行检索下跨文件顺序不确定，断言一律用 find/any）
    fn run_search(q: &SearchQuery) -> (usize, Vec<SearchHit>) {
        let hits: Arc<Mutex<Vec<SearchHit>>> = Arc::new(Mutex::new(Vec::new()));
        let hc = Arc::clone(&hits);
        let cancel = Arc::new(AtomicBool::new(false));
        let n = search(q, cancel, move |h| hc.lock().unwrap().push(h)).unwrap();
        let v = Arc::try_unwrap(hits).unwrap().into_inner().unwrap();
        (n, v)
    }

    fn mkfile(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    #[test]
    fn finds_hits_with_line_and_column() {
        let dir = tempfile::tempdir().unwrap();
        mkfile(dir.path(), "a.md", "第一行\n审方中心建设方案\n第三行");
        mkfile(dir.path(), "sub/b.md", "无命中\n也 mention 审方中心");
        fs::write(dir.path().join("skip.txt"), "审方中心").unwrap();

        let q = SearchQuery {
            root: dir.path().to_string_lossy().into_owned(),
            query: "审方中心".into(),
            case_sensitive: false,
            is_regex: false,
            include_glob: Some("*.md".into()),
            max_results: None,
        };
        let (n, hits) = run_search(&q);
        assert_eq!(n, 2);
        let a = hits.iter().find(|h| h.rel_path == "a.md").unwrap();
        assert_eq!(a.line, 2);
        assert_eq!(a.column, 1);
        assert_eq!(a.match_end - a.match_start, 4); // 4 个汉字
        let b = hits.iter().find(|h| h.rel_path == "sub/b.md").unwrap();
        assert_eq!(b.line, 2);
    }

    #[test]
    fn case_insensitive_default() {
        let dir = tempfile::tempdir().unwrap();
        mkfile(dir.path(), "x.md", "Hello Tauri");
        let q = SearchQuery {
            root: dir.path().to_string_lossy().into_owned(),
            query: "hello".into(),
            case_sensitive: false,
            is_regex: false,
            include_glob: None,
            max_results: None,
        };
        let (n, _) = run_search(&q);
        assert_eq!(n, 1);

        let q2 = SearchQuery {
            case_sensitive: true,
            ..q
        };
        let (n2, _) = run_search(&q2);
        assert_eq!(n2, 0);
    }

    #[test]
    fn regex_mode_and_max_results() {
        let dir = tempfile::tempdir().unwrap();
        mkfile(dir.path(), "r.md", "v1\nv22\nv333\nv4444");
        let q = SearchQuery {
            root: dir.path().to_string_lossy().into_owned(),
            query: "v\\d{3}".into(),
            case_sensitive: false,
            is_regex: true,
            include_glob: None,
            max_results: Some(2),
        };
        // 单文件内快路径按行序缓冲，顺序稳定
        let (n, hits) = run_search(&q);
        assert_eq!(n, 2);
        assert_eq!(hits[0].line, 3);
    }

    #[test]
    #[ignore = "真实工作区探针，手工运行"]
    fn probe_real_workspace() {
        let root = r"D:\相关方案文档";
        // 同一查询连跑两轮：第一轮冷缓存（抽取+写盘），第二轮热缓存（直接读文本）
        for round in 1..=2 {
            for w in ["审方", "网盘"] {
                let q = SearchQuery {
                    root: root.into(),
                    query: w.into(),
                    case_sensitive: false,
                    is_regex: false,
                    include_glob: None,
                    max_results: None,
                };
                let t0 = std::time::Instant::now();
                let (n, hits) = run_search(&q);
                println!("== 第{round}轮 {w}: total={n} in {:?}", t0.elapsed());
                for h in hits.iter().take(3) {
                    println!("   {} L{} | {}", h.rel_path, h.line, h.line_text);
                }
            }
        }
    }

    /// GBK 编码文件可搜（慢路径）+ 点开头业务目录不被当隐藏跳过 + .git 排除
    #[test]
    fn gbk_and_dot_dirs_are_searchable_but_git_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let (enc, _, _) = encoding_rs::GBK.encode("审方中心建设方案\n");
        fs::write(dir.path().join("gbk.md"), enc).unwrap();
        mkfile(
            dir.path(),
            ".NET互联网审方技术文档/inner.md",
            "隐藏目录里的审方中心\n",
        );
        mkfile(dir.path(), ".git/config.md", "审方中心\n");

        let q = SearchQuery {
            root: dir.path().to_string_lossy().into_owned(),
            query: "审方中心".into(),
            case_sensitive: false,
            is_regex: false,
            include_glob: Some("*.md".into()),
            max_results: None,
        };
        let (n, hits) = run_search(&q);
        assert_eq!(
            n,
            2,
            "GBK 文件与点开头目录内文件都应命中，.git 排除；hits={:?}",
            hits.iter().map(|h| h.rel_path.clone()).collect::<Vec<_>>()
        );
        assert!(hits.iter().any(|h| h.rel_path == "gbk.md"));
        assert!(hits
            .iter()
            .any(|h| h.rel_path.contains(".NET互联网审方技术文档")));
    }
}
