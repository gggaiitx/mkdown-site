<script setup lang="ts">
/**
 * 图片预览：WebView2 原生可解码格式（png/jpg/gif/bmp/webp/svg/ico），
 * 经 asset:// 加载（img-src CSP 已放行）。默认适应窗口＝居中铺满，滚轮缩放，
 * 放大态可拖拽平移，双击整块区域＝页面全屏 / 还原（当图片查看器用的手势）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { convertFileSrc } from '@tauri-apps/api/core';

import OpenSystemBtn from './OpenSystemBtn.vue';
import PreviewZoomBar from './PreviewZoomBar.vue';
import { clampZoom, stepZoom } from './zoomRange';
import { useEditorStore } from '../../stores/editorStore';
import { useI18n } from '../../i18n';

const props = defineProps<{ path: string }>();

const { t } = useI18n();
const editor = useEditorStore();

const zoom = ref(100);
/** 适应窗口（默认）：整块面板铺满；关掉后按「自然尺寸 × zoom%」出宽，100% = 1:1 */
const fitMode = ref(true);
const loaded = ref(false);
const failed = ref(false);

const src = computed(() => convertFileSrc(props.path));

function resetImage() {
  loaded.value = false;
  failed.value = false;
  nat.value = null;
  fitMode.value = true;
  zoom.value = 100;
}
onMounted(resetImage);
watch(() => props.path, resetImage);

// ---------- 放大态拖拽平移：直接搬 stage 的滚动位置 ----------
// 不用 transform 位移：滚动范围由图片实际盒算出来，margin:auto 居中那套也不用改；
// 图片比容器小时拖动就是空转，不必额外加条件判断
const stageRef = ref<HTMLElement | null>(null);
const panning = ref(false);
let panStartX = 0;
let panStartY = 0;
let panScrollX = 0;
let panScrollY = 0;
function stopPan() {
  panning.value = false;
  window.removeEventListener('mousemove', onPanMove);
  window.removeEventListener('mouseup', stopPan);
}
function onPanStart(e: MouseEvent) {
  if (e.button !== 0 || fitMode.value) return;
  const el = stageRef.value;
  if (!el) return;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panScrollX = el.scrollLeft;
  panScrollY = el.scrollTop;
  panning.value = true;
  // 不拦的话 <img> 原生拖拽会接管这次拖动，出现 ghost 图片且不再走 mousemove
  e.preventDefault();
  window.addEventListener('mousemove', onPanMove);
  window.addEventListener('mouseup', stopPan);
}
function onPanMove(e: MouseEvent) {
  const el = stageRef.value;
  if (!el) return;
  el.scrollLeft = panScrollX - (e.clientX - panStartX);
  el.scrollTop = panScrollY - (e.clientY - panStartY);
}
onBeforeUnmount(stopPan);

// ---------- 缩放：100% = 图片自然尺寸（1:1） ----------
const imgRef = ref<HTMLImageElement | null>(null);
/** 自然尺寸只在 load 时取一次，给非适应态算显式宽度用 */
const nat = ref<{ w: number; h: number } | null>(null);

function onImgLoad(e: Event) {
  const el = e.target as HTMLImageElement;
  nat.value = { w: el.naturalWidth, h: el.naturalHeight };
  loaded.value = true;
}

/** 非适应态按「自然尺寸 × zoom%」出宽，高度由图片自身宽高比走；
 *  适应态交给 CSS 的 object-fit:contain 铺满，不写宽度 */
const imgStyle = computed(() => {
  if (fitMode.value || !nat.value) return undefined;
  return { width: `${Math.max(1, Math.round((nat.value.w * zoom.value) / 100))}px` };
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

/** 滚轮上下 = 缩放（放大后靠拖拽平移和滚动条挪视口，这是图片查看器的常规分工） */
function onWheel(e: WheelEvent) {
  if (fitMode.value) {
    zoom.value = apparentZoom();
    fitMode.value = false;
  }
  zoom.value = stepZoom(zoom.value, e.deltaY < 0 ? 1 : -1);
}
</script>

<template>
  <div class="img-pane mk-zoom-pane">
    <PreviewZoomBar v-model:zoom="zoom" v-model:fit="fitMode" show-fit>
      <OpenSystemBtn :path="path" inline />
    </PreviewZoomBar>
    <div
      ref="stageRef"
      class="img-stage"
      :class="{ dark: !fitMode, panning }"
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
  overflow: auto;
  display: flex;
  padding: 16px;
}
/* 居中用子项 margin:auto 而非容器的 align/justify center：
   flex 容器居中 + overflow 时，上/左方向溢出不可达（滚不上去）——
   margin:auto 在内容小于容器时同样居中，溢出方向全部可滚动 */
.img-stage img {
  margin: auto;
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
     取消收缩后超出部分交给 .img-stage 自己滚，小于容器时 margin:auto 照样居中 */
  flex: none;
  max-width: none;
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
  margin: auto; /* 容器改用子项 margin:auto 居中后，提示同样保持居中 */
  color: var(--mk-fg-soft);
  font-size: 14px;
}
.pv-error {
  color: var(--mk-danger);
}
</style>
