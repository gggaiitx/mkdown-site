<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted } from 'vue';
import { useTabsStore } from '../stores/tabsStore';

const tabs = useTabsStore();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'goto', line: number, kw?: string, caseSensitive?: boolean): void;
  (e: 'find', keyword: string, caseSensitive: boolean): void;
}>();

const keyword = ref('');
const caseSensitive = ref(false);
const current = ref(0); // 0-based，指向 matches
const ipt = ref<HTMLInputElement | null>(null);

interface Match {
  line: number;
  column: number; // 1-based 字符列
  text: string; // 命中行原文（截断展示用）
}

/** 对当前文档内容做行级匹配（复用 tab.content，与编辑器内容实时同步） */
const matches = computed<Match[]>(() => {
  const tab = tabs.activeTab;
  const kw = keyword.value;
  if (!tab || kw.length === 0) return [];
  const hay = caseSensitive.value ? tab.content : tab.content.toLowerCase();
  const needle = caseSensitive.value ? kw : kw.toLowerCase();
  const out: Match[] = [];
  const lines = tab.content.split('\n');
  const hayLines = hay.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = hayLines[i];
    let from = 0;
    // 同一行可能多次命中，全部收集
    while (true) {
      const at = line.indexOf(needle, from);
      if (at < 0) break;
      out.push({ line: i + 1, column: at + 1, text: lines[i].slice(0, 200) });
      from = at + Math.max(1, needle.length); // 空串防御：强制推进
    }
    if (out.length >= 2000) break; // 与全局搜索同量级的上限兜底
  }
  return out;
});

function clampIndex(): void {
  const n = matches.value.length;
  if (current.value >= n) current.value = n > 0 ? n - 1 : 0;
}

/** 跳到当前命中：上抛行号+关键词由宿主直调引擎（定位 + 维持高亮，否则 goto 会清掉 find 刚画的高亮） */
function gotoMatch(idx: number): void {
  clampIndex();
  const m = matches.value[idx];
  const tab = tabs.activeTab;
  if (!m || !tab) return;
  emit('goto', m.line, keyword.value, caseSensitive.value);
  tabs.updateTab(tab.id, { cursorLine: m.line });
}

function next(): void {
  if (matches.value.length === 0) return;
  current.value = (current.value + 1) % matches.value.length;
  gotoMatch(current.value);
}

function prev(): void {
  if (matches.value.length === 0) return;
  current.value = (current.value - 1 + matches.value.length) % matches.value.length;
  gotoMatch(current.value);
}

// 关键词/大小写变化：重置到第一处并立即定位 + 上抛高亮态（宿主转引擎）
watch([keyword, caseSensitive], () => {
  current.value = 0;
  emit('find', keyword.value, caseSensitive.value);
  void nextTick(() => gotoMatch(0));
});

onMounted(() => {
  ipt.value?.focus();
  ipt.value?.select();
});
</script>

<template>
  <div class="findbar">
    <input
      ref="ipt"
      class="ipt"
      v-model="keyword"
      placeholder="在当前文件中查找…"
      spellcheck="false"
      @keydown.enter.prevent="($event as KeyboardEvent).shiftKey ? prev() : next()"
      @keydown.down.prevent="next()"
      @keydown.up.prevent="prev()"
      @keydown.esc.prevent="emit('close')"
    />
    <span class="count" :class="{ none: matches.length === 0 && keyword }">
      {{ keyword ? (matches.length ? `${current + 1} / ${matches.length}` : '无匹配') : '' }}
    </span>
    <button class="opt" :class="{ on: caseSensitive }" title="区分大小写" @click="caseSensitive = !caseSensitive">Aa</button>
    <button class="nav" title="上一处 (Shift+Enter)" :disabled="!matches.length" @click="prev()">↑</button>
    <button class="nav" title="下一处 (Enter)" :disabled="!matches.length" @click="next()">↓</button>
    <button class="close" title="关闭 (Esc)" @click="emit('close')">×</button>
  </div>
</template>

<style scoped>
.findbar {
  position: absolute;
  top: 8px; right: 16px;
  z-index: 70;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px;
  background: var(--mk-panel); color: var(--mk-fg);
  border: 1px solid var(--mk-border); border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
.ipt {
  width: 220px;
  border: 1px solid var(--mk-border); border-radius: 6px;
  background: var(--mk-bg); color: var(--mk-fg);
  padding: 4px 8px; font-size: 12px; outline: none;
}
.ipt:focus { border-color: var(--mk-accent); }
.count { min-width: 52px; text-align: center; font-size: 12px; color: var(--mk-fg-muted); }
.count.none { color: var(--mk-danger); }
.opt, .nav, .close {
  border: 1px solid var(--mk-border); background: transparent; color: var(--mk-fg-muted);
  border-radius: 5px; width: 26px; height: 24px;
  font-size: 12px; cursor: pointer; line-height: 1;
}
.opt.on { border-color: var(--mk-accent); color: var(--mk-accent); }
.nav:hover:not(:disabled), .opt:hover, .close:hover { background: var(--mk-hover); color: var(--mk-fg); }
.nav:disabled { opacity: 0.4; cursor: default; }
.close { border: none; font-size: 15px; }
</style>
