<script setup lang="ts">
import { computed } from 'vue';
import { FolderOpen, FileText, FilePlus2, History } from '@lucide/vue';
import { useSettingsStore } from '../stores/settingsStore';
import type { MdTemplate } from '../utils/markdownTemplate';

const props = defineProps<{
  templates: MdTemplate[];
}>();

const settings = useSettingsStore();

const emit = defineEmits<{
  (e: 'open-workspace'): void;
  (e: 'open-file'): void;
  (e: 'new-template', tpl: MdTemplate): void;
  (e: 'open-recent', path: string): void;
}>();

const recent = computed(() =>
  [...settings.settings.recentFiles].sort((a, b) => b.openedAtMs - a.openedAtMs).slice(0, 8),
);

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="welcome">
    <div class="hero">
      <svg class="logo" viewBox="0 0 102 102" aria-hidden="true">
        <rect width="102" height="102" rx="24" fill="#E6F1FB" />
        <path
          d="M27 72 L27 32 L42 50 L57 32 L57 72"
          fill="none" stroke="#0C447C" stroke-width="7"
          stroke-linecap="round" stroke-linejoin="round"
        />
        <rect x="63" y="60" width="11" height="14" rx="2.5" fill="#378ADD" />
      </svg>
      <h1>码克</h1>
      <p class="sub">本地 Markdown 编辑与阅读器 · 离线优先 · 数据不出本机</p>
    </div>

    <div class="cols">
      <section class="col">
        <h2>开始</h2>
        <button class="big" @click="emit('open-workspace')"><FolderOpen class="b-icon" />打开工作区</button>
        <button class="big" @click="emit('open-file')"><FileText class="b-icon" />打开文件</button>
        <h2>从模板新建</h2>
        <button v-for="t in props.templates" :key="t.id" class="big" @click="emit('new-template', t)">
          <FilePlus2 class="b-icon" />{{ t.name }}
        </button>
      </section>
      <section class="col recent-col">
        <h2><History class="h-icon" /> 最近打开</h2>
        <template v-if="recent.length > 0">
          <button
            v-for="r in recent"
            :key="r.path"
            class="recent"
            :title="r.path"
            @click="emit('open-recent', r.path)"
          >
            <span class="r-name">{{ r.path.split(/[\\/]/).pop() }}</span>
            <span class="r-time">{{ fmtTime(r.openedAtMs) }}</span>
          </button>
        </template>
        <p v-else class="none">暂无记录</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  height: 100%;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 28px;
  background: var(--mk-bg);
  overflow-y: auto;
}
.hero { text-align: center; }
.logo {
  display: inline-block;
  width: 56px; height: 56px;
  border-radius: 14px;
  margin-bottom: 10px;
}
h1 { margin: 0; font-size: 26px; color: var(--mk-fg); letter-spacing: 2px; }
.sub { margin: 8px 0 0; font-size: 13px; color: var(--mk-fg-muted); }
.cols { display: flex; gap: 48px; align-items: flex-start; }
.col { min-width: 220px; }
/* 最近打开列：限宽防止超长文件名把整列撑开（截断由 .r-name 省略号负责） */
.recent-col { width: 560px; max-width: 42vw; }
h2 { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--mk-fg-muted); letter-spacing: 2px; margin: 18px 0 8px; font-weight: 600; }
.h-icon { width: 12px; height: 12px; }
.big {
  display: flex; align-items: center; gap: 9px;
  width: 100%; text-align: left;
  border: 1px solid var(--mk-border); background: var(--mk-bg); color: var(--mk-fg);
  border-radius: var(--mk-radius); padding: 9px 14px; font-size: 13.5px;
  cursor: pointer; margin-bottom: 6px;
  transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
}
.big:hover { border-color: var(--mk-fg-muted); background: var(--mk-hover); }
.b-icon { width: 15px; height: 15px; color: var(--mk-fg-muted); flex: none; }
.big:hover .b-icon { color: var(--mk-fg); }
.recent {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  width: 100%; text-align: left;
  border: none; background: transparent; color: var(--mk-fg);
  padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.recent:hover { background: var(--mk-hover); }
.r-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-time { font-size: 11px; color: var(--mk-fg-muted); flex: none; }
.none { font-size: 12px; color: var(--mk-fg-muted); }
</style>
