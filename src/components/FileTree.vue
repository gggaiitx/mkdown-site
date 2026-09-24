<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronsDownUp, ChevronDown, Check, FolderOpen, PanelLeftClose, RefreshCw, Search, Trash2, X } from '@lucide/vue';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useCtxMenu } from '../composables/useCtxMenu';
import type { NodeKind, WorkspaceNode } from '../api/types';
import FileTreeNode from './FileTreeNode.vue';
import AppDialog from './AppDialog.vue';

const ws = useWorkspaceStore();

const emit = defineEmits<{
  (e: 'open-file', path: string): void;
  /** 新建文件成功后以其父视图默认打开并进入编辑模式 */
  (e: 'open-file-edit', path: string): void;
  (e: 'hide'): void;
  /** 切换到历史工作区（Workbench 负责脏标签确认与关标签） */
  (e: 'switch-workspace', dir: string): void;
  (e: 'open-workspace'): void;
  /** 全部移除（含当前）：Workbench 负责确认、关标签、回到欢迎页 */
  (e: 'remove-all-workspaces'): void;
}>();

// ---- 工作区切换菜单（点击根目录名弹出） ----
const wsMenuOpen = ref(false);
const recentWorkspaces = computed(() => useSettingsStore().settings.recentWorkspaces);
function pickWorkspace(dir: string) {
  wsMenuOpen.value = false;
  if (dir !== ws.root) emit('switch-workspace', dir);
}
function pickOther() {
  wsMenuOpen.value = false;
  emit('open-workspace');
}
/** 全部移除（含当前工作区）：确认与执行在 Workbench */
function removeAll() {
  wsMenuOpen.value = false;
  emit('remove-all-workspaces');
}
/** 从历史列表移除工作区（仅列表，不删文件；当前工作区不提供移除） */
function removeWorkspace(dir: string) {
  const settings = useSettingsStore();
  void settings.update({
    recentWorkspaces: settings.settings.recentWorkspaces.filter((d) => d !== dir),
  });
}

// ---- 拖拽调宽（右缘手柄，200–440px） ----
const width = ref(230);
const dragging = ref(false);
let startX = 0;
let startW = 0;

function onResizeStart(e: MouseEvent) {
  dragging.value = true;
  startX = e.clientX;
  startW = width.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', onResizeEnd);
}
function onResizeMove(e: MouseEvent) {
  if (!dragging.value) return;
  width.value = Math.min(440, Math.max(200, startW + (e.clientX - startX)));
}
function onResizeEnd() {
  dragging.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeEnd);
}
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeEnd);
});

// ---- 右键菜单（useCtxMenu：视口夹紧定位，底部/右缘不再被窗口裁剪） ----
const { menu, setMenuRef, open: openCtxMenu, close: closeCtxMenu } = useCtxMenu();
/** 右键目标节点单独保存：菜单项点击（document click 关闭菜单）后仍可取到 */
const ctxNode = ref<WorkspaceNode | null>(null);
const targetDir = computed(() => {
  const n = ctxNode.value;
  if (!n) return ws.root ?? '';
  return n.kind === 'dir' ? n.path : n.path.replace(/[\\/][^\\/]*$/, '');
});

function onContextMenu(e: MouseEvent, node: WorkspaceNode | null) {
  e.preventDefault();
  ctxNode.value = node;
  openCtxMenu(e.clientX, e.clientY);
}
function closeMenu() {
  ctxNode.value = null;
  closeCtxMenu();
  wsMenuOpen.value = false;
}
onMounted(() => document.addEventListener('click', closeMenu));
onBeforeUnmount(() => document.removeEventListener('click', closeMenu));

function menuNewFile() { openCreate('file', targetDir.value); }
function menuNewDir() { openCreate('dir', targetDir.value); }
function menuRename() {
  const n = ctxNode.value;
  if (!n || !n.path || n.path === ws.root) return;
  renameDialog.value = { visible: true, value: n.name, path: n.path };
}
function menuDelete() {
  const n = ctxNode.value;
  if (!n || !n.path || n.path === ws.root) return;
  deleteDialog.value = { visible: true, node: n };
}

// ---- 新建 ----
const createDialog = ref<{ visible: boolean; kind: NodeKind; value: string }>({
  visible: false,
  kind: 'file',
  value: '',
});
/** 新建目标目录：必须在菜单项点击瞬间快照——对话框确认时右键菜单早已被 document click 关闭清空 */
const createTarget = ref('');
function openCreate(kind: NodeKind, dir?: string) {
  createTarget.value = dir || ws.root || '';
  createDialog.value = { visible: true, kind, value: kind === 'file' ? '新建文档.md' : '新建文件夹' };
}
async function doCreate() {
  const { kind, value } = createDialog.value;
  const parent = createTarget.value || ws.root || '';
  if (!parent || !value.trim()) return;
  try {
    const node = await ws.createEntry(parent, value.trim(), kind);
    createDialog.value.visible = false;
    createError.value = '';
    // 新建文件直接打开进编辑模式（新建文件夹只展开定位，无可打开内容）
    if (kind === 'file' && node?.path) emit('open-file-edit', node.path);
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err);
  }
}
const createError = ref('');

