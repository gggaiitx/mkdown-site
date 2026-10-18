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
  Maximize,
  PenLine,
  RefreshCw,
  X,
} from '@lucide/vue';
import { isPreviewKind, useTabsStore, type DocumentTab } from '../stores/tabsStore';
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
  /** 刷新完成：父级在内容区播放刷新动效 */
  (e: 'reloaded'): void;
  /** 页面全屏：目标标签可能不是当前标签，激活与全屏的分发都在 Workbench */
  (e: 'fullscreen', id: string): void;
}>();

// ---- 标签栏横向滚动：在该区域滚动鼠标滚轮即可平移标签 ----
const stripRef = ref<HTMLElement | null>(null);

function onWheel(e: WheelEvent) {
  // 溢出菜单是 strip 的 DOM 子节点，菜单内滚轮会冒泡到此——放行给菜单原生滚动
  if ((e.target as HTMLElement | null)?.closest?.('.ov-menu')) return;
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

// ---- 溢出隐藏标签：悬停第一/最后一个完全可视的标签时，弹出被裁切标签的下拉菜单 ----
type OvSide = 'left' | 'right';
const ovMenu = ref<{ side: OvSide; ids: string[]; x: number; y: number } | null>(null);
/** 条目取自 store 保持实时顺序与脏标记（ids 为打开菜单时的快照） */
const ovMenuTabs = computed(() =>
  ovMenu.value ? tabs.tabs.filter((t) => ovMenu.value!.ids.includes(t.id)) : [],
);
const ovMenuStyle = computed(() => {
  const m = ovMenu.value;
  if (!m) return {};
  // 右侧菜单锚定标签右缘：用 right 定位避免依赖菜单自身宽度
  return m.side === 'left'
    ? { left: `${m.x}px`, top: `${m.y}px` }
    : { right: `${window.innerWidth - m.x}px`, top: `${m.y}px` };
});

/** 读 DOM 计算两侧标签可视状态：有任何部分露出即算「可视」（触发点），
 *  完全不可见才算「隐藏」（菜单条目）。标签从左到右排列，交集布尔序列连续，
 *  故 [0, firstVis) 与 (lastVis, end] 内均为完全不可见的标签。
 *  同时返回首/末可视标签的可见比例（可见宽/自身宽），供放宽档触发判定 */
function hiddenSides() {
  const strip = stripRef.value;
  if (!strip) return null;
  const els = strip.querySelectorAll<HTMLElement>('.tab');
  if (els.length !== tabs.tabs.length) return null;
  const s = strip.getBoundingClientRect();
  const vis = Array.from(els, (el) => {
    const r = el.getBoundingClientRect();
    return r.right > s.left && r.left < s.right;
  });
  const firstVis = vis.indexOf(true);
  const lastVis = vis.lastIndexOf(true);
  const visRatio = (i: number): number => {
    if (i < 0 || i >= els.length) return 1;
    const r = els[i].getBoundingClientRect();
    if (r.width <= 0) return 1;
    const seen = Math.min(r.right, s.right) - Math.max(r.left, s.left);
    return Math.max(0, seen) / r.width;
  };
  return {
    firstVis,
    lastVis,
    firstVisRatio: visRatio(firstVis),
    lastVisRatio: visRatio(lastVis),
    left: firstVis > 0 ? tabs.tabs.slice(0, firstVis).map((t) => t.id) : [],
    right:
      lastVis >= 0 && lastVis < tabs.tabs.length - 1
        ? tabs.tabs.slice(lastVis + 1).map((t) => t.id)
        : [],
  };
}

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let ovCloseTimer: ReturnType<typeof setTimeout> | null = null;

function clearHoverTimer() {
  if (hoverTimer !== null) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}
function clearOvCloseTimer() {
  if (ovCloseTimer !== null) {
    clearTimeout(ovCloseTimer);
    ovCloseTimer = null;
  }
}
function scheduleOvClose() {
  clearOvCloseTimer();
  ovCloseTimer = setTimeout(() => {
    ovCloseTimer = null;
    ovMenu.value = null;
  }, 220);
}
function closeOvMenuNow() {
  clearHoverTimer();
  clearOvCloseTimer();
  ovMenu.value = null;
}

function onTabEnter(_e: MouseEvent, id: string) {
  if (dragId.value) return;
  clearHoverTimer();
  // 延时触发：快速滑过标签不弹菜单，悬停片刻才弹
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    openOvMenu(id);
  }, 260);
}
function onTabLeave() {
  clearHoverTimer();
  if (ovMenu.value) scheduleOvClose();
}

