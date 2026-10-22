<script setup lang="ts">
/** 大纲面板：标题列表 + 左缘拖拽调宽（160–460px）；拖到最右隐藏，隐藏后拖边线复原 */
import { onBeforeUnmount, ref } from 'vue';
import { ListTree } from '@lucide/vue';
import { useEditorStore, type OutlineItem } from '../stores/editorStore';
import { useI18n } from '../i18n';

const editor = useEditorStore();
const { t } = useI18n();

const emit = defineEmits<{
  (e: 'goto', item: OutlineItem): void;
}>();

// ---- 拖拽调宽 / 拖动隐藏 / 边线复原 ----
const MIN_W = 160;
const MAX_W = 460;
/** 向右拖到低于该宽度 → 松手隐藏 */
const HIDE_AT = 100;
/** 隐藏后向左拖超过该距离 → 展开 */
const RESTORE_AT = 60;

const width = ref(220);
const collapsed = ref(false);
const dragging = ref(false);
let startX = 0;
let startW = 0;
let willCollapse = false; // 本次拖拽松手后是否收起
let restoring = false; // 当前是否处于「从隐藏拖出」的复原拖拽

function beginDrag(e: MouseEvent, fromCollapsed: boolean) {
  dragging.value = true;
  restoring = fromCollapsed;
  willCollapse = false;
  startX = e.clientX;
  startW = width.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  // iframe 会吞掉拖拽中的 mousemove/mouseup（见 global.css mk-col-dragging 注释）
  document.body.classList.add('mk-col-dragging');
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', onResizeEnd);
}
function onResizeStart(e: MouseEvent) {
  beginDrag(e, false);
}
function onRestoreStart(e: MouseEvent) {
  beginDrag(e, true);
}
function onResizeMove(e: MouseEvent) {
  if (!dragging.value) return;
  const dx = startX - e.clientX; // 向左拖为正 → 变宽
  if (restoring) {
    // 复原：拖过阈值即展开，宽度跟随拖拽实时增长，基准重置后无缝衔接普通调宽
    if (dx > RESTORE_AT) {
      collapsed.value = false;
      // 取整：小数宽度会让左缘 1px 边线落在亚像素边界上渲染成 2px 模糊线
      width.value = Math.round(Math.min(MAX_W, Math.max(MIN_W, dx)));
      restoring = false;
      startX = e.clientX;
      startW = width.value;
    }
    return;
  }
  const raw = startW + dx;
  willCollapse = raw < HIDE_AT;
  // 允许压到 0，给「正在收起」的视觉反馈；松手时按 willCollapse 定型
  width.value = Math.round(Math.min(MAX_W, Math.max(0, raw)));
}
function onResizeEnd() {
  if (!dragging.value) return;
  dragging.value = false;
  if (willCollapse) {
    collapsed.value = true;
    width.value = 0; // 宽度归零，不占布局；复原宽度由拖拽距离决定
  } else if (!restoring) {
    width.value = Math.min(MAX_W, Math.max(MIN_W, width.value));
  }
  restoring = false;
  willCollapse = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.body.classList.remove('mk-col-dragging');
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeEnd);
}
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeEnd);
  document.body.classList.remove('mk-col-dragging');
});
</script>

<template>
  <aside class="outline" :class="{ collapsed }" :style="{ width: `${width}px` }">
    <!-- 左缘拖拽手柄（拖到最右可隐藏） -->
    <div
      v-if="!collapsed"
      class="resizer"
      :class="{ active: dragging }"
      @mousedown="onResizeStart"
      :title="t('outline.resizerTip')"
    />
    <div v-show="!collapsed" class="outline-inner">
      <div class="panel-head">
        <ListTree class="head-icon" />
        <span>{{ t('outline.title') }}</span>
      </div>
      <div class="list" v-if="editor.outline.length > 0">
        <button
          v-for="item in editor.outline"
          :key="`${item.index}-${item.line}`"
          class="ol-item"
          :class="[`lv${Math.min(item.level, 4)}`, { on: editor.activeHeading === item.index }]"
          :style="{ paddingLeft: `${(item.level - 1) * 14 + 10}px` }"
          :title="t('outline.lineTip', { line: item.line })"
          @click="emit('goto', item)"
        >
          <span class="dot" />
          <span class="text">{{ item.text }}</span>
        </button>
      </div>
      <div v-else class="empty">{{ t('outline.empty') }}</div>
    </div>
    <!-- 隐藏态：右缘边线，向左拖动展开 -->
    <div v-if="collapsed" class="edge" :class="{ active: dragging }" @mousedown="onRestoreStart" :title="t('outline.edgeTip')" />
  </aside>
