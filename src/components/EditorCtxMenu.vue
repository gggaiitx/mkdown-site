<script setup lang="ts">
/**
 * 编辑区右键菜单（Markdown 引擎与富文本引擎编辑/分栏态唤起，取代此前的顶栏「表格」下拉）。
 * 一级：刷新 / 全屏 / 专注模式 / 行号 / 表格▸（光标在表内）或 插入表格 / 标题▸ / 常用行内与块级格式。
 * 二级飞窗：hover 组行展开，绝对定位贴右侧；右缘或下缘不够时翻转、上移。
 * 主菜单观感与标签栏 / 文件树右键菜单一致：useCtxMenu 视口夹紧 + 点击外部或 Esc 关闭。
 * 富文本（.mh）只给视图级两项：Markdown 源码语义的表格/标题/格式项对它无意义。
 * 代码引擎同样去掉 Markdown 语义项，换成「搜索 / 复制 / 粘贴代码」三项。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Component } from 'vue';
import {
  Table, ArrowUpLeft, ArrowDownRight, ArrowLeft, ArrowRight, Minus,
  WandSparkles, AlignHorizontalSpaceAround, RefreshCw, ChevronRight, Focus, Check, ListEnd, Maximize,
  Search, Copy, ClipboardPaste,
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
  /** 行号当前状态（同上） */
  showLineNumbers?: boolean;
}>();
const emit = defineEmits<{
  (e: 'op', op: 'insert' | TableOp): void;
  /** 格式动作（加粗/标题/引用/列表…）：分发逻辑在 Workbench，与快捷键同源 */
  (e: 'format', id: FormatId): void;
  /** 刷新当前标签：脏确认对话框与 reloadTab 全在 TabBar 内，这里只转达意图 */
  (e: 'refresh'): void;
  /** 页面全屏：三引擎三形态的分发在 Workbench.toggleFullscreen */
  (e: 'fullscreen'): void;
  /** 切换视图类开关（专注模式 / 行号）：状态存在设置里，由 Workbench 写 settings.update */
  (e: 'toggleFocus'): void;
  (e: 'toggleLineNumbers'): void;
  /** 代码引擎三项：搜索走 Ctrl+F 同一条链路，复制/粘贴的剪贴板与提示在 Workbench */
  (e: 'searchCode'): void;
  (e: 'copyCode'): void;
  (e: 'pasteCode'): void;
  (e: 'dismiss'): void;
}>();

const { t } = useI18n();
const { menu, setMenuRef, open, close } = useCtxMenu();

/** 富文本引擎上报的右键：只留「刷新 / 专注模式」两项视图级动作
 *  （行号是 CodeMirror 画在行上的，Slate 没有这个概念；表格/标题/格式是 Markdown 源码语义） */
const mhOnly = computed(() => props.ctx?.engine === 'mh');
/** 代码引擎：视图级三项通用，动作区换成搜索/复制/粘贴（行号是 md 内核那套 class 开关，
 *  CodeMirror 的行号槽由内核自带，给了也不起作用，故一并去掉） */
