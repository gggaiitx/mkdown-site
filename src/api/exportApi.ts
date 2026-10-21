import { call } from './ipc';

/** 导出 HTML：Rust 侧弹保存对话框 + 原子写；用户取消返回 null */
export const exportHtml = (docPath: string, html: string) =>
  call<string | null>('export_html', { docPath, html });

/** 导出 Word（docx）：二进制 payload（Tauri v2 IPC 原生支持 Uint8Array）；
 *  Rust 侧弹保存对话框 + 原子写 + grant_picked。用户取消返回 null；
 *  docPath 仅用于推导默认文件名（stem + .docx） */
export const exportDocx = (docPath: string, data: Uint8Array) =>
  call<string | null>('export_docx', { docPath, data });

/** 导出 PDF：前端传自包含 HTML 文档（convert/printDoc.ts 产物）；
 *  Rust 侧写临时文件 → 调系统 Edge headless --print-to-pdf（Chromium 打印引擎，
 *  矢量文字型 PDF）→ 读回 → 弹保存对话框 + 原子写 + grant_picked。
 *  用户取消返回 null；未检测到 Edge 时抛错（引导用「打印 PDF」）。
 *  docPath 仅用于推导默认文件名（stem + .pdf） */
export const exportPdf = (docPath: string, html: string) =>
  call<string | null>('export_pdf', { docPath, html });

/** 导出 PNG：前端把 SVG 栅格化后的字节传过来（同 exportDocx 的二进制形态）；
 *  Rust 侧弹保存对话框 + 原子写 + grant_picked。用户取消返回 null。
 *  docPath 仅用于推导默认文件名（stem + .png） */
export const exportPng = (docPath: string, data: Uint8Array) =>
  call<string | null>('export_png', { docPath, data });
