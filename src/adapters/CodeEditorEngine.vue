<script setup lang="ts">
/**
 * ★ 代码编辑引擎（CodeMirror 6 自建装配，2026-10-09）。
 * 实现 CommonEngineHandle 契约（IMarkdownEngine.ts）；Markdown 专属方法
 * （wrapSelection/setHeading/togglePageFullscreen/exportPdf）刻意不暴露。
 * 语言包按扩展名动态 import（不进首屏 chunk，D4）；亮暗主题经 Compartment 切换。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';

import { mkFindExtension, setCmFind } from './findHighlight';
import { focusLineExtension, setFocusMode } from './cmFocusLine';
import { captureScrollTop, restoreScrollTop } from './scrollRestore';
import { codeDarkTheme, codeLightTheme } from './codeTheme';
import { buildLanguageExtensions } from './codeLanguage';
import type { EditorCtxPayload } from './IMarkdownEngine';
import type { ThemeKind } from '../api/types';

const props = defineProps<{
  modelValue: string;
  theme: ThemeKind;
  /** 文档路径（null = 未保存新建）：同一组件实例切换文件时按新扩展名重载语言包 */
  path: string | null;
  /** 专注模式（设置-编辑器，与 md 引擎同一开关）：当前段落清晰、其余行淡出 */
  focusMode?: boolean;
  /** 自动换行（设置 codeLineWrap，默认关）：开则长行折到下一视觉行，关则横向滚动。
   *  md 内核的换行由 md-editor-v3 恒开，这一档只管本引擎（长 URL / 长日志此前会被截断） */
  lineWrap?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
  (e: 'cursor', pos: { line: number; col: number }): void;
  /** 编辑区右键：上层在同一坐标弹编辑菜单（刷新 / 全屏 / 专注模式 / 搜索·复制·粘贴代码） */
  (e: 'editorContext', pos: EditorCtxPayload): void;
}>();

const rootRef = ref<HTMLElement | null>(null);
let view: EditorView | null = null;

/** 语言加载请求序号（P1-3）：快速切文件时旧 loader 后返回不得 reconfigure，防语言包错配 */
let langSeq = 0;

const themeComp = new Compartment();
const langComp = new Compartment();
const wrapComp = new Compartment();

/** 语言查找键：取路径最后一段完整文件名（codeLanguage 先查文件名表再查扩展名表，
 *  Cargo.lock / Dockerfile / .editorconfig 等特殊全名才能命中） */
function extOf(p: string | null): string {
  if (!p) return '';
  return p.split(/[\\/]/).pop() ?? '';
}

/** 光标位置 → 状态栏 L:C 口径（与 MdEditorV3Engine 的 emit 一致） */
function emitCursor(): void {
  if (!view) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  emit('cursor', { line: line.number, col: head - line.from + 1 });
}

async function loadLanguage(ext: string): Promise<void> {
  const mySeq = ++langSeq;
  const extensions = await buildLanguageExtensions(ext);
  if (mySeq !== langSeq) return; // 过期请求（已切走）：直接丢弃，不 reconfigure
  view?.dispatch({ effects: langComp.reconfigure(extensions) });
}

// 专注模式：开关写进 cmFocusLine 的模块级标志（构造期即读取，故首挂也生效）；
// 空事务只为触发 ViewPlugin 重算装饰，不改文档内容
watch(
  () => props.focusMode,
  (on) => {
    setFocusMode(!!on);
    view?.dispatch({});
  },
  { immediate: true },
);

onMounted(() => {
  if (!rootRef.value) return;
  view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        mkFindExtension,
        focusLineExtension,
        themeComp.of(props.theme === 'dark' ? codeDarkTheme : codeLightTheme),
        langComp.of([]),
        wrapComp.of(props.lineWrap ? EditorView.lineWrapping : []),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              emit('save');
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString());
          if (u.selectionSet || u.focusChanged) emitCursor();
        }),
      ],
    }),
    parent: rootRef.value,
  });
  void loadLanguage(extOf(props.path));
});

// 同一实例切换文件：按新扩展名重载语言包
watch(
  () => props.path,
  (p) => {
    void loadLanguage(extOf(p));
  },
);

