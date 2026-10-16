<script setup lang="ts">
/**
 * 主工作台：三栏布局 + 保存流水线 + 快捷键 + 导出/打印。
 * 只依赖 adapters 契约与 stores，不直接 import md-editor-v3。
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, CheckCircle2, Info } from '@lucide/vue';

import Toolbar from '../components/Toolbar.vue';
import TabBar from '../components/TabBar.vue';
import StatusBar from '../components/StatusBar.vue';
import OutlinePanel from '../components/OutlinePanel.vue';
import FileTree from '../components/FileTree.vue';
import SearchHub from '../components/SearchHub.vue';
import SettingsDialog from '../components/SettingsDialog.vue';
import WordConvertDialog from '../components/WordConvertDialog.vue';
import Welcome from '../components/Welcome.vue';
import AppDialog from '../components/AppDialog.vue';
import FloatTip from '../components/FloatTip.vue';
import EditorCtxMenu from '../components/EditorCtxMenu.vue';
// docx-preview / xlsx 体积大（合计约 1.6MB 未压缩）且仅在点开对应文件时才渲染：
// 懒加载拆出首屏 chunk（P1-7），模板用法不变
const DocxPreview = defineAsyncComponent(() => import('../components/preview/DocxPreview.vue'));
const SheetPreview = defineAsyncComponent(() => import('../components/preview/SheetPreview.vue'));
const PdfPreview = defineAsyncComponent(() => import('../components/preview/PdfPreview.vue'));
import ImagePreview from '../components/preview/ImagePreview.vue';
import HtmlFrame from '../components/preview/HtmlFrame.vue';
import SvgFrame from '../components/preview/SvgFrame.vue';
import { MdEditorV3Engine, CodeEditorEngine, WangEditorEngine, type EngineHandle } from '../adapters';
import type { EditorCtxPayload } from '../adapters/IMarkdownEngine';
import { formatMarkdown } from '../utils/mdFormat';
import {
  hydrateSession,
  applyActiveTabMode,
  startSessionSnapshot,
  flushSessionSnapshot,
} from '../utils/sessionSnapshot';
import type { OutlineItem } from '../stores/editorStore';

import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useTabsStore } from '../stores/tabsStore';
import { useEditorStore } from '../stores/editorStore';
import { useSearchStore } from '../stores/searchStore';
import { useExternalChangeGuard } from '../composables/useExternalChangeGuard';

import {
  getFileMeta,
  openInSystem,
  openUrl,
  openWebWindow,
  pickOpenFile,
  pickWorkspaceDir,
  probePreviewKind,
  probeTextFile,
  saveAs as saveAsApi,
  takePendingOpenArgs,
  writeFileAtomic,
} from '../api/fileApi';
import { exportDocx, exportHtml, exportPdf } from '../api/exportApi';
import { htmlToDocx, type WordStyleOpts } from '../convert/htmlToDocx';
import { mdToDocxCommunity } from '../convert/mdToDocxCommunity';
import { buildPrintDocument } from '../convert/printDoc';
import { allowAssetDir } from '../api/imageApi';
import type { EditorMode, ThemeKind } from '../api/types';
import { isCodeExt } from '../utils/fileKind';
import type { TableOp } from '../utils/mdTable';
import {
  BLOCK_EXAMPLE_KEYS, HEADING_EXAMPLE_KEY, HEADING_LEVELS, WRAP_ACTIONS,
  type FormatId, type HeadingId, type WrapActionId,
} from '../utils/mdActions';
import type { BlockFormatKind } from '../utils/mdLineFormat';
import { findMatchRanges, replaceAll, type ReplaceRequest } from '../utils/mdReplace';
import { TEMPLATES, type MdTemplate } from '../utils/markdownTemplate';
import { debounce } from '../utils/common';
import { useI18n } from '../i18n';

const { t } = useI18n();
const settings = useSettingsStore();
const ws = useWorkspaceStore();
const tabs = useTabsStore();
const editor = useEditorStore();
const search = useSearchStore();

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
/** 左侧工作区显示/隐藏（隐藏后经顶栏「展开侧边栏」恢复） */
const sidebarVisible = ref(true);

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

