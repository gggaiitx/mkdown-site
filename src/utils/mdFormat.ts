/**
 * 规则式 Markdown 美化（Ctrl+Shift+F）。无第三方依赖，代码块（``` / ~~~）内
 * 内容一律不动（空行与空格在代码里有语义）。规则：
 *   1) 行尾空白去除；
 *   2) ATX 标题 `#` 后统一恰好一个空格（`#标题` → `# 标题`）；
 *   3) 无序列表标记 `*` / `+` 统一为 `-`；
 *   4) 连续多个空行压缩为 1 个空行（代码块外）；
 *   5) CRLF/CR 统一为 LF，文件末尾恰好一个换行。
 */
export function formatMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let blankRun = 0;

  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode;
      out.push(raw.replace(/\s+$/, ''));
      blankRun = 0;
      continue;
    }
    if (inCode) {
      out.push(raw);
      continue;
    }

    let line = raw.replace(/\s+$/, ''); // 1) 行尾空白
    line = line.replace(/^(#{1,6})\s*/, '$1 ').trimEnd(); // 2) 标题空格（顺带清 `###` 尾随空格）
    line = line.replace(/^(\s*)[*+](\s+)/, '$1-$2'); // 3) 无序列表统一 -

    if (line === '') {
      blankRun++;
      if (blankRun > 1) continue; // 4) 空行最多连续 1 个
    } else {
      blankRun = 0;
    }
    out.push(line);
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop(); // 5) 去文末空行
  return out.length > 0 ? out.join('\n') + '\n' : '';
}
