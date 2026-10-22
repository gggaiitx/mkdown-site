<script setup lang="ts">
/** 顶栏 = 标题栏 + 工具栏（对齐 DBX AppToolbar）：无品牌块，左侧功能按钮，右侧窗口控制 */
import { onBeforeUnmount, onMounted, ref, computed, watch, nextTick } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  List, FolderOpen, Folder, FolderPlus, FilePlus2, Save, SaveAll,
  Pencil, Columns2, BookOpen,   Search, FileCode2, Printer,
  Sun, Moon, Settings, Minus, Plus, Download,
  PanelLeftOpen, PanelLeftClose,
  FileText, ArrowRightLeft, FileType,
  Minus as WinMin, Square, Copy, X,
} from '@lucide/vue';

import type { EditorMode, ThemeKind } from '../api/types';
import { FONT_STEP } from '../api/types';
import { altHint, modHint, modShiftHint } from '../utils/keyHint';
import { useEditorStore } from '../stores/editorStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useI18n } from '../i18n';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import { flushSessionSnapshot } from '../utils/sessionSnapshot';
import AppDialog from './AppDialog.vue';

const props = defineProps<{
  mode: EditorMode;
  theme: ThemeKind;
  hasActive: boolean;
  searchActive: boolean;
  /** 左侧工作区已隐藏：顶栏前部显示「展开侧边栏」 */
  sidebarHidden: boolean;
  /** 激活标签为代码类：分栏/阅读模式按钮禁用（代码引擎只有编辑态） */
  codeTab?: boolean;
  /** 激活标签为富文本（.mh）：仅分栏按钮禁用（双形态 edit/read，阅读态带大纲） */
  noSplit?: boolean;
  /** 激活标签可导出 HTML / Word（md/mh，D8 起 mh 放开）：false 时菜单项灰掉 */
  exportable?: boolean;
  /** 激活标签可打印 PDF（md 内核 ExportPDF / mh 富文本导出）：false 时菜单项灰掉 */
  printable?: boolean;
  /** 导出进行中（Word/PDF/HTML）：trigger 显示 loading，导出项禁用防重复触发 */
  exporting?: boolean;
  /** 顶栏模式切换三按钮组位置（设置-外观「模式位置」）：center 顶栏居中（默认）/ left 跟随左侧功能区 */
  modeBarPosition?: 'center' | 'left';
}>();

const emit = defineEmits<{
  (e: 'open-file'): void;
  (e: 'open-workspace'): void;
  (e: 'new-workspace'): void;
  (e: 'toggle-sidebar'): void;
  (e: 'new'): void;
  (e: 'new-kernel', kind: 'md' | 'mh'): void;
  (e: 'new-code'): void;
  (e: 'save'): void;
  (e: 'save-as'): void;
  (e: 'set-mode', m: EditorMode): void;
  (e: 'toggle-theme'): void;
  (e: 'font', delta: number): void;
  (e: 'search'): void;
  (e: 'export-html'): void;
  (e: 'export-word'): void;
  (e: 'export-pdf'): void;
  (e: 'print-pdf'): void;
  (e: 'word-to-md'): void;
  (e: 'word-to-mh'): void;
  (e: 'settings'): void;
  (e: 'github'): void;
  (e: 'update', url: string): void;
}>();

// 更新检测：挂载时向 GitHub 查询最新 Release，与本地版本比较；点击后后台下载并提示重启
const editor = useEditorStore();
const settings = useSettingsStore();
const { t } = useI18n();

/** 顶栏自动保存快捷开关：与设置-编辑器同一字段，写入仍走 settingsStore 防抖落盘 */
const autoSaveOn = computed(() => settings.settings.autoSave);
function toggleAutoSave() {
  void settings.update({ autoSave: !settings.settings.autoSave });
}
/** 新建文件内核（与设置-编辑器同一字段）：md/mh 档点击即新建，同时把内核留给 Ctrl+N / 整行新建。
 *  txt 不是可持久化的内核，而是「新建代码文件」入口：代码文件要先有后缀才能选语言，
 *  未命名阶段先落成 .txt 纯文本，保存时再由「另存为」按新后缀接管。 */
const kernelIsMh = computed(() => settings.settings.editorEngine === 'wangeditor');
function newKernel(k: 'md' | 'mh') {
  const engine = k === 'mh' ? 'wangeditor' : 'markdown';
  if (settings.settings.editorEngine !== engine) void settings.update({ editorEngine: engine });
  closeMenu();
  emit('new-kernel', k);
}
function newCodeFile() {
  closeMenu();
  emit('new-code');
}
const {
  state: updateState,
  latestVersion,
  currentVersion,
  releaseUrl,
  downloadUrl,
  downloadState,
  progress,
  check,
  startDownload,
  applyUpdate,
} = useUpdateCheck();

const showUpdateDialog = ref(false);

/** 下载进度百分比：总量已知时返回 0-100，未知（total=0）返回 null 走转圈兜底 */
const downloadPct = computed<number | null>(() => {
  if (downloadState.value !== 'downloading') return null;
  const p = progress.value;
  return p && p.total > 0 ? Math.min(100, Math.floor((p.downloaded / p.total) * 100)) : null;
});

/* 进度环几何：r=8 → 周长 2πr ≈ 50.27 */
const RING_C = 50.27;

