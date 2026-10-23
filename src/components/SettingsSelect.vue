<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { Check, ChevronDown } from '@lucide/vue';

export type SelectOption = { value: string; label: string };

const props = defineProps<{
  modelValue: string;
  options: SelectOption[];
  ariaLabel?: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const open = ref(false);
const positioned = ref(false);
const activeIndex = ref(0);
const pos = ref({ top: 0, left: 0, width: 200 });

const currentLabel = computed(
  () => props.options.find((opt) => opt.value === props.modelValue)?.label ?? props.modelValue,
);

function isSelected(opt: SelectOption) {
  return opt.value === props.modelValue;
}

function close(refocus = true) {
  if (!open.value) return;
  open.value = false;
  activeIndex.value = 0;
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
  window.removeEventListener('resize', place);
  document.removeEventListener('scroll', onDocScroll, true);
  if (refocus) void nextTick(() => triggerRef.value?.focus());
}

function choose(opt: SelectOption) {
  if (opt.value !== props.modelValue) emit('update:modelValue', opt.value);
  close();
}

/** 默认与触发钮同宽，只有长选项才适度加宽；超长文案截断，悬停 title 看全文 */
function measureWidth(triggerWidth: number): number {
  let maxLabel = 0;
  panelRef.value?.querySelectorAll<HTMLElement>('.mk-select-opt-label').forEach((el) => {
    maxLabel = Math.max(maxLabel, el.scrollWidth);
  });
  /* 64 = 面板左右内边距 16 + 选项左右内边距 16 + 勾选图标与间距 22 + 滚动条余量 */
  return Math.max(triggerWidth, Math.min(320, Math.ceil(maxLabel) + 64));
}

async function place() {
  const rect = triggerRef.value?.getBoundingClientRect();
  if (!rect) return;
  const width = measureWidth(rect.width);
  const height = panelRef.value?.offsetHeight ?? 300;
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8 && rect.top - 4 - height >= 8) {
    top = rect.top - 4 - height;
  }
  /* 右对齐触发钮：下拉在设置面板右列，左对齐会顶出面板右缘 */
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  /* 位置没变就别写（新对象必触发一次面板重渲） */
  if (pos.value.top !== top || pos.value.left !== left || pos.value.width !== width) {
    pos.value = { top, left, width };
  }
  positioned.value = true;
}

/** 列表自己的滚动不参与定位：否则滚动每一帧都会读布局、写响应式 */
function onDocScroll(e: Event) {
  const target = e.target as Node | null;
  if (target && panelRef.value?.contains(target)) return;
  void place();
}

function setActive(i: number) {
  activeIndex.value = i;
  void nextTick(() => {
    listRef.value?.querySelector<HTMLElement>(`[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });
}

/** 打开时把当前选中项滚进视野并设为键盘起点 */
function revealSelected() {
  const idx = props.options.findIndex((opt) => isSelected(opt));
  if (idx < 0) {
    activeIndex.value = 0;
    return;
  }
  activeIndex.value = idx;
  void nextTick(() => {
    listRef.value?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'center' });
  });
}

async function show() {
  if (open.value) return;
  open.value = true;
  positioned.value = false;
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('resize', place);
  document.addEventListener('scroll', onDocScroll, true);
  await nextTick();
  await place();
  if (!open.value) return;
  listRef.value?.focus({ preventScroll: true });
  revealSelected();
}

function toggle() {
  if (open.value) close();
  else void show();
}

/** Esc 要在捕获阶段截住：设置面板自己在 document 上监听 Esc 关闭面板 */
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  close();
}

function onDocPointerDown(e: PointerEvent) {
  const target = e.target as Node | null;
  if (!target) return;
  if (panelRef.value?.contains(target) || triggerRef.value?.contains(target)) return;
  close(false);
}

function move(delta: number) {
  const count = props.options.length;
  if (!count) return;
  setActive((activeIndex.value + delta + count) % count);
}

function onListKeydown(e: KeyboardEvent) {
  /* 中文/日文输入法组词期间的回车与方向键属于候选框，不拿来选项 */
  if (e.isComposing) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    setActive(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    setActive(props.options.length - 1);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const opt = props.options[activeIndex.value];
    if (opt) choose(opt);
  } else if (e.key === 'Tab') {
    close(false);
  }
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
  window.removeEventListener('resize', place);
  document.removeEventListener('scroll', onDocScroll, true);
});
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="mk-select-trigger"
    aria-haspopup="listbox"
    :aria-label="ariaLabel"
    :aria-expanded="open"
    :title="currentLabel"
    @click="toggle"
    @keydown.down.prevent="show"
    @keydown.up.prevent="show"
  >
    <span class="mk-select-trigger-label">{{ currentLabel }}</span>
    <ChevronDown :size="14" class="mk-select-chev" />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="panelRef"
      class="mk-select-panel"
      :class="{ ready: positioned }"
      :style="{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${pos.width}px` }"
    >
      <ul
        ref="listRef"
        class="mk-select-list"
        role="listbox"
        tabindex="-1"
        :aria-label="ariaLabel"
        @keydown="onListKeydown"
      >
        <li
          v-for="(opt, i) in options"
          :key="opt.value"
          class="mk-select-opt"
          :class="{ active: i === activeIndex }"
          role="option"
          :aria-selected="isSelected(opt)"
          :data-idx="i"
          @mousemove="activeIndex = i"
          @mousedown.prevent
          @click="choose(opt)"
        >
          <span class="mk-select-opt-label" :title="opt.label">{{ opt.label }}</span>
          <Check v-if="isSelected(opt)" :size="14" class="mk-select-check" />
        </li>
      </ul>
    </div>
  </Teleport>
</template>
