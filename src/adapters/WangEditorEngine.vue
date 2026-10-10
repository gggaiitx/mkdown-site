<script setup lang="ts">
/**
 * ★ wangEditor 富文本引擎（.mh 原生 HTML 读写，零转换，DEV §6）。
 *
 * - 仅本文件 import @wangeditor/*（适配层边界，ARCHITECTURE §13）；
 *   组件本身经 adapters/index.ts 的 defineAsyncComponent 懒加载（D4，独立 chunk）。
 * - 双形态（2026-10-10 修订）：edit=可编辑 / read=只读渲染（分栏形态已移除——富文本
 *   所见即所得，左编辑右只读镜像无信息增量，且工具条弹层在窄容器下会脱离文档流遮挡正文）。
 * - 工具条紧凑化：剔除 fontSize/fontFamily/lineHeight 三个宽下拉（溢出换行主因）与
 *   fullScreen（wangEditor 内置全屏会脱离布局流，遮功能栏、破坏目录区边线——F11 页面
 *   全屏由应用层接管）、group-video；并整体压缩菜单项密度，保证单行放下。
 * - 查找高亮（2026-10-10 修订）：CSS Custom Highlight API（CSS.highlights + ::highlight()），
 *   Range 高亮不触碰 Slate 托管 DOM（原 R6 no-op 方案废弃——WebView 原生 Ctrl+F 无计数/定位能力），
 *   编辑/阅读两态通用；当前命中单独注册 mk-find-cur 强化色。
 */
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Editor, Toolbar } from '@wangeditor/editor-for-vue';
import { i18nChangeLanguage } from '@wangeditor/editor';
import type { IDomEditor, IEditorConfig, IToolbarConfig } from '@wangeditor/editor';
import { convertFileSrc } from '@tauri-apps/api/core';

import '@wangeditor/editor/dist/css/style.css';
import { savePastedImage } from '../api/imageApi';
import type { EditorMode, ThemeKind } from '../api/types';
import type { OutlineItem } from '../stores/editorStore';
import { useI18n } from '../i18n';

const props = defineProps<{
  /** .mh 原始 HTML（磁盘口径：相对路径）；未保存新建为空串 */
  modelValue: string;
  mode: EditorMode;
  theme: ThemeKind;
  /** 文档路径（null = 未保存新建）：图片落盘目录与 asset 还原基准 */
  docPath: string | null;
  language: string;
  /** 内容版式三档宽度（阅读态生效，同 md 内核 readLayout 口径） */
  readLayout?: 'narrow' | 'medium' | 'wide';
  /** 显示功能栏（同 md 内核 showToolbar；关闭时整行隐藏，F11 全屏仍可用） */
  showToolbar?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
  (e: 'outline', items: OutlineItem[]): void;
  (e: 'toast', msg: string): void;
  /** http(s) 超链接：交由应用开 Web 标签（webview 内嵌浏览） */
  (e: 'openLink', href: string): void;
}>();

const { t } = useI18n();

const editorRef = shallowRef<IDomEditor | null>(null);
/** 语言切换需重建编辑器（i18nChangeLanguage 仅在创建前生效） */
const mountKey = ref(0);
/** 导出宿主（打印时临时挂载） */
const exportHostVisible = ref(false);
const exportEditorRef = shallowRef<IDomEditor | null>(null);

/** 编辑器内容（v-model 口径，已是 wangEditor 归一化 HTML） */
const valueHtml = ref(props.modelValue || '<p><br></p>');
/** 最近一次由本组件 emit 的内容：外部 watch 回写时跳过，防止光标跳回文档头 */
let lastEmitted = valueHtml.value;

// ---------- 相对路径 ↔ asset:// ----------

function docDir(): string {
  return props.docPath ? props.docPath.replace(/[\\/][^\\/]*$/, '') : '';
}

