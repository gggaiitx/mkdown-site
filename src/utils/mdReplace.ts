/**
 * 全文替换的纯计算层：命中区间与替换结果都在这里算，引擎只做「校验后落盘到文档」。
 *
 * 匹配口径与查找面板（SearchHub.fileMatches）严格一致——**只在行内匹配**，
 * 关键词含换行时不算命中。这样面板显示的「第 k 处 / 共 n 处」与这里返回的第 k 个区间
 * 永远对应同一处文本，否则「替换当前」会替错地方。
 */

export interface MatchRange {
  /** 文档内起始偏移（含） */
  from: number;
  /** 文档内结束偏移（不含） */
  to: number;
}

/** 查找面板发给 Workbench 的替换请求：关键词与大小写由面板持有（它才是命中列表的真相源），
 *  index 是面板「第 k 处」的序号，与 findMatchRanges 的返回顺序一一对应 */
export interface ReplaceRequest {
  mode: 'one' | 'all';
  keyword: string;
  replacement: string;
  caseSensitive: boolean;
  index: number;
}

/** 命中数上限：与查找面板同款兜底，超大文档不至于把主线程吃死 */
const MATCH_CAP = 2000;

/** 按行扫描关键词，返回文档偏移区间列表（行内匹配，顺序 = 逐行从左到右） */
export function findMatchRanges(text: string, keyword: string, caseSensitive: boolean): MatchRange[] {
  if (keyword.length === 0) return [];
  const out: MatchRange[] = [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const hayLine = hay.slice(lineStart, lineStart + line.length);
    let from = 0;
    for (;;) {
      const at = hayLine.indexOf(needle, from);
      if (at < 0) break;
      out.push({ from: lineStart + at, to: lineStart + at + needle.length });
      if (out.length >= MATCH_CAP) return out;
      from = at + Math.max(1, needle.length); // 空串防御：强制推进
    }
    lineStart += line.length + 1; // 跨过换行符
  }
  return out;
}

/**
 * 全部替换：返回新文本与替换处数。
 * 未命中时原样返回（count=0），调用方据此决定要不要动文档——避免空事务白标脏。
 */
export function replaceAll(
  text: string,
  keyword: string,
  replacement: string,
  caseSensitive: boolean,
): { text: string; count: number } {
  const ranges = findMatchRanges(text, keyword, caseSensitive);
  if (ranges.length === 0) return { text, count: 0 };
  let next = '';
  let cursor = 0;
  for (const r of ranges) {
    next += text.slice(cursor, r.from) + replacement;
    cursor = r.to;
  }
  next += text.slice(cursor);
  return { text: next, count: ranges.length };
}
