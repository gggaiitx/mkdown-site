<script setup lang="ts">
import { ref, watch } from 'vue';

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
  { message: '', confirmText: '确定', cancelText: '取消', danger: false, input: false, inputValue: '', placeholder: '' },
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

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('cancel');
  if (e.key === 'Enter' && props.input) emit('confirm', val.value);
}
function submit() {
  emit('confirm', val.value);
}
</script>

<template>
  <div v-if="visible" class="mask" @keydown="onKey" @click.self="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="title">{{ title }}</div>
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
        <button class="btn" @click="emit('cancel')">{{ cancelText }}</button>
        <button class="btn" :class="danger ? 'danger' : 'primary'" @click="submit">
          {{ confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 30010;
  background: rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
}
.dialog {
  width: 380px; max-width: 90vw;
  background: var(--mk-panel); color: var(--mk-fg);
  border: 1px solid var(--mk-border); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  padding: 16px;
}
.title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.msg { font-size: 13px; line-height: 1.6; margin: 0 0 8px; color: var(--mk-fg); }
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