/** ./assets/x.png → asset://（显示口径；无 docPath 时原样返回） */
function relToAsset(rel: string): string {
  const raw = (rel ?? '').trim();
  const dir = docDir();
  if (!dir || /^(https?|data|asset|blob):/i.test(raw) || raw.startsWith('/')) return raw;
  const path = raw.replace(/^\.\//, '');
  if (!path) return raw;
  return convertFileSrc(`${dir}\\${path.replaceAll('/', '\\')}`);
}

/** 磁盘 HTML（相对路径）→ 编辑器显示 HTML（asset://） */
function htmlToDisplay(html: string): string {
  return html.replace(/(src|href)=(["'])(\.\/[^"']+)\2/g, (_m, attr, q, rel) =>
    `${attr}=${q}${relToAsset(rel)}${q}`);
}

/** asset://（本目录内）→ 磁盘 HTML（相对路径），随 assets 目录分发（同 Workbench.deAssetify 口径） */
function htmlToDisk(html: string): string {
  const dir = docDir();
  if (!dir) return html;
  return html.replace(/https?:\/\/asset\.localhost\/([^"'\s)>]+)/g, (_m, enc) => {
    try {
      const abs = decodeURIComponent(enc).replace(/\//g, '\\');
      if (abs.toLowerCase().startsWith(dir.toLowerCase())) {
        return `./${abs.slice(dir.length + 1).replaceAll('\\', '/')}`;
      }
      return abs.replaceAll('\\', '/');
    } catch {
      return enc;
    }
  });
}

// ---------- 大纲（HTML h1-h6，DEV §10） ----------

function outlineFromHtml(html: string): OutlineItem[] {
  if (!html) return [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items: OutlineItem[] = [];
    doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
      const text = (el.textContent ?? '').trim();
      if (!text) return;
      items.push({
        index: items.length,
        text,
        level: Number(el.tagName.slice(1)),
        line: items.length + 1,
      });
    });
    return items;
  } catch {
    return [];
  }
}

let outlineTimer: ReturnType<typeof setTimeout> | null = null;
function emitOutlineSoon(): void {
  if (outlineTimer) clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    outlineTimer = null;
    emit('outline', outlineFromHtml(editorRef.value?.getHtml() ?? ''));
  }, 300);
}

// ---------- 图片落盘（FR-04：复用 savePastedImage + ./assets/ 约定） ----------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('read file failed'));
    reader.readAsDataURL(file);
  });
}

async function customUpload(file: File, insertFn: (url: string, alt: string, href: string) => void): Promise<void> {
  if (!props.docPath) {
    emit('toast', t('engine.saveImgFirst', { mod: 'Ctrl' }));
    return;
  }
  try {
    const ext = (file.name.split('.').pop() ?? 'png').toLowerCase();
    const base64 = await fileToBase64(file);
    const saved = await savePastedImage(props.docPath, base64, ext);
    insertFn(relToAsset(saved.relPath), file.name, relToAsset(saved.relPath));
  } catch (err) {
    emit('toast', t('engine.imgSaveFail', { msg: err instanceof Error ? err.message : String(err) }));
  }
}

const editorConfig: Partial<IEditorConfig> = {
  placeholder: '',
  MENU_CONF: {
    uploadImage: { customUpload },
  },
};
/** 紧凑工具条（2026-10-10）：剔除宽下拉与破坏布局的内置全屏/视频组 */
const toolbarConfig: Partial<IToolbarConfig> = {
  excludeKeys: [
    'fontSize',
    'fontFamily',
    'lineHeight',
    'fullScreen',
    'group-video',
    'group-more-style',
  ],
};

// ---------- 模式 / 主题 / 语言 ----------

function applyMode(editor: IDomEditor | null, m: EditorMode): void {
  if (!editor) return;
  if (m === 'read') editor.disable();
  else editor.enable();
}

watch(() => props.mode, (m) => applyMode(editorRef.value, m));
watch(() => props.theme, () => undefined); // 主题走根 class 响应式，无需实例操作

watch(
  () => props.language,
  () => {
    i18nChangeLanguage(props.language === 'en-US' ? 'en' : 'zh-CN');
    mountKey.value += 1; // 重建实例以应用新语言
  },
);

// 外部内容替换（切文件/会话恢复）：仅在与当前内容不同时回写
watch(
  () => props.modelValue,
  (v) => {
    const disk = v || '<p><br></p>';
    if (disk === lastEmitted) return;
    valueHtml.value = disk;
    lastEmitted = disk;
    editorRef.value?.setHtml(htmlToDisplay(disk));
  },
);

function onChange(): void {
  const html = editorRef.value?.getHtml() ?? '';
  valueHtml.value = html;
  lastEmitted = html;
  emit('update:modelValue', htmlToDisk(html));
  emitOutlineSoon();
  // 查找态存活时随内容编辑刷新高亮 Range（Slate 渲染会复用/重建文本节点，旧 Range 失效）
  if (findState) refreshHighlight();
}

