<script setup lang="ts">
/**
 * 正文预览区「回到顶部」浮标（长 Markdown / Markhtml 文档）。
 *
 * 挂在两个正文引擎的根节点里（`.engine-root` / `.wang-engine-root`，两者都已是
 * position:relative 的定位父级），绝对定位贴右下角——这样页面全屏态（引擎根变 fixed）
 * 不用另做 Teleport，重排、分栏拖动、窗口缩放也全由 CSS 跟着走。
 *
 * 三个判据叠出「该不该出现」：
 *  ① 设置开关 backTopEnabled；
 *  ② 滚动宿主 scrollTop 超过阈值（240px）——短文档根本不滚，按钮永不出现在第一屏；
 *  ③ 自适应档（backTopMode='auto'）还要求指针在右下热区内。
 * 「一直显示」只是去掉 ③，① ② 仍生效：回到顶部的按钮停在文档顶部毫无意义。
 *
 * ★ 热区用 pointermove 算，不铺一块透明命中区：右下角往往正压着正文，
 *   铺一层实心热区会把那片文字的选择、链接点击、右键菜单一起吃掉。
 * ★ 点击后由宿主跑一段缓动回顶（见 utils/smoothScroll.ts），不是一下跳上去；
 *   过渡期间本节判据上锁，免得动画自己发的 scroll 事件把按钮又顶出来。
 * ★ 滚动宿主由宿主引擎用函数传进来（md 阅读态是 .read-scroll、分栏态是预览栏，
 *   .mh 是 .w-e-scroll 且要向下找），不在本组件里硬编码选择器——引擎 DOM 换代时
 *   只改引擎那一侧。函数返回 null 表示还没渲染好，这里逐帧重试到挂上为止。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowUp } from '@lucide/vue';

import { useI18n } from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';

const props = withDefaults(
  defineProps<{
    /** 取当前滚动宿主：返回 null 时组件会逐帧重试（引擎异步挂载的窗口期） */
    scroll: () => HTMLElement | null;
    /** 换个值即重挂监听：模式切换、换文档后滚动宿主是另一个节点 */
    bindKey?: string | number;
    /** 右下热区边长（px）：自适应档指针进入这个方块即浮出 */
    zone?: number;
  }>(),
  { bindKey: '', zone: 140 },
);
const emit = defineEmits<{ (e: 'top'): void }>();

const { t } = useI18n();
const settings = useSettingsStore();

/** 向下滚过这么多才值得给按钮：约一屏的 1/3，避免轻滚一下就冒出来 */
const SHOW_AFTER = 240;

const rootEl = ref<HTMLElement | null>(null);
const scrolled = ref(false);
const inZone = ref(false);

const enabled = computed(() => settings.settings.backTopEnabled !== false);
/** 缺字段的旧配置按自适应走（DEFAULT_SETTINGS 已兜底，这里再判一次空值） */
const isAuto = computed(() => settings.settings.backTopMode !== 'always');
const shown = computed(() => enabled.value && scrolled.value && (!isAuto.value || inZone.value));

let host: HTMLElement | null = null;
let scroller: HTMLElement | null = null;
let rafId = 0;
let tries = 0;
/** 回顶过渡期间锁住判据：点完这一下之后，过渡动画自己每帧写 scrollTop 会一直发 scroll，
 *  那几十毫秒里 scrollTop 还远在阈值之上——不解锁按钮就会"点完又冒出来"。
 *  动画到底（scrollTop 归零）立刻解锁；用户中途打断（滚动没归零）由超时兜底解锁 */
let locked = false;
let lockTimer: number | undefined;

function unlock(): void {
  locked = false;
  if (lockTimer) {
    window.clearTimeout(lockTimer);
    lockTimer = undefined;
  }
}

function onScroll(): void {
  if (locked) {
    if ((scroller?.scrollTop ?? 0) <= 1) unlock();
    return;
  }
  const on = (scroller?.scrollTop ?? 0) > SHOW_AFTER;
  if (on !== scrolled.value) scrolled.value = on;
}

