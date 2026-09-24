<script setup lang="ts">
/**
 * 图片预览：WebView2 原生可解码格式（png/jpg/gif/bmp/webp/svg/ico），
 * 经 asset:// 加载（img-src CSP 已放行）。支持缩放与适应窗口。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { Minus, Plus, Scan, ZoomIn } from '@lucide/vue';

import { convertFileSrc } from '@tauri-apps/api/core';

import OpenSystemBtn from './OpenSystemBtn.vue';

const props = defineProps<{ path: string }>();

const ZOOM_MIN = 10;
const ZOOM_MAX = 800;
const ZOOM_STEP = 20;

const zoom = ref(100);
const fitMode = ref(true); // 适应窗口（默认），关掉后按 zoom 百分比显示
const loaded = ref(false);
const failed = ref(false);

const src = computed(() => convertFileSrc(props.path));

function zoomIn() {
  fitMode.value = false;
  zoom.value = Math.min(ZOOM_MAX, zoom.value + ZOOM_STEP);
}
function zoomOut() {
  fitMode.value = false;
  zoom.value = Math.max(ZOOM_MIN, zoom.value - ZOOM_STEP);
}
function resetZoom() {
  fitMode.value = false;
  zoom.value = 100;
}
function toggleFit() {
  fitMode.value = !fitMode.value;
}

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
</script>

<template>
  <div class="img-pane">
    <div class="img-toolbar">
      <button class="tb" title="缩小" @click="zoomOut"><Minus :size="14" /></button>
      <span class="tb-val">{{ fitMode ? '适应窗口' : `${zoom}%` }}</span>
      <button class="tb" title="放大" @click="zoomIn"><Plus :size="14" /></button>
      <button class="tb" title="实际大小 100%" @click="resetZoom"><Scan :size="14" /></button>
      <button class="tb" title="适应窗口" :class="{ on: fitMode }" @click="toggleFit">
        <ZoomIn :size="14" />
      </button>
      <OpenSystemBtn :path="path" inline />
    </div>
    <div class="img-stage" :class="{ dark: !fitMode }">
      <span v-if="!loaded && !failed" class="pv-hint">加载中…</span>
      <img
        v-show="loaded"
        :src="src"
        :class="fitMode ? 'fit' : 'zoomed'"
        :style="fitMode ? undefined : { width: `${zoom}%` }"
        alt=""
        @load="loaded = true"
        @error="failed = true"
      />
      <span v-if="failed" class="pv-error">图片无法加载，可用系统默认程序打开</span>
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
.img-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid var(--mk-border, #e0e0e0);
}
.tb {
  appearance: none;
  border: 1px solid var(--mk-border, #e0e0e0);
  background: var(--mk-panel, #fff);
  color: var(--mk-fg, #24292f);
  border-radius: 6px;
  padding: 4px 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.tb.on,
.tb:hover {
  border-color: var(--mk-accent, #4a89dc);
  color: var(--mk-accent, #4a89dc);
}
.tb-val {
  min-width: 64px;
  text-align: center;
  font-size: 12px;
  color: var(--mk-fg-soft, #666);
}
.img-stage {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.img-stage img.fit {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.img-stage img.zoomed {
  max-width: none;
  cursor: grab;
}
.pv-hint,
.pv-error {
  color: var(--mk-fg-soft, #666);
  font-size: 14px;
}
.pv-error {
  color: var(--mk-danger, #d9534f);
}
</style>
