<script setup lang="ts">
import { computed } from 'vue';
import { useSearchStore } from '../stores/searchStore';
import { useTabsStore } from '../stores/tabsStore';
import { useEditorStore } from '../stores/editorStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { openInSystem, probeTextFile } from '../api/fileApi';
import type { SearchHit } from '../api/types';
import { fileKind } from '../utils/fileKind';
import { useI18n } from '../i18n';

const search = useSearchStore();
const tabs = useTabsStore();
const editor = useEditorStore();
const settings = useSettingsStore();
const ws = useWorkspaceStore();
const { t } = useI18n();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'goto', line: number, kw?: string, caseSensitive?: boolean): void;
}>();

const groups = computed(() => {
  const map = new Map<string, SearchHit[]>();
  for (const h of search.hits) {
    const list = map.get(h.relPath) ?? [];
    list.push(h);
    map.set(h.relPath, list);
  }
  return Array.from(map.entries());
});

function highlight(line: string, start: number, end: number) {
  return [
    line.slice(0, start),
    line.slice(start, end),
    line.slice(end),
  ];
}

/** 命中条目的提示语分类（只影响悬浮文案；能否编辑仍以后端探测为准） */
const TEXT_KINDS = new Set(['md', 'text', 'code']);
const isTextLike = (p: string) => TEXT_KINDS.has(fileKind(p.split(/[\\/]/).pop() ?? ''));

/**
 * 命中跳转的类型分流与目录树保持同一判定源：Rust 侧 `probe_text_file`
 * （扩展名 + 内容嗅探），避免"树里能开的 .json/.csv，搜索里却跳系统程序"。
 */
async function openHit(hit: SearchHit) {
  try {
    if (!(await probeTextFile(hit.path))) {
      await openInSystem(hit.path);
      editor.showToast(t('searchpanel.openedWithSystem', { path: hit.relPath }), 'success');
      return;
    }
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
    return;
  }
  try {
    const tab = await tabs.openByPath(hit.path, settings.settings.editorMode);
    ws.expandTo(hit.path);
    ws.select(hit.path);
    // 三种模式均可定位（阅读态走 data-line 锚点），不再强制切编辑模式；
    // 关键词同步传入做高亮；正则/空查询传 ''（= 清除残留高亮）
    const kw = search.isRegex || !search.query.trim() ? '' : search.query.trim();
    emit('goto', hit.line, kw, search.caseSensitive);
    tabs.updateTab(tab.id, { cursorLine: hit.line });
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}
</script>

<template>
  <div class="search-panel" v-if="search.visible">
    <div class="panel-head">
      <span class="panel-title">{{ t('searchpanel.title') }}</span>
      <button class="close" @click="emit('close'); search.close()">×</button>
    </div>
    <div class="input-row">
      <input
        class="ipt"
        v-model="search.query"
        :placeholder="t('searchpanel.placeholder')"
        @keydown.enter="search.run()"
      />
      <button class="go" :disabled="search.searching" @click="search.run()">
        {{ search.searching ? '…' : t('searchpanel.go') }}
      </button>
    </div>
    <div class="opts">
      <label><input type="checkbox" v-model="search.caseSensitive" /> {{ t('searchpanel.caseSensitive') }}</label>
      <label><input type="checkbox" v-model="search.isRegex" /> {{ t('searchpanel.regex') }}</label>
      <label><input type="checkbox" :true-value="'*.md'" :false-value="null" v-model="search.includeGlob" /> {{ t('searchpanel.onlyMarkdown') }}</label>
    </div>

    <p class="hint" v-if="!ws.root">{{ t('searchpanel.openWorkspaceFirst') }}</p>
    <p class="hint err" v-else-if="search.error">{{ search.error }}</p>
    <p class="hint" v-else-if="search.total > 0">
      {{ t('searchpanel.totalHits', { total: search.total }) }}<template v-if="search.hits.length < search.total">{{ t('searchpanel.shownPrefix', { n: search.hits.length }) }}</template>
    </p>
    <p class="hint" v-else-if="!search.searching && search.lastQuery">{{ t('searchpanel.noHits') }}</p>

    <div class="results">
      <div v-for="[relPath, hits] in groups" :key="relPath" class="group">
        <div class="file-name" :title="hits[0].path">{{ relPath }}</div>
        <button
          v-for="h in hits"
          :key="`${h.path}:${h.line}:${h.column}`"
          class="hit"
          :title="isTextLike(h.path) ? t('searchpanel.lineOpen', { line: h.line }) : t('searchpanel.lineOpenSystem', { line: h.line })"
          @click="openHit(h)"
        >
          <span class="line-no">L{{ h.line }}</span>
          <span class="line-text">{{ highlight(h.lineText, h.matchStart, h.matchEnd)[0] }}<mark>{{ highlight(h.lineText, h.matchStart, h.matchEnd)[1] }}</mark>{{ highlight(h.lineText, h.matchStart, h.matchEnd)[2] }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  position: fixed;
  top: 42px; right: 12px; bottom: 26px;
  width: 380px; max-width: 90vw;
  z-index: 80;
  display: flex; flex-direction: column;
  background: var(--mk-panel); color: var(--mk-fg);
  border: 1px solid var(--mk-border); border-radius: 10px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--mk-border);
}
.panel-title { font-size: 12px; font-weight: 600; letter-spacing: 2px; color: var(--mk-fg-muted); }
.close { border: none; background: transparent; color: var(--mk-fg-muted); font-size: 16px; cursor: pointer; }
.input-row { display: flex; gap: 6px; padding: 10px 12px 4px; }
.ipt {
  flex: 1; border: 1px solid var(--mk-border); border-radius: 6px;
  background: var(--mk-bg); color: var(--mk-fg);
  padding: 6px 10px; font-size: 13px; outline: none;
}
.ipt:focus { border-color: var(--mk-accent); }
.go {
  border: 1px solid var(--mk-accent); background: var(--mk-accent); color: var(--mk-accent-fg);
  border-radius: 6px; padding: 0 12px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.go:hover { background: color-mix(in srgb, var(--mk-accent) 86%, var(--mk-accent-fg)); }
.opts { display: flex; gap: 12px; padding: 4px 12px; font-size: 12px; color: var(--mk-fg-muted); }
.opts label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.hint { padding: 6px 12px 0; font-size: 12px; color: var(--mk-fg-muted); margin: 0; }
.hint.err { color: var(--mk-danger); }
.results { flex: 1; overflow-y: auto; padding: 8px 8px 12px; }
.group { margin-bottom: 10px; }
.file-name {
  font-size: 12px; font-weight: 600; color: var(--mk-accent);
  padding: 4px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hit {
  display: flex; gap: 8px; width: 100%; text-align: left;
  border: none; background: transparent;
  padding: 3px 6px; border-radius: 4px; cursor: pointer;
  font-size: 12px; color: var(--mk-fg); line-height: 1.5;
}
.hit:hover { background: var(--mk-hover); }
.line-no { color: var(--mk-fg-muted); flex: none; min-width: 34px; }
.line-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
mark { background: var(--mk-accent-weak); color: var(--mk-accent); border-radius: 2px; padding: 0 1px; }
</style>
