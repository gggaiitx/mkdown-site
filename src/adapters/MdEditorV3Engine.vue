<script setup lang="ts">
/**
 * ★ 编辑器内核适配层唯一实现文件（业务代码禁止直接 import md-editor-v3）。
 * 对外契约见 IMarkdownEngine.ts 注释；内核更换时仅改本文件。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { MdEditor, MdPreview, type ToolbarNames } from 'md-editor-v3';
// CM6 视图层：仅用 EditorView.scrollIntoView effect（纯数据 effect，跨实例安全，
// 版本与内核同源扁平安装 6.43.x）。改用 TransactionSpec.scrollIntoView 会依赖 selection，
// 而内核开了 scrollToSelection，改选区即被拉回视口 —— 滚动等于失效。
import { EditorView } from '@codemirror/view';
import 'md-editor-v3/lib/style.css';
// 自建 win 预览主题（Windows 11 Fluent 风）；必须在 style.css 之后加载，
// style.css 首行 @import 的 @vavt/markdown-theme 全量主题在其前，同特异性下本文件规则胜出
import '../styles/win-theme.css';

import { savePastedImage } from '../api/imageApi';
import { openUrl } from '../api/fileApi';
import { modKey } from '../utils/keyHint';
import { extractOutline } from '../utils/outline';
import type { EditorMode, ThemeKind } from '../api/types';
import type { OutlineItem } from '../stores/editorStore';
import type { EditorCtxPayload } from './IMarkdownEngine';
import { setCurrentDocDir, setupMdRenderer, renderMermaidSvg } from './mdRendererConfig';
import { setCmFind } from './findHighlight';
import { buildTableSkeleton, editTable, isWideAlignable, parseTable, tsvToTable } from '../utils/mdTable';
import { formatBlockLines, type BlockFormatKind, type BlockKind } from '../utils/mdLineFormat';
import { setFocusMode } from './cmFocusLine';
import { useI18n } from '../i18n';

const props = defineProps<{
  modelValue: string;
  mode: EditorMode;
  theme: ThemeKind;
  previewTheme: string;
  /** 内容版式（编辑/分栏/阅读通用）：窄 / 中 / 宽 */
  readLayout?: 'narrow' | 'medium' | 'wide';
  /** 当前文档路径（null = 未保存新建），用于图片落盘与相对路径解析 */
  docPath: string | null;
  editorId: string;
  /** 编辑器顶部功能栏显隐（设置-编辑器）：false = 隐藏（正文区上移） */
  showToolbar?: boolean;
  /** 显示行号（设置-编辑器）：编辑窗格左侧画一列行号，开关只切 class 不重配 CM 扩展 */
  showLineNumbers?: boolean;
  /** 专注模式（设置-编辑器）：当前段落保持原样，其余行淡出。仅编辑/分栏态的 CM 窗格生效 */
  focusMode?: boolean;
  /** 分栏态编辑区↔预览区滚动同步（设置-编辑器「滚动同步」，默认开）。
   *  传 false 时内核 scrollAuto 关闭——注意内核按滚动**比例**同步，
   *  编辑区与预览区行高不同会产生百像素级累积偏差（实测约 127px） */
  scrollSync?: boolean;
  /** 内核界面语言（'zh-CN' | 'en-US'，设置-外观「界面语言」）。
   *  内核语言同为挂载初值型 prop，变更经 editorRemountKey 重挂载生效 */
  language?: string;
}>();

const { t } = useI18n();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save', v: string): void;
  (e: 'outline', items: OutlineItem[]): void;
  (e: 'htmlChanged', html: string): void;
  (e: 'cursor', pos: { line: number; col: number }): void;
  (e: 'toast', text: string): void;
  /** http(s) 超链接：交由应用开 Web 标签（webview 内嵌浏览） */
  (e: 'openLink', href: string): void;
  /** 文件路径链接（docs/PRD.md 等）：交由应用按当前文档目录解析后打开 */
  (e: 'openDoc', href: string): void;
  /** 编辑区右键：请求上层在 (x, y) 弹表格菜单（inTable=false 时只有「插入表格」）。
   *  引擎已把光标落到点击处，菜单项只需回调 tableOp / insertTable */
  (e: 'editorContext', pos: EditorCtxPayload): void;
}>();

const rootRef = ref<HTMLElement | null>(null);
const editorRef = ref<InstanceType<typeof MdEditor> | null>(null);

// md-editor 的 class prop 只接受 string；编辑器外壳保持铺满（版式不再缩外壳）
const editorClass = computed(() => 'engine-editor');

// ---- 编辑区行高跟随阅读主题 ----
// 各预览主题正文行高不同（default 1.6 / github 1.5 / win 1.75），硬编码任何一个都会在
// 换主题时再次与阅读态失配。导出预览宿主（#export-pdf-preview）与阅读态共用同一
// previewTheme 且恒驻 DOM：从中量出「行高/字号」比值注入 --mk-editor-lh，
// CM 行高走该变量（见样式段）。比值转移对字号无关——两侧字号同源于 --mk-font-size。
const editLineHeight = ref('1.6');
function measureEditLineHeight(): void {
  const scope = document
    .getElementById('export-pdf-preview')
    ?.querySelector<HTMLElement>('.md-editor-preview');
  if (!scope) return;
  // 必须量真实段落：主题对标题多数不设行高（computed 为 normal，会被下方守卫拒绝），
  // 且 default 主题的 1.6 就挂在 div.default-theme p 上。li 为纯列表文档兜底。
  const probe = scope.querySelector<HTMLElement>('p') ?? scope.querySelector<HTMLElement>('li') ?? scope;
  const cs = getComputedStyle(probe);
  const lh = Number.parseFloat(cs.lineHeight);
  const fs = Number.parseFloat(cs.fontSize);
  if (Number.isFinite(lh) && Number.isFinite(fs) && fs > 0 && lh > 0) {
    editLineHeight.value = (lh / fs).toFixed(3);
  }
}
watch(
  () => props.previewTheme,
  () => {
    // 主题切换：等导出宿主根节点主题类更新后再量（渲染同步，一个 tick 足够）
    void nextTick(() => requestAnimationFrame(measureEditLineHeight));
  },
);

/**
 * v7 的 preview prop 只作为挂载初值写入内部 store（挂载后无 props 同步），
 * 运行时切换预览必须走实例 API togglePreview()（内部经 updateSetting 生效）。
 */
type EditorInstanceApi = {
  togglePreview?: (v: boolean) => void;
};

watch(
  () => props.mode,
  (m, old) => {
    // 每次模式切换重置校正计数与上一轮锚点
    resyncCount = 0;
    resyncAnchor = null;
    switchStartedAt = performance.now();
    if (m === 'read') {
      // edit/split → read：此刻编辑器实例仍在 DOM（v-if 未切换），锚定视口顶行；
      // MdPreview 挂载渲染完成后定位（onHtmlChanged 提前命中 + 轮询兜底）
      pendingAnchor = captureViewportAnchor();
      if (pendingAnchor) locateReadAnchor();
      return;
    }
    if (old === 'read') {
      // read → edit/split：此刻阅读 DOM 仍在（v-if 未切换），锚定阅读视口位置；
      // MdEditor 重挂载后补位（不移动光标）
      pendingAnchor = captureReadAnchor();
    } else {
      pendingAnchor = null; // edit ↔ split 同一实例，CM 自身保留滚动位置，无需干预
    }
    const inst = editorRef.value as unknown as EditorInstanceApi | null;
    inst?.togglePreview?.(m === 'split');
    if (pendingAnchor) {
      const a = pendingAnchor;
      pendingAnchor = null;
      void nextTick(() => requestAnimationFrame(() => applyEditAnchor(a)));
    }
    // 从阅读态返回编辑态时光标口径复位（重挂载后 CM 光标在文档头）
    void nextTick(() => emitCursorPosition());
  },
);

// 功能栏分组（v7 合法项全集 = keyof ToolbarTips，见 md-editor-v3/lib/types/index.d.ts）：
// 文本格式 / 段落结构 / 插入元素 / 撤销恢复 / 保存·全屏。
// mermaid / katex 由 mdRendererConfig 以本地 instance 直传（离线可渲染），版本锚定内核 CDN 同款。
// 刻意不放的项——功能已由应用层承担，放进来会出现双入口失同步：
// - catalog：大纲由自建 OutlinePanel 承担；
// - preview / htmlPreview：三模式由顶栏统一管理（引擎经 togglePreview 同步），
//   功能栏内直切会脱离 tabsStore 的 mode 状态导致 UI 失同步；
// - github：顶栏已有仓库入口。
// - 导出 PDF：v7 官方 ExportPDF（@vavt/v3-extension）在本应用实测适配不佳，已撤除；
//   导出/打印统一收在顶栏 Printer 按钮（自建打印宿主，见 exportPdf 段注释）。
const toolbars: ToolbarNames[] = [
  'bold', 'underline', 'italic', 'strikeThrough', 'sub', 'sup', '-',
  'title', 'quote', 'unorderedList', 'orderedList', 'task', '-',
  'codeRow', 'code', 'link', 'image', 'table', 'mermaid', 'katex', '-',
  'revoke', 'next', 'save', '=', 'pageFullscreen',
];

// ---- 大纲提取（跳过代码块内的 # 行；唯一实现在 utils/outline.ts，P2-20 去重）----
let outlineTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.modelValue,
  (v) => {
    if (outlineTimer) clearTimeout(outlineTimer);
    outlineTimer = setTimeout(() => {
      emit('outline', extractOutline(v));
      emitCursorPosition(); // 切文档/内容替换后光标口径跟随（重置为 L1:C1 等）
    }, 150);
  },
  { immediate: true },
);

