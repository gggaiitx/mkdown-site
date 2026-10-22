/**
 * 平滑回顶：把某个滚动容器从当前 scrollTop 缓动到 0（约 320~700ms，按距离取档）。
 *
 * 为什么要自己写而不直接 `scrollTo({behavior:'smooth'})`：
 *  - 需要**可中断**——用户在这 0.5 秒里自己滚了滚轮，动画必须立刻让位，
 *    否则会出现"我往回滚，它却继续把我顶回去"的手感；
 *  - 需要**可替换**——连点两次、或从分栏切到阅读态换了滚动宿主，上一次的 rAF 必须自己收掉；
 *  - 分栏态下 md 内核按**比例**双向同步两栏，只有驱动侧能跑动画（见 MdEditorV3Engine.smoothBackToTop），
 *    原生光滑滚动无法只驱动一侧。
 *
 * 中断只认用户意图（wheel / touchstart / keydown），不认 scroll 事件：
 * 动画自己每一帧写 scrollTop 也会发 scroll，监听 scroll 会把自己杀掉。
 */
const running = new WeakMap<HTMLElement, () => void>();

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** 距离越远给的时间越长，但夹在 320~700ms：再短看不出来、再长像卡住 */
function durationFor(distance: number): number {
  return Math.round(Math.min(700, Math.max(320, distance * 0.5)));
}

/** 把 el 缓动滚到顶。el 已不在文档里、或已在顶部时直接返回 */
export function smoothScrollTop(el: HTMLElement | null, duration?: number): void {
  if (!el || !el.isConnected) return;
  const start = el.scrollTop;
  if (start <= 1) {
    if (start !== 0) el.scrollTop = 0;
    return;
  }
  /* 系统开了「减少动态效果」：不做过渡，直接归零（无障碍口径，和 CSS 的
     prefers-reduced-motion 保持一致） */
  let reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    reduced = false;
  }
  if (reduced) {
    el.scrollTop = 0;
    return;
  }
  /* 同一宿主上再点一次：先收掉上一次，避免两条 rAF 抢着写同一个 scrollTop */
  running.get(el)?.();

  const total = duration ?? durationFor(start);
  const t0 = performance.now();
  let raf = 0;

  const cancel = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    el.removeEventListener('wheel', cancel, { capture: true } as EventListenerOptions);
    el.removeEventListener('touchstart', cancel, { capture: true } as EventListenerOptions);
    el.removeEventListener('keydown', cancel, { capture: true } as EventListenerOptions);
    if (running.get(el) === cancel) running.delete(el);
  };

  const step = (): void => {
    const p = Math.min(1, (performance.now() - t0) / total);
    el.scrollTop = Math.round(start * (1 - easeOutCubic(p)));
    if (p >= 1) {
      el.scrollTop = 0;
      cancel();
      return;
    }
    raf = requestAnimationFrame(step);
  };

  el.addEventListener('wheel', cancel, { capture: true, passive: true });
  el.addEventListener('touchstart', cancel, { capture: true, passive: true });
  el.addEventListener('keydown', cancel, { capture: true });
  running.set(el, cancel);
  raf = requestAnimationFrame(step);
}
