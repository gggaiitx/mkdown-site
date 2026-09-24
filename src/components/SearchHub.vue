<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSearchStore } from '../stores/searchStore';
import { useTabsStore } from '../stores/tabsStore';
import { useEditorStore } from '../stores/editorStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { openInSystem, probeTextFile } from '../api/fileApi';
import type { SearchHit } from '../api/types';
import { fileKind } from '../utils/fileKind';

/**
 * 统一搜索面板（SearchHub）：
 * - file 模式：当前文件内容查找（复用 tab.content 行级匹配，实时定位 + 高亮）
 * - global 模式：工作区全文检索（searchStore，Markdown/Office）
 * - 面板可拖动（标题栏按住拖移），Ctrl+Alt+F 在两模式间切换
 */
const props = defineProps<{ mode: 'file' | 'global' }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'update:mode', m: 'file' | 'global'): void;
  (e: 'goto', line: number, kw?: string, caseSensitive?: boolean): void;
  (e: 'find', keyword: string, caseSensitive: boolean): void;
}>();

const search = useSearchStore();
const tabs = useTabsStore();
const editor = useEditorStore();
const settings = useSettingsStore();
const ws = useWorkspaceStore();

// ---------- 共享输入 ----------
const keyword = ref('');
const caseSensitive = ref(false);
const ipt = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

// ================= 文件内查找 =================
interface Match {
  line: number;
  column: number; // 1-based 字符列
  text: string;
}

/** 对当前文档内容做行级匹配（复用 tab.content，与编辑器内容实时同步） */
const fileMatches = computed<Match[]>(() => {
  if (props.mode !== 'file') return [];
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
    while (true) {
      const at = line.indexOf(needle, from);
      if (at < 0) break;
      out.push({ line: i + 1, column: at + 1, text: lines[i].slice(0, 200) });
      from = at + Math.max(1, needle.length); // 空串防御：强制推进
    }
    if (out.length >= 2000) break; // 上限兜底
  }
  return out;
});

const fileCur = ref(0); // 0-based 当前命中

function clampFileCur(): void {
  const n = fileMatches.value.length;
  if (fileCur.value >= n) fileCur.value = n > 0 ? n - 1 : 0;
}

/** 跳到当前命中：上抛行号+关键词由宿主直调引擎（定位 + 维持高亮） */
function gotoFile(idx: number): void {
  clampFileCur();
  const m = fileMatches.value[idx];
  const tab = tabs.activeTab;
  if (!m || !tab) return;
  emit('goto', m.line, keyword.value, caseSensitive.value);
  tabs.updateTab(tab.id, { cursorLine: m.line });
}

function fileNext(): void {
  if (!fileMatches.value.length) return;
  fileCur.value = (fileCur.value + 1) % fileMatches.value.length;
  gotoFile(fileCur.value);
}

function filePrev(): void {
  const n = fileMatches.value.length;
  if (!n) return;
  fileCur.value = (fileCur.value - 1 + n) % n;
  gotoFile(fileCur.value);
}

// 关键词/大小写变化（file 模式）：重置到第一处并立即定位 + 上抛高亮态
watch([keyword, caseSensitive], () => {
  if (props.mode !== 'file') return;
  fileCur.value = 0;
  emit('find', keyword.value, caseSensitive.value);
  void nextTick(() => gotoFile(0));
});

// ================= 全局搜索 =================
let runTimer: number | undefined;

function scheduleRun(delay = 400): void {
  window.clearTimeout(runTimer);
  runTimer = window.setTimeout(() => {
    if (search.query.trim()) void search.run();
    else search.clear();
  }, delay);
}

// 输入同步到 store（global 模式）+ 防抖自动检索；Enter 立即执行
watch(keyword, (kw) => {
  if (props.mode !== 'global') return;
  search.query = kw;
  scheduleRun();
});

// 检索选项变化：立即重跑（有关键词时）
watch(
  () => [search.caseSensitive, search.isRegex, search.includeGlob] as const,
  () => {
    if (props.mode !== 'global') return;
    if (search.query.trim()) scheduleRun(0);
  },
);

const selIdx = ref(0); // 扁平命中列表的选中项
watch(
  () => search.hits.length,
  () => {
    selIdx.value = 0;
  },
);

const flatHits = computed(() => search.hits);