const updateTip = computed(() => {
  if (downloadState.value === 'downloading') {
    const p = progress.value;
    const pct = p && p.total > 0 ? Math.floor((p.downloaded / p.total) * 100) : null;
    return pct === null ? t('toolbar.downloading') : t('toolbar.downloadingPct', { n: pct });
  }
  if (downloadState.value === 'downloaded') return t('toolbar.downloaded');
  if (downloadState.value === 'error') return t('toolbar.downloadFailed');
  switch (updateState.value) {
    case 'available':
      return t('toolbar.available', { v: latestVersion.value });
    case 'uptodate':
      return t('toolbar.upToDate', { v: currentVersion.value });
    case 'checking':
      return t('toolbar.checking');
    case 'error':
      return t('toolbar.checkFailed');
    default:
      return t('toolbar.checkUpdate');
  }
});

/** 点击更新：
 *  - 有可用更新 → 后台下载；已下载 → 弹重启确认；
 *  - 其余状态（已是最新/检测失败/未检测）→ 先强制重检再按结果处理：
 *    后端发布新版后点击即可检测到并直接进入下载，无需重启应用（2026-10-09）；
 *  - 重检后仍最新 → toast；仍失败 → 兜底跳发布页 */
async function onUpdateClick() {
  if (updateState.value === 'available' && downloadUrl.value) {
    if (downloadState.value === 'downloading') return; // 下载中：忽略
    if (downloadState.value === 'downloaded') {
      showUpdateDialog.value = true; // 已下载：再次弹出重启确认
      return;
    }
    void startDownload();
    return;
  }
  if (updateState.value === 'checking') return; // 正在检测：忽略重复点击
  await check(true); // force：绕过会话缓存重新请求 GitHub
  if (updateState.value === 'available' && downloadUrl.value) {
    void startDownload();
    return;
  }
  if (updateState.value === 'uptodate') {
    editor.showToast(t('toolbar.alreadyLatest', { v: currentVersion.value }), 'info');
    return;
  }
  // 检查失败等异常态：打开 Release 发布页
  emit('update', releaseUrl.value);
}

async function onApplyConfirm() {
  showUpdateDialog.value = false;
  // 退出前固化会话（含未保存草稿），重启后由会话恢复流程还原
  await flushSessionSnapshot();
  await applyUpdate(); // 进程将在此退出并重启
}

// 下载完成自动弹出重启确认
watch(downloadState, (s) => {
  if (s === 'downloaded') showUpdateDialog.value = true;
});

const modes = computed<{ key: EditorMode; label: string; hint: string; icon: unknown }[]>(() => [
  { key: 'edit', label: t('toolbar.modeEdit'), hint: altHint('E'), icon: Pencil },
  { key: 'split', label: t('toolbar.modeSplit'), hint: altHint('W'), icon: Columns2 },
  { key: 'read', label: t('toolbar.modeRead'), hint: altHint('R'), icon: BookOpen },
]);

// ---- 模式切换组「居中」档的动态吸附 ----
// 窗宽缩小到居中组与左侧功能区贴近时，直接吸附回左侧（跟随功能流，等同靠左档），
// 而非悬在中间与左侧按钮重叠。判定纯几何：50% 位置的组左缘 ≥ 左侧功能区右缘 + 最小间距。
// 左侧功能区宽度随按钮收纳分级（container query）动态变化，故用 ResizeObserver 实时重算，
// 不用固定窗宽断点——收纳成图标后左侧变窄，同一组可能重新获得居中空间。
const modeSegRef = ref<HTMLElement | null>(null);
const tbMainRef = ref<HTMLElement | null>(null);
/** true = 居中组吸附到左侧（此时不加 .centered 类，回归流内布局） */
const segSnapped = ref(false);
/** 模式组是否处于流内布局：靠左档恒在流内；居中档吸附后回归流内。
 *  同时驱动两处视图：.mode-seg 是否加 centered 类、第二根分隔线显隐
 *  （模式组飞走后左组末尾的孤线默认隐藏，吸附/靠左时才作为分隔显示） */
const segInFlow = computed(() => props.modeBarPosition === 'left' || segSnapped.value);
/** true = 居中悬空的模式组右缘已贴近右侧功能区（搜索按钮组），需在其间显示分隔线。
 *  显示区间：模式组与搜索的实距 < RIGHT_DIVIDER_MAX（开始贴近）且 ≥ SEG_MIN_GAP
 *  （间隙仍容得下线+两侧呼吸距——再压线会贴到阅读图标，直接隐藏） */
const segNearRight = ref(false);
/** 居中组与两侧功能区的最小呼吸间距（左吸附阈值 / 右线隐藏下限） */
const SEG_MIN_GAP = 12;
/** 右分隔线显示的间距上界：间隙小于此值视为「贴近」，线在间隙中点出现 */
const RIGHT_DIVIDER_MAX = 26;
let segRO: ResizeObserver | null = null;

