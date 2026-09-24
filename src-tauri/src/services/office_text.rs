//! Office 文档纯文本抽取（供全局检索使用）。
//!
//! 为什么需要它：工作区里绝大多数内容是 Office 文档（本仓库实测 .docx 2147 个、
//! .doc 390 个、.xlsx/.pptx 若干），这些格式**无法按字节 grep**——docx 是 zip 包，
//! 字节层面全是 DEFLATE 压缩流，直接搜必然 0 命中。必须先把正文还原成文本再匹配。
//!
//! 两条路径：
//! - **OOXML（.docx/.xlsx/.pptx）**：zip + XML。解包取正文 XML，按段落/行/形状
//!   边界切成"行"，去标签 + 实体解码后交给调用方。
//! - **遗留 OLE（.doc/.xls/.ppt）**：无轻量解析器，采用 UTF-16LE 文本串启发式抽取
//!   （Word 97-2003 含中文的文档正文几乎都以 UTF-16LE 存放，实测有效）。
//!   属尽力而为：抽不到就不产生任何行，不影响其余文件检索。
//!
//! 设计为**流式回调**（`for_each_line`）而非返回 `Vec<String>`：一个 docx 常含数千段落，
//! 全库 2000+ 个文档若逐行分配会产生上千万次堆分配，实测全库扫描 53s；改为复用缓冲
//! 后逐文件仅个位数分配。
//!
//! 约定：回调的每一项对应一条"可展示的行"。对 Office 文档而言行号 = 段落/单元格
//! 序号（不是屏幕行），命中跳转按段落定位。

use std::borrow::Cow;
use std::fs;
use std::io::Read;
use std::path::Path;

/// 单个 XML 部件的大小上限，防止异常包把内存打爆
const MAX_PART_BYTES: usize = 32 * 1024 * 1024;

/// 逐行回调。`visit` 返回 false 表示"够了，停止"。函数返回是否产出过至少一行。
pub fn for_each_line(path: &Path, mut visit: impl FnMut(&str) -> bool) -> bool {
    let Some(ext) = path.extension() else {
        return false;
    };
    let ext = ext.to_string_lossy().to_lowercase();
    match ext.as_str() {
        "docx" | "xlsx" | "pptx" => for_each_ooxml_line(path, &ext, &mut visit),
        "doc" | "xls" | "ppt" => {
            let Ok(bytes) = fs::read(path) else {
                return false;
            };
            if !is_ole(&bytes) {
                return false; // 实为 RTF/HTML/docx 的"假 .doc"，不做误判
            }
            for_each_ole_line(&bytes, visit)
        }
        _ => false,
    }
}

/// 一次性取回全部行。仅测试/调试使用（生产路径请用 [`for_each_line`]），
/// 故不参与非测试构建，避免 dead_code 警告。
#[cfg(test)]
pub fn extract_lines(path: &Path) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let any = for_each_line(path, |line| {
        out.push(line.to_string());
        true
    });
    if any {
        Some(out)
    } else {
        None
    }
}

/// 抽取整篇正文为单个字符串（行间以 `\n` 分隔）。供检索缓存落盘使用：
/// 缓存只需存文本，行号由消费方按 `\n` 还原。
pub fn extract_text(path: &Path) -> Option<String> {
    let mut out = String::new();
    let any = for_each_line(path, |line| {
        out.push_str(line);
        out.push('\n');
        true
    });
    if any {
        Some(out)
    } else {
        None
    }
}

/// OLE 复合文档魔数 D0 CF 11 E0 A1 B1 1A E1
fn is_ole(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
}

/// OLE 头扇区大小。头 512 字节是结构化的目录/扇区表，不是正文；
/// 若从 0 开始扫，魔数 D0CF 11E0 A1B1 1AE1 会被当 UTF-16 码元解出
/// "쿐\u{e011}놡\u{e11a}" 并粘到第一条正文行上（实测会出现）。
const OLE_HEADER_BYTES: usize = 512;

/// 二进制垃圾码元：私用区（OLE 结构化数据解出大量 U+E000–U+F8FF）、
/// 非字符 U+FFFE/U+FFFF、代理项区。遇到即断行，避免污染正文。
fn is_junk_char(c: char) -> bool {
    let u = c as u32;
    (0xE000..=0xF8FF).contains(&u) || u == 0xFFFE || u == 0xFFFF || (0xD800..=0xDFFF).contains(&u)
}

