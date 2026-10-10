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
import type { EditorMode, ThemeKind } from '../api/types';
import type { OutlineItem } from '../stores/editorStore';
import { setCurrentDocDir, setupMdRenderer } from './mdRendererConfig';
import { setCmFind } from './findHighlight';
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

// ---- 大纲提取（跳过代码块内的 # 行） ----
function extractOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let inCode = false;
  let index = 0;
  content.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^(```|~~~)/.test(line.trim())) {
      inCode = !inCode;
      return;
    }
    if (inCode) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      items.push({
        index: index++,
        text: m[2].replace(/#+\s*$/, '').trim(),
        level: m[1].length,
        line: i + 1,
      });
    }
  });
  return items;
}

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
    // CodeMirror 6：每行一个 .cm-line，按序号定位（行号 1-based）
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
    selection: { main: { from: number; to: number } };
    doc: {
      lineAt(pos: number): { number: number };
      line(n: number): { from: number; to: number; text: string };
    };
  };
  dispatch(spec: { changes: Array<{ from: number; to: number; insert: string }> }): void;
}

/** 为光标所在行（或选区覆盖各行）设置 N 级标题：剥旧前缀再加新前缀（幂等），行首语义正确 */
function setHeading(level: number): void {
  const inst = editorRef.value as unknown as EditorWithView | null;
  const view = inst?.getEditorView?.() as unknown as CmHeadingView | null;
  if (!view) return;
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(Math.min(sel.from, sel.to)).number;
  const endLine = view.state.doc.lineAt(Math.max(sel.from, sel.to)).number;
  const prefix = `${'#'.repeat(Math.min(6, Math.max(1, level)))} `;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (let n = startLine; n <= endLine; n++) {
    const line = view.state.doc.line(n);
    const stripped = line.text.replace(/^#{1,6}\s*/, '');
    if (line.text !== `${prefix}${stripped}`) {
      changes.push({ from: line.from, to: line.to, insert: `${prefix}${stripped}` });
    }
  }
  if (changes.length > 0) view.dispatch({ changes });
}

/** 切换编辑器页面内全屏（同工具栏 pageFullscreen 图标，F11 快捷键共用） */
function togglePageFullscreen(): void {
  const inst = editorRef.value as unknown as InsertApi | null;
  inst?.togglePageFullscreen?.();
}

defineExpose({ scrollToLine, insert, wrapSelection, setHeading, togglePageFullscreen, highlight, clearHighlight, exportPdf });

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

/** 打印 PDF：同步最新内容 → 等渲染 → window.print。三态通用。 */
async function exportPdf(): Promise<void> {
  exportContent.value = props.modelValue;
  // renderDelay 500ms + 余量；mermaid/图片等异步资源的继续加载由打印对话框弹出前的空档兜底
  await new Promise((resolve) => setTimeout(resolve, 650));
  if (!document.getElementById('export-pdf-preview')) {
    throw new Error(t('engine.exportPreviewMissing'));
  }
  window.print();
}

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
// 应用 UI 被顶掉且无法返回。规则：外链走系统浏览器、文内锚点平滑滚动、其余禁止。
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
  // 相对路径（.md 等）与其他协议：一律禁止，防止整窗被导航
  e.preventDefault();
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
});
</script>

<template>
  <div
    ref="rootRef"
    class="engine-root"
    :class="[mode !== 'split' ? `layout--${readLayout ?? 'medium'}` : '', { 'no-toolbar': showToolbar === false }]"
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
          @on-html-changed="measureEditLineHeight"
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
   （搜索面板 z-index 80），统一压回普通流——浮层永远在上 */
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