const groups = computed(() => {
  const map = new Map<string, SearchHit[]>();
  for (const h of search.hits) {
    const list = map.get(h.relPath) ?? [];
    list.push(h);
    map.set(h.relPath, list);
  }
  return Array.from(map.entries());
});

/** 文件行文本按命中区间切段渲染 <mark> */
function hitSegs(h: SearchHit) {
  return [
    h.lineText.slice(0, h.matchStart),
    h.lineText.slice(h.matchStart, h.matchEnd),
    h.lineText.slice(h.matchEnd),
  ];
}

/** 文件内查找：按关键词全部出现位置切段（区分大小写跟随当前开关） */
function kwSegs(text: string): { t: string; hit: boolean }[] {
  const kw = keyword.value;
  if (!kw) return [{ t: text, hit: false }];
  const hay = caseSensitive.value ? text : text.toLowerCase();
  const needle = caseSensitive.value ? kw : kw.toLowerCase();
  const out: { t: string; hit: boolean }[] = [];
  let from = 0;
  while (true) {
    const at = hay.indexOf(needle, from);
    if (at < 0) {
      out.push({ t: text.slice(from), hit: false });
      break;
    }
    if (at > from) out.push({ t: text.slice(from, at), hit: false });
    out.push({ t: text.slice(at, at + needle.length), hit: true });
    from = at + Math.max(1, needle.length);
  }
  return out;
}

/** 选中项滚动到可见 */
watch(selIdx, async () => {
  await nextTick();
  panelRef.value?.querySelector('.hit.sel')?.scrollIntoView({ block: 'nearest' });
});

function selNext(): void {
  if (!flatHits.value.length) return;
  selIdx.value = Math.min(selIdx.value + 1, flatHits.value.length - 1);
}

