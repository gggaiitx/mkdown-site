export { default as MdEditorV3Engine } from './MdEditorV3Engine.vue';
export type { EngineHandle, OutlineItem, EditorMode, ThemeKind } from './IMarkdownEngine';

/**
 * 内核工厂：当前唯一实现 md-editor-v3。
 * 未来切换 md-editor-rt / 自研内核时在此增加分支，业务层零改动。
 */
export function createEngineKind(): 'md-editor-v3' {
  return 'md-editor-v3';
}
