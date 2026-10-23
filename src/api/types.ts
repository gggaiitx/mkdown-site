/** 与 src-tauri/src/models.rs 一一对应（手写维护，改 Rust 结构体必须同步改这里） */

export type NodeKind = 'file' | 'dir';

export interface WorkspaceNode {
  name: string;
  path: string;
  kind: NodeKind;
  children?: WorkspaceNode[];
  size?: number;
  mtimeMs?: number;
}

export interface FileContent {
  path: string;
  content: string;
  /** "utf-8" | "utf-8-bom" | "GBK" | ... */
  encoding: string;
  hadBom: boolean;
  /** 非 UTF-8 文档（如 GBK）禁止就地写，提示另存为 UTF-8 */
  isUtf8: boolean;
  size: number;
  mtimeMs: number;
}

export interface SaveResult {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FileMeta {
  path: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
  isReadonly: boolean;
}

/** 应用内文件选择器的一条条目；kind 仅快捷位置（home/documents/…）与盘符根（root）有值 */
export interface DirEntry {
  name: string;
  path: string;
  kind: string | null;
  /** 隐藏项：默认不列出，选择器里的开关打开才显示 */
  hidden: boolean;
}

/** 一次目录浏览的结果：当前位置 + 子目录（+ 文件模式的当前目录文件）
 *  + 常用位置 + 盘符根 */
export interface DirBrowse {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  /** 文件/保存模式才列出；文件夹模式恒为空 */
  files: DirEntry[];
  /** 请求路径本身指向文件时回填，供前端预选 */
  selected: string | null;
  places: DirEntry[];
  roots: DirEntry[];
  truncated: boolean;
}

export interface SearchQuery {
  root: string;
  query: string;
  caseSensitive: boolean;
  isRegex: boolean;
  includeGlob: string | null;
  maxResults?: number;
}

export interface SearchHit {
  path: string;
  relPath: string;
  /** 1-based */
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface SavedImage {
  absPath: string;
  relPath: string;
  fileName: string;
}

export interface RecentFile {
  path: string;
  openedAtMs: number;
}

/** 解析后的模式（明/暗）：驱动 `data-theme`，全应用「是否暗色」的唯一判据 */
export type ThemeKind = 'light' | 'dark';
/** 模式偏好：system = 跟随系统（仅切模式，配色各模式下各自保留）；light/dark = 手动锁定 */
export type ThemeModePref = 'system' | ThemeKind;
/** 明色三套配色（paper = 素白，出厂默认） */
export type LightPalette = 'paper' | 'fog' | 'sepia';
/** 暗色三套配色（graphite = 石墨，出厂默认） */
export type DarkPalette = 'graphite' | 'midnight' | 'ember';
export type ThemePalette = LightPalette | DarkPalette;
export type EditorMode = 'edit' | 'split' | 'read';
/** 内容版式：窄 / 中 / 宽 = 正文列限宽三档；full = 自适应铺满（不给阅读列上限） */
export type ReadLayout = 'narrow' | 'medium' | 'wide' | 'full';

/** 编辑内核（语义=新建文件默认格式）：markdown→.md / wangeditor→.mh（唯一定义处） */
export type EditorKernel = 'markdown' | 'wangeditor';

/** 欢迎页版式：auto = 宽窗用书桌、窄窗用经典（出厂默认）| desk = 书桌（Bento）
 *  | classic = 经典（品牌居中 + 左右两列）。两版数据同源，只是信息密度不同 */
export type WelcomeLayout = 'auto' | 'desk' | 'classic';

/** 预览浮块工具条的显隐档（图片 / HTML / SVG 三个面板共用同一份，不是各面板一份）：
 *  auto = 鼠标进面板或 Tab 到条上才浮出（出厂默认）| shown = 常驻 | hidden = 彻底不出现。
 *  hidden 下条子不可聚焦也不可拖，只能从预览窗格右键调回——所以图片面板也接了同一套菜单 */
export type PreviewBarMode = 'auto' | 'shown' | 'hidden';

/** 正文预览区「回到顶部」按钮的显现方式（md 阅读/分栏 与 .mh 共用一份）：
 *  auto = 指针移入右下角热区才浮出（出厂默认，不打扰阅读）| always = 滚动后常驻。
 *  两种档位都以「已向下滚过一段」为前提，文档没超出屏宽时按钮不出现 */
export type BackTopMode = 'auto' | 'always';

export interface AppSettings {
  /** @deprecated 旧版单字段（仅 light/dark）。保留只为旧配置迁移与回滚兼容：
   *  运行时由 themeMode 解析结果回写，真正决定外观的是 themeMode + 两套 palette */
  theme: ThemeKind;
  /** 模式偏好：system（跟随系统）/ light / dark */
  themeMode: ThemeModePref;
  /** 明色模式下的配色（paper 素白 / fog 冷灰 / sepia 米黄） */
  themePaletteLight: LightPalette;
  /** 暗色模式下的配色（graphite 石墨 / midnight 午夜蓝 / ember 暖褐） */
  themePaletteDark: DarkPalette;
  /** 全局字号（px）：0.5px 一档，见 FONT_STEP */
  fontSize: number;
  /** 全局字体（CSS font-family 值，空字符串 = 应用默认 Geist 栈）。
   *  作用于界面与正文；代码编辑/代码块固定等宽，不跟随 */
  fontFamily: string;
  editorMode: EditorMode;
  autoSave: boolean;
  autoSaveDelayMs: number;
  lastWorkspace: string | null;
  /** 历史工作区（最近在前，去重，上限 10）：点击树根目录名可切换 */
  recentWorkspaces: string[];
  recentFiles: RecentFile[];
  language: string;
  previewTheme: string;
  /** 内容版式（编辑/分栏/阅读通用）：窄 760 / 中 1020（默认）/ 宽 1320 / 自适应铺满 */
  readLayout: ReadLayout;
  /** 顶栏「编辑 / 分栏 / 阅读」三按钮组位置：center 顶栏水平居中（默认）/ left 跟随左侧功能区 */
  modeBarPosition: 'center' | 'left';
  scrollSync: boolean;
  wordWrap: boolean;
  /** 代码/文本引擎的自动换行：默认关（长行横向滚动），右键菜单里开。
   *  不复用上面的 wordWrap——那个字段出厂即 true 且早已写进用户的 settings.json，
   *  拿过来做「默认关」的开关会读出旧值 true，改不动；md 内核的换行由 md-editor-v3 恒开，与本项无关 */
  codeLineWrap: boolean;
  /** 编辑器顶部功能栏（格式工具条）显隐：false = 隐藏，正文区上移 */
  showToolbar: boolean;
  /** 专注模式：当前段落保持原样、其余淡出。md/code 走 CM6 行装饰（按空行分段），
   *  .mh 给 Slate 顶层块挂类；阅读态一律不生效 */
  focusMode: boolean;
  /** 显示行号：Markdown 编辑窗格左侧画一列行号（数字取自每行 data-ln 属性，代码引擎由 basicSetup 自带） */
  showLineNumbers: boolean;
  /** ←/→ 同目录文件切换：预览类恒可用；文本类仅编辑器失焦时生效（否则方向键归光标）。
   *  出厂开；关掉后应用层与预览帧内转发都不再切文件 */
  siblingNav: boolean;
  /** 点弹窗外（遮罩）是否关闭弹窗：出厂关 = 只能用「取消 / 关闭」、右上角 × 或 Esc 关闭。
   *  设置 / 文件夹与文件选择 / Word 转换 / 确认框等所有带遮罩的弹窗共用这一份口径 */
  dialogCloseOnMask: boolean;
  /** 大纲呈现方式：classic = 右侧面板 / fresh = 视口右缘的短横线浮标（出厂默认，
   *  md 双栏与阅读态、.mh 阅读态通用） */
  outlineStyle: 'classic' | 'fresh';
  /** 新建文件默认格式：markdown→.md（默认）/ wangeditor→.mh；不影响已打开文件 */
  editorEngine: EditorKernel;
  /** 欢迎页版式（见 WelcomeLayout）：出厂 auto，按欢迎区实际可用尺寸自适应 */
  welcomeLayout: WelcomeLayout;
  /** 导出 Word 正文字体基线（D2）：中文字体 */
  wordFontZh: string;
  /** 导出 Word 正文字体基线（D2）：西文字体 */
  wordFontEn: string;
  /** 导出 Word 正文字体基线（D2）：正文字号（pt） */
  wordFontSize: number;
  /** MD 导出 Word 引擎："builtin"（自研 HTML→docx 映射，公式/图表走光栅化，默认）| "community"（@mohtasham/md-to-docx 试点：原生 OMML 公式 + 语法高亮；仅 md 标签生效） */
  wordExportEngine: 'builtin' | 'community';
  /** Word 转 MH 管线："semantic"（mammoth 语义净化，默认）| "fidelity"（docx-preview 高保真试点：保留颜色/字号/对齐） */
  wordImportFidelity: 'semantic' | 'fidelity';
  /** SVG 预览「导出为图片」四周留白（px）：导出画幅 = 适应窗口那一档 + 2×该值。
   *  默认 2——他要的是几乎贴边，给到几十就成"图中间一个小图"了 */
  exportPadding: number;
  /** 预览浮块工具条显隐档（右键「预览工具条」三档，见 PreviewBarMode） */
  previewBarMode: PreviewBarMode;
  /** 浮块横向落位：条身**中心**占面板宽的比例 0~1。存比例而不是 px——分栏把预览拖窄后
   *   它仍贴着同一侧；实际渲染前会按浮块自然宽再夹一次，保证不会被 overflow 裁掉半截 */
  previewBarX: number;
  /** 浮块纵向落位：条身**下缘**离面板底缘的 px（默认 8 贴底）。窗口变高时它该待在底边，
   *   所以纵向存 px 而不是比例 */
  previewBarBottom: number;
  /** 正文预览区「回到顶部」按钮开关（设置-操作）。默认开：长 md / .mh 文档滚下去后
   *   右下角浮出一颗回到顶部的小圆钮（见 BackTopMode） */
  backTopEnabled: boolean;
  /** 「回到顶部」显现方式：auto = 指针移入右下角才浮出（默认）/ always = 滚动后常驻。
   *  与开关分开两个字段：关掉再打开时能记住上次选的方式 */
  backTopMode: BackTopMode;
}

/** 字号档位（顶栏 ± 按钮、Ctrl+滚轮、Ctrl+=/Ctrl+-、设置滑块共用同一组常量）：
 *  12~24px，一档 0.5px。半档是有意的——docx 导出按半磅取整（fontSize × 2），
 *  0.5px 一档刚好落进整数半磅，不会导出出 31.5 这种值 */
export const FONT_MIN = 12;
export const FONT_MAX = 24;
export const FONT_STEP = 0.5;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  themeMode: 'light',
  themePaletteLight: 'paper',
  themePaletteDark: 'graphite',
  fontSize: 13,
  fontFamily: '',
  editorMode: 'split',
  autoSave: false,
  autoSaveDelayMs: 800,
  lastWorkspace: null,
  recentWorkspaces: [],
  recentFiles: [],
  language: 'zh-CN',
  previewTheme: 'default',
  readLayout: 'medium',
  modeBarPosition: 'center',
  scrollSync: true,
  wordWrap: true,
  codeLineWrap: false,
  showToolbar: true,
  focusMode: false,
  showLineNumbers: false,
  siblingNav: true,
  dialogCloseOnMask: false,
  outlineStyle: 'fresh',
  editorEngine: 'markdown',
  welcomeLayout: 'auto',
  wordFontZh: '等线',
  wordFontEn: 'Calibri',
  wordFontSize: 11,
  wordExportEngine: 'builtin',
  wordImportFidelity: 'semantic',
  exportPadding: 2,
  previewBarMode: 'auto',
  previewBarX: 0.5,
  previewBarBottom: 8,
  backTopEnabled: true,
  backTopMode: 'auto',
};
