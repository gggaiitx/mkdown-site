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
    pub scroll_sync: bool,
    pub word_wrap: bool,
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
            scroll_sync: true,
            word_wrap: true,
        }
    }
}
