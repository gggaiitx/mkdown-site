/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

// @wangeditor/editor-for-vue 的 package.json exports 未正确指向类型文件（上游缺陷），
// 手动指向其 dist/src/index.d.ts 等价声明
declare module '@wangeditor/editor-for-vue' {
  import type { DefineComponent } from 'vue';
  import type { IDomEditor, IEditorConfig, IToolbarConfig } from '@wangeditor/editor';
  type EditorProps = {
    modelValue?: string;
    defaultConfig?: Partial<IEditorConfig>;
    defaultContent?: unknown[];
    mode?: string;
  };
  type ToolbarProps = {
    editor?: IDomEditor | null;
    defaultConfig?: Partial<IToolbarConfig>;
    mode?: string;
  };
  export const Editor: DefineComponent<EditorProps, Record<string, unknown>, unknown>;
  export const Toolbar: DefineComponent<ToolbarProps, Record<string, unknown>, unknown>;
}

// turndown-plugin-gfm 无官方类型（@types 不存在，上游未维护）：
// CJS exports.gfm = [tables, strikethrough, taskListItems] 等命名导出，
// Vite interop 后按具名 import 消费（default 导出是整体 exports 对象，不能直接用）
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  const gfm: TurndownService.Plugin | TurndownService.Plugin[];
  export { gfm };
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}
