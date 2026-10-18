/**
 * ★ 文件内查找的 CodeMirror 6 关键词高亮扩展（md 编辑/分栏与代码引擎共用；md 引擎经
 * md-editor-v3 全局 config 的 codeMirrorExtensions 钩子注入，业务层勿用）。
 *
 * 设计：
 * - StateField 保存查找态（关键词 + 大小写 + 当前命中），经 StateEffect 派发更新；
 * - ViewPlugin 按可视区增量构建 mark Decoration（大文档也不会全量扫描）；
 * - 模块级**不保留**「当前活跃视图」单例：三引擎常驻并存后（2026-10-17），md 与代码引擎的
 *   CM 实例可同时存活，「谁最后挂载谁占用全局指针」会把高亮派发到看不见的实例上。
 *   改为调用方（引擎）显式把自己的 view 传给 setCmFind()，本模块只做装饰与派发。
 * - 带 matchIndex 时把第 n 个命中落成**真实选区**并居中：面板 Enter / ↑↓ 逐条走查时，
 *   内容侧除了底色还能看出"这一条是当前命中"，且能直接 Ctrl+C 或键入替换。
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/** 调用方给的查找请求：当前命中按全文序号指定 */
export interface FindRequest {
  keyword: string;
  caseSensitive: boolean;
  /** 当前命中序号（0-based，口径 = 搜索面板命中列表）；省略 / 负数 = 只画高亮，不定位 */
  matchIndex?: number;
}

/** 查找态 = 请求 + 解析出的当前命中偏移（-1 = 无当前命中） */
export interface FindState extends Required<FindRequest> {
  curFrom: number;
  curTo: number;
}

const NO_HIT = { matchIndex: -1, curFrom: -1, curTo: -1 };

/** 查找态更新效果 */
const setFindEffect = StateEffect.define<FindState>();

const findField = StateField.define<FindState>({
  create: () => ({ keyword: '', caseSensitive: false, ...NO_HIT }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindEffect)) return e.value;
    }
    // 文档一改，上一轮的命中偏移就不可信（装饰会错位）：清掉，等下一次导航重算
    return tr.docChanged ? { ...value, ...NO_HIT } : value;
  },
});

const MARK_CAP = 2000; // 与全局搜索同量级的上限兜底
const markDeco = Decoration.mark({ class: 'mk-cm-find' });
const curDeco = Decoration.mark({ class: 'mk-cm-find mk-cm-find-cur' });

/** 关键词按字面量匹配（与面板的 indexOf 同口径：正则元字符不特殊处理） */
function findRegExp(keyword: string, caseSensitive: boolean): RegExp {
  return new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
}

/** 第 index 个命中的绝对偏移。要在全篇序上数（可视区里的第 k 个 ≠ 全文第 k 个），
 *  故整串扫一遍——面板本就每 150ms 全量 split+scan 出命中列表，量级一致 */
function nthMatchRange(doc: string, re: RegExp, index: number): { from: number; to: number } | null {
  if (index < 0) return null;
  re.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // 空匹配防御：强制推进
      continue;
    }
    if (n++ === index) return { from: m.index, to: m.index + m[0].length };
  }
  return null;
}

function buildDecorations(view: EditorView): DecorationSet {
  const { keyword, caseSensitive, curFrom, curTo } = view.state.field(findField);
  if (!keyword) return Decoration.none;
  const re = findRegExp(keyword, caseSensitive);
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
      const s = from + m.index;
      const e = s + m[0].length;
      builder.add(s, e, s === curFrom && e === curTo ? curDeco : markDeco);
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
 * 请求未带当前命中（关面板 / 仅输入关键词）时不动选区：关掉面板后光标留在原处。
 */
export function setCmFind(view: EditorView | null, req: FindRequest): boolean {
  if (!view) return false;
  const { keyword, caseSensitive, matchIndex = -1 } = req;
  const cur = view.state.field(findField, false);
  if (cur && cur.keyword === keyword && cur.caseSensitive === caseSensitive && cur.matchIndex === matchIndex) {
    return true;
  }
  const range = keyword ? nthMatchRange(view.state.doc.toString(), findRegExp(keyword, caseSensitive), matchIndex) : null;
  const next: FindState = {
    keyword,
    caseSensitive,
    matchIndex: range ? matchIndex : -1,
    curFrom: range?.from ?? -1,
    curTo: range?.to ?? -1,
  };
  const effects: StateEffect<unknown>[] = [setFindEffect.of(next)];
  const tr: TransactionSpec = { effects };
  if (range) {
    tr.selection = { anchor: range.from, head: range.to };
    effects.push(EditorView.scrollIntoView(range.from, { y: 'center' }));
  }
  view.dispatch(tr);
  return true;
}
