import { defineAsyncComponent } from 'vue';

export { default as MdEditorV3Engine } from './MdEditorV3Engine.vue';
export { default as CodeEditorEngine } from './CodeEditorEngine.vue';
/**
 * wangEditor 富文本引擎（.mh）：defineAsyncComponent 懒加载——
 * @wangeditor/* 仅被 WangEditorEngine.vue 引用，动态 import 使其成独立 chunk 不进首屏（D4）。
 * 类型仍走 IMarkdownEngine 契约（EngineHandle），业务层用法与其余引擎一致。
 */
export const WangEditorEngine = defineAsyncComponent(() => import('./WangEditorEngine.vue'));
export type {
  EngineHandle,
  CommonEngineHandle,
  MarkdownEngineHandle,
  SaveableEngineHandle,
  OutlineItem,
  EditorMode,
  ThemeKind,
} from './IMarkdownEngine';

/**
 * 内核工厂：当前唯一实现 md-editor-v3。
 * 未来切换 md-editor-rt / 自研内核时在此增加分支，业务层零改动。
 */
export function createEngineKind(): 'md-editor-v3' {
  return 'md-editor-v3';
}
