/**
 * ★ 编辑器内核唯一契约（ARCHITECTURE §4）。
 * 业务层只允许依赖此处定义的类型与 MdEditorV3Engine.vue 暴露的能力；
 * 除 adapters/MdEditorV3Engine.vue 外任何文件禁止 import 'md-editor-v3'。
 */
import type { EditorMode, ThemeKind } from '../api/types';
import type { OutlineItem } from '../stores/editorStore';

export type { EditorMode, OutlineItem, ThemeKind };

/** 引擎组件对外暴露的方法（defineExpose 契约） */
export interface EngineHandle {
  /** 滚动到指定行。三态通用：编辑/分栏按 CM 行元素，阅读按 data-line 锚点；
   *  headingIndex >= 0 时按标题序号定位（大纲跳转用）。 */
  scrollToLine(line: number, headingIndex?: number): void;
  /** 在光标处插入文本 */
  insert(text: string): void;
  /** 文件内查找高亮：编辑/分栏态 CM6 装饰 + 阅读态预览 mark；空关键词 = 清除 */
  highlight(keyword: string, caseSensitive?: boolean): void;
  /** 清除全部查找高亮 */
  clearHighlight(): void;
}
