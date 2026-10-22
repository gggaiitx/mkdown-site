import { call } from './ipc';
import type { FileContent, FileMeta, SaveResult } from './types';

export const readFile = (path: string) => call<FileContent>('read_file', { path });

/** 取走「打开方式」启动参数解析出的待打开文件（取后即清） */
export const takePendingOpenArgs = () => call<string[]>('take_pending_open_args');

export const writeFileAtomic = (path: string, content: string, keepBom: boolean) =>
  call<SaveResult>('write_file_atomic', { path, content, keepBom });

/** 另存为：ext 缺省 md（旧行为）；initial_dir = 对话框初始目录（V5，反转产物保存用） */
export const saveAs = (defaultName: string, content: string, ext?: string, initialDir?: string) =>
  call<SaveResult | null>('save_as', { defaultName, content, ext, initialDir });

/**
 * 系统打开文件对话框。
 * - 不传参：全类型可选（应用能开的一律能选，选完由 routeByType 分流），
 *   macOS 侧甚至不下发任何扩展名白名单——见 Rust 侧 pick_open_file 注释。
 * - 传 exts：按窄列表过滤（Word 反转只选 .docx），label 决定过滤器文案。
 */
export const pickOpenFile = (exts?: string[], label?: string) =>
  call<string | null>('pick_open_file', { exts: exts ?? null, label: label ?? null });

export const pickWorkspaceDir = () => call<string | null>('pick_workspace_dir');

export const getFileMeta = (path: string) => call<FileMeta>('get_file_meta', { path });

/** 判断文件能否在编辑器里按文本打开（false → 预览或交系统默认程序） */
export const probeTextFile = (path: string) => call<boolean>('probe_text_file', { path });

/**
 * 判断文件能否在应用内预览（Rust 侧唯一真相源）：
 * "docx" | "xlsx" | "image"，null = 不预览（走系统默认程序）
 */
export const probePreviewKind = (path: string) =>
  call<'docx' | 'xlsx' | 'image' | 'pdf' | null>('probe_preview_kind', { path });

/** 同目录下与当前文件同族的全部文件（文件名自然排序），左右键切换用 */
export const listSiblingFiles = (path: string) => call<string[]>('list_sibling_files', { path });

/** 用系统默认程序打开（Office/PDF/图片等；目录则在文件管理器中显示） */
export const openInSystem = (path: string) => call<void>('open_in_system', { path });

/** 在系统文件管理器中定位文件/目录（Windows：打开所在目录并选中该项） */
export const revealInExplorer = (path: string) => call<void>('reveal_in_explorer', { path });

/** 用系统默认浏览器打开 http/https/mailto 链接（预览区外链） */
export const openUrl = (url: string) => call<void>('open_url', { url });

/** 应用内独立 WebView 窗口打开 URL（文档内超链接；不受目标站反 iframe 限制） */
export const openWebWindow = (url: string) => call<void>('open_web_window', { url });
