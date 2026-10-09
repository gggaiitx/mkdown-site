/**
 * 跨平台快捷键提示工具：Mac 显示 ⌘/⌥/⇧ 符号，Windows/Linux 显示 Ctrl/Alt/Shift。
 * 仅用于**展示层**（tooltip / 说明文案 / 悬浮提示）；
 * 功能判定一律以键盘事件修饰键为准（Workbench.onKeydown 已兼容 ctrlKey||metaKey）。
 */
export const isMac =
  /Mac|iPhone|iPad/i.test(navigator.platform ?? '') || /Macintosh/i.test(navigator.userAgent ?? '');

/** 主修饰键：Mac=⌘，其他=Ctrl */
export const modKey = (): string => (isMac ? '⌘' : 'Ctrl');

/** Alt 修饰键：Mac=⌥，其他=Alt */
export const altKey = (): string => (isMac ? '⌥' : 'Alt');

/** Shift 修饰键：Mac=⇧，其他=Shift */
export const shiftKey = (): string => (isMac ? '⇧' : 'Shift');

/** 主修饰键+键名提示：Mac=⌘S，其他=Ctrl+S */
export const modHint = (key: string): string => (isMac ? `⌘${key}` : `Ctrl+${key}`);

/** Alt+键名提示：Mac=⌥E，其他=Alt+E */
export const altHint = (key: string): string => (isMac ? `⌥${key}` : `Alt+${key}`);

/** Shift+键名提示：Mac=⇧F，其他=Shift+F */
export const shiftHint = (key: string): string => (isMac ? `⇧${key}` : `Shift+${key}`);