function updateSegSnap() {
  const seg = modeSegRef.value;
  const main = tbMainRef.value;
  if (!seg || !main) {
    segSnapped.value = false;
    segNearRight.value = false;
    return;
  }
  // 左侧功能区右缘 = mode-seg 在流内的前一个兄弟（第二根 divider）右缘；
  // seg 脱流与否都不影响它前面的元素布局，任意定位态下测量均有效
  const prev = seg.previousElementSibling as HTMLElement | null;
  if (!prev) {
    segSnapped.value = false;
    segNearRight.value = false;
    return;
  }
  const mainLeft = main.getBoundingClientRect().left;
  const leftEdge = prev.getBoundingClientRect().right - mainLeft;
  const segHalf = seg.offsetWidth / 2;
  segSnapped.value = main.clientWidth / 2 - segHalf < leftEdge + SEG_MIN_GAP;
  // 右侧判定：模式组右缘与搜索按钮左缘的实距 gap。spacer/搜索位置由 flex 决定，
  // 不受模式组定位与右分隔线（absolute 不占流）影响，判定无反馈回路。
  // 线位置 = 间隙中点：压缩时同步移动、与阅读/搜索两侧恒等距（≥gap/2 ≥ 6px），
  // 不会钉死在搜索侧而随压缩贴到阅读图标上；gap < SEG_MIN_GAP 时线隐藏。
  const spacer = (seg.nextElementSibling as HTMLElement | null)?.nextElementSibling as HTMLElement | null;
  const search = spacer?.nextElementSibling as HTMLElement | null;
  if (search) {
    const segRight = seg.getBoundingClientRect().right;
    const gap = search.getBoundingClientRect().left - segRight;
    segNearRight.value = gap < RIGHT_DIVIDER_MAX && gap >= SEG_MIN_GAP;
    if (segNearRight.value) {
      const mid = (segRight + search.getBoundingClientRect().left) / 2 - mainLeft - 0.5;
      main.style.setProperty('--mk-right-div-x', `${mid.toFixed(1)}px`);
    }
  } else {
    segNearRight.value = false;
  }
}

// 重算信号：① tb-main 宽度（窗口/侧栏变化必然传导至此）② 左组末按钮（宽度随
// 字体/语言加载变化——tb-main 总宽不变时 RO 不会触发，靠它补齐重算时机）
// ③ window resize 事件（RO 的冗余兜底，任何环境下 resize 必触发重算）
watch(modeSegRef, (el) => {
  segRO?.disconnect();
  segRO = null;
  if (!el || !tbMainRef.value) return;
  segRO = new ResizeObserver(() => updateSegSnap());
  segRO.observe(tbMainRef.value);
  // prev = 第二根 divider（seg 的流内前驱），再往前是「另存为」按钮
  const lastLeftBtn = el.previousElementSibling?.previousElementSibling;
  if (lastLeftBtn) segRO.observe(lastLeftBtn);
  // 初次量测延后两帧：挂载首帧 flex 分配/字体回退可能未稳定，避免误判吸附
  void nextTick(() => {
    updateSegSnap();
    requestAnimationFrame(() => requestAnimationFrame(updateSegSnap));
  });
});
// 设置里切换居中/靠左时重算（tb-main 宽度不变，RO 不触发）
watch(
  () => props.modeBarPosition,
  () => void nextTick(updateSegSnap),
);

// ---- 窗口控制（decorations=false，本栏即标题栏） ----
// macOS：走 tauri.macos.conf.json 的原生红绿灯（titleBarStyle Overlay，左上角），
// 隐藏右侧自绘三键并预留左上空间；Windows/Linux 维持自绘三键不变
const isMac = /Mac/i.test(navigator.platform) || navigator.userAgent.includes('Macintosh');
/** 字号按钮提示里的滚轮快捷键（Ctrl+滚轮 / Mac ⌘+滚轮，见 Workbench.onFontWheel） */
const fontWheelHint = isMac ? '⌘+滚轮' : 'Ctrl+滚轮';
/** 加/减各自的键盘快捷键（一档 0.5px；见 Workbench.onKeydown 的 Equal/Minus 分支） */
const fontKeyUp = isMac ? '⌘=' : 'Ctrl+=';
const fontKeyDown = isMac ? '⌘-' : 'Ctrl+-';
const win = getCurrentWindow();
const isMaximized = ref(false);
let unlistenResized: (() => void) | null = null;

onMounted(() => {
  // DOM 监听必须先于 Tauri 异步链注册：await 链若中断（invoke 失败等）不能连累吸附重算失效
  window.addEventListener('resize', updateSegSnap);
  // 中文字体就绪后左组按钮宽度会变（fallback 字体 → 正式字体），补一次吸附重算
  void document.fonts?.ready.then(() => updateSegSnap());
  void (async () => {
    isMaximized.value = await win.isMaximized();
    unlistenResized = await win.onResized(async () => {
      isMaximized.value = await win.isMaximized();
    });
  })();
});
onBeforeUnmount(() => {
  unlistenResized?.();
  window.removeEventListener('resize', updateSegSnap);
  segRO?.disconnect();
  segRO = null;
});
function minimize() { void win.minimize(); }
function toggleMaximize() { void win.toggleMaximize(); }
function closeWindow() {
  // 走 close 事件 → Workbench 的 onCloseRequested 未保存拦截仍然生效
  void win.close();
}

// ---- 「文件」下拉菜单开合 ----
// 交互口径（2026-10-13 定稿）：**点击图标展开/收起**（不再 hover 展开，防误触）；
// 点击菜单项后收起；点击外部 / Esc 关闭。导出/打印/转换并入本菜单，不再单设「输出」入口。
const fileWrapRef = ref<HTMLElement | null>(null);
const fileBtnRef = ref<HTMLElement | null>(null);
/** teleport 到 body 后的菜单元素（点击外部关闭需把它纳入命中判定） */
const fileMenuRef = ref<HTMLElement | null>(null);
/** 菜单 fixed 定位内联样式（top 由 trigger 实时坐标推导，left 固定贴视口左侧，越界由 adjustMenu 兜底） */
const fileMenuStyle = ref<Record<string, string>>({});
const fileOpen = ref(false);

/** 展开菜单：按 trigger 底缘算 top（脱离 .toolbar/.tb-main 的 overflow:hidden 裁剪），
 *  左缘固定 left:1px（不再跟 trigger 对齐）；宽度自适应内容，越界由 adjustMenu 兜底 */