// ---- 重命名 ----
const renameDialog = ref<{ visible: boolean; value: string; path: string }>({
  visible: false, value: '', path: '',
});
async function doRename() {
  const { path, value } = renameDialog.value;
  if (!value.trim()) return;
  try {
    await ws.renameEntry(path, value.trim());
    renameDialog.value.visible = false;
    renameError.value = '';
  } catch (err) {
    renameError.value = err instanceof Error ? err.message : String(err);
  }
}
const renameError = ref('');

// ---- 删除 ----
const deleteDialog = ref<{ visible: boolean; node: WorkspaceNode | null }>({ visible: false, node: null });
async function doDelete() {
  const node = deleteDialog.value.node;
  if (!node?.path) return;
  try {
    await ws.deleteEntry(node.path);
    deleteDialog.value.visible = false;
    deleteError.value = '';
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : String(err);
  }
}
const deleteError = ref('');

// ---- 按名称过滤（当前工作区的目录 / 文件名，纯前端过滤已加载的全量树） ----
const filterVisible = ref(false);
const filterText = ref('');
const filterIpt = ref<HTMLInputElement | null>(null);

/** 过滤是否生效（开着且有非空关键词） */
const filterActive = computed(() => filterVisible.value && filterText.value.trim().length > 0);

function toggleFilter(): void {
  filterVisible.value = !filterVisible.value;
  if (filterVisible.value) {
    void nextTick(() => filterIpt.value?.focus());
  } else {
    filterText.value = '';
  }
}

function closeFilter(): void {
  filterVisible.value = false;
  filterText.value = '';
}

/**
 * 递归过滤：文件名命中保留该文件；目录名命中保留整棵子树（明确命中时
 * 用户通常想看的是这个目录本身）；否则目录仅当后代有命中时保留（过滤后的 children）。
 */
function filterNode(node: WorkspaceNode, kw: string): WorkspaceNode | null {
  const selfMatch = node.name.toLowerCase().includes(kw);
  if (node.kind === 'file') return selfMatch ? node : null;
  if (selfMatch) return node;
  const children = (node.children ?? [])
    .map((c) => filterNode(c, kw))
    .filter((c): c is WorkspaceNode => c !== null);
  return children.length > 0 ? { ...node, children } : null;
}

/** null = 未启用过滤，走原树；空数组 = 无匹配 */
const filteredTree = computed<WorkspaceNode[] | null>(() => {
  const kw = filterText.value.trim().toLowerCase();
  if (!filterActive.value || !ws.tree) return null;
  return (ws.tree.children ?? [])
    .map((c) => filterNode(c, kw))
    .filter((c): c is WorkspaceNode => c !== null);
});

// 过滤生效时自动展开结果里的所有目录（展开态在 store，命中目录否则默认折叠看不见）
watch(filteredTree, (nodes) => {
  if (!nodes) return;
  const next = new Set(ws.expanded);
  const walk = (list: WorkspaceNode[]) => {
    for (const n of list) {
      if (n.kind === 'dir') {
        next.add(n.path);
        walk(n.children ?? []);
      }
    }
  };
  walk(nodes);
  ws.expanded = next;
});
</script>