</template>

<style scoped>
.outline {
  position: relative;
  height: 100%;
  flex: none;
  background: var(--mk-panel);
}
/* 隐藏态：宽度归零，仅保留右缘边线供拖出复原 */
.outline.collapsed {
  background: transparent;
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
  /* 1 设备像素细线（--mk-dpr 见 main.ts）：避免非整数缩放下被 snap 成 2px */
  width: calc(1px / var(--mk-dpr, 1));
  background: transparent;
  transition: background-color 120ms ease;
}
/* hover/拖拽点亮：与目录树右缘同一套口径（2 设备像素 + accent 混色），
   宽度按 --mk-dpr 折算，避免非整数缩放下变粗发虚 */
.resizer:hover::after,
.resizer.active::after,
.edge:hover::after,
.edge.active::after {
  width: calc(2px / var(--mk-dpr, 1));
  background: color-mix(in srgb, var(--mk-accent) 62%, var(--mk-border));
}
.resizer.active::after,
.edge.active::after {
  background: var(--mk-accent);
}
/* 隐藏态的复原手柄：跨在编辑区右缘的窄条 + 常显 1px 边线 */
.edge {
  position: absolute;
  left: -4px;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 5;
}
.edge::after {
  content: '';
  position: absolute;
  left: 3.5px;
  top: 0;
  bottom: 0;
  /* 同上：常显边线折算成 1 设备像素 */
  width: calc(1px / var(--mk-dpr, 1));
  background: var(--mk-border);
  transition: background-color 120ms ease;
}
.outline-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid var(--mk-border);
  min-width: 0;
  overflow: hidden;
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
/* 层级标记（二版）：统一 5px 小圆点保持安静，层级区分交给缩进 + 文字排版——
   H1 加粗深色 → H2 中等 → H3 常规 → H4+ 常规弱化；圆点灰阶深浅仅作辅助。
   （一版混搭形状被否：太乱） */
.dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: var(--mk-ol-3); }
.ol-item.lv1 .dot { background: var(--mk-ol-1); }
.ol-item.lv2 .dot { background: var(--mk-ol-2); }
.ol-item.lv3 .dot { background: var(--mk-ol-3); }
.ol-item.lv4 .dot { background: var(--mk-ol-4); }
.ol-item.lv1 .text { font-weight: 600; }
.ol-item.lv2 .text { font-weight: 500; }
.ol-item.lv3 .text { font-weight: 400; }
.ol-item.lv4 .text { font-weight: 400; color: var(--mk-fg-muted); }
.text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 当前阅读位置（滚动联动，序号由 Workbench 量测写入 editor.activeHeading）：
   给一档实打实的淡墨底 + 圆点换成强调色，层级排版保持不变。
   原来这里也是 var(--mk-hover)，与上一行的悬停态是同一个值——
   选中条只有划过才看得出，静止时跟普通行没区别，这就是"不明显"的根因。
   淡墨按主题分开算：亮色 14% 落到 ~214（hover 245），暗色 accent 本身偏亮、
   14% 只够跟 hover(46) 打平，所以提到 24%（落到 ~69）才真压得过。 */
.ol-item.on { background: color-mix(in srgb, var(--mk-accent) 14%, transparent); }
:root[data-theme='dark'] .ol-item.on {
  background: color-mix(in srgb, var(--mk-accent) 24%, transparent);
}
.ol-item.on .dot { background: var(--mk-accent); }
.ol-item.on .text { color: var(--mk-fg); font-weight: 600; }
.empty { padding: 18px 12px; font-size: 13px; color: var(--mk-fg-muted); }
</style>
