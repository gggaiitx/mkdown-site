/**
 * Markdown 表格辅助（纯文本层，零 DOM 依赖）：
 * 解析管道符表格块 → 行列增删 / 紧凑规整 / 等宽对齐（窄表）/ 插入骨架 / TSV·CSV 粘贴转换。
 * 调用方（引擎层）负责把区间替换回 CM6 doc。
 */

/** 分隔行表达的对齐方式（GFM 冒号语义） */
export type TableAlign = 'none' | 'left' | 'center' | 'right';

export interface TableBlock {
  /** 块首行号（0 基，= 表头行） */
  startLine: number;
  /** 块末行号（含） */
  endLine: number;
  /** 表头单元格 */
  header: string[];
  /** 数据行（分隔行与表头之间） */
  rows: string[][];
  /** 各列对齐方式（长度 = header.length，缺失列按 none） */
  align: TableAlign[];
  /** 光标是否落在表头行 */
  caretOnHeader: boolean;
  /** 光标是否落在分隔行 */
  caretOnSeparator: boolean;
  /** 光标所在数据行下标（0 基；表头/分隔行 = -1 / 0） */
  caretRowIdx: number;
  /** 光标所在列（0 基，按光标左侧未转义管道数计） */
  caretCol: number;
}

/** 分隔行：| --- | :-: | ---: |（允许缺边缘管道、冒号对齐） */
const SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** 拆一行管道单元格：剥边缘管道，识别 \| 转义 */
export function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparator(line: string): boolean {
  return SEP_RE.test(line) && line.includes('-');
}

/** 光标左侧未转义管道数；用于定位所在列（左边缘管道之后即第 0 列起） */
function pipesBefore(line: string, col: number): number {
  let n = 0;
  for (let i = 0; i < col && i < line.length; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\') n++;
  }
  return n;
}

function alignOf(token: string): TableAlign {
  const l = token.startsWith(':');
  const r = token.endsWith(':');
  if (l && r) return 'center';
  if (l) return 'left';
  if (r) return 'right';
  return 'none';
}

/**
 * 在 lines 中定位光标所在表格块。块 = 含管道的连续行、首行为表头、第二行为分隔行。
 * caretLine 0 基；caretCol 为光标在 caretLine 内的列（字符数）。
 */
export function parseTable(lines: string[], caretLine: number, caretCol: number): TableBlock | null {
  if (caretLine < 0 || caretLine >= lines.length) return null;
  if (!lines[caretLine].includes('|')) return null;
  let top = caretLine;
  while (top > 0 && lines[top - 1].includes('|')) top--;
  let bottom = caretLine;
  while (bottom < lines.length - 1 && lines[bottom + 1].includes('|')) bottom++;
  if (top === bottom || !isSeparator(lines[top + 1])) return null;
  const header = splitCells(lines[top]);
  if (header.length < 1 || header.some((c) => c === '')) return null;
  const align = padRow(splitCells(lines[top + 1]), header.length).map(alignOf);
  const rows: string[][] = [];
  for (let n = top + 2; n <= bottom; n++) rows.push(splitCells(lines[n]));

  const caretOnHeader = caretLine === top;
  const caretOnSeparator = caretLine === top + 1;
  let caretRowIdx: number;
  if (caretOnSeparator) caretRowIdx = 0; // 分隔行操作按首数据行处理
  else if (caretOnHeader) caretRowIdx = -1;
  else caretRowIdx = caretLine - (top + 2);
  const caretColIdx = Math.max(0, Math.min(pipesBefore(lines[caretLine], caretCol) - 1, header.length - 1));
  return { startLine: top, endLine: bottom, header, rows, align, caretOnHeader, caretOnSeparator, caretRowIdx, caretCol: caretColIdx };
}

/** 单元格回写：裸 | 转义为 \| */
function toCell(c: string): string {
  return c.includes('\\|') ? c : c.includes('|') ? c.replace(/\|/g, '\\|') : c;
}
/** 紧凑行：每格前后各一空格，不补列宽 */
function formatRow(cells: string[]): string {
  return `| ${cells.map(toCell).join(' | ')} |`;
}

function newRow(n: number): string[] {
  return Array.from({ length: n }, () => '');
}
function padRow(r: string[], n: number): string[] {
  if (r.length >= n) return r.slice(0, n);
  return [...r, ...Array.from({ length: n - r.length }, () => '')];
}
/** 对齐数组补齐：缺失列按无对齐 */
function padAlign(a: TableAlign[], n: number): TableAlign[] {
  if (a.length >= n) return a.slice(0, n);
  return [...a, ...Array.from({ length: n - a.length }, (): TableAlign => 'none')];
}

