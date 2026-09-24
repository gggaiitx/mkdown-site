import { invoke } from '@tauri-apps/api/core';

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
  constructor(code: string, message: string) {
    super(message);
    this.code = (code as AppErrorCode) ?? 'UNKNOWN';
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

/** invoke 基座：所有命令经此调用，统一错误形状 */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toIpcError(e);
  }
}

/** 各错误码的中文文案 */
export const ERROR_TEXT: Record<string, string> = {
  NOT_FOUND: '路径不存在',
  PERMISSION_DENIED: '没有权限',
  IO_ERROR: '磁盘读写失败',
  ENCODING_ERROR: '编码错误',
  INVALID_ARG: '参数无效',
  CONFLICT: '名称冲突',
  CANCELLED: '操作已取消',
  UNSUPPORTED: '不支持的操作',
  INTERNAL: '内部错误',
  UNKNOWN: '未知错误',
};
