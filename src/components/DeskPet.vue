<script setup lang="ts">
/**
 * 书桌右下角的常驻码猫。
 *
 * 四种表情原图交叉淡化 + CSS 微动（业界"3~5 张表情图"那一档）：
 *   idle  睁眼坐着，默认态，叠一层眨眼
 *   greet 举爪打招呼，指针移上来时切
 *   happy 眯眼笑，点一下切
 *   sleepy 打哈欠闭眼，长时间没操作时切
 *
 * 四张图已由 scripts/gen-pet-faces.py 归一化到 240x294（头顶到脚底等高、底边对齐、水平居中），
 * 所以切换时头和脚不会跳。微动做在外层容器上，不参与表情切换。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settingsStore';
import eyesSrc from '../assets/mascot/pet-eyes.png';
import idleFace from '../assets/mascot/pet-face-idle.webp';
import happyFace from '../assets/mascot/pet-face-happy.webp';
import greetFace from '../assets/mascot/pet-face-greet.webp';
import sleepyFace from '../assets/mascot/pet-face-sleepy.webp';

type Mood = 'idle' | 'happy' | 'greet' | 'sleepy';

const FACES: Record<Mood, string> = {
  idle: idleFace,
  happy: happyFace,
  greet: greetFace,
  sleepy: sleepyFace,
};

const props = defineProps<{
  /** 继续写作的文件名：悬停气泡里点名 */
  continueName?: string;
}>();

const emit = defineEmits<{
  (e: 'continue'): void;
}>();

const { t, tList } = useI18n();
const settings = useSettingsStore();

/** 归一化画布 240x294 */
const RATIO = 294 / 240;
/** 固定显示宽度：它是坐在状态栏上的装饰，尺寸不再做成选项 */
const PET_W = 52;
/** 空闲多久切"困了"：半分钟没动就打哈欠 */
const NAP_AFTER = 30_000;

const rootRef = ref<HTMLElement | null>(null);
const hostW = ref(0);
const dockTop = ref(0);
const entered = ref(false);
const ready = ref(false);
const bubble = ref('');
const react = ref(false);
const mood = ref<Mood>('idle');

const petH = Math.round(PET_W * RATIO);
const visible = computed(() => settings.settings.petEnabled && hostW.value >= 460);

const rootStyle = {
  '--pet-w': `${PET_W}px`,
  '--pet-h': `${petH}px`,
};

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---------------------------------------------------------------- 定位
let ro: ResizeObserver | null = null;

/** 屁股贴在书桌区最底边（= 应用状态栏上沿）。对齐的是底边，尺寸怎么变都落在同一条线上 */
function measure() {
  const host = rootRef.value?.parentElement;
  if (!host) return;
  const hr = host.getBoundingClientRect();
  hostW.value = Math.round(hr.width);
  dockTop.value = Math.round(hr.height - petH);
}

// ---------------------------------------------------------------- 状态
let backTimer = 0;
let napTimer = 0;
let sayTimer = 0;

function backToIdleAfter(ms: number) {
  window.clearTimeout(backTimer);
  backTimer = window.setTimeout(() => {
    if (mood.value !== 'sleepy') mood.value = 'idle';
  }, ms);
}

function setMood(next: Mood, backMs?: number) {
  mood.value = next;
  if (backMs) backToIdleAfter(backMs);
  else window.clearTimeout(backTimer);
}

function resetNap() {
  window.clearTimeout(napTimer);
  if (!visible.value || document.hidden) return;
  napTimer = window.setTimeout(() => {
    if (mood.value === 'idle') mood.value = 'sleepy';
  }, NAP_AFTER);
}

// ---------------- 定时提醒 ----------------
/**
 * 普通提醒半小时一次，**锚点定在每小时的 :01 和 :31**（避开整点——整点常撞会议/系统通知）。
 * 12:00 饭点、17:30 下班是精确时刻，单独排在网格上。
 * 用 setTimeout 直接排到下一个时间戳，不用 setInterval 轮询（后台标签会被节流成分钟粒度）。
 */
type SlotKind = 'half' | 'lunch' | 'offwork';
interface Slot {
  at: number;
  kind: SlotKind;
}

/** 普通提醒的分钟锚点 */
const HALF_ANCHORS = [1, 31];

