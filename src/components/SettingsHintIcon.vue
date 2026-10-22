<script setup lang="ts">
import { computed } from 'vue';
import { Info } from '@lucide/vue';
import { useI18n } from '../i18n';

const props = defineProps<{ target: string; open: boolean }>();
const emit = defineEmits<{ (e: 'toggle'): void }>();
const { t } = useI18n();

const label = computed(() => (props.open ? t('settings.hintHide') : t('settings.hintShow')));
</script>

<template>
  <button
    type="button"
    class="hint-btn"
    :class="{ on: open }"
    :aria-expanded="open"
    :aria-controls="`hint-${target}`"
    :aria-label="label"
    v-tip="label"
    @click.stop="emit('toggle')"
  >
    <Info :size="13" />
  </button>
</template>

<style scoped>
/* 设置页副描述的统一开关：标题旁的小信息图标，点开才显示说明 */
.hint-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0; flex: none;
  border: none; border-radius: 4px; background: transparent;
  color: var(--mk-fg-muted); opacity: 0.65; cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.hint-btn:hover { background: var(--mk-hover); color: var(--mk-fg); opacity: 1; }
.hint-btn.on { color: var(--mk-accent); opacity: 1; }
.hint-btn:focus-visible { outline: 2px solid var(--mk-fg-muted); outline-offset: 1px; }
</style>
