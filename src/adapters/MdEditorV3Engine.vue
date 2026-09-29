<script setup lang="ts">
/**
 * ★ 编辑器内核适配层唯一实现文件（业务代码禁止直接 import md-editor-v3）。
 * 对外契约见 IMarkdownEngine.ts 注释；内核更换时仅改本文件。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { MdEditor, MdPreview, type ToolbarNames } from 'md-editor-v3';
import 'md-editor-v3/lib/style.css';
// 自建 win 预览主题（Windows 11 Fluent 风）；必须在 style.css 之后加载，
// style.css 首行 @import 的 @vavt/markdown-theme 全量主题在其前，同特异性下本文件规则胜出
import '../styles/win-theme.css';

import { savePastedImage } from '../api/imageApi';
import { openUrl } from '../api/fileApi';
import type { EditorMode, ThemeKind } from '../api/types';
import type { OutlineItem } from '../stores/editorStore';
import { setCurrentDocDir, setupMdRenderer } from './mdRendererConfig';
import { setCmFind } from './findHighlight';

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
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save', v: string): void;
  (e: 'outline', items: OutlineItem[]): void;
  (e: 'htmlChanged', html: string): void;
  (e: 'cursor', pos: { line: number; col: number }): void;
  (e: 'toast', text: string): void;
}>();

const rootRef = ref<HTMLElement | null>(null);
const editorRef = ref<InstanceType<typeof MdEditor> | null>(null);

// md-editor 的 class prop 只接受 string；编辑器外壳保持铺满（版式不再缩外壳）
const editorClass = computed(() => 'engine-editor');

/**
 * v7 的 preview prop 只作为挂载初值写入内部 store（挂载后无 props 同步），
 * 运行时切换预览必须走实例 API togglePreview()（内部经 updateSetting 生效）。
 */
type EditorInstanceApi = {
  togglePreview?: (v: boolean) => void;
};

watch(
  () => props.mode,
  (m) => {
    // read 态 MdEditor 未挂载：重挂载时会以 :preview 计算值作为正确初值，无需处理
    if (m === 'read') return;
    const inst = editorRef.value as unknown as EditorInstanceApi | null;
    inst?.togglePreview?.(m === 'split');
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
    emit('toast', '请先保存文档（Ctrl+S），再粘贴/插入图片');
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
      emit('toast', `图片保存失败：${err instanceof Error ? err.message : String(err)}`);
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
    throw new Error('导出预览体未就绪（export-pdf-preview 缺失）');
  }
  window.print();
}

// ---- 光标跟踪（状态栏 L:C）：监听原生 selectionchange，经 rAF 节流后从 CM6 state 读取 ----
interface CmViewLike {
  state: {
    selection: { main: { head: number } };
    doc: { lineAt(pos: number): { number: number; from: number } };
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
    if (isTauri) {
      openUrl(href).catch(() => emit('toast', `浏览器打开失败：${href}`));
    } else {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
    return;
  }
  // 相对路径（.md 等）与其他协议：一律禁止，防止整窗被导航
  e.preventDefault();
  emit('toast', `应用内不跳转该链接：${href}`);
}

// ---- 预览 HTML 渲染完成：上抛 + 查找高亮重涂（重渲染会重建 DOM，mark 丢失） ----
function onHtmlChanged(html: string): void {
  emit('htmlChanged', html);
  if (lastFind) {
    void nextTick(() => applyPreviewMarks(lastFind!.keyword, lastFind!.caseSensitive));
  }
}

onMounted(() => {
  setupMdRenderer();
  rootRef.value?.addEventListener('error', onImgError, true);
  // 链接拦截：捕获阶段先于 md-editor 内部与浏览器默认行为
  rootRef.value?.addEventListener('click', onAnchorClick, true);
  // 光标跟踪：CM6 光标移动会触发原生 selectionchange，rAF 节流后读取 CM state
  document.addEventListener('selectionchange', onSelectionChange);
});
onBeforeUnmount(() => {
  rootRef.value?.removeEventListener('error', onImgError, true);
  rootRef.value?.removeEventListener('click', onAnchorClick, true);
  document.removeEventListener('selectionchange', onSelectionChange);
  if (cursorRaf) {
    cancelAnimationFrame(cursorRaf);
    cursorRaf = 0;
  }
});
</script>

<template>
  <div ref="rootRef" class="engine-root" :class="mode !== 'split' ? `layout--${readLayout ?? 'medium'}` : ''">
    <!-- 阅读态：独立滚动容器 + 居中阅读栏，内容可正常滚动；key 绑定 docPath，切文档时重建以套用新目录 -->
    <div v-if="mode === 'read'" class="read-scroll">
      <div class="read-column" :class="`read-column--${readLayout ?? 'medium'}`">
        <MdPreview
          :id="`${editorId}-pv`"
          :key="docPath ?? 'draft'"
          :model-value="modelValue"
          :theme="theme"
          :preview-theme="previewTheme"
          @on-html-changed="onHtmlChanged"
        />
      </div>
    </div>
    <!-- 编辑/分栏态：同一实例，preview 属性响应式切换（不再强制重建，避免重挂载崩溃） -->
    <MdEditor
      v-else
      :id="editorId"
      ref="editorRef"
      :model-value="modelValue"
      :theme="theme"
      :preview-theme="previewTheme"
      :preview="mode === 'split'"
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
          :model-value="exportContent"
          theme="light"
          :preview-theme="previewTheme"
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
  /* md-editor 根容器默认带 1px 边框（--md-border-color），与应用 chrome 的
     分隔线（标签栏底线/侧栏缘线/状态栏顶线）叠加成双线框。
     用面板色边框代替删除：保持默认盒模型不变（直接 none 会因几何变化在
     四边交界露出亚像素缝隙），且四邻全是 --mk-panel 面板（标签栏/文件树/
     状态栏/大纲），1px 边框融入背景——功能栏背景与树边线无缝接拢 */
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
  /* 行距对齐 win 预览主题（.win-theme line-height 1.75），编辑/预览密度一致 */
  line-height: 1.75;
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
/* ---- 功能栏视觉对齐：底色/边线对齐应用 chrome，图标色与 hover 语言同顶栏 ----
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
