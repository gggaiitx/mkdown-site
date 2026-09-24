<script setup lang="ts">
/** 标签栏 —— chip 形标签 + 类型图标 + 脏标记 + 关闭按钮 + 右键菜单（复制/重命名/批量关闭） */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FileText, X } from '@lucide/vue';
import { useTabsStore } from '../stores/tabsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useEditorStore } from '../stores/editorStore';
import { useCtxMenu } from '../composables/useCtxMenu';
import AppDialog from './AppDialog.vue';

const tabs = useTabsStore();
const ws = useWorkspaceStore();
const editor = useEditorStore();

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
  const t = ctxIdx.value >= 0 ? tabs.tabs[ctxIdx.value] : null;
  if (!t) return;
  void copyText(t.title);
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    editor.showToast('已复制文件名', 'success');
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
    editor.showToast(ok ? '已复制文件名' : '复制失败', ok ? 'success' : 'error');
  }
}

// ---- 重命名（走 workspaceStore.renameEntry，联动标签/树/展开态） ----
const renameDialog = ref<{ visible: boolean; value: string; path: string }>({
  visible: false, value: '', path: '',
});
const renameError = ref('');
function menuRename() {
  const path = ctxTabPath.value;
  const t = ctxIdx.value >= 0 ? tabs.tabs[ctxIdx.value] : null;
  if (!path || !t) return; // 未保存的新文档（无路径）不支持重命名
  renameDialog.value = { visible: true, value: t.title, path };
}
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
      v-for="t in tabs.tabs"
      :key="t.id"
      class="tab"
      :class="{ active: t.id === tabs.activeId }"
      :data-tip="t.path ?? '未保存的新文档'"
      @click="tabs.activate(t.id)"
      @auxclick.middle="emit('close', t.id)"
      @contextmenu="onTabContext($event, t.id)"
    >
      <FileText class="t-icon" />
      <span class="title">{{ t.title }}</span>
      <span class="dirty" v-if="t.isDirty" data-tip="未保存" />
      <button class="close" @click.stop="emit('close', t.id)" data-tip="关闭标签">
        <X class="x-icon" />
      </button>
    </div>

    <!-- 标签右键菜单 -->
    <div v-if="menu" :ref="setMenuRef" class="ctx-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button class="ctx-item" @click="menuCopyName">复制文件名</button>
      <button class="ctx-item" :disabled="!ctxTabPath" @click="menuRename">文件重命名</button>
      <div class="ctx-sep" />
      <button class="ctx-item" @click="menuClose">关闭标签</button>
      <button class="ctx-item" :disabled="ctxIdx <= 0" @click="menuCloseLeft">关闭左侧</button>
      <button class="ctx-item" :disabled="ctxIdx < 0 || ctxIdx >= tabs.tabs.length - 1" @click="menuCloseRight">关闭右侧</button>
      <button class="ctx-item" :disabled="tabs.tabs.length <= 1" @click="menuCloseOthers">关闭其他</button>
      <button class="ctx-item danger" @click="menuCloseAll">关闭全部</button>
    </div>

    <!-- 重命名对话框 -->
    <AppDialog
      :visible="renameDialog.visible"
      title="文件重命名"
      input
      :input-value="renameDialog.value"
      placeholder="新名称"
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
}
.ctx-item:hover:not(:disabled) { background: var(--mk-hover); }
.ctx-item.danger { color: var(--mk-danger); }
.ctx-item:disabled { opacity: 0.4; cursor: default; }
.ctx-sep { height: 1px; background: var(--mk-border); margin: 4px 6px; }
.err { color: var(--mk-danger); font-size: 12px; margin: 6px 0 0; }
</style>
