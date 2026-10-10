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
