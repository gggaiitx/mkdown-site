/**
 * 设备像素比 → CSS 变量 --mk-dpr。
 *
 * 背景：由伪元素绘制的 1px 细线（目录树右缘、大纲左缘/隐藏态复原线）在非整数
 * 缩放下会被 Chromium 按设备像素网格 snap。Windows 125%（dpr=1.25）实测：
 * 目录树宽度满足 `width % 4 === 2` 的档位，1px 线被画成 2 个设备像素的满色
 * （视觉 2px），其余档位是 1 个设备像素 —— 即用户看到的「特定宽度边线变 2px」。
 *
 * 组件侧统一写 `calc(1px / var(--mk-dpr, 1))`，把细线折算成恒定 1 设备像素：
 * 100% 仍是 1px，125% → 0.8px，150% → 0.67px，任何宽度都稳定为一条线。
 */
export function syncDprVar(): void {
  document.documentElement.style.setProperty('--mk-dpr', String(window.devicePixelRatio || 1));
}

let query: MediaQueryList | null = null;

/** 同步一次并挂上监听：窗口跨显示器拖动、系统缩放变更时 dpr 会变 */
export function watchDprVar(): void {
  syncDprVar();
  query?.removeEventListener('change', watchDprVar);
  query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener('change', watchDprVar);
}
