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
import { codeDarkTheme, codeLightTheme } from './codeTheme';
import { buildLanguageExtensions } from './codeLanguage';
import type { ThemeKind } from '../api/types';

const props = defineProps<{
  modelValue: string;
  theme: ThemeKind;
  /** 文档路径（null = 未保存新建）：同一组件实例切换文件时按新扩展名重载语言包 */
  path: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
  (e: 'cursor', pos: { line: number; col: number }): void;
}>();

const rootRef = ref<HTMLElement | null>(null);
let view: EditorView | null = null;

const themeComp = new Compartment();
const langComp = new Compartment();

function extOf(p: string | null): string {
  if (!p) return '';
  const dot = p.toLowerCase().lastIndexOf('.');
  return dot > 0 ? p.slice(dot + 1) : '';
}

/** 光标位置 → 状态栏 L:C 口径（与 MdEditorV3Engine 的 emit 一致） */
function emitCursor(): void {
  if (!view) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  emit('cursor', { line: line.number, col: head - line.from + 1 });
}

async function loadLanguage(ext: string): Promise<void> {
  const extensions = await buildLanguageExtensions(ext);
  view?.dispatch({ effects: langComp.reconfigure(extensions) });
}

onMounted(() => {
  if (!rootRef.value) return;
  view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        mkFindExtension,
        themeComp.of(props.theme === 'dark' ? codeDarkTheme : codeLightTheme),
        langComp.of([]),
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

function highlight(keyword: string, caseSensitive = false): void {
  setCmFind({ keyword, caseSensitive });
}

function clearHighlight(): void {
  setCmFind({ keyword: '', caseSensitive: false });
}

defineExpose({ scrollToLine, insert, highlight, clearHighlight });

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <!-- 选区/光标色按亮暗注入（不透明标准选区蓝，VS Code 规范色；低透明度选区在白底上不可见） -->
  <div
    ref="rootRef"
    class="code-editor-engine"
    :style="{
      '--mk-cm-sel': theme === 'dark' ? '#264f78' : '#add6ff',
      '--mk-cm-caret': theme === 'dark' ? '#58a6ff' : '#0969da',
      '--mk-cm-active': theme === 'dark' ? 'rgba(255, 255, 255, 0.055)' : 'rgba(0, 0, 0, 0.045)',
    }"
  ></div>
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
