import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

export interface FrameStyle {
  width: string;
  height: string;
  zoom: string;
}

/**
 * iframe 内容级缩放（HtmlFrame / SvgFrame 共用）。
 *
 * 模型（图片预览式）：
 * - CSS zoom 只做视觉缩放，iframe 内部布局视口与 zoom 无关——
 *   盒宽 W = max(stage 宽, 内容 scrollWidth)，100% 与放大后布局完全一致，不重排；
 * - 盒高 H = max(内容 scrollHeight, stage 高 / zoom)（后者仅防盒小于 stage 露底）；
 * - 内容溢出全部由外层 stage 统一滚动 → 滚动条只有一套（全局 webkit 样式），
 *   iframe 内部经注入 html{overflow:hidden} 不再出现内层滚动条；
 * - zoom 变化不改内容布局，直接重算盒尺寸即可。
 */
export function useFrameScale(
  iframeRef: Ref<HTMLIFrameElement | null>,
  stageRef: Ref<HTMLElement | null>,
  zoomPercent: Ref<number>,
) {
  const frameStyle = ref<FrameStyle>({ width: '100%', height: '100%', zoom: '1' });

  let timers: ReturnType<typeof setTimeout>[] = [];
  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  function measure() {
    const frame = iframeRef.value;
    const stage = stageRef.value;
    if (!frame || !stage) return;
    const doc = frame.contentDocument;
    const de = doc?.documentElement;
    const sw = Math.max(de?.scrollWidth ?? 0, doc?.body?.scrollWidth ?? 0);
    const sh = Math.max(de?.scrollHeight ?? 0, doc?.body?.scrollHeight ?? 0);
    const z = Math.max(0.1, zoomPercent.value / 100);
    // 盒(CSS px) = max(stage/z, 内容)：渲染后恰好铺满 stage，无缩放幽灵滚动区；
    // 内容超界（固定宽元素）时按内容撑开、由 stage 平移。stage/z 收紧视口
    // 正是浏览器 Ctrl+滚轮缩放语义（文本随缩放重新折行）
    const w = Math.max(stage.clientWidth / z, sw);
    const h = Math.max(stage.clientHeight / z, sh);
    frameStyle.value = { width: `${w}px`, height: `${h}px`, zoom: String(z) };
  }

  /** load 后多轮测量：覆盖字体/图片等异步资源引起的尺寸变化 */
  function scheduleMeasure() {
    clearTimers();
    for (const ms of [0, 350, 900]) timers.push(setTimeout(measure, ms));
  }

  watch(zoomPercent, () => measure());
  window.addEventListener('resize', measure);
  onBeforeUnmount(() => {
    clearTimers();
    window.removeEventListener('resize', measure);
  });

  return { frameStyle, scheduleMeasure, measure };
}