function openMenu() {
  const r = fileBtnRef.value?.getBoundingClientRect();
  if (r) {
    fileMenuStyle.value = {
      position: 'fixed',
      top: `${Math.round(r.bottom) + 6}px`,
      left: '1px',
    };
  }
  fileOpen.value = true;
  void nextTick(adjustMenu);
}

function toggleMenu() {
  if (fileOpen.value) closeMenu();
  else openMenu();
}
function closeMenu() {
  fileOpen.value = false;
}

/** 越界兜底：右缘超出视口则左移夹紧；下缘放不下翻到 trigger 上方。渲染一帧后量实际尺寸再校正 */
function adjustMenu() {
  const menu = fileMenuRef.value;
  const btn = fileBtnRef.value;
  if (!menu || !btn) return;
  const rect = menu.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  const cur = fileMenuStyle.value;
  const top = parseFloat(cur.top);
  const next: Record<string, string> = { ...cur };
  let left = parseFloat(cur.left);
  if (Number.isFinite(left) && left + rect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - rect.width - 8);
  }
  if (Number.isFinite(left)) next.left = `${Math.round(left)}px`;
  if (
    Number.isFinite(top) &&
    top + rect.height > window.innerHeight - 8 &&
    b.top - rect.height - 6 >= 8
  ) {
    next.top = `${Math.round(b.top - rect.height - 6)}px`;
  }
  fileMenuStyle.value = next;
}
/** 文件菜单项：新建 / 打开，文件与工作区两组同列；点击后统一收起 */
function onFileItem(e: 'new' | 'open-file' | 'new-workspace' | 'open-workspace') {
  closeMenu();
  if (e === 'new') emit('new');
  else if (e === 'open-file') emit('open-file');
  else if (e === 'new-workspace') emit('new-workspace');
  else emit('open-workspace');
}

/** 导出类菜单项（同属文件菜单）：派发语义事件后统一收起（避免遮挡后续操作） */
function onExportItem(e: 'export-html' | 'export-word' | 'export-pdf' | 'print-pdf' | 'word-to-md' | 'word-to-mh') {
  closeMenu();
  if (e === 'export-html') emit('export-html');
  else if (e === 'export-word') emit('export-word');
  else if (e === 'export-pdf') emit('export-pdf');
  else if (e === 'print-pdf') emit('print-pdf');
  else if (e === 'word-to-md') emit('word-to-md');
  else emit('word-to-mh');
}

onMounted(() => {
  // 外部点击关闭（capture：先于菜单项 click 之前判定，mousedown 时菜单仍在）
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onDocKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('keydown', onDocKeydown);
});
function onDocMouseDown(e: MouseEvent) {
  if (!fileOpen.value) return;
  const tgt = e.target as Node;
  // 命中 trigger 区或已 teleport 到 body 的菜单本身都不关闭
  if (fileWrapRef.value?.contains(tgt) || fileMenuRef.value?.contains(tgt)) return;
  closeMenu();
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && fileOpen.value) {
    e.stopPropagation();
    closeMenu();
  }
}
</script>