// ---- 本地图片渲染（ADR-05）----
// v7 的 transformImgUrl 只处理「粘贴图片链接文本」，渲染 <img> 时不调用；
// 因此渲染层转换统一走全局 markedRenderer（见 mdRendererConfig.ts），
// 文档目录用 sync watch 在渲染前注入；编辑器上不传 transformImgUrl（保持恒等），
// 粘贴 markdown 图片文本时文档内仍保留相对路径。
watch(
  () => props.docPath,
  (p) => {
    setCurrentDocDir(p ? p.replace(/[\\/][^\\/]*$/, '') : '');
  },
  { immediate: true, flush: 'sync' },
);

async function fileToBase64(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function handleUploadImg(
  files: FileList,
  callback: (urls: string[]) => void,
): Promise<void> {
  if (!props.docPath) {
    emit('toast', t('engine.saveImgFirst', { mod: modKey() }));
    return;
  }
  const urls: string[] = [];
  for (const f of Array.from(files)) {
    const ext = (f.name.includes('.') ? f.name.split('.').pop() : f.type.split('/')[1]) || 'png';
    try {
      const b64 = await fileToBase64(f);
      const saved = await savePastedImage(props.docPath, b64, ext.toLowerCase());
      urls.push(saved.relPath); // 文档内保留相对路径，保证整体可搬迁
    } catch (err) {
      emit('toast', t('engine.imgSaveFail', { msg: err instanceof Error ? err.message : String(err) }));
    }
  }
  if (urls.length > 0) callback(urls);
}

// ---- 对外命令：滚动到行 ----
// 编辑/分栏态用 CodeMirror6 行元素；阅读态用 markdown-it 注入的 data-line 锚点
// （见 mdRendererConfig 的 mk_data_line 规则）；headingIndex 供大纲按标题序号精确定位。
function scrollToLine(line: number, headingIndex = -1): void {
  const root = rootRef.value;
  if (!root) return;
  if (props.mode !== 'read') {
    // CodeMirror 6 只渲染可视区行，DOM 下标 ≠ 文档行号（一滚动就定位错行甚至无操作）；
    // 必须走 doc 取行首偏移，再用 scrollIntoView effect 居中（与 CodeEditorEngine 同口径）
    const view = getTableView();
    if (view) {
      const n = Math.max(1, Math.min(line, view.state.doc.lines));
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'center' }) });
      return;
    }
    const lines = root.querySelectorAll<HTMLElement>('.cm-content .cm-line');
    const target = lines[Math.max(0, line - 1)];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
  void nextTick(() => {
    if (props.mode === 'read' && headingIndex < 0) {
      // 阅读态：按 data-line 锚点找「起始行 <= 目标行」的最后一个块元素
      const blocks = root.querySelectorAll<HTMLElement>('[data-line]');
      let target: HTMLElement | null = null;
      for (const el of blocks) {
        const start = Number(el.getAttribute('data-line'));
        if (Number.isFinite(start) && start <= line) target = el;
        else break;
      }
      target ??= blocks[0] ?? null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    if (headingIndex >= 0) {
      // 大纲跳转：按标题序号定位（编辑/分栏/阅读三态通用）
      const heads = root.querySelectorAll<HTMLElement>('.md-editor-preview-wrapper h1, .md-editor-preview-wrapper h2, .md-editor-preview-wrapper h3, .md-editor-preview-wrapper h4, .md-editor-preview-wrapper h5, .md-editor-preview-wrapper h6, .md-editor-previewOnly h1, .md-editor-previewOnly h2, .md-editor-previewOnly h3, .md-editor-previewOnly h4, .md-editor-previewOnly h5, .md-editor-previewOnly h6');
      heads[headingIndex]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

// ---- 文件内查找：关键词高亮（编辑/分栏 = CM6 装饰，阅读/预览 = DOM mark） ----
const PV_MARK_CAP = 2000;

/** 清除预览/阅读态的查找 mark（文本节点还原 + normalize 合并） */
function clearPreviewMarks(): void {
  const root = rootRef.value;
  if (!root) return;
  root.querySelectorAll('mark.mk-pv-find').forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
    parent.normalize();
  });
}

/** 在预览/阅读容器内为关键词加 mark 高亮（按 DOM 顺序全量标记） */
function applyPreviewMarks(keyword: string, caseSensitive: boolean): void {
  const root = rootRef.value;
  if (!root) return;
  clearPreviewMarks();
  if (!keyword) return;
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  const marks: HTMLElement[] = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') {
          return NodeFilter.FILTER_REJECT;
        }
        return (node as Text).nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    },
  );
  const nodes: Text[] = [];
  let cur = walker.nextNode();
  while (cur) {
    nodes.push(cur as Text);
    cur = walker.nextNode();
  }
  for (const node of nodes) {
    const text = node.nodeValue ?? '';
    const hay = caseSensitive ? text : text.toLowerCase();
    const spans: Array<[number, number]> = [];
    let from = 0;
    while (spans.length < PV_MARK_CAP - marks.length) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      spans.push([at, at + needle.length]);
      from = at + Math.max(1, needle.length); // 空串防御：强制推进
    }
    if (spans.length === 0) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [s, e] of spans) {
      if (s > pos) frag.appendChild(document.createTextNode(text.slice(pos, s)));
      const mark = document.createElement('mark');
      mark.className = 'mk-pv-find';
      mark.textContent = text.slice(s, e);
      frag.appendChild(mark);
      marks.push(mark);
      pos = e;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode?.replaceChild(frag, node);
    if (marks.length >= PV_MARK_CAP) break;
  }
}

/** 最近一次预览高亮参数：预览内容变化（htmlChanged）后自动重涂 */
let lastFind: { keyword: string; caseSensitive: boolean } | null = null;

/** 设置查找高亮（编辑态 CM6 无视图时返回 false，属正常，由预览侧承担） */
function highlight(keyword: string, caseSensitive = false): void {
  lastFind = keyword ? { keyword, caseSensitive } : null;
  setCmFind({ keyword, caseSensitive });
  if (keyword) applyPreviewMarks(keyword, caseSensitive);
  else clearPreviewMarks();
}

/** 清除全部查找高亮 */
function clearHighlight(): void {
  highlight('');
}

/**
 * 对外命令：在光标处插入 / 包裹选区 / 设标题 / 页面全屏（格式快捷键，见 Workbench.onKeydown）。
 * v7 实例 expose 的 insert(generate) 中，generate 收到的是「选中文本字符串」；
 * replaceSelectedText 的选区语义：anchor = 起点 + deviationStart，head = 起点 + 总长 + deviationEnd。
 */
type InsertParamLike = {
  targetValue: string;
  select?: boolean;
  deviationStart?: number;
  deviationEnd?: number;
};
type InsertApi = {
  insert?: (generate: (selectedText: string) => InsertParamLike) => void;
  togglePageFullscreen?: (status?: boolean) => void;
};

/** 在光标处插入文本（模板片段等） */
function insert(text: string): void {
  const inst = editorRef.value as unknown as InsertApi | null;
  inst?.insert?.((selectedText) => ({
    targetValue: `${selectedText}${text}`,
    select: false,
    deviationStart: 0,
    deviationEnd: 0,
  }));
}

/** 用前后缀包裹当前选区（无选区时插入 placeholder）：加粗/斜体/链接/图片占位/代码块共用 */
function wrapSelection(prefix: string, suffix: string, placeholder = ''): void {
  // 无选区时先把作用对象定下来：光标所在行非空 → 整行即目标（中文没有词边界，整行是最小的
  // 行得通语义单位）；空行不动，交给 placeholder 走「示例文字」路径。
  // 内核 insert 回调读的是调用当下的 selection.main（MdEditor.mjs:98-99），故这里先 dispatch 再生效。
  const view = getTableView();
  if (view) {
    const sel = view.state.selection.main;
    if (sel.empty) {
      const line = view.state.doc.lineAt(sel.head);
      if (line.text.trim() !== '') view.dispatch({ selection: { anchor: line.from, head: line.to } });
    }
  }
  const inst = editorRef.value as unknown as InsertApi | null;
  inst?.insert?.((selectedText) => {
    const inner = selectedText || placeholder;
    return {
      targetValue: `${prefix}${inner}${suffix}`,
      select: true,
      deviationStart: prefix.length, // 选区起点 = 前缀之后
      deviationEnd: -suffix.length, // 选区终点 = 总长扣掉后缀
    };
  });
}

/** setHeading 用的 CM6 视图最小接口（dispatch 纯对象 transaction，不引 codemirror 包） */
interface CmHeadingView {
  state: {
    selection: { main: { from: number; to: number; head: number } };
    doc: {
      lineAt(pos: number): { number: number; from: number };
      line(n: number): { from: number; to: number; text: string };
    };
  };
  /** head 省略 = 收缩为插入点；块级格式补示例文字时要靠它把示例置于选中态 */
  dispatch(spec: {
    changes?: Array<{ from: number; to: number; insert: string }> | { from: number; to: number; insert: string };
    selection?: { anchor: number; head?: number };
    scrollIntoView?: boolean;
  }): void;
}

