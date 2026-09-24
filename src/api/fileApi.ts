import { call } from './ipc';
import type { FileContent, FileMeta, SaveResult } from './types';

export const readFile = (path: string) => call<FileContent>('read_file', { path });

export const writeFileAtomic = (path: string, content: string, keepBom: boolean) =>
  call<SaveResult>('write_file_atomic', { path, content, keepBom });

export const saveAs = (defaultName: string, content: string) =>
  call<SaveResult | null>('save_as', { defaultName, content });

export const pickOpenFile = () => call<string | null>('pick_open_file');

export const pickWorkspaceDir = () => call<string | null>('pick_workspace_dir');

export const getFileMeta = (path: string) => call<FileMeta>('get_file_meta', { path });

/** 判断文件能否在编辑器里按文本打开（false → 预览或交系统默认程序） */
export const probeTextFile = (path: string) => call<boolean>('probe_text_file', { path });

/**
 * 判断文件能否在应用内预览（Rust 侧唯一真相源）：
 * "docx" | "xlsx" | "image"，null = 不预览（走系统默认程序）
 */
export const probePreviewKind = (path: string) =>
  call<'docx' | 'xlsx' | 'image' | null>('probe_preview_kind', { path });

/** 用系统默认程序打开（Office/PDF/图片等；目录则在文件管理器中显示） */
export const openInSystem = (path: string) => call<void>('open_in_system', { path });

/** 用系统默认浏览器打开 http/https/mailto 链接（预览区外链） */
export const openUrl = (url: string) => call<void>('open_url', { url });
