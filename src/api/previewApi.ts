import { call } from './ipc';

/**
 * HTML 预览临时文档（$APPCONFIG/preview/*.html）。
 * 预览必须走真实 URL 才能执行页面自带脚本，详见 preview_cmd.rs 注释。
 */
export const writePreviewDoc = (name: string, html: string) =>
  call<string>('write_preview_doc', { name, html });

/** 删除上一份预览文档；删不掉无所谓，启动时统一清理 */
export const deletePreviewDoc = (name: string) => call<void>('delete_preview_doc', { name });
