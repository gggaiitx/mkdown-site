<script setup lang="ts">
/**
 * 预览区共用工具条：图片 / HTML / SVG 三处同一份定稿（原先各写一套、观感漂移）。
 * − 读数 + 实际尺寸 [适应窗口] + 尾部 slot（OpenSystemBtn inline）+ 全屏。
 * 收成一颗浮块，默认贴在面板底缘正中，默认收起让内容占满整块，鼠标进面板或 Tab 到条上
 * 才露出（收放与落位规则在 global.css 的 .mk-zoom-pane 契约里，宿主根节点挂这个类）。
 * 不浮在顶缘是因为网页自带 sticky 顶栏，顶部一条盖上去正好把它的导航整排吃掉。
 * 两颗可调：① 整块可拖到面板内任意位置，落位与显隐档都存在设置里、三个面板共用一份
 * （不是每个面板各记一份），双击条身空白处回默认；② 显隐三档 auto / shown / hidden
 * 走预览窗格右键（图片面板也接了那套菜单，否则 hidden 之后在图片标签里调不回来）。
 * 开着适应窗口时读数显示「适应窗口」，任何手动缩放都先退出该模式。
 * 全屏读 editorStore.pageFull——它必须和 F11、右键菜单是同一份状态；
 * 图标随状态换向（Maximize2 ⇄ Minimize2），和 Windows 标题栏那个按钮同惯例。
 * 图标刻意用 Maximize2 / Minimize2（对角双箭头）：Maximize 与「实际尺寸」的 Scan
 * 在 14px 下都是四角括号，两个紧挨着的按钮长得一样，认不出来。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Maximize2, Minimize2, Minus, Plus, Scan, ZoomIn } from '@lucide/vue';

import { useEditorStore } from '../../stores/editorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useI18n } from '../../i18n';
import { DEFAULT_SETTINGS } from '../../api/types';
import { stepZoom } from './zoomRange';

const { t } = useI18n();
const editor = useEditorStore();
const settings = useSettingsStore();

/* 上下限不在这里传：三个面板共用 zoomRange 的同一口径（100% = 设计尺寸 1:1） */
const props = withDefaults(
  defineProps<{
    zoom: number;
    /** 适应窗口态（仅 showFit 时有意义） */
    fit?: boolean;
    /** 文档类预览（HTML）没有"整页塞进一屏"这种适应，不显示该按钮 */
    showFit?: boolean;
  }>(),
  { fit: false, showFit: false },
);
const emit = defineEmits<{
  (e: 'update:zoom', v: number): void;
  (e: 'update:fit', v: boolean): void;
}>();

/* 档位按 ×1.25 走（见 zoomRange.ts）：5%~4000% 的区间里固定步长要按几百次才到头 */
function zoomIn() {
  if (props.showFit && props.fit) emit('update:fit', false);
  emit('update:zoom', stepZoom(props.zoom, 1));
}
function zoomOut() {
  if (props.showFit && props.fit) emit('update:fit', false);
  emit('update:zoom', stepZoom(props.zoom, -1));
}
function actualSize() {
  if (props.showFit) emit('update:fit', false);
  emit('update:zoom', 100);
}

/* ---------- 落位与拖动：三个面板共用这一份，位置也只存一份（跨重启保持） ---------- */

const barRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
/** 当前落在面板里的视图落位（按面板尺寸夹过一遍），存储值不动——分栏把预览拖窄再拖回来，
 *  浮块会自己回到原位，而不是把被挤歪的落位存进设置。
 *  ★ 这两个数刻意做成普通变量 + 直接写元素属性，不走响应式：拖动时每个 pointermove 都要改，
 *    走 ref 就意味着一帧一次整条重渲染（六个图标组件 + slot 全过一遍 patch），
 *    在 WebView2 里就是"不跟手"。模板不再绑 style，Vue 也就永远不会把我的写入盖回去。 */
let viewX = DEFAULT_SETTINGS.previewBarX;
let viewBottom = DEFAULT_SETTINGS.previewBarBottom;

