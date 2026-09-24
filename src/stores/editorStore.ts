import { defineStore } from 'pinia';
import type { EditorMode } from '../api/types';
import { countChars } from '../utils/common';

export interface OutlineItem {
  index: number;
  text: string;
  level: number;
  line: number;
}

/** 从 Markdown 文本提取标题大纲（跳过代码块内的 # 行） */
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

export const useEditorStore = defineStore('editor', {
  state: () => ({
    mode: 'split' as EditorMode,
    outline: [] as OutlineItem[],
    cursorLine: 1,
    cursorCol: 1,
    wordCount: 0,
    lineCount: 0,
    /** 保存中标记（状态栏展示） */
    saving: false,
    /** 预览区实时 HTML（导出/打印用） */
    previewHtml: '',
    /** 指向引擎的滚动指令（自增序号触发 watch） */
    scrollTarget: { seq: 0, line: 1, headingIndex: -1 },
    /** 全局轻提示 */
    toast: { seq: 0, text: '', kind: 'info' as 'info' | 'error' | 'success' },
  }),
  actions: {
    setMode(m: EditorMode) {
      this.mode = m;
    },
    syncFromContent(content: string) {
      this.outline = extractOutline(content);
      this.wordCount = countChars(content);
      // 与编辑器（CodeMirror）口径一致：空文档也是 1 行（编辑区显示一个可定位的空行）
      this.lineCount = content.split('\n').length;
    },
    setCursor(line: number, col: number) {
      this.cursorLine = line;
      this.cursorCol = col;
    },
    scrollToLine(line: number, headingIndex = -1) {
      this.scrollTarget = { seq: this.scrollTarget.seq + 1, line, headingIndex };
    },
    showToast(text: string, kind: 'info' | 'error' | 'success' = 'info') {
      this.toast = { seq: this.toast.seq + 1, text, kind };
    },
  },
});
