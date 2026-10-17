/**
 * ★ 文件内查找的 CodeMirror 6 关键词高亮扩展（仅供 mdRendererConfig 经
 * md-editor-v3 全局 config 的 codeMirrorExtensions 钩子注入，业务层勿用）。
 *
 * 设计：
 * - StateField 保存查找态（关键词 + 大小写），经 StateEffect 派发更新；
 * - ViewPlugin 按可视区增量构建 mark Decoration（大文档也不会全量扫描）；
 * - 模块级**不保留**「当前活跃视图」单例：三引擎常驻并存后（2026-10-17），md 与代码引擎的
 *   CM 实例可同时存活，「谁最后挂载谁占用全局指针」会把高亮派发到看不见的实例上。
 *   改为调用方（引擎）显式把自己的 view 传给 setCmFind()，本模块只做装饰与派发。
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

export interface FindState {
  keyword: string;
  caseSensitive: boolean;
}

/** 查找态更新效果 */
const setFindEffect = StateEffect.define<FindState>();

const findField = StateField.define<FindState>({
  create: () => ({ keyword: '', caseSensitive: false }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindEffect)) return e.value;
    }
    return value;
  },
});

const MARK_CAP = 2000; // 与全局搜索同量级的上限兜底
const markDeco = Decoration.mark({ class: 'mk-cm-find' });

function buildDecorations(view: EditorView): DecorationSet {
  const { keyword, caseSensitive } = view.state.field(findField);
  if (!keyword) return Decoration.none;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
  const builder = new RangeSetBuilder<Decoration>();
  let count = 0;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && count < MARK_CAP) {
      if (m[0].length === 0) {
        re.lastIndex += 1; // 空匹配防御：强制推进
        continue;
      }
      builder.add(from + m.index, from + m.index + m[0].length, markDeco);
      count += 1;
    }
  }
  return builder.finish();
}

const findHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      const findChanged = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setFindEffect)),
      );
      if (findChanged || u.docChanged || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---- 无全局视图跟踪：目标视图由调用方显式传入（见文件头设计说明） ----

/** 注入 md-editor-v3 codeMirrorExtensions 的扩展集（其包装类型要求 { type, extension }） */
export const mkFindExtension: Extension = [findField, findHighlightPlugin];

/**
 * 设置指定编辑器实例的查找态。返回 false = 传入视图缺失
 * （md 引擎阅读态没有编辑器实例，属正常情况，预览侧由引擎的 DOM 高亮承担）。
 */
export function setCmFind(view: EditorView | null, state: FindState): boolean {
  if (!view) return false;
  const cur = view.state.field(findField, false);
  if (cur && cur.keyword === state.keyword && cur.caseSensitive === state.caseSensitive) {
    return true;
  }
  view.dispatch({ effects: setFindEffect.of(state) });
  return true;
}