/** 东亚宽字符按 2 列计宽（wcwidth 简化版）：等宽对齐需按显示宽度而非字符数 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首补充 … 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xfe10 && cp <= 0xfe19) || // 竖排形式
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式、小写变体
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // 表情符号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以后
  );
}
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200b || cp === 0xfeff) continue; // 零宽空格 / BOM
    w += isWideChar(cp) ? 2 : 1;
  }
  return w;
}

/** 分隔行单元：紧凑档固定 3 字符宽，等宽档补足到列宽 */
function sepToken(align: TableAlign, width?: number): string {
  if (width === undefined) {
    return align === 'left' ? ':---' : align === 'right' ? '---:' : align === 'center' ? ':---:' : '---';
  }
  const w = Math.max(3, width);
  if (align === 'center') return `:${'-'.repeat(w - 2)}:`;
  if (align === 'left') return `:${'-'.repeat(w - 1)}`;
  if (align === 'right') return `${'-'.repeat(w - 1)}:`;
  return '-'.repeat(w);
}

function columnWidths(cells: string[][]): number[] {
  const cols = cells[0].length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) widths.push(Math.max(3, ...cells.map((r) => displayWidth(r[c]))));
  return widths;
}

/** 紧凑规整（默认动作）：统一 | a | b | 语义（剥多余空白、每格左右各一空格）、分隔行规整为 --- / :---:，
 *  不补列宽——长文本表不会被撑成数百字符宽行 */
export function compactBlock(header: string[], rows: string[][], align: TableAlign[]): string[] {
  const cols = header.length;
  const cells = [header, ...rows].map((r) => padRow(r, cols));
  const a = padAlign(align, cols);
  return [formatRow(cells[0]), `| ${a.map((x) => sepToken(x)).join(' | ')} |`, ...cells.slice(1).map(formatRow)];
}

/** 等宽列对齐（窄表专用）：列宽 = 各格最大显示宽度（CJK 计 2），分隔行同宽并按对齐填充 */
export function wideBlock(header: string[], rows: string[][], align: TableAlign[]): string[] {
  const cols = header.length;
  const cells = [header, ...rows].map((r) => padRow(r, cols));
  const a = padAlign(align, cols);
  const widths = columnWidths(cells);
  const pad = (s: string, w: number) => toCell(s) + ' '.repeat(Math.max(0, w - displayWidth(s)));
  const line = (r: string[]) => `| ${r.map((cell, c) => pad(cell, widths[c])).join(' | ')} |`;
  return [line(cells[0]), `| ${widths.map((w, c) => sepToken(a[c], w)).join(' | ')} |`, ...cells.slice(1).map(line)];
}

/** 等宽对齐适用上限：补宽后单行显示宽度超过此值即视为长文本表，只提供紧凑规整 */
const WIDE_MAX_LINE_WIDTH = 160;

/** 表格是否够窄可安全等宽对齐（补列宽后不产生超长行） */
export function isWideAlignable(header: string[], rows: string[][]): boolean {
  const widths = columnWidths([header, ...rows].map((r) => padRow(r, header.length)));
  return widths.reduce((sum, w) => sum + w + 3, 1) <= WIDE_MAX_LINE_WIDTH;
}

/** 插入空表骨架（rows 个数据行 × cols 列，含表头，紧凑规整）；调用方负责换行上下文 */
export function buildTableSkeleton(rows = 2, cols = 3): string {
  const header = Array.from({ length: cols }, (_, i) => `列${i + 1}`);
  const body = Array.from({ length: rows }, () => newRow(cols));
  return compactBlock(header, body, Array.from({ length: cols }, (): TableAlign => 'none')).join('\n');
}

export type TableOp =
  | 'row-before'
  | 'row-after'
  | 'row-delete'
  | 'col-before'
  | 'col-after'
  | 'col-delete'
  | 'normalize'
  | 'align-wide';

export interface TableEditResult {
  text: string;
  /** 新文本中的建议光标偏移 */
  cursor: number;
  /** 被替换区间 [from, to)：整篇 text 内、原表格块（含尾随换行）的字符偏移。
   *  引擎据此只 dispatch 局部 change，避免整篇替换导致预览全量重渲与滚动跳变 */
  from: number;
  to: number;
  /** 新表格块文本（块内各行以 \n 连接，不含前后换行） */
  block: string;
}

/**
 * 对光标所在表格执行操作。caretOffset 为光标在整个 text 中的字符偏移。
 * 返回替换后的整篇 text 与新光标偏移；光标不在表格内（或操作不可行）返回 null。
 */