function onPointerMove(e: PointerEvent): void {
  if (!host) return;
  const r = host.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const z = props.zone;
  const inside = e.clientX >= r.right - z && e.clientY >= r.bottom - z;
  if (inside !== inZone.value) inZone.value = inside;
}

function onPointerLeave(): void {
  if (inZone.value) inZone.value = false;
}

function detach(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  unlock();
  scroller?.removeEventListener('scroll', onScroll);
  host?.removeEventListener('pointermove', onPointerMove);
  host?.removeEventListener('pointerleave', onPointerLeave);
  scroller = null;
  host = null;
}

/** 尝试挂上监听；宿主/滚动节点任一没就绪就返回 false 交给重试 */
function attach(): boolean {
  host = (rootEl.value?.parentElement as HTMLElement | null) ?? null;
  scroller = props.scroll();
  if (!host || !scroller) return false;
  scroller.addEventListener('scroll', onScroll, { passive: true });
  /* pointermove 冒泡即可：热区判定只需要指针在宿主内的位置，不必捕获 */
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerleave', onPointerLeave);
  onScroll();
  return true;
}

function rebind(): void {
  detach();
  scrolled.value = false;
  inZone.value = false;
  tries = 0;
  const step = (): void => {
    rafId = 0;
    if (attach()) return;
    if (++tries > 90) return; // ≈1.5s 还等不到：放弃挂载，不拖住主线程
    rafId = requestAnimationFrame(step);
  };
  step();
}

onMounted(rebind);
onBeforeUnmount(detach);
watch(() => props.bindKey, rebind);
/** 关掉开关立即收起，不等下一次滚动事件 */
watch(enabled, (on) => {
  if (on) return;
  scrolled.value = false;
  inZone.value = false;
});

function onClick(): void {
  /* 先收起并上锁，再让宿主开始缓动：视觉上是"按一下就退场"，正文自己滑回去 */
  locked = true;
  scrolled.value = false;
  if (lockTimer) window.clearTimeout(lockTimer);
  lockTimer = window.setTimeout(() => {
    lockTimer = undefined;
    locked = false;
    onScroll();
  }, 900); // > 回顶动画上限 700ms：中途被打断也能自己解锁
  emit('top');
}
</script>

<template>
  <button
    ref="rootEl"
    type="button"
    class="mk-backtop"
    :class="{ on: shown }"
    :title="t('preview.backTop')"
    :aria-label="t('preview.backTop')"
    :aria-hidden="!shown"
    :tabindex="shown ? 0 : -1"
    @click="onClick"
  >
    <ArrowUp :size="16" />
  </button>
</template>

<style scoped>
/* 定位父级由引擎根承担（.engine-root / .wang-engine-root 的 position:relative），
   18px 的右偏移刚好让开正文滚动条（全局规格 10px）与大纲浮标的居中带 */
.mk-backtop {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 20;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  appearance: none;
  border: 1px solid var(--mk-border);
  border-radius: 50%;
  background: var(--mk-panel);
  color: var(--mk-fg-muted);
  box-shadow: 0 2px 10px rgb(0 0 0 / 12%);
  cursor: pointer;
  /* 收起态不参与命中：自适应档下这块区域平时完全还给正文 */
  opacity: 0;
  transform: translateY(8px) scale(0.92);
  pointer-events: none;
  transition: opacity 160ms ease, transform 160ms ease, color 120ms ease, border-color 120ms ease;
}
.mk-backtop.on {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
/* 码猫常驻右下（编辑器浮层位，right 22 / 宽 52）：回顶钮左移让开同一条竖线，
   两个圆钮并排而不叠成一坨。书桌页没有回顶钮，这条规则实际只在编辑器生效 */
html.pet-docked .mk-backtop {
  right: 84px;
}
.mk-backtop:hover,
.mk-backtop:focus-visible {
  color: var(--mk-accent);
  border-color: var(--mk-accent);
}
.mk-backtop:focus-visible {
  outline: var(--mk-focus-ring);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .mk-backtop {
    transition: none;
  }
}
</style>