/** 逐行施加块级格式：行文本计算全在 utils/mdLineFormat（可脱浏览器单测），这里只按行 diff 后局部替换 */
function applyBlockFormat(kind: BlockKind, options: { level?: number; example?: string } = {}): void {
  const inst = editorRef.value as unknown as EditorWithView | null;
  const view = inst?.getEditorView?.() as unknown as CmHeadingView | null;
  if (!view) return;
  const sel = view.state.selection.main;
  const anchorPos = Math.min(sel.from, sel.to);
  // 选区终点落在某行行首时不算那一行（拖选整行、Shift+↓ 都会正好停在下一行开头，
  // 直接 lineAt(to) 会多改一行）
  const headRaw = Math.max(sel.from, sel.to);
  const headPos = headRaw > anchorPos && view.state.doc.lineAt(headRaw).from === headRaw ? headRaw - 1 : headRaw;
  const startLine = view.state.doc.lineAt(anchorPos).number;
  const endLine = view.state.doc.lineAt(headPos).number;
  const texts: string[] = [];
  for (let n = startLine; n <= endLine; n++) texts.push(view.state.doc.line(n).text);
  const next = formatBlockLines(texts, kind, options);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (let i = 0; i < next.length; i++) {
    if (next[i] === texts[i]) continue;
    const line = view.state.doc.line(startLine + i);
    changes.push({ from: line.from, to: line.to, insert: next[i] });
  }
  if (changes.length === 0) return;
  // 单行空段落补了示例文字时，让示例处于选中态：接着打字即替换（与包裹型的 placeholder 一致）
  const example = options.example ?? '';
  if (texts.length === 1 && example !== '' && texts[0].trim() === '') {
    const at = next[0].indexOf(example);
    if (at >= 0) {
      const line = view.state.doc.line(startLine);
      view.dispatch({
        changes,
        selection: { anchor: line.from + at, head: line.from + at + example.length },
      });
      return;
    }
  }
  view.dispatch({ changes });
}

/** 为光标所在行（或选区覆盖各行）设置 N 级标题：剥旧块标记再加新前缀（幂等），行首语义正确。
 *  目标是空行时补 example 示例文字，格式效果当场可见 */
function setHeading(level: number, example?: string): void {
  applyBlockFormat('heading', { level, example });
}

/** 引用 / 无序 / 有序（自动编号）/ 任务项（保留勾选态）/ 正文——同一条逐行链路 */
function setBlockFormat(kind: BlockFormatKind, example?: string): void {
  applyBlockFormat(kind, { example });
}

// ---- 表格编辑辅助（能力在 utils/mdTable.ts 纯函数层，这里只做 CM 视图桥接） ----
type TableOp = import('../utils/mdTable').TableOp;

/** 表格操作用的 CM6 视图最小接口（比 setHeading 版多 doc.lines / lineAt 的行内字段） */
interface CmTableView {
  state: {
    /** empty = 插入点（无选区）；包裹型动作据此决定作用对象 */
    selection: { main: { from: number; to: number; head: number; empty: boolean } };
    doc: {
      lines: number;
      /** 全文长度与整篇文本：文本级替换的一致性校验要用 */
      length: number;
      toString(): string;
      sliceString(from: number, to: number): string;
      lineAt(pos: number): { number: number; from: number; to: number; text: string };
      line(n: number): { from: number; to: number; text: string };
    };
  };
  /** changes 省略 = 纯选区变更（右键定位光标）；head 省略 = 收缩为插入点 */
  dispatch(spec: {
    changes?: { from: number; to?: number; insert: string } | Array<{ from: number; to: number; insert: string }>;
    selection?: { anchor: number; head?: number };
    scrollIntoView?: boolean;
    /** 只放 EditorView.scrollIntoView 这类纯数据 effect（跨实例安全，见文件头 CM6 注释） */
    effects?: unknown;
  }): void;
  /** 坐标 → doc 偏移（不在文本上返回 null）；右键定位用 */
  posAtCoords(coords: { x: number; y: number }): number | null;
  /** 焦点交还编辑区 */
  focus(): void;
}

function getTableView(): CmTableView | null {
  const inst = editorRef.value as unknown as EditorWithView | null;
  return (inst?.getEditorView?.() ?? null) as unknown as CmTableView | null;
}

/** 右键菜单项点完焦点停在按钮上：操作后把焦点交还编辑器，保证能直接接着打字 */
function focusEditor(): void {
  getTableView()?.focus();
}

// ---- 专注模式（设置-编辑器「专注模式」）----
// 行装饰本体在 adapters/cmFocusLine.ts，经 mdRendererConfig 的全局 codeMirrorExtensions 注入；
// 这里只负责把开关状态写进去并补发一次空事务让插件重算（空事务不触发 onChange 回写）
watch(
  () => props.focusMode,
  (on) => {
    setFocusMode(!!on);
    getTableView()?.dispatch({});
  },
  { immediate: true },
);

/** 对光标所在表格执行行/列操作或规整；不在表格内 / 操作不适用返回 false。
 *  只替换表格块（[from,to)）为新块，光标落回 cursor —— 避免整篇替换触发预览全量重渲 */
function tableOp(op: TableOp): boolean {
  const view = getTableView();
  if (!view) return false;
  const doc = view.state.doc;
  const ls: string[] = [];
  for (let n = 1; n <= doc.lines; n++) ls.push(doc.line(n).text);
  const text = ls.join('\n');
  const head = view.state.selection.main.head;
  const r = editTable(text, head, op);
  if (!r) return false;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: r.block },
    // r.cursor 已按替换后的整篇新文本算好，即 CM 应用本次 change 后的绝对偏移
    selection: { anchor: r.cursor },
    scrollIntoView: true,
  });
  return true;
}

/** 右键定位：命中表格则把光标落到点击处（表格操作按 selection.main.head 生效），
 *  并请求上层在点击处弹菜单；等宽档可用性一并算出，供菜单置灰。
 *  ★ 绑在 rootRef 的原生 contextmenu（捕获阶段），不用内核 domEventHandlers：
 *    内核实现是 `inst?.view.dispatch({effects: reconfigure(...)})`，CM 视图未就绪时
 *    整句静默 no-op，且该 compartment 在配置重建时被换回内层默认 handler 集合——
 *    一次性注册因此时灵时不灵（切换标签后右键弹不出即此因） */
function onEditorContext(event: MouseEvent): void {
  if (props.mode === 'read') return; // 阅读态无编辑光标语义，不接管右键
  // 只接管编辑窗格内的右键：预览窗格、导出宿主等区域维持原状
  if (!(event.target as HTMLElement | null)?.closest('.cm-editor')) return;
  const view = getTableView();
  if (!view) return;
  // posAtCoords 在 .cm-editor 的滚动条/内边距区返回 null：退回当前光标语义，保证窗格内右键必出菜单
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
  const doc = view.state.doc;
  const ls: string[] = [];
  for (let n = 1; n <= doc.lines; n++) ls.push(doc.line(n).text);
  const line = doc.lineAt(pos);
  const t = parseTable(ls, line.number - 1, pos - line.from);
  event.preventDefault();
  // 点在既有选区内部 → 保留选区，菜单动作就作用在选中内容上；否则光标落到点击处
  const sel = view.state.selection.main;
  const inSelection = pos >= Math.min(sel.from, sel.to) && pos <= Math.max(sel.from, sel.to);
  if (!inSelection) view.dispatch({ selection: { anchor: pos } });
  emit('editorContext', {
    x: event.clientX,
    y: event.clientY,
    inTable: !!t,
    wideAlignable: t ? isWideAlignable(t.header, t.rows) : false,
  });
}

/** 在光标处插入表格骨架（独占新行） */
function insertTable(rows = 2, cols = 3): void {
  const view = getTableView();
  if (!view) return;
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const sep = line.text.trim() === '' ? '' : '\n\n';
  const insert = `${sep}${buildTableSkeleton(rows, cols)}\n`;
  view.dispatch({
    changes: { from: line.to, to: line.to, insert },
    selection: { anchor: line.to + sep.length + 2 },
    scrollIntoView: true,
  });
}

// ---- 文本级替换（全文替换用；契约见 IMarkdownEngine.CmReplaceHandle）----
/** 替换一处。dispatch 必带 docChanged → 内核 on-change 冒泡 → markDirty → 自动保存，
 *  不需要另外回写 tab.content。偏移与 tab.content 同源，仍先比对 expect 再动手 */
function replaceRange(from: number, to: number, replacement: string, expect: string): boolean {
  const view = getTableView();
  if (!view) return false;
  if (view.state.doc.sliceString(from, to) !== expect) return false; // 查找后文本又变了：拒绝，别替错位置
  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: { anchor: from + replacement.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** 整篇替换：单事务完成全部命中（一步撤销即可整体回退），文档与 baseText 不符时拒绝 */
function replaceDocText(nextText: string, baseText: string): boolean {
  const view = getTableView();
  if (!view) return false;
  if (view.state.doc.toString() !== baseText) return false;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextText } });
  view.focus();
  return true;
}

/** 粘贴拦截：剪贴板为 ≥2行×2列 的 TSV/CSV 时改写为 Markdown 表格再交默认插入 */
function onPasteTable(event: ClipboardEvent): void {
  // 仅接管编辑窗格内的粘贴（监听挂在常驻根节点，需自行收窄，防误接管输入框/对话框）
  if (!(event.target as HTMLElement | null)?.closest('.cm-editor')) return;
  const data = event.clipboardData;
  if (!data || data.files.length > 0) return; // 图片粘贴走 on-upload-img
  const raw = data.getData('text/plain');
  if (!raw) return;
  const md = tsvToTable(raw);
  if (!md) return;
  // paste 事件内可读可写；preventDefault 使 CM 不插入，随后内置 handler 读到的即改写值
  event.preventDefault();
  data.setData('text/plain', md);
  const view = getTableView();
  if (view) {
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: md },
      selection: { anchor: sel.from + md.length },
      scrollIntoView: true,
    });
  }
}

