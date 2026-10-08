<script setup lang="ts">
/**
 * 预览缩放工具栏（HtmlFrame / SvgFrame 共用）：缩小 / 百分比（点击重置）/ 放大 / 重置 100%。
 * 视觉对齐 ImagePreview 的工具条；尾部 slot 供 OpenSystemBtn(inline) 等扩展。
 */
import { Minus, Plus, Scan } from '@lucide/vue';

const props = withDefaults(
  defineProps<{ zoom: number; min?: number; max?: number; step?: number }>(),
  { min: 30, max: 300, step: 5 },
);
const emit = defineEmits<{ (e: 'update:zoom', v: number): void }>();

function zoomIn() {
  emit('update:zoom', Math.min(props.max, props.zoom + props.step));
}
function zoomOut() {
  emit('update:zoom', Math.max(props.min, props.zoom - props.step));
}
function reset() {
  emit('update:zoom', 100);
}
</script>

<template>
  <div class="zoom-bar">
    <button class="tb" title="缩小" @click="zoomOut"><Minus :size="14" /></button>
    <button class="tb tb-val" title="点击重置 100%" @click="reset">{{ zoom }}%</button>
    <button class="tb" title="放大" @click="zoomIn"><Plus :size="14" /></button>
    <button class="tb" title="重置 100%" @click="reset"><Scan :size="14" /></button>
    <slot />
  </div>
</template>

<style scoped>
.zoom-bar {
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
.tb:hover {
  border-color: var(--mk-accent, #4a89dc);
  color: var(--mk-accent, #4a89dc);
}
.tb-val {
  min-width: 56px;
  justify-content: center;
  font-size: 12px;
  color: var(--mk-fg-soft, #666);
}
</style>
