<script setup lang="ts">
/** 标签栏 —— chip 形标签 + 类型图标 + 脏标记 + 关闭按钮 + 右键菜单（复制/重命名/批量关闭） */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  CircleX,
  Copy,
  FileText,
  Layers,
  PenLine,
  X,
} from '@lucide/vue';
import { useTabsStore } from '../stores/tabsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useEditorStore } from '../stores/editorStore';
import { useCtxMenu } from '../composables/useCtxMenu';
import AppDialog from './AppDialog.vue';
import { useI18n } from '../i18n';

const tabs = useTabsStore();
const ws = useWorkspaceStore();
const editor = useEditorStore();
const { t } = useI18n();

const emit = defineEmits<{
  (e: 'close', id: string): void;
  /** 批量关闭（脏页由父级 Workbench 统一弹窗确认） */
  (e: 'close-batch', ids: string[]): void;
}>();

// ---- 标签栏横向滚动：在该区域滚动鼠标滚轮即可平移标签 ----
const stripRef = ref<HTMLElement | null>(null);

function onWheel(e: WheelEvent) {
  const el = stripRef.value;
  if (!el) return;
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (delta !== 0) {
    el.scrollLeft += delta;
    e.preventDefault();
  }
}

// ---- 激活标签联动滚动：目录树点击/搜索跳转打开文件后，保证激活标签在可视区内 ----
watch(
  () => tabs.activeId,
  async () => {
    await nextTick(); // 等新标签 DOM 渲染完成（新开文件才有这个标签）
    const strip = stripRef.value;
    const el = strip?.querySelector<HTMLElement>('.tab.active');
    if (!strip || !el) return;
    // 用 rect 比较（offsetLeft 依赖 offsetParent，tabbar 未定位会取错基准）
    const r = el.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    if (r.left < s.left) {
      strip.scrollBy({ left: r.left - s.left - 8, behavior: 'smooth' });
    } else if (r.right > s.right) {
      strip.scrollBy({ left: r.right - s.right + 8, behavior: 'smooth' });
    }
  },
);

// ---- 右键菜单（useCtxMenu：视口夹紧定位） ----
const { menu, setMenuRef, open: openCtxMenu, close: closeCtxMenu } = useCtxMenu();
/** 右键目标标签 id 单独保存：菜单项点击（document click 关闭菜单）后仍可取到 */
const ctxTabId = ref<string | null>(null);
const ctxIdx = computed(() =>
  ctxTabId.value ? tabs.tabs.findIndex((t) => t.id === ctxTabId.value) : -1,
);
const ctxTabPath = computed(() =>
  ctxIdx.value >= 0 ? tabs.tabs[ctxIdx.value]?.path ?? null : null,
);

function onTabContext(e: MouseEvent, id: string) {
  e.preventDefault();
  ctxTabId.value = id;
  openCtxMenu(e.clientX, e.clientY);
}
function closeMenu() {
  ctxTabId.value = null;
  closeCtxMenu();
}
onMounted(() => document.addEventListener('click', closeMenu));
onBeforeUnmount(() => document.removeEventListener('click', closeMenu));

function menuCopyName() {
  const tab = ctxIdx.value >= 0 ? tabs.tabs[ctxIdx.value] : null;
  if (!tab) return;
  void copyText(tab.title);
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    editor.showToast(t('tabbar.copied'), 'success');
  } catch {
    // WebView 剪贴板 API 不可用时的兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    editor.showToast(ok ? t('tabbar.copied') : t('tabbar.copyFail'), ok ? 'success' : 'error');
  }
}

// ---- 重命名（走 workspaceStore.renameEntry，联动标签/树/展开态） ----
const renameDialog = ref<{ visible: boolean; value: string; path: string }>({
  visible: false, value: '', path: '',
});
const renameError = ref('');
/** 按标签 id 打开重命名对话框（右键菜单与 F2 快捷键共用；无路径的新文档忽略） */
function renameTab(id: string | null) {
  const tab = id ? tabs.tabs.find((x) => x.id === id) : null;
  if (!tab || !tab.path) return;
  renameDialog.value = { visible: true, value: tab.title, path: tab.path };
}
function menuRename() {
  renameTab(ctxTabId.value);
}
/** 供 Workbench F2 快捷键调用：重命名当前激活标签 */
function renameActive() {
  renameTab(tabs.activeId);
}
defineExpose({ renameActive });
async function doRename() {
  const { path, value } = renameDialog.value;
  if (!path || !value.trim()) return;
  try {
    await ws.renameEntry(path, value.trim());
    renameDialog.value.visible = false;
    renameError.value = '';
  } catch (err) {
    renameError.value = err instanceof Error ? err.message : String(err);
  }
}

// ---- 关闭动作 ----
function menuClose() {
  if (ctxTabId.value) emit('close', ctxTabId.value);
}
function menuCloseLeft() {
  const idx = ctxIdx.value;
  if (idx <= 0) return;
  emit('close-batch', tabs.tabs.slice(0, idx).map((t) => t.id));
}
function menuCloseRight() {
  const idx = ctxIdx.value;
  if (idx < 0 || idx >= tabs.tabs.length - 1) return;
  emit('close-batch', tabs.tabs.slice(idx + 1).map((t) => t.id));
}
function menuCloseOthers() {
  const idx = ctxIdx.value;
  if (idx < 0) return;
  emit('close-batch', tabs.tabs.filter((_, i) => i !== idx).map((t) => t.id));
}
function menuCloseAll() {
  if (tabs.tabs.length === 0) return;
  emit('close-batch', tabs.tabs.map((t) => t.id));
}
</script>

