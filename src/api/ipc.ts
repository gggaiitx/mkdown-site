import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';

/** 稳定错误码（与 Rust error.rs 的 code() 对应） */
export type AppErrorCode =
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'IO_ERROR'
  | 'ENCODING_ERROR'
  | 'INVALID_ARG'
  | 'CONFLICT'
  | 'CANCELLED'
  | 'UNSUPPORTED'
  | 'INTERNAL';

/** 统一 IPC 错误：UI 按 code 分支文案，禁止匹配 message 文本 */
export class IpcError extends Error {
  readonly code: AppErrorCode | 'UNKNOWN';
  /** 本地化前的原始 message（Rust 英文原文）：日志/排查用，UI 不展示 */
  readonly rawMessage: string;
  constructor(code: string, message: string, rawMessage: string = message) {
    super(message);
    this.code = (code as AppErrorCode) ?? 'UNKNOWN';
    this.rawMessage = rawMessage;
    this.name = 'IpcError';
  }
}

export function toIpcError(e: unknown): IpcError {
  if (e instanceof IpcError) return e;
  if (e && typeof e === 'object' && 'code' in e) {
    const obj = e as { code?: string; message?: string };
    return new IpcError(obj.code ?? 'UNKNOWN', obj.message ?? String(e));
  }
  return new IpcError('UNKNOWN', String(e));
}

/**
 * 错误码 → i18n 文案 key（dialog.error.*，zh/en 双语见 i18n/packs/dialog.ts）。
 * 码表与 Rust error.rs 的 code() 一一对应；P2-10 起由 call() 出口消费——
 * 原 ERROR_TEXT 中文字面量表零消费导致 toast 直接显示 Rust 英文原文。
 */
export const ERROR_TEXT_KEY: Record<string, string> = {
  NOT_FOUND: 'dialog.error.notFound',
  PERMISSION_DENIED: 'dialog.error.permissionDenied',
  IO_ERROR: 'dialog.error.io',
  ENCODING_ERROR: 'dialog.error.encoding',
  INVALID_ARG: 'dialog.error.invalidArg',
  CONFLICT: 'dialog.error.conflict',
  CANCELLED: 'dialog.error.cancelled',
  UNSUPPORTED: 'dialog.error.unsupported',
  INTERNAL: 'dialog.error.internal',
  UNKNOWN: 'dialog.error.unknown',
};

/** 按 code 取本地化文案；key 缺失或 i18n 未就绪（极端启动期）时返回 null 保留原文 */
function localizeError(code: string): string | null {
  const key = ERROR_TEXT_KEY[code];
  if (!key) return null;
  try {
    const { t } = useI18n();
    const s = t(key);
    return s === key ? null : s; // t 的回退值为 key 本身：缺失时不用
  } catch {
    return null;
  }
}

/** invoke 基座：所有命令经此调用，统一错误形状。
 *  catch 出口按稳定错误码映射 i18n 文案（P2-10）：命中则 message 显示本地化文本，
 *  Rust 原文保留在 rawMessage 供日志；未命中（含 UNKNOWN 兜底）原样抛出。 */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = toIpcError(e);
    const text = localizeError(err.code);
    if (text) throw new IpcError(err.code, text, err.rawMessage);
    throw err;
  }
}
