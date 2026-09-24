<script setup lang="ts">
/**
 * 全局浮动气泡提示（替代 CSS 伪元素方案）：
 * - 事件委托监听 [data-tip]，Teleport 到 body + position:fixed，不受任何 overflow 裁剪；
 * - 450ms 延迟淡入，划过不闪；移开/滚动/点击立即消失；
 * - 对齐策略：.win-btn 右对齐（贴窗右）、.tb-first / .row 左对齐（贴窗左/行首）、其余居中；
 *   最终统一做视口钳制，箭头始终指向宿主元素。
 */
import { onBeforeUnmount, onMounted, ref, nextTick, reactive } from 'vue';

const host = ref<HTMLElement | null>(null);
const st = reactive({ text: '', x: 0, y: 0, ax: 14, on: false });

let timer: number | undefined;
let currentEl: Element | null = null;
/** 最近一次悬停的鼠标位置（树行 .row 的气泡跟随光标，标准 tooltip 手感） */
let mx = 0;
let my = 0;

function hide() {
  if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  currentEl = null;
  st.on = false;
}

async function showFor(el: Element) {
  const text = el.getAttribute('data-tip') ?? '';
  if (!text) { hide(); return; }
  currentEl = el;
  if (timer !== undefined) clearTimeout(timer);
  timer = window.setTimeout(async () => {
    st.text = text;
    st.on = false; // 先以透明态渲染，量宽后再定位显示
    await nextTick();
    const bubble = host.value;
    if (!bubble || !currentEl) return;
    const r = currentEl.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const rightAlign = !!currentEl.closest('.win-btn');
    const leftAlign = !!currentEl.closest('.tb-first');
    // 树行/标签：气泡跟随光标右下角（这些元素横向较宽，锚元素会盖住邻近项、看起来像别人的提示）
    const followCursor = !!currentEl.closest('.row, .tab');
    let bx: number;
    let by: number;
    if (followCursor) {
      bx = mx + 14;
      by = my + 18;
    } else {
      bx = rightAlign ? r.right - bw : leftAlign ? r.left : r.left + r.width / 2 - bw / 2;
      by = r.bottom + 6;
      if (by + bh > window.innerHeight - 8) by = Math.max(8, r.top - bh - 6);
    }
    bx = Math.min(Math.max(8, bx), window.innerWidth - bw - 8);
    by = Math.min(Math.max(8, by), window.innerHeight - bh - 8);
    // 箭头水平位置：跟随宿主中心（光标模式跟随光标），钳制在气泡内（左右留 10px）
    const anchorX = followCursor ? mx : rightAlign ? r.right - 12 : r.left + r.width / 2;
    let ax = anchorX - bx;
    ax = Math.min(Math.max(10, ax), bw - 10);
    st.x = bx;
    st.y = by;
    st.ax = ax;
    st.on = true;
  }, 450);
}

function onOver(e: MouseEvent) {
  mx = e.clientX;
  my = e.clientY;
  const t = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
  if (t) {
    if (t !== currentEl) void showFor(t);
  } else if (currentEl) {
    hide();
  }
}
function onOut(e: MouseEvent) {
  if (!currentEl) return;
  const to = e.relatedTarget as Element | null;
  if (!to || !to.closest?.('[data-tip]') || !currentEl.contains(to)) hide();
}
/** 光标模式（树行）下气泡实时跟随；其余模式只记位置 */
function onMove(e: MouseEvent) {
  mx = e.clientX;
  my = e.clientY;
  if (st.on && currentEl?.closest('.row, .tab')) {
    const bubble = host.value;
    if (!bubble) return;
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let bx = Math.min(Math.max(8, mx + 14), window.innerWidth - bw - 8);
    let by = Math.min(Math.max(8, my + 18), window.innerHeight - bh - 8);
    st.x = bx;
    st.y = by;
    st.ax = Math.min(Math.max(10, mx - bx), bw - 10);
  }
}
function onDown() { hide(); }
function onScroll() {
  // 气泡是 fixed 定位不跟随滚动，任何滚动直接隐藏（capture 覆盖所有滚动容器）
  if (currentEl || st.on) hide();
}

onMounted(() => {
  document.addEventListener('mouseover', onOver);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseout', onOut);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', hide);
});
onBeforeUnmount(() => {
  document.removeEventListener('mouseover', onOver);
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseout', onOut);
  document.removeEventListener('mousedown', onDown, true);
  document.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('blur', hide);
  if (timer !== undefined) clearTimeout(timer);
});
</script>

<template>
  <Teleport to="body">
    <div ref="host" class="float-tip" :class="{ on: st.on }" :style="{ left: `${st.x}px`, top: `${st.y}px` }">
      <i class="ft-arrow" :style="{ left: `${st.ax}px` }" />
      <span class="ft-text">{{ st.text }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
.float-tip {
  position: fixed;
  z-index: 99999;
  width: max-content;
  max-width: 380px;
  padding: 6px 10px;
  background: var(--mk-tip-bg);
  color: var(--mk-tip-fg);
  font-size: 12px;
  line-height: 1.45;
  border-radius: 6px;
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.28);
  opacity: 0;
  transition: opacity 0.12s ease;
  pointer-events: none;
}
.float-tip.on { opacity: 1; }
/* 箭头：border 三角，底边与气泡上缘同基准（top:-5px + 高5px = 上缘），无缝 */
.ft-arrow {
  position: absolute;
  top: -5px;
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-top-width: 0;
  border-bottom-color: var(--mk-tip-bg);
}
.ft-text { display: block; }
</style>
