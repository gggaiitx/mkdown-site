import { defineStore } from 'pinia';
import { readFile } from '../api/fileApi';
import type { EditorMode, FileContent } from '../api/types';

let uid = 0;
const nextId = () => `tab-${++uid}`;

/**
 * 标签内容种类：
 * - md：Markdown，进 MdEditorV3Engine
 * - mh：富文本（wangEditor 原生 HTML，.mh 文件族）
 * - text / html / svg：文本类，进编辑器（html/svg 在分栏/阅读态由对应 Frame 接管渲染）
 * - code：代码类文本，由 CodeEditorEngine（纯 CodeMirror 6）接管，恒编辑态
 * - docx / xlsx / image：预览类，只读，由对应预览组件渲染，禁止任何保存路径
 */
export type TabKind = 'md' | 'mh' | 'text' | 'code' | 'html' | 'svg' | 'docx' | 'xlsx' | 'image';

/** 预览类标签（只读，无编辑/保存语义） */
export type PreviewKind = 'docx' | 'xlsx' | 'image';

const isPreviewKind = (k: TabKind): k is PreviewKind =>
  k === 'docx' || k === 'xlsx' || k === 'image';

/** 按扩展名归类文本标签（预览类不经此函数，由 probe_preview_kind 后端判定）。
 *  只有 Markdown 走 md 引擎渲染；txt/log/csv/tsv 及未知文本一律 'code'
 *  （CodeMirror 纯文本编辑，不做 Markdown 渲染，避免 #/* 等字符被误渲染成标题/斜体）。 */
function textKindOf(path: string): TabKind {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'svg';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'md';
  if (ext === 'mh') return 'mh';
  return 'code';
}

export interface DocumentTab {
  id: string;
  /** null = 从未保存的新建文档 */
  path: string | null;
  title: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
  encoding: string;
  hadBom: boolean;
  /** 非 UTF-8（GBK 等）禁止就地写 */
  isUtf8: boolean;
  mode: EditorMode;
  cursorLine: number;
  /** 内容种类（决定右侧内容区用哪个组件渲染） */
  kind: TabKind;
}

