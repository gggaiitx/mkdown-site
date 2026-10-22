import { defineStore } from 'pinia';
import { probeTextFile, readFile } from '../api/fileApi';
import type { EditorMode, FileContent } from '../api/types';

let uid = 0;
const nextId = () => `tab-${++uid}`;

/**
 * 标签内容种类：
 * - md：Markdown，进 MdEditorV3Engine
 * - mh：富文本（wangEditor 原生 HTML，.mh 文件族）
 * - text / html / svg：文本类，进编辑器（html/svg 在分栏/阅读态由对应 Frame 接管渲染）
 * - code：代码类文本，由 CodeEditorEngine（纯 CodeMirror 6）接管，恒编辑态
 * - docx / xlsx / image / pdf：预览类，只读，由对应预览组件渲染，禁止任何保存路径
 */
export type TabKind = 'md' | 'mh' | 'text' | 'code' | 'html' | 'svg' | 'docx' | 'xlsx' | 'image' | 'pdf';

/** 预览类标签（只读，无编辑/保存语义） */
export type PreviewKind = 'docx' | 'xlsx' | 'image' | 'pdf';

/** 预览类标签（只读，无编辑/保存语义）。导出给「刷新/全屏」这类按标签能力显隐的菜单用 */
export const isPreviewKind = (k: TabKind): k is PreviewKind =>
  k === 'docx' || k === 'xlsx' || k === 'image' || k === 'pdf';

/** 「用户改过没有」的文本口径：编辑器内核（CodeMirror / md-editor）把 CRLF 读成 LF 再回写，
 *  只差换行符不是编辑——否则 Windows 上刚打开的文件立刻标脏、关标签还要确认保存。 */
const sameText = (a: string, b: string): boolean =>
  a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');

/** 按扩展名归类文本标签（预览类不经此函数，由 probe_preview_kind 后端判定）。
 *  只有 Markdown 走 md 引擎渲染；txt/log/csv/tsv 及未知文本一律 'code'
 *  （CodeMirror 纯文本编辑，不做 Markdown 渲染，避免 #/* 等字符被误渲染成标题/斜体）。
 *  导出给「另存为 / 重命名之后按新扩展名重算引擎」用，避免调用处再抄一份归类规则。 */
export function textKindOf(path: string): TabKind {
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
  /** 意向文件路径（§6.5 draftPath）：Word 反转产物「转换后打开」时确定为 docx 同目录的
   *  xxx.md/xxx.mh，文件尚未创建；仅作资产基准目录与锚点标识，不代表文件存在。
   *  保存到正式路径后 path 优先，draftPath 自然失效 */
  draftPath?: string | null;
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
  /** 预览类标签的刷新序号：bump 后预览组件经 :key 重挂、重新自取字节 */
  reloadSeq?: number;
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
     *  md 用 templateContent（Markdown 骨架），mh 用 mhContent（HTML 骨架，缺省空白起步）；
     *  opts.draftPath = 意向文件路径（§6.5，反转产物「转换后打开」用，文件未创建），
     *  opts.title = 自定义标题（V6：冠来源名，如「xxx.docx → md」） */
    newUntitled(
      templateContent: string,
      mode: EditorMode,
      kind: 'md' | 'mh' = 'md',
      mhContent = '',
      opts?: { draftPath?: string; title?: string },
    ): DocumentTab {
      const content = kind === 'mh' ? mhContent : templateContent;
      const tab: DocumentTab = {
        id: nextId(),
        path: null,
        draftPath: opts?.draftPath ?? null,
        title: opts?.title ?? (kind === 'mh' ? '未命名.mh' : '未命名.md'),
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
    /** 拖拽换序：将 dragId 标签移动到 targetId 之前/之后（不改变激活状态） */
    moveTab(dragId: string, targetId: string, place: 'before' | 'after'): void {
      const from = this.tabs.findIndex((t) => t.id === dragId);
      if (from < 0 || dragId === targetId) return;
      const [moved] = this.tabs.splice(from, 1);
      const to = this.tabs.findIndex((t) => t.id === targetId);
      if (to < 0) {
        this.tabs.splice(from, 0, moved); // 目标丢失（并发关闭）：放回原位
        return;
      }
      this.tabs.splice(place === 'after' ? to + 1 : to, 0, moved);
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
      tab.isDirty = !sameText(content, tab.savedContent);
    },
    markSaved(id: string, content: string) {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab) return;
      tab.savedContent = content;
      tab.isDirty = false;
    },
    /** 刷新标签（重读磁盘，丢弃未保存修改——脏页由调用方先行确认）。
     *  文本类：read_file 覆盖 content/savedContent，编辑器经 modelValue 外部变更链路回写；
     *  预览类（docx/xlsx/image，无文本语义）：bump reloadSeq 触发预览组件重挂。
     *  读盘失败（文件被删/权限不足）原样抛错，由调用方 toast。 */
    async reloadTab(id: string): Promise<void> {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab?.path) return;
      if (isPreviewKind(tab.kind)) {
        tab.reloadSeq = (tab.reloadSeq ?? 0) + 1;
        return;
      }
      const file = await readFile(tab.path);
      Object.assign(tab, {
        content: file.content,
        savedContent: file.content,
        isDirty: false,
        encoding: file.encoding,
        hadBom: file.hadBom,
        isUtf8: file.isUtf8,
      });
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
    async retabPath(oldPath: string, newPath: string | null) {
      const sep = oldPath.includes('\\') ? '\\' : '/';
      for (const t of this.tabs) {
        if (!t.path) continue;
        if (t.path === oldPath) {
          t.path = newPath;
          if (newPath) {
            t.title = newPath.split(/[\\/]/).pop() ?? t.title;
            await this.retypeTab(t, newPath);
          }
        } else if (newPath && t.path.startsWith(oldPath + sep)) {
          // 目录级重命名：子文件只换父路径，扩展名没变，引擎不用动
          t.path = newPath + t.path.slice(oldPath.length);
          t.title = t.path.split(/[\\/]/).pop() ?? t.title;
        }
      }
    },
    /** 重命名改了扩展名时按新类型重挂引擎（a.md → a.txt 不该还留在 Markdown 内核里，
     *  反向亦然）。归类复用 textKindOf，与 openByPath 同一个真相源。
     *  只在归类结果真的变了才去探测，同类型改名零额外 IO。
     *  后端判「不能按文本打开」（改成 png/exe 之类）时保持原 kind：转成预览/只读要补
     *  asset 授权与禁存语义，那是 routeByType 的活，不是重命名联动该管的。 */
    async retypeTab(t: DocumentTab, newPath: string) {
      if (isPreviewKind(t.kind)) return;
      const next = textKindOf(newPath);
      if (next === t.kind) return;
      if (!(await probeTextFile(newPath).catch(() => false))) return;
      t.kind = next;
    },
  },
});