<template>
  <div ref="stripRef" class="tabbar" v-if="tabs.tabs.length > 0" @wheel="onWheel">
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === tabs.activeId }"
      :data-tip="tab.path ?? t('tabbar.untitled')"
      @click="tabs.activate(tab.id)"
      @auxclick.middle="emit('close', tab.id)"
      @contextmenu="onTabContext($event, tab.id)"
    >
      <FileText class="t-icon" />
      <span class="title">{{ tab.title }}</span>
      <span class="dirty" v-if="tab.isDirty" :data-tip="t('tabbar.dirtyTip')" />
      <button class="close" @click.stop="emit('close', tab.id)" :data-tip="t('tabbar.closeTabTip')">
        <X class="x-icon" />
      </button>
    </div>

    <!-- 标签右键菜单：图标 + 名称 + 快捷键（仅标注真实存在的绑定，见 Workbench.onKeydown） -->
    <div v-if="menu" :ref="setMenuRef" class="ctx-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button class="ctx-item" @click="menuCopyName">
        <Copy class="ctx-ico" /><span>{{ t('tabbar.copyName') }}</span>
      </button>
      <button class="ctx-item" :disabled="!ctxTabPath" @click="menuRename">
        <PenLine class="ctx-ico" /><span>{{ t('tabbar.renameTitle') }}</span><kbd class="ctx-key">F2</kbd>
      </button>
      <div class="ctx-sep" />
      <button class="ctx-item" @click="menuClose">
        <X class="ctx-ico" /><span>{{ t('tabbar.closeTab') }}</span><kbd class="ctx-key">Ctrl+W</kbd>
      </button>
      <button class="ctx-item" :disabled="ctxIdx <= 0" @click="menuCloseLeft">
        <ArrowLeftToLine class="ctx-ico" /><span>{{ t('tabbar.closeLeft') }}</span>
      </button>
      <button class="ctx-item" :disabled="ctxIdx < 0 || ctxIdx >= tabs.tabs.length - 1" @click="menuCloseRight">
        <ArrowRightToLine class="ctx-ico" /><span>{{ t('tabbar.closeRight') }}</span>
      </button>
      <button class="ctx-item" :disabled="tabs.tabs.length <= 1" @click="menuCloseOthers">
        <Layers class="ctx-ico" /><span>{{ t('tabbar.closeOthers') }}</span>
      </button>
      <button class="ctx-item danger" @click="menuCloseAll">
        <CircleX class="ctx-ico" /><span>{{ t('tabbar.closeAll') }}</span><kbd class="ctx-key">Ctrl+Shift+W</kbd>
      </button>
    </div>

    <!-- 重命名对话框 -->
    <AppDialog
      :visible="renameDialog.visible"
      :title="t('tabbar.renameTitle')"
      input
      :input-value="renameDialog.value"
      :placeholder="t('tabbar.newNamePlaceholder')"
      @confirm="renameDialog.value = $event; doRename()"
      @cancel="renameDialog.visible = false; renameError = ''"
    >
      <p class="err" v-if="renameError">{{ renameError }}</p>
    </AppDialog>
  </div>
</template>

<style scoped>
.tabbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  padding: 0 8px;
  background: var(--mk-panel);
  border-bottom: 1px solid var(--mk-border);
  overflow-x: auto;
  overflow-y: hidden;
  flex: none;
  user-select: none;
}
.tabbar::-webkit-scrollbar {
  display: none;
}
.tabbar {
  scrollbar-width: none;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px 0 10px;
  font-size: 12px;
  color: var(--mk-fg-muted);
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: var(--mk-radius);
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
.tab:hover { background: var(--mk-hover); color: var(--mk-fg); }
.tab.active {
  color: var(--mk-fg);
  background: var(--mk-bg);
  border-color: var(--mk-border);
}
.t-icon { width: 13px; height: 13px; flex: none; opacity: 0.8; }
.title { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.dirty {
  width: 7px; height: 7px;
  border-radius: 9999px;
  background: var(--mk-warn);
  flex: none;
}
.close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px;
  border: none; background: transparent;
  color: var(--mk-fg-muted);
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
}
.close:hover { background: var(--mk-active); color: var(--mk-danger); }
.x-icon { width: 12px; height: 12px; }

/* ---- 右键菜单（与 FileTree 同款） ---- */
.ctx-menu {
  position: fixed;
  z-index: 90;
  min-width: 150px;
  /* max-content：fixed 未设宽时 shrink-to-fit 会被「视口宽-left」压缩——
     右键点在标签栏右缘时菜单被压窄，「关闭全部 Ctrl+Shift+W」折行，
     且 useCtxMenu 夹紧公式用的正是这个被压窄的测量值。锁定内容宽后测量即真实宽 */
  width: max-content;
  background: var(--mk-panel);
  color: var(--mk-fg);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
  padding: 4px;
  display: flex;
  flex-direction: column;
}
.ctx-item {
  border: none;
  background: transparent;
  text-align: left;
  color: var(--mk-fg);
  font-size: 12.5px;
  padding: 6px 10px;
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 168px;
  white-space: nowrap; /* 兜底：菜单文案任何情况下不折行 */
}
.ctx-ico { width: 13px; height: 13px; flex: none; opacity: 0.75; }
.ctx-key {
  margin-left: auto;
  padding-left: 14px;
  font-family: inherit;
  font-size: 11px;
  color: var(--mk-fg-muted);
  pointer-events: none;
  white-space: nowrap;
}
.ctx-item:hover:not(:disabled) { background: var(--mk-hover); }
.ctx-item.danger { color: var(--mk-danger); }
.ctx-item:disabled { opacity: 0.4; cursor: default; }
.ctx-sep { height: 1px; background: var(--mk-border); margin: 4px 6px; }
.err { color: var(--mk-danger); font-size: 12px; margin: 6px 0 0; }
</style>
