<script setup lang="ts">
/**
 * 编辑区右键菜单（Markdown 引擎编辑/分栏态唤起，取代此前的顶栏「表格」下拉）。
 * 一级：刷新 / 表格▸（光标在表内）或 插入表格 / 标题▸ / 常用行内与块级格式。
 * 二级飞窗：hover 组行展开，绝对定位贴右侧；右缘或下缘不够时翻转、上移。
 * 主菜单观感与标签栏 / 文件树右键菜单一致：useCtxMenu 视口夹紧 + 点击外部或 Esc 关闭。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Component } from 'vue';
import {
  Table, ArrowUpLeft, ArrowDownRight, ArrowLeft, ArrowRight, Minus,
  WandSparkles, AlignHorizontalSpaceAround, RefreshCw, ChevronRight, Focus, Check,
  Text, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  Bold, Italic, Quote, Code, SquareCode, List, ListOrdered, ListTodo, Link,
} from '@lucide/vue';
import { useI18n } from '../i18n';
import { useCtxMenu } from '../composables/useCtxMenu';
import { modHint, modShiftHint } from '../utils/keyHint';
import type { EditorCtxPayload } from '../adapters/IMarkdownEngine';
import type { TableOp } from '../utils/mdTable';
import type { FormatId, HeadingId } from '../utils/mdActions';

const props = defineProps<{
  ctx: EditorCtxPayload | null;
  /** 当前标签是否可刷新（已落盘的文件；未保存新建无路径 → 隐藏该项） */
  canReload?: boolean;
  /** 专注模式当前状态（决定菜单项的勾选标记） */
  focusMode?: boolean;
}>();
const emit = defineEmits<{
  (e: 'op', op: 'insert' | TableOp): void;
  /** 格式动作（加粗/标题/引用/列表…）：分发逻辑在 Workbench，与快捷键同源 */
  (e: 'format', id: FormatId): void;
  /** 刷新当前标签：脏确认对话框与 reloadTab 全在 TabBar 内，这里只转达意图 */
  (e: 'refresh'): void;
  /** 切换专注模式：状态存在设置里，由 Workbench 写 settings.update */
  (e: 'toggleFocus'): void;
  (e: 'dismiss'): void;
}>();

const { t } = useI18n();
const { menu, setMenuRef, open, close } = useCtxMenu();

/** 同时只可能展开一个飞窗，故用独立 ref 而非同名 ref（避免卸载/挂载次序影响测量） */
type GroupId = 'table' | 'heading';
const openGroup = ref<GroupId | null>(null);
const tableSubRef = ref<HTMLElement | null>(null);
const headingSubRef = ref<HTMLElement | null>(null);
/** 飞窗定位覆写：默认贴右（left: calc(100% + 2px)），越界时改为贴左并上移 */
const subStyle = ref<Record<string, string>>({});

/** 标题飞窗条目：正文（清除块标记）+ 六级标题，图标各异故走 v-for */
const headingItems: Array<{ id: HeadingId | 'plain'; icon: Component }> = [
  { id: 'plain', icon: Text },
  { id: 'h1', icon: Heading1 },
  { id: 'h2', icon: Heading2 },
  { id: 'h3', icon: Heading3 },
  { id: 'h4', icon: Heading4 },
  { id: 'h5', icon: Heading5 },
  { id: 'h6', icon: Heading6 },
];

function showGroup(id: GroupId): void {
  if (openGroup.value === id) return;
  openGroup.value = id;
  void nextTick(clampSub);
}
function hideGroup(id: GroupId): void {
  if (openGroup.value === id) openGroup.value = null;
}

/** 飞窗先按贴右渲染，再量真实矩形：右缘越界→翻到组行左侧；下缘越界→按超出量上移 */
function clampSub(): void {
  const el = openGroup.value === 'table' ? tableSubRef.value : headingSubRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const style: Record<string, string> = {};
  if (rect.right > window.innerWidth - 6) {
    style.left = 'auto';
    style.right = 'calc(100% + 2px)';
  }
  const overflow = rect.bottom - (window.innerHeight - 6);
  if (overflow > 0) style.top = `${-5 - overflow}px`;
  subStyle.value = style;
}

// ctx 由上层置值即唤起，置 null 即关闭（菜单项点击后同样由上层清空）
watch(
  () => props.ctx,
  (c) => {
    openGroup.value = null;
    subStyle.value = {};
    if (!c) close();
    else open(c.x, c.y);
  },
);