function selPrev(): void {
  if (!flatHits.value.length) return;
  selIdx.value = Math.max(selIdx.value - 1, 0);
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
      editor.showToast(`已用系统默认程序打开：${hit.relPath}`, 'success');
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
    // 三种模式均可定位（阅读态走 data-line 锚点）；
    // 关键词同步传入做高亮；正则/空查询传 ''（= 清除残留高亮）
    const kw = search.isRegex || !search.query.trim() ? '' : search.query.trim();
    emit('goto', hit.line, kw, search.caseSensitive);
    tabs.updateTab(tab.id, { cursorLine: hit.line });
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

function openSelected(): void {
  const h = flatHits.value[selIdx.value];
  if (h) void openHit(h);
}

// ================= 模式切换 =================
function toggleMode(): void {
  emit('update:mode', props.mode === 'file' ? 'global' : 'file');
}

watch(
  () => props.mode,
  (m, old) => {
    // 离开 file 模式清掉文件内高亮；进入 file 模式回放当前关键词
    if (old === 'file' && m !== 'file') emit('find', '', false);
    if (m === 'file' && keyword.value) {
      fileCur.value = 0;
      emit('find', keyword.value, caseSensitive.value);
      void nextTick(() => gotoFile(0));
    }
    // 进入 global 模式：关键词带入并立即检索（有关键词时）
    if (m === 'global') {
      search.query = keyword.value;
      if (search.query.trim()) scheduleRun(0);
    }
    void nextTick(() => {
      ipt.value?.focus();
      ipt.value?.select();
    });
  },
);

// ================= 键盘 =================
function onEnter(e: KeyboardEvent): void {
  if (props.mode === 'file') {
    e.shiftKey ? filePrev() : fileNext();
  } else if (flatHits.value.length) {
    openSelected();
  } else if (search.query.trim()) {
    void search.run();
  }
}

function onDown(): void {
  props.mode === 'file' ? fileNext() : selNext();
}

function onUp(): void {
  props.mode === 'file' ? filePrev() : selPrev();
}

// ================= 拖动 =================
const pos = ref<{ x: number; y: number } | null>(null); // null = 默认右上角
const dragging = ref(false);
let dragOff = { x: 0, y: 0 };

const posStyle = computed(() =>
  pos.value ? { left: `${pos.value.x}px`, top: `${pos.value.y}px` } : { right: '28px', top: '64px' },
);

function dragStart(e: PointerEvent): void {
  const t = e.target as HTMLElement;
  if (t.closest('input, button')) return; // 输入框/按钮不触发拖动
  const el = panelRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  pos.value = { x: rect.left, y: rect.top };
  dragOff = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  dragging.value = true;
  try {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    // 无头环境/合成事件下可能无活动指针，忽略即可（move 监听仍在 header 上）
  }
}

function dragMove(e: PointerEvent): void {
  if (!dragging.value) return;
  const w = panelRef.value?.offsetWidth ?? 560;
  const x = Math.min(Math.max(8, e.clientX - dragOff.x), window.innerWidth - w - 8);
  const y = Math.min(Math.max(8, e.clientY - dragOff.y), window.innerHeight - 120);
  pos.value = { x, y };
}

function dragEnd(): void {
  dragging.value = false;
}

onBeforeUnmount(() => {
  window.clearTimeout(runTimer);
});

// 打开面板即聚焦输入框（全局模式可能有上次关键词，全选便于直接覆盖输入）
onMounted(() => {
  ipt.value?.focus();
  ipt.value?.select();
});

const footCount = computed(() =>
  props.mode === 'file'
    ? fileMatches.value.length
      ? `第 ${fileCur.value + 1} / ${fileMatches.value.length} 处`
      : keyword.value
        ? '0 个结果'
        : '0 个结果'
    : `${search.total} 个结果`,
);

const switchLabel = computed(() => (props.mode === 'file' ? '全局文件内容搜索' : '当前文件搜索'));
/** 底栏切换提示：显示"另一个模式"的实际快捷键（文件内=Ctrl+P 去全局 / 全局=Ctrl+F 回文件内） */
const switchKey = computed(() => (props.mode === 'file' ? 'Ctrl + P' : 'Ctrl + F'));
</script>

<template>
  <div
    ref="panelRef"
    class="hub"
    :class="{ dragging }"
    :style="posStyle"
    @keydown.esc.prevent="emit('close')"
  >
    <!-- 标题栏：拖动手柄 + 模式切换 + 输入 + 选项 -->
    <div class="hub-head" @pointerdown="dragStart" @pointermove="dragMove" @pointerup="dragEnd" @pointercancel="dragEnd">
      <button
        class="scope"
        :title="`切换查找范围（文件内 Ctrl+F / 全局 Ctrl+P）：当前${mode === 'file' ? '文件内' : '全局'}`"
        @click="toggleMode"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 .8v2.6M8 12.6v2.6M.8 8h2.6M12.6 8h2.6" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
      <input
        ref="ipt"
        v-model="keyword"
        class="ipt"
        :placeholder="mode === 'file' ? '在当前文件中查找…' : '全局搜索文件内容…'"
        spellcheck="false"
        @keydown.enter.prevent="onEnter"
        @keydown.down.prevent="onDown"
        @keydown.up.prevent="onUp"
      />
      <button class="opt" :class="{ on: caseSensitive }" title="区分大小写" @click="caseSensitive = !caseSensitive">Aa</button>
      <button
        v-if="mode === 'global'"
        class="opt"
        :class="{ on: search.isRegex }"
        title="正则表达式"
        @click="search.isRegex = !search.isRegex"
      >
        .*
      </button>
      <button
        v-if="mode === 'global'"
        class="opt"
        :class="{ on: search.includeGlob === '*.md' }"
        title="仅 Markdown"
        @click="search.includeGlob = search.includeGlob === '*.md' ? null : '*.md'"
      >
        M↓
      </button>
      <button class="close" title="关闭 (Esc)" @click="emit('close')">×</button>
    </div>

    <!-- 结果区 -->
    <div class="hub-body">
      <!-- 文件内查找 -->
      <template v-if="mode === 'file'">
        <p v-if="!tabs.activeTab" class="hint center">请先打开文档</p>
        <p v-else-if="!keyword" class="hint center">开始输入进行搜索</p>
        <p v-else-if="!fileMatches.length" class="hint center">无匹配</p>
        <button
          v-for="(m, i) in fileMatches"
          v-else
          :key="`${m.line}:${m.column}`"
          class="hit"
          :class="{ sel: i === fileCur }"
          :title="`第 ${m.line} 行，点击定位`"
          @click="fileCur = i; gotoFile(i)"
        >
          <span class="line-no">L{{ m.line }}</span>
          <span class="line-text">
            <template v-for="(s, si) in kwSegs(m.text)" :key="si">
              <mark v-if="s.hit">{{ s.t }}</mark>
              <template v-else>{{ s.t }}</template>
            </template>
          </span>
        </button>
      </template>

      <!-- 全局搜索 -->
      <template v-else>
        <p v-if="!ws.root" class="hint center">请先打开工作区</p>
        <p v-else-if="search.error" class="hint center err">{{ search.error }}</p>
        <p v-else-if="search.searching" class="hint center">搜索中…</p>
        <p v-else-if="!keyword && !search.hits.length" class="hint center">开始输入进行搜索</p>
        <p v-else-if="!search.hits.length" class="hint center">无命中</p>
        <div v-for="[relPath, hits] in groups" v-else :key="relPath" class="group">
          <div class="file-name" :title="hits[0].path">{{ relPath }}</div>
          <button
            v-for="h in hits"
            :key="`${h.path}:${h.line}:${h.column}`"
            class="hit"
            :class="{ sel: flatHits[selIdx] === h }"
            :title="isTextLike(h.path) ? `第 ${h.line} 行，点击打开` : `第 ${h.line} 段，点击用系统程序打开`"
            @click="openHit(h)"
          >
            <span class="line-no">L{{ h.line }}</span>
            <span class="line-text">{{ hitSegs(h)[0] }}<mark>{{ hitSegs(h)[1] }}</mark>{{ hitSegs(h)[2] }}</span>
          </button>
        </div>
      </template>
    </div>

    <!-- 底栏：结果数 + 快捷键提示 + 模式切换 -->
    <div class="hub-foot">
      <span class="cnt">{{ footCount }}</span>
      <span class="keys">
        <kbd>↑</kbd><kbd>↓</kbd> 导航
        <kbd>↵</kbd> 选择
        <kbd>ESC</kbd> 关闭
      </span>
      <button class="mode-switch" :title="`按 ${switchKey} 切换到${switchLabel}`" @click="toggleMode">
        <kbd>{{ switchKey }}</kbd> {{ switchLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.hub {
  position: fixed;
  z-index: 80;
  width: 560px;
  max-width: calc(100vw - 24px);
  height: 420px;
  max-height: calc(100vh - 120px);
  display: flex;
  flex-direction: column;
  background: var(--mk-panel);
  color: var(--mk-fg);
  border: 1px solid var(--mk-border);
  border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.hub.dragging {
  user-select: none;
  cursor: grabbing;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.3);
}

/* ---- 标题栏（拖动手柄） ---- */
.hub-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--mk-border);
  cursor: grab;
  background: var(--mk-panel);
}
.hub-head:active { cursor: grabbing; }
.scope {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--mk-fg-muted);
  cursor: pointer;
}
.scope:hover { background: var(--mk-hover); color: var(--mk-accent); }
.ipt {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--mk-fg);
  font-size: 14px;
  padding: 5px 4px;
  outline: none;
}
.ipt::placeholder { color: var(--mk-fg-muted); }
.opt,
.close {
  flex: none;
  border: 1px solid var(--mk-border);
  background: transparent;
  color: var(--mk-fg-muted);
  border-radius: 5px;
  min-width: 26px;
  height: 26px;
  font-size: 12px;
  cursor: pointer;
  line-height: 1;
  padding: 0 5px;
}
.opt.on { border-color: var(--mk-accent); color: var(--mk-accent); }
.opt:hover, .close:hover { background: var(--mk-hover); color: var(--mk-fg); }
.close { border: none; font-size: 16px; }