/// 目标 XML 部件判定 + 该部件的分段标签
fn part_spec(name: &str, ext: &str) -> Option<&'static [&'static str]> {
    match ext {
        // 正文 + 页眉页脚；<w:p> 段落、<w:br> 软换行、<w:tr> 表格行
        "docx" => {
            if name == "word/document.xml"
                || name.starts_with("word/header")
                || name.starts_with("word/footer")
            {
                Some(&["w:p", "w:br", "w:tr"])
            } else {
                None
            }
        }
        // 共享字符串表（真实文本）+ 工作表（行结构，含数字与内联串）
        "xlsx" => {
            if name == "xl/sharedStrings.xml" {
                Some(&["si"])
            } else if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
                Some(&["row"])
            } else {
                None
            }
        }
        // 每页幻灯片：<a:p> 段落（显式列出，未知扩展名一律不识别）
        "pptx" => {
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                Some(&["a:p"])
            } else {
                None
            }
        }
        _ => None,
    }
}

fn for_each_ooxml_line(path: &Path, ext: &str, visit: &mut impl FnMut(&str) -> bool) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let Ok(mut zip) = zip::ZipArchive::new(file) else {
        return false;
    };
    // 先收集名字再逐个读：借用检查不允许遍历时持有 zip 的可变借用
    let mut names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    names.sort();

    let mut emitted = false;
    let mut buf: Vec<u8> = Vec::new();
    for name in names {
        let Some(break_tags) = part_spec(&name, ext) else {
            continue;
        };
        buf.clear();
        let read_ok = match zip.by_name(&name) {
            Ok(f) => f.take(MAX_PART_BYTES as u64).read_to_end(&mut buf).is_ok(),
            Err(_) => false,
        };
        if !read_ok {
            continue;
        }
        // 合法 UTF-8 直接借用，省一次整包拷贝
        let xml: Cow<str> = match std::str::from_utf8(&buf) {
            Ok(s) => Cow::Borrowed(s),
            Err(_) => Cow::Owned(String::from_utf8_lossy(&buf).into_owned()),
        };
        let raw = xml_to_text(&xml, break_tags);
        for seg in raw.split('\n') {
            let line = seg.trim();
            if line.is_empty() {
                continue;
            }
            emitted = true;
            if !visit(line) {
                return emitted;
            }
        }
    }
    emitted
}

/// 极简 XML → 文本：遇到 `break_tags` 里的标签名换成换行，其余标签换成空格，
/// 文本段原样保留，最后做实体解码。
/// 不做完整 XML 解析（命名空间/属性/CDATA 均无意义），目标是"可 grep 的正文"。
/// 连续空白在写入时就折叠，使下游 `trim()` 即可成型、无需再分配。
fn xml_to_text(xml: &str, break_tags: &[&str]) -> String {
    let bytes = xml.as_bytes();
    let mut out = String::with_capacity(xml.len() / 4);
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let Some(rel) = bytes[i..].iter().position(|&c| c == b'>') else {
                break;
            };
            let end = i + rel;
            let tag = xml[i + 1..end].trim_start();
            i = end + 1;
            // 注释 / 声明 / 处理指令
            if tag.starts_with('!') || tag.starts_with('?') {
                continue;
            }
            let name: String = tag
                .trim_start_matches('/')
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '/')
                .collect();
            if break_tags.contains(&name.as_str()) {
                out.push('\n');
            } else {
                // 标签边界补空格，避免相邻单元格/相邻 run 的文本粘连成词
                push_space(&mut out);
            }
        } else {
            let end = bytes[i..]
                .iter()
                .position(|&c| c == b'<')
                .map(|p| i + p)
                .unwrap_or(bytes.len());
            out.push_str(&xml[i..end]);
            i = end;
        }
    }
    if out.contains('&') {
        decode_entities(&out)
    } else {
        out
    }
}

