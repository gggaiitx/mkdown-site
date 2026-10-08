<script setup lang="ts">
import { computed } from 'vue';
import { useEditorStore } from '../stores/editorStore';
import { useI18n } from '../i18n';
import { useTabsStore } from '../stores/tabsStore';
import type { EditorMode } from '../api/types';

const props = defineProps<{ mode: EditorMode }>();

const editor = useEditorStore();
const tabs = useTabsStore();
const { t } = useI18n();

const stateText = computed(() => {
  const tab = tabs.activeTab;
  if (!tab) return t('statusbar.ready');
  if (editor.saving) return t('statusbar.saving');
  return tab.isDirty ? t('statusbar.unsaved') : t('statusbar.saved');
});
const stateKind = computed(() => {
  const t = tabs.activeTab;
  if (!t) return '';
  if (editor.saving) return 'warn';
  return t.isDirty ? 'warn' : 'ok';
});
const modeText = computed(() => ({ edit: t('statusbar.modeEdit'), split: t('statusbar.modeSplit'), read: t('statusbar.modeRead') } as Record<EditorMode, string>)[props.mode] ?? props.mode);
</script>

<template>
  <footer class="statusbar">
    <span class="item strong">{{ tabs.activeTab?.title ?? t('statusbar.noDoc') }}</span>
    <span class="item" :class="stateKind">{{ stateText }}</span>
    <span class="spacer" />
    <span class="item">{{ t('statusbar.wordCount', { n: editor.wordCount.toLocaleString() }) }}</span>
    <span class="sep" />
    <span class="item">{{ t('statusbar.lineCount', { n: editor.lineCount }) }}</span>
    <!-- 阅读态无光标概念，隐藏光标项 -->
    <template v-if="mode !== 'read'">
      <span class="sep" />
      <span class="item">{{ t('statusbar.cursor', { l: editor.cursorLine, c: editor.cursorCol }) }}</span>
    </template>
    <span class="sep" />
    <span class="item">{{ modeText }}</span>
    <template v-if="tabs.activeTab">
      <span class="sep" />
      <span class="item">{{ tabs.activeTab.encoding }}</span>
    </template>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 24px;
  padding: 0 12px;
  font-size: 11px;
  color: var(--mk-fg-muted);
  background: var(--mk-panel);
  border-top: 1px solid var(--mk-border);
  flex: none;
  user-select: none;
}
.item { white-space: nowrap; }
.item.strong { color: var(--mk-fg); font-weight: 500; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.item.ok { color: var(--mk-ok); }
.item.warn { color: var(--mk-warn); }
.sep { width: 1px; height: 10px; background: var(--mk-border); }
.spacer { flex: 1; }
</style>
