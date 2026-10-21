<script setup lang="ts">
/**
 * 预览区共用工具条：图片 / HTML / SVG 三处同一份定稿（原先各写一套、观感漂移）。
 * − 读数 + 实际尺寸 [适应窗口] + 尾部 slot（OpenSystemBtn inline）+ 全屏。
 * 条身浮在面板顶缘，默认收起让内容占满整块，鼠标进面板或 Tab 到条上才露出
 * （收放规则在 global.css 的 .mk-zoom-pane 契约里，宿主根节点挂这个类）。
 * 开着适应窗口时读数显示「适应窗口」，任何手动缩放都先退出该模式。
 * 全屏读 editorStore.pageFull——它必须和 F11、右键菜单是同一份状态；
 * 图标随状态换向（Maximize2 ⇄ Minimize2），和 Windows 标题栏那个按钮同惯例。
 * 图标刻意用 Maximize2 / Minimize2（对角双箭头）：Maximize 与「实际尺寸」的 Scan
 * 在 14px 下都是四角括号，两个紧挨着的按钮长得一样，认不出来。
 */
import { Maximize2, Minimize2, Minus, Plus, Scan, ZoomIn } from '@lucide/vue';

import { useEditorStore } from '../../stores/editorStore';
import { useI18n } from '../../i18n';
import { stepZoom } from './zoomRange';

const { t } = useI18n();
const editor = useEditorStore();

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
</script>

<template>
  <div class="zoom-bar">
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
      class="tb tb-full"
      :class="{ on: editor.pageFull }"
      :title="editor.pageFull ? t('engine.exitPageFullscreen') : t('engine.pageFullscreen')"
      @click="editor.pageFull = !editor.pageFull"
    >
      <component :is="editor.pageFull ? Minimize2 : Maximize2" :size="14" />
    </button>
  </div>
</template>

<style scoped>
/* 定位与「hover / focus-within 才浮出」的收放在 global.css 的 .mk-zoom-pane 契约里，
   这里只管条身外观。不再声明 position——绝对定位元素本身就是 .tb-full 的包含块 */
.zoom-bar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 4px;
  background: var(--mk-panel);
  border-bottom: 1px solid var(--mk-border);
  box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
  /* 分栏把预览区拖窄时，工具条压到极限就不再收缩、保持自身宽度（超出部分由宿主
     overflow:hidden 裁掉）。不钉住的话 flex 会把按钮挤到 min-content，「系统打开」
     的中文逐字竖排成一列，整条变形 */
  min-width: max-content;
}
/* 绝对定位而非 flex 尾项：margin-left:auto 会把左边整组推到左对齐，
   居中观感就没了 */
.tb-full {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
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
