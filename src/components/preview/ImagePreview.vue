<script setup lang="ts">
/**
 * 图片预览：WebView2 原生可解码格式（png/jpg/gif/bmp/webp/svg/ico），
 * 经 asset:// 加载（img-src CSP 已放行）。默认适应窗口＝居中铺满，滚轮缩放，
 * 缩放后（无论图比画布大还是小）都可拖拽平移、不出现滚动条，双击整块区域＝页面全屏 / 还原（当图片查看器用的手势）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { convertFileSrc } from '@tauri-apps/api/core';

import OpenSystemBtn from './OpenSystemBtn.vue';
import PreviewZoomBar from './PreviewZoomBar.vue';
import { clampZoom, stepZoom } from './zoomRange';
import type { EditorCtxPayload } from '../../adapters/IMarkdownEngine';
import { useEditorStore } from '../../stores/editorStore';
import { useI18n } from '../../i18n';

const props = defineProps<{ path: string }>();
/** 面板内右键 → 上层弹应用菜单（刷新 / 全屏 / 预览工具条三档）。
 *  工具条是三个预览面板共用的，档位又只能从这条菜单改——图片面板不给右键的话，
 *  一旦把工具条设成「隐藏」，在图片标签里就再也调不出来了。
 *  ←/→ 同目录轮换由 Workbench 统一接管（所有预览类共用一份守卫与缓存）。 */
const emit = defineEmits<{
  (e: 'editorContext', pos: EditorCtxPayload): void;
}>();

const { t } = useI18n();
const editor = useEditorStore();

const zoom = ref(100);
/** 适应窗口（默认）：整块面板铺满；关掉后按「自然尺寸 × zoom%」出宽，100% = 1:1 */
const fitMode = ref(true);
const loaded = ref(false);
const failed = ref(false);

const src = computed(() => convertFileSrc(props.path));

/** 非适应态的拖拽位移（px），以「居中」为零点。
 *  放大超过画布：两轴各能挪到图边贴画布边，四周全看得到，且不出滚动条；
 *  缩小到比画布小：同一套夹法给出「左边贴齐 ↔ 右边贴齐」的行程，位置也能拖。
 *  —— 两档共用一条夹取口径，见 panBounds()。 */
const panX = ref(0);
const panY = ref(0);

function resetImage() {
  loaded.value = false;
  failed.value = false;
  nat.value = null;
  fitMode.value = true;
  zoom.value = 100;
  panX.value = 0;
  panY.value = 0;
}

watch(() => props.path, resetImage);

// ---------- 拖拽平移：transform 位移，不走滚动 ----------
// 以前搬的是 stage.scrollLeft/scrollTop：放大时会冒出滚动条，缩小到没有滚动余量就完全拖不动。
// 现在 stage 一律 overflow:hidden，位移直接写 transform，两种尺寸共用同一条拖拽路径。
const stageRef = ref<HTMLElement | null>(null);
const imgRef = ref<HTMLImageElement | null>(null);
const panning = ref(false);

interface PanBounds {
  maxX: number;
  maxY: number;
}
const clampNum = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** 位移上限：图片盒与画布内容区（扣掉 padding）差值的绝对值的一半。
 *  居中为零点，所以两个方向都是这个数——大图正好看到两侧边缘，小图正好贴到两边。 */
function panBounds(): PanBounds {
  const stage = stageRef.value;
  const img = imgRef.value;
  if (!stage || !img) return { maxX: 0, maxY: 0 };
  const cs = getComputedStyle(stage);
  const innerW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const innerH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return {
    maxX: Math.abs(img.offsetWidth - innerW) / 2,
    maxY: Math.abs(img.offsetHeight - innerH) / 2,
  };
}

/** 当前位移按最新尺寸夹一遍（缩放、加载完成、面板尺寸变化后调用） */
function clampPanInPlace(): void {
  if (fitMode.value) return;
  const b = panBounds();
  panX.value = clampNum(panX.value, -b.maxX, b.maxX);
  panY.value = clampNum(panY.value, -b.maxY, b.maxY);
}

let dragStartX = 0;
let dragStartY = 0;
let dragPanX = 0;
let dragPanY = 0;
let dragBounds: PanBounds = { maxX: 0, maxY: 0 };

