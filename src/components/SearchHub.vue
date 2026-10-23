<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSearchStore } from '../stores/searchStore';
import { useTabsStore } from '../stores/tabsStore';
import { useEditorStore } from '../stores/editorStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { openInSystem, probeTextFile } from '../api/fileApi';
import { modKey } from '../utils/keyHint';
import { htmlPlainText } from '../utils/htmlText';
import type { ReplaceRequest } from '../utils/mdReplace';
import type { SearchHit } from '../api/types';
import { fileKind } from '../utils/fileKind';
import { useI18n } from '../i18n';

/**
 * 统一搜索面板（SearchHub）：
 * - file 模式：当前文件内容查找（复用 tab.content 行级匹配，实时定位 + 高亮）
 * - global 模式：工作区全文检索（searchStore，Markdown/Office）
 * - 面板可拖动（标题栏 / 底栏空白区按住拖移）；模式切换走面板 UI（标题栏范围按钮 /
 *   底栏切换按钮；Workbench 侧 Ctrl+F / Ctrl+P 开面板时已带入对应模式）
 */
const props = defineProps<{ mode: 'file' | 'global'; canReplace?: boolean }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'update:mode', m: 'file' | 'global'): void;
  (e: 'goto', line: number, kw?: string, caseSensitive?: boolean, matchIndex?: number): void;
  (e: 'find', keyword: string, caseSensitive: boolean): void;
  /** 替换请求：区间计算与落盘在 Workbench（那里同时持有 tab.content 与引擎句柄） */
  (e: 'replace', req: ReplaceRequest): void;
}>();

const search = useSearchStore();
const tabs = useTabsStore();
const editor = useEditorStore();
const settings = useSettingsStore();
const ws = useWorkspaceStore();
const { t } = useI18n();

// ---------- 共享输入 ----------
const keyword = ref('');
const caseSensitive = ref(false);
const ipt = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
/** 结果列表滚动容器（.hub-body）：键盘切换命中时把选中行滚进视口 */
const bodyRef = ref<HTMLElement | null>(null);

// ================= 文件内查找 =================
interface Match {
  line: number;
  column: number; // 1-based 字符列
  text: string;
}

/** 对当前文档内容做行级匹配（复用 tab.content，与编辑器内容实时同步）；
 *  mh（富文本）标签的 content 是 HTML 源码，按源码匹配会命中标签属性——
 *  改用去标签纯文本（口径 = 富文本引擎 TreeWalker 文本节点 join，见 utils/htmlText.ts）。
 *  关键词经 matchKw/matchCase 防抖代入（150ms，P2-30）：超大文档每次按键全量
 *  split+scan 会卡输入，防抖窗口内连续键入只算最后一次 */
