import { convertFileSrc } from '@tauri-apps/api/core';

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
