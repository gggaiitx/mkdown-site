/**
 * 块级格式纯函数层：标题 / 引用 / 无序 / 有序 / 任务项 / 正文（清除块标记）。
 * 与 utils/mdTable.ts 同一分工——计算在这里，引擎只做 CM 视图桥接，因此可脱离浏览器单测。
 */

/** 行首块标记：标题 #、引用 >、任务 - [ ]、无序 - 星号 加号、有序 1. 或 1) */
const MARKER_RE = /^(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;

export type BlockKind = 'heading' | 'quote' | 'ul' | 'ol' | 'task' | 'plain';

/** 引擎对外暴露的块格式档：标题另有 level 语义（setHeading），其余走 setBlockFormat */
export type BlockFormatKind = Exclude<BlockKind, 'heading'>;

/**
 * 反复剥进行首块标记（`> - [ ] x` 这类复合前缀一次转换即清干净），
 * 同时捎带出任务项的勾选态——标记被剥掉后原文里就找不到它了。
 */
function parseLine(text: string): { body: string; task: string } {
  let rest = text;
  let task = ' ';
  for (;;) {
    const m = MARKER_RE.exec(rest);
    if (!m) return { body: rest, task };
    const mark = /\[([ xX])\]/.exec(m[0])?.[1];
    if (mark) task = mark;
    rest = rest.slice(m[0].length);
  }
}

function markerFor(kind: BlockKind, index: number, level: number, task: string): string {
  if (kind === 'heading') return `${'#'.repeat(Math.min(6, Math.max(1, level)))} `;
  if (kind === 'quote') return '> ';
  if (kind === 'ol') return `${index + 1}. `;
  if (kind === 'task') return `- [${task}] `;
  if (kind === 'plain') return '';
  return '- ';
}

/**
 * 对一组行文本施加块级格式，返回等长的新行数组。
 * 原行缩进保留（嵌套项不拍平）。
 * kind=heading 取 level（1-6，越界夹回）；kind=ol 按数组序自动编号。
 * example 只在「选中范围就是一行空行」时生效——补一段示例文字，让引用/列表的效果当场可见；
 * 多行选区里的空行仍是块间距，原样保留，不会被塞进内容。
 */
export function formatBlockLines(
  lines: string[],
  kind: BlockKind,
  options: { level?: number; example?: string } = {},
): string[] {
  const level = options.level ?? 1;
  const example = options.example ?? '';
  return lines.map((line, i) => {
    const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
    const { body, task } = parseLine(line.slice(indent.length));
    if (body.trim() === '') {
      // 空白行的前导空格在 Markdown 里没有语义，补示例时不带走
      if (lines.length === 1 && example !== '') {
        return `${markerFor(kind, i, level, task)}${example}`;
      }
      return line;
    }
    return `${indent}${markerFor(kind, i, level, task)}${body}`;
  });
}