const HOUR_LINES = computed(() => tList('pet.reminds'));
const LUNCH_LINES = computed(() => tList('pet.lunch'));
const OFFWORK_LINES = computed(() => tList('pet.offwork'));
let remindTimer = 0;
/** 上一次真正弹出去的时间：饭点和紧随其后的 :01 只差一分钟，靠它压掉重复 */
let lastFireAt = 0;

function nextSlot(from: number): Slot {
  const todayAt = (h: number, m: number) => {
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const hourStart = new Date(from);
  hourStart.setMinutes(0, 0, 0);
  const base = hourStart.getTime();
  // 本小时的 :01 / :31，都过了就落到下一小时的 :01
  const half = HALF_ANCHORS.map((m) => base + m * 60_000).find((t) => t > from) ?? base + 3_600_000 + 60_000;

  const slots: Slot[] = [{ at: half, kind: 'half' }];
  const lunch = todayAt(12, 0);
  const off = todayAt(17, 30);
  if (lunch > from) slots.push({ at: lunch, kind: 'lunch' });
  if (off > from) slots.push({ at: off, kind: 'offwork' });

  // 同一时刻撞上时具体事件优先（例如 12:00 与 12:01 挨得太近，先让饭点排上）
  slots.sort((a, b) => a.at - b.at || (a.kind === 'half' ? 1 : -1));
  return slots[0];
}

function pickOne(list: string[], fallback: string): string {
  return list.length ? list[Math.floor(Math.random() * list.length)] : fallback;
}

function fireSlot(kind: SlotKind) {
  if (!visible.value || document.hidden) return;
  // 饭点 12:00 弹完，12:01 那一轮普通提醒不重复弹（两条相隔一分钟，会像卡了）
  if (Date.now() - lastFireAt < 90_000) return;
  lastFireAt = Date.now();
  const fallback = t('pet.deskGreet');
  const text =
    kind === 'lunch'
      ? pickOne(LUNCH_LINES.value, fallback)
      : kind === 'offwork'
        ? pickOne(OFFWORK_LINES.value, fallback)
        : pickOne(HOUR_LINES.value, fallback);
  say(text, 9000);
  setMood('greet', 3800);
}

function scheduleRemind() {
  window.clearTimeout(remindTimer);
  const now = Date.now();
  const slot = nextSlot(now);
  remindTimer = window.setTimeout(() => {
    try {
      // 系统休眠/唤醒回来时可能晚很多，那一条就作废，别补一发过期的
      if (Date.now() - slot.at < 120_000) fireSlot(slot.kind);
    } finally {
      scheduleRemind();
    }
  }, Math.max(1000, slot.at - now));
}

function say(text: string, ms = 2400) {
  bubble.value = text;
  window.clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => {
    if (bubble.value === text) bubble.value = '';
  }, ms);
}

// ---------------------------------------------------------------- 交互
const LINES = computed(() => {
  const list = tList('pet.lines');
  return list.length ? list : [t('pet.deskGreet')];
});

function onEnter() {
  if (!ready.value) return;
  // 悬停优先：取消待执行的"回 idle"，否则 hover 手势会被上一轮的计时器打断
  window.clearTimeout(backTimer);
  resetNap();
  if (mood.value !== 'happy') setMood('greet');
  const name = props.continueName;
  if (name) {
    const short = name.length > 16 ? `${name.slice(0, 15)}…` : name;
    say(t('pet.backTo', { name: short }), 4200);
  } else {
    say(t('pet.deskGreet'), 4200);
  }
}

function onLeave() {
  if (mood.value === 'happy') {
    // 点完的开心表情让它再走 0.6s 才收，立刻切 idle 会像闪了一下
    backToIdleAfter(600);
    return;
  }
  setMood('idle');
  bubble.value = '';
}

/** 随机取一句，但不连着两次同一句——38 条的池子里连中两次会显得像坏了 */
let lastLineIdx = -1;
function pickLine(): string {
  const list = LINES.value;
  if (!list.length) return t('pet.deskGreet');
  if (list.length === 1) return list[0];
  let i = Math.floor(Math.random() * list.length);
  if (i === lastLineIdx) i = (i + 1) % list.length;
  lastLineIdx = i;
  return list[i];
}

let reactTimer = 0;
function onClick(e: MouseEvent) {
  e.stopPropagation();
  if (!ready.value) return;
  resetNap();
  setMood('happy', 2200);
  react.value = false;
  requestAnimationFrame(() => {
    react.value = true;
    window.clearTimeout(reactTimer);
    reactTimer = window.setTimeout(() => (react.value = false), 620);
  });
  say(pickLine(), 4200);
}