<template>
  <header class="toolbar" data-tauri-drag-region :class="{ 'is-mac': isMac }">
    <!-- macOS 原生红绿灯占位（titleBarStyle Overlay 绘制在左上，此区域仅留白+可拖拽） -->
    <div v-if="isMac" class="traffic-pad" data-tauri-drag-region />
    <!-- 左侧功能区：deep 拖动区（子树内空白处可拖动/双击最大化，按钮自动阻断），为右侧窗口控制让位 -->
    <div ref="tbMainRef" class="tb-main" data-tauri-drag-region="deep">
    <!-- 侧边栏开关：恒钉在最左，图标随显隐切换（隐藏按钮已从工作区头部移除） -->
    <button
      class="tb-btn tb-btn--icon tb-first"
      :aria-label="sidebarHidden ? t('toolbar.expandSidebar') : t('toolbar.collapseSidebar')"
      @click="emit('toggle-sidebar')"
      v-tip="sidebarHidden ? t('toolbar.expandSidebar') : t('toolbar.collapseSidebar')"
    >
      <PanelLeftOpen v-if="sidebarHidden" class="icon" />
      <PanelLeftClose v-else class="icon" />
    </button>
    <!-- 「文件」下拉：新建/打开文件与新建/打开工作区统一收在这里，点击展开 -->
    <div ref="fileWrapRef" class="tb-menu-wrap">
      <button
        ref="fileBtnRef"
        class="tb-btn tb-btn--text"
        :class="{ 'tb-btn--active': fileOpen }"
        :aria-label="t('toolbar.file')"
        aria-haspopup="menu"
        :aria-expanded="fileOpen ? 'true' : 'false'"
        v-tip="t('toolbar.fileMenuTip')"
        @click="toggleMenu"
      >
        <List class="icon" />
        <span class="label">{{ t('toolbar.file') }}</span>
        <span v-if="fileOpen" class="active-dot" />
      </button>
      <Teleport to="body">
        <div v-if="fileOpen" ref="fileMenuRef" class="mk-menu file-menu tb-menu" :style="fileMenuStyle">
          <!-- 「新建文件」行内嵌三档开关：md/mh/txt 点击都直接新建对应类型（未命名.md / .mh / .txt） -->
          <div class="kernel-line" @click="onFileItem('new')">
            <button class="kernel-new" type="button">
              <FilePlus2 class="mk-menu-ico" />
              <span>{{ t('toolbar.menuNewFile') }}</span>
            </button>
            <div
              class="kernel-switch"
              role="group"
              :aria-label="t('toolbar.newKernel')"
              v-tip="t('toolbar.kernelTip')"
            >
              <button
                class="ks-opt"
                type="button"
                :class="{ on: !kernelIsMh }"
                :aria-pressed="!kernelIsMh ? 'true' : 'false'"
                @click.stop="newKernel('md')"
              >md</button>
              <button
                class="ks-opt"
                type="button"
                :class="{ on: kernelIsMh }"
                :aria-pressed="kernelIsMh ? 'true' : 'false'"
                @click.stop="newKernel('mh')"
              >mh</button>
              <button
                class="ks-opt"
                type="button"
                :aria-label="t('toolbar.newCodeFile')"
                @click.stop="newCodeFile"
              >txt</button>
            </div>
            <kbd class="mk-menu-key">{{ modHint('N') }}</kbd>
          </div>
          <button class="mk-menu-item" @click="onFileItem('open-file')">
            <FolderOpen class="mk-menu-ico" />
            <span>{{ t('toolbar.menuOpenFile') }}</span>
            <kbd class="mk-menu-key">{{ modHint('O') }}</kbd>
          </button>
          <div class="mk-menu-sep" />
          <button class="mk-menu-item" @click="onFileItem('new-workspace')">
            <FolderPlus class="mk-menu-ico" />
            <span>{{ t('toolbar.menuNewWorkspace') }}</span>
            <kbd class="mk-menu-key">{{ modShiftHint('N') }}</kbd>
          </button>
          <button class="mk-menu-item" @click="onFileItem('open-workspace')">
            <Folder class="mk-menu-ico" />
            <span>{{ t('toolbar.menuOpenWorkspace') }}</span>
            <kbd class="mk-menu-key">{{ modShiftHint('O') }}</kbd>
          </button>

          <div class="mk-menu-sep" />

          <!-- 导出 / 打印 / 转换：原「输出」下拉整组并入文件菜单，按 kind 置灰 -->
          <div class="om-group">{{ t('toolbar.groupExport') }}</div>
          <button class="mk-menu-item om-item" :disabled="!exportable || props.exporting" @click="onExportItem('export-html')">
            <FileCode2 class="om-ic" />
            <span class="om-label">{{ t('toolbar.exportHtml') }}</span>
          </button>
          <button class="mk-menu-item om-item" :disabled="!exportable || props.exporting" @click="onExportItem('export-word')">
            <FileText class="om-ic" />
            <span class="om-label">{{ t('toolbar.exportWord') }}</span>
          </button>
          <button class="mk-menu-item om-item" :disabled="!exportable || props.exporting" @click="onExportItem('export-pdf')">
            <FileType class="om-ic" />
            <span class="om-label">{{ t('toolbar.exportPdf') }}</span>
          </button>
          <div class="om-group">{{ t('toolbar.groupPrint') }}</div>
          <button class="mk-menu-item om-item" :disabled="!printable" @click="onExportItem('print-pdf')">
            <Printer class="om-ic" />
            <span class="om-label">{{ t('toolbar.printPdf') }}</span>
          </button>
          <div class="om-group">{{ t('toolbar.groupConvert') }}</div>
          <button class="mk-menu-item om-item" @click="onExportItem('word-to-md')">
            <ArrowRightLeft class="om-ic" />
            <span class="om-label">{{ t('toolbar.wordToMd') }}</span>
            <kbd class="mk-menu-key">{{ modShiftHint('M') }}</kbd>
          </button>
          <button class="mk-menu-item om-item" @click="onExportItem('word-to-mh')">
            <ArrowRightLeft class="om-ic" />
            <span class="om-label">{{ t('toolbar.wordToMh') }}</span>
            <kbd class="mk-menu-key">{{ modShiftHint('H') }}</kbd>
          </button>
        </div>
      </Teleport>
    </div>

    <!-- 自动保存快捷开关：与设置-编辑器同一字段；窄窗收起文字只留轨道 -->
    <button
      class="tb-btn tb-btn--text autosave-btn"
      role="switch"
      :aria-checked="autoSaveOn ? 'true' : 'false'"
      :aria-label="t('toolbar.autoSave')"
      v-tip="autoSaveOn ? t('toolbar.autoSaveTipOn') : t('toolbar.autoSaveTipOff')"
      @click="toggleAutoSave"
    >
      <span class="label">{{ t('toolbar.autoSave') }}</span>
      <span class="mini-track" :class="{ on: autoSaveOn }" aria-hidden="true"><span class="mini-knob" /></span>
    </button>

    <div class="divider" />

    <button class="tb-btn tb-btn--text" :disabled="!hasActive" @click="emit('save')" v-tip="t('toolbar.saveTip')">
      <Save class="icon" />
      <span class="label">{{ t('toolbar.save') }}</span>
    </button>
    <button class="tb-btn tb-btn--text tb-save-as" :disabled="!hasActive" @click="emit('save-as')" v-tip="t('toolbar.saveAsTip')">
      <SaveAll class="icon" />
      <span class="label">{{ t('toolbar.saveAs') }}</span>
    </button>

    <div class="divider" :class="{ 'divider-hide': !segInFlow }" />

    <div
      ref="modeSegRef"
      class="mode-seg"
      :class="{ centered: !segInFlow }"
      role="group"
      :aria-label="t('toolbar.viewMode')"
    >
      <button
        v-for="m in modes"
        :key="m.key"
        class="tb-btn tb-btn--icon"
        :class="{ 'tb-btn--active': mode === m.key }"
        :disabled="(codeTab && m.key !== 'edit') || (noSplit && m.key === 'split')"
        :aria-label="m.label"
        v-tip="(codeTab && m.key !== 'edit') || (noSplit && m.key === 'split') ? undefined : `${m.label} (${m.hint})`"
        @click="emit('set-mode', m.key)"
      >
        <component :is="m.icon" class="icon" />
        <span v-if="mode === m.key" class="active-dot" />
      </button>
    </div>

    <!-- 右组分隔线：绝对定位钉在搜索按钮左侧（x 由 updateSegSnap 写入 CSS 变量），
         仅当居中模式组右缘贴近右侧功能区时显示，作为「模式组 ↔ 搜索」的分隔。
         absolute 不占 flex 流——流内插入只会落在左组末尾（模式组已脱流），无法到达两者中间；
         且显隐/移位不扰动布局，右侧判定（读 spacer 右缘）无反馈回路 -->
    <div
      class="divider right-divider"
      :class="{ 'divider-show': !segInFlow && segNearRight }"
    />

    <div class="flex-spacer" data-tauri-drag-region />

    <button class="tb-btn tb-btn--icon" :class="{ 'tb-btn--active': searchActive }" @click="emit('search')" v-tip="t('toolbar.searchTip')">
      <Search class="icon" />
      <span v-if="searchActive" class="active-dot" />
    </button>

    <!-- 表格编辑入口已迁至编辑区右键菜单（Workbench.vue + MdEditorV3Engine 的 contextmenu 拦截） -->

    <div class="divider" />

    <div class="font-seg">
      <button class="tb-btn tb-btn--icon" @click="emit('font', -FONT_STEP)" v-tip="t('toolbar.fontSmaller', { k: fontWheelHint, s: fontKeyDown })">
        <Minus class="icon icon-sm" />
      </button>
      <button class="tb-btn tb-btn--icon tb-font-type" v-tip="t('toolbar.fontSize', { r: isMac ? '⌘0' : 'Ctrl+0' })" disabled>
        <span class="font-aa">Aa</span>
      </button>
      <button class="tb-btn tb-btn--icon" @click="emit('font', FONT_STEP)" v-tip="t('toolbar.fontLarger', { k: fontWheelHint, s: fontKeyUp })">
        <Plus class="icon icon-sm" />
      </button>
    </div>

    <div class="divider" />

    <button class="tb-btn tb-btn--icon" @click="emit('toggle-theme')" v-tip="theme === 'dark' ? t('toolbar.toLight') : t('toolbar.toDark')">
      <Sun v-if="theme === 'dark'" class="icon" />
      <Moon v-else class="icon" />
    </button>
    <button class="tb-btn tb-btn--icon" @click="emit('settings')" v-tip="t('toolbar.settings')">
      <Settings class="icon" />
    </button>
    <a
      class="tb-btn tb-btn--icon tb-github"
      href="https://github.com/gggaiitx/mkdown-site"
      target="_blank"
      rel="noopener noreferrer"
      v-tip="t('toolbar.githubRepo')"
      @click.prevent="emit('github')"
    >
      <svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    </a>
    <button
      class="tb-btn tb-btn--icon"
      :class="{ 'tb-btn--active': updateState === 'available' }"
      :aria-label="t('toolbar.checkUpdate')"
      v-tip="updateTip"
      @click="onUpdateClick"
    >
      <!-- 下载中：总量已知时进度环直接内嵌在更新图标位（环心显示百分比数字）；未知总量退回转圈 -->
      <svg
        v-if="downloadPct !== null"
        class="update-ring"
        viewBox="0 0 20 20"
        role="progressbar"
        :aria-valuenow="downloadPct"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <!-- 旋转只作用于圆环（进度从 12 点方向起始）；环心数字不旋转 -->
        <g transform="rotate(-90 10 10)">
          <circle class="ring-bg" cx="10" cy="10" r="8" />
          <circle
            class="ring-fg"
            cx="10"
            cy="10"
            r="8"
            :stroke-dasharray="RING_C"
            :stroke-dashoffset="RING_C * (1 - downloadPct / 100)"
          />
        </g>
        <text class="ring-text" x="10" y="10.5" text-anchor="middle" dominant-baseline="central">
          {{ Math.round(downloadPct) }}
        </text>
      </svg>
      <span v-else-if="downloadState === 'downloading' || updateState === 'checking'" class="spin" />
      <Download v-else class="icon" />
      <span
        v-if="updateState === 'available' && downloadState !== 'downloading' && downloadState !== 'downloaded'"
        class="update-dot"
      />
    </button>

    </div><!-- /tb-main -->

    <AppDialog
      :visible="showUpdateDialog"
      :title="t('toolbar.updateReady')"
      :message="t('toolbar.updateReadyMsg', { v: latestVersion })"
      :confirm-text="t('toolbar.updateNow')"
      :cancel-text="t('toolbar.later')"
      @confirm="onApplyConfirm"
      @cancel="showUpdateDialog = false"
    />

    <!-- 窗口控制：macOS 由系统红绿灯接管，不再自绘 -->
    <template v-if="!isMac">
      <div class="divider" />
      <button class="tb-btn tb-btn--icon win-btn" v-tip="t('toolbar.minimize')" @click="minimize">
        <WinMin class="icon icon-sm" />
      </button>
      <button class="tb-btn tb-btn--icon win-btn" v-tip="isMaximized ? t('toolbar.restore') : t('toolbar.maximize')" @click="toggleMaximize">
        <Copy v-if="isMaximized" class="icon icon-sm" />
        <Square v-else class="icon icon-sm" />
      </button>
      <button class="tb-btn tb-btn--icon win-btn win-btn--close" v-tip="t('toolbar.close')" @click="closeWindow">
        <X class="icon icon-sm" />
      </button>
    </template>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  padding: 0 4px 0 8px;
  background: var(--mk-panel);
  border-bottom: 1px solid var(--mk-border);
  flex: none;
  user-select: none;
  /* 容器查询基准：按顶栏实际可用宽度（扣除侧边栏后）分级收纳功能区 */
  container-type: inline-size;
  overflow: hidden; /* 兜底：极端宽度下溢出内容不外泄 */
}
/* 左侧功能区：flex:1 + min-width:0，空间不足时先于窗口控制区收缩/裁剪 */
.tb-main {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  /* 模式切换组「居中」档的定位基准（见 .mode-seg.centered） */
  position: relative;
}
.divider {
  width: 1px; height: 18px;
  background: var(--mk-border);
  margin: 0 6px;
  flex: none;
}
/* 模式组居中（未吸附）时：左组末尾这条分隔线跟随模式组飞走成孤线，默认隐藏；
   吸附回左侧（或靠左档）后恢复显示，作为「另存为 ↔ 模式组」的分隔。
   ★必须用 visibility（保留占位）：display:none 会把 updateSegSnap 依赖的
   divider 几何归零（leftEdge → 负值），吸附判定闭环卡死永不触发 */