<template>
  <aside class="explorer" :style="{ width: `${width}px` }">
    <!-- 右缘拖拽手柄 -->
    <div
      class="resizer"
      :class="{ active: dragging }"
      @mousedown="onResizeStart"
      data-tip="拖动调整宽度"
    />
    <div class="panel-head">
      <button
      class="root-name"
      :data-tip="ws.root ?? ''"
        @click.stop="wsMenuOpen = !wsMenuOpen"
      >
        <span class="root-name-text">{{ ws.rootName || '资源管理器' }}</span>
        <ChevronDown class="root-caret" :size="12" />
      </button>
      <span class="tools">
        <button class="tool" :class="{ on: filterVisible }" data-tip="按名称过滤（目录 / 文件）" @click="toggleFilter"><Search class="t-icon" /></button>
        <button class="tool" data-tip="折叠全部" @click="ws.collapseAll()"><ChevronsDownUp class="t-icon" /></button>
        <button class="tool" data-tip="刷新" @click="ws.refresh()"><RefreshCw class="t-icon" /></button>
        <button class="tool" data-tip="隐藏工作区" @click="emit('hide')"><PanelLeftClose class="t-icon" /></button>
      </span>
    </div>

    <!-- 工作区切换菜单（点击根目录名弹出） -->
    <div class="ws-menu" v-if="wsMenuOpen" @click.stop>
      <div class="ws-menu-title">切换工作区</div>
      <button
        v-for="d in recentWorkspaces"
        :key="d"
        class="ws-item"
        :class="{ current: d === ws.root }"
        @click="pickWorkspace(d)"
      >
        <span class="ws-item-name">{{ d.split(/[\\/]/).pop() }}</span>
        <button
          v-if="d !== ws.root"
          class="ws-remove"
          data-tip="从列表移除（不删除磁盘文件）"
          @click.stop="removeWorkspace(d)"
        >
          <X :size="14" />
        </button>
        <Check v-else class="ws-check" :size="13" />
      </button>
      <div class="ws-menu-sep" />
      <button class="ws-item" @click="pickOther">
        <FolderOpen class="ws-ico" :size="14" />
        <span class="ws-item-name">打开其他工作区…</span>
      </button>
      <button class="ws-item ws-remove-all" @click="removeAll">
        <Trash2 class="ws-ico" :size="14" />
        <span class="ws-item-name">全部移除（含当前）</span>
      </button>
    </div>

    <!-- 名称过滤框（工具栏搜索图标切换显隐） -->
    <div class="filter-row" v-if="filterVisible">
      <Search class="f-ico" />
      <input
        ref="filterIpt"
        v-model="filterText"
        placeholder="过滤目录 / 文件名…"
        spellcheck="false"
        @keydown.esc.prevent="closeFilter"
      />
      <button class="f-clear" v-if="filterText" title="清空" @click="filterText = ''; filterIpt?.focus()"><X class="f-clear-ico" /></button>
    </div>

    <div class="tree" v-if="ws.tree && ws.tree.children && ws.tree.children.length > 0">
      <!-- 过滤模式 -->
      <template v-if="filterActive">
        <FileTreeNode
          v-for="node in filteredTree ?? []"
          :key="node.path"
          :node="node"
          :depth="0"
          @open-file="(p: string) => emit('open-file', p)"
          @ctx="(ev, n) => onContextMenu(ev, n)"
        />
        <div v-if="!filteredTree || filteredTree.length === 0" class="empty">无匹配的目录或文件</div>
      </template>
      <!-- 原始树 -->
      <template v-else>
        <FileTreeNode
          v-for="node in ws.tree.children"
          :key="node.path"
          :node="node"
          :depth="0"
          @open-file="(p: string) => emit('open-file', p)"
          @ctx="(ev, n) => onContextMenu(ev, n)"
        />
      </template>
    </div>
    <div v-else-if="ws.tree" class="empty">空文件夹<br>右键可新建</div>
    <div v-else class="empty">请打开一个文件夹<br>作为工作区</div>

    <!-- 右键菜单 -->
    <div v-if="menu" :ref="setMenuRef" class="ctx-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button class="ctx-item" @click="menuNewFile">新建文件</button>
      <button class="ctx-item" @click="menuNewDir">新建文件夹</button>
      <div class="ctx-sep" />
      <button class="ctx-item" :disabled="!ctxNode || ctxNode.path === ws.root" @click="menuRename">重命名</button>
      <button class="ctx-item danger" :disabled="!ctxNode || ctxNode.path === ws.root" @click="menuDelete">删除（回收站）</button>
    </div>

    <!-- 新建对话框 -->
    <AppDialog
      :visible="createDialog.visible"
      :title="createDialog.kind === 'file' ? '新建文件' : '新建文件夹'"
      input
      :input-value="createDialog.value"
      placeholder="名称"
      @confirm="createDialog.value = $event; doCreate()"
      @cancel="createDialog.visible = false; createError = ''"
    >
      <p class="target-hint" :title="createTarget">位置：{{ createTarget }}</p>
      <p class="err" v-if="createError">{{ createError }}</p>
    </AppDialog>

    <!-- 重命名对话框 -->
    <AppDialog
      :visible="renameDialog.visible"
      title="重命名"
      input
      :input-value="renameDialog.value"
      placeholder="新名称"
      @confirm="renameDialog.value = $event; doRename()"
      @cancel="renameDialog.visible = false; renameError = ''"
    >
      <p class="err" v-if="renameError">{{ renameError }}</p>
    </AppDialog>

    <!-- 删除确认 -->
    <AppDialog
      :visible="deleteDialog.visible"
      title="删除"
      :danger="true"
      confirm-text="删除"
      :message="`「${deleteDialog.node?.name ?? ''}」将移动到系统回收站，确定删除？`"
      @confirm="doDelete"
      @cancel="deleteDialog.visible = false; deleteError = ''"
    >
      <p class="err" v-if="deleteError">{{ deleteError }}</p>
    </AppDialog>
  </aside>