function applyVars(): void {
  const bar = barRef.value;
  if (!bar) return;
  bar.style.setProperty('--mk-bar-x', String(viewX));
  bar.style.setProperty('--mk-bar-bottom', `${Math.round(viewBottom)}px`);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 横向：条身中心占面板宽的比例，两端各留 4px 让浮块整个在面板里；夹不住（面板比条还窄）
 *  就退回居中，左右各裁一点。纵向：条身下缘离面板底缘的 px。
 *  ★ 被量的两个矩形都不会被 flex 拉满：条身是绝对定位 + min-width:max-content（自然宽），
 *    面板尺寸由外层决定、绝对定位的子项不回推宿主，所以这条「量尺寸→写样式」没有自激
 *    （分栏下限那次踩过，见 global.css 的 .mk-zoom-pane 注释与 Workbench 的 PREVIEW_MIN_PX）。 */
function remeasure(): void {
  const bar = barRef.value;
  const host = bar?.parentElement;
  if (!bar || !host) return;
  const pw = host.clientWidth;
  const ph = host.clientHeight;
  const bw = bar.offsetWidth;
  const bh = bar.offsetHeight;
  if (!pw || !ph || !bw) return; // hidden 档 display:none、或面板还没布局：留着上一次的视图值
  const lo = bw / 2 + 4;
  const hi = pw - bw / 2 - 4;
  viewX = hi < lo ? 0.5 : clamp(settings.settings.previewBarX * pw, lo, hi) / pw;
  viewBottom = clamp(settings.settings.previewBarBottom, 4, Math.max(4, ph - bh - 4));
  applyVars();
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  remeasure();
  const host = barRef.value?.parentElement;
  if (host) {
    ro = new ResizeObserver(remeasure);
    ro.observe(host);
  }
});
onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
});

watch(
  () =>
    [
      settings.settings.previewBarX,
      settings.settings.previewBarBottom,
      settings.settings.previewBarMode,
    ] as const,
  remeasure,
);

interface BarDrag {
  startX: number;
  startY: number;
  /** 起拖时的视图落位 */
  x: number;
  bottom: number;
  pw: number;
  ph: number;
  bw: number;
  bh: number;
  /** 本帧最新位移：一帧内来多条 pointermove 也只写最后一次 */
  lastDx: number;
  lastDy: number;
  moved: boolean;
}
/** ★ 刻意不在 pointerdown 里 setPointerCapture：那会把落在条子里的按钮（含 slot 里的
 *  「系统打开」）的 click 一起吞掉——官网更新时间线那条坑同一型。改成「移动过 4px 才算拖」，
 *  期间监听 window，拖完补上来的那一记 click 由捕获阶段拦掉。 */
let drag: BarDrag | null = null;
let swallowClick = false;
/** 拖动写入合帧：pointermove 在一帧里可能来好几条，逐条写元素属性等于把样式失效×N，
 *  只保留最新位移、rAF 里写一次才是"跟手" */
