import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * 预览文件大小上限（P1-7）：32MB。超限不进解析器——docx-preview / xlsx 都是全量
 * 解压 + 解析，超大文件会长时间占用主线程；预览定位是"快速看一眼"，超大文件
 * 应由用户用系统默认程序打开（错误态文案见 preview.ts tooLarge）。
 */
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

/** 是否超过预览大小上限（读取文件字节后调用） */
export function tooLargeToPreview(buf: ArrayBuffer): boolean {
  return buf.byteLength > MAX_PREVIEW_BYTES;
}

/**
 * 预览组件读取文件字节的统一入口：
 * Tauri 下走 asset:// 协议（目录经 allow_asset_dir 运行时授权，
 * CSP connect-src 已放行 asset: http://asset.localhost）。
 */
export async function readPreviewBytes(path: string): Promise<ArrayBuffer> {
  const res = await fetch(convertFileSrc(path));
  if (!res.ok) {
    throw new Error(`读取失败（HTTP ${res.status}）`);
  }
  return res.arrayBuffer();
}

/** 文件所在目录（用于 HtmlFrame 注入 <base> 解析相对资源） */
export function parentDirOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}
