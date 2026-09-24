<script setup lang="ts">
/**
 * 预览区右上角"用系统默认程序打开"按钮：
 * docx/xlsx/图片/HTML 预览均为只读，编辑/深交互场景仍需本机程序接力。
 * 绝对定位浮在预览区右上（inline 模式除外，用于已有工具条的组件）。
 */
import { ref } from 'vue';
import { ExternalLink } from '@lucide/vue';

import { openInSystem } from '../../api/fileApi';
import { useEditorStore } from '../../stores/editorStore';

const props = withDefaults(defineProps<{ path: string; inline?: boolean }>(), { inline: false });

const editor = useEditorStore();
const busy = ref(false);

async function open() {
  if (busy.value) return;
  busy.value = true;
  try {
    await openInSystem(props.path);
    editor.showToast(`已用系统默认程序打开：${props.path.split(/[\\/]/).pop() ?? props.path}`, 'info');
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button
    class="pv-open-sys"
    :class="{ inline }"
    title="用系统默认程序打开"
    @click="open"
  >
    <ExternalLink :size="14" />
    <span v-if="inline" class="pv-open-sys-text">系统打开</span>
  </button>
</template>

<style scoped>
.pv-open-sys {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  appearance: none;
  border: 1px solid var(--mk-border, #e0e0e0);
  background: var(--mk-panel, #fff);
  color: var(--mk-fg-soft, #666);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 1px 6px rgb(0 0 0 / 0.12);
}
.pv-open-sys:hover {
  border-color: var(--mk-accent, #4a89dc);
  color: var(--mk-accent, #4a89dc);
}
.pv-open-sys:disabled {
  opacity: 0.5;
  cursor: default;
}
.pv-open-sys.inline {
  position: static;
  box-shadow: none;
}
</style>
