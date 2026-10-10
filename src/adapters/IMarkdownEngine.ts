/**
 * ★ 编辑器内核唯一契约（ARCHITECTURE §4）。
 * 业务层只允许依赖此处定义的类型与引擎组件（MdEditorV3Engine / CodeEditorEngine）
 * 暴露的能力；除 adapters/ 下引擎文件外任何文件禁止 import 'md-editor-v3'。
 *
 * 契约分两段（2026-10-09 拆分）：
 * - CommonEngineHandle：语言无关的通用能力，所有引擎必实现；
 * - MarkdownEngineHandle：Markdown 专属能力，仅 MdEditorV3Engine 实现。
 * 对外统一类型 EngineHandle = 通用必选 + Markdown 方法可选（Partial），
 * 业务层调用专属方法须用 `engineRef.value?.setHeading?.(...)` 双层可选链。
 */
import type { EditorMode, ThemeKind } from '../api/types';
import type { OutlineItem } from '../stores/editorStore';

export type { EditorMode, OutlineItem, ThemeKind };

/** 语言无关的通用引擎能力（所有引擎必实现） */
export interface CommonEngineHandle {
  /** 滚动到指定行。三态通用：编辑/分栏按 CM 行元素，阅读按 data-line 锚点；
   *  headingIndex >= 0 时按标题序号定位（大纲跳转用，仅 Markdown 引擎生效）。 */
  scrollToLine(line: number, headingIndex?: number): void;
  /** 在光标处插入文本 */
  insert(text: string): void;
  /** 文件内查找高亮：编辑/分栏态 CM6 装饰 + 阅读态预览 mark；空关键词 = 清除 */
  highlight(keyword: string, caseSensitive?: boolean): void;
  /** 清除全部查找高亮 */
  clearHighlight(): void;
  /** 滚动到第 index 个查找命中并标记为当前命中（可选能力，仅富文本引擎实现——
   *  CSS Custom Highlight API 方案，不触碰 Slate 托管 DOM） */
  scrollToMatch?(index: number): void;
}

/** Markdown 专属能力（仅 MdEditorV3Engine 实现；代码引擎不暴露） */
export interface MarkdownEngineHandle {
  /** 用前后缀包裹当前选区（无选区时插入占位文本）：加粗/斜体/链接/图片占位/代码块等格式快捷键 */
  wrapSelection(prefix: string, suffix: string, placeholder?: string): void;
  /** 为光标所在行（或选区覆盖各行）设置 N 级标题（1~6，行首语义，幂等剥旧前缀） */
  setHeading(level: number): void;
  /** 切换编辑器页面内全屏（同工具栏 pageFullscreen 图标，F11 快捷键共用） */
  togglePageFullscreen(): void;
  /** 导出 PDF：md-editor-v3 官方 ExportPDF 机制（window.print 只打印内嵌预览体）。三态通用。 */
  exportPdf(): Promise<void>;
}

/** 保存管线统一契约（可选实现）：md→Markdown 文本、mh→HTML（DEV §3.3） */
export interface SaveableEngineHandle {
  /** 返回应落盘文本：md-editor-v3→Markdown；wangEditor→getHtml()（.mh） */
  getSaveContent(): string;
  /** 返回当前视图 HTML（PDF/预览复用） */
  getViewHtml(): string;
}

/** 引擎组件对外暴露的方法（defineExpose 契约）：通用必选 + Markdown/保存方法可选 */
export type EngineHandle = CommonEngineHandle
  & Partial<MarkdownEngineHandle>
  & Partial<SaveableEngineHandle>;
