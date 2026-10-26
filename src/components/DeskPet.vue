<script setup lang="ts">
/**
 * 码猫本体：书桌右下角与编辑器右下角共用同一套表情/气泡/微动。
 *
 * 两个落位：
 *   desk  —— 欢迎书桌里，屁股贴在书桌区底边（宿主是 .desk，尺寸由父盒量出来）；
 *   float —— 编辑器里，fixed 贴窗口右下（状态栏之上），不参与编辑区布局。
 *
 * 八种情绪，其中 focus / think 没有单独原画，复用 idle 的脸靠姿态区分：
 *   idle 坐着 / greet 举爪 / happy 眯眼 / sleepy 打哈欠 / read 捧书 / alert 惊到
 *   focus 身体微侧、压住呼吸幅度；think 歪头（卡稿时）
 * 六张原图已由 scripts/gen-pet-faces.py 归一化到 240x294，切换时头脚不跳。
 *
 * 状态不落在本组件里：mood / 气泡 / 困倦与提醒计时全在 petStore，书桌与编辑器
 * 两个实例同时挂载也只有一份计时。本组件只负责 DOM、指针手势与右键菜单。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Check } from '@lucide/vue';
import { useI18n } from '../i18n';
import { useCtxMenu } from '../composables/useCtxMenu';
import { usePetStore, type PetMood, type PetTipsLevel } from '../stores/petStore';
import { useSettingsStore } from '../stores/settingsStore';
import eyesSrc from '../assets/mascot/pet-eyes.png';
import idleFace from '../assets/mascot/pet-face-idle.webp';
import happyFace from '../assets/mascot/pet-face-happy.webp';
import greetFace from '../assets/mascot/pet-face-greet.webp';
import sleepyFace from '../assets/mascot/pet-face-sleepy.webp';
import readFace from '../assets/mascot/pet-face-read.webp';
import alertFace from '../assets/mascot/pet-face-alert.webp';

const FACES: Record<PetMood, string> = {
  idle: idleFace,
  happy: happyFace,
  greet: greetFace,
  sleepy: sleepyFace,
  read: readFace,
  alert: alertFace,
  /* 专注/思考没有单独原画：借用 idle 的脸，用姿态与呼吸节奏区分 */
  focus: idleFace,
  think: idleFace,
};

const props = withDefaults(
  defineProps<{
    /** desk = 欢迎书桌（按父盒量坐标）；float = 编辑器浮层（fixed 贴右下） */
    placement?: 'desk' | 'float';
    /** 继续写作的文件名：书桌悬停气泡里点名 */
    continueName?: string;
    /** float 档离窗口底边的距离：等于状态栏高度，猫脚正好压在状态栏顶边上 */
    bottom?: number;
  }>(),
  { placement: 'desk', bottom: 24 },
);

const emit = defineEmits<{
  /** 书桌双击：继续上次的文件 */
  (e: 'continue'): void;
  /** 编辑区双击：阅读态回顶、写作态切专注模式（由 Workbench 决定） */
  (e: 'primary'): void;
  (e: 'action', action: 'focus' | 'top' | 'settings'): void;
}>();

const { t } = useI18n();
const settings = useSettingsStore();
const pet = usePetStore();

/** 归一化画布 240x294 */
const RATIO = 294 / 240;
/** 固定显示宽度：它是坐在状态栏上的装饰，尺寸不再做成选项 */
const PET_W = 52;
const PET_H = Math.round(PET_W * RATIO);

const rootRef = ref<HTMLElement | null>(null);
const hostW = ref(0);
const winW = ref(typeof window === 'undefined' ? 1280 : window.innerWidth);
const dockTop = ref(0);
const entered = ref(false);
const ready = ref(false);
const react = ref(false);

const petH = PET_H;
const visible = computed(() => {
  if (!settings.settings.petEnabled) return false;
  if (props.placement === 'float') return winW.value >= 640;
  return hostW.value >= 460;
});

const rootStyle = computed(() => ({
  '--pet-w': `${PET_W}px`,
  '--pet-h': `${petH}px`,
  '--pet-bottom': `${props.bottom}px`,
}));