.divider.divider-hide { visibility: hidden; }
/* 右组分隔线：absolute 钉在搜索按钮左侧，x 坐标由 updateSegSnap 按搜索按钮
   实时位置写入 --mk-right-div-x（tb-main 为定位基准）；margin 归零避免偏移 */
.divider.right-divider {
  position: absolute;
  left: var(--mk-right-div-x, -100px);
  top: 50%;
  transform: translateY(-50%);
  margin: 0;
  visibility: hidden;
}
.divider.right-divider.divider-show { visibility: visible; }
.flex-spacer { flex: 1; height: 100%; }

.tb-btn {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  flex: none; /* 窗体变窄时保持原宽不压缩，文字按钮不被裁字 */
  height: 28px; min-width: 28px;
  border: none; background: transparent;
  color: var(--mk-fg);
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
  white-space: nowrap;
  font-size: 11.5px;
  text-decoration: none;
  transition: background-color 120ms ease, color 120ms ease;
}
/* 文字按钮：图标与文字同一色调（muted），hover 整体点亮，按钮内部不再双色混排 */
.tb-btn--text { padding: 0 8px; gap: 6px; color: var(--mk-fg-muted); }
.tb-btn--text:hover:not(:disabled),
.tb-btn--text:active:not(:disabled) { color: var(--mk-fg); }
.tb-btn:hover:not(:disabled) { background: var(--mk-hover); }
.tb-btn:active:not(:disabled) { background: var(--mk-active); }
.tb-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.tb-btn--active { background: var(--mk-hover); color: var(--mk-fg); }
.icon { width: 15px; height: 15px; color: var(--mk-fg-muted); }
.tb-btn:hover:not(:disabled) .icon { color: var(--mk-fg); }
.tb-btn--active .icon { color: var(--mk-fg); }
.icon-sm { width: 13px; height: 13px; }

