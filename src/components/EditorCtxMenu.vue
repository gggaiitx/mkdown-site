<script setup lang="ts">
/**
 * 编辑区右键菜单（三引擎的编辑 / 分栏 / 阅读态共用这一份，取代此前的顶栏「表格」下拉）。
 * 一级：刷新 / 全屏（已在全屏里则「退出全屏」）/ 专注模式 / 显示行号 / 表格▸（光标在表内）或 插入表格 / 标题▸ / 常用行内与块级格式。
 * 二级飞窗：hover 组行展开，绝对定位贴右侧；右缘或下缘不够时翻转、上移。
 * 主菜单观感与标签栏 / 文件树右键菜单一致：useCtxMenu 视口夹紧 + 点击外部或 Esc 关闭。
 * 富文本（.mh）编辑态只给视图级三项：Markdown 源码语义的表格/标题/格式项对它无意义。
 * 代码引擎同样去掉 Markdown 语义项，换成「搜索 / 复制 / 粘贴代码」三项 + 自动换行；
 * 纯文本（txt/log/csv）沿用这一套动作，但文案改说「文本」。
 * 阅读态与分栏的预览窗格（载荷 read=true，两者都是只读窗格）换成只读那一套：
 * 搜索 / 复制全文 / 预览主题▸ / 版式▸ / 模式对向入口——
 * 表格·标题·格式是 Markdown 源码语义，显示行号只画在 CM 编辑窗格，给了都不生效，故一并隐去。
 * 预览主题只给 md 的预览窗格：.mh 的正文走 wangEditor，previewTheme 对它不生效；
 * 编辑态没有预览 DOM，改了看不到反馈——两处都不给。
 * 预览窗格（engine='frame'，图片 / HTML / SVG 三处共用这一套）再窄一档，只给视图项：
 * 刷新 / 全屏 / 复制图片（只图片）/ 导出为图片（只 SVG），外加「预览工具条」三档飞窗；
 * 「导出为图片」只给 SVG——HTML 落在 opaque origin 沙箱里，父页取不到它的画面。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Component, Ref } from 'vue';
import {
  Table, ArrowUpLeft, ArrowDownRight, ArrowLeft, ArrowRight, Minus,
  WandSparkles, AlignHorizontalSpaceAround, RefreshCw, ChevronRight, Focus, Check, ListEnd, Maximize, Minimize2,
  Search, Copy, ClipboardPaste, MoveHorizontal, Pencil, Columns2, BookOpen, WrapText,
  ImageDown, Move, RotateCcw, Palette,
  Text, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  Bold, Italic, Quote, Code, SquareCode, List, ListOrdered, ListTodo, Link,
} from '@lucide/vue';
import { useI18n } from '../i18n';
import { useCtxMenu } from '../composables/useCtxMenu';
import { altHint, modHint, modShiftHint } from '../utils/keyHint';
import { PREVIEW_THEMES } from '../utils/previewTheme';
import type { EditorCtxPayload } from '../adapters/IMarkdownEngine';
import type { EditorMode, PreviewBarMode, ReadLayout } from '../api/types';
import type { TableOp } from '../utils/mdTable';
import type { FormatId, HeadingId } from '../utils/mdActions';

const props = defineProps<{
  ctx: EditorCtxPayload | null;
  /** 当前标签是否可刷新（已落盘的文件；未保存新建无路径 → 隐藏该项） */
  canReload?: boolean;
  /** 页面全屏当前状态（首项据此显示「全屏」/「退出全屏」，同为 F11 那一套状态） */
  pageFull?: boolean;
  /** 专注模式当前状态（决定菜单项的勾选标记） */
  focusMode?: boolean;
  /** 行号当前状态（同上） */
  showLineNumbers?: boolean;
  /** 自动换行当前状态（代码引擎专用：长行折行 vs 横向滚动，默认关） */
  lineWrap?: boolean;
  /** 当前标签是纯文本（txt/log/csv…）：同走代码引擎，但动作项文案不该说「代码」 */
  plainText?: boolean;
  /** 当前标签是 SVG 源码：给「格式化」项（markup 保守美化，与 Ctrl+Shift+F 同源） */
  svg?: boolean;
  /** 内容版式当前值：阅读态「版式」飞窗给当前项打勾（与设置面板「内容版式」同一字段） */
  readLayout?: ReadLayout;
  /** 预览主题当前值：md 预览窗格「预览主题」飞窗给当前项打勾（与设置面板「预览主题」同一字段） */
  previewTheme?: string;
  /** 预览浮块工具条当前档：预览窗格「预览工具条」飞窗给当前项打勾（三面板共用一份状态） */
  barMode?: PreviewBarMode;
  /** 当前形态：决定「版式」给不给（md 分栏态不挂 layout--* 类），以及模式项该列哪几档 */
  mode?: EditorMode;
}>();
const emit = defineEmits<{
  (e: 'op', op: 'insert' | TableOp): void;
  /** 格式动作（加粗/标题/引用/列表…）：分发逻辑在 Workbench，与快捷键同源 */
  (e: 'format', id: FormatId): void;
  /** 刷新当前标签：脏确认对话框与 reloadTab 全在 TabBar 内，这里只转达意图 */
  (e: 'refresh'): void;
  /** 页面全屏：三引擎三形态的分发在 Workbench.toggleFullscreen */
  (e: 'fullscreen'): void;
  /** 切换视图类开关（专注模式 / 显示行号）：状态存在设置里，由 Workbench 写 settings.update */
  (e: 'toggleFocus'): void;
  (e: 'toggleLineNumbers'): void;
  /** 自动换行：状态同样存设置，由 Workbench 写 settings.update（只影响代码引擎） */
  (e: 'toggleWrap'): void;
  /** SVG 源码格式化：动作在 Workbench.beautifyActive，与 Ctrl+Shift+F 同源 */
  (e: 'formatMarkup'): void;
  /** 预览窗格「导出为图片」：按当前适应窗口的画幅出 PNG（只给 SVG） */
  (e: 'exportPng'): void;
  /** 图片预览「复制图片」：取字节交系统剪贴板（位图形态），动作在 Workbench */
  (e: 'copyImage'): void;
  /** 预览浮块工具条显隐档（自动浮出 / 始终显示 / 隐藏）：状态存设置、三面板共用，由 Workbench 写 */
  (e: 'barMode', v: PreviewBarMode): void;
  /** 预览浮块工具条回到默认落位（贴底居中）：落位同样存设置 */
  (e: 'barReset'): void;
  /** 文件内查找：与 Ctrl+F 同一条链路（代码引擎与阅读态共用，文案按上下文取） */
  (e: 'search'): void;
  /** 阅读态「复制全文」：取文口径在引擎（md = 源码，.mh = 渲染纯文本），剪贴板与提示在 Workbench */
  (e: 'copyAll'): void;
  /** 阅读态切回编辑 / 分栏：模式真相源在 Workbench.setMode */
  (e: 'mode', mode: EditorMode): void;
  /** 内容版式（窄 / 中 / 宽）：写设置，与设置面板同一入口 */
  (e: 'layout', layout: ReadLayout): void;
  /** 预览主题（default / github / …）：写设置，与设置面板同一入口 */
  (e: 'previewTheme', theme: string): void;
  /** 代码引擎两项：复制/粘贴的剪贴板与提示在 Workbench */
  (e: 'copyCode'): void;
  (e: 'pasteCode'): void;
  (e: 'dismiss'): void;
}>();

