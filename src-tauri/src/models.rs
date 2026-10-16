use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    /// "utf-8" | "utf-8-bom" | "gbk" | ...
    pub encoding: String,
    pub had_bom: bool,
    /// 非 UTF-8 文档（如 GBK）标记：前端据此禁止就地写并提示另存为 UTF-8
    pub is_utf8: bool,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    File,
    Dir,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNode {
    pub name: String,
    pub path: String,
    pub kind: NodeKind,
    pub children: Option<Vec<WorkspaceNode>>,
    pub size: Option<u64>,
    pub mtime_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub is_dir: bool,
    pub is_readonly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub root: String,
    pub query: String,
    pub case_sensitive: bool,
    pub is_regex: bool,
    pub include_glob: Option<String>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub rel_path: String,
    /// 1-based
    pub line: usize,
    /// 1-based 字符列
    pub column: usize,
    pub line_text: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub abs_path: String,
    /// 相对当前 md 文件，如 "./assets/img.png"
    pub rel_path: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub opened_at_ms: i64,
}

fn default_read_layout() -> String {
    "medium".into()
}

fn default_mode_bar_position() -> String {
    "center".into()
}

fn default_editor_engine() -> String {
    "markdown".into()
}

fn default_word_font_zh() -> String {
    "等线".into()
}

fn default_word_font_en() -> String {
    "Calibri".into()
}

fn default_word_font_size() -> u32 {
    11
}

fn default_word_export_engine() -> String {
    "builtin".into()
}

fn default_word_import_fidelity() -> String {
    "semantic".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: String,
    pub font_size: u32,
    /// "edit" | "split" | "read"
    pub editor_mode: String,
    pub auto_save: bool,
    pub auto_save_delay_ms: u32,
    pub last_workspace: Option<String>,
    /// 历史工作区（最近在前，去重，上限 10）：树根目录名点击切换
    pub recent_workspaces: Vec<String>,
    pub recent_files: Vec<RecentFile>,
    pub language: String,
    pub preview_theme: String,
    /// 内容版式（编辑/分栏/阅读通用）："narrow" | "medium" | "wide"（默认 medium）
    #[serde(default = "default_read_layout")]
    pub read_layout: String,
    /// 顶栏模式切换三按钮组位置："center"（默认）| "left"
    #[serde(default = "default_mode_bar_position")]
    pub mode_bar_position: String,
    pub scroll_sync: bool,
    pub word_wrap: bool,
    /// 编辑器顶部功能栏显隐（false = 隐藏，正文区上移）
    pub show_toolbar: bool,
    /// 专注模式：编辑区当前段落保持原样、其余行淡出（仅 Markdown 引擎编辑/分栏态生效）
    pub focus_mode: bool,
    /// 新建文件默认格式："markdown"（默认）| "wangeditor"（新建 .mh）
    #[serde(default = "default_editor_engine")]
    pub editor_engine: String,
    /// 导出 Word 正文字体基线（D2）：中文字体（2026-10-13 补：此前缺失导致设置不持久化）
    #[serde(default = "default_word_font_zh")]
    pub word_font_zh: String,
    /// 导出 Word 正文字体基线（D2）：西文字体
    #[serde(default = "default_word_font_en")]
    pub word_font_en: String,
    /// 导出 Word 正文字体基线（D2）：正文字号（pt）
    #[serde(default = "default_word_font_size")]
    pub word_font_size: u32,
    /// MD 导出 Word 引擎："builtin"（默认）| "community"（@mohtasham/md-to-docx 试点）
    #[serde(default = "default_word_export_engine")]
    pub word_export_engine: String,
    /// Word 转 MH 管线："semantic"（默认）| "fidelity"（docx-preview 高保真试点）
    #[serde(default = "default_word_import_fidelity")]
    pub word_import_fidelity: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            font_size: 15,
            editor_mode: "split".into(),
            auto_save: false,
            auto_save_delay_ms: 800,
            last_workspace: None,
            recent_workspaces: Vec::new(),
            recent_files: Vec::new(),
            language: "zh-CN".into(),
            preview_theme: "default".into(),
            read_layout: default_read_layout(),
            mode_bar_position: default_mode_bar_position(),
            scroll_sync: true,
            word_wrap: true,
            show_toolbar: true,
            focus_mode: false,
            editor_engine: default_editor_engine(),
            word_font_zh: default_word_font_zh(),
            word_font_en: default_word_font_en(),
            word_font_size: default_word_font_size(),
            word_export_engine: default_word_export_engine(),
            word_import_fidelity: default_word_import_fidelity(),
        }
    }
}
