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
import type { TableOp } from '../utils/mdTable';
import type { BlockFormatKind } from '../utils/mdLineFormat';

export type { EditorMode, OutlineItem, ThemeKind };

/** 编辑区右键菜单载荷：引擎拦截 contextmenu 后上报，上层据此唤起菜单。
 *  引擎已把光标落到点击处，菜单项只需回调 tableOp / insertTable / setBlockFormat 等 */
export interface EditorCtxPayload {
  x: number;
  y: number;
  /** 右键点是否落在表格块内：false 时只给「插入表格」 */
  inTable: boolean;
  /** 等宽对齐是否可用：长文本表补列宽会撑出数百字符行，故置灰 */
  wideAlignable: boolean;
  /** 上报来源引擎（缺省 = Markdown 引擎，保持既有调用点不变）。
   *  富文本（.mh）没有 Markdown 源码语义，菜单只保留「刷新 / 专注模式」两项视图级动作。 */
  engine?: 'md' | 'mh' | 'code';
}

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
  /**
   * 取当前滚动位置（引擎常驻 v-show 后按标签保存，2026-10-17）。
   * 无滚动宿主（未挂载 / 阅读态容器缺失）返回 0，调用方据此跳过恢复。
   */
  captureScroll?(): number;
  /**
   * 恢复滚动位置。引擎刚从 display:none 切回可见时布局尚未结算（display:none 期间
   * 滚动位置会被浏览器清零），故内部自带重试，调用方 fire-and-forget。
   */
  restoreScroll?(top: number): void;
}

/** Markdown 专属能力（仅 MdEditorV3Engine 实现；代码引擎不暴露） */
export interface MarkdownEngineHandle {
  /** 用前后缀包裹当前选区（无选区时插入占位文本）：加粗/斜体/链接/图片占位/代码块等格式快捷键 */
  wrapSelection(prefix: string, suffix: string, placeholder?: string): void;
  /** 为光标所在行（或选区覆盖各行）设置 N 级标题（1~6，行首语义，幂等剥旧前缀）。
   *  example = 目标是一整行空行时补进去的示例文字（不传则空行原样不动） */
  setHeading(level: number, example?: string): void;
  /** 逐行为选区覆盖行施加块级格式：引用 / 无序 / 有序（自动编号）/ 任务项（保留勾选态）/ 正文。
   *  既有块标记先剥净再补新标记，各档之间来回转换不会叠加前缀；example 同 setHeading */
  setBlockFormat(kind: BlockFormatKind, example?: string): void;
  /** 切换编辑器页面内全屏（同工具栏 pageFullscreen 图标，F11 快捷键共用） */
  togglePageFullscreen(): void;
  /** 导出 PDF：md-editor-v3 官方 ExportPDF 机制（window.print 只打印内嵌预览体）。三态通用。 */
  exportPdf(): Promise<void>;
  /** Word 导出用的预览 HTML 快照：同步内容到导出宿主 → 等渲染（mermaid/katex 完成）→ 取 innerHTML。
   *  复用 waitExportPreviewReady 等待机制；编辑态同样可用（宿主恒驻）。 */
  getExportPreviewHtml(): Promise<string>;
  /** 表格编辑：对光标所在表格执行行/列增删、紧凑规整（normalize）或等宽对齐（align-wide）。
   *  返回 false = 光标不在表格内 / 该操作对当前表不适用（如宽表等宽对齐），调用方据此提示 */
  tableOp(op: TableOp): boolean;
  /** 在光标处插入表格骨架（rows 数据行 × cols 列，含表头） */
  insertTable(rows?: number, cols?: number): void;
  /** 焦点交还编辑区：右键菜单项点完焦点停在按钮上，操作后需能直接接着打字 */
  focusEditor(): void;
}

/** 引擎组件对外暴露的方法（defineExpose 契约）：通用必选 + Markdown 方法可选 */
export type EngineHandle =
  CommonEngineHandle & Partial<MarkdownEngineHandle> & Partial<RichTextEngineHandle> & Partial<CmReplaceHandle>;

/** 文本级替换能力：只有 CodeMirror 系引擎（md / code）实现。
 *  .mh 富文本的内容模型是 HTML、命中口径与纯文本不同，故不实现（业务层用 `?.` 调用并据此隐藏替换入口）。
 *  偏移量以「文档全文」为基准，与 tab.content 同源；两处方法都带一致性校验，
 *  防止「查找之后文本又变了」替错位置——校验不过返回 false，由调用方提示重新查找。 */
export interface CmReplaceHandle {
  /** 替换一处：doc[from,to) 必须等于 expect */
  replaceRange(from: number, to: number, replacement: string, expect: string): boolean;
  /** 整篇替换（一次事务 = 一步撤销）：当前文档必须等于 baseText */
  replaceDocText(nextText: string, baseText: string): boolean;
}

/** 富文本（wangEditor）专属能力：仅 WangEditorEngine 实现 */
export interface RichTextEngineHandle {
  /** 取显示态 HTML（图片为 asset:// URL，docxAssets 可直接 fetch）；Word 导出用 */
  getDisplayHtml(): string;
}