function onDblClick(e: MouseEvent) {
  e.stopPropagation();
  emit('continue');
}

/** 任何点击都算"人还在"，从困倦里醒过来 */
function onDocDown() {
  if (mood.value === 'sleepy') mood.value = 'idle';
  resetNap();
}

function onVisibility() {
  if (document.hidden) window.clearTimeout(napTimer);
  else resetNap();
}

// ---------------------------------------------------------------- 生命周期
onMounted(() => {
  const host = rootRef.value?.parentElement;
  if (host) {
    ro = new ResizeObserver(() => measure());
    ro.observe(host);
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

  window.addEventListener('resize', measure);
  window.addEventListener('pointerdown', onDocDown, true);
  // 滚轮也算"人在"：只监听点击的话，专心读文档不点鼠标，30 秒就会被打哈欠
  window.addEventListener('wheel', resetNap, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  resetNap();
  scheduleRemind();
});

onBeforeUnmount(() => {
  window.clearTimeout(backTimer);
  window.clearTimeout(napTimer);
  window.clearTimeout(sayTimer);
  window.clearTimeout(reactTimer);
  window.clearTimeout(remindTimer);
  ro?.disconnect();
  ro = null;
  window.removeEventListener('resize', measure);
  window.removeEventListener('pointerdown', onDocDown, true);
  window.removeEventListener('wheel', resetNap, true);
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<template>
  <!-- 外层常驻：宿主宽度靠它量（rootRef.parentElement），根节点一加 v-if 就永远测不到宽度 -->
  <div ref="rootRef" class="desk-pet" :style="rootStyle" aria-hidden="true">
    <div
      v-if="visible"
      class="pet-dock"
      :class="{ 'is-in': entered }"
      :style="{ top: `${dockTop}px` }"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @click="onClick"
      @dblclick="onDblClick"
    >
      <div class="dock-body" :class="{ 'is-react': react, 'is-resting': mood === 'sleepy' }">
        <div class="face-stack">
          <img
            v-for="(src, key) in FACES"
            :key="key"
            class="face"
            :class="{ on: mood === key }"
            :src="src"
            alt=""
            draggable="false"
          />
          <!-- 眨眼只叠在 idle 上：另外三张本来就是眯眼/闭眼 -->
          <img v-if="mood === 'idle'" class="pet-eyes" :src="eyesSrc" alt="" draggable="false" />
        </div>
      </div>

      <Transition name="mk-pet-bubble">
        <div v-if="bubble" class="pet-bubble">
          <span class="bubble-dot" />
          {{ bubble }}
        </div>
      </Transition>
    </div>

  </div>
</template>

<style scoped>
.desk-pet {
  position: absolute;
  inset: 0;
  z-index: 6; /* 压过卡片，低于应用菜单带 */
  pointer-events: none;
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
.dock-body.is-react {
  animation: pet-hop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes pet-hop {
  0% { transform: translateY(0) scale(1, 1); }
  28% { transform: translateY(-9%) scale(0.97, 1.05); }
  58% { transform: translateY(0) scale(1.03, 0.96); }
  100% { transform: translateY(0) scale(1, 1); }
}

/* 四张表情叠在一起交叉淡化：归一化过，头脚都不会跳 */
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
  padding: 7px 11px 8px;
  border-radius: 10px;
  border: 1px solid var(--mk-border-strong);
  background: var(--mk-panel);
  color: var(--mk-fg);
  font-size: 12px;
  line-height: 1.4;
  /* 不折行：折过之后一句 17 字的吐槽被切成两截，读起来断气。
     宽度交给内容自己决定，最长一句 17 字 ≈ 226px，窗口最窄 460 也放得下 */
  white-space: nowrap;
  box-shadow: 0 14px 30px -20px rgb(16 24 40 / 0.55);
  pointer-events: none;
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
.bubble-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--desk-brand);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--desk-brand) 16%, transparent);
  flex: none;
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

@media (prefers-reduced-motion: reduce) {
  .pet-dock,
  .face,
  .mk-pet-bubble-enter-active,
  .mk-pet-bubble-leave-active {
    transition: none;
  }
  .dock-body,
  .pet-eyes,
  .dock-body.is-react {
    animation: none;
  }
}
</style>