const dockStyle = computed(() => (props.placement === 'desk' ? { top: `${dockTop.value}px` } : undefined));

const poseClass = computed(() => ({
  'is-focus': pet.mood === 'focus',
  'is-think': pet.mood === 'think',
  'is-read': pet.mood === 'read',
  'lean-down': pet.lean > 0,
  'lean-up': pet.lean < 0,
}));

const tipsLevel = computed<PetTipsLevel>(() => settings.settings.petTipsLevel ?? 'normal');
const LEVELS = computed<{ value: PetTipsLevel; label: string }[]>(() => [
  { value: 'quiet', label: t('pet.menu.levelQuiet') },
  { value: 'normal', label: t('pet.menu.levelNormal') },
  { value: 'chatty', label: t('pet.menu.levelChatty') },
]);

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---------------------------------------------------------------- 定位（仅书桌档）
let ro: ResizeObserver | null = null;

/** 屁股贴在书桌区最底边（= 应用状态栏上沿）。对齐的是底边，尺寸怎么变都落在同一条线上 */
function measure() {
  if (props.placement !== 'desk') return;
  const host = rootRef.value?.parentElement;
  if (!host) return;
  const hr = host.getBoundingClientRect();
  hostW.value = Math.round(hr.width);
  dockTop.value = Math.round(hr.height - petH);
}

function onWinResize() {
  winW.value = window.innerWidth;
  measure();
}

// ---------------------------------------------------------------- 入场 / 宿主挂载
/** 本实例是否真的挂上了 store：不可见时不能盲调 detachHost，否则会把另一个实例的宿主计数减掉 */
let attached = false;

function syncAttach(on: boolean) {
  if (on === attached) return;
  attached = on;
  if (on) pet.attachHost();
  else pet.detachHost();
}

watch(visible, syncAttach, { immediate: true });

// ---------------------------------------------------------------- 表情微动
let reactTimer = 0;
watch(
  () => pet.hopSeq,
  () => {
    react.value = false;
    requestAnimationFrame(() => {
      react.value = true;
      window.clearTimeout(reactTimer);
      reactTimer = window.setTimeout(() => (react.value = false), 620);
    });
  },
);

// ---------------------------------------------------------------- 指针手势
function onEnter() {
  if (!ready.value) return;
  pet.hover(props.continueName);
}

function onLeave() {
  if (!ready.value) return;
  clearLongPress();
  pet.leave();
}

function onClick(e: MouseEvent) {
  e.stopPropagation();
  if (!ready.value) return;
  if (longPressed) {
    longPressed = false;
    return;
  }
  pet.press();
}

function onDblClick(e: MouseEvent) {
  e.stopPropagation();
  if (!ready.value) return;
  if (props.placement === 'float') emit('primary');
  else emit('continue');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  if (!ready.value) return;
  pet.press();
}

/* 长按 = 呼噜：550ms 后触发，松手时把随后那次 click 吃掉 */
let pressTimer = 0;
let longPressed = false;

function clearLongPress() {
  window.clearTimeout(pressTimer);
  pressTimer = 0;
}

/** 长按后把指针拖出按钮再松手：按钮收不到 pointerup，得在这里把标记清掉，
 *  否则下一次正常点击会被 onClick 当成「长按的尾随 click」白吞一次 */
function onPointerLeave() {
  clearLongPress();
  longPressed = false;
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  longPressed = false;
  clearLongPress();
  pressTimer = window.setTimeout(() => {
    pressTimer = 0;
    longPressed = true;
    pet.longPress();
  }, 550);
}

function onPointerUp() {
  clearLongPress();
}

// ---------------------------------------------------------------- 右键菜单
const { menu, setMenuRef, open: openMenuAt, close: closeMenu } = useCtxMenu();

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  openMenuAt(e.clientX, e.clientY);
}

function openMenuAtPet() {
  const r = rootRef.value?.getBoundingClientRect();
  if (!r) return;
  openMenuAt(Math.max(8, r.right - 12), Math.max(8, r.bottom - petH));
}

function pick(level: PetTipsLevel) {
  closeMenu();
  void settings.update({ petTipsLevel: level });
}