</template>

<style scoped>
.explorer {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--mk-panel);
  min-width: 200px;
  max-width: 440px;
  flex: none;
}
.resizer {
  position: absolute;
  right: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}
.resizer::after {
  content: '';
  position: absolute;
  right: 2.5px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--mk-border);
  transition: background-color 120ms ease;
}
.resizer:hover::after,
.resizer.active::after {
  background: var(--mk-accent);
  width: 2px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  padding: 0 6px 0 12px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--mk-fg-muted);
  letter-spacing: 0.5px; /* 中文标签：字距收紧避免松散 */
  flex: none;
}
.root-name {
  display: inline-flex; align-items: center; gap: 3px;
  min-width: 0; max-width: calc(100% - 118px);
  padding: 3px 6px; margin-left: -6px;
  border: none; background: transparent;
  font: inherit; color: inherit;
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
}
.root-name:hover { background: var(--mk-hover); color: var(--mk-fg); }
.root-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.root-caret { flex: none; opacity: 0.7; }
.tools { display: inline-flex; gap: 3px; }
.ws-menu {
  position: absolute;
  top: 36px; left: 8px; z-index: 30;
  min-width: 220px; max-width: calc(100% - 16px);
  padding: 5px;
  background: var(--mk-bg);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
}
.ws-menu-title {
  padding: 4px 8px;
  font-size: 10.5px; font-weight: 600; letter-spacing: 1px;
  color: var(--mk-fg-muted);
}
.ws-item {
  display: flex; align-items: center; gap: 7px;
  width: 100%; text-align: left;
  padding: 6px 8px;
  border: none; background: transparent;
  font-size: 12.5px; color: var(--mk-fg);
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
}
.ws-item:hover { background: var(--mk-hover); }
.ws-item.current { color: var(--mk-accent); }
.ws-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-check { flex: none; }
.ws-ico { flex: none; color: var(--mk-fg-muted); }
.ws-menu-sep { height: 1px; margin: 4px 0; background: var(--mk-border); }
.ws-remove {
  display: inline-flex; align-items: center; justify-content: center;
  flex: none; width: 22px; height: 22px;
  border: 1px solid var(--mk-border); background: transparent;
  color: var(--mk-fg-muted);
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
}
.ws-remove:hover { border-color: var(--mk-danger, #A32D2D); color: #fff; background: var(--mk-danger, #A32D2D); }
.ws-remove-all { color: var(--mk-danger, #A32D2D); }
.ws-remove-all .ws-item-name { color: var(--mk-danger, #A32D2D); }
.ws-remove-all:hover { background: var(--mk-hover); }
.tool {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px;
  position: relative; /* data-tip 气泡定位基准 */
  border: none; background: transparent;
  color: var(--mk-fg-muted);
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
}
.tool:hover { background: var(--mk-hover); color: var(--mk-fg); }
/* 过滤开关激活态：淡底色 + 主题色描边，明确"当前开着" */
.tool.on {
  background: var(--mk-accent-weak);
  color: var(--mk-accent);
  box-shadow: inset 0 0 0 1px var(--mk-accent-weak);
}
.tool:focus-visible { outline: 1px solid var(--mk-accent); outline-offset: 1px; }
.t-icon { width: 17px; height: 17px; }

/* ---- 名称过滤框 ---- */
.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin: 0 8px 4px;
  padding: 0 8px;
  height: 28px;
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-sm);
  background: var(--mk-bg);
}
.filter-row:focus-within { border-color: var(--mk-accent); }
.f-ico { width: 14px; height: 14px; color: var(--mk-fg-muted); flex: none; }
.filter-row input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--mk-fg);
  font-size: 12.5px;
  outline: none;
}
.filter-row input::placeholder { color: var(--mk-fg-muted); }
.f-clear {
  display: inline-flex;
  border: none;
  background: transparent;
  color: var(--mk-fg-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  flex: none;
}
.f-clear:hover { color: var(--mk-fg); background: var(--mk-hover); }
.f-clear-ico { width: 12px; height: 12px; }
.tree { overflow-y: auto; overflow-x: hidden; flex: 1; padding: 4px 6px 16px; }
.empty {
  padding: 24px 16px;
  font-size: 12px;
  color: var(--mk-fg-muted);
  line-height: 1.8;
  text-align: center;
}
.ctx-menu {
  position: fixed;
  z-index: 90;
  min-width: 160px;
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
.target-hint {
  font-size: 11.5px;
  color: var(--mk-fg-muted);
  margin: 0 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl; /* 长路径省略头部，保留尾部（真正区分位置的段） */
  text-align: left;
}
.err { color: var(--mk-danger); font-size: 12px; margin: 6px 0 0; }
</style>