/** 切换编辑器页面内全屏（同工具栏 pageFullscreen 图标，F11 快捷键共用） */
function togglePageFullscreen(): void {
  const inst = editorRef.value as unknown as InsertApi | null;
  inst?.togglePageFullscreen?.();
}

// ---- 导出/打印 PDF（官方 ExportPDF 机制同构自建） ----
// 机制同 md-editor-v3 官方 ExportPDF（@vavt/v3-extension）：独立 MdPreview
// （id=export-pdf-preview，Teleport 到 body 直下、恒驻 DOM）+ window.print()，
// 打印范围由本文件末尾非 scoped 样式的 @media print 规则接管（移植自官方 ExportPDF.css）。
// 不直接挂官方组件的原因：① ModalToolbar 深依赖 MdEditor 的 provide 上下文，裸放会渲染崩溃；
// ② 挂 defToolbars 插槽时 v7 强制 clone props 且错绑 theme/previewTheme/language，
//    需额外包装层隔离，实测适配链路脆弱。导出功能收在顶栏 Printer 单一入口。
const exportContent = ref(props.modelValue);

// 内容快照节流：避免编辑态每次按键都触发第二个 MdPreview 全量渲染；
// 打印瞬间强制同步最新值，等 MdPreview 内部渲染（renderDelay 默认 500ms）完成再触发打印
let exportSyncTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.modelValue,
  (v) => {
    if (exportSyncTimer) clearTimeout(exportSyncTimer);
    exportSyncTimer = setTimeout(() => {
      exportContent.value = v;
    }, 800);
  },
);

/** 导出宿主渲染完成等待者（exportPdf 挂起中；on-html-changed 或轮询兜底唤醒） */
let exportRenderWake: (() => void) | null = null;

/** 导出宿主 MdPreview 的 on-html-changed：量行高 + 唤醒打印等待（P2-34 事件路径） */
function onExportPreviewRendered(): void {
  measureEditLineHeight();
  const wake = exportRenderWake;
  exportRenderWake = null;
  wake?.();
}

/**
 * 等导出宿主渲染完成（P2-34）：on-html-changed 事件优先；
 * 内容未变（无事件触发）时轮询兜底——#export-pdf-preview 文本长度两帧稳定
 * 且已过最少 500ms（对齐内核 renderDelay）判就绪。mermaid/图片等异步资源的
 * 继续加载仍由打印对话框弹出前的空档兜底（同原固定等待口径）。
 */