function pickQuiet() {
  closeMenu();
  pet.toggleQuiet();
}

function pickScratch() {
  closeMenu();
  pet.longPress();
}

function pickAction(action: 'focus' | 'top' | 'settings') {
  closeMenu();
  emit('action', action);
}

function pickHide() {
  closeMenu();
  void settings.update({ petEnabled: false });
}

function onDocClick() {
  if (menu.value) closeMenu();
}

function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && menu.value) closeMenu();
}

// ---------------------------------------------------------------- 生命周期
onMounted(() => {
  if (props.placement === 'desk') {
    const host = rootRef.value?.parentElement;
    if (host && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure());
      ro.observe(host);
    }
  }
  measure();
  /* 首帧量到的常是布局落定前的值（字体、栅格列宽都还在变），后面也没有 resize 纠正 */
  requestAnimationFrame(() => {
    measure();
    requestAnimationFrame(measure);
  });
  window.setTimeout(measure, 240);

  requestAnimationFrame(() => {
    entered.value = true;
    window.setTimeout(() => (ready.value = true), reduceMotion ? 0 : 620);
  });

  window.addEventListener('resize', onWinResize);
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
});

onBeforeUnmount(() => {
  syncAttach(false);
  window.clearTimeout(reactTimer);
  clearLongPress();
  ro?.disconnect();
  ro = null;
  window.removeEventListener('resize', onWinResize);
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKey);
});
</script>

