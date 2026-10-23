<script setup lang="ts">
/**
 * 主工作台：三栏布局 + 保存流水线 + 快捷键 + 导出/打印。
 * 只依赖 adapters 契约与 stores，不直接 import md-editor-v3。
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, CheckCircle2, Info } from '@lucide/vue';

import Toolbar from '../components/Toolbar.vue';
import TabBar from '../components/TabBar.vue';
import StatusBar from '../components/StatusBar.vue';
import OutlinePanel from '../components/OutlinePanel.vue';
import OutlineRail from '../components/OutlineRail.vue';
import FileTree from '../components/FileTree.vue';
import SearchHub from '../components/SearchHub.vue';
import SettingsDialog from '../components/SettingsDialog.vue';
import Welcome from '../components/Welcome.vue';
import AppDialog from '../components/AppDialog.vue';
import FolderPicker from '../components/FolderPicker.vue';
import FloatTip from '../components/FloatTip.vue';
import EditorCtxMenu from '../components/EditorCtxMenu.vue';
// docx-preview / xlsx 体积大（合计约 1.6MB 未压缩）且仅在点开对应文件时才渲染：
// 懒加载拆出首屏 chunk（P1-7），模板用法不变
const DocxPreview = defineAsyncComponent(() => import('../components/preview/DocxPreview.vue'));
const SheetPreview = defineAsyncComponent(() => import('../components/preview/SheetPreview.vue'));
const PdfPreview = defineAsyncComponent(() => import('../components/preview/PdfPreview.vue'));
/** Word 反转弹窗同样懒加载：它静态引用 docxToMd / docxPreviewToMh，连带把 mammoth 全家
 *  （mammoth+jszip+xmlbuilder+@xmldom+lop+dingbat ≈260KB min）拖进首屏，而弹窗点开才有用 */
const WordConvertDialog = defineAsyncComponent(() => import('../components/WordConvertDialog.vue'));
import ImagePreview from '../components/preview/ImagePreview.vue';
import HtmlFrame from '../components/preview/HtmlFrame.vue';
import SvgFrame from '../components/preview/SvgFrame.vue';
import { MdEditorV3Engine, CodeEditorEngine, WangEditorEngine, type EngineHandle } from '../adapters';
import { cancelScrollRestore } from '../adapters/scrollRestore';
import type { EditorCtxPayload } from '../adapters/IMarkdownEngine';
import { modHint } from '../utils/keyHint';
import { formatMarkdown } from '../utils/mdFormat';
import { formatXml } from '../utils/markup';
import { copyImageFile } from '../utils/clipboardImage';
import {
  hydrateSession,
  applyActiveTabMode,
  startSessionSnapshot,
  flushSessionSnapshot,
} from '../utils/sessionSnapshot';
import type { OutlineItem } from '../stores/editorStore';

import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { textKindOf, isPreviewKind, useTabsStore } from '../stores/tabsStore';
import type { TabKind } from '../stores/tabsStore';
import { extractHtmlOutline, useEditorStore } from '../stores/editorStore';
import { useSearchStore } from '../stores/searchStore';
import { useFilePickerStore } from '../stores/filePickerStore';
import { useExternalChangeGuard } from '../composables/useExternalChangeGuard';

import {
  getFileMeta,
  openInSystem,
  openUrl,
  openWebWindow,
  listSiblingFiles,
  probePreviewKind,
  probeTextFile,
  readFile,
  saveTextAt,
  takePendingOpenArgs,
  writeFileAtomic,
} from '../api/fileApi';
import { exportDocx, exportHtml, exportPdf, exportPng } from '../api/exportApi';
import { createWorkspaceDir, getDefaultWorkspaceParent } from '../api/workspaceApi';
import type { WordStyleOpts } from '../convert/htmlToDocx';
import { allowAssetDir } from '../api/imageApi';
import type { EditorMode, PreviewBarMode, ReadLayout, ThemeKind } from '../api/types';
import { DEFAULT_SETTINGS, FONT_MAX, FONT_MIN, FONT_STEP } from '../api/types';
import { fileKind, isCodeExt } from '../utils/fileKind';
import type { TableOp } from '../utils/mdTable';
import {
  BLOCK_EXAMPLE_KEYS, HEADING_EXAMPLE_KEY, HEADING_LEVELS, WRAP_ACTIONS,
  type FormatId, type HeadingId, type WrapActionId,
} from '../utils/mdActions';
import type { BlockFormatKind } from '../utils/mdLineFormat';
import { findMatchRanges, replaceAll, type ReplaceRequest } from '../utils/mdReplace';
import { TEMPLATES, type MdTemplate } from '../utils/markdownTemplate';
import { debounce } from '../utils/common';
import { isPathInside, isWinStylePath } from '../utils/pathJoin';
import { useI18n } from '../i18n';

const { t } = useI18n();
const settings = useSettingsStore();
const ws = useWorkspaceStore();
const tabs = useTabsStore();
const editor = useEditorStore();
const search = useSearchStore();
const filePicker = useFilePickerStore();

/** 外部修改检测（composable 内自带窗口聚焦 + 轮询触发）：脏标签撞车时弹对话框让用户裁决 */
const {
  conflict: externalConflict,
  resolveReload: onExternalReload,
  resolveKeep: onExternalKeep,
} = useExternalChangeGuard();

/** 三个引擎各自持 ref（引擎常驻挂载后并存，不能用同名 ref 互踩）；
 *  engineRef 由当前激活标签种类路由到对应实例 */
const codeEngineRef = ref<EngineHandle | null>(null);
const mdEngineRef = ref<EngineHandle | null>(null);
const wangEngineRef = ref<EngineHandle | null>(null);
/** 标签栏组件引用：F2 重命名当前文档经 TabBar.renameActive() 走同一对话框链路 */
const tabBarRef = ref<InstanceType<typeof TabBar> | null>(null);
/** SVG 预览框：右键「导出为图片」要问它当前这一档的画幅（尺寸真相源在框内） */
const svgFrameRef = ref<InstanceType<typeof SvgFrame> | null>(null);

/** 内容区刷新动效：标签右键「刷新」重读完成后短促淡入（先摘 class 再挂回以重启动画） */
const reloadFlash = ref(false);
function flashReloadArea() {
  reloadFlash.value = false;
  void nextTick(() => {
    reloadFlash.value = true;
    setTimeout(() => (reloadFlash.value = false), 480);
  });
}
/** 目录树组件引用：Shift+F 按名称过滤经 FileTree.openFilter() 打开并聚焦 */
const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
/** 标记文档所在目录（相对资源经 asset:// base 解析）。
 *  draftPath 升级（§6.5 V1）：未保存标签（path=null）用意向路径兜底——
 *  反转产物「转换后打开」的相对路径图片据此解析，不再破图 */
const activeDocPath = computed(() => tabs.activeTab?.path ?? tabs.activeTab?.draftPath ?? null);
const showSettings = ref(false);

/** 顶栏 GitHub 入口：用系统默认浏览器打开仓库 */
const GITHUB_URL = 'https://github.com/gggaiitx/mkdown-site';
function openGithub() {
  void openUrl(GITHUB_URL).catch(() => {
    /* open_url 失败（无默认浏览器等）静默忽略，仓库链接已可手动复制 */
  });
}

/** 顶栏「更新」入口：打开对应 Release 页（有更新时指向最新 Release，否则指向发布列表） */
const GITHUB_RELEASES = 'https://github.com/gggaiitx/mkdown-site/releases';
function openReleases(url: string) {
  void openUrl(url || GITHUB_RELEASES).catch(() => {
    /* 失败时静默忽略 */
  });
}
/** 统一搜索面板（SearchHub）模式：'file' 文件内查找 / 'global' 全局搜索 */
const hubMode = ref<'file' | 'global'>('file');
/** 左侧工作区显示/隐藏（隐藏后经顶栏「展开侧边栏」恢复）。
 *  出厂/升级后默认收起：启动恢复 lastWorkspace 时也保持隐藏，只有用户主动打开或切换工作区才展开 */
const sidebarVisible = ref(false);
/** 工作区侧栏唯一的开合口：工具栏按钮与 Ctrl+Tab 都走这里，别各写一份取反 */
function toggleSidebar(): void {
  sidebarVisible.value = !sidebarVisible.value;
}

/** 轻提示展示层：去重合并 + 分级停留 + 上限 3 条，避免连发刷屏 */
interface ToastItem {
  /** 稳定自增 id：仅作 :key。去重合并时保持不变——若用 seq 做 key，
   *  合并改写 seq 会改变 :key 使 TransitionGroup 销毁重建 DOM、重播进出场动画（P2-31） */
  id: number;
  /** 来源序号（editor.toast.seq）：仅用于 dismiss 查找与定时器归属 */
  seq: number;
  text: string;
  kind: 'info' | 'error' | 'success';
  count: number;
  timer: number;
}
let toastUid = 0;
const MAX_TOASTS = 3;
/** 错误要留时间读，成功一闪而过即可 */
const TOAST_MS: Record<string, number> = { error: 5000, info: 2600, success: 2000 };
const toasts = ref<ToastItem[]>([]);

function dismissToast(seq: number) {
  const hit = toasts.value.find((t) => t.seq === seq);
  if (hit) clearTimeout(hit.timer);
  toasts.value = toasts.value.filter((t) => t.seq !== seq);
}

watch(
  () => editor.toast.seq,
  () => {
    const { seq, text, kind } = editor.toast;
    // 同文案同类型连发：只累加计数并重置倒计时（Ctrl+S 连点、自动保存最常见）
    const dup = toasts.value.find((t) => t.text === text && t.kind === kind);
    if (dup) {
      clearTimeout(dup.timer);
      dup.count += 1;
      dup.seq = seq; // 仅更新 dismiss 查找用的 seq，:key（id）不动，不重播动画
      dup.timer = window.setTimeout(() => dismissToast(seq), TOAST_MS[kind] ?? 2600);
      return;
    }
    const item: ToastItem = { id: ++toastUid, seq, text, kind, count: 1, timer: 0 };
    item.timer = window.setTimeout(() => dismissToast(seq), TOAST_MS[kind] ?? 2600);
    toasts.value.push(item);
    // 超出上限丢最旧的一条
    while (toasts.value.length > MAX_TOASTS) {
      const drop = toasts.value.shift();
      if (drop) clearTimeout(drop.timer);
    }
  },
);

/** 关闭标签确认：tabId=单标签 / batchIds=批量 / 双 null=关窗口 */
const closeConfirm = ref<{ visible: boolean; tabId: string | null; batchIds: string[] | null }>({
  visible: false,
  tabId: null,
  batchIds: null,
});
const closeBatchDirtyCount = computed(
  () => (closeConfirm.value.batchIds ?? []).filter((id) => tabs.tabs.find((t) => t.id === id)?.isDirty).length,
);

// ---------- 内容同步 ----------
function onContentChange(v: string) {
  const tab = tabs.activeTab;
  if (!tab) return;
  tabs.markDirty(tab.id, v);
}

/** wangEditor 内容写回门控：引擎常驻（v-show），隐藏期间它承载的是上一份 mh 文档，
 *  此时冒出来的 change 不能写进当前激活标签（多半是 md/code）的内容里 */
function onMhContentChange(v: string) {
  if (!isMhTab.value) return;
  onContentChange(v);
}

/** md / 代码引擎同样常驻，门控口径与上面一致：只认「当前激活标签确实归我管」。
 *  隐藏期事件主要来自切档时的内容替换（引擎把新 doc 当成 change 上报），
 *  不拦住就会把 A 文档的正文写进 B 标签，或把只读预览标签写成脏标签。 */
function onMdContentChange(v: string) {
  if (!isMdTab.value) return;
  onContentChange(v);
}
function onCodeContentChange(v: string) {
  if (!usesCodeEngine.value) return;
  onContentChange(v);
}

/** Ctrl+Shift+F：美化当前文档。Markdown 走规则式美化，SVG 源码走 markup 格式化
 *  （标脏走统一写回链路，大纲/字数自动同步） */
function beautifyActive() {
  const tab = tabs.activeTab;
  if (!tab) {
    editor.showToast(t('workbench.toast.noDoc'), 'error');
    return;
  }
  if (tabs.activeIsPreview) {
    editor.showToast(t('workbench.toast.previewReadonlyBeautify'), 'info');
    return;
  }
  // SVG 源码走 markup 的保守格式化（重缩进 + 文本叶子收成一行；混合内容、
  // 未闭合标签整段原样，绝不替源码补结束标签）。
  // ★ 不给 .html：真实网页几乎全是「文本与子元素并存」的混合内容，保守规则
  //   改不动一个字节，用户点了只会收到「已是规范格式」，不如不给这个入口。
  if (tab.kind === 'svg') {
    const formatted = formatXml(tab.content);
    if (!formatted || formatted === tab.content) {
      editor.showToast(t('workbench.toast.alreadyFormatted'), 'info');
      return;
    }
    onContentChange(formatted);
    editor.showToast(t('workbench.toast.markupFormatted'), 'success');
    return;
  }
  // 其余代码文件与富文本不走 Markdown 规则美化，避免规则式改写破坏内容结构
  if (usesCodeEngine.value || isMhTab.value) {
    editor.showToast(t('workbench.toast.codeNoBeautify'), 'info');
    return;
  }
  const formatted = formatMarkdown(tab.content);
  if (formatted === tab.content) {
    editor.showToast(t('workbench.toast.alreadyFormatted'), 'info');
    return;
  }
  onContentChange(formatted);
  syncOutline(formatted);
  editor.showToast(t('workbench.toast.beautified'), 'success');
}

const syncOutline = debounce((v: string) => editor.syncFromContent(v), 120);
watch(
  () => tabs.activeTab?.content ?? '',
  (v) => {
    // 富文本（.mh）：大纲/字数走 HTML 口径（syncFromHtml），不走 Markdown 行解析
    if (tabs.activeTab?.kind === 'mh') editor.syncFromHtml(v);
    else syncOutline(v);
  },
  { immediate: true },
);

/** 大纲上报（仅 md 引擎绑定）：常驻后隐藏引擎也会因内容替换重发，非当前标签的一律丢弃 */
function onOutline(items: OutlineItem[]) {
  if (!isMdTab.value) return;
  editor.outline = items;
}

/** .mh 引擎的大纲上报（HTML 标题序）。三引擎常驻后切档不会重发，
 *  故下方还有一条按 activeId 的补发——两者都只认「当前标签是自己的引擎」 */
function onMhOutline(items: OutlineItem[]) {
  if (!isMhTab.value) return;
  editor.outline = items;
}
// 从 md 标签切回 .mh 标签时引擎不会重发大纲（created/change 才发），面板与全屏浮标
// 会留着上一篇 md 的目录：按当前 HTML 直接补算一次（index 口径与 extractHtmlOutline 同源，
// .mh 的跳转走 headingIndex，见 WangEditorEngine.scrollToLine）
watch(
  () => tabs.activeId,
  () => {
    if (!isMhTab.value) return;
    const html = wangEngineRef.value?.getDisplayHtml?.();
    if (html) editor.outline = extractHtmlOutline(html);
  },
);

/** 预览 HTML 上报（Word 导出真相源）：同上，只认当前 md 标签 */
function onMdHtmlChanged(html: string) {
  if (!isMdTab.value) return;
  editor.previewHtml = html;
}

/** 引擎内 Ctrl+S：隐藏实例理论上收不到按键，门控只是把「谁都能触发保存」这条路堵死 */
function onMdSave() {
  if (isMdTab.value) void saveActive();
}
function onCodeSave() {
  if (usesCodeEngine.value) void saveActive();
}
function onMhSave() {
  if (isMhTab.value) void saveActive();
}

/** 引擎光标上报（md / code 引擎共用）：写状态栏行列。
 *  ★ 参数显式标注：MdEditorV3Engine 的 emits 类型字面量成员增多后，
 *    vue-tsc 对该组件模板绑定丢失上下文推断（解构参数变隐式 any），此处自带类型即不受影响 */
