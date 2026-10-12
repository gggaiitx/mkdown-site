import type { OutlineItem } from '../stores/editorStore';

/**
 * 从 Markdown 文本提取标题大纲（跳过代码块内的 # 行）。
 * 原 editorStore 与 MdEditorV3Engine 各有一份相同实现（P2-20 重复实现），
 * 此收为唯一实现：editorStore.syncFromContent（状态/字数统计）与
 * MdEditorV3Engine（大纲 UI 的 outline emit）共用，行为不变。
 */
export function extractOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let inCode = false;
  let index = 0;
  content.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^(```|~~~)/.test(line.trim())) {
      inCode = !inCode;
      return;
    }
    if (inCode) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      items.push({
        index: index++,
        text: m[2].replace(/#+\s*$/, '').trim(),
        level: m[1].length,
        line: i + 1,
      });
    }
  });
  return items;
}