function waitExportPreviewReady(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      exportRenderWake = null;
      resolve();
    };
    exportRenderWake = done;
    const startedAt = performance.now();
    const host = document.getElementById('export-pdf-preview');
    let lastLen = host?.textContent?.length ?? -1;
    let missFrames = 0; // 宿主缺失计数：防无限 rAF 空转（缺失由调用方 exportPreviewMissing 报错）
    const tick = (): void => {
      if (!exportRenderWake) return; // 已被 on-html-changed 唤醒
      const el = document.getElementById('export-pdf-preview');
      const len = el?.textContent?.length ?? -1;
      if (len < 0) {
        if (++missFrames > 30) {
          done();
          return;
        }
      } else {
        missFrames = 0;
      }
      const stable = len >= 0 && len === lastLen;
      lastLen = len;
      if (stable && performance.now() - startedAt >= 500) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * 等待导出宿主内 Mermaid 渲染完成（svg 就位）：md-editor 的 mermaid 在 html-changed
 * 之后异步 replaceMermaid（mermaid.render 为 async，渲染源码 div 被整替为 svg 段落），
 * 「文本长度稳定 / on-html-changed 唤醒」都早于 svg 插入——快照/打印会抓到源码态。
 * 轮询至宿主内所有 [class*="mermaid"] 节点带 data-processed 或含 svg；
 * 渲染失败（语法错误）会停留源码态，3s 上限兜底继续（可用性优先，勿无限等待）。
 */
async function waitMermaidRendered(): Promise<void> {
  const started = performance.now();
  // 图表本体 = 类名含 mermaid 但排除操作条（-action/-copy/-zoom 无 svg 也永不带 data-processed）
  const isChartEl = (n: Element): boolean => {
    const c = n.getAttribute('class') ?? '';
    return (
      c.includes('mermaid') &&
      !c.includes('mermaid-action') &&
      !c.includes('mermaid-copy') &&
      !c.includes('mermaid-zoom')
    );
  };
  const pending = (): number => {
    const el = document.getElementById('export-pdf-preview');
    if (!el) return 0;
    return Array.from(el.querySelectorAll('[class*="mermaid"]')).filter(
      (n) => isChartEl(n) && !n.hasAttribute('data-processed') && !n.querySelector('svg'),
    ).length;
  };
  while (pending() > 0 && performance.now() - started < 1500) {
    await new Promise((r) => setTimeout(r, 120));
  }
}

/**
 * 导出宿主内 mermaid 图表的确定性替换（2026-10-13 修复「导出 Word 架构图空白/源码」）。
 *
 * 内核两大事实（见 mdRendererConfig.renderMermaidSvg 注释）：
 *  1. replaceMermaid 是 html-changed 之后的异步渲染，源码 div 被整替为含 svg 的段落；
 *  2. 渲染结果按源文本缓存在模块级 LRU，**缓存命中时不做节点替换**——主预览渲染过的
 *     图表，导出宿主内永远是源码 div（等待解决不了）。
 * 故此处不再依赖内核渲染：对宿主内每个图表元素（渲染前 div / 渲染后 p 均可）取源码
 * （优先 data-content 属性，回退 textContent），用 renderMermaidSvg 以「无 foreignObject、
 * 白底浅色」配置自渲染并就地替换为 data-processed 段落——快照内全部是可光栅化的 svg。
 * 内核迟到的 replaceMermaid 只替换 div（我们产出的是 p），不会二次覆盖，竞态安全。
 * 渲染失败保留原样（源码 div → 映射层 D9 降级为源码文本，绝不出空白）。
 */
async function replaceExportMermaid(): Promise<void> {
  const host = document.getElementById('export-pdf-preview');
  if (!host) return;
  const isChartEl = (n: Element): boolean => {
    const c = n.getAttribute('class') ?? '';
    return (
      c.includes('mermaid') &&
      !c.includes('mermaid-action') &&
      !c.includes('mermaid-copy') &&
      !c.includes('mermaid-zoom')
    );
  };
  const charts = Array.from(host.querySelectorAll('[class*="mermaid"]')).filter(isChartEl);
  for (const el of charts) {
    const src = (el.getAttribute('data-content') ?? el.textContent ?? '').trim();
    if (!src) continue;
    const svg = await renderMermaidSvg(src);
    if (!svg) continue;
    const p = document.createElement('p');
    p.className = 'mermaid';
    p.setAttribute('data-processed', '');
    p.innerHTML = svg;
    el.replaceWith(p);
  }
}

/** 打印 PDF：同步最新内容 → 等渲染（事件优先、轮询兜底）→ window.print。三态通用。 */
async function exportPdf(): Promise<void> {
  exportContent.value = props.modelValue;
  await waitExportPreviewReady();
  await waitMermaidRendered();
  await replaceExportMermaid();
  if (!document.getElementById('export-pdf-preview')) {
    throw new Error(t('engine.exportPreviewMissing'));
  }
  window.print();
}

/**
 * Word 导出用的预览 HTML 快照（R1）：同步内容到导出宿主 → 等渲染（mermaid/katex/图片）→ 取 innerHTML。
 * 与 exportPdf 共用等待机制，编辑态同样可用（宿主恒驻 DOM）；调用方（Workbench.doExportWord）持锁防重入。
 *
 * 关键：导出宿主 .mk-export-host 屏幕态恒 display:none，零布局会导致：
 *  - Mermaid 在快照 HTML 中拿不到渲染后的 <svg>（依赖真实容器宽度）；
 *  - 即便 htmlToDocx 后续把 HTML 移入离屏 staging 重新布局，公式/图尺寸量测也易失真。
 * 故快照期间临时挂 .mk-export-host--live（脱离 display:none，off-screen + visibility:hidden 仅隐藏不丢布局），
 * 让 Mermaid/KaTeX 在可见布局下完成渲染与回流，取完 innerHTML 即摘除。
 */
async function getExportPreviewHtml(): Promise<string> {
  const host = document.getElementById('export-pdf-preview');
  if (!host) {
    throw new Error(t('engine.exportPreviewMissing'));
  }
  const wrap = host.closest('.mk-export-host') as HTMLElement | null;
  wrap?.classList.add('mk-export-host--live');
  try {
    exportContent.value = props.modelValue;
    await waitExportPreviewReady();
    await waitMermaidRendered();
    await replaceExportMermaid();
    await nextTick(); // 等一帧：Mermaid/KaTeX 在可见布局下完成渲染与回流
    const fresh = document.getElementById('export-pdf-preview');
    if (!fresh) {
      throw new Error(t('engine.exportPreviewMissing'));
    }
    return fresh.innerHTML;
  } finally {
    wrap?.classList.remove('mk-export-host--live');
  }
}

defineExpose({
  scrollToLine,
  insert,
  wrapSelection,
  setHeading,
  setBlockFormat,
  togglePageFullscreen,
  highlight,
  clearHighlight,
  exportPdf,
  getExportPreviewHtml,
  tableOp,
  insertTable,
  focusEditor,
  replaceRange,
  replaceDocText,
});

// ---- 光标跟踪（状态栏 L:C）：监听原生 selectionchange，经 rAF 节流后从 CM6 state 读取 ----
interface CmViewLike {
  scrollDOM: HTMLElement;
  focus(): void;
  dispatch(spec: { selection?: { anchor: number }; scrollIntoView?: boolean; effects?: unknown }): void;
  lineBlockAtHeight(y: number): { from: number };
  lineBlockAt(pos: number): { top: number };
  state: {
    selection: { main: { head: number } };
    doc: {
      lines: number;
      lineAt(pos: number): { number: number; from: number };
      line(n: number): { from: number; to: number; text: string };
    };
  };
}
type EditorWithView = { getEditorView?: () => CmViewLike | null };

let cursorRaf = 0;
function emitCursorPosition() {
  if (props.mode === 'read') return; // 阅读态无光标概念
  const inst = editorRef.value as unknown as EditorWithView | null;
  const view = inst?.getEditorView?.();
  if (!view) return;
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  emit('cursor', { line: line.number, col: head - line.from + 1 });
}
function onSelectionChange() {
  if (cursorRaf) return;
  cursorRaf = requestAnimationFrame(() => {
    cursorRaf = 0;
    emitCursorPosition();
  });
}

// ---- 三模式切换的位置同步（编辑位置 ↔ 阅读位置） ----
// 锚点 = { line: 目标源码行(1-based), yOffset: 目标在源视口内的 y 偏移, doc: 捕获时的文档路径, atEnd: 源侧已滚到底 }
// 双向统一「视口顶边」口径，保证切换前后视口顶边内容连续：
// edit/split → read：锚点取 **CM 视口顶部可见行**（含被裁偏移 yOffset ≤ 0）；
//   阅读态把该行所在块的块顶还原到同一偏移处（源码块与渲染块高度近似成比例，
//   裁切偏移转移后顶边内容基本逐行对齐）。**不用视口中心行 + 固定 1/3 落点**——
//   中心行在编辑态位于 50%，阅读态块顶却在 33%，纯切换（不动滚动条）也固定上跳约 1/6 视口。
//   split 下内核按比例同步，CM 顶行与预览顶边内容一致，取 CM 顶行同样成立。
//   只改 .read-scroll.scrollTop，**不用 scrollIntoView**：后者会连带滚动所有可滚动祖先
//   （body 等），真实工作台布局下会把顶栏/文件树一起顶走。
// read → edit/split：锚点取阅读视口顶部可见块（data-line）+ 被裁偏移；编辑态用
//   EditorView.scrollIntoView effect 还原块顶偏移（偏移钳为 ≥0），**不动光标**——
//   TransactionSpec.scrollIntoView 依赖 selection，改选区会被内核 scrollToSelection
//   立刻拉回视口（等于没滚）。
// **底边特判**：源侧距最大滚动 ≤4px 视为"滚到底"（atEnd），目标侧直接钉到自己的
//   最大滚动位——通用偏移转移在边界失效（两侧内容总高度不同，按偏移对齐后到不了底），
//   且阅读态资源加载增高后重钉仍成立（resync 复用同一锚点）。
// 定位后校正：图片/mermaid/katex 渲染完成使内容增高，按同一锚点重算（限次，防抖）。
type ModeAnchor = { line: number; yOffset: number; doc: string | null; atEnd?: boolean };

/** 距最大滚动 ≤4px 视为"已滚到底"（滚轮/滚动条都存在末尾像素级抖动） */
const AT_END_EPS = 4;

/** 资源加载后的校正次数上限（防抖 300ms 内合并多次触发） */
const RESYNC_MAX = 3;
/** 定位重试窗口内用户已有操作则放弃补位，避免"自己刚滚完又被拽回去" */
const USER_TOUCH_WINDOW = 1500;

let pendingAnchor: ModeAnchor | null = null;
let resyncAnchor: ModeAnchor | null = null;
// 三条异步链各自持有定时器：共用一个会互相覆盖（分栏预览同步的轮询曾被 CM 校验定时器顶掉，
// 导致预览停在顶部且不再重试）
let locateTimer: ReturnType<typeof setTimeout> | null = null; // 阅读态锚点轮询
let previewTimer: ReturnType<typeof setTimeout> | null = null; // 分栏预览同步轮询
let verifyTimer: ReturnType<typeof setTimeout> | null = null; // CM 滚动生效校验
let resyncTimer: ReturnType<typeof setTimeout> | null = null;
let resyncCount = 0;
let userTouchedAt = 0;
/** 本次模式切换的起点时刻：守卫只拦「切换之后」的用户操作——
 *  切换前的滚轮（如滚到文档末尾马上点切换按钮）是达成切换意图的必要动作，
 *  不能作为"用户已接管定位"的证据，否则定位直接放弃、编辑态停在文档头 */
let switchStartedAt = 0;

/**
 * 滚动同步开关（settings.scrollSync）的运行时生效机制：
 * 内核 scrollAuto 与 preview prop 同款限制——内部 store 只在挂载时从 props 取值
 * （`Z({scrollAuto: e.scrollAuto})`），无 props 同步 watcher，实例 API 也没有
 * toggleScrollAuto，运行时改 prop 无效。因此设置变更走**重挂载**：
 * 先捕获当前视口锚点，重挂后 applyEditAnchor 还原位置（applyEditAnchor 的
 * 120ms 重试覆盖 CM 未就绪窗口）。
 */
const editorRemountKey = ref(0);
let remountAnchor: ModeAnchor | null = null;
function remountEditorPreservingViewport(): void {
  if (props.mode === 'read') return; // 阅读态无编辑器实例，下次切入自然带新值
  remountAnchor = captureViewportAnchor();
  editorRemountKey.value += 1;
  void nextTick(() =>
    requestAnimationFrame(() => {
      const a = remountAnchor;
      remountAnchor = null;
      if (a) applyEditAnchor(a);
    }),
  );
}
watch(() => props.scrollSync, remountEditorPreservingViewport);
// 语言变更同样依赖重挂载（内核 language 同为挂载初值型 prop）；
// 阅读态 MdPreview / 导出宿主经 :key 内含 language 自动重建
watch(() => props.language, remountEditorPreservingViewport);

function userTouchedRecently(): boolean {
  // 只认切换开始之后的操作：切换前的 wheel/keydown 是浏览动作，不否定本次定位
  return (
    userTouchedAt > switchStartedAt &&
    performance.now() - userTouchedAt < USER_TOUCH_WINDOW
  );
}
function markUserTouch(): void {
  userTouchedAt = performance.now();
}

/** 捕获编辑/分栏视口顶部可见行作为锚点（与 read→edit 的「顶块」口径对称）。
 *  不用光标行：滚轮浏览时光标不随视线移动（常停在文档头），split 下用户看的是
 *  预览侧（内核按比例同步，光标行与视线可差数百行）；CM 顶行在两种模式下
 *  都对应视口顶边内容。yOffset = 顶行块顶距视口顶的偏移（≤0，被裁量），
 *  阅读态按同一偏移还原，顶边内容连续（源码块与渲染块高度近似成比例）。 */
function captureViewportAnchor(): ModeAnchor | null {
  const inst = editorRef.value as unknown as EditorWithView | null;
  const view = inst?.getEditorView?.();
  if (!view) return null;
  const sd = view.scrollDOM;
  if (sd.scrollTop < 4) return null; // 停在文档头：阅读/编辑都从顶部开始，无需同步
  const maxScroll = sd.scrollHeight - sd.clientHeight;
  const atEnd = sd.scrollTop >= maxScroll - AT_END_EPS;
  const block = view.lineBlockAtHeight(sd.scrollTop + 2); // 文档坐标（非视口坐标）
  const line = view.state.doc.lineAt(block.from).number;
  const top = view.lineBlockAt(block.from).top;
  return { line, yOffset: Math.round(top - sd.scrollTop), doc: props.docPath, atEnd };
}

/** 捕获阅读视口顶部可见块：data-line 行号 + 块顶距容器顶的偏移；停在文档头返回 null */
function captureReadAnchor(): ModeAnchor | null {
  const root = rootRef.value;
  const scroller = root?.querySelector<HTMLElement>('.read-scroll');
  if (!root || !scroller) return null;
  if (scroller.scrollTop < 4) return null; // 停在文档头：阅读/编辑都从顶部开始，无需同步
  const maxScroll = scroller.scrollHeight - scroller.clientHeight;
  const atEnd = scroller.scrollTop >= maxScroll - AT_END_EPS;
  const crect = scroller.getBoundingClientRect();
  const blocks = root.querySelectorAll<HTMLElement>('[data-line]');
  // 视口内第一个块（前一块的 bottom 已滚出容器顶）；滚过末尾空白区时取最后一个锚点块
  let first: HTMLElement | null = null;
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (r.bottom > crect.top + 1) {
      first = el;
      break;
    }
  }
  first ??= blocks[blocks.length - 1] ?? null;
  if (!first) return null;
  const line = Number(first.getAttribute('data-line'));
  if (!Number.isFinite(line)) return null;
  return {
    line,
    yOffset: first.getBoundingClientRect().top - crect.top,
    doc: props.docPath,
    atEnd,
  };
}

/** 在容器内找「起始行 <= 目标行」的最后一个 data-line 块 */
function findAnchorBlock(scope: HTMLElement, line: number): HTMLElement | null {
  let target: HTMLElement | null = null;
  for (const el of scope.querySelectorAll<HTMLElement>('[data-line]')) {
    const start = Number(el.getAttribute('data-line'));
    if (Number.isFinite(start) && start <= line) target = el;
    else break;
  }
  return target;
}