/* ---- 结果区 ---- */
.hub-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px 10px;
}
.hint {
  margin: 0;
  padding: 40px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--mk-fg-muted);
}
.hint.err { color: var(--mk-danger); }
.group { margin-bottom: 10px; }
.file-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--mk-accent);
  padding: 4px 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit {
  display: flex;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--mk-fg);
  line-height: 1.5;
}
.hit:hover { background: var(--mk-hover); }
.hit.sel { background: var(--mk-hover); outline: 1px solid var(--mk-accent-weak); }
.line-no { color: var(--mk-fg-muted); flex: none; min-width: 36px; }
.line-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
mark {
  background: var(--mk-accent-weak);
  color: var(--mk-accent);
  border-radius: 2px;
  padding: 0 1px;
}

/* ---- 底栏 ---- */
.hub-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-top: 1px solid var(--mk-border);
  font-size: 12px;
  color: var(--mk-fg-muted);
}
.cnt { flex: none; min-width: 64px; }
.keys { flex: 1; display: flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; }
kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--mk-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--mk-bg);
  font-size: 11px;
  font-family: inherit;
  color: var(--mk-fg);
}
.mode-switch {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--mk-fg-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}
.mode-switch:hover { background: var(--mk-hover); color: var(--mk-fg); }
</style>