export function editTable(text: string, caretOffset: number, op: TableOp): TableEditResult | null {
  const lines = text.split('\n');
  const clampedCaret = Math.max(0, Math.min(caretOffset, text.length));
  const before = text.slice(0, clampedCaret);
  const caretLine = before.split('\n').length - 1;
  const caretCol = clampedCaret - (before.lastIndexOf('\n') + 1);
  const t = parseTable(lines, caretLine, caretCol);
  if (!t) return null;

  const cols = t.header.length;
  let header = [...t.header];
  let rows = t.rows.map((r) => padRow(r, cols));
  let align: TableAlign[] = padAlign(t.align, cols);

  if (op === 'row-before' || op === 'row-after' || op === 'row-delete') {
    if (op === 'row-delete') {
      if (t.caretOnHeader || t.caretOnSeparator) return null; // 表头/分隔行不可删
      rows = rows.filter((_, i) => i !== t.caretRowIdx);
    } else {
      // row-before：插到当前数据行之上；表头/分隔行上操作 → 插为首个数据行
      // row-after：插到当前数据行之中/之后
      const dataIdx = t.caretOnHeader ? -1 : t.caretRowIdx; // 表头视作 -1
      const insertAt = op === 'row-before' ? Math.max(dataIdx, 0) : dataIdx + 1;
      rows = [...rows.slice(0, insertAt), newRow(cols), ...rows.slice(insertAt)];
    }
  } else if (op === 'col-before' || op === 'col-after' || op === 'col-delete') {
    const at = t.caretCol;
    if (op === 'col-delete') {
      if (cols <= 1) return null;
      header = header.filter((_, i) => i !== at);
      rows = rows.map((r) => r.filter((_, i) => i !== at));
      align = align.filter((_, i) => i !== at);
    } else {
      const idx = op === 'col-before' ? at : at + 1;
      header = [...header.slice(0, idx), `列${idx + 1}`, ...header.slice(idx)];
      rows = rows.map((r) => [...r.slice(0, idx), '', ...r.slice(idx)]);
      align = [...align.slice(0, idx), 'none', ...align.slice(idx)];
    }
  } else if (op !== 'normalize' && op !== 'align-wide') {
    return null;
  }

  if (op === 'align-wide' && !isWideAlignable(header, rows)) return null; // 长文本表不补列宽
  const outLines =
    op === 'normalize'
      ? compactBlock(header, rows, align)
      : op === 'align-wide'
        ? wideBlock(header, rows, align)
        : [formatRow(header), `| ${align.map((x) => sepToken(x)).join(' | ')} |`, ...rows.map(formatRow)];
  const pre = lines.slice(0, t.startLine);
  const post = lines.slice(t.endLine + 1);
  const newBlockLines = [...pre, ...outLines, ...post];
  const newText = newBlockLines.join('\n');

  // 光标落点：仍在原逻辑行（删除当前数据行时落在同位置下一行/块尾）
  let line = Math.min(Math.max(caretLine, t.startLine), t.startLine + outLines.length - 1);
  if (op === 'row-delete' && t.caretRowIdx === rows.length) {
    line = Math.min(t.startLine + outLines.length - 2, t.endLine - 1);
  }
  const lineText = newBlockLines[line] ?? '';
  const col = Math.min(caretCol, lineText.length);
  const cursor = newBlockLines.slice(0, line).join('\n').length + (line > 0 ? 1 : 0) + col;
  // 原表格块区间：[块首行行首, 块末行行尾]（不含末行换行）。pre 非空时前面有换行需 +1
  const from = lines.slice(0, t.startLine).join('\n').length + (t.startLine > 0 ? 1 : 0);
  const to = lines.slice(0, t.endLine + 1).join('\n').length;
  return { text: newText, cursor, from, to, block: outLines.join('\n') };
}

/** TSV/CSV 文本（≥2 行 ≥2 列）转 md 表格；不符合返回 null */
export function tsvToTable(pasted: string): string | null {
  let lines = pasted.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  if (lines.length < 2) return null;
  const deli = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : lines[0].includes(';') ? ';' : null;
  if (!deli || !lines[0].includes(deli)) return null;
  const rows = lines.map((l) => parseDelimitedLine(l, deli));
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols < 2) return null;
  const [header, ...body] = rows.map((r) => padRow(r, cols));
  return compactBlock(header, body, Array.from({ length: cols }, (): TableAlign => 'none')).join('\n');
}

/** 单行 CSV 解析：支持双引号包裹与 "" 转义；TSV 直接 split */
function parseDelimitedLine(line: string, deli: string): string[] {
  if (deli === '\t') return line.split('\t').map((s) => s.trim());
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
    } else if (ch === deli) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}