/* 自动保存快捷开关：文字按钮内嵌迷你轨道（配色与设置面板的开关同源） */
.autosave-btn { gap: 7px; }
/* 迷你开关轨道：顶栏自动保存与文件菜单「新建内核」共用 */
.mini-track {
  position: relative;
  flex: none;
  width: 24px; height: 14px;
  border-radius: 999px;
  background: var(--mk-border-strong);
  transition: background-color 150ms ease;
}
.mini-knob {
  position: absolute;
  top: 2px; left: 2px;
  width: 10px; height: 10px;
  border-radius: 50%;
  background: var(--mk-accent-fg);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
  transition: transform 150ms ease;
}
.mini-track.on { background: var(--mk-accent); }
.mini-track.on .mini-knob { transform: translateX(10px); }

.active-dot {
  position: absolute;
  bottom: 2px; left: 50%;
  width: 3px; height: 3px;
  border-radius: 9999px;
  background: var(--mk-accent);
  transform: translateX(-50%);
}

/* 更新可用：右上角 accent 圆点提示 */
.update-dot {
  position: absolute;
  top: 4px; right: 4px;
  width: 6px; height: 6px;
  border-radius: 9999px;
  background: var(--mk-danger); /* 语义提示色：--mk-accent 是主按钮色，浅色主题下近黑，做提示点会发黑 */
}