const matchKw = ref('');
const matchCase = ref(false);
const fileMatches = computed<Match[]>(() => {
  if (props.mode !== 'file') return [];
  const tab = tabs.activeTab;
  const kw = matchKw.value;
  if (!tab || kw.length === 0) return [];
  const isMh = tab.kind === 'mh';
  const src = isMh ? htmlPlainText(tab.content) : tab.content;
  const hay = matchCase.value ? src : src.toLowerCase();
  const needle = matchCase.value ? kw : kw.toLowerCase();
  const out: Match[] = [];
  const lines = src.split('\n');
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

/** 文件内匹配防抖调度（P2-30）：150ms 后代入当前关键词/大小写并重算列表，算完定位第一处。
 *  高亮（emit find）仍即时——引擎侧便宜且用户预期即时反馈；贵的是全文档 split+scan */
let matchTimer: ReturnType<typeof setTimeout> | null = null;
/** 防抖代入后是否已定位过第一处（键入后立刻按 Enter/↑↓ 时先落位，避免拿旧列表序号起跳） */
let matchLanded = false;
function scheduleMatch(): void {
  if (matchTimer) clearTimeout(matchTimer);
  matchLanded = false;
  matchTimer = setTimeout(() => {
    matchTimer = null;
    matchKw.value = keyword.value;
    matchCase.value = caseSensitive.value;
    matchLanded = true;
    void nextTick(() => gotoFile(0)); // 列表重算后定位第一处
  }, 150);
}
/** 立即代入当前关键词（Enter/↑↓ 导航前调用，避免拿旧匹配列表导航） */
function flushMatch(): void {
  if (matchTimer) {
    clearTimeout(matchTimer);
    matchTimer = null;
  }
  matchKw.value = keyword.value;
  matchCase.value = caseSensitive.value;
}
/** 防抖窗口内的首次导航：先落位第一处（返回 true = 已消费本次导航） */
function landIfPending(): boolean {
  if (matchLanded) return false;
  matchLanded = true;
  fileCur.value = 0;
  gotoFile(0);
  return true;
}

const fileCur = ref(0); // 0-based 当前命中

// 键盘/替换推进命中序号时，把选中行滚进列表视口（block:'nearest' 已在视野内就不动，避免抖动）
watch(fileCur, () => {
  void nextTick(() => {
    const el = bodyRef.value?.querySelector('.hit.sel') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  });
});

function clampFileCur(): void {
  const n = fileMatches.value.length;
  if (fileCur.value >= n) fileCur.value = n > 0 ? n - 1 : 0;
}

/** 跳到当前命中：上抛行号 + 关键词 + 命中序号（第 4 参），由宿主直调引擎（定位 + 维持高亮）。
 *  序号三引擎通用：CM 系（md / code）据此强化当前命中并落成真实选区，
 *  富文本（.mh）由宿主另路由到 scrollToMatch */
function gotoFile(idx: number): void {
  clampFileCur();
  const m = fileMatches.value[idx];
  const tab = tabs.activeTab;
  if (!m || !tab) return;
  emit('goto', m.line, keyword.value, caseSensitive.value, idx);
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

// 关键词/大小写变化（file 模式）：重置到第一处并立即上抛高亮态；匹配列表防抖重算
watch([keyword, caseSensitive], () => {
  if (props.mode !== 'file') return;
  fileCur.value = 0;
  emit('find', keyword.value, caseSensitive.value);
  scheduleMatch();
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

/** 分组命中 + 行文本切段预计算（P2-30）：切段原先在模板里每行调用 3 次，
 *  改为建组时算一次随组带出（segs = [命中前, 命中, 命中后]） */
interface GroupHit {
  hit: SearchHit;
  segs: [string, string, string];
}
const groups = computed<[string, GroupHit[]][]>(() => {
  const map = new Map<string, GroupHit[]>();
  for (const h of search.hits) {
    const list = map.get(h.relPath) ?? [];
    list.push({
      hit: h,
      segs: [
        h.lineText.slice(0, h.matchStart),
        h.lineText.slice(h.matchStart, h.matchEnd),
        h.lineText.slice(h.matchEnd),
      ],
    });
    map.set(h.relPath, list);
  }
  return Array.from(map.entries());
});

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
      editor.showToast(t('search.openedWithSystem', { path: hit.relPath }), 'success');
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
      // 模式切换是一次性动作：关键词立即代入（不走 150ms 防抖），保证回放定位准确
      matchKw.value = keyword.value;
      matchCase.value = caseSensitive.value;
      matchLanded = true;
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
    flushMatch(); // 防抖窗口内按键：立即代入，避免旧列表导航
    if (landIfPending()) return; // 键入后首次导航：落位第一处
    e.shiftKey ? filePrev() : fileNext();
  } else if (flatHits.value.length) {
    openSelected();
  } else if (search.query.trim()) {
    void search.run();
  }
}

function onDown(): void {
  if (props.mode === 'file') {
    flushMatch();
    if (landIfPending()) return;
    fileNext();
  } else {
    selNext();
  }
}

function onUp(): void {
  if (props.mode === 'file') {
    flushMatch();
    if (landIfPending()) return;
    filePrev();
  } else {
    selPrev();
  }
}

// ================= 拖动 =================
// 手柄两处：标题栏（hub-head）+ 底栏空白区（hub-foot 的 cnt/keys）；按钮/输入框由
// dragStart 的 closest('input, button') 守卫排除，不触发拖移
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
  if (matchTimer) clearTimeout(matchTimer);
});

// 打开面板即聚焦输入框（全局模式可能有上次关键词，全选便于直接覆盖输入）
onMounted(() => {
  ipt.value?.focus();
  ipt.value?.select();
});

const footCount = computed(() =>
  props.mode === 'file'
    ? fileMatches.value.length
      ? t('search.filePos', { cur: fileCur.value + 1, total: fileMatches.value.length })
      : t('search.zeroResults')
    : t('search.nResults', { n: search.total }),
);

const switchLabel = computed(() => (props.mode === 'file' ? t('search.switchToGlobal') : t('search.switchToFile')));

// ================= 文件内替换（仅 CodeMirror 系引擎：md / code / 文本；.mh 不提供）=================
/** 替换文本；空串即「删除命中」 */
const replaceWith = ref('');

/**
 * 发出替换请求：关键词、大小写、命中序号都由面板带过去——面板是命中列表的真相源，
 * Workbench 只按同一口径算出文档偏移并交引擎落盘（引擎 dispatch → on-change → markDirty → 自动保存）。
 * 「替换当前」后面板留在原序号：列表随 tab.content 重算，同序号自然指向下一处，越界则回绕。
 */
function doReplace(mode: ReplaceRequest['mode']): void {
  if (fileMatches.value.length === 0) return;
  emit('replace', {
    mode,
    keyword: keyword.value,
    replacement: replaceWith.value,
    caseSensitive: caseSensitive.value,
    index: fileCur.value,
  });
  if (mode === 'all') return;
  void nextTick(() => {
    if (fileMatches.value.length === 0) return;
    if (fileCur.value >= fileMatches.value.length) fileCur.value = 0;
    gotoFile(fileCur.value);
  });
}
/** 底栏切换提示：显示"另一个模式"的实际快捷键（文件内=⌘/Ctrl+P 去全局 / 全局=⌘/Ctrl+F 回文件内），Mac 用 ⌘ 符号 */
const switchKey = computed(() => `${modKey()} + ${props.mode === 'file' ? 'P' : 'F'}`);
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
        :title="t('search.scopeTitle', { cur: mode === 'file' ? t('search.modeFile') : t('search.modeGlobal') })"
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
        :placeholder="mode === 'file' ? t('search.placeholderFile') : t('search.placeholderGlobal')"
        spellcheck="false"
        @keydown.enter.prevent="onEnter"
        @keydown.down.prevent="onDown"
        @keydown.up.prevent="onUp"
      />
      <button class="opt" :class="{ on: caseSensitive }" :title="t('search.caseSensitive')" @click="caseSensitive = !caseSensitive">Aa</button>
      <button
        v-if="mode === 'global'"
        class="opt"
        :class="{ on: search.isRegex }"
        :title="t('search.regex')"
        @click="search.isRegex = !search.isRegex"
      >
        .*
      </button>
      <button
        v-if="mode === 'global'"
        class="opt"
        :class="{ on: search.includeGlob === '*.md' }"
        :title="t('search.onlyMarkdown')"
        @click="search.includeGlob = search.includeGlob === '*.md' ? null : '*.md'"
      >
        M↓
      </button>
      <button class="close" :title="t('search.closeTitle')" @click="emit('close')">×</button>
    </div>

    <!-- 替换行：只在文件内模式、引擎支持文本级替换（md / code / 文本，.mh 不支持）且已有关键词时出现。
         Enter = 替换当前并跳到下一处 -->
    <div v-if="mode === 'file' && canReplace && keyword" class="hub-replace">
      <input
        v-model="replaceWith"
        class="ipt"
        :placeholder="t('search.replacePlaceholder')"
        spellcheck="false"
        @keydown.enter.prevent="doReplace('one')"
      />
      <button class="opt" :disabled="!fileMatches.length" :title="t('search.replaceOneHint')" @click="doReplace('one')">
        {{ t('search.replaceOne') }}
      </button>
      <button class="opt" :disabled="!fileMatches.length" :title="t('search.replaceAllHint')" @click="doReplace('all')">
        {{ t('search.replaceAll') }}
      </button>
    </div>

    <!-- 结果区 -->
    <div ref="bodyRef" class="hub-body">
      <!-- 文件内查找 -->
      <template v-if="mode === 'file'">
        <p v-if="!tabs.activeTab" class="hint center">{{ t('search.openDocFirst') }}</p>
        <p v-else-if="!keyword" class="hint center">{{ t('search.startTyping') }}</p>
        <p v-else-if="!fileMatches.length" class="hint center">{{ t('search.noMatch') }}</p>
        <button
          v-for="(m, i) in fileMatches"
          v-else
          :key="`${m.line}:${m.column}`"
          class="hit"
          :class="{ sel: i === fileCur }"
          :title="t('search.lineLocate', { line: m.line })"
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
        <p v-if="!ws.root" class="hint center">{{ t('search.openWorkspaceFirst') }}</p>
        <p v-else-if="search.error" class="hint center err">{{ search.error }}</p>
        <p v-else-if="search.searching" class="hint center">{{ t('search.searching') }}</p>
        <p v-else-if="!keyword && !search.hits.length" class="hint center">{{ t('search.startTyping') }}</p>
        <p v-else-if="!search.hits.length" class="hint center">{{ t('search.noHits') }}</p>
        <div v-for="[relPath, hits] in groups" v-else :key="relPath" class="group">
          <div class="file-name" :title="hits[0].hit.path">{{ relPath }}</div>
          <button
            v-for="{ hit: h, segs } in hits"
            :key="`${h.path}:${h.line}:${h.column}`"
            class="hit"
            :class="{ sel: flatHits[selIdx] === h }"
            :title="isTextLike(h.path) ? t('search.lineOpen', { line: h.line }) : t('search.lineOpenSystem', { line: h.line })"
            @click="openHit(h)"
          >
            <span class="line-no">L{{ h.line }}</span>
            <span class="line-text">{{ segs[0] }}<mark>{{ segs[1] }}</mark>{{ segs[2] }}</span>
          </button>
        </div>
      </template>
    </div>

    <!-- 底栏：结果数 + 快捷键提示 + 模式切换；空白区（cnt/keys）同为拖动手柄，与标题栏一致 -->
    <div class="hub-foot" @pointerdown="dragStart" @pointermove="dragMove" @pointerup="dragEnd" @pointercancel="dragEnd">
      <span class="cnt">{{ footCount }}</span>
      <span class="keys">
        <kbd>↑</kbd><kbd>↓</kbd> {{ t('search.nav') }}
        <kbd>↵</kbd> {{ t('search.select') }}
        <kbd>ESC</kbd> {{ t('search.close') }}
      </span>
      <button class="mode-switch" :title="t('search.switchTo', { key: switchKey, label: switchLabel })" @click="toggleMode">
        <kbd>{{ switchKey }}</kbd> {{ switchLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.hub {
  position: fixed;
  /* 10100+ 层级带：编辑器「页面全屏」层（内核 z-index 10000 的 fixed 铺满层）
     会盖住旧的 80，全屏状态下 Ctrl+F 面板将完全看不见 */
  z-index: var(--mk-z-panel);
  /* 尺寸：480×360 —— 比首版的 560×420 收一档，正文区还能放下 8~9 条结果，
     同时不挡编辑器上下文（飞总 2026-10-23：长宽都小一点） */
  width: 480px;
  max-width: calc(100vw - 24px);
  height: 360px;
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
.opt:disabled { opacity: 0.4; cursor: default; }

/* ---- 替换行：与标题栏同族但更矮，避免抢查找输入的视觉重心 ---- */
.hub-replace {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--mk-border);
  background: var(--mk-panel);
}
.hub-replace .ipt { font-size: 13px; }

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

/* ---- 底栏（空白区同为拖动手柄：cursor 对齐标题栏；按钮自身 pointer 优先） ---- */
.hub-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-top: 1px solid var(--mk-border);
  font-size: 12px;
  color: var(--mk-fg-muted);
  cursor: grab;
}
.hub-foot:active { cursor: grabbing; }
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