function stopPan() {
  panning.value = false;
  window.removeEventListener('mousemove', onPanMove);
  window.removeEventListener('mouseup', stopPan);
  window.removeEventListener('blur', stopPan);
}
function onPanStart(e: MouseEvent) {
  // 适应窗口态整块铺满，挪了只会露白边，不接拖拽
  if (e.button !== 0 || fitMode.value || !loaded.value) return;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragPanX = panX.value;
  dragPanY = panY.value;
  // 夹取范围在起拖时量一次：拖动过程里尺寸不会变，省掉每帧 getComputedStyle
  dragBounds = panBounds();
  panning.value = true;
  // 不拦的话 <img> 原生拖拽会接管这次拖动，出现 ghost 图片且不再走 mousemove
  e.preventDefault();
  window.addEventListener('mousemove', onPanMove);
  window.addEventListener('mouseup', stopPan);
  // 窗口失焦（Alt+Tab / 弹窗抢焦点）收不到 mouseup：就地结束，别让图粘着指针
  window.addEventListener('blur', stopPan);
}
function onPanMove(e: MouseEvent) {
  // 在窗口外松手后再移回来（没收到 mouseup）：按键已经松开，结束平移
  if (e.buttons === 0) {
    stopPan();
    return;
  }
  panX.value = clampNum(
    dragPanX + (e.clientX - dragStartX),
    -dragBounds.maxX,
    dragBounds.maxX,
  );
  panY.value = clampNum(
    dragPanY + (e.clientY - dragStartY),
    -dragBounds.maxY,
    dragBounds.maxY,
  );
}

/** 面板尺寸变化（窗口缩放 / 页面全屏 / 分栏拖宽）：重新夹位移，别把图留在画布外 */
let ro: ResizeObserver | null = null;
onMounted(() => {
  resetImage();
  const stage = stageRef.value;
  if (stage) {
    ro = new ResizeObserver(clampPanInPlace);
    ro.observe(stage);
  }
});
onBeforeUnmount(() => {
  stopPan();
  ro?.disconnect();
  ro = null;
});

// 缩放后图片盒尺寸要等下一帧才生效，夹取放 nextTick；回适应窗口时位移清零
watch([zoom, fitMode, loaded], async () => {
  if (fitMode.value) {
    panX.value = 0;
    panY.value = 0;
    return;
  }
  await nextTick();
  clampPanInPlace();
});

// ---------- 缩放：100% = 图片自然尺寸（1:1） ----------
/** 自然尺寸只在 load 时取一次，给非适应态算显式宽度用 */
const nat = ref<{ w: number; h: number } | null>(null);

function onImgLoad(e: Event) {
  const el = e.target as HTMLImageElement;
  nat.value = { w: el.naturalWidth, h: el.naturalHeight };
  loaded.value = true;
}

/** 非适应态按「自然尺寸 × zoom%」出宽，高度由图片自身宽高比走；
 *  适应态交给 CSS 的 object-fit:contain 铺满，不写宽度。
 *  位移进 transform，尺寸超出画布由 .img-stage 的 overflow:hidden 裁掉（不出滚动条） */
const imgStyle = computed(() => {
  if (fitMode.value || !nat.value) return undefined;
  const offset = panX.value || panY.value
    ? `translate(${panX.value}px, ${panY.value}px)`
    : undefined;
  return { width: `${Math.max(1, Math.round((nat.value.w * zoom.value) / 100))}px`, transform: offset };
});

/** 适应窗口态下当前视觉比例，折算成同一口径（占自然尺寸的百分比）。
 *  contain 的缩放率 = min(容器宽/自然宽, 容器高/自然高)，退出适应时从这一档接手才不跳 */
function apparentZoom(): number {
  const el = imgRef.value;
  if (!el || !el.naturalWidth || !el.naturalHeight) return 100;
  const box = el.getBoundingClientRect();
  if (!box.width || !box.height) return 100;
  return clampZoom(Math.min(box.width / el.naturalWidth, box.height / el.naturalHeight) * 100);
}

/** 双击整块区域 = 页面全屏 / 还原。把码克当图片查看器用时，双击进来就该是整屏，再双击回去。
 *  写的是 editorStore.pageFull——与工具条「全屏」按钮、F11、外部打开时自动全屏同一份状态，
 *  不另开一套（见 mkdown-fullscreen-mechanics 那条：全屏必须单一入口）。 */
