<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from '../i18n';
import { useDialogClose } from '../composables/useDialogClose';

const { t } = useI18n();
const { maskCloses } = useDialogClose();

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    /** 输入模式：显示输入框并返回文本 */
    input?: boolean;
    inputValue?: string;
    placeholder?: string;
  }>(),
  // confirmText/cancelText 不给静态默认值，由模板回退到 t('dialog.*')，切换语言后按钮文字可响应式更新
  { message: '', danger: false, input: false, inputValue: '', placeholder: '' },
);

const emit = defineEmits<{
  (e: 'confirm', value: string): void;
  (e: 'cancel'): void;
}>();

// 键入只更新本地值；confirm 仅由 Enter / 确定按钮触发（此前 @input 直接 emit confirm 会导致每敲一个字就提交一次）
const val = ref(props.inputValue);
watch(
  () => props.visible,
  (v) => {
    if (v) val.value = props.inputValue;
  },
);

/* ---- 键盘路径 ----
   此前 @keydown 挂在 .mask 上，而 .mask 不可聚焦、也没有焦点管理：
   非输入框的确认框（删除文件、丢弃改动…）打开后焦点仍留在遮罩后面的调用处，
   Esc 的冒泡路径根本不经过 .mask → 键盘关不掉，Tab 还会跑到遮罩背后。
   现在：可见期间监听 document 按键，打开时把焦点收进对话框，关闭后还给调用处。 */
const titleId = useId();
const dialogRef = ref<HTMLElement | null>(null);
let restoreFocusTo: HTMLElement | null = null;

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      restoreFocusTo = document.activeElement as HTMLElement | null;
      document.addEventListener('keydown', onKey, true);
      await nextTick();
      const first = dialogRef.value?.querySelector<HTMLElement>('.ipt');
      (first ?? dialogRef.value)?.focus();
    } else {
      document.removeEventListener('keydown', onKey, true);
      restoreFocusTo?.focus?.();
      restoreFocusTo = null;
    }
  },
);
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('cancel');
  } else if (e.key === 'Enter' && props.input) {
    // 焦点在按钮上时交给按钮自己处理，否则一次回车会同时触发按钮与提交
    if (document.activeElement instanceof HTMLButtonElement) return;
    emit('confirm', val.value);
  } else if (e.key === 'Tab') {
    trapTab(e);
  }
}

/** 最小焦点陷阱：Tab 在对话框内首尾循环，不跑到遮罩背后 */
function trapTab(e: KeyboardEvent) {
  const items = dialogRef.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  );
  if (!items?.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dialogRef.value)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function submit() {
  emit('confirm', val.value);
}

function onMaskClick() {
  if (maskCloses()) emit('cancel');
}
</script>

<template>
  <div v-if="visible" class="mask" @click.self="onMaskClick">
    <div ref="dialogRef" class="dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
      <div class="head">
        <div class="title" :id="titleId">{{ title }}</div>
        <button class="close" :title="t('dialog.close')" :aria-label="t('dialog.close')" @click="emit('cancel')">×</button>
      </div>
      <div class="body">
        <p v-if="message" class="msg">{{ message }}</p>
        <input
          v-if="input"
          class="ipt"
          v-model="val"
          :placeholder="placeholder"
          autofocus
        />
        <slot />
      </div>
      <div class="actions">
        <button class="btn" @click="emit('cancel')">{{ cancelText || t('dialog.cancel') }}</button>
        <button class="btn" :class="danger ? 'danger' : 'primary'" @click="submit">
          {{ confirmText || t('dialog.confirm') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--mk-z-dialog);
  background: var(--mk-mask);
  display: flex; align-items: center; justify-content: center;
}
.dialog {
  width: 380px; max-width: 90vw;
  background: var(--mk-panel); color: var(--mk-fg);
  border: 1px solid var(--mk-border); border-radius: 10px;
  box-shadow: var(--mk-shadow-dialog);
  padding: 16px;
}
/* 容器只是键盘落点（tabindex="-1"），不需要整框焦点环 */
.dialog:focus { outline: none; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.title { font-size: 14px; font-weight: 600; min-width: 0; }
.close {
  flex: none; margin: -2px -2px 0 0; padding: 0 2px;
  border: none; background: transparent; color: var(--mk-fg-muted);
  font-size: 18px; line-height: 1; cursor: pointer;
}
.close:hover { color: var(--mk-fg); }
.msg { font-size: 13px; line-height: 1.6; margin: 0 0 8px; color: var(--mk-fg); overflow-wrap: anywhere; }
.ipt {
  width: 100%; box-sizing: border-box;
  border: 1px solid var(--mk-border); border-radius: 6px;
  background: var(--mk-bg); color: var(--mk-fg);
  padding: 6px 10px; font-size: 13px; outline: none;
}
.ipt:focus { border-color: var(--mk-accent); }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.btn {
  min-width: 72px;
  border: 1px solid var(--mk-border); background: var(--mk-bg); color: var(--mk-fg);
  border-radius: 6px; padding: 6px 16px; font-size: 13px; cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
}
.btn:hover { background: var(--mk-hover); border-color: var(--mk-border-strong); }
.btn:active { background: var(--mk-active); }
.btn:focus-visible { outline: 2px solid var(--mk-accent); outline-offset: 1px; }
/* 主按钮文字用主题配对色 --mk-accent-fg：暗色主题 accent 是浅灰，硬编码 #fff 会白字压浅灰底（对比 ≈1.6:1 几乎不可读） */
.btn.primary {
  background: var(--mk-accent); border-color: var(--mk-accent); color: var(--mk-accent-fg);
  font-weight: 600;
}
.btn.primary:hover { background: color-mix(in srgb, var(--mk-accent) 86%, var(--mk-accent-fg)); }
.btn.primary:active { background: color-mix(in srgb, var(--mk-accent) 76%, var(--mk-accent-fg)); }
.btn.danger {
  background: var(--mk-danger); border-color: var(--mk-danger); color: var(--mk-danger-fg);
  font-weight: 600;
}
.btn.danger:hover { background: color-mix(in srgb, var(--mk-danger) 86%, var(--mk-danger-fg)); }
.btn.danger:active { background: color-mix(in srgb, var(--mk-danger) 76%, var(--mk-danger-fg)); }
</style>
