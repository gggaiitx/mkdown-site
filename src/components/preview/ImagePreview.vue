<script setup lang="ts">
/**
 * 图片预览：WebView2 原生可解码格式（png/jpg/gif/bmp/webp/svg/ico），
 * 经 asset:// 加载（img-src CSP 已放行）。支持缩放、适应窗口与放大态拖拽平移。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { convertFileSrc } from '@tauri-apps/api/core';

import OpenSystemBtn from './OpenSystemBtn.vue';
import PreviewZoomBar from './PreviewZoomBar.vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ path: string }>();

const { t } = useI18n();

const ZOOM_MIN = 10;
const ZOOM_MAX = 800;
const ZOOM_STEP = 5;

const zoom = ref(100);
const fitMode = ref(true); // 适应窗口（默认），关掉后按 zoom 百分比显示
const loaded = ref(false);
const failed = ref(false);

const src = computed(() => convertFileSrc(props.path));

onMounted(() => {
  loaded.value = false;
  failed.value = false;
});
watch(
  () => props.path,
  () => {
    loaded.value = false;
    failed.value = false;
    fitMode.value = true;
    zoom.value = 100;
  },
);

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
</script>

<template>
  <div class="img-pane">
    <PreviewZoomBar
      v-model:zoom="zoom"
      v-model:fit="fitMode"
      :min="ZOOM_MIN"
      :max="ZOOM_MAX"
      :step="ZOOM_STEP"
      show-fit
    >
      <OpenSystemBtn :path="path" inline />
    </PreviewZoomBar>
    <div
      ref="stageRef"
      class="img-stage"
      :class="{ dark: !fitMode, panning }"
      @mousedown="onPanStart"
    >
      <span v-if="!loaded && !failed" class="pv-hint">{{ t('preview.loading') }}</span>
      <img
        v-show="loaded"
        :src="src"
        :class="fitMode ? 'fit' : 'zoomed'"
        :style="fitMode ? undefined : { width: `${zoom}%` }"
        alt=""
        @load="loaded = true"
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
.img-stage img.fit {
  max-width: 100%;
  max-height: 100%;
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
