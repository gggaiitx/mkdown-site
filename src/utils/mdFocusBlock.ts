/**
 * 专注模式的「当前段落」判定：段落 = 从光标行向两侧扩到空行为止。
 * 空行是 Markdown 的块分隔符，因此标题、表格、列表（内部无空行）各算一整块，不会被拆散。
 * 纯函数层与 utils/mdLineFormat.ts 同一分工：只吃「第 n 行是否空行」的取值器，便于脱浏览器单测。
 */

export interface BlockRange {
  /** 起始行下标（0-based，含） */
  start: number;
  /** 结束行下标（0-based，含） */
  end: number;
}

/**
 * 返回包含 caret 的段落行区间。
 * caret 落在空行上时退化为该行自身（不越窗去够上下段落，避免高亮块随滚动跳动）。
 */
export function blockRangeAround(
  caret: number,
  isBlankAt: (lineIndex: number) => boolean,
  lineCount: number,
): BlockRange {
  const at = Math.min(Math.max(caret, 0), Math.max(lineCount - 1, 0));
  if (lineCount === 0 || isBlankAt(at)) return { start: at, end: at };
  let start = at;
  while (start > 0 && !isBlankAt(start - 1)) start--;
  let end = at;
  while (end < lineCount - 1 && !isBlankAt(end + 1)) end++;
  return { start, end };
}
