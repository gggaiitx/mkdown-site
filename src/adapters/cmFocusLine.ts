/**
 * CM6 行装饰：专注模式下，除「当前段落」外的可见行挂 mk-focus-dim 类（淡出）。
 *
 * 与 cmHeadingLine.ts 同一注入通路——md-editor-v3 的全局 codeMirrorExtensions 钩子
 * （见 mdRendererConfig.ts）；CodeEditorEngine 自建 Editor 时直接把本扩展塞进 extensions 数组，
 * 两个引擎共用同一份实现与同一个模块级开关（同一时刻只有一个 CM 引擎在场）。
 * 富文本 .mh 没有 CM 视图，由 WangEditorEngine 给 Slate 顶层块挂同一个类（样式在 global.css）。
 *
 * 段落 = 光标所在处向两侧扩到空行为止（算法在 utils/mdFocusBlock.ts），
 * 所以标题、表格、列表各自成块，不会被逐行拆开。空行本身不压暗：段间距观感保持不变。
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { blockRangeAround } from '../utils/mdFocusBlock';

let focusEnabled = false;

/** 引擎在设置变更与挂载时写入（扩展构造期即读取，故首挂也生效） */
export function setFocusMode(enabled: boolean): void {
  focusEnabled = enabled;
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (!focusEnabled) return builder.finish();
  const { doc } = view.state;
  const caret = doc.lineAt(view.state.selection.main.head).number - 1;
  const { start, end } = blockRangeAround(
    caret,
    (index) => doc.line(index + 1).text.trim() === '',
    doc.lines,
  );
  // 只扫可视区：CM 本就只渲染可见行，全篇建装饰集是白白开销
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      const index = line.number - 1;
      if ((index < start || index > end) && line.text.trim() !== '') {
        builder.add(line.from, line.from, Decoration.line({ class: 'mk-focus-dim' }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const focusLineExtension: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(u: ViewUpdate) {
      // 光标移动（selectionSet 会体现在事务里）与滚动都要重算；
      // 空事务（开关切换后引擎补发的一次 dispatch）同样触发，故判 transactions 而非仅 docChanged
      if (u.transactions.length > 0 || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
