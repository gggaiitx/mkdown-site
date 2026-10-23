<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Check, ChevronDown } from '@lucide/vue';
import { useI18n } from '../i18n';
import {
  DEFAULT_APP_FONT_FAMILY,
  DEFAULT_FONT_VALUE,
  SYSTEM_UI_FONT_FAMILY,
  fontStackForName,
  loadSystemFonts,
  normalizeFontInput,
  readableFontFamily,
  resolveFontFamily,
} from '../utils/fontFamily';

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();
const { t } = useI18n();

type FontOption = { key: string; label: string; value: string; css: string };

const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);

const open = ref(false);
const positioned = ref(false);
const loading = ref(false);
const systemFonts = ref<string[]>([]);
const query = ref('');
const activeIndex = ref(0);
const pos = ref({ top: 0, left: 0, width: 200 });

const currentCss = computed(() => resolveFontFamily(props.modelValue).css);
const currentLabel = computed(() => {
  const value = props.modelValue.trim();
  if (!value) return t('settings.fontDefault');
  if (value === SYSTEM_UI_FONT_FAMILY) return t('settings.fontSystem');
  return readableFontFamily(value);
});

const loweredQuery = computed(() => query.value.trim().toLowerCase());

/** 无搜索词时才置顶的固定项：应用默认 / 系统默认 / 当前值（自定义字体不在系统列表时） */
const pinnedOptions = computed<FontOption[]>(() => {
  if (loweredQuery.value) return [];
  const pinned: FontOption[] = [
    {
      key: 'default',
      label: t('settings.fontDefault'),
      value: DEFAULT_FONT_VALUE,
      css: DEFAULT_APP_FONT_FAMILY,
    },
    {
      key: 'system',
      label: t('settings.fontSystem'),
      value: SYSTEM_UI_FONT_FAMILY,
      css: SYSTEM_UI_FONT_FAMILY,
    },
  ];
  const value = props.modelValue.trim();
  if (value && value !== SYSTEM_UI_FONT_FAMILY) {
    const fromSystemList = systemFonts.value.some((name) => fontStackForName(name) === value);
    if (!fromSystemList) {
      pinned.push({ key: 'current', label: readableFontFamily(value), value, css: value });
    }
  }
  return pinned;
});

const systemOptions = computed<FontOption[]>(() =>
  systemFonts.value
    .filter((name) => !loweredQuery.value || name.toLowerCase().includes(loweredQuery.value))
    .map((name) => {
      const stack = fontStackForName(name);
      return { key: `font:${name}`, label: name, value: stack, css: stack };
    }),
);

const baseOptions = computed<FontOption[]>(() => [...pinnedOptions.value, ...systemOptions.value]);

/** 搜索词可落成「自定义字体」入口：未命中已有项时才出现（照 DBX 的 allow-custom 口径） */
const customOption = computed<FontOption | null>(() => {
  const raw = query.value.trim();
  if (!raw) return null;
  const normalized = normalizeFontInput(raw);
  const hit = baseOptions.value.some(
    (opt) => opt.value === normalized || opt.label.toLowerCase() === raw.toLowerCase(),
  );
  if (hit) return null;
  return {
    key: 'custom',
    label: t('settings.fontUseCustom', { font: readableFontFamily(normalized) }),
    value: normalized,
    css: normalized,
  };
});

const options = computed<FontOption[]>(() => {
  const list = baseOptions.value;
  return customOption.value ? [...list, customOption.value] : list;
});
const pinnedCount = computed(() => pinnedOptions.value.length);

function isSelected(opt: FontOption): boolean {
  return opt.value === props.modelValue.trim();
}

function close(refocus = true) {
  if (!open.value) return;
  open.value = false;
  query.value = '';
  activeIndex.value = 0;
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
  window.removeEventListener('resize', place);
  document.removeEventListener('scroll', onDocScroll, true);
  if (refocus) void nextTick(() => triggerRef.value?.focus());
}

function choose(opt: FontOption) {
  emit('update:modelValue', opt.value);
  close();
}

async function place() {
  const rect = triggerRef.value?.getBoundingClientRect();
  if (!rect) return;
  const width = rect.width;
  const height = panelRef.value?.offsetHeight ?? 300;
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8 && rect.top - 4 - height >= 8) {
    top = rect.top - 4 - height;
  }
  /* 与通用下拉同一规则：右缘对齐触发钮，避免顶出设置面板 */
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  /* 位置没变就别写（新对象必触发一次面板重渲）：展开/收起列表时高度不变，只有外部滚动才真的挪 */
  if (pos.value.top !== top || pos.value.left !== left || pos.value.width !== width) {
    pos.value = { top, left, width };
  }
  positioned.value = true;
}