function onEngineCursor({ line, col }: { line: number; col: number }) {
  editor.setCursor(line, col);
}

/** 常驻后按「谁发的」各自门控：隐藏引擎在切档时也会重发一次光标（内容替换归零），
 *  不拦住状态栏行列会被别的文档的值盖掉 */
function onMdCursor(pos: { line: number; col: number }) {
  if (isMdTab.value) onEngineCursor(pos);
}
function onCodeCursor(pos: { line: number; col: number }) {
  if (usesCodeEngine.value) onEngineCursor(pos);
}

// ---------- 打开 / 新建 ----------
/** 用户主动打开/切换/新建工作区：成功后展开侧栏。启动恢复不走这里（保持默认收起） */
async function openWorkspaceAt(dir: string) {
  await ws.openWorkspace(dir);
  sidebarVisible.value = true;
}

/** 应用内文件夹选择（打开工作区）：初始落点沿用当前/上次工作区；
 *  取不到时由后端退回文档 → 主目录。 */
const folderPicker = ref<{ visible: boolean; initial: string }>({
  visible: false,
  initial: '',
});

function pickerStartDir(): string {
  return ws.root || settings.settings.lastWorkspace || '';
}

function openWorkspace() {
  folderPicker.value = { visible: true, initial: pickerStartDir() };
}