const codeOnly = computed(() => props.ctx?.engine === 'code');

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
    class="mk-menu editor-ctx-menu"
    :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
  >
    <button v-if="canReload" class="mk-menu-item" @click="emit('refresh')">
      <RefreshCw class="mk-menu-ico" /><span>{{ t('workbench.ctx.reload') }}</span>
    </button>
    <button class="mk-menu-item" @click="emit('fullscreen')">
      <Maximize class="mk-menu-ico" /><span>{{ t('workbench.ctx.fullscreen') }}</span><kbd class="mk-menu-key">F11</kbd>
    </button>
    <!-- 视图级开关：勾选态即当前状态，点击即切换（状态存设置里，跨文档保持） -->
    <button class="mk-menu-item" @click="emit('toggleFocus')">
      <Focus class="mk-menu-ico" /><span>{{ t('workbench.ctx.focusMode') }}</span>
      <Check v-if="focusMode" class="ctx-check" />
    </button>
    <button v-if="!mhOnly && !codeOnly" class="mk-menu-item" @click="emit('toggleLineNumbers')">
      <ListEnd class="mk-menu-ico" /><span>{{ t('workbench.ctx.lineNumbers') }}</span>
      <Check v-if="showLineNumbers" class="ctx-check" />
    </button>
    <!-- 代码引擎的动作区：查找与 Ctrl+F 同源，粘贴走 CM 事务（Ctrl+Z 可整体撤回） -->
    <template v-if="codeOnly">
      <div class="mk-menu-sep" />
      <button class="mk-menu-item" @click="emit('searchCode')">
        <Search class="mk-menu-ico" /><span>{{ t('workbench.ctx.searchCode') }}</span><kbd class="mk-menu-key">{{ modHint('F') }}</kbd>
      </button>
      <button class="mk-menu-item" @click="emit('copyCode')">
        <Copy class="mk-menu-ico" /><span>{{ t('workbench.ctx.copyCode') }}</span><kbd class="mk-menu-key">{{ modHint('C') }}</kbd>
      </button>
      <button class="mk-menu-item" @click="emit('pasteCode')">
        <ClipboardPaste class="mk-menu-ico" /><span>{{ t('workbench.ctx.pasteCode') }}</span><kbd class="mk-menu-key">{{ modHint('V') }}</kbd>
      </button>
    </template>
    <!-- 富文本只到上面两项为止：以下全是 Markdown 源码语义的动作 -->
    <template v-if="!mhOnly && !codeOnly">
    <div class="mk-menu-sep" />

    <!-- 表格：光标在表内收进二级，表外只留「插入表格」一条 -->
    <div
      v-if="ctx?.inTable"
      class="ctx-group"
      @mouseenter="showGroup('table')"
      @mouseleave="hideGroup('table')"
    >
      <button class="mk-menu-item">
        <Table class="mk-menu-ico" /><span>{{ t('workbench.ctx.table') }}</span>
        <ChevronRight class="ctx-arrow" />
      </button>
      <div v-if="openGroup === 'table'" ref="tableSubRef" class="mk-menu ctx-sub" :style="subStyle">
        <button class="mk-menu-item" @click="pick('insert')">
          <Table class="mk-menu-ico" /><span>{{ t('workbench.table.insert') }}</span>
        </button>
        <div class="mk-menu-sep" />
        <button class="mk-menu-item" @click="pick('row-before')">
          <ArrowUpLeft class="mk-menu-ico" /><span>{{ t('workbench.table.rowBefore') }}</span>
        </button>
        <button class="mk-menu-item" @click="pick('row-after')">
          <ArrowDownRight class="mk-menu-ico" /><span>{{ t('workbench.table.rowAfter') }}</span>
        </button>
        <button class="mk-menu-item danger" @click="pick('row-delete')">
          <Minus class="mk-menu-ico" /><span>{{ t('workbench.table.rowDelete') }}</span>
        </button>
        <div class="mk-menu-sep" />
        <button class="mk-menu-item" @click="pick('col-before')">
          <ArrowLeft class="mk-menu-ico" /><span>{{ t('workbench.table.colBefore') }}</span>
        </button>
        <button class="mk-menu-item" @click="pick('col-after')">
          <ArrowRight class="mk-menu-ico" /><span>{{ t('workbench.table.colAfter') }}</span>
        </button>
        <button class="mk-menu-item danger" @click="pick('col-delete')">
          <Minus class="mk-menu-ico" /><span>{{ t('workbench.table.colDelete') }}</span>
        </button>
        <div class="mk-menu-sep" />
        <button class="mk-menu-item" @click="pick('normalize')">
          <WandSparkles class="mk-menu-ico" /><span>{{ t('workbench.table.normalize') }}</span>
        </button>
        <button class="mk-menu-item" :disabled="!ctx?.wideAlignable" @click="pick('align-wide')">
          <AlignHorizontalSpaceAround class="mk-menu-ico" /><span>{{ t('workbench.table.alignWide') }}</span>
        </button>
      </div>
    </div>
    <button v-else class="mk-menu-item" @click="pick('insert')">
      <Table class="mk-menu-ico" /><span>{{ t('workbench.table.insert') }}</span>
    </button>

    <div class="ctx-group" @mouseenter="showGroup('heading')" @mouseleave="hideGroup('heading')">
      <button class="mk-menu-item">
        <Heading1 class="mk-menu-ico" /><span>{{ t('workbench.ctx.heading') }}</span>
        <ChevronRight class="ctx-arrow" />
      </button>
      <div v-if="openGroup === 'heading'" ref="headingSubRef" class="mk-menu ctx-sub" :style="subStyle">
        <button
          v-for="item in headingItems"
          :key="item.id"
          class="mk-menu-item"
          @click="run(item.id)"
        >
          <component :is="item.icon" class="mk-menu-ico" />
          <span>{{ t(`workbench.ctx.${item.id}`) }}</span>
          <kbd v-if="item.id !== 'plain'" class="mk-menu-key">{{ modHint(item.id.slice(1)) }}</kbd>
        </button>
      </div>
    </div>
    <div class="mk-menu-sep" />

    <button class="mk-menu-item" @click="run('bold')">
      <Bold class="mk-menu-ico" /><span>{{ t('workbench.ctx.bold') }}</span><kbd class="mk-menu-key">{{ modHint('B') }}</kbd>
    </button>
    <button class="mk-menu-item" @click="run('italic')">
      <Italic class="mk-menu-ico" /><span>{{ t('workbench.ctx.italic') }}</span><kbd class="mk-menu-key">{{ modHint('I') }}</kbd>
    </button>
    <button class="mk-menu-item" @click="run('quote')">
      <Quote class="mk-menu-ico" /><span>{{ t('workbench.ctx.quote') }}</span>
    </button>
    <button class="mk-menu-item" @click="run('codeBlock')">
      <SquareCode class="mk-menu-ico" /><span>{{ t('workbench.ctx.codeBlock') }}</span><kbd class="mk-menu-key">{{ modShiftHint('C') }}</kbd>
    </button>
    <button class="mk-menu-item" @click="run('codeRow')">
      <Code class="mk-menu-ico" /><span>{{ t('workbench.ctx.codeRow') }}</span>
    </button>
    <div class="mk-menu-sep" />

    <button class="mk-menu-item" @click="run('ul')">
      <List class="mk-menu-ico" /><span>{{ t('workbench.ctx.ul') }}</span>
    </button>
    <button class="mk-menu-item" @click="run('ol')">
      <ListOrdered class="mk-menu-ico" /><span>{{ t('workbench.ctx.ol') }}</span>
    </button>
    <button class="mk-menu-item" @click="run('task')">
      <ListTodo class="mk-menu-ico" /><span>{{ t('workbench.ctx.task') }}</span>
    </button>
    <div class="mk-menu-sep" />

    <button class="mk-menu-item" @click="run('link')">
      <Link class="mk-menu-ico" /><span>{{ t('workbench.ctx.link') }}</span><kbd class="mk-menu-key">{{ modHint('K') }}</kbd>
    </button>
    </template>
  </div>
</template>

<style scoped>
/* 菜单与条目外观统一走 global.css 的 .mk-menu / .mk-menu-item（全应用唯一规格），
   这里只留本组件独有的：右侧箭头/勾选、二级飞窗的定位 */
.ctx-arrow {
  width: 12px;
  height: 12px;
  margin-left: auto;
  flex: none;
  opacity: 0.55;
}
/* 勾选标记：与 .mk-menu-key / .ctx-arrow 同样靠右对齐 */
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
  /* .mk-menu 给的是 fixed（右键菜单按视口坐标定位），飞窗按父组行绝对定位 */
  position: absolute;
  left: calc(100% + 2px);
  top: -5px;
}
</style>