/** 字体列表自己的滚动不参与定位：否则滚动每一帧都会读布局、写响应式 */
function onDocScroll(e: Event) {
  const target = e.target as Node | null;
  if (target && panelRef.value?.contains(target)) return;
  void place();
}

/** 打开时把当前选中项滚进视野：字体列表可能几百项，选中的常在字母序中段 */
function revealSelected() {
  const idx = options.value.findIndex((opt) => isSelected(opt));
  if (idx < 0) return;
  activeIndex.value = idx;
  void nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    el?.scrollIntoView({ block: 'center' });
  });
}

async function show() {
  open.value = true;
  positioned.value = false;
  query.value = '';
  activeIndex.value = 0;
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('resize', place);
  document.addEventListener('scroll', onDocScroll, true);

  loading.value = systemFonts.value.length === 0;
  await nextTick();
  await place();
  if (!open.value) return;
  searchRef.value?.focus();
  revealSelected();

  if (loading.value) {
    const fonts = await loadSystemFonts();
    if (!open.value) return;
    systemFonts.value = fonts;
    loading.value = false;
    await nextTick();
    await place();
    revealSelected();
  }
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
  const count = options.value.length;
  if (!count) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
  void nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-idx="${activeIndex.value}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  });
}

function onSearchKeydown(e: KeyboardEvent) {
  /* 中文/日文输入法组词期间的回车与方向键属于候选框，不能拿来选项 */
  if (e.isComposing) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const opt = options.value[activeIndex.value];
    if (opt) choose(opt);
  } else if (e.key === 'Tab') {
    close(false);
  }
}

watch(query, () => {
  activeIndex.value = 0;
});

watch(options, () => {
  if (activeIndex.value >= options.value.length) activeIndex.value = 0;
  if (open.value) void nextTick(place);
});

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
    :aria-label="t('settings.fontFamily')"
    :aria-expanded="open"
    :title="currentLabel"
    @click="toggle"
  >
    <span class="mk-select-trigger-label" :style="{ fontFamily: currentCss }">{{ currentLabel }}</span>
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
      <input
        ref="searchRef"
        v-model="query"
        class="font-search"
        type="text"
        role="combobox"
        aria-controls="mk-font-list"
        aria-autocomplete="list"
        :aria-expanded="true"
        :placeholder="t('settings.fontSearch')"
        :aria-label="t('settings.fontSearch')"
        @keydown="onSearchKeydown"
      />
      <div v-if="loading" class="mk-select-state">{{ t('settings.fontLoading') }}</div>
      <ul v-else id="mk-font-list" ref="listRef" class="mk-select-list" role="listbox">
        <template v-for="(opt, i) in options" :key="opt.key">
          <li
            v-if="i === pinnedCount && pinnedCount > 0 && !loweredQuery"
            class="mk-select-divider"
            aria-hidden="true"
          />
          <li
            v-if="customOption && i === options.length - 1"
            class="mk-select-divider"
            aria-hidden="true"
          />
          <li
            class="mk-select-opt"
            :class="{ active: i === activeIndex }"
            role="option"
            :aria-selected="isSelected(opt)"
            :data-idx="i"
            @mousemove="activeIndex = i"
            @mousedown.prevent
            @click="choose(opt)"
          >
            <span class="mk-select-opt-label" :style="{ fontFamily: opt.css }" :title="opt.label">{{ opt.label }}</span>
            <Check v-if="isSelected(opt)" :size="14" class="mk-select-check" />
          </li>
        </template>
        <li v-if="!options.length" class="mk-select-state">{{ t('settings.fontNoMatch') }}</li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped>
/* 触发钮 / 弹层 / 选项 / 勾选 / 分隔线 / 空态走 global.css 的 .mk-select-* 一套规格；
   这里只留字体选择器独有的搜索框。 */
.font-search {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--mk-border); border-radius: 6px;
  background: var(--mk-bg); color: var(--mk-fg);
  font-size: 13px;
  outline: none;
}
.font-search:focus { border-color: var(--mk-border-strong); }
</style>
