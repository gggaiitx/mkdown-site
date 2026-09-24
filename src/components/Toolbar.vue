<script setup lang="ts">
/** 顶栏 = 标题栏 + 工具栏（对齐 DBX AppToolbar）：无品牌块，左侧功能按钮，右侧窗口控制 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  FolderOpen, Folder, FilePlus2, Save, SaveAll,
  Pencil, Columns2, BookOpen, Search, FileCode2, Printer,
  Sun, Moon, Settings, Minus, Plus, Type,
  PanelLeftOpen,
  Minus as WinMin, Square, Copy, X,
} from '@lucide/vue';

import type { EditorMode, ThemeKind } from '../api/types';

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
}>();

const modes: { key: EditorMode; label: string; hint: string; icon: unknown }[] = [
  { key: 'edit', label: '仅编辑', hint: 'Alt+E', icon: Pencil },
  { key: 'split', label: '分栏', hint: 'Alt+W', icon: Columns2 },
  { key: 'read', label: '阅读', hint: 'Alt+R', icon: BookOpen },
];

// ---- 窗口控制（decorations=false，本栏即标题栏） ----
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
  <header class="toolbar" data-tauri-drag-region>
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
    <button class="tb-btn tb-btn--text" @click="emit('open-workspace')" data-tip="打开文件夹作为工作区">
      <Folder class="icon" />
      <span class="label">打开工作区</span>
    </button>
    <button class="tb-btn tb-btn--text" @click="emit('new')" data-tip="新建 (Ctrl+N)">
      <FilePlus2 class="icon" />
      <span class="label">新建</span>
    </button>

    <div class="divider" />

    <button class="tb-btn tb-btn--text" :disabled="!hasActive" @click="emit('save')" data-tip="保存 (Ctrl+S)">
      <Save class="icon" />
      <span class="label">保存</span>
    </button>
    <button class="tb-btn tb-btn--text" :disabled="!hasActive" @click="emit('save-as')" data-tip="另存为">
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
    <button class="tb-btn tb-btn--icon" :disabled="!hasActive" @click="emit('print-pdf')" data-tip="导出 PDF（WebView 打印）">
      <Printer class="icon" />
    </button>

    <div class="divider" />

    <button class="tb-btn tb-btn--icon" @click="emit('font', -1)" data-tip="减小字号（编辑与阅读全局生效）">
      <Minus class="icon icon-sm" />
    </button>
    <button class="tb-btn tb-btn--icon" data-tip="字号" disabled>
      <Type class="icon icon-sm" />
    </button>
    <button class="tb-btn tb-btn--icon" @click="emit('font', 1)" data-tip="增大字号（编辑与阅读全局生效）">
      <Plus class="icon icon-sm" />
    </button>

    <div class="divider" />

    <button class="tb-btn tb-btn--icon" @click="emit('toggle-theme')" :data-tip="theme === 'dark' ? '切换到亮色' : '切换到暗色'">
      <Sun v-if="theme === 'dark'" class="icon" />
      <Moon v-else class="icon" />
    </button>
    <button class="tb-btn tb-btn--icon" @click="emit('settings')" data-tip="设置与快捷键 (F1)">
      <Settings class="icon" />
    </button>

    <!-- 窗口控制 -->
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
  height: 28px; min-width: 28px;
  border: none; background: transparent;
  color: var(--mk-fg);
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
  white-space: nowrap;
  font-size: 11.5px;
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

.mode-seg { display: inline-flex; gap: 2px; }

/* 窗口控制：方角、宽热区，关闭悬停红（Windows 惯例） */
.win-btn { border-radius: 0; width: 40px; height: 32px; }
.win-btn--close:hover:not(:disabled) { background: #e81123; }
.win-btn--close:hover:not(:disabled) .icon { color: #fff; }
</style>