/** Ctrl+Shift+F：规则式美化当前文档（标脏走统一写回链路，大纲/字数自动同步） */
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
  // 代码 / HTML / 富文本文件不走 Markdown 规则美化，避免规则式改写破坏内容结构
  if (usesCodeEngine.value || isMhTab.value) {
    editor.showToast(t('workbench.toast.codeNoBeautify'), 'info');    return;
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

function onOutline(items: OutlineItem[]) {
  editor.outline = items;
}

/** 引擎光标上报（md / code 引擎共用）：写状态栏行列。
 *  ★ 参数显式标注：MdEditorV3Engine 的 emits 类型字面量成员增多后，
 *    vue-tsc 对该组件模板绑定丢失上下文推断（解构参数变隐式 any），此处自带类型即不受影响 */
function onEngineCursor({ line, col }: { line: number; col: number }) {
  editor.setCursor(line, col);
}

// ---------- 打开 / 新建 ----------
async function openWorkspace() {
  try {
    const dir = await pickWorkspaceDir();
    if (dir) await ws.openWorkspace(dir);
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
    await ws.openWorkspace(dir);
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
/** 富文本标签（.mh）：由 WangEditorEngine 接管，三模式全支持 */
const isMhTab = computed(() => tabs.activeTab?.kind === 'mh');
/** 按激活标签种类路由到的引擎句柄（code/md/wang 三引擎并存时的统一出口） */
const engineRef = computed<EngineHandle | null>(() => {
  if (isMhTab.value) return wangEngineRef.value;
  if (usesCodeEngine.value) return codeEngineRef.value;
  return mdEngineRef.value;
});
/** wangEditor 引擎是否已挂载过：首次激活 .mh 标签置 true，此后常驻（v-show 显隐） */
const wangEverMounted = ref(false);
watch(isMhTab, (v) => {
  if (v) wangEverMounted.value = true;
});
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
/** 编辑区由 CodeMirror 代码引擎接管的标签：code 恒编辑；html/svg 三模式中的源码侧；
 *  'text' 为旧会话快照兼容（新打开不再产生，txt/log/csv 等已归 'code'）——
 *  即除 Markdown/富文本外的一切文本都走代码引擎，杜绝 txt 被当 Markdown 渲染 */
const usesCodeEngine = computed(() => {
  const k = tabs.activeTab?.kind;
  return !!k && k !== 'md' && k !== 'mh';
});
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
 * 'handled' = 已在应用内处理（docx/xlsx/图片开预览标签，其余交系统默认程序）。
 * 两个判定都在 Rust 侧：probe_text_file（扩展名+嗅探）、probe_preview_kind（预览种类），
 * 前端不猜测扩展名。
 */
async function routeByType(path: string, openSystem = true): Promise<'text' | 'handled'> {
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
    if (openSystem) {
      await openInSystem(path);
      editor.showToast(t('workbench.toast.openedBySystem', { name: baseName(path) }), 'info');
    }
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

async function openFileByDialog() {
  try {
    const p = await pickOpenFile();
    if (p) await openFilePath(p);
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
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
  return parts.join('\\');
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

async function saveActiveAs(): Promise<string | null> {
  const tab = tabs.activeTab;
  if (!tab) return null;
  try {
    const res = await saveAsApi(tab.title, tab.content);
    if (res) {
      const newTitle = res.path.split(/[\\/]/).pop() ?? tab.title;
      tabs.updateTab(tab.id, {
        path: res.path,
        title: newTitle,
        encoding: 'utf-8',
        hadBom: false,
        isUtf8: true,
      });
      tabs.markSaved(tab.id, tab.content);
      ws.expandTo(res.path);
      rememberRecent(res.path);
      // 另存到新目录同样补授权，保证粘贴图片在阅读态可见
      const dir = res.path.replace(/[\\/][^\\/]*$/, '');
      if (dir) void allowAssetDir(dir).catch(() => undefined);
      editor.showToast(t('workbench.toast.savedAs', { name: newTitle }), 'success');
      return res.path;
    }
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

// ---------- 工作区隐藏后的左缘复原边线（拖动向右展开，交互与大纲面板一致；点击顶栏按钮也可） ----------
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
function toggleTheme() {
  const theme: ThemeKind = settings.isDark ? 'light' : 'dark';
  void settings.update({ theme });
}
function changeFont(delta: number) {
  const size = Math.min(24, Math.max(12, settings.settings.fontSize + delta));
  void settings.update({ fontSize: size });
}

/** Ctrl/⌘+滚轮调整全局字号：编辑态/分栏态/阅读态统一走 --mk-font-size
 *  （CM 编辑区与 md 预览区样式都消费该变量，无需按模式分流）。
 *  必须 window capture + passive:false 且 preventDefault：WebView2/WKWebView
 *  默认把 Ctrl+滚轮当页面缩放手势，不拦截会整页缩放而非调字号。
 *  钳制范围与 changeFont（顶栏 +/-）一致 12-24；持久化由 settings.update 内部防抖。
 *  deltaY<0 = 滚轮向上（远离用户）= 放大，与顶栏 + 按钮同向。 */
function onFontWheel(e: WheelEvent) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  changeFont(e.deltaY < 0 ? 1 : -1);
  // 轻提示反馈当前字号：滚轮连续滚动时 toast 去重合并（同文案同类型），最多 3 条并存
  editor.showToast(t('toolbar.fontZoomTip', { n: settings.settings.fontSize }), 'info');
}

// ---------- 大纲跳转 ----------
function gotoOutline(item: OutlineItem) {
  engineRef.value?.scrollToLine(item.line, item.index);
  editor.cursorLine = item.line;
}

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
 *  （面板每次跳转都会 emit goto，若 goto 无条件清除会秒删 emit('find') 刚画的高亮） */
function gotoLine(line: number, kw?: string, cs = false, matchIndex?: number) {
  engineRef.value?.scrollToLine(line);
  if (kw !== undefined) {
    if (kw) engineRef.value?.highlight(kw, cs);
    else engineRef.value?.clearHighlight();
  }
  // mh（富文本引擎）：highlight 重算 Range 后按命中序号定位 + 标记当前命中
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
watch(
  () => tabs.activeId,
  async () => {
    const path = tabs.activeTab?.path;
    // 未保存的新建文档 / 工作区外文件：不改变工作区选中态
    if (!path || !ws.root || !path.startsWith(ws.root)) return;
    ws.expandTo(path);
    ws.select(path);
    await nextTick(); // 等祖先展开渲染出新节点
    document
      .querySelector(`[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  },
);

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
  editor.showToast(t('workbench.toast.exporting'), 'info');
  try {
    let body: string;
    if (isMhTab.value) {
      // D8：mh 导出 HTML——来源 = tab.content（磁盘态，图片已是相对路径，deAssetify 空转）
      body = tab.content;
    } else {
      body = editor.previewHtml || '';
    }
    const html = deAssetify(wrapExportHtml(body), tab.path ?? t('workbench.untitledMd'));
    const out = await exportHtml(tab.path ?? t('workbench.untitledMd'), html);
    if (out) editor.showToast(t('workbench.toast.exported', { path: out }), 'success');
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
 *  其余（md 内置 / mh 全部）→ HTML 快照 → htmlToDocx（docx 包懒加载）→ exportDocx（Rust 对话框 + 原子写） */
async function doExportWord() {
  const tab = tabs.activeTab;
  if (!tab || tabs.activeIsPreview) return;
  if (exportingWord.value) return;
  exportingWord.value = true;
  editor.showToast(t('workbench.toast.exporting'), 'info');
  try {
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
      const { blob, warnings } = await mdToDocxCommunity(tab.content, style, baseDir);
      const data = new Uint8Array(await blob.arrayBuffer());
      const out = await exportDocx(tab.path ?? t('workbench.untitledMd'), data);
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
    const { blob, degradedFormulas, failedImages } = await htmlToDocx(html, style);
    const data = new Uint8Array(await blob.arrayBuffer());
    const out = await exportDocx(tab.path ?? t('workbench.untitledMd'), data);
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
  // 过渡提示：mermaid 渲染 + 样式/字体内联 + Edge 打印共数秒，先给 toast + 按钮 loading，
  // Rust 侧随后立即弹保存对话框（见 export_pdf：先取路径再打印），用户感知不到空窗
  editor.showToast(t('workbench.toast.exporting'), 'info');
  try {
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
    const printDoc = await buildPrintDocument(html);
    const out = await exportPdf(tab.path ?? t('workbench.untitledMd'), printDoc);
    if (out) {
      editor.showToast(t('workbench.toast.exported', { path: out }), 'success');
    }
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
function onEditorContext(payload: EditorCtxPayload): void {
  editorCtx.value = payload;
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

/** 右键「专注模式」：视图级开关，状态落设置文件（跨文档保持），点完即收菜单 */
function onToggleFocusMode(): void {
  editorCtx.value = null;
  settings.update({ focusMode: !settings.settings.focusMode });
}

/** 右键「行号」：同上，切换只影响 engine-root 上的 class，不打断输入与撤销栈 */
function onToggleLineNumbers(): void {
  editorCtx.value = null;
  settings.update({ showLineNumbers: !settings.settings.showLineNumbers });
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
      // 重命名当前文档（与标签右键菜单同一对话框；无路径的新文档由 TabBar 忽略）
      e.preventDefault();
      tabBarRef.value?.renameActive();
      return;
    }
    if (e.key === 'F11') {
      // 编辑器全屏（页面内全屏，同工具栏 pageFullscreen）：阻止 WebView 原生全屏。
      // 编辑/阅读两态都可用（对齐 md pageFullscreen），全屏态强制显示功能区
      e.preventDefault();
      engineRef.value?.togglePageFullscreen?.();
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
    if (!tabs.activeTab) {
      editor.showToast(t('workbench.toast.openBeforeFind'), 'info');
      return;
    }
    hubMode.value = 'file';
    search.open();
    return;
  }
  if (k === 'p') {
    e.preventDefault();
    hubMode.value = 'global'; // Ctrl+P：全局搜索（面板已开时=切到全局模式）
    search.open();
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
/** 拖拽可打开：Markdown/TXT + html/svg（isCodeExt 不含 svg，fileKind 归 image）+ 代码扩展名 */
const OPENABLE_EXT = /\.(md|markdown|mh|txt|html?|svg)$/i;
const isDragOpenable = (p: string): boolean => OPENABLE_EXT.test(p) || isCodeExt(p);
function onDragDrop(ev: { payload: { type: string; paths?: string[] } }) {
  // 转换弹窗打开时让位：拖拽由弹窗内拖拽区接管（docx 转换源），不触发打开文件
  if (wordConvert.value.visible) return;
  if (ev.payload.type !== 'drop' || !ev.payload.paths) return;
  const files = ev.payload.paths.filter(isDragOpenable);
  const skipped = ev.payload.paths.length - files.length;
  if (skipped > 0) editor.showToast(t('workbench.toast.skippedNonMd', { n: skipped }), 'info');
  if (files.length === 0) return;
  // 拖入默认模式：首个文件为源码类（html/svg/代码）→ 编辑态；Markdown/TXT → 阅读态
  editor.setMode(opensInEdit(files[0]) ? 'edit' : 'read');
  void (async () => {
    for (const p of files) await openFilePath(p, opensInEdit(p) ? 'edit' : 'read');
  })();
}

// ---------- 「打开方式」/ 双击关联文件 ----------
// 首次启动：Rust setup 解析启动参数存入待打开队列，挂载后经命令取走；
// 应用已运行：单实例插件把新文件路径经 open-file-args 事件转发过来。
async function openArgsFiles(paths: string[]) {
  if (!paths?.length) return;
  for (const p of paths) await openFilePath(p);
}
let unlistenOpenArgs: (() => void) | null = null;

// ---------- 生命周期 ----------
onMounted(async () => {
  await settings.load();
  editor.setMode(settings.settings.editorMode);
  // 空闲预载 wangEditor 引擎 chunk（~280KB gzip 独立分包）：消除 md→mh 首切的 1~2s 卡顿
  const idlePreload = (cb: () => void) =>
    'requestIdleCallback' in window
      ? requestIdleCallback(cb, { timeout: 5000 })
      : (setTimeout(cb, 3000) as unknown as number);
  idlePreload(() => {
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
  await win.onCloseRequested(onCloseRequested);
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
  // 恢复上次工作区
  if (settings.settings.lastWorkspace) {
    try {
      await ws.openWorkspace(settings.settings.lastWorkspace);
    } catch {
      editor.showToast(t('workbench.toast.lastWsUnavailable'), 'info');
    }
  }
  // 会话恢复（更新重启/崩溃后还原标签页与未保存草稿）：干净页读盘，脏页用快照草稿
  try {
    const hydrate = await hydrateSession();
    if (hydrate.restored) {
      applyActiveTabMode(hydrate.activeTab);
      // 恢复活动文本标签的光标位置（预览标签无编辑器，跳过）
      const at = hydrate.activeTab;
      if (at && at.cursorLine > 1 && !tabs.activeIsPreview) {
        void nextTick(() => engineRef.value?.scrollToLine(at.cursorLine));
      }
    }
  } catch {
    /* 会话恢复失败不致命 */
  }
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
      :theme="settings.settings.theme"
      :has-active="!!tabs.activeTab"
      :search-active="search.visible"
      :sidebar-hidden="!sidebarVisible"
      :code-tab="isCodeTab"
      :no-split="isMhTab"
      :exportable="canExportHtml"
      :printable="canPrintPdf"
      :exporting="exportingWord"
      :mode-bar-position="settings.settings.modeBarPosition"
      @toggle-sidebar="sidebarVisible = !sidebarVisible"
      @open-file="openFileByDialog"
      @open-workspace="openWorkspace"
      @new="newFromTemplate(TEMPLATES[0])"
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
        @remove-all-workspaces="removeAllWorkspaces"
      />
      <!-- 工作区隐藏后的左缘复原边线：拖动向右展开（原生 title 提示，同大纲面板） -->
      <div
        v-else
        class="ws-restore"
        :title="t('workbench.dragToRestore')"
        @mousedown="onWsRestoreStart"
      ><i class="ws-restore-line" /></div>
      <div class="center">
        <TabBar ref="tabBarRef" @close="requestCloseTab" @close-batch="requestCloseBatch" @reloaded="flashReloadArea" />
        <div class="editor-area" :class="{ 'area-reloading': reloadFlash }" v-if="tabs.activeTab">
          <!-- 预览类标签（docx/xlsx/图片/pdf）：只读预览，不进编辑器。
               :key=reloadSeq：右键「刷新」bump 后重挂，重新经 asset:// 自取字节 -->
          <DocxPreview v-if="tabs.activeTab.kind === 'docx'" :key="tabs.activeTab.reloadSeq ?? 0" :path="tabs.activeTab.path ?? ''" />
          <SheetPreview v-else-if="tabs.activeTab.kind === 'xlsx'" :key="tabs.activeTab.reloadSeq ?? 0" :path="tabs.activeTab.path ?? ''" />
          <ImagePreview v-else-if="tabs.activeTab.kind === 'image'" :key="tabs.activeTab.reloadSeq ?? 0" :path="tabs.activeTab.path ?? ''" />
          <PdfPreview v-else-if="tabs.activeTab.kind === 'pdf'" :key="tabs.activeTab.reloadSeq ?? 0" :path="tabs.activeTab.path ?? ''" />
          <!-- 文本类标签：md/text/svg 由 md 引擎接管；html 与 code 由代码引擎接管源码侧。
               html/svg 三模式：edit=代码编辑器，split=代码编辑器+Frame，read=Frame
               （编辑器恒挂载不卸载，html-mode 布局类控显隐，:first-child 规则命中编辑器） -->
          <div v-else class="text-area" :class="[{ 'html-mode': isMarkupTab }, editor.mode]">
            <!-- code / html / svg 标签：CodeMirror 6 代码引擎（html/svg 的 split/read 渲染由 Frame 承担） -->
            <CodeEditorEngine
              v-if="usesCodeEngine"
              ref="codeEngineRef"
              :model-value="tabs.activeTab.content"
              :theme="settings.settings.theme"
              :focus-mode="settings.settings.focusMode"
              :path="tabs.activeTab.path"
              @update:model-value="onContentChange"
              @save="() => saveActive()"
              @cursor="onEngineCursor"
            />
            <!-- .mh 富文本：wangEditor 引擎。★ 首次激活 mh 后常驻挂载（v-show 显隐）——
                 createEditor 成本高（数百 ms），随标签切换反复销毁重建是 md→mh 卡顿根因；
                 model-value 走 mhEditorHtml：隐藏期间保持上一份 mh 内容，不再喂空串
                 （喂空串会让切回变成「外部变更」从而整篇 setHtml，方案骨架下直接卡死主线程），
                 隐藏态误发的事件仍由 onMhContentChange 门控丢弃。
               DOM 顺序必须在 md 引擎之后：.text-area > :first-child 的 flex 规则
               依赖可见引擎排第一（wang 隐藏时 display:none 不参与 flex 流） -->
            <MdEditorV3Engine
              v-if="!usesCodeEngine && !isMhTab"
              ref="mdEngineRef"
              :model-value="tabs.activeTab.content"
              :mode="editor.mode"
              :theme="settings.settings.theme"
              :preview-theme="settings.settings.previewTheme"
              :read-layout="settings.settings.readLayout"
              :show-toolbar="settings.settings.showToolbar"
              :focus-mode="settings.settings.focusMode"
              :show-line-numbers="settings.settings.showLineNumbers"
              :scroll-sync="settings.settings.scrollSync"
              :doc-path="activeDocPath"
              :language="settings.settings.language"
              editor-id="mkdown-editor"
              @update:model-value="onContentChange"
              @save="() => saveActive()"
              @outline="onOutline"
              @cursor="onEngineCursor"
              @html-changed="(h: string) => (editor.previewHtml = h)"
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
              :theme="settings.settings.theme"
              :focus-mode="settings.settings.focusMode"
              :doc-path="activeDocPath"
              :language="settings.settings.language"
              :read-layout="settings.settings.readLayout"
              :show-toolbar="settings.settings.showToolbar"
              @update:model-value="onMhContentChange"
              @save="() => saveActive()"
              @toast="(msg: string) => editor.showToast(msg, 'error')"
              @open-link="onOpenLink"
            />
            <HtmlFrame
              v-if="tabs.activeTab.kind === 'html' && editor.mode !== 'edit'"
              class="html-frame-host"
              :content="tabs.activeTab.content"
              :dir="markupDocDir"
              :path="tabs.activeTab.path"
              :dark="settings.isDark"
            />
            <SvgFrame
              v-else-if="tabs.activeTab.kind === 'svg' && editor.mode !== 'edit'"
              class="html-frame-host"
              :content="tabs.activeTab.content"
              :dir="markupDocDir"
              :path="tabs.activeTab.path"
              :dark="settings.isDark"
            />
          </div>
        </div>
        <Welcome
          v-else
          :templates="TEMPLATES"
          @open-workspace="openWorkspace"
          @open-file="openFileByDialog"
          @new-template="newFromTemplate"
          @open-recent="openFilePath"
        />
      </div>
      <OutlinePanel v-if="showOutline" @goto="gotoOutline" />
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
      :focus-mode="settings.settings.focusMode"
      :show-line-numbers="settings.settings.showLineNumbers"
      @op="onTableOp"
      @format="onFormatFromMenu"
      @refresh="onCtxRefresh"
      @toggle-focus="onToggleFocusMode"
      @toggle-line-numbers="onToggleLineNumbers"
      @dismiss="editorCtx = null"
    />

    <!-- 全局浮动气泡提示（data-tip 委托） -->
    <FloatTip />
  </div>
</template>

