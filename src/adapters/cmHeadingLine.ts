/**
 * CM6 行装饰：给以 # 开头的 ATX 标题行整行挂 mk-cm-heading 类。
 *
 * 为什么不用 CSS 选择器：CM6 的 markdown token 类名是混淆名（ͼ11 之类），
 * 随构建版本漂移，无法稳定定位标题行；用 Decoration.line 挂自有类最稳。
 * 字号 +2px 由引擎样式 .mk-cm-heading 控制（跟随 --mk-font-size 缩放）。
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';

/** ATX 标题行：行首 1-6 个 #，后跟空白或行尾（#自身也算，覆盖空标题） */
const ATX_RE = /^#{1,6}(\s|$)/;

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  // 只扫可视区，大文档无全量开销；文档/视口变化时重建
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (ATX_RE.test(line.text)) {
        b.add(line.from, line.from, Decoration.line({ class: 'mk-cm-heading' }));
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

export const headingLineExtension: Extension = ViewPlugin.fromClass(
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
