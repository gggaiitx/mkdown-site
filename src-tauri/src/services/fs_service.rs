use std::cmp::Ordering;
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
    /// 解码时出现了无法解码的字节（内容里已插入 U+FFFD）：
    /// 原文再也无法逐字节还原，处于这种状态的文档只能另存为 UTF-8
    pub had_decode_errors: bool,
}

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 读取文本文件并做编码探测：
/// 1) UTF-8 BOM / UTF-16 BOM 直接识别；
/// 2) 无 BOM 先按 UTF-8 校验；
/// 3) 非法 UTF-8 时用 chardetng 猜测（GBK 等），转 UTF-8 供前端编辑。
/// 解码中出现无法解码的字节时记入 `had_decode_errors`：那些位置已经变成 U+FFFD，
/// 原始字节不可还原，前端据此禁止就地保存、只能另存为 UTF-8。
pub fn read_text(path: &Path) -> AppResult<DetectedText> {
    let bytes = fs::read(path)?;
    Ok(detect_text(&bytes))
}

/// 编码探测核心（字节 → DetectedText）。与 `read_text` 分离，
/// 供 `read_file` 的限量读路径复用：先 `take(MAX+1)` 限量读再探测，
/// 避免「metadata 检查 + 全量 read」两步之间文件增长越过闸门（P1-6）。
pub fn detect_text(bytes: &[u8]) -> DetectedText {
    if bytes.starts_with(&UTF8_BOM) {
        let (cow, _, had_errors) = encoding_rs::UTF_8.decode(&bytes[UTF8_BOM.len()..]);
        return DetectedText {
            content: cow.into_owned(),
            encoding: "utf-8-bom".into(),
            had_bom: true,
            is_utf8: true,
            had_decode_errors: had_errors,
        };
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, had_errors) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return DetectedText {
            content: cow.into_owned(),
            encoding: "utf-16le".into(),
            had_bom: true,
            is_utf8: false,
            had_decode_errors: had_errors,
        };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, had_errors) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return DetectedText {
            content: cow.into_owned(),
            encoding: "utf-16be".into(),
            had_bom: true,
            is_utf8: false,
            had_decode_errors: had_errors,
        };
    }

    match std::str::from_utf8(bytes) {
        Ok(s) => DetectedText {
            content: s.to_owned(),
            encoding: "utf-8".into(),
            had_bom: false,
            is_utf8: true,
            had_decode_errors: false,
        },
        Err(_) => {
            let mut det = chardetng::EncodingDetector::new();
            det.feed(bytes, true);
            let enc = det.guess(None, false);
            let (cow, _, had_errors) = enc.decode(bytes);
            DetectedText {
                content: cow.into_owned(),
                encoding: enc.name().to_string(),
                had_bom: false,
                is_utf8: false,
                had_decode_errors: had_errors,
            }
        }
    }
}

/// 按原编码把文本编回字节（保存链路）。
///
/// - `encoding` 取 `detect_text` 报出的名字（`utf-8` / `utf-8-bom` / `utf-16le` / `utf-16be` /
///   chardetng 猜测名如 `GBK`）；传空串或未知值不静默兜底，一律报错由前端提示另存为 UTF-8。
/// - UTF-8 两档由本函数自己补 BOM：`encoding_rs` 的 UTF-8 编码器不写 BOM，语义不如显式清楚；
///   其余编码交给 `encode_without_bom_handling`，UTF-16 两档按 `keep_bom` 手工补 BOM
///   （BOM 必须保住——无 BOM 的 UTF-16 下次打开会被当未知编码，整篇乱码）。
/// - 编码无法表示正文中的字符（GBK 里写 emoji）时返回 `Encoding` 错误，**绝不静默替换成 `?`**：
///   静默替换会悄悄改坏文档，且用户无从发现。
/// - 再做一次往返校验（encode → decode 还原同一文本）：chardetng 是猜测，把 GBK 认成
///   windows-1252 时往返必然对不上，宁可拒绝保存也不能写坏原文件。
pub fn encode_text(content: &str, encoding: &str, keep_bom: bool) -> AppResult<Vec<u8>> {
    let label = encoding.trim().to_ascii_lowercase();
    if label.is_empty() || label == "utf-8" || label == "utf8" || label == "utf-8-bom" {
        let mut bytes = Vec::with_capacity(content.len() + UTF8_BOM.len());
        if keep_bom || label == "utf-8-bom" {
            bytes.extend_from_slice(&UTF8_BOM);
        }
        bytes.extend_from_slice(content.as_bytes());
        return Ok(bytes);
    }

    let enc = encoding_rs::Encoding::for_label(encoding.trim().as_bytes()).ok_or_else(|| {
        AppError::Encoding(format!("无法识别的文件编码 {encoding}，请另存为 UTF-8"))
    })?;

    // UTF-16 手工编码：encoding_rs 里这两档的 *output encoding* 是 UTF-8（WHATWG 规范），
    // `encode()` 拿到的是 UTF-8 字节，写回 UTF-16 文件会把编码整个换掉。
    // UTF-16 能表示全部 Unicode（Rust str 不存在孤立代理项），无需可表示性检查。
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let le = enc == encoding_rs::UTF_16LE;
        let mut out = Vec::with_capacity(content.len() * 2 + 2);
        if keep_bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE][..] } else { &[0xFE, 0xFF][..] });
        }
        for unit in content.encode_utf16() {
            let b = if le {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            };
            out.extend_from_slice(&b);
        }
        return Ok(out);
    }

    let (body, _, had_unmappable) = enc.encode(content);
    if had_unmappable {
        return Err(AppError::Encoding(format!(
            "当前编码 {} 无法表示正文中的部分字符（例如表情符号），请另存为 UTF-8",
            enc.name()
        )));
    }
    let (back, _, back_errors) = enc.decode(&body);
    if back_errors || back != content {
        return Err(AppError::Encoding(format!(
            "按 {} 回写会改变正文，已中止保存；请另存为 UTF-8",
            enc.name()
        )));
    }
    Ok(body.into_owned())
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

