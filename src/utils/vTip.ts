import type { Directive } from 'vue';

/**
 * v-tip="文案" —— 气泡提示的唯一入口，同时负责可访问名。
 *
 * 为什么不是直接写 `:data-tip`：FloatTip 读 `data-tip` 画自绘气泡，而 `data-*` 不参与
 * 无障碍名称计算。此前 28 处提示里 18 个纯图标按钮既无 aria-label 也无文字，
 * 屏幕阅读器读出来是 18 个"无名按钮"（WCAG 4.1.2）。
 *
 * 规则：
 * - 一律写 data-tip，保持 FloatTip 现有机制不变；
 * - 只有「控件本身没有任何可读文字」时才补 aria-label —— 有可见文字的按钮不补，
 *   否则 aria-label 会顶掉可见文字，反而违反「名称里要含可见文字」。
 *
 * 挂载入口除 main.ts 外，repro/ 下的探针页自建 app 时也要 `app.directive('tip', vTip)`。
 */
export const vTip: Directive<HTMLElement, string | undefined> = {
  mounted(el, { value }) {
    apply(el, value);
  },
  updated(el, { value, oldValue }) {
    if (value !== oldValue) apply(el, value);
  },
};

function apply(el: HTMLElement, text?: string) {
  if (!text) {
    el.removeAttribute('data-tip');
    return;
  }
  el.setAttribute('data-tip', text);
  if (!el.textContent?.trim() && !el.hasAttribute('aria-label')) {
    el.setAttribute('aria-label', text);
  }
}
