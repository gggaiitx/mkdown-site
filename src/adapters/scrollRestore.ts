/**
 * 引擎常驻（v-show）后的滚动恢复工具（2026-10-17）。
 *
 * 为什么需要重试：
 * - 元素被 `display:none` 隐藏时浏览器会丢弃其滚动位置（切回来读到 0），所以位置必须由
 *   上层按标签存下来再写回；
 * - 刚从隐藏切回可见的同一帧里布局尚未结算：CodeMirror 只渲染可视区行，写 scrollTop 时
 *   文档总高还是旧值/零值，会被钳制；富文本（Slate）与 md 阅读容器同理。
 * 因此逐帧重试，直到值真正落地或次数用尽（默认 4 帧 ≈ 64ms，肉眼不可见，也不会和用户
 * 随后的滚动打架）。宿主缺失（引擎未挂载 / 该模式无滚动容器）时静默放弃。
 */
const EPS = 2;

/** 恢复代次：任何显式定位（大纲跳转、搜索命中跳转、会话光标还原）都要把它 +1，
 *  正在重试的恢复循环发现自己不是最新一代就立刻停手——否则「切标签顺带恢复滚动位」
 *  会在几帧后把刚跳过去的视口又拽回上一次的位置（同标签点击搜索结果时两者同 tick）。 */
let restoreGen = 0;

/** 放弃所有在飞的滚动恢复（下一条显式定位生效前调用） */
export function cancelScrollRestore(): void {
  restoreGen += 1;
}

export function restoreScrollTop(
  hostOf: () => HTMLElement | null,
  top: number,
  tries = 4,
): void {
  if (!Number.isFinite(top) || top <= 0) return;
  const my = ++restoreGen;
  let left = tries;
  const step = (): void => {
    if (my !== restoreGen) return; // 期间发生过显式定位：让位
    const host = hostOf();
    if (!host || left-- <= 0) return;
    host.scrollTop = top;
    // 下一帧复核：钳制未解开（内容还没排到那么高）就再写一次
    if (Math.abs(host.scrollTop - top) > EPS) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

/** 取滚动位置：宿主缺失返回 0（上层据此跳过恢复，避免把「0」当成有效存档写进标签） */
export function captureScrollTop(hostOf: () => HTMLElement | null): number {
  const host = hostOf();
  if (!host) return 0;
  // 停在文档头不必存档：切回来本就从顶部开始，写 0 反而覆盖不了历史值
  return host.scrollTop > EPS ? host.scrollTop : 0;
}
