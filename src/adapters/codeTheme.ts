/**
 * ★ 代码编辑引擎主题（CodeMirror 6）。
 * 布局与交互层颜色全部绑定应用 --mk-* 变量（亮/暗随宿主 .dark 类自动跟随）；
 * 语法 token 采用「GitHub Light / GitHub Dark」同源设计语言的自建配色
 * （关键词红、函数紫、类型橙、字符串浅蓝、注释灰斜体、标签/正则绿），
 * 替换 CM 内置 defaultHighlightStyle（亮色区分度不足）与 oneDark（与亮色风格断裂）。
 * 选区/光标色经组件根注入的 --mk-cm-sel / --mk-cm-caret 按亮暗切换。
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as tg } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const MONO = "Consolas, 'Cascadia Mono', 'Microsoft YaHei', monospace";

/** 亮/暗共用的布局主题：颜色经 CSS 变量跟随应用主题，无需运行时重建 */
const layoutTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--mk-font-size, 15px)',
    color: 'var(--mk-fg)',
    backgroundColor: 'var(--mk-bg)',
  },
  '.cm-scroller': {
    fontFamily: MONO,
    lineHeight: '1.65',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--mk-cm-caret, var(--mk-accent))',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--mk-cm-caret, var(--mk-accent))',
    borderLeftWidth: '2px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--mk-cm-sel, var(--mk-accent-weak)) !important',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--mk-bg)',
    color: 'var(--mk-fg-muted)',
    border: 'none',
    fontFamily: MONO,
    fontSize: '0.86em',
  },
  /* 当前行高亮必须半透明：CM6 选区层 z-index=-2 画在行背景之下，
     不透明背景（如 --mk-panel-muted）会把拖选的选区整段盖住 */
  '.cm-activeLine': { backgroundColor: 'var(--mk-cm-active, rgba(0, 0, 0, 0.045))' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--mk-cm-active, rgba(0, 0, 0, 0.045))' },
  '.cm-selectionMatch': { backgroundColor: 'var(--mk-accent-weak)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--mk-panel)',
    color: 'var(--mk-fg)',
    border: '1px solid var(--mk-border-strong)',
    borderRadius: 'var(--mk-radius-sm, 4px)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: MONO,
    maxHeight: '14em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--mk-hover)',
    color: 'var(--mk-fg)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--mk-panel)',
    color: 'var(--mk-fg)',
    borderColor: 'var(--mk-border)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--mk-accent-weak)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '2.2em' },
});

/** 亮色 token（GitHub Light 风格）：白底上高区分度、中等饱和 */
const lightTokens = HighlightStyle.define([
  { tag: tg.comment, color: '#6e7781', fontStyle: 'italic' },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName)], color: '#8250df' },
  { tag: [tg.keyword, tg.modifier, tg.operatorKeyword, tg.controlKeyword, tg.moduleKeyword], color: '#cf222e' },
  { tag: [tg.typeName, tg.className, tg.namespace], color: '#953800' },
  { tag: [tg.definition(tg.variableName), tg.definition(tg.propertyName)], color: '#953800' },
  { tag: [tg.number, tg.bool, tg.null, tg.atom], color: '#0550ae' },
  { tag: [tg.string, tg.special(tg.string), tg.character], color: '#0a3069' },
  { tag: [tg.regexp, tg.escape], color: '#116329' },
  { tag: [tg.propertyName], color: '#0550ae' },
  { tag: [tg.tagName], color: '#116329' },
  { tag: [tg.attributeName], color: '#0550ae' },
  { tag: [tg.attributeValue], color: '#0a3069' },
  { tag: [tg.name, tg.variableName, tg.labelName], color: '#24292f' },
  { tag: [tg.operator, tg.punctuation, tg.separator, tg.bracket, tg.self, tg.angleBracket], color: '#57606a' },
  { tag: [tg.standard(tg.variableName)], color: '#0550ae' },
  { tag: [tg.heading], color: '#0550ae', fontWeight: 'bold' },
  { tag: [tg.contentSeparator], color: '#cf222e' },
  { tag: tg.link, color: '#0a3069', textDecoration: 'underline' },
  { tag: tg.meta, color: '#57606a' },
  { tag: tg.invalid, color: '#82071e' },
]);

/** 暗色 token（GitHub Dark 风格）：与亮色同一设计语言，深底高对比 */
const darkTokens = HighlightStyle.define([
  { tag: tg.comment, color: '#8b949e', fontStyle: 'italic' },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName)], color: '#d2a8ff' },
  { tag: [tg.keyword, tg.modifier, tg.operatorKeyword, tg.controlKeyword, tg.moduleKeyword], color: '#ff7b72' },
  { tag: [tg.typeName, tg.className, tg.namespace], color: '#ffa657' },
  { tag: [tg.definition(tg.variableName), tg.definition(tg.propertyName)], color: '#ffa657' },
  { tag: [tg.number, tg.bool, tg.null, tg.atom], color: '#79c0ff' },
  { tag: [tg.string, tg.special(tg.string), tg.character], color: '#a5d6ff' },
  { tag: [tg.regexp, tg.escape], color: '#7ee787' },
  { tag: [tg.propertyName], color: '#79c0ff' },
  { tag: [tg.tagName], color: '#7ee787' },
  { tag: [tg.attributeName], color: '#79c0ff' },
  { tag: [tg.attributeValue], color: '#a5d6ff' },
  { tag: [tg.name, tg.variableName, tg.labelName], color: '#e6edf3' },
  { tag: [tg.operator, tg.punctuation, tg.separator, tg.bracket, tg.self, tg.angleBracket], color: '#8b949e' },
  { tag: [tg.standard(tg.variableName)], color: '#79c0ff' },
  { tag: [tg.heading], color: '#79c0ff', fontWeight: 'bold' },
  { tag: [tg.contentSeparator], color: '#ff7b72' },
  { tag: tg.link, color: '#a5d6ff', textDecoration: 'underline' },
  { tag: tg.meta, color: '#8b949e' },
  { tag: tg.invalid, color: '#f85149' },
]);

/** 亮色：自建 GitHub Light token 配色（非 fallback：覆盖 CM 内建 defaultHighlightStyle） */
export const codeLightTheme: Extension[] = [
  layoutTheme,
  syntaxHighlighting(lightTokens),
];

/** 暗色：自建 GitHub Dark token 配色 */
export const codeDarkTheme: Extension[] = [
  layoutTheme,
  syntaxHighlighting(darkTokens),
];