const { t } = useI18n();
const { menu, setMenuRef, open, close } = useCtxMenu();

/** 富文本引擎上报的右键：编辑态只留「刷新 / 专注模式」两项视图级动作
 *  （行号是 CodeMirror 画在行上的，Slate 没有这个概念；表格/标题/格式是 Markdown 源码语义） */
const mhOnly = computed(() => props.ctx?.engine === 'mh');
/** 代码引擎：视图级三项通用，动作区换成搜索/复制/粘贴（行号是 md 内核那套 class 开关，
 *  CodeMirror 的行号槽由内核自带，给了也不起作用，故一并去掉） */
const codeOnly = computed(() => props.ctx?.engine === 'code');
/** 格式化只给 SVG 源码（它走代码引擎，靠 svg 标记区分；.html 不给，见 Workbench.beautifyActive） */
const svgOnly = computed(() => codeOnly.value && props.svg === true);
/** HTML/SVG 预览窗格：只给视图级四项，源码语义与只读正文那套都不适用 */
const frameOnly = computed(() => props.ctx?.engine === 'frame');
/** 导出为图片只给 SVG：HTML 那份在 opaque origin 沙箱里，父页取不到画面 */
const canExportPng = computed(() => frameOnly.value && props.ctx?.frame === 'svg');
/** 复制图片只给图片面板：位图就是面板里那份原图，读字节后交系统剪贴板
 *  （HTML/SVG 帧画面在沙箱里取不到，SVG 想复制走「导出为图片」那条栅格化） */