function pick(op: 'insert' | TableOp): void {
  emit('op', op);
}
function run(id: FormatId): void {
  emit('format', id);
}

// 动作项的 click 已先派发操作；组行与飞窗内的点击不算「点击外部」，交给动作自身收合
function onDocClick(event: MouseEvent): void {
  if (!menu.value) return;
  if ((event.target as HTMLElement | null)?.closest('.ctx-group')) return;
  emit('dismiss');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && menu.value) emit('dismiss');
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    v-if="ctx && menu"
    :ref="setMenuRef"
    class="ctx-menu editor-ctx-menu"
    :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
  >
    <button v-if="canReload" class="ctx-item" @click="emit('refresh')">
      <RefreshCw class="ctx-ico" /><span>{{ t('workbench.ctx.reload') }}</span>
    </button>
    <!-- 视图级开关：勾选态即当前状态，点击即切换（状态存设置里，跨文档保持） -->
    <button class="ctx-item" @click="emit('toggleFocus')">
      <Focus class="ctx-ico" /><span>{{ t('workbench.ctx.focusMode') }}</span>
      <Check v-if="focusMode" class="ctx-check" />
    </button>
    <div class="ctx-sep" />

    <!-- 表格：光标在表内收进二级，表外只留「插入表格」一条 -->
    <div
      v-if="ctx?.inTable"
      class="ctx-group"
      @mouseenter="showGroup('table')"
      @mouseleave="hideGroup('table')"
    >
      <button class="ctx-item">
        <Table class="ctx-ico" /><span>{{ t('workbench.ctx.table') }}</span>
        <ChevronRight class="ctx-arrow" />
      </button>
      <div v-if="openGroup === 'table'" ref="tableSubRef" class="ctx-sub" :style="subStyle">
        <button class="ctx-item" @click="pick('insert')">
          <Table class="ctx-ico" /><span>{{ t('workbench.table.insert') }}</span>
        </button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="pick('row-before')">
          <ArrowUpLeft class="ctx-ico" /><span>{{ t('workbench.table.rowBefore') }}</span>
        </button>
        <button class="ctx-item" @click="pick('row-after')">
          <ArrowDownRight class="ctx-ico" /><span>{{ t('workbench.table.rowAfter') }}</span>
        </button>
        <button class="ctx-item ctx-danger" @click="pick('row-delete')">
          <Minus class="ctx-ico" /><span>{{ t('workbench.table.rowDelete') }}</span>
        </button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="pick('col-before')">
          <ArrowLeft class="ctx-ico" /><span>{{ t('workbench.table.colBefore') }}</span>
        </button>
        <button class="ctx-item" @click="pick('col-after')">
          <ArrowRight class="ctx-ico" /><span>{{ t('workbench.table.colAfter') }}</span>
        </button>
        <button class="ctx-item ctx-danger" @click="pick('col-delete')">
          <Minus class="ctx-ico" /><span>{{ t('workbench.table.colDelete') }}</span>
        </button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="pick('normalize')">
          <WandSparkles class="ctx-ico" /><span>{{ t('workbench.table.normalize') }}</span>
        </button>
        <button class="ctx-item" :disabled="!ctx?.wideAlignable" @click="pick('align-wide')">
          <AlignHorizontalSpaceAround class="ctx-ico" /><span>{{ t('workbench.table.alignWide') }}</span>
        </button>
      </div>
    </div>
    <button v-else class="ctx-item" @click="pick('insert')">
      <Table class="ctx-ico" /><span>{{ t('workbench.table.insert') }}</span>
    </button>

    <div class="ctx-group" @mouseenter="showGroup('heading')" @mouseleave="hideGroup('heading')">
      <button class="ctx-item">
        <Heading1 class="ctx-ico" /><span>{{ t('workbench.ctx.heading') }}</span>
        <ChevronRight class="ctx-arrow" />
      </button>
      <div v-if="openGroup === 'heading'" ref="headingSubRef" class="ctx-sub" :style="subStyle">
        <button
          v-for="item in headingItems"
          :key="item.id"
          class="ctx-item"
          @click="run(item.id)"
        >
          <component :is="item.icon" class="ctx-ico" />
          <span>{{ t(`workbench.ctx.${item.id}`) }}</span>
          <kbd v-if="item.id !== 'plain'" class="ctx-key">{{ modHint(item.id.slice(1)) }}</kbd>
        </button>
      </div>
    </div>
    <div class="ctx-sep" />

    <button class="ctx-item" @click="run('bold')">
      <Bold class="ctx-ico" /><span>{{ t('workbench.ctx.bold') }}</span><kbd class="ctx-key">{{ modHint('B') }}</kbd>
    </button>
    <button class="ctx-item" @click="run('italic')">
      <Italic class="ctx-ico" /><span>{{ t('workbench.ctx.italic') }}</span><kbd class="ctx-key">{{ modHint('I') }}</kbd>
    </button>
    <button class="ctx-item" @click="run('quote')">
      <Quote class="ctx-ico" /><span>{{ t('workbench.ctx.quote') }}</span>
    </button>
    <button class="ctx-item" @click="run('codeBlock')">
      <SquareCode class="ctx-ico" /><span>{{ t('workbench.ctx.codeBlock') }}</span><kbd class="ctx-key">{{ modShiftHint('C') }}</kbd>
    </button>
    <button class="ctx-item" @click="run('codeRow')">
      <Code class="ctx-ico" /><span>{{ t('workbench.ctx.codeRow') }}</span>
    </button>
    <div class="ctx-sep" />

    <button class="ctx-item" @click="run('ul')">
      <List class="ctx-ico" /><span>{{ t('workbench.ctx.ul') }}</span>
    </button>
    <button class="ctx-item" @click="run('ol')">
      <ListOrdered class="ctx-ico" /><span>{{ t('workbench.ctx.ol') }}</span>
    </button>
    <button class="ctx-item" @click="run('task')">
      <ListTodo class="ctx-ico" /><span>{{ t('workbench.ctx.task') }}</span>
    </button>
    <div class="ctx-sep" />

    <button class="ctx-item" @click="run('link')">
      <Link class="ctx-ico" /><span>{{ t('workbench.ctx.link') }}</span><kbd class="ctx-key">{{ modHint('K') }}</kbd>
    </button>
  </div>
