<script setup lang="ts">
/**
 * SVG 预览框架：iframe srcdoc 渲染（svg 标签的分栏/阅读态渲染端）。
 *
 * 做法：把 SVG 文本包进一个最小 HTML 壳。两阶段适配——
 * ① 首次 build 不约束 svg（display:block + margin:auto 居中），load 后测量固有尺寸；
 * ② 若超出 stage 则按 min(stageW/natW, stageH/natH, 1) 计算适配率，重写 srcdoc
 *    给 svg 烘焙显式 px 尺寸。显式 px 使内容布局与 zoom 完全解耦。
 *
 * 缩放（图片预览式）：CSS zoom 只做视觉缩放、不重排；盒尺寸由「已知内容尺寸」
 * 直接计算（宽 = max(stage 宽, 内容宽)，高 = max(内容高, stage 高/zoom)），
 * 外层 stage 统一滚动。不走 scrollHeight 测量——body{height:100%} 会让
 * 视口高度反馈进测量造成盒高只涨不缩。壳内 html/body overflow:hidden，
 * 内层永不出滚动条；::-webkit-scrollbar 规则仅作兜底注入。
 *
 * 安全边界（与 HtmlFrame 同策略，刻意设计）：
 * - sandbox 仅 allow-same-origin（不含 allow-scripts）→ SVG 内脚本不执行；
 * - srcdoc 文档继承父窗口 CSP → 内联与外链脚本双保险被拦。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import OpenSystemBtn from './OpenSystemBtn.vue';
import PreviewZoomBar from './PreviewZoomBar.vue';
import { useI18n } from '../../i18n';

const { t } = useI18n();

const props = defineProps<{
  /** SVG 源码 */
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

const srcdoc = ref('');
let buildTimer: ReturnType<typeof setTimeout> | null = null;

/** svg 固有尺寸（load 后测得）与烘焙适配后的显式尺寸 */
const natural = ref<{ w: number; h: number } | null>(null);
const fitted = ref<{ w: number; h: number } | null>(null);

function build() {
  const dir = props.dir ?? '';
  const base = dir
    ? `<base href="http://asset.localhost/${encodeURIComponent(dir)}/">`
    : '';
  // 剥掉 XML 声明（HTML 上下文中无意义）；DOCTYPE svg 同理剥除，避免 bogus 解析
  const svg = props.content
    .replace(/<\?xml[\s\S]*?\?>/i, '')
    .replace(/<!DOCTYPE[^>]*>/i, '');
  // phase 1 不约束 svg（量固有尺寸）；phase 2 烘焙显式 px（布局与 zoom 解耦）。
  // margin:auto 居中；html/body overflow:hidden 把滚动交给外层 stage
  const svgCss = fitted.value
    ? `svg{display:block;margin:auto;width:${fitted.value.w}px;height:${fitted.value.h}px}`
    : 'svg{display:block;margin:auto}';
  srcdoc.value = `<!doctype html><html><head><meta charset="utf-8">${base}<style>
html,body{margin:0;height:100%;background:#fff;overflow:hidden}
body{display:flex}
${svgCss}
${scrollbarCss.value}
</style></head><body>${svg}</body></html>`;
}

watch(
  () => [props.content, props.dir, props.dark] as const,
  () => {
    if (buildTimer) clearTimeout(buildTimer);
    natural.value = null; // 内容变化后回 phase 1 重新适配
    fitted.value = null;
    buildTimer = setTimeout(build, 300); // 编辑态连续键入不重渲染
  },
  { immediate: true },
);

/** 盒尺寸由已知内容尺寸直接算（不用 scrollHeight：body 100% 会反馈视口高度）；
 *  盒(CSS px) = max(stage/z, 内容)，渲染后恰好铺满 stage，无缩放幽灵滚动区 */
function updateStyle() {
  const stage = stageRef.value;
  const z = Math.max(0.1, zoom.value / 100);
  const cw = fitted.value?.w ?? natural.value?.w ?? 0;
  const ch = fitted.value?.h ?? natural.value?.h ?? 0;
  const stageW = stage?.clientWidth ?? 0;
  const stageH = stage?.clientHeight ?? 0;
  frameStyle.value = {
    width: `${Math.max(stageW / z, cw)}px`,
    height: `${Math.max(stageH / z, ch)}px`,
    zoom: String(z),
  };
}
const frameStyle = ref<{ width: string; height: string; zoom: string }>({
  width: '100%',
  height: '100%',
  zoom: '1',
});
watch(zoom, updateStyle);

function onLoad() {
  // 固有尺寸只测一次（phase 2 重载后 svg rect 是适配尺寸，不能覆盖固有值）
  const frame = iframeRef.value;
  if (frame && !natural.value) {
    const svg = frame.contentDocument?.querySelector('svg');
    const rect = svg?.getBoundingClientRect();
    const w = rect ? Math.ceil(rect.width) : 0;
    const h = rect ? Math.ceil(rect.height) : 0;
    if (w && h) natural.value = { w, h };
  }
  refit();
}

/** 依固有尺寸重算适配率（stage 尺寸变化时调用）；fit 变化才重建 srcdoc */
function refit() {
  const stage = stageRef.value;
  const nat = natural.value;
  if (!stage || !nat) return;
  const fit = Math.min(1, stage.clientWidth / nat.w, stage.clientHeight / nat.h);
  const next = fit < 1 ? { w: Math.floor(nat.w * fit), h: Math.floor(nat.h * fit) } : null;
  const cur = fitted.value;
  const same = next === null ? cur === null : !!cur && next.w === cur.w && next.h === cur.h;
  if (!same) {
    fitted.value = next;
    build(); // 适配率变化 → 重写 srcdoc 烘焙新显式 px
  }
  updateStyle();
}

// stage 尺寸变化（拖目录树宽度 / 收展侧栏 / 窗口缩放）：
// 盒宽随 stage 连续跟随（updateStyle），适配率变化防抖后重建（refit）。
// 盒是按 stage.clientWidth 算的绝对 px，只听 window resize 不够——
// 拖目录树宽度不触发 window resize
let roTimer: ReturnType<typeof setTimeout> | null = null;
let stageRO: ResizeObserver | null = null;
onMounted(() => {
  stageRO = new ResizeObserver(() => {
    updateStyle();
    if (roTimer) clearTimeout(roTimer);
    roTimer = setTimeout(refit, 150);
  });
  if (stageRef.value) stageRO.observe(stageRef.value);
});
onBeforeUnmount(() => {
  stageRO?.disconnect();
  stageRO = null;
  if (roTimer) clearTimeout(roTimer);
});
</script>

<template>
  <div class="svg-frame-host">
    <PreviewZoomBar v-model:zoom="zoom" :min="ZOOM_MIN" :max="ZOOM_MAX" :step="ZOOM_STEP">
      <OpenSystemBtn v-if="path" :path="path" inline />
    </PreviewZoomBar>
    <div ref="stageRef" class="frame-stage">
      <iframe
        ref="iframeRef"
        class="svg-frame"
        :srcdoc="srcdoc"
        sandbox="allow-same-origin"
        :title="t('preview.svgTitle')"
        :style="frameStyle"
        @load="onLoad"
      ></iframe>
    </div>
  </div>
</template>

<style scoped>
.svg-frame-host {
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
.svg-frame {
  border: none;
  display: block;
  background: #fff;
}
</style>