const canCopyImage = computed(() => frameOnly.value && props.ctx?.frame === 'image');
/** 纯文本标签（txt/log/csv…）：引擎上报仍是 code，但「搜索/复制/粘贴代码」这套说法对它不成立，
 *  动作项改用「文本」口径（html/svg 等标记语言仍算代码） */
const textDoc = computed(() => codeOnly.value && props.plainText === true);
/** 只读窗格：阅读态的阅读栏，或分栏态的预览栏（引擎都标 read=true）——
 *  内容不是可编辑源码，表格·标题·格式没有作用对象，显示行号也只画在 CM 编辑窗格 */
const isRead = computed(() => props.ctx?.read === true);
/** 版式飞窗：md 分栏态不给——那一档根本不挂 layout--* 类（正文宽度由两栏平分决定），选了没反应 */
const showLayout = computed(() => !codeOnly.value && props.mode !== 'split');
/** 预览主题飞窗：只给 md 的预览窗格（阅读态 / 分栏预览）。
 *  .mh 的正文走 wangEditor，previewTheme 对它不生效；编辑态没有预览 DOM，改了看不到反馈 */
const showPreviewTheme = computed(() => isRead.value && !mhOnly.value && !codeOnly.value && !frameOnly.value);
/** 模式对向入口。规则：只读窗格里给出「离开这一档」的其它档（阅读态→编辑/分栏，分栏预览→编辑/阅读，
 *  .mh 阅读态只有编辑一档）；编辑窗格只在页面全屏里补「阅读」——平时顶栏有模式按钮，
 *  全屏层把顶栏整个盖住才是真缺口（.mh 功能栏在全屏态已有模式按钮，故不给它补） */
const modeItems = computed<EditorMode[]>(() => {
  if (codeOnly.value) return [];
  if (isRead.value) {
    if (mhOnly.value) return ['edit']; // .mh 只有编辑/阅读两档
    return props.mode === 'split' ? ['edit', 'read'] : ['edit', 'split'];
  }
  return props.pageFull === true && !mhOnly.value && props.mode !== 'read' ? ['read'] : [];
});
/** 三档模式的图标与 Alt 快捷键（与顶栏模式按钮、Alt+E/W/R 同源） */
const modeIcon: Record<EditorMode, Component> = { edit: Pencil, split: Columns2, read: BookOpen };
const modeKey: Record<EditorMode, string> = { edit: 'E', split: 'W', read: 'R' };

