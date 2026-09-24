<script setup lang="ts">
/** 大纲面板：标题列表 + 左缘拖拽调宽（160–460px） */
import { onBeforeUnmount, ref } from 'vue';
import { ListTree } from '@lucide/vue';
import { useEditorStore, type OutlineItem } from '../stores/editorStore';

const editor = useEditorStore();

const emit = defineEmits<{
  (e: 'goto', item: OutlineItem): void;
}>();

// ---- 拖拽调宽 ----
const width = ref(220);
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
  // 向左拖 → 变宽
  width.value = Math.min(460, Math.max(160, startW + (startX - e.clientX)));
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

const levelColor = (lv: number) => `var(--mk-ol-${Math.min(lv, 4)})`;
</script>

<template>
  <aside class="outline" :style="{ width: `${width}px` }">
    <!-- 左缘拖拽手柄 -->
    <div
      class="resizer"
      :class="{ active: dragging }"
      @mousedown="onResizeStart"
      title="拖动调整宽度"
    />
    <div class="outline-inner">
      <div class="panel-head">
        <ListTree class="head-icon" />
        <span>大纲</span>
      </div>
      <div class="list" v-if="editor.outline.length > 0">
        <button
          v-for="item in editor.outline"
          :key="`${item.index}-${item.line}`"
          class="ol-item"
          :style="{ paddingLeft: `${(item.level - 1) * 14 + 10}px` }"
          :title="`第 ${item.line} 行`"
          @click="emit('goto', item)"
        >
          <span class="dot" :style="{ background: levelColor(item.level) }" />
          <span class="text">{{ item.text }}</span>
        </button>
      </div>
      <div v-else class="empty">暂无标题</div>
    </div>
  </aside>
</template>

<style scoped>
.outline {
  position: relative;
  height: 100%;
  flex: none;
  background: var(--mk-panel);
}
.resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}
.resizer::after {
  content: '';
  position: absolute;
  left: 2.5px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: transparent;
  transition: background-color 120ms ease;
}
.resizer:hover::after,
.resizer.active::after {
  background: var(--mk-accent);
}
.outline-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid var(--mk-border);
  min-width: 0;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--mk-fg-muted);
  letter-spacing: 1.5px;
  flex: none;
}
.head-icon { width: 13px; height: 13px; }
.list { overflow-y: auto; overflow-x: hidden; flex: 1; padding: 2px 6px 12px; }
.ol-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--mk-fg);
  font-size: 13px;
  line-height: 1.5;
  height: 27px;
  padding-right: 8px;
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
  white-space: nowrap;
}
.ol-item:hover { background: var(--mk-hover); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 18px 12px; font-size: 13px; color: var(--mk-fg-muted); }
</style>