export const useTabsStore = defineStore('tabs', {
  state: () => ({
    tabs: [] as DocumentTab[],
    activeId: null as string | null,
  }),
  getters: {
    activeTab(s): DocumentTab | undefined {
      return s.tabs.find((t) => t.id === s.activeId);
    },
    dirtyCount: (s) => s.tabs.filter((t) => t.isDirty).length,
    /** 当前激活标签是否为只读预览类（docx/xlsx/image） */
    activeIsPreview(s): boolean {
      const t = s.tabs.find((t) => t.id === s.activeId);
      return !!t && isPreviewKind(t.kind);
    },
  },
  actions: {
    /** 记录当前标签的视图模式（各标签模式态相互独立，切换标签时由 Workbench 恢复） */
    setActiveMode(m: EditorMode): void {
      const tab = this.activeTab;
      if (tab) tab.mode = m;
    },
    openFile(file: FileContent, mode: EditorMode): DocumentTab {
      const existing = this.tabs.find((t) => t.path === file.path);
      if (existing) {
        this.activeId = existing.id;
        return existing;
      }
      const tab: DocumentTab = {
        id: nextId(),
        path: file.path,
        title: file.path.split(/[\\/]/).pop() ?? file.path,
        content: file.content,
        savedContent: file.content,
        isDirty: false,
        encoding: file.encoding,
        hadBom: file.hadBom,
        isUtf8: file.isUtf8,
        mode,
        cursorLine: 1,
        kind: textKindOf(file.path),
      };
      this.tabs.push(tab);
      this.activeId = tab.id;
      return tab;
    },
    async openByPath(path: string, mode: EditorMode): Promise<DocumentTab> {
      const existing = this.tabs.find((t) => t.path === path);
      if (existing) {
        this.activeId = existing.id;
        return existing;
      }
      const file = await readFile(path);
      return this.openFile(file, mode);
    },
    /** 打开只读预览标签（docx/xlsx/image）：不读文本内容，字节由预览组件经 asset:// 自取 */
    openPreviewByPath(path: string, kind: PreviewKind): DocumentTab {
      const existing = this.tabs.find((t) => t.path === path);
      if (existing) {
        this.activeId = existing.id;
        return existing;
      }
      const tab: DocumentTab = {
        id: nextId(),
        path,
        title: path.split(/[\\/]/).pop() ?? path,
        content: '',
        savedContent: '',
        isDirty: false,
        encoding: 'utf-8',
        hadBom: false,
        isUtf8: false,
        mode: 'read',
        cursorLine: 1,
        kind,
      };
      this.tabs.push(tab);
      this.activeId = tab.id;
      return tab;
    },
    /** 会话恢复专用：直接注入构造好的标签（启动时 tabs 为空，不做去重；id 由 store 重新生成） */    addRestored(tab: Omit<DocumentTab, 'id'>): DocumentTab {
      const restored: DocumentTab = { ...tab, id: nextId() };
      this.tabs.push(restored);
      return restored;
    },
    /** 新建未保存文档：kind 由调用方按 settings.editorEngine 决定（markdown→md / wangeditor→mh）；
     *  mh 为富文本，Markdown 模板内容不适用，恒以空文档起步 */
    newUntitled(templateContent: string, mode: EditorMode, kind: 'md' | 'mh' = 'md'): DocumentTab {
      const content = kind === 'mh' ? '' : templateContent;
      const tab: DocumentTab = {
        id: nextId(),
        path: null,
        title: kind === 'mh' ? '未命名.mh' : '未命名.md',
        content,
        savedContent: content,
        isDirty: content.length > 0,
        encoding: 'utf-8',
        hadBom: false,
        isUtf8: true,
        mode,
        cursorLine: 1,
        kind,
      };
      this.tabs.push(tab);
      this.activeId = tab.id;
      return tab;
    },
    activate(id: string) {
      this.activeId = id;
    },
    /** 关闭标签；脏页由调用方先行确认（confirmFn 返回 false 则中止） */
    async closeTab(id: string, confirmFn: () => Promise<boolean> | boolean) {
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return false;
      const tab = this.tabs[idx];
      if (tab.isDirty) {
        const ok = await confirmFn();
        if (!ok) return false;
      }
      this.tabs.splice(idx, 1);
      if (this.activeId === id) {
        const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
        this.activeId = next ? next.id : null;
      }
      return true;
    },
    /** 批量关闭标签（脏页由调用方先行确认）；关闭后激活原关闭区间的邻近标签 */
    async closeTabsBatch(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      if (!this.tabs.some((t) => idSet.has(t.id))) return;
      const minIdx = this.tabs.findIndex((t) => idSet.has(t.id));
      const maxIdx = this.tabs.reduce((acc, t, i) => (idSet.has(t.id) ? i : acc), minIdx);
      const prevNeighbor = minIdx > 0 ? this.tabs[minIdx - 1] : null;
      const nextNeighbor = maxIdx < this.tabs.length - 1 ? this.tabs[maxIdx + 1] : null;
      this.tabs = this.tabs.filter((t) => !idSet.has(t.id));
      if (this.activeId && idSet.has(this.activeId)) {
        const next = prevNeighbor ?? nextNeighbor ?? this.tabs[0] ?? null;
        this.activeId = next ? next.id : null;
      }
    },
    /** 关闭全部标签（切换工作区用：脏页由调用方先行确认） */
    closeAll(): void {
      this.tabs = [];
      this.activeId = null;
    },
    markDirty(id: string, content: string) {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab || isPreviewKind(tab.kind)) return;
      tab.content = content;
      tab.isDirty = content !== tab.savedContent;
    },
    markSaved(id: string, content: string) {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab) return;
      tab.savedContent = content;
      tab.isDirty = false;
    },
    updateTab(id: string, patch: Partial<DocumentTab>) {
      const tab = this.tabs.find((t) => t.id === id);
      if (tab) Object.assign(tab, patch);
    },
    /** 关闭前有脏页则提示 */
    hasDirtyIn(path: string): boolean {
      return this.tabs.some((t) => t.path === path && t.isDirty);
    },
    /** 文件被重命名/删除时同步标签（newPath 传 null 表示删除）；
     *  重命名目标可能是目录：其子文件按前缀一并跟随新路径 */
    retabPath(oldPath: string, newPath: string | null) {
      const sep = oldPath.includes('\\') ? '\\' : '/';
      for (const t of this.tabs) {
        if (!t.path) continue;
        if (t.path === oldPath) {
          t.path = newPath;
          if (newPath) t.title = newPath.split(/[\\/]/).pop() ?? t.title;
        } else if (newPath && t.path.startsWith(oldPath + sep)) {
          t.path = newPath + t.path.slice(oldPath.length);
          t.title = t.path.split(/[\\/]/).pop() ?? t.title;
        }
      }
    },
  },
});