/** 同时只可能展开一个飞窗，故用独立 ref 而非同名 ref（避免卸载/挂载次序影响测量） */
type GroupId = 'table' | 'heading' | 'layout' | 'bar' | 'theme';
const openGroup = ref<GroupId | null>(null);
const tableSubRef = ref<HTMLElement | null>(null);
const headingSubRef = ref<HTMLElement | null>(null);
const layoutSubRef = ref<HTMLElement | null>(null);
const barSubRef = ref<HTMLElement | null>(null);
const themeSubRef = ref<HTMLElement | null>(null);
/** 三档工具条显隐：与设置 previewBarMode 同源，顺序即菜单顺序 */
const barModes: PreviewBarMode[] = ['auto', 'shown', 'hidden'];
/** 版式四档：与设置面板「内容版式」同源，顺序即菜单顺序 */
const layouts: ReadLayout[] = ['narrow', 'medium', 'wide', 'full'];
/** 四组飞窗的测量目标。openGroup 一次只会展开一个，故按档位取对应 ref（比 ternary 链好加档） */
const subRefs: Record<GroupId, Ref<HTMLElement | null>> = {
  table: tableSubRef,
  heading: headingSubRef,
  layout: layoutSubRef,
  bar: barSubRef,
  theme: themeSubRef,
};
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
  const el = openGroup.value ? subRefs[openGroup.value].value : null;
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
    <!-- 全屏：已在全屏里时改名「退出全屏」（同一动作、同一 F11），不用勾选态——菜单项点完即收，勾了也看不到变化 -->
    <button class="mk-menu-item" @click="emit('fullscreen')">
      <component :is="pageFull ? Minimize2 : Maximize" class="mk-menu-ico" />
      <span>{{ t(pageFull ? 'workbench.ctx.exitFullscreen' : 'workbench.ctx.fullscreen') }}</span>
      <kbd class="mk-menu-key">F11</kbd>
    </button>
    <!-- 预览窗格（HTML / SVG）到这一组为止就是全部：内容既不是源码也不该当正文复制，
         专注模式 / 行号 / 搜索 / 复制 / 版式 / 模式项给了都不生效，下面一律用 frameOnly 隐去 -->
    <button v-if="canCopyImage" class="mk-menu-item" @click="emit('copyImage')">
      <Copy class="mk-menu-ico" /><span>{{ t('workbench.ctx.copyImage') }}</span>
    </button>
    <button v-if="canExportPng" class="mk-menu-item" @click="emit('exportPng')">
      <ImageDown class="mk-menu-ico" /><span>{{ t('workbench.ctx.exportPng') }}</span>
    </button>
    <!-- 预览工具条三档 + 复位：图片 / HTML / SVG 三个面板共用同一份状态（存在设置里）。
         切到「隐藏」后条子连 hover 都不浮出、Tab 也够不到，只能回到这里改档，
         所以图片预览面板也接了这套右键（见 ImagePreview 根节点的 contextmenu） -->
    <template v-if="frameOnly">
      <div class="mk-menu-sep" />
      <div class="ctx-group" @mouseenter="showGroup('bar')" @mouseleave="hideGroup('bar')">
        <button class="mk-menu-item">
          <Move class="mk-menu-ico" /><span>{{ t('workbench.ctx.bar') }}</span>
          <ChevronRight class="ctx-arrow" />
        </button>
        <div v-if="openGroup === 'bar'" ref="barSubRef" class="mk-menu ctx-sub" :style="subStyle">
          <button v-for="v in barModes" :key="v" class="mk-menu-item" @click="emit('barMode', v)">
            <span>{{ t(`workbench.ctx.bar_${v}`) }}</span>
            <Check v-if="barMode === v" class="ctx-check" />
          </button>
          <div class="mk-menu-sep" />
          <button class="mk-menu-item" @click="emit('barReset')">
            <RotateCcw class="mk-menu-ico" /><span>{{ t('workbench.ctx.barReset') }}</span>
          </button>
        </div>
      </div>
    </template>
    <!-- 视图级开关：勾选态即当前状态，点击即切换（状态存设置里，跨文档保持） -->
    <button v-if="!frameOnly" class="mk-menu-item" @click="emit('toggleFocus')">
      <Focus class="mk-menu-ico" /><span>{{ t('workbench.ctx.focusMode') }}</span>
      <Check v-if="focusMode" class="ctx-check" />
    </button>
    <button v-if="!mhOnly && !codeOnly && !isRead && !frameOnly" class="mk-menu-item" @click="emit('toggleLineNumbers')">
      <ListEnd class="mk-menu-ico" /><span>{{ t('workbench.ctx.lineNumbers') }}</span>
      <Check v-if="showLineNumbers" class="ctx-check" />
    </button>
    <!-- 自动换行：只给代码引擎，默认关（点开这一档才折行）。md 编辑窗格的换行由内核恒开，
         摆这一项是假开关，故 md/.mh 都不给 -->
    <button v-if="codeOnly" class="mk-menu-item" @click="emit('toggleWrap')">
      <WrapText class="mk-menu-ico" /><span>{{ t('workbench.ctx.wordWrap') }}</span>
      <Check v-if="lineWrap" class="ctx-check" />
    </button>
    <!-- 格式化：只给 SVG 源码（markup 保守美化，与 Ctrl+Shift+F 同源）。
         其余代码文件不给——缩进规则对 json/css/js 并不适用，还会跟各自既有的格式习惯打架；
         .html 也不给——网页源码几乎全是混合内容，保守规则改不动一个字节，点了只会提示「已是规范格式」 -->
    <button v-if="svgOnly" class="mk-menu-item" @click="emit('formatMarkup')">
      <WandSparkles class="mk-menu-ico" /><span>{{ t('workbench.ctx.formatMarkup') }}</span>
      <kbd class="mk-menu-key">{{ modHint('Shift+F') }}</kbd>
    </button>
    <!-- 动作区：三引擎共用同一条流程，按引擎与形态裁剪，不再各写一套分支。
         搜索与 Ctrl+F 同源；复制全文的口径在引擎（md = 源码、.mh = 渲染纯文本、代码 = 选区优先）；
         粘贴只有代码引擎给（走 CM 单事务，Ctrl+Z 一步整体撤回），md/.mh 的粘贴原生 Ctrl+V 已可用。
         预览窗格整组不给：iframe 里的文字与应用查找面板不是一套模型 -->
    <template v-if="!frameOnly">
    <div class="mk-menu-sep" />
    <button class="mk-menu-item" @click="emit('search')">
      <Search class="mk-menu-ico" /><span>{{ t(textDoc ? 'workbench.ctx.searchText' : codeOnly ? 'workbench.ctx.searchCode' : 'workbench.ctx.search') }}</span>
      <kbd class="mk-menu-key">{{ modHint('F') }}</kbd>
    </button>
    <button v-if="!codeOnly" class="mk-menu-item" @click="emit('copyAll')">
      <Copy class="mk-menu-ico" /><span>{{ t('workbench.ctx.copyAll') }}</span>
    </button>
    <template v-else>
      <button class="mk-menu-item" @click="emit('copyCode')">
        <Copy class="mk-menu-ico" /><span>{{ t(textDoc ? 'workbench.ctx.copyText' : 'workbench.ctx.copyCode') }}</span><kbd class="mk-menu-key">{{ modHint('C') }}</kbd>
      </button>
      <button class="mk-menu-item" @click="emit('pasteCode')">
        <ClipboardPaste class="mk-menu-ico" /><span>{{ t(textDoc ? 'workbench.ctx.pasteText' : 'workbench.ctx.pasteCode') }}</span><kbd class="mk-menu-key">{{ modHint('V') }}</kbd>
      </button>
    </template>
    </template><!-- /!frameOnly（动作区整组） -->
    <!-- 视图组：预览主题（md 预览窗格）+ 版式（与设置面板「内容版式」同字段）+ 模式对向入口。
         阅读态给「编辑」（md 另给「分栏」）；编辑/分栏态只在页面全屏里补「阅读」——
         平时顶栏有模式按钮，全屏时顶栏被全屏层盖住才是真缺口（.mh 功能栏已有模式按钮，故不给） -->
    <template v-if="!codeOnly && !frameOnly">
      <div class="mk-menu-sep" />
      <!-- 预览主题：md 预览窗格专属（阅读态 / 分栏预览）。设置面板同一字段，
           改完即刻换掉 .md-editor-preview 的主题类，正文排版与代码块底色一起变 -->
      <div
        v-if="showPreviewTheme"
        class="ctx-group"
        @mouseenter="showGroup('theme')"
        @mouseleave="hideGroup('theme')"
      >
        <button class="mk-menu-item">
          <Palette class="mk-menu-ico" /><span>{{ t('workbench.ctx.previewTheme') }}</span>
          <ChevronRight class="ctx-arrow" />
        </button>
        <div v-if="openGroup === 'theme'" ref="themeSubRef" class="mk-menu ctx-sub" :style="subStyle">
          <button v-for="v in PREVIEW_THEMES" :key="v.value" class="mk-menu-item" @click="emit('previewTheme', v.value)">
            <span>{{ t(v.label) }}</span>
            <Check v-if="previewTheme === v.value" class="ctx-check" />
          </button>
        </div>
      </div>
      <div v-if="showLayout" class="ctx-group" @mouseenter="showGroup('layout')" @mouseleave="hideGroup('layout')">
        <button class="mk-menu-item">
          <MoveHorizontal class="mk-menu-ico" /><span>{{ t('workbench.ctx.layout') }}</span>
          <ChevronRight class="ctx-arrow" />
        </button>
        <div v-if="openGroup === 'layout'" ref="layoutSubRef" class="mk-menu ctx-sub" :style="subStyle">
          <button v-for="v in layouts" :key="v" class="mk-menu-item" @click="emit('layout', v)">
            <span>{{ t(`workbench.ctx.layout_${v}`) }}</span>
            <Check v-if="readLayout === v" class="ctx-check" />
          </button>
        </div>
      </div>
      <button v-for="m in modeItems" :key="m" class="mk-menu-item" @click="emit('mode', m)">
        <component :is="modeIcon[m]" class="mk-menu-ico" />
        <span>{{ t(`workbench.ctx.to_${m}`) }}</span><kbd class="mk-menu-key">{{ altHint(modeKey[m]) }}</kbd>
      </button>
    </template>
    <!-- Markdown 源码语义的动作：只给 md 的编辑/分栏态（阅读态内容不是源码，.mh 与代码引擎没有这套语义） -->
    <template v-if="!mhOnly && !codeOnly && !isRead && !frameOnly">
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
