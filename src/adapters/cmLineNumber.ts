/**
 * CM6 行号属性装饰：给可视区每一行挂 data-ln="行号"，行号本体由 CSS 伪元素画在 .cm-content
 * 左侧留白里（样式见 MdEditorV3Engine.vue）。
 *
 * 为什么不引 @codemirror/gutter：本机镜像源只有 0.19 那一代（会拖进 @codemirror/state@0.19
 * 等一整套冲突依赖），而我们要的只是「显示行号」这一件事——属性 + 伪元素足够，且切换开关
 * 只是挂/摘一个 class，不需要重配扩展、也不用补发空事务让视图重算。
 *
 * 与 cmHeadingLine.ts 一样走 md-editor-v3 的全局 codeMirrorExtensions 通路注入（mdRendererConfig.ts）。
 * 代价（相对真 gutter）：关闭自动换行时横向滚动，行号会随文本一起滚走；应用默认开着 wordWrap，
 * 正常写作不受影响。
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // 只覆盖可视区：CM 本就只渲染可见行，全篇挂属性是白白开销
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      builder.add(line.from, line.from, Decoration.line({ attributes: { 'data-ln': String(line.number) } }));
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const lineNumberAttrExtension: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