let rafId = 0;

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  swallowClick = false;
  const bar = barRef.value;
  const host = bar?.parentElement;
  if (!bar || !host) return;
  drag = {
    startX: e.clientX,
    startY: e.clientY,
    x: viewX,
    bottom: viewBottom,
    pw: host.clientWidth,
    ph: host.clientHeight,
    bw: bar.offsetWidth,
    bh: bar.offsetHeight,
    lastDx: 0,
    lastDy: 0,
    moved: false,
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function onPointerMove(e: PointerEvent): void {
  const d = drag;
  if (!d || !d.pw || !d.bw) return;
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
  if (!d.moved) {
    d.moved = true;
    dragging.value = true; // 这一次重渲染（换 cursor）之后，每帧不再碰响应式
    /* ★ 过阈值才接管指针，而且必须接管：只在 window 上监听不够——指针一快就冲出浮块、
       落到预览的 iframe 上，之后 pointermove 全进 iframe 的文档，父页一条都收不到，
       浮块就"卡在原地不动"（慢拖追得上指针，所以只表现为快速拖动掉帧，2026-10-21 他报的就是这个）。
       Ctrl+F 面板同款做法（SearchHub 在 pointerdown 里就 capture），但它头部没有可点按钮；
       这里整块都能按下，按下就 capture 会把 −／＋／实际尺寸／系统打开 的 click 一起吃掉，
       所以只能等阈值过了再接管。再加一道 body 类把帧内 pointer-events 关掉，见 global.css */
    try {
      barRef.value?.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件 / 该 pointerId 不是活动指针：capture 拿不到也照样拖，还有 body 类兜底 */
    }
    document.body.classList.add('mk-bar-dragging');
  }
  e.preventDefault(); // 拖的时候别把条身上的读数选成文本
  d.lastDx = dx;
  d.lastDy = dy;
  if (!rafId) rafId = requestAnimationFrame(applyDragFrame);
}

function applyDragFrame(): void {
  rafId = 0;
  const d = drag;
  if (!d) return;
  const lo = d.bw / 2 + 4;
  const hi = d.pw - d.bw / 2 - 4;
  viewX = hi < lo ? 0.5 : clamp(d.x * d.pw + d.lastDx, lo, hi) / d.pw;
  viewBottom = clamp(d.bottom - d.lastDy, 4, Math.max(4, d.ph - d.bh - 4));
  applyVars();
}

function onPointerUp(): void {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
  document.body.classList.remove('mk-bar-dragging'); // 松手就把帧内的命中还回去
  if (rafId) {
    cancelAnimationFrame(rafId);
    applyDragFrame(); // 最后一帧的位移别丢，否则松手位置比指针差一截
  }
  const d = drag;
  drag = null;
  dragging.value = false;
  if (!d?.moved) return;
  swallowClick = true;
  void settings.update({
    previewBarX: Math.round(viewX * 1e4) / 1e4,
    previewBarBottom: Math.round(viewBottom),
  });
}

function onClickCapture(e: MouseEvent): void {
  if (!swallowClick) return;
  swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}

/** 双击条身空白处 = 回默认落位（按在按钮上那一记是按钮自己的双击，不算） */
function onDblClick(e: MouseEvent): void {
  if ((e.target as HTMLElement | null)?.closest('button')) return;
  void settings.update({
    previewBarX: DEFAULT_SETTINGS.previewBarX,
    previewBarBottom: DEFAULT_SETTINGS.previewBarBottom,
  });
}
</script>

<template>
  <div
    ref="barRef"
    class="zoom-bar"
    :class="[settings.settings.previewBarMode, { dragging }]"
    :title="t('preview.barDragHint')"
    @pointerdown="onPointerDown"
    @dblclick="onDblClick"
    @click.capture="onClickCapture"
  >
    <button class="tb" :title="t('preview.zoomOut')" @click="zoomOut"><Minus :size="14" /></button>
    <span class="tb-val">{{ showFit && fit ? t('preview.fitWindow') : `${zoom}%` }}</span>
    <button class="tb" :title="t('preview.zoomIn')" @click="zoomIn"><Plus :size="14" /></button>
    <button class="tb" :title="t('preview.actualSize')" @click="actualSize"><Scan :size="14" /></button>
    <button
      v-if="showFit"
      class="tb"
      :class="{ on: fit }"
      :title="t('preview.fitWindow')"
      @click="emit('update:fit', !fit)"
    >
      <ZoomIn :size="14" />
    </button>
    <slot />
    <button
      class="tb"
      :class="{ on: editor.pageFull }"
      :title="editor.pageFull ? t('engine.exitPageFullscreen') : t('engine.pageFullscreen')"
      @click="editor.pageFull = !editor.pageFull"
    >
      <component :is="editor.pageFull ? Minimize2 : Maximize2" :size="14" />
    </button>
  </div>
</template>

<style scoped>
/* 定位与「hover / focus-within 才浮出」的收放在 global.css 的 .mk-zoom-pane 契约里
   （贴底居中浮出），这里只管那颗浮块自己的外观 */
.zoom-bar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--mk-panel);
  border: 1px solid var(--mk-border);
  border-radius: 10px;
  box-shadow: 0 2px 10px rgb(0 0 0 / 14%);
  /* 分栏把预览区拖窄时，浮块不再收缩、保持自身宽度（超出部分由宿主 overflow:hidden
     裁掉）。不钉住的话 flex 会把按钮挤到 min-content，「系统打开」的中文逐字竖排成
     一列，整块变形 */
  min-width: max-content;
  /* 整块都可拖（按下后移动过 4px 才算拖，见 script 段）；读数在拖的时候不许变选区 */
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}
.zoom-bar.dragging {
  cursor: grabbing;
}
.tb {
  flex: none;
  white-space: nowrap;
  appearance: none;
  border: 1px solid var(--mk-border);
  background: var(--mk-panel);
  color: var(--mk-fg);
  border-radius: 6px;
  padding: 4px 5px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.tb.on,
.tb:hover {
  border-color: var(--mk-accent);
  color: var(--mk-accent);
}
.tb-val {
  flex: none;
  white-space: nowrap;
  min-width: 54px;
  text-align: center;
  font-size: 12px;
  color: var(--mk-fg-soft);
}
</style>