// 外部内容替换（切文件/会话恢复/另存）：仅在与当前 doc 不同时回写，避免光标跳回文档头
watch(
  () => props.modelValue,
  (v) => {
    if (!view || view.state.doc.toString() === v) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  },
);

// 亮暗主题跟随设置（Compartment 重配，不重建视图）
watch(
  () => props.theme,
  (t) => {
    view?.dispatch({
      effects: themeComp.reconfigure(t === 'dark' ? codeDarkTheme : codeLightTheme),
    });
  },
);

// 自动换行开关：只重配 lineWrapping 一项，撤销栈、光标与滚动位置都不动
watch(
  () => props.lineWrap,
  (on) => {
    view?.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) });
  },
);

/** 滚动到指定行（1-based；headingIndex 为 Markdown 契约参数，代码引擎忽略） */
function scrollToLine(line: number, _headingIndex?: number): void {
  if (!view) return;
  const n = Math.min(Math.max(1, Math.round(line)), view.state.doc.lines);
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'center' }),
  });
}

function insert(text: string): void {
  if (!view) return;
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

/** 右键「复制代码」的取文口径：选区优先，无选区取全文 */
function copyScopeText(): string {
  if (!view) return '';
  const sel = view.state.selection.main;
  return sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
}

/** 右键：收掉浏览器原生菜单，把光标落到点击处再上报（与另外两个引擎同一套上层菜单）。
 *  点击落在已有选区内则保留选区——否则「复制代码」会把要复制的选区自己取消掉 */
function onContextMenu(e: MouseEvent): void {
  if (!view) return;
  e.preventDefault();
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos != null) {
    const sel = view.state.selection.main;
    if (pos < sel.from || pos > sel.to) view.dispatch({ selection: { anchor: pos } });
  }
  view.focus();
  emit('editorContext', { x: e.clientX, y: e.clientY, inTable: false, wideAlignable: false, engine: 'code' });
}

/** 查找高亮：matchIndex = 当前命中序号（搜索面板列表口径），带上时强化标记并落成真实选区 */
function highlight(keyword: string, caseSensitive = false, matchIndex?: number): void {
  setCmFind(view, { keyword, caseSensitive, matchIndex });
}

/** 替换一处（偏移以全文为基准，与 tab.content 同源）；先比对 expect 再动手 */
function replaceRange(from: number, to: number, replacement: string, expect: string): boolean {
  if (!view) return false;
  if (view.state.doc.sliceString(from, to) !== expect) return false;
  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: { anchor: from + replacement.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** 整篇替换：单事务完成全部命中，一步撤销即可整体回退 */
function replaceDocText(nextText: string, baseText: string): boolean {
  if (!view) return false;
  if (view.state.doc.toString() !== baseText) return false;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextText } });
  view.focus();
  return true;
}

function clearHighlight(): void {
  setCmFind(view, { keyword: '', caseSensitive: false });
}

/** 按标签保存/恢复滚动位置（引擎常驻 v-show：隐藏会清 0，位置得由上层存） */
function captureScroll(): number {
  return captureScrollTop(() => view?.scrollDOM ?? null);
}

function restoreScroll(top: number): void {
  restoreScrollTop(() => view?.scrollDOM ?? null, top);
}

defineExpose({ scrollToLine, insert, copyScopeText, highlight, clearHighlight, replaceRange, replaceDocText, captureScroll, restoreScroll });

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <!-- 选区/光标/当前行色**不再内联注入**：改由 global.css 的 --mk-cm-* token 提供
       （:root 为素白、:root[data-theme='dark'] 为石墨，其余配色在各自 palette 块里覆盖）。
       内联值会以元素级声明压死 palette 覆盖，6 套配色下选区不跟随配色——这正是要避免的 -->
  <div ref="rootRef" class="code-editor-engine" @contextmenu="onContextMenu"></div>
</template>

<style scoped>
.code-editor-engine {
  height: 100%;
  min-width: 0;
  overflow: hidden;
}
/* 行号槽与编辑区同底色（主题变量由 codeTheme 布局主题接管） */
.code-editor-engine :deep(.cm-editor) {
  height: 100%;
}
</style>