/// 明确是纯文本的扩展名：命中即进编辑器，无需嗅探。
/// 用切片而非定长数组：声明长度写死后每次增删条目都要同步改数字，
/// 一旦漏改就是编译错误（BINARY_EXTS 已因此改为切片，这里对齐）。
/// 集合与前端 src/adapters/codeLanguage.ts 的 loaders 及 src/utils/fileKind.ts 的 EXT_KIND 对齐。
const TEXT_EXTS: &[&str] = &[
    // —— 基础文本 / 标记 ——
    "md", "markdown", "mdx",
    // 富文本（wangEditor 原生 HTML，.mh 文件族，2026-10-10 加）
    "mh",
    "txt", "text", "log", "csv", "tsv",
    "gitignore",
    // lockfile（Cargo.lock/poetry.lock/pubspec.lock 等均为 TOML 文本；二进制 .lock 罕见且有 8MB 闸门兜底）
    "lock",
    // —— 配置 / 数据交换 ——
    "json", "jsonc", "json5", "ndjson", "geojson", "jsonld",
    "yml", "yaml", "toml",
    "ini", "cfg", "conf", "properties", "env", "config", "cnf", "inf",
    // systemd unit / desktop 入口（ini 风格键值，2026-10-09 补）
    "service", "timer", "socket", "target", "mount", "desktop",
    "xml", "xsd", "xsl", "rss", "atom", "wsdl", "plist",
    "diff", "patch",
    // —— Web ——
    "html", "htm", "xhtml", "svg",
    "vue", "svelte",
    "jsp", "jspx", "erb", "ejs", "hbs", "mustache",
    "css", "scss", "less", "sass", "pcss", "styl",
    // —— 脚本 / 后端 ——
    "js", "mjs", "cjs", "jsx", "es6", "pac",
    "ts", "tsx", "mts", "cts",
    "py", "pyw", "pyi", "pyx",
    "rs",
    "java",
    "rb", "rake", "gemspec", "ru",
    "sh", "bash", "zsh", "ksh",
    "bat", "ps1", "pwsh",
    "lua", "luau", "nse",
    "pl", "pm", "perl",
    "r",
    "swift",
    "go",
    "sql", "mysql", "pgsql", "postgres", "sqlite", "mssql", "mariadb", "oracle", "hive", "spark",
    // —— C / C++ / C# / 系 ——
    "c", "h", "cpp", "hpp", "cc", "cxx", "hxx", "hh", "c++", "h++",
    "ino", "ipp", "tpp",
    "cs", "scala", "kotlin", "kt", "dart",
    // —— 其他编译型语言 ——
    "pas", "pp", "p", "lpr", "dpr",
    "d",
    "f", "for", "f77", "f90", "f95", "f03", "f08", "fpp", "ftn",
    "v", "sv", "svh", "vhd", "vhdl",
    "asm", "s", "nasm",
    "cob", "cbl", "cobol",
    "cr",
    "groovy", "gradle", "gvy",
    "julia", "jl",
    "clj", "cljs", "cljc", "edn",
    "hs", "lhs",
    "elm",
    "erl", "hrl",
    "lisp", "cl", "lsp", "el",
    "scm", "ss",
    "ocaml", "ml", "fs", "fsharp", "sml",
    "coffeescript", "coffee", "iced",
    // —— 标记 / 查询 / 文档 ——
    "tex", "sty", "cls", "bib", "stex",
    "tcl", "tclsh",
    "feature",
    "proto",
    "solr", "sparql", "rq", "ttl", "nt", "msc",
    "widl", "webidl", "idl",
    "xq", "xql", "xquery", "xqy", "xqm",
    // —— 构建 / 运维 / DSL ——
    "dockerfile", "containerfile", "cmake",
    "nsi", "nsh",
    "puppet",
    "vb", "vbs",
    "vm",
    "nginx",
    "rpm", "spec",
    "oz", "pig", "pegjs", "peg", "sas",
    // —— 函数式 / 学术 / 小众 ——
    "factor", "fcl", "forth", "frt",
    "dylan", "dyl", "ebnf", "ecl",
    "eiffel", "e",
    "haxe", "hxml",
    "http",
    "jinja", "j2", "jinja2",
    "livescript", "ls",
    "mathematica", "mma",
    "mbox",
    "mirc", "mrc",
    "modelica", "mo",
    "octave",
    "smalltalk", "st",
    "sieve", "siv",
    "textile",
    "tiddlywiki", "tid",
    "tiki",
    "troff", "roff",
    "ttcn", "ttcn3", "ttcnpp",
    "wast", "wat",
    "yacas",
    "z80",
    "apl",
    "asn", "asn1",
    "asc",
    "asterisk",
    "brainfuck", "bf",
    "cypher", "cql",
    "dtd",
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

/// 无扩展名（含点开头 dotfile）但确实是文本的常见文件名（全小写匹配）。
/// 白名单命中零 IO——新增常见 dotfile 时在此补，别依赖嗅探（文件树全量判定会读盘）。
const TEXT_NAMES: [&str; 15] = [
    "makefile",
    "dockerfile",
    "license",
    "readme",
    "changelog",
    "authors",
    "copying",
    // dotfiles / 无扩展名构建文件（2026-10-11 补：免嗅探读盘，着色由前端按文件名映射）
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".editorconfig",
    ".npmrc",
    "gemfile",
    "rakefile",
    "jenkinsfile",
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

/// 扩展名层面的「能否按文本处理」：口径与 `is_text_file` 的白/黑名单一致
/// （BINARY 优先命中即否），但不读盘、不嗅探、不看大小。
///
/// 给检索分类这类「整棵树批量判定」的场景复用，免得各服务各抄一份名单——
/// `search_service` 原先那份就漏过 `svg`（编辑器能开能存，搜索里却隐身），
/// 而 `sqlite` 在 TEXT_EXTS 与 BINARY_EXTS 里都挂过，按 BINARY 优先归二进制，不再当文本搜。
/// 传入的 `ext` 必须是**已小写**的纯扩展名（不含点）。
pub fn is_text_ext(ext: &str) -> bool {
    !BINARY_EXTS.contains(&ext) && TEXT_EXTS.contains(&ext)
}

/// 应用内预览支持的图片格式：仅收 WebView/Chromium 原生可解码者，
/// tiff/heic/emf/wmf/psd 不收（浏览器渲染不了，交系统查看器）。
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico"];

/// 判断文件是否可在应用内预览（probe_preview_kind 命令的唯一真相源）。
///
/// 路由语义：命中 → 前端右侧内容区开"预览标签"（不进编辑器、不交系统程序）；
/// None → 维持原分流（文本进编辑器 / 其余交系统默认程序）。
///
/// 名单刻意从紧：
/// - docx：docx-preview（纯前端渲染 OOXML）；遗留 OLE 的 .doc 无可靠前端解析器，不收；
/// - xlsx/xlsm：SheetJS 解析 + HTML 表格渲染；.xls 同为 OLE，不收；
/// - image：仅收 WebView2（Chromium）原生可解码的格式；
///   tiff/heic/emf/wmf/psd 浏览器不能渲染，交系统查看器；
/// - pdf：pdfjs-dist 纯前端渲染（应用内预览，阶段二）；
/// - svg 不在此列：内容是文本（is_text_file 命中在先），前端按 kind='svg'
///   开文本标签支持编辑/分栏/阅读三模式（阅读态由 SvgFrame 渲染）。
///
/// 文件本体不读盘，纯扩展名判定（与 is_text_file 同级的零 IO 闸门）。
pub fn preview_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    match ext.as_str() {
        "docx" => Some("docx"),
        "xlsx" | "xlsm" => Some("xlsx"),
        "pdf" => Some("pdf"),
        e if IMAGE_EXTS.contains(&e) => Some("image"),
        _ => None,
    }
}

/// 同一目录下、与 path 同族的全部文件，按文件名自然排序。
/// 图片 / PDF / Word / Excel 按 preview_kind 分族；文本按前端 TabKind 的归类分族
/// （md、mh、html/htm、svg，其余同扩展名一族）。左右键切换用它：只读目录项，不读文件内容。
pub fn sibling_files(path: &Path) -> AppResult<Vec<String>> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::InvalidArg(format!("路径没有父目录: {}", path.display())))?;
    let Some(group) = nav_group(path) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<String> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let p = entry.path();
        // Word 打开文档时会生成 "~$xxx.docx" 属主锁文件；macOS 拷贝会留下 "._xxx" 资源叉。
        // 两者扩展名都对得上，但预览必失败，不参与轮换。
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("~$") || name.starts_with("._") {
            continue;
        }
        if nav_group(&p).is_some_and(|g| g == group) {
            out.push(p.to_string_lossy().into_owned());
        }
    }
    out.sort_by(|a, b| natural_cmp(file_name(a), file_name(b)));
    Ok(out)
}