/// 写入折叠后的单个空格：已有空白结尾则不再追加
fn push_space(out: &mut String) {
    if !out.ends_with(char::is_whitespace) {
        out.push(' ');
    }
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        let (head, tail) = rest.split_at(p);
        out.push_str(head);
        match tail.find(';') {
            Some(e) if e <= 10 => {
                let ent = &tail[..=e];
                match ent {
                    "&amp;" => out.push('&'),
                    "&lt;" => out.push('<'),
                    "&gt;" => out.push('>'),
                    "&quot;" => out.push('"'),
                    "&apos;" => out.push('\''),
                    "&nbsp;" => out.push(' '),
                    _ => {
                        let hex = ent
                            .strip_prefix("&#x")
                            .or_else(|| ent.strip_prefix("&#X"))
                            .and_then(|x| x.strip_suffix(';'))
                            .and_then(|x| u32::from_str_radix(x, 16).ok());
                        let dec = ent
                            .strip_prefix("&#")
                            .and_then(|x| x.strip_suffix(';'))
                            .and_then(|x| x.parse::<u32>().ok());
                        if let Some(cp) = hex.or(dec) {
                            if let Some(c) = char::from_u32(cp) {
                                out.push(c);
                            }
                        }
                    }
                }
                rest = &tail[e + 1..];
            }
            _ => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// OLE 遗留文档启发式正文抽取：
/// Word 97-2003 含中文的文档正文几乎都以 UTF-16LE 存放，逐 u16 扫描、
/// 把非文本码元当分隔符，再过滤掉 OLE 目录项产生的 ASCII 元数据噪声
/// （"Root Entry" / "WordDocument" / "Microsoft Office Word" 等）。
/// 空白在累积时即折叠，行尾只做 `trim`，全程零额外分配。
fn for_each_ole_line(bytes: &[u8], mut visit: impl FnMut(&str) -> bool) -> bool {
    let mut line = String::new();
    let mut emitted = false;
    // 跳过头扇区：那里是目录/扇区表，不是正文
    let mut i = if bytes.len() > OLE_HEADER_BYTES {
        OLE_HEADER_BYTES
    } else {
        bytes.len()
    };
    while i + 1 < bytes.len() {
        let unit = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
        i += 2;
        // 非法码元 / 控制符 / 私用区垃圾 → 断行
        let c = char::from_u32(unit as u32);
        match c {
            Some(c) if !c.is_control() && !is_junk_char(c) => {
                if c.is_whitespace() {
                    push_space(&mut line);
                } else {
                    line.push(c);
                }
            }
            _ => {
                if flush_ole(&mut line, &mut visit) {
                    emitted = true;
                } else {
                    return emitted;
                }
            }
        }
    }
    if flush_ole(&mut line, &mut visit) {
        emitted = true;
    }
    emitted
}

/// OLE 单行过滤：长度 >= 4 且含非 ASCII —— 纯 ASCII 短串几乎都是格式元数据
fn flush_ole(line: &mut String, visit: &mut impl FnMut(&str) -> bool) -> bool {
    let trimmed = line.trim();
    let ok = trimmed.chars().count() >= 4 && !trimmed.is_ascii();
    let keep = if ok { visit(trimmed) } else { true };
    line.clear();
    keep
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_tags_and_decodes_entities() {
        let xml = "<w:p><w:r><w:t>审方&amp;点评</w:t></w:r><w:r><w:t>中心</w:t></w:r></w:p>";
        let t = xml_to_text(xml, &["w:p"]);
        assert!(t.contains("审方&点评"), "实体未解码: {t:?}");
        assert!(t.contains('\n'), "段落边界未成行: {t:?}");
    }

    /// 构造最小 OLE 骨架：8 字节魔数 + 补齐头扇区，后接 UTF-16LE 正文
    fn ole_fixture(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        bytes.resize(OLE_HEADER_BYTES, 0);
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        bytes
    }

    fn ole_lines(bytes: &[u8]) -> Vec<String> {
        let mut got = Vec::new();
        for_each_ole_line(bytes, |l| {
            got.push(l.to_string());
            true
        });
        got
    }

    #[test]
    fn ole_metadata_noise_is_filtered() {
        // OLE 目录项里的 ASCII 元数据必须被过滤，否则命中全是噪声
        let bytes = ole_fixture("Root Entry WordDocument Microsoft Office Word");
        assert!(ole_lines(&bytes).is_empty(), "ASCII 元数据应被过滤");
    }

    #[test]
    fn ole_header_magic_does_not_leak_into_body() {
        // 头扇区魔数若参与解码会解出 "쿐\u{e011}놡\u{e11a}" 粘在正文前
        let bytes = ole_fixture("区域审方中心建设方案");
        assert_eq!(ole_lines(&bytes), vec!["区域审方中心建设方案"]);
    }

    #[test]
    fn ole_utf16_body_text_is_extractable() {
        // 模拟"正文以 UTF-16LE 存放"：\r 作段落分隔
        let bytes = ole_fixture("区域审方中心管理系统功能技术参数表\r采用微服务架构");
        assert_eq!(
            ole_lines(&bytes),
            vec!["区域审方中心管理系统功能技术参数表", "采用微服务架构"]
        );
    }

    /// 真实 docx 端到端：用 zip 打包一份最小 word/document.xml 再抽取
    #[test]
    fn docx_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.docx");
        {
            let f = fs::File::create(&path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            zw.start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            let xml = r#"<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>区域审方中心建设方案</w:t></w:r></w:p><w:p><w:r><w:t>合理用药监测与药师审方干预</w:t></w:r></w:p></w:body></w:document>"#;
            std::io::Write::write_all(&mut zw, xml.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let lines = extract_lines(&path).unwrap();
        assert_eq!(
            lines,
            vec!["区域审方中心建设方案", "合理用药监测与药师审方干预"]
        );
    }
}
