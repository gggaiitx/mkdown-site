<script setup lang="ts">
/**
 * 主工作台：三栏布局 + 保存流水线 + 快捷键 + 导出/打印。
 * 只依赖 adapters 契约与 stores，不直接 import md-editor-v3。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
import Welcome from '../components/Welcome.vue';
import AppDialog from '../components/AppDialog.vue';
import FloatTip from '../components/FloatTip.vue';
import DocxPreview from '../components/preview/DocxPreview.vue';
import SheetPreview from '../components/preview/SheetPreview.vue';
import ImagePreview from '../components/preview/ImagePreview.vue';
import HtmlFrame from '../components/preview/HtmlFrame.vue';
import SvgFrame from '../components/preview/SvgFrame.vue';
import { MdEditorV3Engine, CodeEditorEngine, type EngineHandle } from '../adapters';
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

import {
  openInSystem,
  openUrl,
  pickOpenFile,
  pickWorkspaceDir,
  probePreviewKind,
  probeTextFile,
  saveAs as saveAsApi,
  takePendingOpenArgs,
  writeFileAtomic,
} from '../api/fileApi';
import { exportHtml } from '../api/exportApi';
import { allowAssetDir } from '../api/imageApi';
import type { EditorMode, ThemeKind } from '../api/types';
import { isCodeExt } from '../utils/fileKind';
import { TEMPLATES, type MdTemplate } from '../utils/markdownTemplate';
import { debounce } from '../utils/common';
import { useI18n } from '../i18n';

const { t } = useI18n();
const settings = useSettingsStore();
const ws = useWorkspaceStore();
const tabs = useTabsStore();
const editor = useEditorStore();
const search = useSearchStore();

const engineRef = ref<EngineHandle | null>(null);
/** 标签栏组件引用：F2 重命名当前文档经 TabBar.renameActive() 走同一对话框链路 */
const tabBarRef = ref<InstanceType<typeof TabBar> | null>(null);
const activeDocPath = computed(() => tabs.activeTab?.path ?? null);
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
  seq: number;
  text: string;
  kind: 'info' | 'error' | 'success';
  count: number;
  timer: number;
}
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
      dup.seq = seq;
      dup.timer = window.setTimeout(() => dismissToast(seq), TOAST_MS[kind] ?? 2600);
      return;
    }
    const item: ToastItem = { seq, text, kind, count: 1, timer: 0 };
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
  // 代码 / HTML 文件不走 Markdown 规则美化，避免规则式改写破坏源码结构
  if (usesCodeEngine.value) {
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
watch(() => tabs.activeTab?.content ?? '', (v) => syncOutline(v), { immediate: true });

function onOutline(items: OutlineItem[]) {
  editor.outline = items;
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
/** 代码类标签：只支持编辑态（无分栏/阅读），由 CodeEditorEngine 接管 */
const isCodeTab = computed(() => tabs.activeTab?.kind === 'code');
/** 编辑区由 CodeMirror 代码引擎接管的标签：code 恒编辑；html/svg 三模式中的源码侧；
 *  'text' 为旧会话快照兼容（新打开不再产生，txt/log/csv 等已归 'code'）——
 *  即除 Markdown 外的一切文本都走代码引擎，杜绝 txt 被当 Markdown 渲染 */
const usesCodeEngine = computed(() => {
  const k = tabs.activeTab?.kind;
  return !!k && k !== 'md';
});
// 激活代码标签时全局视图强制编辑态（不写回设置偏好；切回 md 标签用户可再切回）
watch(isCodeTab, (isCode) => {
  if (isCode && editor.mode !== 'edit') editor.setMode('edit');
});
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
async function routeByType(path: string): Promise<'text' | 'handled'> {
  try {
    if (await probeTextFile(path)) return 'text';
    const kind = await probePreviewKind(path).catch(() => null);
    if (kind === 'docx' || kind === 'xlsx' || kind === 'image') {
      tabs.openPreviewByPath(path, kind);
      ws.expandTo(path);
      ws.select(path);
      rememberRecent(path);
      // 预览组件经 asset:// 自取文件字节：补授权该文档目录
      const dir = path.replace(/[\\/][^\\/]*$/, '');
      if (dir) void allowAssetDir(dir).catch(() => undefined);
      return 'handled';
    }
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

/** 源码类文件（html/svg + 代码扩展名）：打开即进编辑态（渲染由分栏/阅读承担） */
const opensInEdit = (p: string): boolean => /\.(html?|svg)$/i.test(p) || isCodeExt(p);

/** 左侧目录点击打开：Markdown/TXT 默认阅读模式；html/svg/代码类默认编辑模式；
 *  docx/xlsx/图片开预览标签；其余交系统默认程序 */
async function openFileFromTree(path: string) {
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

function rememberRecent(path: string) {
  const rest = settings.settings.recentFiles.filter((r) => r.path !== path);
  void settings.update({
    recentFiles: [{ path, openedAtMs: Date.now() }, ...rest].slice(0, 20),
  });
}

function newFromTemplate(tpl: MdTemplate) {
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
const autoSaveTick = debounce(
  (id: string, content: string) => {
    const tab = tabs.tabs.find((t) => t.id === id);
    if (!tab || !tab.isDirty || !tab.path || !tab.isUtf8) return;
    if (tabs.activeId !== id) return;
    void (async () => {
      try {
        await writeFileAtomic(tab.path as string, content, tab.hadBom);
        tabs.markSaved(id, content);
        editor.showToast(t('workbench.toast.autoSaved', { name: baseName(tab.path as string) }), 'info');
      } catch {
        /* 静默失败，下次停顿重试 */
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
    // 先尝试保存再关闭
    await writeFileAtomic(tab.path, tab.content, tab.hadBom).catch(() => undefined);
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
        await writeFileAtomic(tab.path, tab.content, tab.hadBom).catch(() => undefined);
        tabs.markSaved(id, tab.content);
      }
    }
  }
  await tabs.closeTabsBatch(ids);
}

/** 关闭确认对话框统一入口（单标签 / 批量 / 关窗口三态） */
function onCloseConfirm() {
  if (closeConfirm.value.tabId) void confirmCloseTab(true);
  else if (closeConfirm.value.batchIds) void confirmCloseBatch(true);
  else void confirmCloseWindow('discard');
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
/** 阅读态的往返/回切目标：记住最近一个非阅读模式（read 不改写该记忆，否则会被 'read' 覆盖导致切不回来）。 */
const lastWorkMode = ref<EditorMode>(
  settings.settings.editorMode === 'read' ? 'split' : settings.settings.editorMode,
);
function setMode(m: EditorMode) {
  // 代码标签只支持编辑态：模式按钮已禁用，这里兜底拦截 Alt+E/W/R 快捷键
  if (isCodeTab.value && m !== 'edit') return;
  if (m !== 'read') lastWorkMode.value = m;
  editor.setMode(m);
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

// ---------- 大纲跳转 ----------
function gotoOutline(item: OutlineItem) {
  engineRef.value?.scrollToLine(item.line, item.index);
  editor.cursorLine = item.line;
}

/** 文件内定位（搜索面板文件内查找 / 全局搜索命中跳转共用）：直调引擎按行滚动（三态通用）。
 *  kw 约定：undefined = 不动当前高亮；'' = 清除；非空 = 设置高亮。
 *  （面板每次跳转都会 emit goto，若 goto 无条件清除会秒删 emit('find') 刚画的高亮） */
function gotoLine(line: number, kw?: string, cs = false) {
  engineRef.value?.scrollToLine(line);
  if (kw !== undefined) {
    if (kw) engineRef.value?.highlight(kw, cs);
    else engineRef.value?.clearHighlight();
  }
  editor.cursorLine = line;
}

/** Ctrl+F 查找条状态 → 引擎高亮（编辑/分栏 CM6 装饰 + 阅读态预览 mark） */
function onFind(keyword: string, caseSensitive: boolean) {
  engineRef.value?.highlight(keyword, caseSensitive);
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
function wrapExportHtml(): string {
  const title = tabs.activeTab?.title ?? t('workbench.appName');
  const html = editor.previewHtml || '';
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
<body>${html}</body>
</html>`;
}

/** 导出 HTML 时把 asset:// URL 还原为相对路径，保证 HTML 文件可随 assets 目录分发 */
function deAssetify(html: string, docPath: string): string {
  const dir = docPath.replace(/[\\/][^\\/]*$/, '');
  return html.replace(/https?:\/\/asset\.localhost\/([^"' )]+)/g, (_m, enc) => {
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
  // 代码 / HTML 标签没有 Markdown 渲染 HTML 来源（previewHtml），导出会得到残留内容
  if (usesCodeEngine.value) {
    editor.showToast(t('workbench.toast.codeNoExport'), 'info');
    return;
  }
  try {
    const html = deAssetify(wrapExportHtml(), tab.path ?? t('workbench.untitledMd'));
    const out = await exportHtml(tab.path ?? t('workbench.untitledMd'), html);
    if (out) editor.showToast(t('workbench.toast.exported', { path: out }), 'success');
  } catch (err) {
    editor.showToast(t('workbench.toast.exportFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
  }
}

async function doPrintPdf() {
  if (tabs.activeIsPreview) {
    editor.showToast(t('workbench.toast.previewNoPrint'), 'info');
    return;
  }
  // 代码 / HTML 标签不实现 exportPdf（无 Markdown 打印宿主），给出明确提示而非静默
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
function handleFormatShortcut(e: KeyboardEvent, k: string): boolean {
  // 代码 / HTML 标签：格式键全部交还 CM6/浏览器，不做 Markdown 包裹（防止把源码包进 ** 等）
  if (usesCodeEngine.value) return false;
  const kernelBound =
    (!e.shiftKey && (k === 'b' || k === 'i' || (k >= '1' && k <= '6'))) ||
    (e.shiftKey && k === 'c');
  if (kernelBound && isEditorFocused()) return false;

  const wrap = (prefix: string, suffix: string, placeholder: string) => {
    e.preventDefault();
    if (engineEditable()) engineRef.value?.wrapSelection?.(prefix, suffix, placeholder);
  };
  if (!e.shiftKey) {
    if (k === 'b') { wrap('**', '**', t('workbench.placeholder.bold')); return true; }
    if (k === 'i') { wrap('*', '*', t('workbench.placeholder.italic')); return true; }
    if (k === 'k') { wrap('[', '](https://)', t('workbench.placeholder.link')); return true; }
    if (k >= '1' && k <= '6') {
      e.preventDefault();
      if (engineEditable()) engineRef.value?.setHeading?.(Number(k));
      return true;
    }
  } else {
    if (k === 'c') { wrap('\n```\n', '\n```\n', t('workbench.placeholder.code')); return true; }
    if (k === 'i') { wrap('![', '](https://)', t('workbench.placeholder.image')); return true; }
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
      // 编辑器全屏（页面内全屏，同工具栏 pageFullscreen）：阻止 WebView 原生全屏
      e.preventDefault();
      if (engineEditable()) engineRef.value?.togglePageFullscreen?.();
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

// ---------- 拖拽文件到窗口打开（阅读模式） ----------
// Tauri v2 默认 dragDropEnabled=true 会拦截原生 HTML5 DnD，必须走 onDragDropEvent
let unlistenDrop: (() => void) | null = null;
/** 拖拽可打开：Markdown/TXT + html/svg（isCodeExt 不含 svg，fileKind 归 image）+ 代码扩展名 */
const OPENABLE_EXT = /\.(md|markdown|txt|html?|svg)$/i;
const isDragOpenable = (p: string): boolean => OPENABLE_EXT.test(p) || isCodeExt(p);
function onDragDrop(ev: { payload: { type: string; paths?: string[] } }) {
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
  window.addEventListener('keydown', onKeydown, true);
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
      @print-pdf="doPrintPdf"
      @settings="showSettings = true"
      @github="openGithub"
      @update="openReleases"
    />

    <div class="main">
      <FileTree
        v-if="sidebarVisible"
        @open-file="openFileFromTree"
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
        <TabBar ref="tabBarRef" @close="requestCloseTab" @close-batch="requestCloseBatch" />
        <div class="editor-area" v-if="tabs.activeTab">
          <!-- 预览类标签（docx/xlsx/图片）：只读预览，不进编辑器 -->
          <DocxPreview v-if="tabs.activeTab.kind === 'docx'" :path="tabs.activeTab.path ?? ''" />
          <SheetPreview v-else-if="tabs.activeTab.kind === 'xlsx'" :path="tabs.activeTab.path ?? ''" />
          <ImagePreview v-else-if="tabs.activeTab.kind === 'image'" :path="tabs.activeTab.path ?? ''" />
          <!-- 文本类标签：md/text/svg 由 md 引擎接管；html 与 code 由代码引擎接管源码侧。
               html/svg 三模式：edit=代码编辑器，split=代码编辑器+Frame，read=Frame
               （编辑器恒挂载不卸载，html-mode 布局类控显隐，:first-child 规则命中编辑器） -->
          <div v-else class="text-area" :class="[{ 'html-mode': isMarkupTab }, editor.mode]">
            <!-- code / html / svg 标签：CodeMirror 6 代码引擎（html/svg 的 split/read 渲染由 Frame 承担） -->
            <CodeEditorEngine
              v-if="usesCodeEngine"
              ref="engineRef"
              :model-value="tabs.activeTab.content"
              :theme="settings.settings.theme"
              :path="tabs.activeTab.path"
              @update:model-value="onContentChange"
              @save="() => saveActive()"
              @cursor="({ line, col }) => editor.setCursor(line, col)"
            />
            <MdEditorV3Engine
              v-else
              ref="engineRef"
              :model-value="tabs.activeTab.content"
              :mode="editor.mode"
              :theme="settings.settings.theme"
              :preview-theme="settings.settings.previewTheme"
              :read-layout="settings.settings.readLayout"
              :show-toolbar="settings.settings.showToolbar"
              :scroll-sync="settings.settings.scrollSync"
              :doc-path="activeDocPath"
              :language="settings.settings.language"
              editor-id="mkdown-editor"
              @update:model-value="onContentChange"
              @save="() => saveActive()"
              @outline="onOutline"
              @cursor="({ line, col }) => editor.setCursor(line, col)"
              @html-changed="(h: string) => (editor.previewHtml = h)"
              @toast="(t: string) => editor.showToast(t, 'error')"
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
      @update:mode="hubMode = $event"
      @close="closeHub"
      @goto="gotoLine"
      @find="onFind"
    />
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />

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

    <!-- 轻提示 -->
    <Teleport to="body">
      <TransitionGroup name="toast" tag="div" class="toast-host">        <div
          v-for="toast in toasts"
          :key="toast.seq"
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

    <!-- 全局浮动气泡提示（data-tip 委托） -->
    <FloatTip />
  </div>
</template>

