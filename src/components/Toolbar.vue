<script setup lang="ts">
/** 顶栏 = 标题栏 + 工具栏（对齐 DBX AppToolbar）：无品牌块，左侧功能按钮，右侧窗口控制 */
import { onBeforeUnmount, onMounted, ref, computed, watch } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  FolderOpen, Folder, FilePlus2, Save, SaveAll,
  Pencil, Columns2, BookOpen,   Search, FileCode2, Printer,
  Sun, Moon, Settings, Minus, Plus, Type, Download,
  PanelLeftOpen,
  Minus as WinMin, Square, Copy, X,
} from '@lucide/vue';

import type { EditorMode, ThemeKind } from '../api/types';
import { useEditorStore } from '../stores/editorStore';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import { flushSessionSnapshot } from '../utils/sessionSnapshot';
import AppDialog from './AppDialog.vue';

defineProps<{
  mode: EditorMode;
  theme: ThemeKind;
  hasActive: boolean;
  searchActive: boolean;
  /** 左侧工作区已隐藏：顶栏前部显示「展开侧边栏」 */
  sidebarHidden: boolean;
}>();

const emit = defineEmits<{
  (e: 'open-file'): void;
  (e: 'open-workspace'): void;
  (e: 'toggle-sidebar'): void;
  (e: 'new'): void;
  (e: 'save'): void;
  (e: 'save-as'): void;
  (e: 'set-mode', m: EditorMode): void;
  (e: 'toggle-theme'): void;
  (e: 'font', delta: number): void;
  (e: 'search'): void;
  (e: 'export-html'): void;
  (e: 'print-pdf'): void;
  (e: 'settings'): void;
  (e: 'github'): void;
  (e: 'update', url: string): void;
}>();

// 更新检测：挂载时向 GitHub 查询最新 Release，与本地版本比较；点击后后台下载并提示重启
const editor = useEditorStore();
const {
  state: updateState,
  latestVersion,
  currentVersion,
  releaseUrl,
  downloadUrl,
  downloadState,
  progress,
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
    return pct === null ? '正在下载更新…' : `正在下载更新 ${pct}%`;
  }
  if (downloadState.value === 'downloaded') return '更新已下载，点击重启以应用';
  if (downloadState.value === 'error') return '更新下载失败，点击前往发布页';
  switch (updateState.value) {
    case 'available':
      return `发现新版本 v${latestVersion.value}，点击下载`;
    case 'uptodate':
      return `已是最新 v${currentVersion.value}`;
    case 'checking':
      return '正在检查更新…';
    case 'error':
      return '更新检查失败，点击前往发布页';
    default:
      return '检查更新';
  }
});

/** 点击更新：有可用更新则后台下载；下载完成则弹出重启确认；
 *  已是最新时右上角 toast 提示、不跳转；检查失败才兜底跳转发布页 */