<template>
  <!-- 外层常驻：书桌档靠它量宿主（rootRef.parentElement），根节点一加 v-if 就永远测不到宽度 -->
  <div
    ref="rootRef"
    class="desk-pet"
    :class="{ 'is-float': placement === 'float' }"
    :style="rootStyle"
  >
    <div
      v-if="visible"
      class="pet-dock"
      :class="{ 'is-in': entered, 'is-float': placement === 'float' }"
      :style="dockStyle"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @contextmenu="onContextMenu"
    >
      <button
        type="button"
        class="pet-hit"
        :aria-label="t('pet.aria')"
        @click="onClick"
        @dblclick="onDblClick"
        @keydown="onKeydown"
        @keydown.shift.f10.prevent="openMenuAtPet"
        @pointerdown="onPointerDown"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
      >
        <div
          class="dock-body"
          :class="{
            'is-react': react,
            'is-resting': pet.mood === 'sleepy',
            'is-alert': pet.mood === 'alert',
            'is-typing': pet.mood === 'focus',
          }"
        >
          <div class="pet-pose" :class="poseClass">
            <div class="face-stack">
              <img
                v-for="(src, key) in FACES"
                :key="key"
                class="face"
                :class="{ on: pet.mood === key }"
                :src="src"
                alt=""
                draggable="false"
              />
              <!-- 眨眼只叠在 idle 系（idle / focus / think）：其余几张本来就是眯眼/闭眼/捧书 -->
              <img
                v-if="pet.mood === 'idle' || pet.mood === 'focus' || pet.mood === 'think'"
                class="pet-eyes"
                :src="eyesSrc"
                alt=""
                draggable="false"
              />
            </div>
          </div>
        </div>
      </button>

      <Transition name="mk-pet-bubble">
        <button
          v-if="pet.bubble"
          type="button"
          class="pet-bubble"
          :class="`kind-${pet.bubbleKind}`"
          role="status"
          aria-live="polite"
          @click.stop="pet.dismissBubble()"
        >
          <span class="bubble-dot" />
          {{ pet.bubble }}
        </button>
      </Transition>
    </div>

    <Teleport to="body">
      <div
        v-if="menu"
        :ref="setMenuRef"
        class="mk-menu pet-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @contextmenu.prevent
      >
        <div class="pet-menu-title">{{ t('pet.menu.title') }}</div>
        <button class="mk-menu-item" @click="pickScratch">
          <span class="menu-ico-space" />{{ t('pet.menu.pet') }}
        </button>
        <button class="mk-menu-item" @click="pickQuiet">
          <span class="menu-ico-space" />{{ pet.quietActive ? t('pet.menu.unquiet') : t('pet.menu.quiet') }}
        </button>
        <div class="mk-menu-sep" />
        <div class="pet-menu-label">{{ t('pet.menu.level') }}</div>
        <button
          v-for="lv in LEVELS"
          :key="lv.value"
          class="mk-menu-item pet-level"
          @click="pick(lv.value)"
        >
          <Check v-if="tipsLevel === lv.value" class="mk-menu-ico" />
          <span v-else class="menu-ico-space" />
          {{ lv.label }}
        </button>
        <template v-if="placement === 'float'">
          <div class="mk-menu-sep" />
          <button class="mk-menu-item" :disabled="!pet.context.hasDoc" @click="pickAction('focus')">
            <span class="menu-ico-space" />{{ t('pet.menu.focus') }}
          </button>
          <button class="mk-menu-item" :disabled="!pet.context.hasDoc" @click="pickAction('top')">
            <span class="menu-ico-space" />{{ t('pet.menu.top') }}
          </button>
        </template>
        <div class="mk-menu-sep" />
        <button class="mk-menu-item" @click="pickAction('settings')">
          <span class="menu-ico-space" />{{ t('pet.menu.settings') }}
        </button>
        <button class="mk-menu-item" @click="pickHide">
          <span class="menu-ico-space" />{{ t('pet.menu.hide') }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.desk-pet {
  position: absolute;
  inset: 0;
  z-index: 6; /* 压过卡片，低于应用菜单带 */
  pointer-events: none;
}
/* 编辑器浮层：不占流、不量父盒，只有一只猫那么大（气泡溢出可见） */
.desk-pet.is-float {
  position: fixed;
  inset: auto;
  right: 0;
  bottom: 0;
  width: 0;
  height: 0;
  z-index: var(--mk-z-pet);
}

.pet-dock {
  position: absolute;
  right: 22px;
  width: var(--pet-w);
  height: var(--pet-h);
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity 0.34s ease,
    transform 0.52s cubic-bezier(0.22, 1, 0.36, 1);
}
.pet-dock.is-in {
  opacity: 1;
  transform: translateY(0);
}
.pet-dock.is-float {
  position: fixed;
  right: 22px;
  bottom: var(--pet-bottom);
}
/* 交互语义挂在真按钮上（键盘/读屏）；这里只把原生按钮外观抹掉 */
.pet-hit {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 12px;
}
.pet-hit:focus-visible {
  outline: var(--mk-focus-ring);
  outline-offset: 4px;
}

/* 微动：呼吸 + 极慢的侧倾。做在外层，和表情切换互不干扰 */
.dock-body {
  position: relative;
  width: var(--pet-w);
  transform-origin: 50% 100%;
  /* 薄而深的接触阴影：软阴影拖得长会显得猫悬在地上 */
  filter: drop-shadow(0 2px 3px rgb(8 16 28 / 0.22));
  animation: pet-breathe 4.6s ease-in-out infinite;
}
@keyframes pet-breathe {
  0%, 100% { transform: translateY(0) rotate(0deg) scaleY(1); }
  30% { transform: translateY(-1.4px) rotate(-0.45deg) scaleY(1.012); }
  62% { transform: translateY(-0.3px) rotate(0.32deg) scaleY(1.002); }
}
/* 困了：呼吸放慢、幅度变小，像在那儿打盹 */
.dock-body.is-resting {
  animation-duration: 7.2s;
}
/* 打字时收住幅度：猫在旁边趴着，不抢注意力 */
.dock-body.is-typing {
  animation-duration: 6.8s;
}
.dock-body.is-react {
  animation: pet-hop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes pet-hop {
  0% { transform: translateY(0) scale(1, 1); }
  28% { transform: translateY(-9%) scale(0.97, 1.05); }
  58% { transform: translateY(0) scale(1.03, 0.96); }
  100% { transform: translateY(0) scale(1, 1); }
}
/* 警觉：保存失败这类坏消息，先抖一下再定格 */
.dock-body.is-alert {
  animation: pet-alert 0.56s cubic-bezier(0.36, 0.07, 0.19, 0.97);
}
@keyframes pet-alert {
  0%, 100% { transform: translateX(0); }
  18% { transform: translateX(-3px) rotate(-2deg); }
  38% { transform: translateX(3px) rotate(2deg); }
  58% { transform: translateX(-2px) rotate(-1.4deg); }
  78% { transform: translateX(1.5px) rotate(0.8deg); }
}

/* 姿态层：歪头/侧身/跟着阅读方向轻倾。和呼吸动画分开，互不覆盖 */
.pet-pose {
  transform-origin: 50% 100%;
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.pet-pose.is-focus {
  transform: rotate(-2.2deg) translateY(1px);
}
.pet-pose.is-think {
  transform: rotate(4.5deg);
}
.pet-pose.is-read {
  transform: rotate(-1deg) translateY(2px);
}
.pet-pose.is-read.lean-down {
  transform: rotate(-3.4deg) translateY(2px);
}
.pet-pose.is-read.lean-up {
  transform: rotate(1.6deg) translateY(1px);
}

/* 六张表情叠在一起交叉淡化：归一化过，头脚都不会跳 */
.face-stack {
  position: relative;
  width: 100%;
  aspect-ratio: 240 / 294;
}
.face {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0;
  transition: opacity 0.26s ease;
  pointer-events: none;
}
.face.on {
  opacity: 1;
}

.pet-eyes {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  opacity: 0;
  /* 5.2s 里只闭 130ms */
  animation: pet-blink 5.2s steps(1, end) infinite;
}
@keyframes pet-blink {
  0%, 92% { opacity: 0; }
  93%, 95.5% { opacity: 1; }
  96.5%, 100% { opacity: 0; }
}

/* ---------- 气泡 ---------- */
.pet-bubble {
  position: absolute;
  right: calc(100% - 6px);
  bottom: 62%;
  display: flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  /* 提示文案比台词长（最长一句约 24 字），必须允许折行；上限随窗口收窄，别顶出屏幕 */
  max-width: min(260px, calc(100vw - 120px));
  padding: 7px 11px 8px;
  border-radius: 10px;
  border: 1px solid var(--mk-border-strong);
  background: var(--mk-panel);
  color: var(--mk-fg);
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  box-shadow: 0 14px 30px -20px rgb(16 24 40 / 0.55);
  cursor: pointer;
}
.pet-bubble::after {
  content: '';
  position: absolute;
  right: -4px;
  bottom: 13px;
  width: 7px;
  height: 7px;
  border-right: 1px solid var(--mk-border-strong);
  border-top: 1px solid var(--mk-border-strong);
  background: var(--mk-panel);
  transform: rotate(45deg);
}
.pet-bubble:focus-visible {
  outline: var(--mk-focus-ring);
  outline-offset: 2px;
}
.bubble-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--desk-brand);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--desk-brand) 16%, transparent);
  flex: none;
}
.pet-bubble.kind-warn {
  border-color: color-mix(in srgb, var(--mk-warn) 55%, var(--mk-border-strong));
}
.pet-bubble.kind-warn .bubble-dot {
  background: var(--mk-warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--mk-warn) 18%, transparent);
}
.pet-bubble.kind-ok .bubble-dot {
  background: var(--mk-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--mk-accent) 16%, transparent);
}

.mk-pet-bubble-enter-active,
.mk-pet-bubble-leave-active {
  transition: opacity 0.24s ease, transform 0.24s ease;
}
.mk-pet-bubble-enter-from,
.mk-pet-bubble-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.97);
}

/* ---------- 右键菜单 ---------- */
.pet-menu {
  min-width: 176px;
}
.pet-menu-title,
.pet-menu-label {
  padding: 5px 10px 4px;
  font-size: 11px;
  color: var(--mk-fg-muted);
  letter-spacing: 0.02em;
}
.pet-menu-label {
  padding-top: 2px;
}
.menu-ico-space {
  width: 13px;
  height: 13px;
  flex: none;
}

@media (prefers-reduced-motion: reduce) {
  .pet-dock,
  .face,
  .pet-pose,
  .mk-pet-bubble-enter-active,
  .mk-pet-bubble-leave-active {
    transition: none;
  }
  .dock-body,
  .pet-eyes,
  .dock-body.is-react,
  .dock-body.is-alert {
    animation: none;
  }
}
</style>
