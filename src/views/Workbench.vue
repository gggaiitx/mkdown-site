<script setup lang="ts">
/**
 * 主工作台：三栏布局 + 保存流水线 + 快捷键 + 导出/打印。
 * 只依赖 adapters 契约与 stores，不直接 import md-editor-v3。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
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
import { MdEditorV3Engine, type EngineHandle } from '../adapters';
import { formatMarkdown } from '../utils/mdFormat';
import type { OutlineItem } from '../stores/editorStore';

import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useTabsStore } from '../stores/tabsStore';
import { useEditorStore } from '../stores/editorStore';
import { useSearchStore } from '../stores/searchStore';

import {
  openInSystem,
  pickOpenFile,
  pickWorkspaceDir,
  probePreviewKind,
  probeTextFile,
  saveAs as saveAsApi,
  writeFileAtomic,
} from '../api/fileApi';
import { exportHtml } from '../api/exportApi';
import { allowAssetDir } from '../api/imageApi';
import type { EditorMode, ThemeKind } from '../api/types';
import { TEMPLATES, type MdTemplate } from '../utils/markdownTemplate';
import { debounce } from '../utils/common';

const settings = useSettingsStore();
const ws = useWorkspaceStore();
const tabs = useTabsStore();
const editor = useEditorStore();
const search = useSearchStore();

const engineRef = ref<EngineHandle | null>(null);
const activeDocPath = computed(() => tabs.activeTab?.path ?? null);
const showSettings = ref(false);
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
    editor.showToast('没有打开的文档', 'error');
    return;
  }
  if (tabs.activeIsPreview) {
    editor.showToast('预览标签为只读，不支持美化', 'info');
    return;
  }
  const formatted = formatMarkdown(tab.content);
  if (formatted === tab.content) {
    editor.showToast('文档已是规范格式', 'info');
    return;
  }
  onContentChange(formatted);
  syncOutline(formatted);
  editor.showToast('Markdown 已美化', 'success');
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
    editor.showToast(`已切换工作区：${baseName(dir)}`, 'success');
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
  editor.showToast('已移除全部工作区', 'success');
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** 激活标签是否为 HTML（三模式：edit 源码 / split 源码+iframe / read iframe 渲染） */
const isHtmlTab = computed(() => tabs.activeTab?.kind === 'html');
/** HTML 文档所在目录（相对资源经 asset:// base 解析） */
const htmlDocDir = computed(() => {
  const p = tabs.activeTab?.path;
  return p ? p.replace(/[\\/][^\\/]*$/, '') : null;
});
/** 大纲面板可见性：预览类与 HTML 标签没有 Markdown 大纲概念 */
const showOutline = computed(
  () => !!tabs.activeTab && !tabs.activeIsPreview && tabs.activeTab.kind !== 'html' && editor.mode !== 'edit',
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
    editor.showToast(`已用系统默认程序打开：${baseName(path)}`, 'info');
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
    await tabs.openByPath(path, modeOverride ?? settings.settings.editorMode);
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

/** 左侧目录点击打开：文本文件默认阅读模式；docx/xlsx/图片开预览标签；其余交系统默认程序 */
async function openFileInReadMode(path: string) {
  if ((await routeByType(path)) !== 'text') return;
  editor.setMode('read');
  await openFilePath(path, 'read', true);
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
  editor.showToast(`已按「${tpl.name}」新建`, 'success');
}

// ---------- 保存流水线 ----------
async function saveActive(): Promise<void> {
  const tab = tabs.activeTab;
  if (!tab || editor.saving) return;
  // 预览标签（docx/xlsx/图片）没有文本内容，写入会毁掉原文件——硬性拦截
  if (tabs.activeIsPreview) {
    editor.showToast('预览标签为只读，无保存操作', 'info');
    return;
  }
  if (!tab.isUtf8) {
    editor.showToast(`当前文档编码为 ${tab.encoding}，就地保存可能破坏中文，请使用「另存为」保存为 UTF-8`, 'error');
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
    editor.showToast(`已保存 · ${baseName(tab.path)}`, 'success');
  } catch (err) {
    editor.showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
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
      editor.showToast(`已另存为 ${newTitle}`, 'success');
      return res.path;
    }
  } catch (err) {
    editor.showToast(`另存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
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
        editor.showToast(`已自动保存 · ${baseName(tab.path as string)}`, 'info');
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

// ---------- 模式 / 主题 / 字号 ----------
/** 阅读态的往返/回切目标：记住最近一个非阅读模式（read 不改写该记忆，否则会被 'read' 覆盖导致切不回来）。 */
const lastWorkMode = ref<EditorMode>(
  settings.settings.editorMode === 'read' ? 'split' : settings.settings.editorMode,
);
function setMode(m: EditorMode) {
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
  const title = tabs.activeTab?.title ?? '码克';
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
    editor.showToast('预览标签不支持导出 HTML', 'info');
    return;
  }
  try {
    const html = deAssetify(wrapExportHtml(), tab.path ?? '未命名.md');
    const out = await exportHtml(tab.path ?? '未命名.md', html);
    if (out) editor.showToast(`已导出：${out}`, 'success');
  } catch (err) {
    editor.showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function doPrintPdf() {
  if (tabs.activeIsPreview) {
    editor.showToast('预览标签不支持打印', 'info');
    return;
  }
  if (!editor.previewHtml) {
    editor.showToast('预览未就绪，请稍后重试', 'error');
    return;
  }
  // WebView 打印路线（ADR：预览 HTML → WebView2 打印为 PDF），打印样式见 global.css
  window.print();
}

// ---------- 快捷键 ----------
function onKeydown(e: KeyboardEvent) {
  const ctrl = e.ctrlKey || e.metaKey;
  // 模式快捷键：Alt+E 编辑 / Alt+W 分栏 / Alt+R 阅读
  if (e.altKey && !ctrl) {
    const ak = e.key.toLowerCase();
    if (ak === 'e') { e.preventDefault(); setMode('edit'); return; }
    if (ak === 'w') { e.preventDefault(); setMode('split'); return; }
    if (ak === 'r') { e.preventDefault(); setMode('read'); return; }
    return;
  }
  if (!ctrl) {
    if (e.key === 'F1') {
      e.preventDefault();
      showSettings.value = !showSettings.value;
    }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 's') {
    // 编辑器内核已处理编辑态 Ctrl+S；这里兜底（阅读态/焦点在外时）
    if (editor.mode !== 'edit' || !document.querySelector('.CodeMirror-focused')) {
      e.preventDefault();
      void saveActive();
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
      editor.showToast('请先打开文档，再按 Ctrl+F 查找', 'info');
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
  await getCurrentWebviewWindow().destroy();
}

// ---------- 拖拽文件到窗口打开（阅读模式） ----------
// Tauri v2 默认 dragDropEnabled=true 会拦截原生 HTML5 DnD，必须走 onDragDropEvent
let unlistenDrop: (() => void) | null = null;
const OPENABLE_EXT = /\.(md|markdown|txt)$/i;
function onDragDrop(ev: { payload: { type: string; paths?: string[] } }) {
  if (ev.payload.type !== 'drop' || !ev.payload.paths) return;
  const files = ev.payload.paths.filter((p) => OPENABLE_EXT.test(p));
  const skipped = ev.payload.paths.length - files.length;
  if (skipped > 0) editor.showToast(`已忽略 ${skipped} 个非 Markdown/TXT 文件`, 'info');
  if (files.length === 0) return;
  editor.setMode('read'); // 拖入即阅读
  void (async () => {
    for (const p of files) await openFilePath(p, 'read');
  })();
}

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
  // 恢复上次工作区
  if (settings.settings.lastWorkspace) {
    try {
      await ws.openWorkspace(settings.settings.lastWorkspace);
    } catch {
      editor.showToast('上次工作区不可用，可重新打开', 'info');
    }
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true);
  unlistenDrop?.();
  unlistenDrop = null;
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
    />

    <div class="main">
      <FileTree
        v-if="sidebarVisible"
        @open-file="openFileInReadMode"
        @open-file-edit="openFileInEditMode"
        @hide="sidebarVisible = false"
        @switch-workspace="switchWorkspace"
        @open-workspace="openWorkspace"
        @remove-all-workspaces="removeAllWorkspaces"
      />
      <div class="center">
        <TabBar @close="requestCloseTab" @close-batch="requestCloseBatch" />
        <div class="editor-area" v-if="tabs.activeTab">
          <!-- 预览类标签（docx/xlsx/图片）：只读预览，不进编辑器 -->
          <DocxPreview v-if="tabs.activeTab.kind === 'docx'" :path="tabs.activeTab.path ?? ''" />
          <SheetPreview v-else-if="tabs.activeTab.kind === 'xlsx'" :path="tabs.activeTab.path ?? ''" />
          <ImagePreview v-else-if="tabs.activeTab.kind === 'image'" :path="tabs.activeTab.path ?? ''" />
          <!-- 文本类标签：md/text 由引擎接管；html 三模式
               （edit=源码，split=源码+iframe，read=iframe 渲染，引擎隐藏不卸载） -->
          <div v-else class="text-area" :class="[{ 'html-mode': isHtmlTab }, editor.mode]">
            <MdEditorV3Engine
              ref="engineRef"
              :model-value="tabs.activeTab.content"
              :mode="isHtmlTab ? 'edit' : editor.mode"
              :theme="settings.settings.theme"
              :preview-theme="settings.settings.previewTheme"
              :read-layout="settings.settings.readLayout"
              :doc-path="activeDocPath"
              editor-id="mkdown-editor"
              @update:model-value="onContentChange"
              @save="() => saveActive()"
              @outline="onOutline"
              @cursor="({ line, col }) => editor.setCursor(line, col)"
              @html-changed="(h: string) => (editor.previewHtml = h)"
              @toast="(t: string) => editor.showToast(t, 'error')"
            />
            <HtmlFrame
              v-if="isHtmlTab && editor.mode !== 'edit'"
              class="html-frame-host"
              :content="tabs.activeTab.content"
              :dir="htmlDocDir"
              :path="tabs.activeTab.path"
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
      :title="closeConfirm.tabId || closeConfirm.batchIds ? '未保存的更改' : '关闭窗口'"
      :message="closeConfirm.tabId
        ? '当前文档有未保存的更改：确定=保存并关闭，取消=放弃更改并关闭'
        : closeConfirm.batchIds
          ? `有 ${closeBatchDirtyCount} 个未保存文档：确定=全部保存并关闭，取消=全部放弃并关闭`
          : '有未保存的文档，确定保存全部并退出？（取消=留在窗口）'"
      :confirm-text="closeConfirm.tabId ? '保存并关闭' : closeConfirm.batchIds ? '全部保存并关闭' : '保存并退出'"
      :cancel-text="closeConfirm.tabId ? '放弃更改' : closeConfirm.batchIds ? '全部放弃并关闭' : '取消'"
      @confirm="onCloseConfirm"
      @cancel="onCloseCancel"
    />

    <!-- 切换工作区确认（有脏标签时） -->
    <AppDialog
      :visible="wsSwitch.visible"
      title="切换工作区"
      message="有未保存的文档：切换将关闭所有标签且不保存这些更改。确定继续？"
      confirm-text="放弃更改并切换"
      cancel-text="留在当前工作区"
      @confirm="onWsSwitchConfirm"
      @cancel="wsSwitch.visible = false"
    />

    <!-- 全部移除工作区确认（含当前，回到欢迎页） -->
    <AppDialog
      :visible="wsRemoveAll"
      title="全部移除工作区"
      :message="tabs.dirtyCount > 0
        ? `有 ${tabs.dirtyCount} 个未保存文档将丢失，历史列表与当前工作区将被清空（不删除磁盘文件）。确定继续？`
        : '将关闭当前工作区并清空历史列表（不删除磁盘文件）。确定继续？'"
      confirm-text="全部移除"
      cancel-text="取消"
      @confirm="onWsRemoveAllConfirm"
      @cancel="wsRemoveAll = false"
    />

    <!-- 轻提示 -->
    <Teleport to="body">
      <TransitionGroup name="toast" tag="div" class="toast-host">        <div
          v-for="t in toasts"
          :key="t.seq"
          class="toast"
          :class="t.kind"
          :title="'点击关闭'"
          @click="dismissToast(t.seq)"
        >
          <CheckCircle2 v-if="t.kind === 'success'" class="toast-ic" />
          <AlertCircle v-else-if="t.kind === 'error'" class="toast-ic" />
          <Info v-else class="toast-ic" />
          <span class="toast-text">{{ t.text }}</span>
          <span v-if="t.count > 1" class="toast-count">×{{ t.count }}</span>
        </div>
      </TransitionGroup>
    </Teleport>

    <!-- 全局浮动气泡提示（data-tip 委托） -->
    <FloatTip />

    <!-- 打印宿主：仅打印时可见（导出 PDF 走 WebView 打印） -->
    <div class="print-area">
      <div class="md-editor-preview">
        <div v-html="editor.previewHtml" />
      </div>
    </div>
  </div>
</template>