function onDblClick(): void {
  editor.pageFull = !editor.pageFull;
}

/** 滚轮上下 = 缩放（放大/缩小后的位置调整一律靠拖拽，不出滚动条） */
function onWheel(e: WheelEvent) {
  // 横向滚轮 / 触控板横滑 deltaY 为 0：既不是放大也不是缩小，直接忽略
  if (e.deltaY === 0) return;
  if (fitMode.value) {
    zoom.value = apparentZoom();
    fitMode.value = false;
  }
  zoom.value = stepZoom(zoom.value, e.deltaY < 0 ? 1 : -1);
}

// ---------- ←/→：同目录轮换由 Workbench 统一接管 ----------

/** 面板内右键：宿主是同源的普通 DOM（不像 HTML 帧得往 iframe 里注入脚本），
 *  拦掉原生菜单把坐标报给上层，由上层在同一处弹应用菜单 */
function onCtx(e: MouseEvent): void {
  e.preventDefault();
  emit('editorContext', {
    x: e.clientX,
    y: e.clientY,
    inTable: false,
    wideAlignable: false,
    engine: 'frame',
    frame: 'image',
  });
}
</script>

<template>
  <div class="img-pane mk-zoom-pane" @contextmenu="onCtx">
    <PreviewZoomBar v-model:zoom="zoom" v-model:fit="fitMode" show-fit>
      <OpenSystemBtn :path="path" inline />
    </PreviewZoomBar>
    <div
      ref="stageRef"
      class="img-stage"
      :class="{ dark: !fitMode, pannable: !fitMode && loaded, panning }"
      @mousedown="onPanStart"
      @wheel.prevent="onWheel"
      @dblclick="onDblClick"
    >
      <span v-if="!loaded && !failed" class="pv-hint">{{ t('preview.loading') }}</span>
      <img
        ref="imgRef"
        v-show="loaded"
        :src="src"
        :class="fitMode ? 'fit' : 'zoomed'"
        :style="imgStyle"
        alt=""
        @load="onImgLoad"
        @error="failed = true"
      />
      <span v-if="failed" class="pv-error">{{ t('preview.imgLoadFail') }}</span>
    </div>
  </div>
</template>

<style scoped>
.img-pane {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 工具条压到极限后保持自身宽度，超出这里裁掉，不去压邻栏 */
  background: var(--mk-bg);
}
.img-stage {
  flex: 1;
  /* 放大不出滚动条：位移全走拖拽（transform），超出画布的部分直接裁掉 */
  overflow: hidden;
  display: flex;
  /* 溢出时内容在起止两侧对称超出，配合 transform 位移两侧都到得了
     （原来的 margin:auto 方案在溢出时会退化成贴左上，且小图没有可拖行程） */
  align-items: center;
  justify-content: center;
  padding: 16px;
}
/* 默认「适应窗口」= 居中铺满：容器框占满可用区，图片由 object-fit:contain 等比缩到
   长边贴边（小图同样放大，且不裁切）。原先只写 max-width/max-height:100%，那两条
   只会缩小——64px 的图标在 800×600 面板里就是中间一个小点，看着像没做自适应 */
.img-stage img.fit {
  flex: none;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.img-stage img.zoomed {
  /* flex:none 是关键：img 作为 flex 子项默认 flex-shrink:1，width:N% 会被压回容器宽，
     实测 100%~300% 恒等于 stage 内容宽，即"放大过 100% 就没效果"。
     取消收缩后按显式宽度出盒，超出/小于画布都靠 transform 位移调整位置 */
  flex: none;
  max-width: none;
}
/* 非适应态整块画布都可抓：图比画布小时，指针常落在图外的空白上 */
.img-stage.pannable {
  cursor: grab;
}
/* 按住拖动中：光标换成抓取中并禁掉文字选中，避免拖出蓝色选区 */
.img-stage.panning {
  cursor: grabbing;
  user-select: none;
}
.img-stage.panning img {
  cursor: grabbing;
}
.pv-hint,
.pv-error {
  color: var(--mk-fg-soft);
  font-size: 14px;
}
.pv-error {
  color: var(--mk-danger);
}
</style>