function openOvMenu(id: string) {
  const idx = tabs.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const hs = hiddenSides();
  const strip = stripRef.value;
  if (!hs || !strip) return;
  const el = strip.querySelector<HTMLElement>(`.tab[data-tab-id="${id}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  // 触发范围放宽一档：末个可视标签露出 ≤60%（基本被裁没）时，倒数第二个也可触发右侧；
  // 露出充分时最后一个自身就是明确触发点，不放宽。左侧对称。
  // 两条件同时命中（可视区仅 2~3 个标签）时右侧优先
  const nearLast =
    idx === hs.lastVis || (idx === hs.lastVis - 1 && hs.lastVisRatio <= 0.6);
  const nearFirst =
    idx === hs.firstVis || (idx === hs.firstVis + 1 && hs.firstVisRatio <= 0.6);
  // 部分裁切标签的 rect 越出视口，锚点收敛到标签栏可视范围，防止菜单飞出屏幕
  const sr = strip.getBoundingClientRect();
  if (nearLast && hs.right.length > 0) {
    ovMenu.value = { side: 'right', ids: hs.right, x: Math.min(r.right, sr.right), y: r.bottom + 6 };
  } else if (nearFirst && hs.left.length > 0) {
    ovMenu.value = { side: 'left', ids: hs.left, x: Math.max(r.left, sr.left), y: r.bottom + 6 };
  } else {
    ovMenu.value = null;
  }
  void nextTick(clampOvMenu);
}

const ovMenuRef = ref<HTMLElement | null>(null);
function setOvMenuRef(el: unknown) {
  ovMenuRef.value = (el as HTMLElement | null) ?? null;
}

/** 渲染后按菜单实测宽夹紧水平位置：左菜单不越右缘、右菜单不越左缘 */
function clampOvMenu() {
  const el = ovMenuRef.value;
  const m = ovMenu.value;
  if (!el || !m) return;
  const w = el.getBoundingClientRect().width;
  const M = 6;
  let x = m.x;
  if (m.side === 'left') {
    if (x + w > window.innerWidth - M) x = window.innerWidth - w - M; // 贴右缘
    if (x < M) x = M;
  } else {
    // 右菜单以 x 为右缘向左展开：先夹右缘（部分裁切锚点已收敛，此处双保险），再夹左缘
    if (x > window.innerWidth - M) x = window.innerWidth - M;
    if (x - w < M) x = w + M;
  }
  if (x !== m.x) ovMenu.value = { ...m, x };
}

/** 菜单点选：激活后由 activeId watch 平滑滚动到可视区 */
function ovActivate(id: string) {
  tabs.activate(id);
  ovMenu.value = null;
}

/** 标签栏滚动后菜单锚定位置失效，立即关闭 */
function onStripScroll() {
  if (ovMenu.value || hoverTimer !== null) closeOvMenuNow();
}
// 标签增删会改变可视布局，直接关闭
watch(
  () => tabs.tabs.length,
  () => closeOvMenuNow(),
);

// ---- 拖拽换序（HTML5 DnD；中点法判定插入到目标之前/之后） ----
const dragId = ref<string | null>(null);
const dropHint = ref<{ id: string; place: 'before' | 'after' } | null>(null);

function tabClass(tab: DocumentTab) {
  return {
    active: tab.id === tabs.activeId,
    dragging: tab.id === dragId.value,
    'drop-before': dropHint.value?.id === tab.id && dropHint.value.place === 'before',
    'drop-after': dropHint.value?.id === tab.id && dropHint.value.place === 'after',
  };
}

function onTabDragStart(e: DragEvent, id: string) {
  if (!e.dataTransfer) return;
  dragId.value = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id); // 不写入数据 Chromium 不进入拖拽
  closeOvMenuNow();
}

function onTabDragOver(e: DragEvent, id: string) {
  if (!dragId.value || !e.dataTransfer) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (id === dragId.value) {
    dropHint.value = null; // 拖回自身不放
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const place = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
  if (dropHint.value?.id !== id || dropHint.value.place !== place) {
    dropHint.value = { id, place };
  }
}

function onTabDragLeave(e: DragEvent, id: string) {
  if (dropHint.value?.id !== id) return;
  const to = e.relatedTarget as Node | null;
  if (to && (e.currentTarget as HTMLElement).contains(to)) return; // 移入子元素不算离开
  dropHint.value = null;
}

function onTabDrop(e: DragEvent, id: string) {
  const from = dragId.value;
  const hint = dropHint.value;
  onDragEnd();
  e.preventDefault();
  if (!from || from === id) return;
  tabs.moveTab(from, id, hint?.id === id ? hint.place : 'before');
}
function onDragEnd() {
  dragId.value = null;
  dropHint.value = null;
}
/** 拖拽时鼠标贴近 strip 左右边缘持续平移标签栏（dragover 高频触发逐步滚动） */
function onStripDragOver(e: DragEvent) {
  if (!dragId.value) return;
  const strip = stripRef.value;
  if (!strip) return;
  const r = strip.getBoundingClientRect();
  if (e.clientX < r.left + 32) strip.scrollLeft -= 8;
  else if (e.clientX > r.right - 32) strip.scrollLeft += 8;
}

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
/** 预览类标签（docx/xlsx/图片/pdf）没有编辑引擎，全屏无从谈起 → 菜单里不摆死项 */
const ctxIsPreview = computed(() => {
  const tab = ctxIdx.value >= 0 ? tabs.tabs[ctxIdx.value] : null;
  return tab ? isPreviewKind(tab.kind) : true;
});

function menuFullscreen() {
  if (ctxTabId.value) emit('fullscreen', ctxTabId.value);
}

function onTabContext(e: MouseEvent, id: string) {
  e.preventDefault();
  ctxTabId.value = id;
  openCtxMenu(e.clientX, e.clientY);
}
function closeMenu() {
  ctxTabId.value = null;
  closeOvMenuNow();
  closeCtxMenu();
}
onMounted(() => document.addEventListener('click', closeMenu));
onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenu);
  // 悬停弹出/自动关闭的延时定时器（220~260ms 自停）：卸载时清掉，
  // 避免回调操作已卸载组件的响应式状态（P2-22）
  clearHoverTimer();
  clearOvCloseTimer();
});

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
defineExpose({ renameActive, reloadActive });
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

// ---- 刷新（重读磁盘；脏文档先确认丢弃） ----
const reloadConfirm = ref<{ visible: boolean; tabId: string | null }>({
  visible: false, tabId: null,
});
/** 刷新共用入口：无路径（未保存新建）不可刷新；脏文档先弹确认丢弃未保存修改 */
async function requestReload(tab: DocumentTab | undefined | null): Promise<void> {
  if (!tab?.path) return;
  if (tab.isDirty) {
    reloadConfirm.value = { visible: true, tabId: tab.id };
    return;
  }
  await doReload(tab.id);
}
function menuReload() {
  void requestReload(ctxIdx.value >= 0 ? tabs.tabs[ctxIdx.value] : null);
}
/** 供父级调用（编辑区右键菜单）：刷新当前激活标签 */
function reloadActive() {
  void requestReload(tabs.activeTab);
}
async function doReload(id: string) {
  try {
    await tabs.reloadTab(id);
    emit('reloaded');
    editor.showToast(t('tabbar.reloaded'), 'success');
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
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
  <div
    ref="stripRef"
    class="tabbar"
    v-if="tabs.tabs.length > 0"
    @wheel="onWheel"
    @scroll="onStripScroll"
    @dragover="onStripDragOver"
  >
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab"
      :class="tabClass(tab)"
      :data-tab-id="tab.id"
      v-tip="tab.path ?? t('tabbar.untitled')"
      :draggable="true"
      @click="tabs.activate(tab.id)"
      @auxclick.middle="emit('close', tab.id)"
      @contextmenu="onTabContext($event, tab.id)"
      @mouseenter="onTabEnter($event, tab.id)"
      @mouseleave="onTabLeave"
      @dragstart="onTabDragStart($event, tab.id)"
      @dragover="onTabDragOver($event, tab.id)"
      @dragleave="onTabDragLeave($event, tab.id)"
      @drop="onTabDrop($event, tab.id)"
      @dragend="onDragEnd"
    >
      <FileText class="t-icon" />
      <span class="title">{{ tab.title }}</span>
      <span class="dirty" v-if="tab.isDirty" v-tip="t('tabbar.dirtyTip')" />
      <button class="close" @click.stop="emit('close', tab.id)" v-tip="t('tabbar.closeTabTip')">
        <X class="x-icon" />
      </button>
    </div>

    <!-- 溢出隐藏标签菜单：锚定第一/最后一个可视标签，点选激活并自动滚动到可视区 -->
    <div
      v-if="ovMenu"
      :ref="setOvMenuRef"
      class="mk-menu ov-menu"
      :style="ovMenuStyle"
      @mouseenter="clearOvCloseTimer"
      @mouseleave="scheduleOvClose"
    >
      <button
        v-for="t in ovMenuTabs"
        :key="t.id"
        class="mk-menu-item ov-item"
        :class="{ active: t.id === tabs.activeId }"
        @click="ovActivate(t.id)"
      >
        <FileText class="ov-ico" />
        <span class="ov-title">{{ t.title }}</span>
        <span class="ov-dirty" v-if="t.isDirty" />
      </button>
    </div>

    <!-- 标签右键菜单：图标 + 名称 + 快捷键（仅标注真实存在的绑定，见 Workbench.onKeydown） -->
    <div v-if="menu" :ref="setMenuRef" class="mk-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button class="mk-menu-item" @click="menuCopyName">
        <Copy class="mk-menu-ico" /><span>{{ t('tabbar.copyName') }}</span>
      </button>
      <button class="mk-menu-item" :disabled="!ctxTabPath" @click="menuRename">
        <PenLine class="mk-menu-ico" /><span>{{ t('tabbar.renameTitle') }}</span><kbd class="mk-menu-key">F2</kbd>
      </button>
      <div class="mk-menu-sep" />
      <button class="mk-menu-item" :disabled="!ctxTabPath" @click="menuReload">
        <RefreshCw class="mk-menu-ico" /><span>{{ t('tabbar.reload') }}</span>
      </button>
      <button v-if="!ctxIsPreview" class="mk-menu-item" @click="menuFullscreen">
        <Maximize class="mk-menu-ico" /><span>{{ t('tabbar.fullscreen') }}</span><kbd class="mk-menu-key">F11</kbd>
      </button>
      <button class="mk-menu-item" @click="menuClose">
        <X class="mk-menu-ico" /><span>{{ t('tabbar.closeTab') }}</span><kbd class="mk-menu-key">Ctrl+W</kbd>
      </button>
      <button class="mk-menu-item" :disabled="ctxIdx <= 0" @click="menuCloseLeft">
        <ArrowLeftToLine class="mk-menu-ico" /><span>{{ t('tabbar.closeLeft') }}</span>
      </button>
      <button class="mk-menu-item" :disabled="ctxIdx < 0 || ctxIdx >= tabs.tabs.length - 1" @click="menuCloseRight">
        <ArrowRightToLine class="mk-menu-ico" /><span>{{ t('tabbar.closeRight') }}</span>
      </button>
      <button class="mk-menu-item" :disabled="tabs.tabs.length <= 1" @click="menuCloseOthers">
        <Layers class="mk-menu-ico" /><span>{{ t('tabbar.closeOthers') }}</span>
      </button>
      <button class="mk-menu-item danger" @click="menuCloseAll">
        <CircleX class="mk-menu-ico" /><span>{{ t('tabbar.closeAll') }}</span><kbd class="mk-menu-key">Ctrl+Shift+W</kbd>
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

    <!-- 刷新确认（脏文档将丢弃未保存修改） -->
    <AppDialog
      :visible="reloadConfirm.visible"
      :title="t('tabbar.reload')"
      :message="t('tabbar.reloadDirtyTip')"
      danger
      @confirm="reloadConfirm.visible = false; reloadConfirm.tabId && doReload(reloadConfirm.tabId)"
      @cancel="reloadConfirm.visible = false"
    />
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
  position: relative; /* 拖拽插入指示线（::before/::after）锚点 */
}
.tab:hover { background: var(--mk-hover); color: var(--mk-fg); }
.tab.active {
  color: var(--mk-fg);
  background: var(--mk-bg);
  border-color: var(--mk-border);
}
.tab.dragging { opacity: 0.4; }
/* 拖拽换序插入指示线：立在目标标签间隙中，不参与布局 */
.tab.drop-before::before,
.tab.drop-after::after {
  content: '';
  position: absolute;
  top: 1px;
  bottom: 1px;
  width: 2px;
  border-radius: 1px;
  background: var(--mk-accent);
  z-index: 1;
}
.tab.drop-before::before { left: -3px; }
.tab.drop-after::after { right: -3px; }
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

/* ---- 右键菜单 / 溢出菜单：外观统一走 global.css 的 .mk-menu / .mk-menu-item ----
   这里只留溢出菜单独有的滚动上限与"未激活标签用次级色"两点差异 */
.err { color: var(--mk-danger); font-size: 12px; margin: 6px 0 0; }

.ov-menu {
  min-width: 160px;
  max-width: 280px;
  max-height: 260px;
  overflow-y: auto;
}
/* 滚动条不自定义：回落全局 ::-webkit-scrollbar 规格（10px、hover 加深），与预览/阅读区一致 */
.mk-menu .ov-item {
  color: var(--mk-fg-muted);
  font-size: 12px;
}
.ov-item:hover { color: var(--mk-fg); }
.ov-item.active { color: var(--mk-fg); }
.ov-ico { width: 13px; height: 13px; flex: none; opacity: 0.8; }
.ov-title {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ov-dirty {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--mk-warn);
  flex: none;
}
</style>
