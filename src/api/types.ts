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

export type ThemeKind = 'light' | 'dark';
export type EditorMode = 'edit' | 'split' | 'read';
export type ReadLayout = 'narrow' | 'medium' | 'wide';

/** 编辑内核（语义=新建文件默认格式）：markdown→.md / wangeditor→.mh（唯一定义处） */
export type EditorKernel = 'markdown' | 'wangeditor';

export interface AppSettings {
  theme: ThemeKind;
  fontSize: number;
  editorMode: EditorMode;
  autoSave: boolean;
  autoSaveDelayMs: number;
  lastWorkspace: string | null;
  /** 历史工作区（最近在前，去重，上限 10）：点击树根目录名可切换 */
  recentWorkspaces: string[];
  recentFiles: RecentFile[];
  language: string;
  previewTheme: string;
  /** 内容版式（编辑/分栏/阅读通用）：窄 760 / 中 1020（默认）/ 宽 1320 */
  readLayout: ReadLayout;
  /** 顶栏「编辑 / 分栏 / 阅读」三按钮组位置：center 顶栏水平居中（默认）/ left 跟随左侧功能区 */
  modeBarPosition: 'center' | 'left';
  scrollSync: boolean;
  wordWrap: boolean;
  /** 编辑器顶部功能栏（格式工具条）显隐：false = 隐藏，正文区上移 */
  showToolbar: boolean;
  /** 专注模式：当前段落保持原样、其余淡出。md/code 走 CM6 行装饰（按空行分段），
   *  .mh 给 Slate 顶层块挂类；阅读态一律不生效 */
  focusMode: boolean;
  /** 新建文件默认格式：markdown→.md（默认）/ wangeditor→.mh；不影响已打开文件 */
  editorEngine: EditorKernel;
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  fontSize: 15,
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
  showToolbar: true,
  focusMode: false,
  editorEngine: 'markdown',
  wordFontZh: '等线',
  wordFontEn: 'Calibri',
  wordFontSize: 11,
  wordExportEngine: 'builtin',
  wordImportFidelity: 'semantic',
};