</template>

<style scoped>
/* ---- 右键菜单（与 TabBar / FileTree 同款观感） ---- */
.ctx-menu {
  position: fixed;
  /* 层级带 10100+：编辑器「页面全屏」层（内核 .md-editor-fullscreen）是 z-index 10000 的
     fixed 铺满层，会整片盖住应用浮层——菜单曾以 90 弹在全屏编辑器底下，表现为全屏后右键失效。
     搜索面板 10100 < 菜单 10110 < 轻提示 10120，仍低于对话框 30010 与气泡 99999 */
  z-index: 10110;
  min-width: 150px;
  /* max-content：fixed 未设宽时 shrink-to-fit 会被「视口宽-left」压缩，
     useCtxMenu 夹紧用的正是这个测量值，锁定内容宽后测量即真实宽。
     飞窗是绝对定位子节点，不参与本元素的最大内容宽度计算 */
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
  white-space: nowrap;
}
.ctx-ico {
  width: 13px;
  height: 13px;
  flex: none;
  opacity: 0.75;
}
.ctx-item:hover:not(:disabled) { background: var(--mk-hover); }
.ctx-item.ctx-danger { color: var(--mk-danger); }
.ctx-item:disabled { opacity: 0.4; cursor: default; }
.ctx-sep { height: 1px; background: var(--mk-border); margin: 4px 6px; }
.ctx-key {
  margin-left: auto;
  padding-left: 14px;
  font-family: inherit;
  font-size: 11px;
  color: var(--mk-fg-muted);
  pointer-events: none;
  white-space: nowrap;
}
.ctx-arrow {
  width: 12px;
  height: 12px;
  margin-left: auto;
  flex: none;
  opacity: 0.55;
}
/* 勾选标记：与 .ctx-key / .ctx-arrow 同样靠右对齐 */
.ctx-check {
  width: 13px;
  height: 13px;
  margin-left: auto;
  flex: none;
  opacity: 0.85;
}

/* ---- 二级飞窗：贴组行右侧展开，越界由 clampSub 改成贴左并上移 ---- */
.ctx-group { position: relative; }
.ctx-sub {
  position: absolute;
  left: calc(100% + 2px);
  top: -5px;
  z-index: 91;
  background: var(--mk-panel);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
  padding: 4px;
  display: flex;
  flex-direction: column;
}
</style>
