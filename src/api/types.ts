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
  scrollSync: boolean;
  wordWrap: boolean;
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
  scrollSync: true,
  wordWrap: true,
};