function onUpdateClick() {
  if (updateState.value === 'available' && downloadUrl.value) {
    if (downloadState.value === 'downloading') return; // 下载中：忽略
    if (downloadState.value === 'downloaded') {
      showUpdateDialog.value = true; // 已下载：再次弹出重启确认
      return;
    }
    void startDownload();
    return;
  }
  if (updateState.value === 'uptodate') {
    editor.showToast(`已是最新版本 v${currentVersion.value}`, 'info');
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

const modes: { key: EditorMode; label: string; hint: string; icon: unknown }[] = [
  { key: 'edit', label: '仅编辑', hint: 'Alt+E', icon: Pencil },
  { key: 'split', label: '分栏', hint: 'Alt+W', icon: Columns2 },
  { key: 'read', label: '阅读', hint: 'Alt+R', icon: BookOpen },
];

// ---- 窗口控制（decorations=false，本栏即标题栏） ----
// macOS：走 tauri.macos.conf.json 的原生红绿灯（titleBarStyle Overlay，左上角），
// 隐藏右侧自绘三键并预留左上空间；Windows/Linux 维持自绘三键不变
const isMac = /Mac/i.test(navigator.platform) || navigator.userAgent.includes('Macintosh');
const win = getCurrentWindow();
const isMaximized = ref(false);
let unlistenResized: (() => void) | null = null;

onMounted(async () => {
  isMaximized.value = await win.isMaximized();
  unlistenResized = await win.onResized(async () => {
    isMaximized.value = await win.isMaximized();
  });
});
onBeforeUnmount(() => {
  unlistenResized?.();
});
function minimize() { void win.minimize(); }
function toggleMaximize() { void win.toggleMaximize(); }
function closeWindow() {
  // 走 close 事件 → Workbench 的 onCloseRequested 未保存拦截仍然生效
  void win.close();
}
</script>

<template>
  <header class="toolbar" data-tauri-drag-region :class="{ 'is-mac': isMac }">
    <!-- macOS 原生红绿灯占位（titleBarStyle Overlay 绘制在左上，此区域仅留白+可拖拽） -->
    <div v-if="isMac" class="traffic-pad" data-tauri-drag-region />
    <!-- 左侧功能区：deep 拖动区（子树内空白处可拖动/双击最大化，按钮自动阻断），为右侧窗口控制让位 -->
    <div class="tb-main" data-tauri-drag-region="deep">
    <!-- 侧边栏隐藏时提供恢复入口 -->
    <button
      v-if="sidebarHidden"
      class="tb-btn tb-btn--icon tb-first"
      @click="emit('toggle-sidebar')"
      data-tip="展开侧边栏"
    >
      <PanelLeftOpen class="icon" />
    </button>
    <button class="tb-btn tb-btn--text tb-first" @click="emit('open-file')" data-tip="打开文件 (Ctrl+O)">
      <FolderOpen class="icon" />
      <span class="label">打开文件</span>
    </button>
    <button class="tb-btn tb-btn--text tb-open-ws" @click="emit('open-workspace')" data-tip="打开文件夹作为工作区">
      <Folder class="icon" />
      <span class="label">打开工作区</span>
    </button>

    <div class="divider" />

    <button class="tb-btn tb-btn--text" @click="emit('new')" data-tip="新建 (Ctrl+N)">
      <FilePlus2 class="icon" />
      <span class="label">新建</span>
    </button>
    <button class="tb-btn tb-btn--text" :disabled="!hasActive" @click="emit('save')" data-tip="保存 (Ctrl+S)">
      <Save class="icon" />
      <span class="label">保存</span>
    </button>
    <button class="tb-btn tb-btn--text tb-save-as" :disabled="!hasActive" @click="emit('save-as')" data-tip="另存为">
      <SaveAll class="icon" />
      <span class="label">另存为</span>
    </button>

    <div class="divider" />

    <div class="mode-seg" role="group" aria-label="视图模式">
      <button
        v-for="m in modes"
        :key="m.key"
        class="tb-btn tb-btn--icon"
        :class="{ 'tb-btn--active': mode === m.key }"
        :data-tip="`${m.label} (${m.hint})`"
        @click="emit('set-mode', m.key)"
      >
        <component :is="m.icon" class="icon" />
        <span v-if="mode === m.key" class="active-dot" />
      </button>
    </div>

    <div class="flex-spacer" data-tauri-drag-region />

    <button class="tb-btn tb-btn--icon" :class="{ 'tb-btn--active': searchActive }" @click="emit('search')" data-tip="全局搜索 (Ctrl+P)">
      <Search class="icon" />
      <span v-if="searchActive" class="active-dot" />
    </button>

    <button class="tb-btn tb-btn--icon" :disabled="!hasActive" @click="emit('export-html')" data-tip="导出 HTML">
      <FileCode2 class="icon" />
    </button>
    <button class="tb-btn tb-btn--icon" :disabled="!hasActive" @click="emit('print-pdf')" data-tip="打印 PDF（弹出打印对话框）">
      <Printer class="icon" />
    </button>

    <div class="divider" />

    <div class="font-seg">
      <button class="tb-btn tb-btn--icon" @click="emit('font', -1)" data-tip="减小字号（编辑与阅读全局生效）">
        <Minus class="icon icon-sm" />
      </button>
      <button class="tb-btn tb-btn--icon tb-font-type" data-tip="字号" disabled>
        <Type class="icon icon-sm" />
      </button>
      <button class="tb-btn tb-btn--icon" @click="emit('font', 1)" data-tip="增大字号（编辑与阅读全局生效）">
        <Plus class="icon icon-sm" />
      </button>
    </div>

    <div class="divider" />

    <button class="tb-btn tb-btn--icon" @click="emit('toggle-theme')" :data-tip="theme === 'dark' ? '切换到亮色' : '切换到暗色'">
      <Sun v-if="theme === 'dark'" class="icon" />
      <Moon v-else class="icon" />
    </button>
    <button class="tb-btn tb-btn--icon" @click="emit('settings')" data-tip="设置与快捷键 (F1)">
      <Settings class="icon" />
    </button>
    <a
      class="tb-btn tb-btn--icon tb-github"
      href="https://github.com/gggaiitx/mkdown-site"
      target="_blank"
      rel="noopener noreferrer"
      data-tip="GitHub 仓库"
      @click.prevent="emit('github')"
    >
      <svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    </a>
    <button
      class="tb-btn tb-btn--icon"
      :class="{ 'tb-btn--active': updateState === 'available' }"
      :data-tip="updateTip"
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
      <span v-else-if="downloadState === 'downloading'" class="spin" />
      <Download v-else class="icon" />
      <span
        v-if="updateState === 'available' && downloadState !== 'downloading' && downloadState !== 'downloaded'"
        class="update-dot"
      />
    </button>

    </div><!-- /tb-main -->

    <AppDialog
      :visible="showUpdateDialog"
      title="更新就绪"
      :message="`新版本 v${latestVersion} 已下载完成，是否立即重启以应用更新？`"
      confirm-text="立即更新"
      cancel-text="稍后"
      @confirm="onApplyConfirm"
      @cancel="showUpdateDialog = false"
    />

    <!-- 窗口控制：macOS 由系统红绿灯接管，不再自绘 -->
    <template v-if="!isMac">
      <div class="divider" />
      <button class="tb-btn tb-btn--icon win-btn" data-tip="最小化" @click="minimize">
        <WinMin class="icon icon-sm" />
      </button>
      <button class="tb-btn tb-btn--icon win-btn" :data-tip="isMaximized ? '还原' : '最大化'" @click="toggleMaximize">
        <Copy v-if="isMaximized" class="icon icon-sm" />
        <Square v-else class="icon icon-sm" />
      </button>
      <button class="tb-btn tb-btn--icon win-btn win-btn--close" data-tip="关闭" @click="closeWindow">
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
}
.divider {
  width: 1px; height: 18px;
  background: var(--mk-border);
  margin: 0 6px;
  flex: none;
}
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
.font-seg { display: inline-flex; gap: 2px; flex: none; }

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
   T3 ≤600px：隐藏「打开工作区」「另存为」；间距进一步压缩
   T4 ≤520px：隐藏字号调节组
   窗口控制三键全程不参与收纳 */
@container (max-width: 980px) {
  .tb-btn--text .label { display: none; }
  .tb-btn--text { padding: 0 4px; gap: 0; justify-content: center; }
}
@container (max-width: 720px) {
  .tb-github, .tb-font-type { display: none; }
  .divider { margin: 0 4px; }
}
@container (max-width: 600px) {
  .toolbar, .tb-main { gap: 1px; }
  .divider { margin: 0 2px; height: 14px; }
  .tb-open-ws, .tb-save-as { display: none; }
  .win-btn { width: 32px; }
}
@container (max-width: 520px) {
  .font-seg { display: none; }
}
</style>