function onCreated(editor: IDomEditor): void {
  editorRef.value = editor;
  applyMode(editor, props.mode);
  editor.setHtml(htmlToDisplay(props.modelValue || '<p><br></p>'));
  emitOutlineSoon();
}

function onExportCreated(editor: IDomEditor): void {
  exportEditorRef.value = editor;
  editor.setHtml(valueHtml.value);
}

// ---------- 页面内全屏（F11，对齐 md 内核 pageFullscreen：编辑区铺满视口） ----------

const isPageFull = ref(false);
function togglePageFullscreen(): void {
  isPageFull.value = !isPageFull.value;
}

// ---------- Ctrl+S（wangEditor 无内置保存，容器层捕获） ----------

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    emit('save');
  }
}

/** 链接点击拦截（仅阅读态；编辑态由 wangEditor 自身链接 UI 管理）。
 *  阅读态编辑器 disable 后 <a> 点击默认会导航整个 WebView——必须 capture 拦下分流 */
function onClickCapture(e: MouseEvent): void {
  if (props.mode === 'edit') return;
  const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute('href') ?? '';
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (!href || href.startsWith('javascript:')) {
    stop();
    return;
  }
  if (href.startsWith('#')) {
    // 文内锚点：滚动到对应元素（不改动 location，避免 WebView 导航）
    stop();
    const container = editorRef.value?.getEditableContainer();
    const el = container?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`);
    const scroll = container?.querySelector('.w-e-scroll');
    if (el && scroll) {
      (scroll as HTMLElement).scrollTo({ top: (el as HTMLElement).offsetTop - 16, behavior: 'smooth' });
    }
    return;
  }
  if (/^https?:\/\//i.test(href)) {
    stop();
    emit('openLink', href);
    return;
  }
  // 相对路径与其他协议：禁止导航（防整窗跳走）
  stop();
  emit('toast', t('engine.noJumpLink', { href }));
}

// ---------- CommonEngineHandle ----------

/** mh 无行语义：headingIndex>=0 按标题序号滚动（大纲跳转）；否则忽略 */
function scrollToLine(_line: number, headingIndex?: number): void {
  const editor = editorRef.value;
  if (!editor || headingIndex == null || headingIndex < 0) return;
  const container = editor.getEditableContainer();
  if (!container) return;
  // 大纲 index 口径 = 非空标题序号（同 extractHtmlOutline：空标题 <h2><br></h2> 不计入），
  // 这里必须同样过滤，否则文档含空标题时 index 错位跳错节
  const headings = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(
    (el) => (el.textContent ?? '').trim(),
  );
  const target = headings[headingIndex];
  if (!target) return;
  // ★ wangEditor DOM：.w-e-scroll 是 .w-e-text-container 的【子】元素（不是祖先），
  //   滚动根必须向下找；closest 向上找会落空回退到不滚动的宿主（滚动失效根因）
  const scrollRoot =
    (container as HTMLElement).querySelector('.w-e-scroll') ??
    (container.closest('.w-e-scroll') ?? container.parentElement);
  if (!scrollRoot) return;
  // 手动按 offsetTop 平滑滚动（scrollIntoView 会连带滚动所有可滚动祖先，禁用）；
  // offsetParent = .w-e-text-container（position:relative），其顶边即滚动内容顶边。
  // 平滑滚动对齐 md 内核大纲跳转（scrollIntoView behavior:'smooth' 口径）
  (scrollRoot as HTMLElement).scrollTo({
    top: (target as HTMLElement).offsetTop - 16,
    behavior: 'smooth',
  });
}

function insert(text: string): void {
  const editor = editorRef.value;
  if (!editor) return;
  editor.insertNode({ text });
  editor.focus(true);
}

// ---------- 查找高亮（CSS Custom Highlight API，不触碰 Slate 托管 DOM） ----------

/** 高亮注册名：全部命中 / 当前命中 */
const HL_ALL = 'mk-find';
const HL_CUR = 'mk-find-cur';
/** 与 FindBar 同量级的命中上限兜底 */
const FIND_LIMIT = 2000;

/** Highlight API 兼容类型（lib.dom 未覆盖时的运行时兜底，缺失则静默不高亮） */
type HighlightLike = { add: (r: Range) => void };
const HLCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => HighlightLike }).Highlight;
const hlRegistry = (): Map<string, HighlightLike> | null =>
  (CSS as unknown as { highlights?: Map<string, HighlightLike> }).highlights ?? null;

interface FindState {
  kw: string;
  cs: boolean;
  ranges: Range[];
}
let findState: FindState | null = null;
/** 当前命中序号（scrollToMatch 维护，-1 = 未指定） */
let findCurIndex = -1;

/** 编辑器内容根（wangEditor 挂 data-slate-editor 的元素；兜底取 text-container） */
function editableRoot(): HTMLElement | null {
  const container = editorRef.value?.getEditableContainer();
  const inner = container?.querySelector('[data-slate-editor]') as HTMLElement | null;
  return inner ?? (container as HTMLElement | null);
}

/** 查找滚动根：与 scrollToLine 同口径（.w-e-scroll 是 container 的【子】元素，向下找） */
function findScrollRoot(): HTMLElement | null {
  const container = editorRef.value?.getEditableContainer();
  const down = container?.querySelector('.w-e-scroll') as HTMLElement | null;
  const up = container?.closest('.w-e-scroll') as HTMLElement | null;
  return down ?? up ?? container?.parentElement ?? null;
}

/** TreeWalker 收集文本节点 → 拼接全文本做 indexOf 匹配 → 反算每处命中的 Range（支持跨节点） */
function collectRanges(root: HTMLElement, kw: string, cs: boolean): Range[] {
  const needle = cs ? kw : kw.toLowerCase();
  const out: Range[] = [];
  if (!needle) return out;
  const parts: { node: Text; text: string; start: number }[] = [];
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const v = n.nodeValue ?? '';
    if (!v) continue;
    if (n.parentElement?.closest('script,style')) continue;
    parts.push({ node: n, text: v, start: total });
    total += v.length;
  }
  const hay = (cs ? parts.map((p) => p.text).join('') : parts.map((p) => p.text).join('').toLowerCase());
  let from = 0;
  while (out.length < FIND_LIMIT) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    // 起点所在文本节点：第一个覆盖 at 的分段；终点：第一个覆盖 end 的分段
    const si = parts.findIndex((p) => at < p.start + p.text.length);
    const ei = parts.findIndex((p) => end <= p.start + p.text.length);
    if (si < 0 || ei < 0) break;
    const r = document.createRange();
    r.setStart(parts[si].node, at - parts[si].start);
    r.setEnd(parts[ei].node, end - parts[ei].start);
    out.push(r);
    from = at + Math.max(1, needle.length); // 空串防御：强制推进
  }
  return out;
}

/** 重算 Range 并重注册高亮（关键词变化与内容编辑 onChange 共用） */
function refreshHighlight(): void {
  const reg = hlRegistry();
  if (!findState || !reg || !HLCtor) return;
  const root = editableRoot();
  if (!root) return;
  findState.ranges = collectRanges(root, findState.kw, findState.cs);
  reg.set(HL_ALL, new HLCtor(...findState.ranges));
  if (findCurIndex >= findState.ranges.length) findCurIndex = findState.ranges.length - 1;
  if (findCurIndex >= 0 && findState.ranges[findCurIndex]) {
    reg.set(HL_CUR, new HLCtor(findState.ranges[findCurIndex]));
  } else {
    reg.delete(HL_CUR);
  }
}

function highlight(keyword: string, caseSensitive?: boolean): void {
  const kw = keyword ?? '';
  if (!kw) {
    clearHighlight();
    return;
  }
  const reg = hlRegistry();
  if (!reg || !HLCtor) return;
  if (!findState || findState.kw !== kw || findState.cs !== !!caseSensitive) {
    findState = { kw, cs: !!caseSensitive, ranges: [] };
    findCurIndex = -1;
  }
  refreshHighlight();
}

function clearHighlight(): void {
  findState = null;
  findCurIndex = -1;
  const reg = hlRegistry();
  if (!reg) return;
  reg.delete(HL_ALL);
  reg.delete(HL_CUR);
}

/** 滚动到第 index 个命中并标记为当前命中（FindBar mh 路由调用） */
function scrollToMatch(index: number): void {
  if (!findState || findState.ranges.length === 0) return;
  const i = Math.min(Math.max(index, 0), findState.ranges.length - 1);
  findCurIndex = i;
  const reg = hlRegistry();
  if (reg && HLCtor) reg.set(HL_CUR, new HLCtor(findState.ranges[i]));
  const scrollRoot = findScrollRoot();
  if (!scrollRoot) return;
  const rect = findState.ranges[i].getBoundingClientRect();
  const sr = scrollRoot.getBoundingClientRect();
  if (sr.height <= 0) return;
  scrollRoot.scrollTo({
    top: scrollRoot.scrollTop + (rect.top - sr.top) - sr.height / 2 + rect.height / 2,
    behavior: 'smooth',
  });
}

// ---------- PDF 导出（复用全局 @media print 规则，打印宿主 = #export-pdf-preview） ----------

async function exportPdf(): Promise<void> {
  exportHostVisible.value = true;
  await nextTick();
  // 等 wangEditor 挂载 + setHtml 渲染
  await new Promise((r) => setTimeout(r, 400));
  if (!document.getElementById('export-pdf-preview')) {
    exportHostVisible.value = false;
    throw new Error(t('engine.exportPreviewMissing'));
  }
  window.print();
  exportHostVisible.value = false;
}

defineExpose({
  scrollToLine,
  scrollToMatch,
  insert,
  highlight,
  clearHighlight,
  exportPdf,
  togglePageFullscreen,
  getSaveContent: () => htmlToDisk(editorRef.value?.getHtml() ?? valueHtml.value),
  getViewHtml: () => editorRef.value?.getHtml() ?? valueHtml.value,
});

onBeforeUnmount(() => {
  if (outlineTimer) clearTimeout(outlineTimer);
  clearHighlight(); // 清 CSS.highlights 注册，防泄漏到后续标签
  editorRef.value?.destroy();
  editorRef.value = null;
  exportEditorRef.value?.destroy();
  exportEditorRef.value = null;
});
</script>

<template>
  <div
    class="wang-engine-root"
    :class="[`mode-${props.mode}`, { dark: props.theme === 'dark', 'page-full': isPageFull }, `layout--${props.readLayout ?? 'medium'}`]"
    @keydown.capture="onKeydown"
    @click.capture="onClickCapture"
  >
    <div class="wang-edit-pane">
      <div v-if="props.showToolbar !== false" class="wang-toolbar-row">
        <Toolbar
          :key="`tb-${mountKey}`"
          class="wang-toolbar"
          :editor="editorRef ?? undefined"
          :default-config="toolbarConfig"
          mode="default"
        />
        <!-- 全屏按钮（对齐 md pageFullscreen：编辑/阅读两态可用，F11 同一状态） -->
        <button
          type="button"
          class="wang-fs-btn"
          :title="isPageFull ? t('engine.exitPageFullscreen') : t('engine.pageFullscreen')"
          :aria-label="isPageFull ? t('engine.exitPageFullscreen') : t('engine.pageFullscreen')"
          @click="togglePageFullscreen"
        >
          <svg v-if="!isPageFull" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M1 5.5V1h4.5M11 1h4v4.5M15 10.5V15h-4.5M5 15H1v-4.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M5.5 1v4.5H1M10.5 1v4.5H15M15 10.5h-4.5V15M1 10.5h4.5V15"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
      <Editor
        :key="`ed-${mountKey}`"
        class="wang-editor"
        v-model="valueHtml"
        :default-config="editorConfig"
        mode="default"
        @on-created="onCreated"
        @on-change="onChange"
      />
    </div>

    <!-- 导出/打印宿主：屏幕上隐藏，打印时由文件末尾全局 @media print 规则单独显示（机制同 MdEditorV3Engine） -->
    <Teleport to="body">
      <div class="mk-export-host" aria-hidden="true">
        <div v-if="exportHostVisible" id="export-pdf-preview" class="wang-export-body">
          <Editor
            :default-config="{ readOnly: true }"
            mode="default"
            @on-created="onExportCreated"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.wang-engine-root {
  display: flex;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--mk-bg);
}
.wang-edit-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--mk-panel);
}
/* 阅读态隐藏工具条（只读渲染；右侧全屏按钮保留可用）。
   页面全屏态强制显示功能区（对齐 md pageFullscreen：全屏下始终有工具条，含阅读态） */
.mode-read .wang-toolbar {
  display: none;
}
.wang-engine-root.page-full .wang-toolbar {
  display: flex !important;
}
/* ---- 内容版式三档宽度（对齐 md 内核 readLayout：680/940/1240）----
   md 口径：layout 类编辑/阅读两态都生效（mode !== 'split'），正文列限宽 = content-w。
   用对称 padding 产生两侧留白居中（比 margin auto 可靠，同 md .cm-content 手法） */
.wang-engine-root.layout--narrow {
  --mk-content-w: 680px;
}
.wang-engine-root.layout--medium {
  --mk-content-w: 940px;
}
.wang-engine-root.layout--wide {
  --mk-content-w: 1240px;
}
/* 阅读态去表格容器的编辑器虚线框（编辑辅助视觉，阅读不需要） */
.mode-read :deep(.w-e-text-container [data-slate-editor] .table-container) {
  border: none;
  padding: 0;
}
.wang-editor {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
/* 页面内全屏（F11）：铺满视口，盖住侧栏/标签栏/状态栏（同 md 内核 pageFullscreen 观感）。
   ★ z-index 必须压过应用顶栏（.toolbar z-index:9500，否则顶栏盖在全屏层上，
   顶部 40px 功能区被遮——实测根因），低于对话框（30010） */
.wang-engine-root.page-full {
  position: fixed;
  inset: 0;
  z-index: 9600;
  height: 100vh;
  width: 100vw;
}
/* 全屏态工具条钉在顶部（防止任何滚动/裁剪场景下功能区消失） */
.wang-engine-root.page-full .wang-edit-pane {
  border: none;
}
.wang-engine-root.page-full :deep(.w-e-toolbar) {
  position: relative;
  z-index: 2;
  flex-shrink: 0;
}

/* ---- 工具条：单行不换行；项高 32px（飞总指定，比 md 内核 35px 更紧凑）----
   弹层锚点必须与项高同步改：内核 tooltip :before top:40 / :after top:30 /
   下拉·弹层·分组菜单 margin-top:40 全部锚定默认项高 40px，这里统一压到 32px，
   保证 tooltip 与下拉紧贴工具条。严禁 overflow:hidden（裁 tooltip/弹层） ---- */
.wang-engine-root :deep(.w-e-toolbar) {
  background: var(--mk-panel);
  border-bottom: none;
  padding: 0 4px;
  min-height: 32px;
  flex: 1;
  min-width: 0;
  flex-wrap: nowrap;
}
/* 工具条行：内核工具条 + 右侧全屏按钮；下边线统一画在行上 */
.wang-toolbar-row {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  background: var(--mk-panel);
  border-bottom: 1px solid var(--mk-border);
}
.wang-fs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 26px;
  /* 钉在行最右侧：编辑态顶开内核工具条之后的余量，阅读态（工具条隐藏）也保持靠右 */
  margin-left: auto;
  margin-right: 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--mk-fg-muted);
  cursor: pointer;
  flex-shrink: 0;
}
.wang-fs-btn:hover {
  background: var(--mk-hover);
  color: var(--mk-fg);
}
.wang-engine-root :deep(.w-e-bar-item) {
  height: 32px;
  padding: 3px 4px;
}
.wang-engine-root :deep(.w-e-bar-item button) {
  height: 26px;
  padding: 0 6px;
  border-radius: 3px;
}
.wang-engine-root :deep(.w-e-bar-divider) {
  height: 32px;
}
/* 弹层锚点与 32px 项高对齐（内核默认 40px） */
.wang-engine-root :deep(.w-e-menu-tooltip-v5:before) {
  top: 32px;
}
.wang-engine-root :deep(.w-e-menu-tooltip-v5:after) {
  top: 22px;
}
.wang-engine-root :deep(.w-e-bar-item-group .w-e-bar-item-menus-container),
.wang-engine-root :deep(.w-e-select-list),
.wang-engine-root :deep(.w-e-drop-panel) {
  margin-top: 32px;
}

/* 正文字号跟随全局设置（settingsStore 注入 --mk-font-size） */
.wang-engine-root :deep(.w-e-text-container) {
  background: var(--mk-bg);
  color: var(--mk-fg, #24292f);
}
.wang-engine-root :deep(.w-e-text-container [data-slate-editor]) {
  font-size: var(--mk-font-size, 15px);
  line-height: 1.7;
  padding-block: 12px;
  /* 正文列限宽：左右 padding = (容器宽 - 版式宽)/2，窄窗回落 20px（同 md 编辑态） */
  padding-inline: max(calc((100% - var(--mk-content-w, 940px)) / 2), 20px);
}

/* ---- 暗色覆盖（R3，2026-10-10 二轮重构）----
   wangEditor 的工具条/正文/引用块/内联代码块/表格表头/弹层颜色全部消费
   --w-e-* CSS 变量（默认 #fff/#f5f2f0 亮色系）。逐条覆盖选择器易漏（引用块
   背景、表格内 code 等都是漏网项），这里在根节点整体覆写变量，一次治本。 */
.wang-engine-root.dark {
  --w-e-toolbar-bg-color: var(--mk-panel, #161b22);
  --w-e-toolbar-color: #c9d1d9;
  --w-e-toolbar-active-color: #e6edf3; /* tooltip 底色（dark 下取亮字色） */
  --w-e-toolbar-active-bg-color: rgba(255, 255, 255, 0.08);
  --w-e-toolbar-disabled-color: #6e7681;
  --w-e-toolbar-border-color: #30363d;
  --w-e-textarea-bg-color: var(--mk-bg, #0d1117);
  --w-e-textarea-color: #c9d1d9;
  --w-e-textarea-border-color: #30363d;
  --w-e-textarea-slight-border-color: #30363d;
  --w-e-textarea-slight-color: #8b949e;
  /* 引用块 / 内联代码 / 表头 共用的“浅背景”→ 半透明灰（半透明保证叠深底不突兀） */
  --w-e-textarea-slight-bg-color: rgba(110, 118, 129, 0.22);
  --w-e-textarea-selected-border-color: #58a6ff; /* 引用块左竖线 / 选中描边 */
  --w-e-textarea-handler-bg-color: #4290f7;
  --w-e-modal-button-bg-color: #21262d;
  --w-e-modal-button-border-color: #30363d;
}
/* 变量覆盖不到的补充项 */
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] a) {
  color: #58a6ff;
}
/* 内联 code：显式深底亮字（不依赖 slight-bg 变量继承链） */
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] code) {
  background-color: rgba(110, 118, 129, 0.35);
  color: #e6edf3;
}
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] h1),
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] h2),
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] h3),
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] h4),
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] h5),
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] h6) {
  color: var(--mk-fg, #e6edf3);
}
/* 代码块（prism 亮色 token + 白色 text-shadow 在暗底下刺眼） */
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] pre > code) {
  color: #e6edf3;
  text-shadow: none;
  background-color: rgba(110, 118, 129, 0.2);
}
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] code) {
  color: #e6edf3;
}
/* 表格内 todo 复选框/输入控件死白 */
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] input) {
  background: var(--mk-bg, #0d1117);
  color: #c9d1d9;
  border-color: #30363d;
  accent-color: #58a6ff;
}
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] input[type='checkbox']) {
  background: transparent;
}
/* 复制来源带内联样式的 span（从亮色页面粘来的死白底/暗字，暗色下不可读）。
   wangEditor 会把内联 code 的底色写成 span 的 inline style（rgb(240,241,242)），
   属性子串匹配 [style*='background'] 理论够用，这里放宽到所有带 style 的 span，
   只要含内联背景一律 neutralize——暗色下不存在合法的亮色内联底 */
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] span[style]) {
  background-color: transparent !important;
}
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] span[style*='color']) {
  color: inherit !important;
}
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] code) {
  background-color: rgba(110, 118, 129, 0.35) !important;
}
/* 表格文字显式亮色（不依赖继承链） */
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] th),
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] td) {
  color: #c9d1d9;
}
/* 滚动条不做任何覆盖：全局 ::-webkit-scrollbar 自绘规则（10px 常驻圆角滑块）已适用。
   ★ 切勿用 scrollbar-color/scrollbar-width 标准属性——WebView2 命中标准属性会切到
   Fluent 悬浮滚动条路径（细条自动隐藏、样式不可控），与全局滚动条不一致（2026-10-10） */
.wang-engine-root.dark :deep(.w-e-text-container [data-slate-editor] img) {
  max-width: 100%;
}

/* ---- 导出/打印宿主（@media print 全局规则移植自 MdEditorV3Engine，机制同官方 ExportPDF.css） ---- */
.wang-export-body {
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: var(--mk-font-size, 15px);
  line-height: 1.7;
  color: #24292f;
  background: #fff;
  padding: 24px 32px;
}
.wang-export-body :deep(.w-e-text-container) {
  background: #fff !important;
  color: #24292f !important;
}
</style>

<style>
/* 非 scoped：打印规则全局生效（与 MdEditorV3Engine 的全局规则等价，双保险防其被卸载） */
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
  .wang-export-body {
    height: auto !important;
    overflow: visible !important;
  }
}
</style>