/* 下载中：加载转圈（总量未知时的兜底） */
.spin {
  width: 14px; height: 14px;
  border: 2px solid var(--mk-border);
  border-top-color: var(--mk-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 下载进度环：内嵌更新图标位，随 update-progress 事件实时推进；环心显示百分比数字 */
.update-ring {
  width: 20px; height: 20px;
}
.update-ring circle {
  fill: none;
  stroke-width: 2.5;
}
.update-ring .ring-bg { stroke: var(--mk-border); }
.update-ring .ring-fg {
  stroke: var(--mk-accent);
  stroke-linecap: round;
  transition: stroke-dashoffset 200ms ease;
}
/* 环心数字：只显示整数（% 由 tooltip 与环语义表达），三位数时缩小防溢出 */
.update-ring .ring-text {
  fill: var(--mk-fg);
  font-size: 7.5px;
  font-weight: 700;
  letter-spacing: -0.2px;
  font-variant-numeric: tabular-nums;
}

.mode-seg { display: inline-flex; gap: 2px; flex: none; }

/* ---- 顶栏下拉（文件 / 输出） ---- */
/* 菜单经 Teleport 挂到 body，用 fixed + 内联 top/left（由 trigger 坐标推导）定位，
   彻底脱离 .toolbar/.tb-main 的 overflow:hidden 裁剪（否则向下展开的部分会被整片切掉） */
.tb-menu-wrap { position: relative; display: inline-flex; flex: none; }
/* 下拉外观走 global.css 的 .mk-menu / .mk-menu-item（与右键菜单同一份规格），
   这里只留展开动效与输出菜单的分组标题、图标配色 */
.tb-menu {
  animation: om-in 130ms ease-out;
}
@keyframes om-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
/* 文件菜单：条目内容宽度撑开，快捷键贴右（.mk-menu-key 自带 margin-left:auto） */
.file-menu .mk-menu-item { min-width: 210px; }
.file-menu .om-group {
  /* 左内距与 .mk-menu-item 的 10px 对齐：分组标题与条目文字在同一条竖线上 */
  padding: 6px 10px 2px;
  font-size: 10.5px;
  color: var(--mk-fg-muted);
  letter-spacing: 0.02em;
  user-select: none;
}
.file-menu .om-ic { width: 14px; height: 14px; color: var(--mk-fg-muted); flex: none; }
.file-menu .mk-menu-item:hover:not(:disabled) .om-ic { color: var(--mk-fg); }
.file-menu .om-label { flex: 1; }
/* 「新建文件」行：md/mh 开关嵌在文字后面，整行仍按条目样式悬停、点击即新建 */
.file-menu .kernel-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 210px;
  padding: 6px 10px;
  border-radius: var(--mk-radius-sm);
  color: var(--mk-fg);
  font-size: 12.5px;
  cursor: pointer;
}
.file-menu .kernel-line:hover { background: var(--mk-hover); }
.kernel-new {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.kernel-new:focus-visible { outline: var(--mk-focus-ring); outline-offset: 2px; border-radius: 3px; }
/* 内核开关：md / mh / txt 嵌在轨道内，当前态用 accent 实底；点击不触发整行新建 */
.kernel-switch {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex: none;
  height: 16px;
  padding: 1px;
  border-radius: 999px;
  background: var(--mk-active);
}
.ks-opt {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 14px;
  padding: 0 3px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  font-family: inherit;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.01em;
  color: var(--mk-fg-muted);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.ks-opt:hover:not(.on) { color: var(--mk-fg); }
.ks-opt:focus-visible { outline: var(--mk-focus-ring); outline-offset: 1px; }
.ks-opt.on { background: var(--mk-accent); color: var(--mk-accent-fg); }
/* 模式位置=居中（设置-外观「模式位置」，默认）：三按钮组脱离左侧功能流，
   绝对定位于顶栏水平中心（tb-main 与 toolbar 垂直同心，top 50% 即垂直居中）。
   按钮自身阻断拖拽，原空位由 flex-spacer 的拖拽区承接 */
.mode-seg.centered {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 1;
}
.font-seg { display: inline-flex; gap: 1px; flex: none; }
/* 字号组整体收窄：加减按钮 24px，中间 Aa 占位 20px（原 28/28 太占顶栏） */
.font-seg > .tb-btn { min-width: 24px; width: 24px; }
.font-seg > .tb-font-type { min-width: 20px; width: 20px; }
.font-aa { font-size: 10px; font-weight: 600; letter-spacing: -0.1px; line-height: 1; }

/* 窗口控制：方角、宽热区，关闭悬停红（Windows 惯例）
   flex:none 锚定右端，任何窗宽下不允许隐藏或压缩 */
.win-btn { border-radius: 0; width: 36px; height: 32px; }
.win-btn--close:hover:not(:disabled) { background: #e81123; }
.win-btn--close:hover:not(:disabled) .icon { color: #fff; }

/* macOS：原生红绿灯位于左上（trafficLightPosition x:12,y:14），
   预留约 78px 留白避免功能区按钮压到红绿灯；右侧自绘三键已隐藏 */
.toolbar.is-mac { padding-left: 0; }
.traffic-pad { width: 78px; flex: none; align-self: stretch; }

/* ---- 窄窗分级收纳（按 .toolbar 实际宽度，侧边栏占位自动计入）----
   T1 ≤980px：文字按钮收成纯图标
   T2 ≤720px：隐藏 GitHub、字号占位图标；分隔线收窄
   T3 ≤600px：隐藏「另存为」；间距进一步压缩
   T4 ≤520px：隐藏字号调节组
   窗口控制三键全程不参与收纳 */
@container (max-width: 980px) {
  .tb-btn--text .label { display: none; }
  .tb-btn--text { padding: 0 4px; gap: 0; justify-content: center; }
}
@container (max-width: 720px) {
  .tb-github, .tb-font-type { display: none; }
  .divider { margin: 0 4px; }
  /* 兜底：居中档主判定是组件内动态吸附（贴近左侧功能区即回落，见 updateSegSnap），
     此处固定断点仅在 RO 异常时保证居中组不悬空 */
  .mode-seg.centered { position: static; transform: none; }
}
@container (max-width: 600px) {
  .toolbar, .tb-main { gap: 1px; }
  .divider { margin: 0 2px; height: 14px; }
  .tb-save-as { display: none; }
  .win-btn { width: 32px; }
}
@container (max-width: 520px) {
  .font-seg { display: none; }
}
</style>
