import { defineAsyncComponent } from 'vue';

/**
 * ★ 三引擎一律懒加载（2026-10-20 启动提速 P0-b）。
 * 挂载时机仍由 Workbench 的 md/code/wangEverMounted 门控（首次用到才挂、此后常驻 v-show），
 * 所以异步化不改变任何行为，只改变「模块何时下载与求值」：
 * 原先三个引擎连同 md-editor-v3 / CodeMirror / mermaid / katex / highlight.js（约 2.8MB min）
 * 全在首屏静态图里，窗口出来前先解析一大半。现在首屏只剩外壳，引擎 chunk 与
 * 「工作区树 + 会话标签读盘」的 IPC 并行下载；纯 docx/pdf/代码会话甚至完全不下载 md 栈。
 * ref 转发给内层实例（WangEditorEngine 一直是这个用法，.mh 导出与补算大纲都靠它）。
 */
export const MdEditorV3Engine = defineAsyncComponent(() => import('./MdEditorV3Engine.vue'));
export const CodeEditorEngine = defineAsyncComponent(() => import('./CodeEditorEngine.vue'));
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
  EditorCtxPayload,
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