/** 阅读态按锚点对齐：锚点块顶还原到编辑态顶行的偏移处（负值 = 块顶留在视口上方，
 *  与编辑态的被裁状态一致）；源侧已滚到底则直接钉到阅读态最大滚动位。
 *  只动 .read-scroll，不碰祖先。返回是否命中 */
function alignReadAnchor(anchor: ModeAnchor): boolean {
  const root = rootRef.value;
  const scroller = root?.querySelector<HTMLElement>('.read-scroll');
  if (!root || !scroller) return false;
  if (anchor.atEnd) {
    scroller.scrollTop = scroller.scrollHeight; // 浏览器自动钳到最大滚动位
    return true;
  }
  const target = findAnchorBlock(root, anchor.line);
  if (!target) return false;
  const crect = scroller.getBoundingClientRect();
  const desired = crect.top + anchor.yOffset;
  scroller.scrollTop += target.getBoundingClientRect().top - desired;
  return true;
}

/** 分栏态预览区真正承担滚动的容器（wrapper 或 preview 视内核结构而定）。
 *  不做 fallback：预览尚未渲染时两者都不可滚，返回 null 交给轮询重试，
 *  对不可滚容器设 scrollTop 只会静默失效（曾误判为"不同步"） */
function findScrollablePreview(): HTMLElement | null {
  const root = rootRef.value;
  if (!root) return null;
  const cands = [
    root.querySelector<HTMLElement>('.md-editor-preview-wrapper'),
    root.querySelector<HTMLElement>('.md-editor-preview'),
  ].filter((x): x is HTMLElement => !!x);
  return cands.find((el) => el.scrollHeight > el.clientHeight + 4) ?? null;
}

/** 分栏态预览侧同步到同一行：块顶还原偏移与 CM 侧一致（钳为 ≥0，同 applyEditAnchor），
 *  只改预览容器 scrollTop（不碰祖先）。
 *  定位一次即可，**不与内核 scrollAuto 争夺**：内核按滚动比例同步预览是既有功能
 *  （settings.scrollSync），程序化定位后内核仍会按比例回写，链式校正会与之互搏。
 *  内核同步关闭导致预览停在顶部时，本函数兜底。 */
function scrollPreviewToLine(line: number, yOffset = 0, attempt = 0): void {
  const pv = findScrollablePreview();
  const block = pv ? findAnchorBlock(pv, line) : null;
  if (!pv || !block) {
    if (attempt < 8) {
      previewTimer = setTimeout(() => scrollPreviewToLine(line, yOffset, attempt + 1), 100);
    }
    return;
  }
  const crect = pv.getBoundingClientRect();
  pv.scrollTop += block.getBoundingClientRect().top - (crect.top + Math.max(0, yOffset));
}

/** 分栏态预览侧钉到最底部（源侧滚到底的镜像，轮询等预览可滚后赋值） */
function scrollPreviewToEnd(attempt = 0): void {
  const pv = findScrollablePreview();
  if (!pv) {
    if (attempt < 8) previewTimer = setTimeout(() => scrollPreviewToEnd(attempt + 1), 100);
    return;
  }
  pv.scrollTop = pv.scrollHeight;
}

/** 阅读态定位消费：MdPreview 渲染完成前 [data-line] 尚未生成，120ms 轮询兜底（上限 3s） */
function locateReadAnchor(attempt = 0): void {
  const anchor = pendingAnchor;
  if (!anchor) return;
  if (anchor.doc !== props.docPath) {
    pendingAnchor = null; // 期间切了文档，锚点作废
    return;
  }
  if (attempt > 0 && userTouchedRecently()) {
    pendingAnchor = null;
    return;
  }
  if (alignReadAnchor(anchor)) {
    pendingAnchor = null;
    resyncAnchor = anchor; // 交给资源加载后的校正
    scheduleResync();
    return;
  }
  if (attempt < 25) locateTimer = setTimeout(() => locateReadAnchor(attempt + 1), 120);
}

/** 资源加载（图片/mermaid/katex）后内容增高 → 按原锚点重算滚动，限次防抖 */
function scheduleResync(): void {
  if (!resyncAnchor || resyncCount >= RESYNC_MAX) return;
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    const anchor = resyncAnchor;
    if (!anchor || anchor.doc !== props.docPath || userTouchedRecently()) return;
    resyncCount += 1;
    alignReadAnchor(anchor);
  }, 300);
}

/** 编辑态定位：先走 CM scrollIntoView effect（快路径，纯 edit 模式下可靠）；
 *  但 read→split 的 MdEditor 重挂载场景下，effect 滚动会与预览渲染的 measure、
 *  内核 scrollAuto 同步链竞争，偶发被整体顶回（非确定性，实测同代码时过时不过）。
 *  因此 200ms / 700ms 两刀校验「锚点块顶距视口顶 == 期望 yMargin」：
 *  偏差 >40px 判为被顶掉，直接给 scrollDOM.scrollTop 赋值校正
 *  （绕开 effect 的 measure 排队；已在稳态实测可靠）。
 *  源侧（阅读态）滚到底：直接钉 CM 最大滚动位 + 两刀重钉（内容 measure 完成前后
 *  最大滚动位会变），不走逐行锚点。 */
function applyEditAnchor(anchor: ModeAnchor, attempt = 0): void {
  const inst = editorRef.value as unknown as EditorWithView | null;
  const view = inst?.getEditorView?.();
  if (!view) {
    if (attempt < 10) locateTimer = setTimeout(() => applyEditAnchor(anchor, attempt + 1), 120);
    return;
  }
  // 文档已换（切标签）或用户已操作：锚点作废，避免跳到无关位置
  if (anchor.doc !== props.docPath || userTouchedRecently()) return;
  if (anchor.atEnd) {
    // 刻意不调 view.focus()：内核为编辑器启用了 scrollToSelection，聚焦会把视口拉回光标处
    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    const repin = (delay: number): void => {
      verifyTimer = setTimeout(() => {
        const v = (editorRef.value as unknown as EditorWithView | null)?.getEditorView?.();
        if (!v || userTouchedRecently()) return;
        v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
      }, delay);
    };
    repin(200);
    repin(700);
    if (props.mode === 'split') void nextTick(() => scrollPreviewToEnd());
    return;
  }
  const n = Math.max(1, Math.min(anchor.line, view.state.doc.lines));
  const pos = view.state.doc.line(n).from;
  const margin = Math.max(0, anchor.yOffset);
  // 刻意不调 view.focus()：内核为编辑器启用了 scrollToSelection，聚焦会把视口拉回光标处
  // （"不动光标"语义下光标仍在原处，可能与锚点相隔很远），直接抵消刚定位的滚动。
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: margin }),
  });
  if (anchor.line > 1) {
    const verify = (delay: number): void => {
      verifyTimer = setTimeout(() => {
        const v = (editorRef.value as unknown as EditorWithView | null)?.getEditorView?.();
        if (!v || userTouchedRecently()) return;
        const block = v.lineBlockAt(v.state.doc.line(n).from);
        if (Math.abs(block.top - v.scrollDOM.scrollTop - margin) > 40) {
          // effect 滚动被竞争方顶掉：直接赋值校正（S8 实测稳态下可靠）
          v.scrollDOM.scrollTop = Math.max(0, block.top - margin);
        }
      }, delay);
    };
    verify(200);
    verify(700);
  }
  if (props.mode === 'split') void nextTick(() => scrollPreviewToLine(n, anchor.yOffset));
}

// ---- 图片加载失败可视化（捕获阶段监听，含预览/阅读态动态插入的 img） ----
function onImgError(e: Event) {
  const t = e.target as HTMLImageElement | null;
  if (!t || t.tagName !== 'IMG') return;
  t.style.minWidth = '160px';
  t.style.minHeight = '60px';
  t.style.outline = '2px dashed var(--mk-danger, #d9534f)';
  t.style.objectFit = 'contain';
  if (!t.alt) t.alt = '图片加载失败';
  t.title = `图片加载失败：${t.getAttribute('src') ?? ''}`;
}
// ---- 预览区链接拦截（捕获阶段，编辑/分栏/阅读三态全覆盖） ----
// 不拦截时 WebView 会直接导航：相对链接（如 2026-08-03.md）被当主机名解析失败，
// 应用 UI 被顶掉且无法返回。规则：外链走系统浏览器、文内锚点平滑滚动、
// 文件路径链接上抛 openDoc（应用按当前文档目录解析后打开）、其余协议禁止。
const isTauri = typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

function onAnchorClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement | null)?.closest?.('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href') ?? '';
  if (!href || href.startsWith('javascript:')) {
    e.preventDefault();
    return;
  }
  if (href.startsWith('#')) {
    // 文内锚点：滚动到对应标题（不改动 location，避免 WebView 导航）
    e.preventDefault();
    const el = rootRef.value?.querySelector<HTMLElement>(
      `#${CSS.escape(decodeURIComponent(href.slice(1)))}`,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (/^(https?:\/\/|mailto:)/i.test(href)) {
    e.preventDefault();
    if (href.startsWith('mailto:')) {
      // 邮件协议走系统处理（Web 标签无法承载）
      if (isTauri) {
        openUrl(href).catch(() => emit('toast', t('engine.openUrlFail', { url: href })));
      } else {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    } else {
      emit('openLink', href);
    }
    return;
  }
  // 文件路径链接（相对/绝对，无 URL scheme；Windows 盘符 C:\ 经 normalizeLink 编码成
  // C:%5C…，形似 scheme，单字母冒号前缀先排除再判协议）：原样上抛
  // （decode/剥锚点/拼接交业务层，与图片 toAssetUrl 分工一致）。
  e.preventDefault();
  if (/^[a-zA-Z]:/.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    emit('openDoc', href);
    return;
  }
  // 其余未识别协议（ftp:/tel: 等）：一律禁止，防止整窗被导航
  emit('toast', t('engine.noJumpLink', { href }));
}

// ---- 预览 HTML 渲染完成：上抛 + 查找高亮重涂（重渲染会重建 DOM，mark 丢失） ----
function onHtmlChanged(html: string): void {
  emit('htmlChanged', html);
  if (lastFind) {
    void nextTick(() => applyPreviewMarks(lastFind!.keyword, lastFind!.caseSensitive));
  }
  // 切入阅读态的首帧渲染完成：提前命中位置同步（不等轮询）；后续重渲染触发资源校正
  if (pendingAnchor) locateReadAnchor();
  else scheduleResync();
}

// ---- 资源加载完成触发位置校正（图片/mermaid/katex 渲染完内容会增高） ----
// load 事件不冒泡，但捕获阶段仍可拦截；与 onHtmlChanged 的重渲染触发共用 scheduleResync。
function onAssetLoad(e: Event) {
  if ((e.target as HTMLElement | null)?.tagName !== 'IMG') return;
  scheduleResync();
}

onMounted(() => {
  setupMdRenderer();
  rootRef.value?.addEventListener('error', onImgError, true);
  rootRef.value?.addEventListener('load', onAssetLoad, true);
  // 链接拦截：捕获阶段先于 md-editor 内部与浏览器默认行为
  rootRef.value?.addEventListener('click', onAnchorClick, true);
  // 表格粘贴转换 + 编辑区右键：绑在常驻根节点的捕获阶段，先于 CM 内置 handler；
  // 不用内核 domEventHandlers：一次性注册会因 CM 视图未就绪静默失效，见 onEditorContext 注释
  rootRef.value?.addEventListener('paste', onPasteTable, true);
  rootRef.value?.addEventListener('contextmenu', onEditorContext, true);
  // 光标跟踪：CM6 光标移动会触发原生 selectionchange，rAF 节流后读取 CM state
  document.addEventListener('selectionchange', onSelectionChange);
  // 行高跟随主题：导出预览宿主渲染有 500ms 防抖，onMounted 时内容可能未渲染
  // （量到容器 normal 行高会被守卫拦下），以 @on-html-changed 为准，这里仅兜底空文档
  void nextTick(() => setTimeout(measureEditLineHeight, 700));
  // 用户主动操作标记：定位重试窗口内滚轮/按键/点击则放弃补位，防止"刚滚完又被拽回去"
  for (const ev of ['wheel', 'keydown', 'pointerdown'] as const) {
    rootRef.value?.addEventListener(ev, markUserTouch, { capture: true, passive: true });
  }
});
onBeforeUnmount(() => {
  rootRef.value?.removeEventListener('error', onImgError, true);
  rootRef.value?.removeEventListener('load', onAssetLoad, true);
  rootRef.value?.removeEventListener('click', onAnchorClick, true);
  rootRef.value?.removeEventListener('paste', onPasteTable, true);
  rootRef.value?.removeEventListener('contextmenu', onEditorContext, true);
  document.removeEventListener('selectionchange', onSelectionChange);
  for (const ev of ['wheel', 'keydown', 'pointerdown'] as const) {
    rootRef.value?.removeEventListener(ev, markUserTouch, { capture: true });
  }
  if (cursorRaf) {
    cancelAnimationFrame(cursorRaf);
    cursorRaf = 0;
  }
  if (locateTimer) {
    clearTimeout(locateTimer);
    locateTimer = null;
  }
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (verifyTimer) {
    clearTimeout(verifyTimer);
    verifyTimer = null;
  }
  if (resyncTimer) {
    clearTimeout(resyncTimer);
    resyncTimer = null;
  }
  // 大纲防抖与导出内容同步定时器（P1-11）：漏清会导致卸载后旧定时器仍
  // emit('outline') 覆盖新文档大纲 / 改写已切走文档的 exportContent
  if (outlineTimer) {
    clearTimeout(outlineTimer);
    outlineTimer = null;
  }
  if (exportSyncTimer) {
    clearTimeout(exportSyncTimer);
    exportSyncTimer = null;
  }
});
</script>

<template>
  <div
    ref="rootRef"
    class="engine-root"
    :class="[mode !== 'split' ? `layout--${readLayout ?? 'medium'}` : '', { 'no-toolbar': showToolbar === false, 'show-linenum': showLineNumbers === true }]"
    :style="{ '--mk-editor-lh': editLineHeight }"
  >
    <!-- 阅读态：独立滚动容器 + 居中阅读栏，内容可正常滚动；key 绑定 docPath+language，
         切文档/切语言时重建（内核语言同为挂载初值型） -->
    <div v-if="mode === 'read'" class="read-scroll">
      <div class="read-column" :class="`read-column--${readLayout ?? 'medium'}`">
        <MdPreview
          :id="`${editorId}-pv`"
          :key="`${docPath ?? 'draft'}-${language ?? 'zh-CN'}`"
          :model-value="modelValue"
          :theme="theme"
          :preview-theme="previewTheme"
          :language="language"
          @on-html-changed="onHtmlChanged"
        />
      </div>
    </div>
    <!-- 编辑/分栏态：同一实例，preview 属性响应式切换（不再强制重建，避免重挂载崩溃）；
         remountKey 仅在 scrollSync 设置变更时递增（内核 scrollAuto 只读挂载初值，
         运行时改 prop 无效，见 editorRemountKey 注释） -->
    <MdEditor
      v-else
      :id="editorId"
      ref="editorRef"
      :key="editorRemountKey"
      :model-value="modelValue"
      :theme="theme"
      :preview-theme="previewTheme"
      :language="language"
      :preview="mode === 'split'"
      :scroll-auto="scrollSync !== false"
      :footers="[]"
      :toolbars="toolbars"
      :class="editorClass"
      @on-change="(v: string) => emit('update:modelValue', v)"
      @on-save="(v: string) => emit('save', v)"
      @on-upload-img="handleUploadImg"
      @on-html-changed="onHtmlChanged"
    />
    <!-- 导出/打印 PDF 宿主（官方 ExportPDF 机制同构）：Teleport 到 body 直下，
         屏幕上隐藏，打印时由文件末尾 @media print 规则（移植自官方 ExportPDF.css）单独显示。
         theme 恒 light：打印产物固定白底黑字，不跟随应用暗色主题 -->
    <Teleport to="body">
      <div class="mk-export-host" aria-hidden="true">
        <MdPreview
          id="export-pdf-preview"
          :key="language ?? 'zh-CN'"
          :model-value="exportContent"
          theme="light"
          :preview-theme="previewTheme"
          :language="language"
          @on-html-changed="onExportPreviewRendered"
        />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.engine-root {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
.engine-editor {
  height: 100%;
}
.engine-root :deep(.md-editor) {
  height: 100%;
}
/* md-editor 根容器默认带 1px 边框（--md-border-color），与应用 chrome 的
   分隔线（标签栏底线/侧栏缘线/状态栏顶线）叠加成双线框。
   用面板色边框代替删除：保持默认盒模型不变（直接 none 会因几何变化在
   四边交界露出亚像素缝隙），且四邻全是 --mk-panel 面板（标签栏/文件树/
   状态栏/大纲），1px 边框融入背景——功能栏背景与树边线无缝接拢。
   注意：阅读态 MdPreview 的根节点 class 同样含 .md-editor（md-editor-previewOnly），
   必须排除——否则阅读内容列两侧各多一条 1px 面板色线，与白色背景形成视觉分隔 */
.engine-root :deep(.md-editor:not(.md-editor-previewOnly)) {
  border: 1px solid var(--mk-panel);
}
/* 暗色下 md-editor 内置背景板（--md-bk-color 默认 #000）对齐全局 --mk-bg，
   消除 editor-area 与编辑/分栏/阅读区（含 #mkdown-editor-pv）的色差分裂 */
.engine-root :deep(.md-editor[data-theme='dark']) {
  --md-bk-color: var(--mk-bg);
}

/* ---- 内容版式：控制"正文列"宽度，即两侧留白（编辑器外壳保持铺满） ----
   版式类挂在 engine-root 上：编辑态/阅读态挂，分栏态不挂 */
.engine-root {
  background: var(--mk-bg);
}
.layout--narrow { --mk-content-w: 680px; }
.layout--medium { --mk-content-w: 940px; }
.layout--wide { --mk-content-w: 1240px; }

/* 编辑态：CodeMirror 6 正文列限宽——用对称 padding 产生两侧留白（比 margin auto 在 flex 布局下更可靠） */
.engine-root :deep(.cm-content) {
  max-width: none;
  padding-inline: max(calc((100% - var(--mk-content-w, 940px)) / 2), 20px);
}

/* 阅读态：整栏滚动，内容居中限宽（列宽与编辑态一致，+80px 左右 padding） */
.read-scroll {
  height: 100%;
  overflow-y: auto;
  background: var(--mk-bg);
}
.read-column {
  max-width: calc(var(--mk-content-w, 940px) + 80px);
  margin: 0 auto;
  padding: 0 40px 64px;
}
.read-column :deep(.md-editor-preview),
.read-column :deep(.md-editor-previewOnly) {
  padding: 0;
}
/* 压掉预览首元素（通常 H1）的顶部 margin：分栏预览与阅读态都生效。
   注意 v7 预览没有 .markdown-body 中间层——主题类（default-theme/win-theme）
   直接挂在 .md-editor-preview 容器上，内容块是它的直接子元素 */
.engine-root :deep(.md-editor-preview > *:first-child) {
  margin-top: 0;
}
/* 代码块头部栏（复制/折叠）层级钳制：内核给它的 z-index 会盖过应用浮层
   （搜索面板曾为 80，现为 10100 层级带），统一压回普通流——浮层永远在上 */
.engine-root :deep(.md-editor-code-head),
.engine-root :deep(.md-editor-code-head .md-editor-copy-button),
.engine-root :deep(.md-editor-code-head .md-editor-code-fold) {
  z-index: auto !important;
}

/* ---- 全局字号：覆盖 md-editor 内部写死的字号，跟随 --mk-font-size ---- */
.engine-root :deep(.cm-editor) {
  font-size: var(--mk-font-size);
  /* 行距兜底：实际生效值在下方 .cm-scroller 覆盖（跟随阅读主题的 --mk-editor-lh） */
  line-height: 1.75;
}
/* 关键：内核在 `.md-editor .ͼ1 .cm-scroller` 上写死 line-height: 20px（特异性 0,3,0），
   .cm-scroller 有自己的声明，上面 .cm-editor 的 1.75 继承不过去——编辑态行距实际被
   钳成 20px，与阅读态明显不一致（纯视觉拥挤，字越大越挤）。
   这里以 0,4,0 特异性直接覆盖 .cm-scroller（.cm-line 为内核的 line-height: inherit）；
   行高值 = --mk-editor-lh（脚本从导出预览宿主量取当前阅读主题的行高/字号比，
   default 1.6 / github 1.5 / win 1.75 自动跟随），兜底 1.75。 */
.engine-root :deep(.md-editor .cm-scroller) {
  line-height: var(--mk-editor-lh, 1.75);
}
/* ---- 编辑态文字亮度（编辑/分栏下的 CodeMirror 窗格）----
   md-editor v7 的 CM 主题硬编码偏暗基色：亮色 #3f4a54、暗色 var(--md-color)=#999。
   用独立 token --mk-editor-fg 校准：亮色对齐预览正文（#3f4a54），
   暗色取中档 rgb(196,201,210)（#999 偏暗、rgb(232,233,238) 偏亮，两档均被否）。
   仅作用于 .cm-editor 子树，md-editor 工具栏/目录等 chrome 不受影响。 */
.engine-root :deep(.cm-editor) {
  color: var(--mk-editor-fg, var(--mk-fg));
  --md-color: var(--mk-editor-fg, var(--mk-fg));
}
.engine-root :deep(.cm-content) {
  font-family: Consolas, 'Cascadia Mono', 'Microsoft YaHei', monospace;
}
/* ---- 编辑态标题行：以 # 开头的整行字号固定 19px ----
   行类由 cmHeadingLine.ts 的 Decoration.line 挂载（token 类名混淆，CSS 无法定位）；
   行距随全局 1.75（同 win 预览主题），CM6 自行重测量。
   注意：固定值不随设置里的全局字号缩放（用户指定绝对 19px） */
.engine-root :deep(.cm-line.mk-cm-heading) {
  font-size: 19px;
}
.engine-root :deep(.md-editor-preview),
.engine-root :deep(.md-editor-previewOnly) {
  font-size: var(--mk-font-size);
}
.engine-root :deep(.markdown-body) {
  font-size: var(--mk-font-size) !important;
}
/* ---- 功能栏显隐（设置-编辑器「显示功能栏」）----
   display:none 直接收起 #mkdown-editor-toolbar-wrapper（内核按普通流布局，
   正文区自行上移铺满；CM6 容器高度变化走自身 ResizeObserver 重测量）。
   类挂在 engine-root 上，选择器带 .no-toolbar 限定，不影响导出预览宿主 */
.engine-root.no-toolbar :deep(.md-editor-toolbar-wrapper) {
  display: none;
}

/* ---- 行号（设置-编辑器「显示行号」）----
   数字来自 cmLineNumber.ts 挂在每行的 data-ln 属性（只覆盖可视区）。开关只切 engine-root 上的
   show-linenum 类：不重配 CM 扩展、不补发事务，因此切换不会打断输入与撤销栈。
   留白必须挂在 .cm-line 而不是 .cm-content：CM6 的选区层按 .cm-content 的内边距盒定位，
   留白挂在 content 上会让选区底色探进行号列；挂在行自身上，选区按字形坐标画，只覆盖正文。 */
.engine-root.show-linenum {
  /* 行号列总宽：加宽/收窄整列只改这一个值（数字与正文的间距另见 padding-right） */
  --mk-ln-w: 3.5em;
}
.engine-root.show-linenum :deep(.cm-line) {
  padding-left: var(--mk-ln-w);
}
.engine-root.show-linenum :deep(.cm-line::before) {
  content: attr(data-ln);
  /* 不用绝对定位：那要求 .cm-line 确实成为包含块（受内核同名规则与样式注入顺序影响，
     一旦没吃到就整体错位）。改为随文本流排布，再用负 margin 把整块拉进左留白 ——
     位置只由 --mk-ln-w 决定，数字天然贴列左，且与文字同一基线、无需手工算行高。 */
  display: inline-block;
  width: var(--mk-ln-w);
  margin-left: calc(-1 * var(--mk-ln-w));
  padding-right: 0.8em;
  box-sizing: border-box;
  text-align: left;
  color: var(--mk-fg-muted);
  opacity: 0.62;
  /* 行号独立字号（不跟全局字号缩放，与右键菜单 12.5px 同口径）；标题行的字号与字重也不继承 */
  font-size: 12.5px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  white-space: pre;
  user-select: none;
}

/* 功能栏视觉对齐：底色/边线对齐应用 chrome，图标色与 hover 语言同顶栏 ----
   md-editor v7 默认：图标 --md-color（亮 #3f4a54 / 暗 #999）、hover 底 --md-bk-color-outstand，
   与应用 token 体系脱节；这里逐项映射到 --mk-*，主题切换自动跟随 */
.engine-root :deep(.md-editor-toolbar-wrapper) {
  padding-block: 2px;
  background-color: var(--mk-panel);
  border-block-end-color: var(--mk-border);
  /* 左右各外扩 1px 盖住 .md-editor 的面板色边框列：功能栏底线（border-block-end）
     原本画在内容盒内，左端距树边线差 1px（DPI 下可见浅缝）；
     外扩后底线两端分别与目录树边线/右缘贴合。wrapper 自身无水平 padding，内容不位移 */
  margin-inline: -1px;
}
.engine-root :deep(.md-editor-toolbar-item) {
  color: var(--mk-fg-muted);
  transition: background-color 120ms ease, color 120ms ease;
}
.engine-root :deep(.md-editor-toolbar-item:not([disabled]):hover),
.engine-root :deep(.md-editor-toolbar-item.md-editor-toolbar-active) {
  color: var(--mk-fg);
  background-color: var(--mk-hover);
}

/* 编辑态滚动条是 v7 自绘的（原生 cm-scroller 滚动条已被隐藏）：
   滑槽默认带 --md-scrollbar-bg-color 底色（亮 #e2e2e2），置透明只留滑块 */
.engine-root :deep(.md-editor-custom-scrollbar__track) {
  background: transparent;
}

/* 暗色下的查找高亮底色（mark 在 .md-editor[data-theme] 子树内可继承该变量） */
.engine-root :deep(.md-editor[data-theme='dark']) {
  --mk-find-bg: rgba(255, 183, 77, 0.38);
}
</style>

<style>
/* ---- 文件内查找关键词高亮（非 scoped：CM6 装饰与预览 mark 均为动态插入 DOM） ---- */
.mk-cm-find,
mark.mk-pv-find {
  background: var(--mk-find-bg, rgba(255, 200, 0, 0.42));
  color: inherit;
  border-radius: 2px;
  padding: 0;
}

/* ---- 导出/打印 PDF（@media print 规则移植自 md-editor-v3 官方 ExportPDF.css） ----
   机制同官方：打印时隐藏 body 直下所有节点，仅显示导出宿主（Teleport 到 body 直下）。
   屏幕态宿主恒隐藏；打印态 !important 覆盖为可见。
   与官方的差异仅在宿主类名链路：官方走 .md-editor-modal-container 弹窗长链，
   此处宿主结构扁平，用 :not() 排除等价实现。 */
.mk-export-host {
  display: none;
}
/* Word 导出快照期间临时态：脱离 display:none，置于视口外且 visibility:hidden（仅隐藏不丢布局），
   让 Mermaid/KaTeX 在真实容器宽度下完成渲染与回流；双类选择器特异性高于 .mk-export-host，无需 !important */
.mk-export-host.mk-export-host--live {
  display: block;
  position: fixed;
  left: -99999px;
  top: 0;
  width: 1020px;
  visibility: hidden;
  z-index: -1;
  pointer-events: none;
}
@media print {
  body {
    margin: 0;
  }
  body > *:not(.mk-export-host) {
    display: none !important;
  }
  .mk-export-host {
    display: block !important;
  }
  /* 代码块打印时自动换行（官方同款规则） */
  .mk-export-host .md-editor-code pre code .md-editor-code-block {
    text-wrap: wrap;
  }
}
</style>
