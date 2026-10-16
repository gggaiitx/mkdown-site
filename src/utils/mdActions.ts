/**
 * 格式动作唯一定义处：快捷键路径（Workbench.handleFormatShortcut）与编辑区右键菜单共用
 * 同一份前后缀与占位符文案键——两处各写一遍迟早漂出两种行为。
 */
import type { BlockFormatKind } from './mdLineFormat';

/** 包裹型动作：在选区（或占位文本）两侧补前后缀，走内核 insert API */
export type WrapActionId = 'bold' | 'italic' | 'codeRow' | 'codeBlock' | 'link' | 'image';

export interface WrapSpec {
  prefix: string;
  suffix: string;
  /** 无选区时插入的占位文本 i18n 键 */
  placeholderKey: string;
}

export const WRAP_ACTIONS: Record<WrapActionId, WrapSpec> = {
  bold: { prefix: '**', suffix: '**', placeholderKey: 'workbench.placeholder.bold' },
  italic: { prefix: '*', suffix: '*', placeholderKey: 'workbench.placeholder.italic' },
  codeRow: { prefix: '`', suffix: '`', placeholderKey: 'workbench.placeholder.code' },
  // 围栏代码块：前后各带换行，保证标记独占一行
  codeBlock: { prefix: '\n```\n', suffix: '\n```\n', placeholderKey: 'workbench.placeholder.code' },
  link: { prefix: '[', suffix: '](https://)', placeholderKey: 'workbench.placeholder.link' },
  image: { prefix: '![', suffix: '](https://)', placeholderKey: 'workbench.placeholder.image' },
};

/** 标题档 id → # 级数（右键「标题」飞窗项） */
export type HeadingId = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

export const HEADING_LEVELS: Record<HeadingId, number> = {
  h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
};

/** 编辑区右键「格式」可请求的全部动作：包裹型 + 标题 + 块级（引用/无序/有序/任务/正文） */
export type FormatId = WrapActionId | HeadingId | BlockFormatKind;

/** 标题档在空行上执行时补的示例文字；包裹型档用 WRAP_ACTIONS 里的 placeholderKey */
export const HEADING_EXAMPLE_KEY = 'workbench.example.heading';

/**
 * 块级档的示例文字 i18n 键。空段落上单点「引用/列表」若只塞一个裸标记，用户看不到任何效果，
 * 故补一段示例并让它处于选中态（逐行链路只替换行文本，选中由后续输入直接顶掉）。
 * plain 是「去掉标记」，空行上无事可做，因此不在表内。
 */
export const BLOCK_EXAMPLE_KEYS: Partial<Record<BlockFormatKind, string>> = {
  quote: 'workbench.example.quote',
  ul: 'workbench.example.item',
  ol: 'workbench.example.item',
  task: 'workbench.example.task',
};