async function onFolderPicked(dir: string) {
  folderPicker.value.visible = false;
  try {
    await openWorkspaceAt(dir);
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

/** 新建工作区：名称与存放位置在同一个选择器界面里填写，
 *  默认位置沿用当前/上次工作区所在目录 */
const wsCreate = ref<{ visible: boolean; parent: string; busy: boolean }>({
  visible: false, parent: '', busy: false,
});

/** 取父目录；盘符根（C:\）原样返回，取不到返回空串 */
function parentDirOf(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return '';
  if (i === 2 && s[1] === ':') return s.slice(0, 3);
  return s.slice(0, i);
}

async function createWorkspace() {
  let parent = parentDirOf(ws.root || settings.settings.lastWorkspace || '');
  if (!parent) {
    try {
      parent = (await getDefaultWorkspaceParent()) ?? '';
    } catch {
      parent = '';
    }
  }
  wsCreate.value = { visible: true, parent, busy: false };
}

async function doCreateWorkspace(parent: string, name: string) {
  wsCreate.value.busy = true;
  let path: string;
  try {
    path = await createWorkspaceDir(parent, name);
  } catch (err) {
    // 重名/非法名/无权限：留在弹窗里改名字或换位置重试
    wsCreate.value.busy = false;
    editor.showToast(
      t('workbench.toast.wsCreateFailed', { msg: err instanceof Error ? err.message : String(err) }),
      'error',
    );
    return;
  }
  wsCreate.value = { visible: false, parent: '', busy: false };
  try {
    await openWorkspaceAt(path);
    editor.showToast(t('workbench.toast.wsCreated', { name }), 'success');
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

/** 工作区切换（树根目录名菜单）：有脏标签先确认，避免静默丢失未保存内容 */
const wsSwitch = ref<{ visible: boolean; dir: string }>({ visible: false, dir: '' });

async function switchWorkspace(dir: string) {
  if (dir === ws.root) return;
  if (tabs.dirtyCount > 0) {
    wsSwitch.value = { visible: true, dir };
    return;
  }
  await doSwitchWorkspace(dir);
}

async function doSwitchWorkspace(dir: string) {
  try {
    tabs.closeAll(); // 切换前已经确认过：老工作区的标签全部关闭
    await openWorkspaceAt(dir);
    editor.showToast(t('workbench.toast.wsSwitched', { name: baseName(dir) }), 'success');
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

function onWsSwitchConfirm() {
  const dir = wsSwitch.value.dir;
  wsSwitch.value = { visible: false, dir: '' };
  void doSwitchWorkspace(dir);
}

/** 全部移除（含当前工作区）：确认后关全部标签、清列表、回欢迎页 */
const wsRemoveAll = ref(false);

function removeAllWorkspaces() {
  wsRemoveAll.value = true;
}

function onWsRemoveAllConfirm() {
  wsRemoveAll.value = false;
  tabs.closeAll(); // 确认对话框已提示放弃未保存内容
  ws.closeWorkspace();
  editor.showToast(t('workbench.toast.wsRemovedAll'), 'success');
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * 标记类文本标签（html / svg）：三模式管线——
 * edit=代码引擎源码，split=源码+Frame 渲染，read=Frame 渲染（编辑器隐藏不卸载）。
 */
const isMarkupTab = computed(() => {
  const k = tabs.activeTab?.kind;
  return k === 'html' || k === 'svg';
});
/** 当前是 SVG 源码标签：格式化（markup 保守美化）只给它，.html 不给 */
const isSvgTab = computed(() => tabs.activeTab?.kind === 'svg');
/** 激活标签是否可导出 HTML / Word：md 有预览 HTML 来源，mh 磁盘态即 HTML（D8 起放开） */
const canExportHtml = computed(() => {
  const k = tabs.activeTab?.kind;
  return k === 'md' || k === 'mh';
});
/** 激活标签是否可打印 PDF：md 走内核 ExportPDF，mh 富文本引擎自带导出；代码/标记/预览类无打印宿主 */
const canPrintPdf = computed(() => {
  const k = tabs.activeTab?.kind;
  return k === 'md' || k === 'mh';
});

/** 代码类标签：只支持编辑态（无分栏/阅读），由 CodeEditorEngine 接管 */
const isCodeTab = computed(() => tabs.activeTab?.kind === 'code');
/** 纯文本标签（txt/log/csv/tsv）：同样由代码引擎接管，但它不是「代码」——
 *  右键菜单与复制提示改用「文本」口径（html/svg 等标记语言仍算代码） */
const isPlainTextTab = computed(() => {
  const tab = tabs.activeTab;
  if (!tab || tab.kind !== 'code') return false;
  return fileKind((tab.path ?? tab.title).split(/[\\/]/).pop() ?? '') === 'text';
});
/** 富文本标签（.mh）：由 WangEditorEngine 接管，三模式全支持 */
const isMhTab = computed(() => tabs.activeTab?.kind === 'mh');
/** Markdown 标签：由 md-editor-v3 引擎接管（与代码/富文本引擎并列常驻，见下方挂载注释） */
const isMdTab = computed(() => tabs.activeTab?.kind === 'md');
/** 按激活标签种类路由到的引擎句柄（code/md/wang 三引擎并存时的统一出口）。
 *  ★ 预览类（docx/xlsx/image/pdf）必须显式返回 null：三引擎改为常驻后，
 *  隐藏的实例仍挂在 ref 上，路由错对象会让 Ctrl+F / 大纲跳转落到看不见的编辑器里
 *  （常驻前 v-if 保证预览态三个 ref 全为 null，这是那层保护消失后补的等价判断） */
const engineRef = computed<EngineHandle | null>(() => {
  if (!tabs.activeTab || tabs.activeIsPreview) return null;
  if (isMhTab.value) return wangEngineRef.value;
  if (usesCodeEngine.value) return codeEngineRef.value;
  return mdEngineRef.value;
});
/** ---- 三引擎常驻（2026-10-17）----
 * 每个引擎「首次被用到才挂，挂了就不再销毁」，可见性走 v-show。
 * 动机：原先 md 引擎是 v-if，md ↔ .mh ↔ 代码 每切一次都销毁重建整个内核
 * （md-editor 连撤销栈、滚动位置、已渲染的 mermaid/katex 一起丢），
 * wangEditor 的 createEditor 更是数百毫秒级——.mh 切换卡顿修完只剩这一半。
 * 常驻后必须同时守住三条，否则会立刻出问题：
 *  1) 隐藏期间不吃外部值（下面的 frozen props）——否则切回来被判定为「外部变更」整篇重建；
 *  2) 隐藏期间冒出来的事件一律丢弃（onMdContentChange / onCodeContentChange 等门控）；
 *  3) 隐藏会把 DOM 滚动位置清 0，位置改由 tabScroll 按标签存、切回时逐帧写回。 */
const mdEverMounted = ref(false);
const codeEverMounted = ref(false);
const wangEverMounted = ref(false);
watch(
  () => tabs.activeTab?.kind,
  (k) => {
    if (!k || tabs.activeIsPreview) return;
    if (k === 'md') mdEverMounted.value = true;
    else if (k === 'mh') wangEverMounted.value = true;
    else codeEverMounted.value = true; // code / html / svg / 旧快照 'text'
  },
  { immediate: true },
);
/** 编辑区由 CodeMirror 代码引擎接管的标签：code 恒编辑；html/svg 三模式中的源码侧；
 *  'text' 为旧会话快照兼容（新打开不再产生，txt/log/csv 等已归 'code'）——
 *  即除 Markdown/富文本外的一切文本都走代码引擎，杜绝 txt 被当 Markdown 渲染。
 *  ★ 预览类显式排除：常驻后它们没有 v-if 帮忙挡了，留着会让事件门控放脏数据进只读标签 */
const usesCodeEngine = computed(() => {
  const k = tabs.activeTab?.kind;
  return !!k && !tabs.activeIsPreview && k !== 'md' && k !== 'mh';
});
/** 交给常驻 md 引擎的内容：只在「激活的是 Markdown 标签」时更新（口径同 mhEditorHtml）。
 *  mode / docPath 同理冻结——隐藏期间跟着别的标签改视图模式会白白触发一次内核重排，
 *  而 docPath 一变动还牵动图片目录全局量。主题、字号、行号、专注模式等应用级设置不冻，
 *  它们只是 class/Compartment 切换，代价可忽略且切回时状态天然正确。 */
const mdEditorContent = ref('');
const mdEditorMode = ref<EditorMode>('edit');
const mdEditorDocPath = ref<string | null>(null);
watch(
  () => (isMdTab.value ? tabs.activeTab?.content ?? null : null),
  (v) => {
    if (v != null) mdEditorContent.value = v;
  },
  { immediate: true },
);
watch(
  () => (isMdTab.value ? editor.mode : null),
  (m) => {
    if (m) mdEditorMode.value = m;
  },
  { immediate: true },
);
watch(
  () => (isMdTab.value ? activeDocPath.value : null),
  (p) => {
    if (p !== null) mdEditorDocPath.value = p;
  },
  { immediate: true },
);
/** 交给常驻代码引擎的内容与文件名：同上，只在代码/标记类标签激活时更新
 *  （文件名决定语言包热切，冻结后切到 md 标签不会把语言洗成 null） */
const codeEditorContent = ref('');
const codeEditorPath = ref<string | null>(null);
watch(
  () => (usesCodeEngine.value ? tabs.activeTab?.content ?? null : null),
  (v) => {
    if (v != null) codeEditorContent.value = v;
  },
  { immediate: true },
);
watch(
  () => (usesCodeEngine.value ? tabs.activeTab?.path ?? tabs.activeTab?.draftPath ?? tabs.activeTab?.title ?? null : null),
  (p) => {
    if (p !== null) codeEditorPath.value = p;
  },
  { immediate: true },
);
/** 交给常驻 wangEditor 的内容：只在「激活的是 mh 标签」时更新。
 *  旧写法在非 mh 标签时喂空串，切回 mh 就被引擎判定为外部变更而整篇 setHtml 重建 Slate；
 *  方案骨架（八章节 + 多个预填表格）下这是数百毫秒起的主线程阻塞，表现为切不动也关不掉。
 *  保持原值后：md ↔ mh 往返不再 setHtml，只有换到另一份 mh 文档才必需重建。 */
const mhEditorHtml = ref('');
watch(
  () => (isMhTab.value ? tabs.activeTab?.content ?? null : null),
  (content) => {
    if (content != null) mhEditorHtml.value = content;
  },
  { immediate: true },
);
// 激活代码标签时全局视图强制编辑态（不写回设置偏好；切回 md 标签用户可再切回）
watch(isCodeTab, (isCode) => {
  if (isCode && editor.mode !== 'edit') editor.setMode('edit');
});
/** 标签切换 → 恢复该标签自己的视图模式（各标签模式态相互独立：
 *  md 的阅读态不会带进 mh，反之亦然）。直接改 editor store，
 *  不走 Workbench.setMode（避免把标签级模式写进全局视图偏好） */
watch(
  () => tabs.activeId,
  () => {
    const tab = tabs.activeTab;
    if (!tab || tabs.activeIsPreview || isCodeTab.value) return;
    const m = tab.mode;
    // 含 split：代码标签（强制 edit）切回 split 存储模式的 md 标签时不恢复（P2-27）
    if (m && editor.mode !== m) {
      editor.setMode(m);
    }
  },
);
/** ---- 按标签保存/恢复滚动位置（常驻的配套件，2026-10-17）----
 * 元素被 display:none 时浏览器会丢掉它的滚动位置，切回来读到 0；三引擎改常驻后
 * 不再销毁实例，但显隐仍然是 display:none，所以位置必须由上层按标签存。
 * 顺带把「同类文档互切」也管上了：以前 md A→md B 复用同一实例、scrollTop 原样留着，
 * B 就开在 A 的高度上；现在各回各位。
 * capture 走 flush:'pre'（DOM 变更前），此时上一个引擎还在屏幕上，读到的是真值。 */
const tabScroll = new Map<string, number>();
function engineOfTab(tab: { kind: string } | undefined): EngineHandle | null {
  if (!tab) return null;
  if (tab.kind === 'docx' || tab.kind === 'xlsx' || tab.kind === 'image' || tab.kind === 'pdf') return null;
  if (tab.kind === 'md') return mdEngineRef.value;
  if (tab.kind === 'mh') return wangEngineRef.value;
  return codeEngineRef.value;
}
watch(
  () => tabs.activeId,
  (id, oldId) => {
    if (oldId) {
      const top = engineOfTab(tabs.tabs.find((t) => t.id === oldId))?.captureScroll?.() ?? 0;
      if (top) tabScroll.set(oldId, top);
      else tabScroll.delete(oldId); // 停在文档头：删存档，切回来本就从顶部开始
    }
    // 关掉的标签不留档（Map 只随标签数增长）
    for (const key of [...tabScroll.keys()]) {
      if (!tabs.tabs.some((t) => t.id === key)) tabScroll.delete(key);
    }
    const target = id ? tabScroll.get(id) ?? 0 : 0;
    if (target) engineOfTab(tabs.activeTab)?.restoreScroll?.(target);
  },
);
/** 标记文档所在目录（相对资源经 asset:// base 解析） */
const markupDocDir = computed(() => {
  const p = tabs.activeTab?.path;
  return p ? p.replace(/[\\/][^\\/]*$/, '') : null;
});
/** 大纲面板可见性：预览类与标记类/代码类标签没有 Markdown 大纲概念 */
const showOutline = computed(
  () =>
    !!tabs.activeTab &&
    !tabs.activeIsPreview &&
    tabs.activeTab.kind !== 'html' &&
    tabs.activeTab.kind !== 'svg' &&
    tabs.activeTab.kind !== 'code' &&
    editor.mode !== 'edit',
);

/**
 * 打开类型三分流：'text' 文本类（md/txt/代码/HTML…）由编辑器接管；
 * 'handled' = 已在应用内处理（docx/xlsx/图片/PDF 开预览标签，或已交系统默认程序）；
 * 'rejected' = openSystem=false 且应用内开不了，调用方据此提示/忽略——
 * 目录树单击与拖入因此不会误启外部程序，双击或选择器显式选择才会。
 * 两个判定都在 Rust 侧：probe_text_file（扩展名+嗅探）、probe_preview_kind（预览种类），
 * 前端不猜测扩展名。
 */
async function routeByType(path: string, openSystem = true): Promise<'text' | 'handled' | 'rejected'> {
  try {
    if (await probeTextFile(path)) return 'text';
    const kind = await probePreviewKind(path).catch(() => null);
    // 命中即预览：与 Rust 侧 preview_kind「非 null 即可预览」语义严格一致，
    // 新增预览种类只改 Rust 名单，前端不再补白名单（方案 §5.4 修订）
    if (kind) {
      tabs.openPreviewByPath(path, kind);
      ws.expandTo(path);
      ws.select(path);
      rememberRecent(path);
      // 预览组件经 asset:// 自取文件字节：补授权该文档目录
      const dir = path.replace(/[\\/][^\\/]*$/, '');
      if (dir) void allowAssetDir(dir).catch(() => undefined);
      return 'handled';
    }
    // 非文本非预览 = 交系统默认程序。openSystem=false 时跳过（树内单击不误开外部程序，双击才开）
    if (!openSystem) return 'rejected';
    await openInSystem(path);
    editor.showToast(t('workbench.toast.openedBySystem', { name: baseName(path) }), 'info');
    return 'handled';
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
    return 'handled';
  }
}

/** `skipTypeCheck`：调用方已做过分流时跳过重复探测 */
async function openFilePath(path: string, modeOverride?: EditorMode, skipTypeCheck = false) {
  if (!skipTypeCheck && (await routeByType(path)) !== 'text') return;
  try {
    // 打开默认模式：调用方未指定时，源码类（html/svg/代码）进编辑态，其余用用户偏好视图
    const mode = modeOverride ?? (opensInEdit(path) ? 'edit' : settings.settings.editorMode);
    await tabs.openByPath(path, mode);
    ws.expandTo(path);
    ws.select(path);
    rememberRecent(path);
    // 单文件打开（未开工作区）或跨工作区文件：补授权该文档目录，预览图片才能走 asset://
    const dir = path.replace(/[\\/][^\\/]*$/, '');
    if (dir) void allowAssetDir(dir).catch(() => undefined);
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

/** 新建文件直达编辑：全局视图切到编辑态（不改动用户的默认视图偏好） */
async function openFileInEditMode(path: string) {
  editor.setMode('edit');
  await openFilePath(path, 'edit');
}

/** 源码类文件（html/svg + 代码扩展名）与富文本（.mh）：打开即进编辑态（渲染由分栏/阅读承担） */
const opensInEdit = (p: string): boolean => /\.(html?|svg|mh)$/i.test(p) || isCodeExt(p);

/** 左侧目录单击打开：Markdown/TXT 默认阅读模式；html/svg/代码类默认编辑模式；
 *  docx/xlsx/图片开预览标签；其余（系统默认程序类）单击不动作——双击才开（防误触外部程序） */
async function openFileFromTree(path: string) {
  if ((await routeByType(path, false)) !== 'text') return;
  const mode: EditorMode = opensInEdit(path) ? 'edit' : 'read';
  editor.setMode(mode);
  await openFilePath(path, mode, true);
}

/** 树内双击：系统默认程序类在此打开；文本/预览类已被单击打开，重复调用按路径去重无害 */
async function openFileFromTreeDbl(path: string) {
  if ((await routeByType(path)) !== 'text') return;
  const mode: EditorMode = opensInEdit(path) ? 'edit' : 'read';
  editor.setMode(mode);
  await openFilePath(path, mode, true);
}

/** 打开文件：应用内选择器。初始落点 = 当前文档目录，否则当前/上次工作区。
 *  选中文件夹即授权（替代系统对话框的授权点），后续探测、读取、预览才能通过白名单。 */
async function openFileByDialog() {
  try {
    const from = activeDocPath.value ? parentDirOf(activeDocPath.value) : pickerStartDir();
    const p = await filePicker.open({
      mode: 'file',
      title: t('workbench.folderPicker.openFileTitle'),
      initialPath: from,
    });
    if (!p) return;
    await allowAssetDir(parentDirOf(p));
    await openFilePath(p);
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

/** 另存为 / 导出共用的保存目标选择：取消返回 null */
function pickSaveTarget(
  title: string,
  defaultName: string,
  ext: string,
  initialDir = '',
): Promise<string | null> {
  return filePicker.open({
    mode: 'save',
    title,
    initialPath: initialDir || pickerStartDir(),
    defaultName,
    ext,
  });
}

/** 按源文档名推导导出默认文件名（stem + 扩展名） */
function exportTargetName(docPath: string, ext: string): string {
  const stem = (docPath.split(/[\\/]/).pop() ?? docPath).replace(/\.[^.]*$/, '');
  return `${stem || 'export'}.${ext}`;
}

function exportStartDir(): string {
  return tabs.activeTab?.path ? parentDirOf(tabs.activeTab.path) : pickerStartDir();
}

// ---------- 预览区文档互链（[PRD](docs/PRD.md)） ----------
/** 以 baseDir 为基准合并相对段（. / .. / 混合斜杠），产出 Windows 绝对路径 */
function resolveJoin(baseDir: string, rel: string): string {
  const parts = baseDir.replace(/[\\/]+$/, '').split(/[\\/]/);
  for (const seg of rel.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  // 分隔符跟着 baseDir 的形态走：写死 `\` 在 mac/Linux 上拼出的绝对路径不存在，
  // 预览区文档互链（[PRD](docs/PRD.md)）会直接「文件不存在」
  return parts.join(isWinStylePath(baseDir) ? '\\' : '/');
}

/** 预览区文件路径链接：按当前文档目录解析成绝对路径，走统一打开分流。
 *  存在性先经 get_file_meta 校验（顺带过权限闸门），避免不存在的路径被
 *  routeByType 误交系统默认程序。锚点/查询串仅剥除（跨文档锚点定位不做）。 */
async function onOpenDoc(href: string) {
  const tab = tabs.activeTab;
  const baseDir = tab?.path ? tab.path.replace(/[\\/][^\\/]*$/, '') : null;
  if (!baseDir) {
    editor.showToast(t('workbench.toast.docLinkNoBase'), 'error');
    return;
  }
  let raw = href;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* 含裸 % 等非法编码时保留原样 */
  }
  raw = raw.split('#')[0].split('?')[0];
  if (!raw) return;
  const abs =
    /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')
      ? raw
      : resolveJoin(baseDir, raw);
  try {
    await getFileMeta(abs);
  } catch {
    editor.showToast(t('workbench.toast.docLinkMiss', { path: abs }), 'error');
    return;
  }
  await openFilePath(abs);
}

function rememberRecent(path: string) {
  const rest = settings.settings.recentFiles.filter((r) => r.path !== path);
  void settings.update({
    recentFiles: [{ path, openedAtMs: Date.now() }, ...rest].slice(0, 20),
  });
}

function newFromTemplate(tpl: MdTemplate) {
  // 编辑内核=富文本：新建 .mh（wangEditor），带出模板 HTML 骨架（contentHtml，双形态见 markdownTemplate.ts）；
  // 空白文档无 HTML 骨架，维持空白起步。其他模板 Markdown 骨架不适用，走 contentHtml。
  if (settings.settings.editorEngine === 'wangeditor') {
    const html = tpl.contentHtml ?? '';
    tabs.newUntitled('', 'edit', 'mh', html);
    editor.setMode('edit');
    editor.showToast(
      html ? t('workbench.toast.createdFromTpl', { name: tpl.name }) : t('engine.createdMh'),
      'success',
    );
    return;
  }
  // 空白文档默认直接进编辑模式；其他模板沿用偏好里的默认视图
  const mode = tpl.id === 'blank' ? 'edit' : settings.settings.editorMode;
  tabs.newUntitled(tpl.content, mode);
  editor.setMode(mode);
  editor.showToast(t('workbench.toast.createdFromTpl', { name: tpl.name }), 'success');
}

/** 文件菜单 md/mh 档：与 txt 同口径的直达新建（空文档），内核已由 Toolbar 同步给后续 Ctrl+N */
function newKernelFile(kind: 'md' | 'mh') {
  tabs.newUntitled('', 'edit', kind);
  editor.setMode('edit');
}

/** 文件菜单 txt 档：代码文件要先有后缀才能选语言，未命名阶段先落成 .txt 纯文本，
 *  保存时走「另存为」按新后缀切语言与标签类型 */
function newCodeFile() {
  tabs.newUntitled('', 'edit', 'code');
  editor.setMode('edit');
}

// ---------- 保存流水线 ----------
async function saveActive(): Promise<void> {
  const tab = tabs.activeTab;
  if (!tab || editor.saving) return;
  // 预览标签（docx/xlsx/图片）没有文本内容，写入会毁掉原文件——硬性拦截
  if (tabs.activeIsPreview) {
    editor.showToast(t('workbench.toast.previewReadonlySave'), 'info');
    return;
  }
  if (!tab.isUtf8) {
    editor.showToast(t('workbench.toast.encodingWarning', { encoding: tab.encoding }), 'error');
    return;
  }
  if (!tab.path) {
    await saveActiveAs();
    return;
  }
  editor.saving = true;
  try {
    await writeFileAtomic(tab.path, tab.content, tab.hadBom);
    tabs.markSaved(tab.id, tab.content);
    editor.showToast(t('workbench.toast.saved', { name: baseName(tab.path) }), 'success');
  } catch (err) {
    editor.showToast(t('workbench.toast.saveFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
  } finally {
    editor.saving = false;
  }
}

/** 另存为的默认扩展名：跟着标签的真实类型走（三引擎之后不再一律落 .md）。
 *  标题尾缀优先，无尾缀（新建文档 / Makefile 这类）按引擎归类。 */
function defaultSaveExt(title: string, kind: TabKind): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(title);
  if (m) return m[1].toLowerCase();
  if (kind === 'mh') return 'mh';
  return kind === 'md' ? 'md' : 'txt';
}

/** 路径是否落在当前工作区内（决定「写完盘要不要回读目录树」）。
 *  分隔符归一与前缀边界（D:\work 不能匹配 D:\workshop）由 utils/pathJoin 统一处理 */
function isInWorkspace(path: string): boolean {
  return isPathInside(ws.root ?? '', path);
}

async function saveActiveAs(): Promise<string | null> {
  const tab = tabs.activeTab;
  if (!tab) return null;
  try {
    const ext = defaultSaveExt(tab.title, tab.kind);
    const p = await pickSaveTarget(
      t('toolbar.saveAs'),
      tab.title,
      ext,
      tab.path ? parentDirOf(tab.path) : '',
    );
    if (!p) return null;
    const res = await saveTextAt(p, tab.content);
    const newTitle = res.path.split(/[\\/]/).pop() ?? tab.title;
    tabs.updateTab(tab.id, {
      path: res.path,
      title: newTitle,
      // 另存成的类型可能与原标签不同（.md 存成 .txt），引擎按新扩展名重算
      kind: textKindOf(res.path),
      encoding: 'utf-8',
      hadBom: false,
      isUtf8: true,
    });
    tabs.markSaved(tab.id, tab.content);
    // 另存进当前工作区：目录树是打开工作区时的快照，不回读就看不到刚写下的新文件
    //（expandTo 只改展开态，不会凭空长出节点）。刷新失败不该盖掉「已保存」的事实，静默忽略
    if (isInWorkspace(res.path)) {
      await ws.refresh().catch(() => undefined);
    }
    ws.expandTo(res.path);
    rememberRecent(res.path);
    // 另存到新目录同样补授权，保证粘贴图片在阅读态可见
    const dir = res.path.replace(/[\\/][^\\/]*$/, '');
    if (dir) void allowAssetDir(dir).catch(() => undefined);
    editor.showToast(t('workbench.toast.savedAs', { name: newTitle }), 'success');
    return res.path;
  } catch (err) {
    editor.showToast(t('workbench.toast.saveAsFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
  }
  return null;
}

// 自动保存（P1-9）：内容停顿后落盘
/** 本次编辑周期内已提示过写盘失败的 tab id：文件被锁/只读/被删时每次停顿都会失败，
 *  不记重会每 1s 弹一次 toast 刷屏（P1-12）。内容再变化（新编辑周期）或保存成功后重置 */
const autoSaveFailed = new Set<string>();
const autoSaveTick = debounce(
  (id: string, content: string) => {
    const tab = tabs.tabs.find((t) => t.id === id);
    if (!tab || !tab.isDirty || !tab.path || !tab.isUtf8) return;
    if (tabs.activeId !== id) return;
    void (async () => {
      try {
        await writeFileAtomic(tab.path as string, content, tab.hadBom);
        tabs.markSaved(id, content);
        autoSaveFailed.delete(id); // 保存成功：重置，下次失败可再次提示
        editor.showToast(t('workbench.toast.autoSaved', { name: baseName(tab.path as string) }), 'info');
      } catch (err) {
        if (autoSaveFailed.has(id)) return; // 本编辑周期已提示过：静默等下次停顿重试
        autoSaveFailed.add(id);
        editor.showToast(
          t('workbench.toast.autoSaveFailed', { msg: err instanceof Error ? err.message : String(err) }),
          'error',
        );
      }
    })();
  },
  1000,
);
watch(
  () => tabs.activeTab?.content,
  () => {
    const s = settings.settings;
    if (s.autoSave && tabs.activeTab) {
      autoSaveTick.cancel();
      autoSaveFailed.delete(tabs.activeTab.id); // 新的编辑周期：失败提示可再次触发
      const { id, content } = tabs.activeTab;
      autoSaveTick(id, content);
    }
  },
);

// ---------- 标签关闭 ----------
async function requestCloseTab(id: string) {
  const tab = tabs.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.isDirty) {
    closeConfirm.value = { visible: true, tabId: id, batchIds: null };
  } else {
    await tabs.closeTab(id, () => true);
  }
}

/** 批量关闭（标签右键菜单：关闭左侧/右侧/其他/全部） */
async function requestCloseBatch(ids: string[]) {
  if (ids.length === 0) return;
  const hasDirty = ids.some((id) => tabs.tabs.find((t) => t.id === id)?.isDirty);
  if (hasDirty) {
    closeConfirm.value = { visible: true, tabId: null, batchIds: ids };
  } else {
    await tabs.closeTabsBatch(ids);
  }
}

async function confirmCloseTab(discard: boolean) {
  const id = closeConfirm.value.tabId;
  closeConfirm.value = { visible: false, tabId: null, batchIds: null };
  if (!id || !discard) {
    if (id) await tabs.closeTab(id, () => true); // 不保存 → 放弃更改并关闭
    return;
  }
  const tab = tabs.tabs.find((t) => t.id === id);
  if (tab?.isDirty && tab.path && tab.isUtf8) {
    // 先尝试保存再关闭；写盘失败（文件被锁/只读/被删）时提示并保留标签——
    // 若静默吞错照常关闭，未保存内容随"关标签 + 标记干净 + 快照剔除"三通道丢失（P1-13）
    try {
      await writeFileAtomic(tab.path, tab.content, tab.hadBom);
      tabs.markSaved(id, tab.content); // 仅在写盘成功后标记已保存
    } catch (err) {
      editor.showToast(t('workbench.toast.saveFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
      return; // 中止关闭：标签保留，用户可重试或另存
    }
  }
  await tabs.closeTab(id, () => true);
}

async function confirmCloseBatch(save: boolean) {
  const ids = closeConfirm.value.batchIds ?? [];
  closeConfirm.value = { visible: false, tabId: null, batchIds: null };
  if (save) {
    for (const id of ids) {
      const tab = tabs.tabs.find((t) => t.id === id);
      if (tab?.isDirty && tab.path && tab.isUtf8) {
        // 任一变失败 → 提示并中止整批关闭（已落盘的标记已生效，未保存的标签保留）
        try {
          await writeFileAtomic(tab.path, tab.content, tab.hadBom);
          tabs.markSaved(id, tab.content); // 仅在写盘成功后标记已保存
        } catch (err) {
          editor.showToast(t('workbench.toast.saveFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
          return;
        }
      }
    }
  }
  await tabs.closeTabsBatch(ids);
}

/** 关闭确认对话框统一入口（单标签 / 批量 / 关窗口三态） */
function onCloseConfirm() {
  if (closeConfirm.value.tabId) void confirmCloseTab(true);
  else if (closeConfirm.value.batchIds) void confirmCloseBatch(true);
  else void confirmCloseWindowSaveAll();
}
function onCloseCancel() {
  if (closeConfirm.value.tabId) void confirmCloseTab(false);
  else if (closeConfirm.value.batchIds) void confirmCloseBatch(false);
  else void confirmCloseWindow('cancel');
}

// ---------- 工作区隐藏后的左缘复原入口（不可见，仅在标签栏行留 4px 命中区；拖动向右展开，点击顶栏按钮也可） ----------
const WS_RESTORE_AT = 60;
let wsRestoreStartX = 0;
function cleanupWsRestore() {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.body.classList.remove('mk-col-dragging');
  window.removeEventListener('mousemove', onWsRestoreMove);
  window.removeEventListener('mouseup', onWsRestoreEnd);
}
function onWsRestoreStart(e: MouseEvent) {
  wsRestoreStartX = e.clientX;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  // iframe 会吞掉拖拽中的 mousemove/mouseup（见 global.css mk-col-dragging 注释）
  document.body.classList.add('mk-col-dragging');
  window.addEventListener('mousemove', onWsRestoreMove);
  window.addEventListener('mouseup', onWsRestoreEnd);
}
function onWsRestoreMove(e: MouseEvent) {
  if (e.clientX - wsRestoreStartX > WS_RESTORE_AT) {
    sidebarVisible.value = true;
    cleanupWsRestore();
  }
}
function onWsRestoreEnd() {
  cleanupWsRestore();
}

// ---------- html / svg 分栏：源码区 ⇄ 预览区可拖宽 ----------
const SPLIT_MIN = 15;
const SPLIT_MAX = 85;
/** 预览区最小宽度：够放下那条工具栏（含贴右缘的全屏按钮），按较宽的英文标签
 *  「Open in System」留足，中文更窄自然也够。
 *  ★ 别改成「运行时量 .zoom-bar 的宽度」——它是**列向** flex 容器的子项，默认
 *    align-items:stretch 会把 offsetWidth 拉成整个面板宽，反推出的占比上限直接落到
 *    下限，结果就是分界线完全拖不动（2026-10-20 踩过）。 */
const PREVIEW_MIN_PX = 340;
/** 源码区占比上限：预览区至少保住 PREVIEW_MIN_PX */
function splitMaxPct(boxW: number): number {
  if (boxW <= 0) return SPLIT_MAX;
  return Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, ((boxW - PREVIEW_MIN_PX) / boxW) * 100));
}
/** 源码区占比，预览区吃剩下的。会话内有效（不落设置：只是临时看版式的手感） */
const markupSplitPct = ref(50);
const textAreaRef = ref<HTMLElement | null>(null);
/** 把已存的比例夹回当前允许的范围（窗口变窄、侧栏收展后都要重夹） */
function clampSplitPct(boxW: number) {
  const pct = markupSplitPct.value;
  const next = Math.min(splitMaxPct(boxW), Math.max(SPLIT_MIN, pct));
  if (next !== pct) markupSplitPct.value = next;
}
let splitBoxW = 0;
let splitStartX = 0;
let splitStartPct = 50;
/** 本帧内累积到的最新鼠标 x，与已排队的 rAF 句柄：合并成每帧最多改一次宽度 */
let splitPendingX = 0;
let splitRaf = 0;
function cleanupSplitDrag() {
  if (splitRaf) {
    cancelAnimationFrame(splitRaf);
    splitRaf = 0;
  }
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.body.classList.remove('mk-col-dragging');
  window.removeEventListener('mousemove', onSplitDragMove);
  window.removeEventListener('mouseup', onSplitDragEnd);
}
function onSplitDragStart(e: MouseEvent) {
  const area = (e.currentTarget as HTMLElement).parentElement;
  if (!area || !area.clientWidth) return;
  splitBoxW = area.clientWidth;
  splitStartX = e.clientX;
  clampSplitPct(splitBoxW); // 窗口可能已变窄，先把旧比例夹回允许范围
  splitStartPct = markupSplitPct.value;
  splitPendingX = e.clientX;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  // 预览区是独立文档，拖进 iframe 就收不到 mousemove/mouseup（见 global.css 同名类注释）
  document.body.classList.add('mk-col-dragging');
  window.addEventListener('mousemove', onSplitDragMove);
  window.addEventListener('mouseup', onSplitDragEnd);
}
/** ★ 每个 mousemove 就改一次盒宽，iframe 内部视口跟不上（内层文档的 resize 是异步的），
 *  会先被拉伸再回弹，预览右缘看着就是晃屏。合并到每帧最多一次，内层跟得上，仍然跟手。 */
function onSplitDragMove(e: MouseEvent) {
  splitPendingX = e.clientX;
  if (splitRaf) return;
  splitRaf = requestAnimationFrame(() => {
    splitRaf = 0;
    const pct = splitStartPct + ((splitPendingX - splitStartX) / splitBoxW) * 100;
    markupSplitPct.value = Math.min(splitMaxPct(splitBoxW), Math.max(SPLIT_MIN, pct));
  });
}
function onSplitDragEnd() {
  cleanupSplitDrag();
}
/** 比例经 .text-area 的 --mk-split 下发给 CSS（见 global.css 文本区规则） */
const textAreaStyle = computed<CSSProperties | undefined>(() =>
  isMarkupTab.value && editor.mode === 'split'
    ? ({ '--mk-split': `${markupSplitPct.value}%` } as unknown as CSSProperties)
    : undefined,
);
// 容器变窄（缩窗口 / 收展侧栏 / 拖目录树）后重夹比例：不夹的话预览区会窄过工具栏，
// 按钮被裁；只听 window resize 不够，拖目录树宽度不触发它
let splitAreaRO: ResizeObserver | null = null;
watch(textAreaRef, (el) => {
  splitAreaRO?.disconnect();
  splitAreaRO = null;
  if (!el) return;
  splitAreaRO = new ResizeObserver(() => clampSplitPct(el.clientWidth));
  splitAreaRO.observe(el);
});
onBeforeUnmount(() => {
  splitAreaRO?.disconnect();
  splitAreaRO = null;
  cleanupSplitDrag();
});

// ---------- 模式 / 主题 / 字号 ----------
function setMode(m: EditorMode) {
  // 代码标签只支持编辑态：模式按钮已禁用，这里兜底拦截 Alt+E/W/R 快捷键
  if (isCodeTab.value && m !== 'edit') return;
  // 富文本（.mh）双形态：分栏禁用（编辑/阅读两态，阅读态带大纲）
  if (isMhTab.value && m === 'split') return;
  editor.setMode(m);
  // 模式态按标签独立：写回当前标签，切走再切回时恢复
  tabs.setActiveMode(m);
  void settings.update({ editorMode: m });
}
/** 引擎功能栏「分栏预览」上报（页面全屏态里唯一的模式入口）。
 *  ★ 参数显式标注：MdEditorV3Engine 的 emits 成员增多后模板绑定会丢推断，具名 + 自带类型即不受影响 */
function onMdRequestMode(m: EditorMode) {
  if (!isMdTab.value) return;
  setMode(m);
}
/** .mh 功能栏模式按钮上报（阅读态页面全屏里唯一的模式入口），真相源同样在本层 */
function onMhRequestMode(m: EditorMode) {
  if (!isMhTab.value) return;
  setMode(m);
}
/** 页面全屏统一入口：F11、标签栏右键「全屏」、内容区右键「全屏」三条路共用。
 *  md 编辑/分栏与 .mh 各自已有内核/自建全屏实现（状态在引擎里，F11 与功能栏按钮同源），
 *  代码引擎与预览类标签没有，故由本层在 .editor-area 上挂类（见 global.css 的 page-full 规则）。
 *  ★ 这份状态放 store 不放本层：预览工具条上的「全屏」按钮要读同一份，否则按钮与 F11 各按各的 */
const areaPageFull = computed(() => usesCodeEngine.value || tabs.activeIsPreview);
function toggleFullscreen() {
  editorCtx.value = null; // 菜单开着时按 F11：先收菜单，否则「全屏/退出全屏」的文案会停在旧状态
  if (areaPageFull.value) {
    editor.pageFull = !editor.pageFull;
    return;
  }
  engineRef.value?.togglePageFullscreen?.();
}
// 全屏类挂在共用的 .editor-area 上：切到自带全屏的引擎（md/.mh）时必须摘掉，
// 否则从代码/预览标签的全屏态经 Ctrl+P（浮层在全屏带之上）跳到 md 标签，会把 md 也留在铺满态
watch(areaPageFull, (own) => {
  if (!own) editor.pageFull = false;
});
/** 标签右键「全屏」：目标标签不是当前标签时先激活再全屏（首次挂载的引擎要等一个 tick 才有 ref） */
async function onTabFullscreen(id: string) {
  if (tabs.activeId !== id) {
    tabs.activate(id);
    await nextTick();
  }
  toggleFullscreen();
}
/** 阅读态页面全屏时，应用层大纲面板被全屏层盖住 → 改由右缘浮标承担目录（状态由引擎上报） */
const mdPageFull = ref(false);
const mhPageFull = ref(false);
// ★ 参数显式标注：避开 MdEditorV3Engine emits 增多后模板绑定的推断塌陷（见 onEngineCursor 注释）
function onMdPageFull(on: boolean) {
  mdPageFull.value = on;
}
function onMhPageFull(on: boolean) {
  mhPageFull.value = on;
}
/** 大纲呈现方式（设置-外观「大纲」）：classic = 右侧面板 / fresh = 视口右缘浮标。
 *  全屏时面板被全屏层整个盖住，所以两种档在全屏阅读态都回落到浮标 */
const outlineFresh = computed(() => settings.settings.outlineStyle === 'fresh');
const outlineRailOn = computed(
  () =>
    (editor.mode === 'read' && (isMhTab.value ? mhPageFull.value : isMdTab.value && mdPageFull.value)) ||
    (outlineFresh.value && showOutline.value),
);
function toggleTheme() {
  /* 顶栏只切「模式」：跟随系统时按下 → 落到与当前相反的固定模式（配色沿用该模式上次的选择） */
  const next: ThemeKind = settings.isDark ? 'light' : 'dark';
  void settings.update({ themeMode: next });
}
/** 字号一档 = 0.5px（范围 12~24）。先钳范围、再折到 0.5 网格上：
 *  浮点连加会漂出整半档之外的值（15.1 之类），而设置里的 range 与 --mk-font-size 只认整半档 */
function changeFont(delta: number) {
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.settings.fontSize + delta));
  void settings.update({ fontSize: Math.round(next * 2) / 2 });
}/** Ctrl+0：回到默认字号（值取 DEFAULT_SETTINGS，别在这儿重抄默认值） */
function resetFont() {
  void settings.update({ fontSize: DEFAULT_SETTINGS.fontSize });
  editor.showToast(t('toolbar.fontZoomTip', { n: DEFAULT_SETTINGS.fontSize }), 'info');
}

/** Ctrl/⌘+滚轮调整全局字号：编辑态/分栏态/阅读态统一走 --mk-font-size
 *  （CM 编辑区与 md 预览区样式都消费该变量，无需按模式分流）。
 *  必须 window capture + passive:false 且 preventDefault：WebView2/WKWebView
 *  默认把 Ctrl+滚轮当页面缩放手势，不拦截会整页缩放而非调字号。
 *  钳制范围与 changeFont（顶栏 +/-、Ctrl+±）一致 12-24，一档 0.5px；持久化由 settings.update 内部防抖。
 *  deltaY<0 = 滚轮向上（远离用户）= 放大，与顶栏 + 按钮同向。 */
function onFontWheel(e: WheelEvent) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  changeFont(e.deltaY < 0 ? FONT_STEP : -FONT_STEP);
  // 轻提示反馈当前字号：滚轮连续滚动时 toast 去重合并（同文案同类型），最多 3 条并存
  editor.showToast(t('toolbar.fontZoomTip', { n: settings.settings.fontSize }), 'info');
}

// ---------- 大纲跳转 ----------
function gotoOutline(item: OutlineItem) {
  cancelScrollRestore(); // 显式定位优先：停掉切标签时那次的滚动恢复重试
  engineRef.value?.scrollToLine(item.line, item.index);
  editor.cursorLine = item.line;
}

/** 会话恢复的光标定位。引擎改成异步组件后，挂载那一帧 ref 还是 null（chunk 正在下载），
 *  单次 nextTick 会扑空——改成重试到引擎出现；约 2 秒仍等不到就放弃，
 *  文档照常打开，只是不落到上次那行。
 *  ★ 按标签 id 守门：等待期间用户可能已经切走，engineRef 那时指向的是别的文档，
 *    不拦就会把新看的那篇滚到旧标签的行号上 */
function scrollToRestoredCursor(tabId: string, line: number): void {
  let tries = 0;
  const step = (): void => {
    if (tabs.activeId !== tabId) return;
    if (engineRef.value?.scrollToLine) {
      engineRef.value.scrollToLine(line);
      return;
    }
    if (++tries > 120) return;
    setTimeout(step, 16);
  };
  void nextTick(step);
}

/* ---- 滚动联动：内容滚到哪个标题，大纲就选中哪一条 ----
   scroll 不冒泡，但捕获阶段能吃到任何后代的滚动 → 一个 document 级监听覆盖三引擎各自的
   滚动宿主（md 分栏的预览栏、md 阅读的 .read-scroll、.mh 的 .w-e-scroll）。
   为什么不挂在 .editor-area 上：那个盒子是 v-if="tabs.activeTab"，Workbench 挂载时会话还没
   恢复出标签，节点根本不存在，监听会静默装不上（实测过）。
   宿主与标题集合由当前引擎自己报（activeHeadingIndex），上层只存一个序号。 */
let spyLast = 0;
let spyTimer: number | undefined;
function measureActiveHeading() {
  const i = engineRef.value?.activeHeadingIndex?.() ?? -1;
  if (i !== editor.activeHeading) editor.activeHeading = i;
}
/** 90ms 节流 + 尾随补一次：只为一行高亮变色，不需要每帧量；
 *  也不用 rAF —— 页面切到后台时 rAF 停摆，那种写法会把节流标记永久卡住 */
function onSpyScroll() {
  const wait = 90 - (performance.now() - spyLast);
  if (wait <= 0) {
    spyLast = performance.now();
    measureActiveHeading();
    return;
  }
  if (spyTimer) return;
  spyTimer = window.setTimeout(() => {
    spyTimer = undefined;
    spyLast = performance.now();
    measureActiveHeading();
  }, wait);
}
onMounted(() => document.addEventListener('scroll', onSpyScroll, true));
onBeforeUnmount(() => {
  document.removeEventListener('scroll', onSpyScroll, true);
  if (spyTimer) window.clearTimeout(spyTimer);
});
// 切文档 / 切模式 / 大纲重算后不会有 scroll 事件（滚动位置是恢复出来的），主动补量一次
watch(
  () => [tabs.activeId, editor.mode, editor.outline.length],
  () => void nextTick(measureActiveHeading),
);

/** 文档内超链接 → 应用内独立 WebView 窗口（md 预览与 mh 阅读态共用）。
 *  iframe 内嵌被大量网站 X-Frame-Options 拒绝，改走真 WebView2 实例 */
function onOpenLink(href: string) {
  openWebWindow(href).catch(() => {
    // 创建窗口失败（极少）：回落系统浏览器
    void openUrl(href).catch(() => undefined);
  });
}

/** 文件内定位（搜索面板文件内查找 / 全局搜索命中跳转共用）：直调引擎按行滚动（三态通用）。
 *  kw 约定：undefined = 不动当前高亮；'' = 清除；非空 = 设置高亮。
 *  （面板每次跳转都会 emit goto，若 goto 无条件清除会秒删 emit('find') 刚画的高亮）
 *  matchIndex（第 4 参）= 当前命中序号，只有文件内查找带；全局命中跳转跨文件，没有序号 */
function gotoLine(line: number, kw?: string, cs = false, matchIndex?: number) {
  cancelScrollRestore(); // 同上：点击搜索结果时切档的滚动恢复与本次定位同 tick，必须让位
  engineRef.value?.scrollToLine(line);
  // CM 系（md / code）：序号随 highlight 一起下发，当前命中强化标记 + 落成真实选区
  if (kw !== undefined) {
    if (kw) engineRef.value?.highlight(kw, cs, matchIndex);
    else engineRef.value?.clearHighlight();
  }
  // mh（富文本引擎）：不吃 matchIndex，需在 highlight 重算 Range 后按序号单独标记 + 定位
  if (isMhTab.value && matchIndex != null) engineRef.value?.scrollToMatch?.(matchIndex);
  editor.cursorLine = line;
}

/** Ctrl+F 查找条状态 → 引擎高亮（编辑/分栏 CM6 装饰 + 阅读态预览 mark） */
function onFind(keyword: string, caseSensitive: boolean) {
  engineRef.value?.highlight(keyword, caseSensitive);
}

/** 可替换范围：只有 CodeMirror 系引擎（md / code / 文本）具备文本级替换。
 *  .mh 的内容模型是 HTML、命中口径不同（面板按去标签纯文本匹配，偏移对不上源码），
 *  阅读态没有可编辑文档，预览类标签无文本语义——三者都不提供替换入口 */
const canReplace = computed(
  () => !!tabs.activeTab && !tabs.activeIsPreview && !isMhTab.value && editor.mode !== 'read',
);

/** 全文替换：命中偏移在 tab.content 上算（与面板「第 k 处」同序同数），交引擎带 expect 校验落盘。
 *  引擎 dispatch 必带 docChanged → on-change → markDirty → 自动保存，不另开写盘支路 */
function onReplace(req: ReplaceRequest): void {
  const tab = tabs.activeTab;
  if (!tab || !canReplace.value) return;
  const engine = engineRef.value;
  if (req.mode === 'all') {
    const res = replaceAll(tab.content, req.keyword, req.replacement, req.caseSensitive);
    if (res.count === 0) {
      editor.showToast(t('search.replaceNone'), 'info');
      return;
    }
    if (!engine?.replaceDocText?.(res.text, tab.content)) {
      editor.showToast(t('search.replaceStale'), 'info');
      return;
    }
    editor.showToast(t('search.replaceDone', { n: res.count }), 'success');
    return;
  }
  const hit = findMatchRanges(tab.content, req.keyword, req.caseSensitive)[req.index];
  if (!hit) {
    editor.showToast(t('search.replaceNone'), 'info');
    return;
  }
  if (!engine?.replaceRange?.(hit.from, hit.to, req.replacement, tab.content.slice(hit.from, hit.to))) {
    editor.showToast(t('search.replaceStale'), 'info');
  }
}

/** 工具栏搜索按钮：打开统一搜索面板（全局模式） */
function openGlobalSearch() {
  hubMode.value = 'global';
  search.open();
}

function closeHub() {
  search.close();
  engineRef.value?.clearHighlight();
}

// ---------- 标签 ↔ 文件树联动：切换标签时工作区选中态跟随（展开祖先 + 滚动到可见） ----------
async function syncTreeToActiveTab(): Promise<void> {
  const path = tabs.activeTab?.path;
  // 未保存的新建文档 / 工作区外文件：不改变工作区选中态
  if (!path || !ws.root || !path.startsWith(ws.root)) return;
  ws.expandTo(path);
  ws.select(path);
  await nextTick(); // 等祖先展开渲染出新节点
  document
    .querySelector(`[data-path="${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}
watch(() => tabs.activeId, () => void syncTreeToActiveTab());

// ---------- 导出 ----------
function wrapExportHtml(body: string): string {
  const title = tabs.activeTab?.title ?? t('workbench.appName');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; max-width: 860px; margin: 0 auto; padding: 40px 24px; line-height: 1.75; color: #24292f; }
  h1, h2, h3 { border-bottom: 1px solid #eaecef; padding-bottom: 6px; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: auto; }
  code { background: #f0f1f2; border-radius: 3px; padding: 1px 5px; font-family: Consolas, monospace; }
  pre code { background: transparent; padding: 0; }
  table { border-collapse: collapse; } th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
  img { max-width: 100%; }
  blockquote { border-left: 4px solid #d0d7de; margin: 0; padding: 0 14px; color: #57606a; }
</style>
</head>
<body>${body}</body>
</html>`;
}

/** 导出 HTML 时把 asset:// URL 还原为相对路径，保证 HTML 文件可随 assets 目录分发。
 *  前缀同时兼容两种 convertFileSrc 形态（P2-13）：Windows/WebView2 的
 *  https?://asset.localhost/ 与 macOS/Linux 的 asset://localhost/
 *  （与 WangEditorEngine.htmlToDisk 同一口径） */
function deAssetify(html: string, docPath: string): string {
  const dir = docPath.replace(/[\\/][^\\/]*$/, '');
  return html.replace(/(?:https?:\/\/asset\.localhost|asset:\/\/localhost)\/([^"' )]+)/g, (_m, enc) => {
    try {
      const abs = decodeURIComponent(enc).replace(/\//g, '\\');
      if (abs.toLowerCase().startsWith(dir.toLowerCase())) {
        return abs.slice(dir.length + 1).replaceAll('\\', '/');
      }
      return abs.replaceAll('\\', '/');
    } catch {
      return enc;
    }
  });
}

async function doExportHtml() {
  const tab = tabs.activeTab;
  if (!tab) return;
  if (tabs.activeIsPreview) {
    editor.showToast(t('workbench.toast.previewNoExportHtml'), 'info');
    return;
  }
  // 代码 / html / svg 标签没有渲染 HTML 来源（与 canExportHtml 口径一致：仅 md/mh 可导出）
  if (usesCodeEngine.value || isMarkupTab.value) {
    editor.showToast(t('workbench.toast.codeNoExport'), 'info');
    return;
  }
  if (exportingWord.value) return; // 与 Word/PDF 导出共用任务级互斥锁
  exportingWord.value = true;
  try {
    const out = await pickSaveTarget(
      t('toolbar.exportHtml'),
      exportTargetName(tab.path ?? t('workbench.untitledMd'), 'html'),
      'html',
      exportStartDir(),
    );
    if (!out) return;
    editor.showToast(t('workbench.toast.exporting'), 'info');
    let body: string;
    if (isMhTab.value) {
      // D8：mh 导出 HTML——来源 = tab.content（磁盘态，图片已是相对路径，deAssetify 空转）
      body = tab.content;
    } else {
      body = editor.previewHtml || '';
    }
    const html = deAssetify(wrapExportHtml(body), tab.path ?? t('workbench.untitledMd'));
    const written = await exportHtml(html, out);
    editor.showToast(t('workbench.toast.exported', { path: written }), 'success');
  } catch (err) {
    editor.showToast(t('workbench.toast.exportFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
  } finally {
    exportingWord.value = false;
  }
}

/** 导出 Word 中（防重入锁）：Toolbar trigger loading + 菜单项禁用 + 二次点击忽略 */
const exportingWord = ref(false);

/** Word 导出（R1/R2；2026-10-13 增社区引擎试点）：
 *  md + wordExportEngine='community' → mdToDocxCommunity 直接吃 md 原文（原生公式/语法高亮）；
 *  其余（md 内置 / mh 全部）→ HTML 快照 → htmlToDocx（docx 包懒加载）→ exportDocx（写入选择器目标路径） */
async function doExportWord() {
  const tab = tabs.activeTab;
  if (!tab || tabs.activeIsPreview) return;
  if (exportingWord.value) return;
  exportingWord.value = true;
  try {
    const target = await pickSaveTarget(
      t('toolbar.exportWord'),
      exportTargetName(tab.path ?? t('workbench.untitledMd'), 'docx'),
      'docx',
      exportStartDir(),
    );
    if (!target) return;
    editor.showToast(t('workbench.toast.exporting'), 'info');
    const style: WordStyleOpts = {
      fontZh: settings.settings.wordFontZh,
      fontEn: settings.settings.wordFontEn,
      fontSize: settings.settings.wordFontSize,
    };
    if (!isMhTab.value && settings.settings.wordExportEngine === 'community') {
      if (!tab.content.trim()) {
        editor.showToast(t('workbench.toast.wordExportEmpty'), 'error');
        return;
      }
      // 文档目录：解析相对路径图片（./assets/…）的基准
      const baseDir = tab.path?.replace(/[\\/][^\\/]*$/, '') || undefined;
      // ★ 转换/导出模块一律点开导出才动态取：mdToDocxCommunity 静态引用 mdRendererConfig，
      //   留着静态 import 就等于把 mermaid+katex+hljs（约 900KB min）钉死在首屏 chunk 里
      const { mdToDocxCommunity } = await import('../convert/mdToDocxCommunity');
      const { blob, warnings } = await mdToDocxCommunity(tab.content, style, baseDir);
      const data = new Uint8Array(await blob.arrayBuffer());
      const out = await exportDocx(data, target);
      if (out) {
        editor.showToast(
          warnings.length
            ? `${t('workbench.toast.exported', { path: out })}（${t('workbench.toast.wordCommunityWarned', { n: warnings.length })}）`
            : t('workbench.toast.exported', { path: out }),
          'success',
        );
      }
      return;
    }
    let html: string;
    if (isMhTab.value) {
      html = wangEngineRef.value?.getDisplayHtml?.() ?? tab.content;
    } else {
      // md：等导出宿主渲染完成（mermaid/katex/图片）再取快照
      html = (await mdEngineRef.value?.getExportPreviewHtml?.()) ?? editor.previewHtml ?? '';
    }
    if (!html.trim()) {
      editor.showToast(t('workbench.toast.wordExportEmpty'), 'error');
      return;
    }
    const { htmlToDocx } = await import('../convert/htmlToDocx');
    const { blob, degradedFormulas, failedImages } = await htmlToDocx(html, style);
    const data = new Uint8Array(await blob.arrayBuffer());
    const out = await exportDocx(data, target);
    if (out) {
      const extra: string[] = [];
      if (degradedFormulas > 0) extra.push(t('workbench.toast.wordFormulaDegraded', { n: degradedFormulas }));
      if (failedImages > 0) extra.push(t('workbench.toast.wordImageFailed', { n: failedImages }));
      editor.showToast(
        extra.length
          ? `${t('workbench.toast.exported', { path: out })}（${extra.join('；')}）`
          : t('workbench.toast.exported', { path: out }),
        failedImages > 0 ? 'info' : 'success',
      );
    }
  } catch (err) {
    editor.showToast(t('workbench.toast.exportFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
  } finally {
    exportingWord.value = false;
  }
}

/** PDF 导出（2026-10-13；Edge 打印引擎版）：md → 导出宿主 innerHTML 快照；mh → getDisplayHtml() 显示态 HTML。
 *  两路 → buildPrintDocument 自包含化（样式/字体/图片全内联，复用 .mk-export-host 打印结构）
 *  → exportPdf（Rust 调系统 Edge headless --print-to-pdf：矢量文字型 PDF + CSS 完整保真 + 智能分页）。
 *  与 doExportWord 共用 exportingWord 互斥锁（同一任务级导出语义） */
async function doExportPdf() {
  const tab = tabs.activeTab;
  if (!tab || tabs.activeIsPreview) return;
  if (exportingWord.value) return;
  exportingWord.value = true;
  try {
    const target = await pickSaveTarget(
      t('toolbar.exportPdf'),
      exportTargetName(tab.path ?? t('workbench.untitledMd'), 'pdf'),
      'pdf',
      exportStartDir(),
    );
    if (!target) return;
    // 过渡提示：mermaid 渲染 + 样式/字体内联 + Edge 打印共数秒，先给 toast + 按钮 loading
    editor.showToast(t('workbench.toast.exporting'), 'info');
    let html: string;
    if (isMhTab.value) {
      html = wangEngineRef.value?.getDisplayHtml?.() ?? tab.content;
    } else {
      // md：等导出宿主渲染完成（mermaid/katex/图片）再取快照（与 Word 导出同链路）
      html = (await mdEngineRef.value?.getExportPreviewHtml?.()) ?? editor.previewHtml ?? '';
    }
    if (!html.trim()) {
      editor.showToast(t('workbench.toast.wordExportEmpty'), 'error');
      return;
    }
    const { buildPrintDocument } = await import('../convert/printDoc');
    const printDoc = await buildPrintDocument(html);
    const out = await exportPdf(printDoc, target);
    editor.showToast(t('workbench.toast.exported', { path: out }), 'success');
  } catch (err) {
    editor.showToast(t('workbench.toast.exportFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
  } finally {
    exportingWord.value = false;
  }
}

/** Word 反转入口（R3/R4）：直接打开转换操作页。
 *  弹窗内拖入/选择文件开始转换；激活标签为 docx 预览时由 source-path 预设直转。
 *  并发守卫（V3）：转换进行中忽略二次触发并 toast */
const wordConvert = ref<{ visible: boolean; target: 'md' | 'mh' }>({
  visible: false,
  target: 'md',
});
function openWordConvert(target: 'md' | 'mh') {
  if (wordConvert.value.visible) {
    editor.showToast(t('workbench.wordConvert.convertingBusy'), 'info');
    return;
  }
  wordConvert.value = { visible: true, target };
}

async function doPrintPdf() {
  if (tabs.activeIsPreview) {
    editor.showToast(t('workbench.toast.previewNoPrint'), 'info');
    return;
  }
  // 代码 / HTML 标签不实现 exportPdf（无打印宿主），给出明确提示而非静默；.mh 引擎自带导出
  if (usesCodeEngine.value) {
    editor.showToast(t('workbench.toast.codeNoExport'), 'info');
    return;
  }
  // 打印 PDF：引擎内官方 ExportPDF 的 trigger（window.print + 官方 @media print 裁剪，
  // 打印范围 = #export-pdf-preview 导出预览体）。编辑/分栏/阅读三态通用。
  try {
    await engineRef.value?.exportPdf?.();
  } catch (err) {
    editor.showToast(t('workbench.toast.printFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
  }
}

/** 编辑区右键菜单：引擎在 contextmenu 上报点击处载荷 → 组件唤起菜单；
 *  表格组回传 onTableOp（按光标执行行/列/规整），格式组回传 onFormatFromMenu（与快捷键同源分发），
 *  刷新转交 TabBar（脏确认与重读链路都在那边）。 */
const editorCtx = ref<EditorCtxPayload | null>(null);
/** 唤起菜单那一刻的全屏快照：菜单首项据此显示「全屏」或「退出全屏」。
 *  三处真相源不同（md 编辑/分栏在内核挂的 .md-editor-fullscreen、md 阅读态与 .mh 在引擎 ref、
 *  代码引擎与预览类在 store 的 pageFull），故按引擎各取各的，取一次即可——菜单项点完即收菜单。 */
const ctxPageFull = ref(false);
function onEditorContext(payload: EditorCtxPayload): void {
  ctxPageFull.value = editor.pageFull || engineRef.value?.isPageFullscreen?.() === true;
  editorCtx.value = payload;
}

/** ←/→ 同目录轮换：预览类（图片/PDF/Word/Excel）恒可用；文本类任何视图都可切，
 *  但焦点在正文编辑区时 onKeydown 放行——方向键归光标。编辑/分栏态点开预览、
 *  工具栏或空白处（编辑区失焦）后即可左右翻文件。 */
function siblingNavOn(): boolean {
  const tab = tabs.activeTab;
  if (!tab?.path || !settings.settings.siblingNav) return false;
  if (isPreviewKind(tab.kind)) return true;
  // 'text' 是旧会话快照遗留的 kind（新打开不再产生），按 code 处理
  return (
    tab.kind === 'md' ||
    tab.kind === 'mh' ||
    tab.kind === 'html' ||
    tab.kind === 'svg' ||
    tab.kind === 'code' ||
    tab.kind === 'text'
  );
}

const navPathKey = (p: string): string => p.replace(/\//g, '\\').toLowerCase();
const navSame = (a: string, b: string): boolean => a === b || navPathKey(a) === navPathKey(b);
const navDirOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '');

/** 列表按「目录 + 当前标签种类」缓存；目录内增删不实时——切到的文件不在列表里时重拉一次 */
let navCacheKey = '';
let navList: string[] = [];
let navBusy = false;

async function navSiblings(path: string, refresh = false): Promise<string[]> {
  const key = `${navDirOf(path)}\u0000${tabs.activeTab?.kind ?? ''}`;
  if (!refresh && key === navCacheKey) return navList;
  try {
    const list = await listSiblingFiles(path);
    navCacheKey = key;
    navList = list;
    return list;
  } catch {
    return []; // 失败不写缓存：下次按键重试（授权/瞬时 IO 问题恢复后仍能切）
  }
}

/** 沿用当前标签切到同族相邻文件（到头回绕），不新开标签；
 *  目标已开在别的标签里则直接激活，避免同路径两份。
 *  文本类要先读盘再落值；有未保存修改时不切，免得静默丢改动。 */
async function stepSibling(step: 1 | -1): Promise<void> {
  const tab = tabs.activeTab;
  if (!tab?.path || navBusy || !siblingNavOn()) return;
  navBusy = true;
  try {
    let list = await navSiblings(tab.path);
    let idx = list.findIndex((p) => navSame(p, tab.path!));
    if (idx < 0) {
      // 缓存里没有当前文件（刚被删/改名，或换了标签）：重拉一次再找
      list = await navSiblings(tab.path, true);
      idx = list.findIndex((p) => navSame(p, tab.path!));
    }
    if (idx < 0 || list.length < 2) return;
    const next = list[(idx + step + list.length) % list.length];
    if (navSame(next, tab.path)) return;
    const existing = tabs.tabs.find((t) => t.id !== tab.id && t.path && navSame(t.path, next));
    if (existing) {
      tabs.activate(existing.id);
      return;
    }
    if (isPreviewKind(tab.kind)) {
      // 预览类只换路径/标题：组件按新路径自取字节（模板 key 含 path，旧的在途加载随卸载作废）
      tabs.updateTab(tab.id, { path: next, title: baseName(next) });
      void syncTreeToActiveTab();
      return;
    }
    if (tab.isDirty) {
      editor.showToast(t('workbench.toast.siblingDirty'), 'info');
      return;
    }
    const file = await readFile(next);
    // 读盘期间标签可能已被切走/关闭：只在它仍是当前标签时落值
    if (tabs.activeTab?.id !== tab.id) return;
    tabs.updateTab(tab.id, {
      path: next,
      title: baseName(next),
      content: file.content,
      savedContent: file.content,
      isDirty: false,
      encoding: file.encoding,
      hadBom: file.hadBom,
      isUtf8: file.isUtf8,
      cursorLine: 1,
    });
    // 引擎常驻，滚动位置不会随换文档自己归零：下一份文档从头开始
    await nextTick();
    engineRef.value?.scrollToTop?.();
    void syncTreeToActiveTab();
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    navBusy = false;
  }
}

/** 帧内方向键（HtmlFrame 注入 / SvgFrame 同源监听）转成切换请求 */
function onFrameSiblingStep(step: 1 | -1): void {
  if (!siblingNavOn()) return;
  void stepSibling(step);
}

function onTableOp(op: 'insert' | TableOp): void {
  editorCtx.value = null;
  if (op === 'insert') {
    engineRef.value?.insertTable?.();
    engineRef.value?.focusEditor?.();
    return;
  }
  // 等宽对齐仅适用于窄表（菜单已置灰兜底）：宽表补列宽会撑出数百字符行，直接降级提示
  if (!engineRef.value?.tableOp?.(op)) {
    editor.showToast(t('workbench.toast.tableAlignUnavailable'), 'info');
    return;
  }
  engineRef.value?.focusEditor?.(); // 菜单项点完焦点在按钮上，交还编辑区才能接着打字
}

/** 右键「刷新」：收掉菜单后转交 TabBar——脏文档丢弃确认与 reloadTab 链路都在那里，避免复制一份 */
function onCtxRefresh(): void {
  editorCtx.value = null;
  tabBarRef.value?.reloadActive();
}

/** 右键「导出为图片」（SVG 预览窗格）：按当前「适应窗口」那一档的画幅栅格化成 PNG，
 *  再选保存位置并写盘。不给 HTML——那份跑在 opaque origin 沙箱里，父页取不到它的画面。 */
/** 导出 PNG 中（防重入）：连点会叠两个选择器，与 doExportWord 的 exportingWord 同策 */
const exportingPng = ref(false);

async function onCtxExportPng(): Promise<void> {
  editorCtx.value = null;
  const tab = tabs.activeTab;
  if (!tab || !svgFrameRef.value || exportingPng.value) return;
  exportingPng.value = true;
  try {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await svgFrameRef.value.exportPng();
    } catch (err) {
      // 图里引用了外部位图 / 外链字体时 canvas 被判脏，toBlob 抛 SecurityError：同源策略，绕不过
      editor.showToast(
        t('workbench.toast.exportFailed', { msg: err instanceof Error ? err.message : String(err) }),
        'error',
      );
      return;
    }
    // 设计尺寸还没定出来（面板当时还没布局完）——不能闷着不响，那就又是"点了没反应"
    if (!bytes) {
      editor.showToast(t('workbench.toast.exportNotReady'), 'info');
      return;
    }
    const target = await pickSaveTarget(
      t('workbench.ctx.exportPng'),
      exportTargetName(tab.path ?? tab.title, 'png'),
      'png',
      exportStartDir(),
    );
    if (!target) return;
    const out = await exportPng(bytes, target);
    editor.showToast(t('workbench.toast.exported', { path: out }), 'success');
  } catch (err) {
    editor.showToast(
      t('workbench.toast.exportFailed', { msg: err instanceof Error ? err.message : String(err) }),
      'error',
    );
  } finally {
    exportingPng.value = false;
  }
}

/** 右键图片预览「复制图片」：读字节 → png 原样交出去、其余先转 PNG → 写系统剪贴板，
 *  贴进 Word / 微信就是当截图用。失败一律报出来别闷着（剪贴板要前台焦点，被拦了就写清楚）。
 *  ★ 不复用面板里那个 `<img>`：它从 asset:// 加载，一进 canvas 就被判脏、toBlob 抛 SecurityError，
 *    所以走"读字节 → Blob → createImageBitmap"这条同源路，见 utils/clipboardImage.ts */
async function onCtxCopyImage(): Promise<void> {
  editorCtx.value = null;
  const path = tabs.activeTab?.path;
  if (!path) return;
  try {
    await copyImageFile(path);
    editor.showToast(t('workbench.toast.imageCopied'), 'success');
  } catch (err) {
    editor.showToast(
      t('workbench.toast.imageCopyFailed', { msg: err instanceof Error ? err.message : String(err) }),
      'error',
    );
  }
}

/** 右键「专注模式」：视图级开关，状态落设置文件（跨文档保持），点完即收菜单 */
function onToggleFocusMode(): void {
  editorCtx.value = null;
  settings.update({ focusMode: !settings.settings.focusMode });
}

/** 右键「显示行号」：同上，切换只影响 engine-root 上的 class，不打断输入与撤销栈 */
function onToggleLineNumbers(): void {
  editorCtx.value = null;
  settings.update({ showLineNumbers: !settings.settings.showLineNumbers });
}

/** 右键「自动换行」：代码引擎重配一个 Compartment，光标与撤销栈都不动。
 *  默认关（长行横向滚动），且只给代码引擎——md 编辑窗格的换行由 md-editor-v3 恒开，
 *  这一项对 md/.mh 都不出现（见 EditorCtxMenu） */
function onToggleWordWrap(): void {
  editorCtx.value = null;
  settings.update({ codeLineWrap: !settings.settings.codeLineWrap });
}

/** 文件内查找（Ctrl+F 与代码页右键「搜索代码」共用一条链路：面板已开时=切到文件内模式） */
function openFileFind(): void {
  if (!tabs.activeTab) {
    editor.showToast(t('workbench.toast.openBeforeFind'), 'info');
    return;
  }
  hubMode.value = 'file';
  search.open();
}

/** 右键「搜索」：代码页的「搜索代码」与阅读态的「搜索」同一个入口（文案按上下文取） */
function onCtxSearch(): void {
  editorCtx.value = null;
  openFileFind();
}

/** 右键「复制代码」：选区优先、无选区取全文（口径在代码引擎的 copyScopeText） */
async function onCtxCopyCode(): Promise<void> {
  editorCtx.value = null;
  const text = engineRef.value?.copyScopeText?.() ?? '';
  if (!text) {
    editor.showToast(t('workbench.toast.codeEmpty'), 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    editor.showToast(t(isPlainTextTab.value ? 'workbench.toast.textCopied' : 'workbench.toast.codeCopied'), 'success');
  } catch {
    // WebView 剪贴板 API 被拒时给明确出路，别让人对着没反应的菜单猜
    editor.showToast(t('workbench.toast.clipboardBlocked', { k: modHint('C') }), 'error');
  }
}

/** 右键「粘贴代码」：剪贴板文本插到光标处，走 CM6 单事务 → Ctrl+Z 一步整体撤回 */
async function onCtxPasteCode(): Promise<void> {
  editorCtx.value = null;
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    editor.showToast(t('workbench.toast.clipboardBlocked', { k: modHint('V') }), 'error');
    return;
  }
  if (!text) {
    editor.showToast(t('workbench.toast.clipboardEmpty'), 'info');
    return;
  }
  engineRef.value?.insert(text);
}

/** 右键「复制全文」（阅读态）：取文口径在引擎——md 给 Markdown 源码（粘出去仍可编辑），
 *  .mh 给渲染后的纯文本（HTML 源码对读者没用）。选区复制不必给：只读正文本就能直接选中，Ctrl+C 是原生的 */
async function onCtxCopyAll(): Promise<void> {
  editorCtx.value = null;
  const text = engineRef.value?.copyAllText?.() ?? '';
  if (!text) {
    editor.showToast(t('workbench.toast.codeEmpty'), 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    editor.showToast(t('workbench.toast.docCopied'), 'success');
  } catch {
    editor.showToast(t('workbench.toast.clipboardBlocked', { k: modHint('C') }), 'error');
  }
}

/** 右键「编辑 / 分栏」（阅读态）：模式真相源在本层，与 Alt+E / Alt+W 同一套 setMode（含 .mh 禁分栏的守卫） */
function onCtxMode(mode: EditorMode): void {
  editorCtx.value = null;
  setMode(mode);
}

/** 右键「版式」：写设置的 readLayout，与设置面板「内容版式」同一字段；只改 CSS 变量，不重建编辑器 */
function onCtxLayout(layout: ReadLayout): void {
  editorCtx.value = null;
  void settings.update({ readLayout: layout });
}

/** 右键「预览工具条」三档：图片 / HTML / SVG 共用这一份状态，写进设置跨重启保持。
 *  切到 hidden 后浮块连 hover 都不出、Tab 也够不到——唯一的出口就是这条菜单，
 *  所以图片预览面板也接进了同一套右键（见 ImagePreview 根节点的 contextmenu） */
function onCtxBarMode(mode: PreviewBarMode): void {
  editorCtx.value = null;
  void settings.update({ previewBarMode: mode });
}

/** 右键「回到默认位置」：与浮块上双击空白处同一条落位口径（都取 DEFAULT_SETTINGS） */
function onCtxBarReset(): void {
  editorCtx.value = null;
  void settings.update({
    previewBarX: DEFAULT_SETTINGS.previewBarX,
    previewBarBottom: DEFAULT_SETTINGS.previewBarBottom,
  });
}

/** 右键「格式化」（SVG 源码）：动作与 Ctrl+Shift+F 同一个 beautifyActive */
function onCtxFormatMarkup(): void {
  editorCtx.value = null;
  beautifyActive();
}

// ---------- 快捷键 ----------
/** CM6 编辑器是否持有焦点（v7 内核 = .cm-editor.cm-focused；CM5 的 .CodeMirror-focused 类已不存在） */
const isEditorFocused = () => !!document.querySelector('.cm-editor.cm-focused');

/** 格式类快捷键可编辑前提：文本/HTML 标签 + 非阅读态（MdEditor 已挂载）；阅读态给出明确提示 */
function engineEditable(): boolean {
  if (!tabs.activeTab || tabs.activeIsPreview) return false;
  if (editor.mode === 'read') {
    editor.showToast(t('workbench.toast.readonlyMode'), 'info');
    return false;
  }
  return true;
}

/**
 * 格式类快捷键分发（返回 true = 事件已消费）。
 * 焦点在编辑器内：Ctrl+B/I、Ctrl+1~6、Ctrl+Shift+C 由内核 keymap 原生处理——此时绝不能
 * preventDefault（CM6 runHandlers 见 defaultPrevented 即跳过，拦了反而无响应），直接放行。
 * 焦点在外：内核 keymap 只监听 CM 自身 DOM，按键会落空——由应用层接管，经引擎写入同一保存链路。
 * 特例：Ctrl+K 内核无绑定（内核链接键是 Ctrl+L）；Ctrl+Shift+I 内核走上传弹窗——两者统一由应用层处理，
 * 保证行为与设置面板说明一致。
 */
/** 执行格式动作：右键菜单与快捷键共用这一条分发。
 *  包裹型走内核 insert（无选区补占位文本），标题与块级走引擎逐行改写。
 *  id 归属用 in 判定，末支即块级档（引用/无序/有序/任务/正文）。
 *  refocus 仅菜单路径开启：键盘路径原先不动焦点，Ctrl+B 落在搜索框等处时不该被抢走 */
function runFormat(id: FormatId, refocus = false): void {
  if (!engineEditable()) return;
  const engine = engineRef.value;
  if (id in WRAP_ACTIONS) {
    const wrap = WRAP_ACTIONS[id as WrapActionId];
    // 有选区 → 包裹选区；无选区且所在行非空 → 包裹整行；空行 → 补示例文字（引擎已把示例置于选中态）
    engine?.wrapSelection?.(wrap.prefix, wrap.suffix, t(wrap.placeholderKey));
  } else if (id in HEADING_LEVELS) {
    engine?.setHeading?.(HEADING_LEVELS[id as HeadingId], t(HEADING_EXAMPLE_KEY));
  } else {
    const exampleKey = BLOCK_EXAMPLE_KEYS[id as BlockFormatKind];
    engine?.setBlockFormat?.(id as BlockFormatKind, exampleKey ? t(exampleKey) : undefined);
  }
  if (refocus) engine?.focusEditor?.();
}

/** 右键菜单格式项：执行后把焦点还给编辑区 */
function onFormatFromMenu(id: FormatId): void {
  runFormat(id, true);
}

function handleFormatShortcut(e: KeyboardEvent, k: string): boolean {
  // 代码 / HTML / 富文本标签：格式键全部交还内核/浏览器，不做 Markdown 包裹（防止把源码包进 ** 等）
  if (usesCodeEngine.value || isMhTab.value) return false;
  const kernelBound =
    (!e.shiftKey && (k === 'b' || k === 'i' || (k >= '1' && k <= '6'))) ||
    (e.shiftKey && k === 'c');
  if (kernelBound && isEditorFocused()) return false;

  const run = (id: FormatId): true => {
    e.preventDefault();
    runFormat(id);
    return true;
  };
  if (!e.shiftKey) {
    if (k === 'b') return run('bold');
    if (k === 'i') return run('italic');
    if (k === 'k') return run('link');
    if (k >= '1' && k <= '6') return run(`h${k}` as HeadingId);
  } else {
    if (k === 'c') return run('codeBlock');
    if (k === 'i') return run('image');
  }
  return false;
}

function onKeydown(e: KeyboardEvent) {
  const ctrl = e.ctrlKey || e.metaKey;
  // ←/→：同目录同族轮换。正文编辑区有焦点时一律放行（方向键归光标），编辑/分栏态
  // 失焦后即可翻文件；输入控件、搜索/设置浮层、右键菜单里的方向键也归它们自己
  //（iframe 焦点由帧内转发上来）
  if (
    !ctrl && !e.altKey && !e.shiftKey &&
    (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
    !e.defaultPrevented && !e.isComposing
  ) {
    const tgt = e.target as HTMLElement | null;
    if (
      siblingNavOn() &&
      !isEditorFocused() &&
      !tgt?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]') &&
      !document.querySelector('.mask, .hub, .mk-menu')
    ) {
      e.preventDefault();
      void stepSibling(e.key === 'ArrowRight' ? 1 : -1);
    }
    return;
  }
  // Ctrl+Tab：开合工作区侧栏（与工具栏那颗按钮同一个函数）。Mac 上 ⌘Tab 被系统截去
  // 切程序，实际只有 Ctrl 能到这里。按 e.code 匹配——Tab 的 code 恒为 'Tab'，不受输入法影响
  if (ctrl && e.code === 'Tab' && !e.altKey) {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  // 模式快捷键：Alt+E 编辑 / Alt+W 分栏 / Alt+R 阅读。
  // Mac 的 Option+字母是死字符输入（e.key 变 '´' 等），必须按 e.code 匹配物理键位
  if (e.altKey && !ctrl) {
    const codeMap: Record<string, string> = { KeyE: 'e', KeyW: 'w', KeyR: 'r' };
    const ak = codeMap[e.code] ?? e.key.toLowerCase();
    if (ak === 'e') { e.preventDefault(); setMode('edit'); return; }
    if (ak === 'w') { e.preventDefault(); setMode('split'); return; }
    if (ak === 'r') { e.preventDefault(); setMode('read'); return; }
    return;
  }
  if (!ctrl) {
    if (e.key === 'F1') {
      e.preventDefault();
      showSettings.value = !showSettings.value;
      return;
    }
    if (e.key === 'F2') {
      // 重命名就近派发：最近交互在目录树且选中了非根节点 → 重命名树节点（与树右键同一对话框）；
      // 其余情况重命名当前标签（无路径的新文档由 TabBar 忽略）。一句 F2 只作用于看得见的那一层
      e.preventDefault();
      if (fileTreeRef.value?.renameSelected?.()) return;
      tabBarRef.value?.renameActive();
      return;
    }
    if (e.key === 'F11') {
      // 编辑器全屏（页面内全屏，同工具栏 pageFullscreen）：阻止 WebView 原生全屏。
      // 编辑/阅读两态都可用（对齐 md pageFullscreen），全屏态强制显示功能区
      e.preventDefault();
      toggleFullscreen();
      return;
    }
    // Shift+F：目录树按名称过滤（跨平台统一，Mac=⇧F；⌘⇧F 已被美化占用故不带 Cmd）。
    // 按 e.code 匹配防中文输入法 e.key 异化；焦点在编辑器/输入框时放行——此时 Shift+F 是正常的大写 F 输入
    if (e.shiftKey && e.code === 'KeyF' && !e.altKey) {
      const tgt = e.target as HTMLElement | null;
      const inEditable = isEditorFocused() || !!tgt?.closest?.('input, textarea, [contenteditable="true"]');
      if (inEditable) return;
      e.preventDefault();
      if (sidebarVisible.value) {
        fileTreeRef.value?.openFilter();
      } else {
        // 侧栏已隐藏：先展开，等挂载完成后开过滤
        sidebarVisible.value = true;
        void nextTick(() => fileTreeRef.value?.openFilter());
      }
      return;
    }
    return;
  }
  const k = e.key.toLowerCase();
  if (handleFormatShortcut(e, k)) return;
  // Ctrl+Shift+N/O/M/H：新建工作区 / 打开工作区 / Word 转 MD / Word 转 MH。
  // 这几个都会再开一层弹窗，已有遮罩（选择器/对话框）时不叠加
  if (e.shiftKey && !e.altKey && (k === 'n' || k === 'o' || k === 'm' || k === 'h')) {
    if (document.querySelector('.mask')) return;
    e.preventDefault();
    if (k === 'n') void createWorkspace();
    else if (k === 'o') openWorkspace();
    else openWordConvert(k === 'm' ? 'md' : 'mh');
    return;
  }
  if (k === 's') {
    // 编辑器内核已处理编辑态 Ctrl+S；这里兜底（阅读态/焦点在外时）
    if (editor.mode !== 'edit' || !isEditorFocused()) {
      e.preventDefault();
      void saveActive();
    }
    return;
  }
  if (k === 'w') {
    // Ctrl+W 关闭当前标签 / Ctrl+Shift+W 关闭全部（与标签右键菜单同链路，脏页统一确认）
    e.preventDefault();
    if (e.shiftKey) {
      if (tabs.tabs.length > 0) void requestCloseBatch(tabs.tabs.map((t) => t.id));
    } else if (tabs.activeTab) {
      void requestCloseTab(tabs.activeTab.id);
    }
    return;
  }
  if (k === 'n') { e.preventDefault(); newFromTemplate(TEMPLATES[0]); return; }
  if (k === 'o') { e.preventDefault(); void openFileByDialog(); return; }
  if (k === 'f' && !e.altKey) {
    e.preventDefault();
    if (e.shiftKey) {
      beautifyActive(); // Ctrl+Shift+F 美化 Markdown
      return;
    }
    // Ctrl+F：文件内查找（面板已开时=切到文件内模式）
    openFileFind();
    return;
  }
  if (k === 'p') {
    e.preventDefault();
    hubMode.value = 'global'; // Ctrl+P：全局搜索（面板已开时=切到全局模式）
    search.open();
    return;
  }
  // 字号键鼠同源：Ctrl+= 放大一档 / Ctrl+- 缩小一档 / Ctrl+0 回默认，一档 0.5px，与 Ctrl+滚轮同向同量。
  // 一律按 e.code 匹配物理键位：Mac 上 ⌘+ 实为 ⌘⇧=（e.key 会变成 '+'），中文输入法下 e.key 也会异化
  if (e.code === 'Equal' || e.code === 'NumpadAdd') {
    e.preventDefault();
    changeFont(FONT_STEP);
    editor.showToast(t('toolbar.fontZoomTip', { n: settings.settings.fontSize }), 'info');
    return;
  }
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
    e.preventDefault();
    changeFont(-FONT_STEP);
    editor.showToast(t('toolbar.fontZoomTip', { n: settings.settings.fontSize }), 'info');
    return;
  }
  if (e.code === 'Digit0' || e.code === 'Numpad0') {
    e.preventDefault();
    resetFont();
    return;
  }
}

// ---------- 窗口关闭保护（P0-11） ----------
let forceClose = false;
async function onCloseRequested(e: { preventDefault: () => void }) {
  if (forceClose) return;
  if (tabs.dirtyCount > 0) {
    e.preventDefault();
    closeConfirm.value = { visible: true, tabId: null, batchIds: null };
  }
}
async function confirmCloseWindow(action: 'discard' | 'cancel') {
  if (action === 'cancel') {
    closeConfirm.value = { visible: false, tabId: null, batchIds: null };
    return;
  }
  forceClose = true;
  // 用户已明确放弃脏草稿：快照剔除脏页后再落盘，防止"已放弃的内容"重启后还魂
  await flushSessionSnapshot({ dropDirty: true });
  await getCurrentWebviewWindow().destroy();
}

/** 关窗口确认（对话框承诺"保存全部并退出"，P1-1）：先遍历全部可保存脏标签
 *  （isDirty && path && isUtf8）落盘；任一变失败 → 提示并中止关闭（留在窗口，
 *  标签与草稿俱在，用户可改用单标签保存/另存处理）；全部成功后再走丢弃路径关闭。 */
async function confirmCloseWindowSaveAll() {
  closeConfirm.value = { visible: false, tabId: null, batchIds: null };
  for (const tab of tabs.tabs) {
    if (!tab.isDirty || !tab.path || !tab.isUtf8) continue;
    try {
      await writeFileAtomic(tab.path, tab.content, tab.hadBom);
      tabs.markSaved(tab.id, tab.content);
    } catch (err) {
      editor.showToast(t('workbench.toast.saveFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
      return; // 中止关闭：不调 confirmCloseWindow，草稿快照也不剔除
    }
  }
  await confirmCloseWindow('discard');
}

// ---------- 拖拽文件到窗口打开（阅读模式） ----------
// Tauri v2 默认 dragDropEnabled=true 会拦截原生 HTML5 DnD，必须走 onDragDropEvent
let unlistenDrop: (() => void) | null = null;
function onDragDrop(ev: { payload: { type: string; paths?: string[] } }) {
  // 转换弹窗打开时让位：拖拽由弹窗内拖拽区接管（docx 转换源），不触发打开文件
  if (wordConvert.value.visible) return;
  if (ev.payload.type !== 'drop' || !ev.payload.paths) return;
  const paths = ev.payload.paths;
  // 能不能在应用内打开一律问后端（routeByType），这里不再抄一份扩展名白名单——
  // 那份名单曾把 docx/xlsx/图片/PDF 挡在门外，而它们在目录树里点击是能开预览的。
  void (async () => {
    const texts: string[] = [];
    let rejected = 0;
    for (const p of paths) {
      const r = await routeByType(p, false);
      if (r === 'text') texts.push(p);
      // 'handled' = 预览标签已由 routeByType 开好；只有应用内真开不了的才计数
      else if (r === 'rejected') rejected += 1;
    }
    if (rejected > 0)
      editor.showToast(t('workbench.toast.skippedUnopenable', { n: rejected }), 'info');
    if (texts.length === 0) return;
    // 拖入默认模式：首个文件为源码类（html/svg/代码）→ 编辑态；Markdown/TXT → 阅读态
    editor.setMode(opensInEdit(texts[0]) ? 'edit' : 'read');
    // skipTypeCheck：分流刚做过，不必重复探测
    for (const p of texts) await openFilePath(p, opensInEdit(p) ? 'edit' : 'read', true);
  })();
}

// ---------- 「打开方式」/ 双击关联文件 ----------
// Windows：启动参数 / 单实例插件转发；macOS：Finder 递交的 Apple Event（RunEvent::Opened）。
// 两条通路都由 Rust 统一派发——前端就绪前入队、挂载后经命令取走；就绪后走 open-file-args 事件。
/** 外部打开（资源管理器双击、文件关联、命令行带路径）都走这一条。
 *  ★ 图片按「查看器」用：直接进页面全屏，别让人先看见编辑器外壳再自己按 F11。
 *    只挂这一条路径——从目录树或标签里点图片仍按当前形态显示，
 *    否则在工作区里瞄一眼图就把整个壳全屏掉，回不去。 */
async function openArgsFiles(paths: string[]) {
  if (!paths?.length) return;
  for (const p of paths) await openFilePath(p);
  if (tabs.activeTab?.kind === 'image') editor.pageFull = true;
}
let unlistenOpenArgs: (() => void) | null = null;

// ---------- 生命周期 ----------
onMounted(async () => {
  await settings.load();
  editor.setMode(settings.settings.editorMode);
  // 空闲预载三引擎 chunk（~280KB gzip 的 wangEditor 那条已有，2026-10-20 补齐另外两个）：
  // 首屏只下载外壳，内核改成点开文档时才按需取——那一下最容易被感知（md 栈 2.2MB min，
  // 求值要几百毫秒）。放到空闲切片里预载，既消掉「欢迎页首次打开文档」的首切延迟，
  // 又不跟启动抢主线程；会话已恢复出对应类型标签时引擎早已挂载，这几行就是空转。
  const idlePreload = (cb: () => void) =>
    'requestIdleCallback' in window
      ? requestIdleCallback(cb, { timeout: 5000 })
      : (setTimeout(cb, 3000) as unknown as number);
  idlePreload(() => {
    void import('../adapters/MdEditorV3Engine.vue');
    void import('../adapters/CodeEditorEngine.vue');
    void import('../adapters/WangEditorEngine.vue');
  });
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('wheel', onFontWheel, { passive: false, capture: true });
  window.addEventListener('beforeunload', (e) => {
    if (tabs.dirtyCount > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  const win = getCurrentWebviewWindow();
  // ---- 启动收尾并行走（2026-10-20 启动提速 P1）----
  // 原先四段逐条 await：窗口事件注册 → 工作区全树遍历 → 会话标签逐个读盘 → 取启动参数。
  // 内容区只依赖第三段，工作区树晚到一点不过是目录树后填一帧，没必要让首屏排队等它。
  const listenersTask = (async () => {
    try {
      await win.onCloseRequested(onCloseRequested);
    } catch {
      /* 非 Tauri 环境忽略：不能让监听注册失败连累工作区与会话恢复 */
    }
    try {
      unlistenDrop = await win.onDragDropEvent(onDragDrop);
    } catch {
      /* 非 Tauri 环境（浏览器/无头验证）无此事件，忽略 */
    }
    try {
      // 二次点击关联文件：单实例插件转发的事件
      unlistenOpenArgs = await listen<string[]>('open-file-args', (e) => {
        void openArgsFiles(e.payload);
      });
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  })();
  const wsTask = settings.settings.lastWorkspace
    ? ws.openWorkspace(settings.settings.lastWorkspace).catch(() => {
        editor.showToast(t('workbench.toast.lastWsUnavailable'), 'info');
      })
    : Promise.resolve();
  // 会话恢复（更新重启/崩溃后还原标签页与未保存草稿）：干净页读盘，脏页用快照草稿
  const sessionTask = hydrateSession().catch(() => null);
  const hydrate = (await Promise.all([listenersTask, wsTask, sessionTask]))[2];

  if (hydrate?.restored) {
    applyActiveTabMode(hydrate.activeTab);
    // 恢复活动文本标签的光标位置（预览标签无编辑器，跳过）
    const at = hydrate.activeTab;
    if (at && at.cursorLine > 1 && !tabs.activeIsPreview) scrollToRestoredCursor(at.id, at.cursorLine);
  }
  // 树与会话并行后，首个恢复标签激活时 ws.root 可能还没落地（联动函数当时直接 return），
  // 这里补一次，保证目录树选中/展开跟得到位
  void syncTreeToActiveTab();
  // 首次启动带文件路径：工作区就绪后再开，标签落位更自然（激活参数文件为活动标签）
  try {
    await openArgsFiles(await takePendingOpenArgs());
  } catch {
    /* 非 Tauri 环境忽略 */
  }
  // 快照 watcher 最后启动：此后任何标签/内容变更都会防抖落盘
  startSessionSnapshot();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('wheel', onFontWheel, { capture: true });
  unlistenDrop?.();
  unlistenDrop = null;
  unlistenOpenArgs?.();
  unlistenOpenArgs = null;
  // 组件销毁时清掉未触发的提示定时器，避免回调访问已卸载的响应式状态
  for (const t of toasts.value) clearTimeout(t.timer);
  toasts.value = [];
});

// 编辑器模式与 editorStore 保持一致
watch(() => editor.mode, (m) => {
  const tab = tabs.activeTab;
  if (tab) tabs.updateTab(tab.id, { mode: m });
});
</script>

<template>
  <div class="workbench" :class="{ dark: settings.isDark }">
    <Toolbar
      :mode="editor.mode"
      :theme="settings.themeMode"
      :has-active="!!tabs.activeTab"
      :search-active="search.visible"
      :sidebar-hidden="!sidebarVisible"
      :code-tab="isCodeTab"
      :no-split="isMhTab"
      :exportable="canExportHtml"
      :printable="canPrintPdf"
      :exporting="exportingWord"
      :mode-bar-position="settings.settings.modeBarPosition"
      @toggle-sidebar="toggleSidebar"
      @open-file="openFileByDialog"
      @open-workspace="openWorkspace"
      @new-workspace="createWorkspace"
      @new="newFromTemplate(TEMPLATES[0])"
      @new-kernel="newKernelFile"
      @new-code="newCodeFile"
      @save="saveActive"
      @save-as="saveActiveAs"
      @set-mode="setMode"
      @toggle-theme="toggleTheme"
      @font="changeFont"
      @search="openGlobalSearch"
      @export-html="doExportHtml"
      @export-word="doExportWord"
      @export-pdf="doExportPdf"
      @print-pdf="doPrintPdf"
      @word-to-md="openWordConvert('md')"
      @word-to-mh="openWordConvert('mh')"
      @settings="showSettings = true"
      @github="openGithub"
      @update="openReleases"
    />

    <div class="main">
      <FileTree
        v-if="sidebarVisible"
        ref="fileTreeRef"
        @open-file="openFileFromTree"
        @open-file-dbl="openFileFromTreeDbl"
        @open-file-edit="openFileInEditMode"
        @hide="sidebarVisible = false"
        @switch-workspace="switchWorkspace"
        @open-workspace="openWorkspace"
        @create-workspace="createWorkspace"
        @remove-all-workspaces="removeAllWorkspaces"
      />
      <!-- 工作区隐藏后的左缘复原入口：不可见，仅在标签栏行留 4px 命中区，拖动向右展开 -->
      <div
        v-else
        class="ws-restore"
        :title="t('workbench.dragToRestore')"
        @mousedown="onWsRestoreStart"
      />
      <div class="center">
        <TabBar ref="tabBarRef" @close="requestCloseTab" @close-batch="requestCloseBatch" @reloaded="flashReloadArea" @fullscreen="onTabFullscreen" />
        <div
          class="editor-area"
          :class="{ 'area-reloading': reloadFlash, 'page-full': editor.pageFull }"
          :style="{ '--mk-rail-pad': outlineRailOn ? '44px' : '20px' }"
          v-if="tabs.activeTab"
        >
          <!-- 预览类标签（docx/xlsx/图片/pdf）：只读预览，不进编辑器。
               :key=path|reloadSeq：左右键换文件时按新路径重挂；右键「刷新」bump 后重挂，
               两条路都让旧的在途加载随卸载作废，避免串图/串页 -->
          <DocxPreview v-if="tabs.activeTab.kind === 'docx'" :key="(tabs.activeTab.path ?? '') + '|' + (tabs.activeTab.reloadSeq ?? 0)" :path="tabs.activeTab.path ?? ''" />
          <SheetPreview v-else-if="tabs.activeTab.kind === 'xlsx'" :key="(tabs.activeTab.path ?? '') + '|' + (tabs.activeTab.reloadSeq ?? 0)" :path="tabs.activeTab.path ?? ''" />
          <ImagePreview v-else-if="tabs.activeTab.kind === 'image'" :key="(tabs.activeTab.path ?? '') + '|' + (tabs.activeTab.reloadSeq ?? 0)" :path="tabs.activeTab.path ?? ''" @editor-context="onEditorContext" />
          <PdfPreview v-else-if="tabs.activeTab.kind === 'pdf'" :key="(tabs.activeTab.path ?? '') + '|' + (tabs.activeTab.reloadSeq ?? 0)" :path="tabs.activeTab.path ?? ''" />
          <!-- 文本类标签：md 由 Markdown 引擎、html/svg/code/txt 由代码引擎、.mh 由富文本引擎接管。
               html/svg 三模式：edit=代码编辑器，split=代码编辑器+Frame，read=Frame。
               ★ 三引擎均为「首次用到才挂、此后常驻」，显隐走 v-show（script 段有整套约束说明）；
               布局不再用 .text-area > :first-child 认主引擎（三个根节点会同时在 DOM 里，
               隐藏的那个依然是 first-child），改按各自根类命中，见 global.css 文本区规则 -->
          <div
            v-else
            ref="textAreaRef"
            class="text-area"
            :class="[{ 'html-mode': isMarkupTab }, editor.mode]"
            :style="textAreaStyle"
          >
            <!-- code / html / svg 标签：CodeMirror 6 代码引擎（html/svg 的 split/read 渲染由 Frame 承担） -->
            <CodeEditorEngine
              v-if="codeEverMounted"
              v-show="usesCodeEngine"
              ref="codeEngineRef"
              :model-value="codeEditorContent"
              :theme="settings.themeMode"
              :focus-mode="settings.settings.focusMode"
              :line-wrap="settings.settings.codeLineWrap"
              :path="codeEditorPath"
              @update:model-value="onCodeContentChange"
              @save="onCodeSave"
              @cursor="onCodeCursor"
              @editor-context="onEditorContext"
            />
            <!-- Markdown 引擎：与代码/富文本引擎并列常驻。model-value / mode / doc-path 走
                 mdEditor* 三个冻结值（隐藏期间不吃外部值，切回来才不被误判成外部变更整篇重建），
                 active 供引擎自己跳过隐藏期的几何重测与打印宿主挂载（Teleport 出的宿主
                 不受父级 v-show 管，靠它从 @media print 里摘出去） -->
            <MdEditorV3Engine
              v-if="mdEverMounted"
              v-show="isMdTab"
              ref="mdEngineRef"
              :model-value="mdEditorContent"
              :mode="mdEditorMode"
              :active="isMdTab"
              :theme="settings.themeMode"
              :preview-theme="settings.settings.previewTheme"
              :read-layout="settings.settings.readLayout"
              :show-toolbar="settings.settings.showToolbar"
              :focus-mode="settings.settings.focusMode"
              :show-line-numbers="settings.settings.showLineNumbers"
              :scroll-sync="settings.settings.scrollSync"
              :doc-path="mdEditorDocPath"
              :language="settings.settings.language"
              editor-id="mkdown-editor"
              @update:model-value="onMdContentChange"
              @save="onMdSave"
              @outline="onOutline"
              @cursor="onMdCursor"
              @html-changed="onMdHtmlChanged"
              @request-mode="onMdRequestMode"
              @page-fullscreen="onMdPageFull"
              @toast="(t: string) => editor.showToast(t, 'error')"
              @open-link="onOpenLink"
              @open-doc="onOpenDoc"
              @editor-context="onEditorContext"
            />
            <WangEditorEngine
              v-if="wangEverMounted"
              v-show="isMhTab"
              ref="wangEngineRef"
              :model-value="mhEditorHtml"
              :mode="editor.mode"
              :theme="settings.themeMode"
              :focus-mode="settings.settings.focusMode"
              :doc-path="activeDocPath"
              :language="settings.settings.language"
              :read-layout="settings.settings.readLayout"
              :show-toolbar="settings.settings.showToolbar"
              @update:model-value="onMhContentChange"
              @save="onMhSave"
              @outline="onMhOutline"
              @editor-context="onEditorContext"
              @page-fullscreen="onMhPageFull"
              @request-mode="onMhRequestMode"
              @toast="(msg: string) => editor.showToast(msg, 'error')"
              @open-link="onOpenLink"
            />
            <HtmlFrame
              v-if="tabs.activeTab.kind === 'html' && editor.mode !== 'edit'"
              :key="tabs.activeTab.path ?? ''"
              class="html-frame-host"
              :content="tabs.activeTab.content"
              :dir="markupDocDir"
              :path="tabs.activeTab.path"
              :dark="settings.isDark"
              @editor-context="onEditorContext"
              @sibling-step="onFrameSiblingStep"
            />
            <SvgFrame
              v-else-if="tabs.activeTab.kind === 'svg' && editor.mode !== 'edit'"
              :key="tabs.activeTab.path ?? ''"
              ref="svgFrameRef"
              class="html-frame-host"
              :content="tabs.activeTab.content"
              :dir="markupDocDir"
              :path="tabs.activeTab.path"
              :dark="settings.isDark"
              @editor-context="onEditorContext"
              @sibling-step="onFrameSiblingStep"
            />
            <!-- 分栏拖拽把手：骑在源码区与预览区那条 1px 分隔线上，绝对定位不占 flex 流 -->
            <div
              v-if="isMarkupTab && editor.mode === 'split'"
              class="markup-split-handle"
              @mousedown="onSplitDragStart"
            ></div>
          </div>
        </div>
        <Welcome
          v-else
          :templates="TEMPLATES"
          @open-workspace="openWorkspace"
          @create-workspace="createWorkspace"
          @open-file="openFileByDialog"
          @new-template="newFromTemplate"
          @open-recent="openFilePath"
        />
      </div>
      <OutlinePanel v-if="showOutline && !outlineFresh" @goto="gotoOutline" />
      <!-- 右缘大纲浮标（自带 Teleport 到 body）：清新档常驻，传统档只在全屏阅读态顶替被盖住的面板 -->
      <OutlineRail v-if="outlineRailOn" :items="editor.outline" @goto="gotoOutline" />
    </div>

    <StatusBar :mode="editor.mode" />

    <SearchHub
      v-if="search.visible"
      :mode="hubMode"
      :can-replace="canReplace"
      @update:mode="hubMode = $event"
      @close="closeHub"
      @goto="gotoLine"
      @find="onFind"
      @replace="onReplace"
    />
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />

    <!-- Word 反转「转换操作页面」（R3/R4，§9.2） -->
    <WordConvertDialog
      v-if="wordConvert.visible"
      :visible="wordConvert.visible"
      :source-path="tabs.activeTab?.kind === 'docx' ? (tabs.activeTab.path ?? '') : ''"
      :target="wordConvert.target"
      @close="wordConvert.visible = false"
    />

    <!-- 关闭确认（单标签 / 批量关闭 / 关窗口 三态共用） -->
    <AppDialog
      :visible="closeConfirm.visible"
      :title="closeConfirm.tabId || closeConfirm.batchIds ? t('workbench.close.unsavedTitle') : t('workbench.close.windowTitle')"
      :message="closeConfirm.tabId
        ? t('workbench.close.tabMsg')
        : closeConfirm.batchIds
          ? t('workbench.close.batchMsg', { n: closeBatchDirtyCount })
          : t('workbench.close.windowMsg')"
      :confirm-text="closeConfirm.tabId ? t('workbench.close.saveClose') : closeConfirm.batchIds ? t('workbench.close.saveAllClose') : t('workbench.close.saveExit')"
      :cancel-text="closeConfirm.tabId ? t('workbench.close.discard') : closeConfirm.batchIds ? t('workbench.close.discardAllClose') : t('workbench.cancel')"
      @confirm="onCloseConfirm"
      @cancel="onCloseCancel"
    />

    <!-- 切换工作区确认（有脏标签时） -->
    <AppDialog
      :visible="wsSwitch.visible"
      :title="t('workbench.close.wsSwitchTitle')"
      :message="t('workbench.close.wsSwitchMsg')"
      :confirm-text="t('workbench.close.wsSwitchConfirm')"
      :cancel-text="t('workbench.close.wsSwitchCancel')"
      @confirm="onWsSwitchConfirm"
      @cancel="wsSwitch.visible = false"
    />

    <!-- 新建工作区：名称 + 存放位置在同一个选择器界面完成，不再分两步 -->
    <FolderPicker
      :visible="wsCreate.visible"
      mode="create"
      :title="t('workbench.wsCreate.title')"
      :initial-path="wsCreate.parent"
      :default-name="t('workbench.wsCreate.defaultName')"
      :busy="wsCreate.busy"
      @create="doCreateWorkspace"
      @cancel="wsCreate.visible = false"
    />

    <!-- 打开工作区：应用内文件夹选择器，不再调系统资源管理器 -->
    <FolderPicker
      :visible="folderPicker.visible"
      :title="t('workbench.folderPicker.openTitle')"
      :initial-path="folderPicker.initial"
      @select="onFolderPicked"
      @cancel="folderPicker.visible = false"
    />

    <!-- 打开文件 / 另存为 / 导出：同一套应用内选择器（Workbench 与 Word 反转弹窗共用） -->
    <FolderPicker
      :visible="filePicker.visible"
      :mode="filePicker.request.mode"
      :title="filePicker.request.title"
      :initial-path="filePicker.request.initialPath ?? ''"
      :default-name="filePicker.request.defaultName ?? ''"
      :ext="filePicker.request.ext ?? ''"
      :exts="filePicker.request.exts ?? []"
      @select="filePicker.close($event)"
      @save="filePicker.close($event)"
      @cancel="filePicker.close(null)"
    />

    <!-- 全部移除工作区确认（含当前，回到欢迎页） -->
    <AppDialog
      :visible="wsRemoveAll"
      :title="t('workbench.close.removeAllTitle')"
      :message="tabs.dirtyCount > 0
        ? t('workbench.close.removeAllDirtyMsg', { n: tabs.dirtyCount })
        : t('workbench.close.removeAllMsg')"
      :confirm-text="t('workbench.close.removeAllConfirm')"
      :cancel-text="t('workbench.cancel')"
      @confirm="onWsRemoveAllConfirm"
      @cancel="wsRemoveAll = false"
    />

    <!-- 外部修改冲突：磁盘内容与本地基线(savedContent)不一致，且本地有未保存改动。
         重新加载 = 丢弃本地采纳磁盘；保留我的改动 = 双方都不动，同一磁盘版本本会话内不再重复提示 -->
    <AppDialog
      :visible="!!externalConflict"
      :title="t('workbench.external.title')"
      :message="externalConflict
        ? t('workbench.external.message', { name: externalConflict.title })
        : ''"
      :confirm-text="t('workbench.external.reload')"
      :cancel-text="t('workbench.external.keep')"
      danger
      @confirm="onExternalReload"
      @cancel="onExternalKeep"
    />

    <!-- 轻提示 -->
    <Teleport to="body">
      <TransitionGroup name="toast" tag="div" class="toast-host">        <div
        v-for="toast in toasts"
        :key="toast.id"
          class="toast"
          :class="toast.kind"
          :title="t('workbench.clickToClose')"
          @click="dismissToast(toast.seq)"
        >
          <CheckCircle2 v-if="toast.kind === 'success'" class="toast-ic" />
          <AlertCircle v-else-if="toast.kind === 'error'" class="toast-ic" />
          <Info v-else class="toast-ic" />
          <span class="toast-text">{{ toast.text }}</span>
          <span v-if="toast.count > 1" class="toast-count">×{{ toast.count }}</span>
        </div>
      </TransitionGroup>
    </Teleport>

    <!-- 编辑区右键菜单：MdEditorV3Engine 右键拦截上报，格式项与快捷键共用 runFormat 分发 -->
    <EditorCtxMenu
      :ctx="editorCtx"
      :can-reload="!!tabs.activeTab?.path"
      :page-full="ctxPageFull"
      :focus-mode="settings.settings.focusMode"
      :show-line-numbers="settings.settings.showLineNumbers"
      :line-wrap="settings.settings.codeLineWrap"
      :plain-text="isPlainTextTab"
      :svg="isSvgTab"
      :read-layout="settings.settings.readLayout"
      :bar-mode="settings.settings.previewBarMode"
      :mode="editor.mode"
      @op="onTableOp"
      @format="onFormatFromMenu"
      @refresh="onCtxRefresh"
      @fullscreen="toggleFullscreen"
      @toggle-focus="onToggleFocusMode"
      @toggle-line-numbers="onToggleLineNumbers"
      @toggle-wrap="onToggleWordWrap"
      @format-markup="onCtxFormatMarkup"
      @export-png="onCtxExportPng"
      @copy-image="onCtxCopyImage"
      @search="onCtxSearch"
      @copy-all="onCtxCopyAll"
      @mode="onCtxMode"
      @layout="onCtxLayout"
      @bar-mode="onCtxBarMode"
      @bar-reset="onCtxBarReset"
      @copy-code="onCtxCopyCode"
      @paste-code="onCtxPasteCode"
      @dismiss="editorCtx = null"
    />

    <!-- 全局浮动气泡提示（data-tip 委托） -->
    <FloatTip />
  </div>
</template>

