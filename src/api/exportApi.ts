import { call } from './ipc';

/** 导出 HTML：写到应用内选择器给定的路径（Rust 侧原子写 + 目录授权） */
export const exportHtml = (html: string, path: string) =>
  call<string>('export_html', { html, path });

/** 导出 Word（docx）：二进制 payload（Tauri v2 IPC 原生支持 Uint8Array），
 *  写到应用内选择器给定的路径 */
export const exportDocx = (data: Uint8Array, path: string) =>
  call<string>('export_docx', { data, path });

/** 导出 PDF：前端传自包含 HTML 文档（convert/printDoc.ts 产物）；
 *  Rust 侧写临时文件 → 调系统 Edge headless --print-to-pdf（Chromium 打印引擎，
 *  矢量文字型 PDF）→ 读回 → 写入选择器给定的路径。
 *  未检测到 Edge 时抛错（引导用「打印 PDF」） */
export const exportPdf = (html: string, path: string) =>
  call<string>('export_pdf', { html, path });

/** 导出 PNG：前端把 SVG 栅格化后的字节传过来（同 exportDocx 的二进制形态），
 *  写到应用内选择器给定的路径 */
export const exportPng = (data: Uint8Array, path: string) =>
  call<string>('export_png', { data, path });

/** 导出长图：前端传自包含 HTML（convert/longImage.ts 产物）与截图宽度（CSS px）；
 *  Rust 侧调系统 Edge headless 两趟——量高度、整页截图——写 PNG 到选择器给定路径。
 *  未检测到 Edge 时抛错 */
export const exportLongImage = (html: string, width: number, path: string) =>
  call<string>('export_long_image', { html, width, path });
