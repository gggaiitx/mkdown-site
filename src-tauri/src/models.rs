use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    /// "utf-8" | "utf-8-bom" | "gbk" | ...
    pub encoding: String,
    pub had_bom: bool,
    /// 内容是否本来就是 UTF-8（含 BOM）：仅作信息展示；
    /// 就地保存按 `encoding` 原样回写，不再据此拦截
    pub is_utf8: bool,
    /// 按探测出的编码解码时出现了无法解码的字节（已被替换成 U+FFFD）。
    /// 前端标记为不可就地保存：写回会丢掉原始字节，只能另存为 UTF-8。
    pub had_decode_errors: bool,
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

/// 应用内文件选择器的一条条目。`kind` 只给快捷位置（home/documents/…）
/// 与盘符根（root）用，普通子目录/文件为 None；选择器只列名字，不读内容。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: Option<String>,
    /// 隐藏项（点开头，或 Windows 的隐藏/系统属性）：前端据此默认过滤，
    /// 打开「显示隐藏项」开关才列出
    pub hidden: bool,
}

/// 选择器一次浏览的结果：当前位置 + 子目录（+ 文件模式的当前目录文件）
/// + 常用位置 + 盘符根
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirBrowse {
    pub path: String,
    pub parent: Option<String>,
    pub dirs: Vec<DirEntry>,
    /// 文件/保存模式才列出；文件夹模式恒为空
    pub files: Vec<DirEntry>,
    /// 请求路径本身指向一个文件时回填，供前端预选；否则为空
    pub selected: Option<String>,
    pub places: Vec<DirEntry>,
    pub roots: Vec<DirEntry>,
    /// 子目录或文件超过上限被截断：前端据此提示，避免用户误以为目录里只有这些
    pub truncated: bool,
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

/// 欢迎页版式："auto"（默认，按欢迎区可用尺寸自适应）| "desk"（书桌 Bento）| "classic"（经典）
fn default_welcome_layout() -> String {
    "auto".into()
}

/// 大纲呈现方式："classic" = 右侧面板 | "fresh" = 右缘短横线浮标（出厂默认）
fn default_outline_style() -> String {
    "fresh".into()
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

/// SVG 导出图片四周留白（px）：默认 2，几乎贴边
fn default_export_padding() -> u32 {
    2
}

/// 预览浮块工具条显隐档："auto"（进面板才浮出）| "shown"（常驻）| "hidden"（彻底不出现）
fn default_preview_bar_mode() -> String {
    "auto".into()
}

/// 浮块横向落位：条身中心占面板宽的比例，默认 0.5 = 居中
fn default_preview_bar_x() -> f64 {
    0.5
}

/// 浮块纵向落位：条身下缘离面板底缘的 px，默认 8 = 贴底
fn default_preview_bar_bottom() -> f64 {
    8.0
}

/// 预览区「回到顶部」按钮显现方式："auto"（指针移入右下角才浮出，出厂默认）| "always"（滚动后常驻）
fn default_back_top_mode() -> String {
    "auto".into()
}

/// 「回到顶部」按钮开关：出厂开（长文档滚下去才出现，短文档不受影响）
fn default_back_top_enabled() -> bool {
    true
}

/// 文件树显示文件大小：出厂关（窄侧栏下两列会挤掉文件名，需要时在设置里打开）
fn default_file_tree_show_size() -> bool {
    false
}

/// 文件树显示修改时间：出厂关
fn default_file_tree_show_mtime() -> bool {
    false
}

/// 文件树排序方式：出厂按名称升序（与目录树一直以来的行为一致）
fn default_file_tree_sort() -> String {
    "name-asc".into()
}

/// 记住侧栏宽度：出厂开
fn default_file_tree_remember_width() -> bool {
    true
}

/// 侧栏宽度默认值：260（要放得下名字 + 行末两列）
fn default_file_tree_width() -> f64 {
    260.0
}

/// 书桌版左栏宽度默认值：208（书桌要留空间给卡片，比工作台侧栏窄）
fn default_welcome_rail_width() -> f64 {
    208.0
}

/// 码猫陪伴：出厂开
fn default_pet_enabled() -> bool {
    true
}

/// ←/→ 同目录文件切换：出厂开
fn default_sibling_nav() -> bool {
    true
}

/// 明色配色出厂值：素白（= v0.1 起的原有外观，升级零视觉变化）
fn default_theme_palette_light() -> String {
    "paper".into()
}

/// 暗色配色出厂值：石墨（= v0.1 起的原有暗色，升级零视觉变化）
fn default_theme_palette_dark() -> String {
    "graphite".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// @deprecated 旧版单字段（light/dark）。保留只为迁移与回滚兼容：
    /// 真正决定外观的是 theme_mode + 两套 palette，前端每次 applyTheme 会把解析结果回写此字段
    pub theme: String,
    /// 模式偏好："system"（跟随系统）| "light" | "dark"。
    /// **空字符串 = 本版之前的旧配置**（只有 theme 没有 themeMode）→ 前端按 theme 迁移成手动模式，
    /// 这样升级用户不会被"跟随系统"意外改掉原来的亮暗选择
    #[serde(default)]
    pub theme_mode: String,
    /// 明色配色："paper"（素白，默认）| "fog"（冷灰）| "sepia"（米黄）| "azure"（晴蓝）
    #[serde(default = "default_theme_palette_light")]
    pub theme_palette_light: String,
    /// 暗色配色："graphite"（石墨，默认）| "midnight"（午夜蓝）| "ember"（暖褐）| "nebula"（星蓝）
    #[serde(default = "default_theme_palette_dark")]
    pub theme_palette_dark: String,
    /// 全局字号（px）：前端以 0.5px 为一档增减，故必须是浮点不是 u32
    /// （存成整数会让 15.5 这种值在 `set_settings` 反序列化时直接报错，整个设置写不进去）
    pub font_size: f64,
    /// 全局字体（CSS font-family 值，空字符串 = 应用默认 Geist 栈）。
    /// 作用于界面与正文；代码编辑/代码块固定等宽，不跟随
    #[serde(default)]
    pub font_family: String,
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
    /// 代码/文本引擎自动换行（右键菜单档位）：默认关，长行横向滚动。
    /// 与 word_wrap 分开：后者出厂即 true 且早已落进用户 settings.json，做「默认关」的开关读不出新默认值
    pub code_line_wrap: bool,
    /// 编辑器顶部功能栏显隐（false = 隐藏，正文区上移）
    pub show_toolbar: bool,
    /// 专注模式：当前段落保持原样、其余淡出（md/code 走 CM6 行装饰，.mh 给 Slate 块挂类）
    pub focus_mode: bool,
    /// 显示行号：Markdown 编辑窗格左侧一列行号（data-ln 属性 + CSS 伪元素）
    pub show_line_numbers: bool,
    /// ←/→ 同目录文件切换：预览类恒可用，文本类仅编辑器失焦时生效
    #[serde(default = "default_sibling_nav")]
    pub sibling_nav: bool,
    /// 点弹窗外（遮罩）是否关闭弹窗：出厂关（缺失字段的旧配置同为关），
    /// 只能用「取消 / 关闭」、右上角 × 或 Esc 关闭
    pub dialog_close_on_mask: bool,
    /// 大纲呈现方式："classic"（右侧面板）| "fresh"（右缘短横线浮标，掠过展开）
    #[serde(default = "default_outline_style")]
    pub outline_style: String,
    /// 新建文件默认格式："markdown"（默认）| "wangeditor"（新建 .mh）
    #[serde(default = "default_editor_engine")]
    pub editor_engine: String,
    /// 欢迎页版式："auto"（默认）| "desk" | "classic"。
    /// **必须与前端 welcomeLayout 同名同步**，否则设置改了不持久化
    #[serde(default = "default_welcome_layout")]
    pub welcome_layout: String,
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
    /// SVG 预览「导出为图片」的留白（px）：先按内容裁掉四周空白，再在四边各加这么多
    #[serde(default = "default_export_padding")]
    pub export_padding: u32,
    /// 预览浮块工具条显隐档："auto" | "shown" | "hidden"（图片/HTML/SVG 三面板共用一份）
    #[serde(default = "default_preview_bar_mode")]
    pub preview_bar_mode: String,
    /// 浮块横向落位：条身中心占面板宽的比例（0~1，渲染前前端还会按浮块自然宽夹一次）
    #[serde(default = "default_preview_bar_x")]
    pub preview_bar_x: f64,
    /// 浮块纵向落位：条身下缘离面板底缘的 px
    #[serde(default = "default_preview_bar_bottom")]
    pub preview_bar_bottom: f64,
    /// 正文预览区「回到顶部」按钮开关（长 md / .mh 文档，设置-操作）
    #[serde(default = "default_back_top_enabled")]
    pub back_top_enabled: bool,
    /// 「回到顶部」显现方式："auto"（指针移入右下角才浮出）| "always"（滚动后常驻）
    #[serde(default = "default_back_top_mode")]
    pub back_top_mode: String,
    /// 文件树每行末尾显示文件大小（只对文件）
    #[serde(default = "default_file_tree_show_size")]
    pub file_tree_show_size: bool,
    /// 文件树每行末尾显示修改时间
    #[serde(default = "default_file_tree_show_mtime")]
    pub file_tree_show_mtime: bool,
    /// 文件树排序方式："name-asc"（默认）| "name-desc" | "mtime-desc" | "mtime-asc" | "size-desc" | "size-asc"
    #[serde(default = "default_file_tree_sort")]
    pub file_tree_sort: String,
    /// 记住用户拖出来的侧栏宽度（设置-操作可关）
    #[serde(default = "default_file_tree_remember_width")]
    pub file_tree_remember_width: bool,
    /// 侧栏宽度（px）：仅 remember 开着时生效
    #[serde(default = "default_file_tree_width")]
    pub file_tree_width: f64,
    /// 欢迎页书桌版左栏宽度（px）：与工作台侧栏分开存，共用同一个 remember 开关
    #[serde(default = "default_welcome_rail_width")]
    pub welcome_rail_width: f64,
    /// 「码猫」开关：书桌右下角那只猫是否显示（关掉后含定时提醒一起停）
    #[serde(default = "default_pet_enabled")]
    pub pet_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            theme_mode: String::new(),
            theme_palette_light: default_theme_palette_light(),
            theme_palette_dark: default_theme_palette_dark(),
            font_size: 13.0,
            font_family: String::new(),
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
            code_line_wrap: false,
            show_toolbar: true,
            focus_mode: false,
            show_line_numbers: false,
            sibling_nav: default_sibling_nav(),
            dialog_close_on_mask: false,
            outline_style: default_outline_style(),
            editor_engine: default_editor_engine(),
            welcome_layout: default_welcome_layout(),
            word_font_zh: default_word_font_zh(),
            word_font_en: default_word_font_en(),
            word_font_size: default_word_font_size(),
            word_export_engine: default_word_export_engine(),
            word_import_fidelity: default_word_import_fidelity(),
            export_padding: default_export_padding(),
            preview_bar_mode: default_preview_bar_mode(),
            preview_bar_x: default_preview_bar_x(),
            preview_bar_bottom: default_preview_bar_bottom(),
            back_top_enabled: default_back_top_enabled(),
            back_top_mode: default_back_top_mode(),
            file_tree_show_size: default_file_tree_show_size(),
            file_tree_show_mtime: default_file_tree_show_mtime(),
            file_tree_sort: default_file_tree_sort(),
            file_tree_remember_width: default_file_tree_remember_width(),
            file_tree_width: default_file_tree_width(),
            welcome_rail_width: default_welcome_rail_width(),
            pet_enabled: default_pet_enabled(),
        }
    }
}
