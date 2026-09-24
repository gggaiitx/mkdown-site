import { call } from './ipc';

/** 导出 HTML：Rust 侧弹保存对话框 + 原子写；用户取消返回 null */
export const exportHtml = (docPath: string, html: string) =>
  call<string | null>('export_html', { docPath, html });
