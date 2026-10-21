/**
 * 预览类面板（图片 / HTML / SVG）共用的缩放口径与档位。
 *
 * ★ 百分比一律「相对设计尺寸 / 图片自然尺寸」：**100% 就是 1:1**，「实际尺寸」按钮名副其实。
 *   原先 SVG 与 HTML 用 30~300、图片用 10~800，而且 SVG 的 100% 其实是"铺满面板"，
 *   同一个读数在三个面板里表示三种尺寸，缩小按钮按到底还缩不下去。
 *
 * ★ 「适应窗口」不再是一套独立的渲染分支，就是把 zoom 设成按面板算出来的那个值
 *   （24px 的图标铺满 524px 面板 = 2183%）。所以退出适应时天然是当前比例，不会跳变。
 *
 * ★ 步长必须按比例走：5%~20000% 的区间里固定 ±5 要按几千次才到头，没有意义。
 *   PDF 预览不并进来（它按页宽适配、30~300 步长 10，自有一套）。
 */
export const ZOOM_MIN = 5;
/** 上限要容得下「适应窗口」算出来的那一档：16px 的图标铺满 2000px 面板就是 12500%，
 *  卡在 4000% 会让小图明明铺不满却已经是上限。DOM 侧不用担心大——盒宽按 面板宽÷zoom
 *  算，档位越高盒越小，只是渲染倍率上去。 */
export const ZOOM_MAX = 20000;

/** ± 按钮与滚轮共用：每档 ×1.25 / ÷1.25 */
const ZOOM_FACTOR = 1.25;

/** 100% 以下改用更细的一档（×1.1）：从 100% 往下按，1.25 会一步跳到 80%，
 *   想在 60%~90% 之间挑个刚好看得清的档位根本落不住（飞总：1~100 之间步长再小点）。
 *   上限那侧维持 1.25，否则爬到 20000% 要按上百次。 */
const ZOOM_FACTOR_FINE = 1.1;

export function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v)));
}

/** 在当前档位上走一档（dir=+1 放大，-1 缩小）。
 *  ★ 判档要把"离开 100% 往下"那一步也算进细档：条件写成 `base < 100` 时，
 *    从 100% 按第一下用的是 1.25 → 直接跳 80%，正是要避免的那一跤（实测 100→80→73…）。
 *    往下用 `<= 100`、往上用 `< 100`，91 ↔ 100 这一对正好互逆。 */
export function stepZoom(cur: number, dir: 1 | -1): number {
  const base = Number.isFinite(cur) && cur > 0 ? cur : 100;
  const fine = dir < 0 ? base <= 100 : base < 100;
  const f = fine ? ZOOM_FACTOR_FINE : ZOOM_FACTOR;
  return clampZoom(dir > 0 ? base * f : base / f);
}
