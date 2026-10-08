<script setup lang="ts">
/**
 * HTML 预览框架：iframe srcdoc 渲染。
 *
 * 安全边界（刻意设计）：
 * - sandbox 仅 allow-same-origin（不含 allow-scripts/form/popup）→ 文档内脚本不执行；
 * - srcdoc 文档继承父窗口 CSP（script-src 'self'）→ 双保险，内联与外链脚本都被拦；
 * - <base href=asset://…> 注入后相对路径的 CSS/图片可正常加载
 *   （CSP style-src/img-src 已放行 asset: http://asset.localhost）。
 * 适用场景：查看静态页面效果；带交互脚本的页面仍需浏览器打开。
 *
 * 缩放（useFrameScale，图片预览式）：布局视口恒定为 stage 宽度，CSS zoom 只做
 * 视觉缩放，iframe 盒按内容实际尺寸撑开、由外层 stage 统一滚动；注入
 * html{overflow:hidden} 压掉 iframe 内层滚动条 + ::-webkit-scrollbar 兜底
 * （WebView2=Chromium，iframe 内部样式无法从父文档穿透，只能随 srcdoc 注入）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import OpenSystemBtn from './OpenSystemBtn.vue';
import PreviewZoomBar from './PreviewZoomBar.vue';
import { useFrameScale } from './useFrameScale';

const props = defineProps<{
  /** HTML 源码 */
  content: string;
  /** 文档所在目录（相对资源解析基准），null/空 = 不注入 base */
  dir: string | null;
  /** 文件完整路径（工具栏"系统打开"按钮用），null = 不显示按钮 */
  path?: string | null;
  /** 应用暗色主题：决定注入 iframe 的滚动条配色 */
  dark?: boolean;
}>();

const ZOOM_MIN = 30;
const ZOOM_MAX = 300;
const ZOOM_STEP = 5;
const zoom = ref(100);

const iframeRef = ref<HTMLIFrameElement | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const { frameStyle, scheduleMeasure, measure } = useFrameScale(iframeRef, stageRef, zoom);

const srcdoc = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;

/** 与 global.css 全局滚动条同款：10px、透明轨道、hover 加深 */
const scrollbarCss = computed(() => {
  const thumb = props.dark ? 'rgb(110 110 114 / 0.45)' : 'rgb(212 212 212)';
  const thumbHover = props.dark ? 'rgb(190 191 197)' : 'rgb(115 115 115)';
  return (
    '::-webkit-scrollbar{width:10px;height:10px}' +
    '::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}' +
    `::-webkit-scrollbar-thumb{background:${thumb};border-radius:6px;border:2.5px solid transparent;background-clip:padding-box}` +
    `::-webkit-scrollbar-thumb:hover{background:${thumbHover};border:2.5px solid transparent;background-clip:padding-box}`
  );
});

function build() {
  let doc = props.content;
  const dir = props.dir ?? '';
  if (dir) {
    // 与 Tauri convertFileSrc 的 Windows 形态一致：http://asset.localhost/<encodeURIComponent(路径)>
    const base = `http://asset.localhost/${encodeURIComponent(dir)}/`;
    if (/<head[^>]*>/i.test(doc)) {
      doc = doc.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
    } else if (/<html[^>]*>/i.test(doc)) {
      doc = doc.replace(/<html([^>]*)>/i, `<html$1><head><base href="${base}"></head>`);
    } else {
      doc = `<base href="${base}">` + doc;
    }
  }
  // 滚动条兜底样式 + 根元素溢出交由外层 stage 滚动（盒尺寸经 useFrameScale 撑开）
  const style = `<style data-mk-scrollbar>${scrollbarCss.value}html{overflow:hidden!important}</style>`;
  if (/<\/head\s*>/i.test(doc)) {
    doc = doc.replace(/<\/head\s*>/i, `${style}</head>`);
  } else {
    doc = doc + style;
  }
  srcdoc.value = doc;
  scheduleMeasure();
}

watch(
  () => [props.content, props.dir, props.dark] as const,
  () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(build, 300); // 编辑态连续键入不重渲染
  },
  { immediate: true },
);

function onLoad() {
  scheduleMeasure();
}

// stage 尺寸变化（拖目录树宽度 / 收展侧栏等任何布局变化）→ 重测盒尺寸。
// 盒是按测量时的 stage.clientWidth 算的绝对 px，不重测就会失效——
// 只监听 window resize 不够（拖树宽度不触发 window resize）
let stageRO: ResizeObserver | null = null;
onMounted(() => {
  stageRO = new ResizeObserver(() => measure());
  if (stageRef.value) stageRO.observe(stageRef.value);
});
onBeforeUnmount(() => {
  stageRO?.disconnect();
  stageRO = null;
});
</script>

<template>
  <div class="html-frame-host">
    <PreviewZoomBar v-model:zoom="zoom" :min="ZOOM_MIN" :max="ZOOM_MAX" :step="ZOOM_STEP">
      <OpenSystemBtn v-if="path" :path="path" inline />
    </PreviewZoomBar>
    <div ref="stageRef" class="frame-stage">
      <iframe
        ref="iframeRef"
        class="html-frame"
        :srcdoc="srcdoc"
        sandbox="allow-same-origin"
        title="HTML 预览"
        :style="frameStyle"
        @load="onLoad"
      ></iframe>
    </div>
  </div>
</template>

<style scoped>
.html-frame-host {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
}
.frame-stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.html-frame {
  border: none;
  display: block;
  background: #fff;
}
</style>