/// 同目录轮换的分组键。预览类直接复用 preview_kind，文本类与 textKindOf 保持同一归类口径。
fn nav_group(path: &Path) -> Option<String> {
    if let Some(kind) = preview_kind(path) {
        return Some(kind.to_string());
    }
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    if ext.is_empty() {
        return None;
    }
    Some(match ext.as_str() {
        "md" | "markdown" | "mdx" => "md".to_string(),
        "mh" => "mh".to_string(),
        "html" | "htm" => "html".to_string(),
        "svg" => "svg".to_string(),
        other => format!("ext:{other}"),
    })
}

fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// 文件名自然排序：连续数字按数值比（img2 < img10），其余字符按小写比。
/// 资源管理器的习惯排序，避免 img10 排到 img2 前面。
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ac = a.chars().peekable();
    let mut bc = b.chars().peekable();
    loop {
        let (x, y) = match (ac.peek().copied(), bc.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => (x, y),
        };
        if x.is_ascii_digit() && y.is_ascii_digit() {
            let mut xn = String::new();
            while let Some(d) = ac.peek().copied().filter(|c| c.is_ascii_digit()) {
                xn.push(d);
                ac.next();
            }
            let mut yn = String::new();
            while let Some(d) = bc.peek().copied().filter(|c| c.is_ascii_digit()) {
                yn.push(d);
                bc.next();
            }
            let xt = xn.trim_start_matches('0');
            let yt = yn.trim_start_matches('0');
            let ord = xt.len().cmp(&yt.len()).then_with(|| xt.cmp(yt));
            if ord != Ordering::Equal {
                return ord;
            }
        } else {
            let ord = x.to_ascii_lowercase().cmp(&y.to_ascii_lowercase());
            if ord != Ordering::Equal {
                return ord;
            }
            ac.next();
            bc.next();
        }
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
        assert!(!det.had_decode_errors);
    }

    /// 解码时出现非法字节：内容里已经混入 U+FFFD，标记必须报出来
    /// （前端据此禁止就地保存——写回等于把看不懂的字节永久替换掉）
    #[test]
    fn decode_errors_are_flagged() {
        // 用「UTF-8 BOM + 非法字节」这条确定的路径：探测编码固定为 utf-8-bom，
        // 不会像无 BOM 那样被 chardetng 猜成 windows-1252（后者什么字节都能解、不会报错）
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(&[0x41, 0xFF, 0xFE, 0x42]);
        let det = detect_text(&bytes);
        assert_eq!(det.encoding, "utf-8-bom");
        assert!(det.had_decode_errors, "非法 UTF-8 字节必须被标记");
        assert!(det.content.contains('\u{FFFD}'));
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
        assert!(!det.had_decode_errors, "合法 GBK 不应报解码错误");
    }

    /// GBK 文档就地保存：写回的字节必须仍是 GBK，且读回来一字不差
    #[test]
    fn gbk_saves_back_in_original_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("gbk.txt");
        let (bytes, _, _) = encoding_rs::GBK.encode("中文段落，含标点。");
        fs::write(&p, bytes).unwrap();
        let det = read_text(&p).unwrap();
        let edited = format!("{}已编辑", det.content);
        let out = encode_text(&edited, &det.encoding, det.had_bom).unwrap();
        fs::write(&p, &out).unwrap();
        // 仍是 GBK：中文 GBK 字节必然是非法 UTF-8 序列，若写成 UTF-8 这条断言会失败
        assert!(std::str::from_utf8(&out).is_err(), "回写后不应变成 UTF-8");
        let again = read_text(&p).unwrap();
        assert_eq!(again.content, edited);
        assert_eq!(again.encoding, "GBK");
    }

    /// GBK 表示不了 emoji：必须报错，不能静默写成 `?`
    #[test]
    fn gbk_rejects_unrepresentable_text() {
        let err = encode_text("中文😀", "GBK", false).unwrap_err();
        assert!(matches!(err, AppError::Encoding(_)), "应为编码错误: {err:?}");
        assert!(
            err.to_string().contains("无法表示"),
            "提示要说明原因: {err}"
        );
    }

    /// BOM 在保存后必须原样保住：UTF-16 丢了 BOM，下次打开会被当未知编码整篇乱码
    #[test]
    fn bom_survives_save() {
        let utf8bom = encode_text("文档", "utf-8-bom", true).unwrap();
        assert!(utf8bom.starts_with(&UTF8_BOM));
        let u16le = encode_text("文档", "utf-16le", true).unwrap();
        assert_eq!(&u16le[..2], &[0xFF, 0xFE]);
        let u16be = encode_text("文档", "utf-16be", true).unwrap();
        assert_eq!(&u16be[..2], &[0xFE, 0xFF]);
        // 无 BOM 的 UTF-8 不被凭空加 BOM
        let plain = encode_text("文档", "utf-8", false).unwrap();
        assert!(!plain.starts_with(&UTF8_BOM));
    }

    /// 编码猜错时必须拒绝保存，而不是写坏原文件
    #[test]
    fn wrong_encoding_is_rejected() {
        assert!(encode_text("plain ascii", "GBK", false).is_ok(), "能表示则允许");
        assert!(encode_text("中文", "windows-1252", false).is_err(), "1252 表示不了中文");
        assert!(encode_text("中文", "no-such-encoding", false).is_err(), "未知编码名要拒绝");
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
            preview_kind(&dir.path().join("f.PDF")),
            Some("pdf"),
            "pdf 应进应用内预览且大小写不敏感"
        );
        std::fs::write(dir.path().join("f.pdf"), b"%PDF-1.7\n1 0 obj\nendobj\ntrailer\n%%EOF").unwrap();
        assert!(
            !is_text_file(&dir.path().join("f.pdf")),
            "pdf 必须留在二进制黑名单，不得被嗅探判为文本"
        );
        assert_eq!(
            preview_kind(&dir.path().join("noext")),
            None,
            "无扩展名不预览"
        );
    }

    #[test]
    fn svg_opens_as_text_for_three_modes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.svg");
        fs::write(&p, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").unwrap();
        // svg 语义是图片但内容是文本：进编辑器（前端 tabsStore 归 kind='svg'，
        // 由 SvgFrame 提供分栏/阅读态的 webview 渲染），不走只读图片预览
        assert!(is_text_file(&p), "svg 应作为文本进编辑器");
        assert_eq!(preview_kind(&p), None, "svg 不进只读图片预览，三模式由前端接管");
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

    #[test]
    fn image_exts_agree_with_preview_kind() {
        for ext in IMAGE_EXTS {
            let name = format!("sample.{ext}");
            assert_eq!(
                preview_kind(Path::new(&name)),
                Some("image"),
                "{ext} 列在 IMAGE_EXTS 里却不被 preview_kind 受理"
            );
        }
    }

    #[test]
    fn sibling_files_groups_by_type_and_sorts_naturally() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "img10.PNG",
            "img2.jpg",
            "img1.webp",
            "note.md",
            "note10.md",
            "note2.md",
            "clip.gif",
            "~$note.docx",
            "plan.docx",
            "plan.pdf",
        ] {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        fs::create_dir(dir.path().join("folder.png")).unwrap();

        let images = sibling_files(&dir.path().join("img2.jpg")).unwrap();
        let names: Vec<&str> = images.iter().map(|p| file_name(p)).collect();
        assert_eq!(
            names,
            vec!["clip.gif", "img1.webp", "img2.jpg", "img10.PNG"],
            "图片同族、目录不算，且数字按数值排序"
        );

        let notes = sibling_files(&dir.path().join("note2.md")).unwrap();
        let names: Vec<&str> = notes.iter().map(|p| file_name(p)).collect();
        assert_eq!(names, vec!["note.md", "note2.md", "note10.md"]);

        let words = sibling_files(&dir.path().join("plan.docx")).unwrap();
        let names: Vec<&str> = words.iter().map(|p| file_name(p)).collect();
        assert_eq!(names, vec!["plan.docx"], "~$ 属主锁文件不参与轮换");
    }
}
