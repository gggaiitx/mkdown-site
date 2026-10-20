import { defineStore } from 'pinia';
import type { EditorMode } from '../api/types';
import { countChars } from '../utils/common';
import { extractOutline } from '../utils/outline';

export interface OutlineItem {
  index: number;
  text: string;
  level: number;
  line: number;
}

/** 从富文本 HTML（.mh / wangEditor）提取标题大纲 */
export function extractHtmlOutline(html: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  if (!html) return items;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
      const text = (el.textContent ?? '').trim();
      if (!text) return;
      items.push({ index: items.length, text, level: Number(el.tagName.slice(1)), line: items.length + 1 });
    });
  } catch {
    /* 解析失败返回空大纲，不致命 */
  }
  return items;
}

export const useEditorStore = defineStore('editor', {  state: () => ({
    mode: 'split' as EditorMode,
    outline: [] as OutlineItem[],
    /** 当前阅读位置对应的标题序号（-1 = 未定位）。滚动联动写入，大纲面板与右缘浮标共用 */
    activeHeading: -1,
    cursorLine: 1,
    cursorCol: 1,
    wordCount: 0,
    lineCount: 0,
    /** 保存中标记（状态栏展示） */
    saving: false,
    /** 内容区页面全屏（F11 那一套）：代码引擎与预览类标签共用，状态放这里才能让
     *  预览工具条的「全屏」按钮与 F11 读同一份；md/.mh 的全屏状态仍在各自引擎内部 */
    pageFull: false,
    /** 预览区实时 HTML（导出/打印用） */
    previewHtml: '',
    /** 全局轻提示 */
    toast: { seq: 0, text: '', kind: 'info' as 'info' | 'error' | 'success' },
  }),
  actions: {
    setMode(m: EditorMode) {
      this.mode = m;
    },
    syncFromContent(content: string) {
      this.outline = extractOutline(content);
      this.activeHeading = -1; // 换文档/重算大纲后旧序号无意义，等下一次量测回填
      this.wordCount = countChars(content);
      // 与编辑器（CodeMirror）口径一致：空文档也是 1 行（编辑区显示一个可定位的空行）
      this.lineCount = content.split('\n').length;
    },
    /** 富文本（.mh）口径：HTML 内提取大纲 + 纯文本字数（无行概念，行数保持 1） */
    syncFromHtml(html: string) {
      this.outline = extractHtmlOutline(html);
      this.activeHeading = -1;
      const text = html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ');
      this.wordCount = countChars(text.replace(/\s+/g, ''));
      this.lineCount = 1;
    },
    setCursor(line: number, col: number) {
      this.cursorLine = line;
      this.cursorCol = col;
    },
    showToast(text: string, kind: 'info' | 'error' | 'success' = 'info') {
      this.toast = { seq: this.toast.seq + 1, text, kind };
    },
  },
});
