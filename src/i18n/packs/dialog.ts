/**
 * 通用对话框（AppDialog.vue）语言包：仅组件内部默认按钮文字；标题/正文由调用方传入。
 * error.* 段为 IPC 稳定错误码（Rust error.rs code()）的本地化文案，由 api/ipc.ts
 * 的 call() 出口按 code 映射（P2-10）：命中即替换 Rust 英文原文（原文留 IpcError.rawMessage）。
 */
export default {
  zh: {
    dialog: {
      confirm: '确定',
      cancel: '取消',
      error: {
        notFound: '路径不存在',
        permissionDenied: '没有权限',
        io: '磁盘读写失败',
        encoding: '编码错误',
        invalidArg: '参数无效',
        conflict: '名称冲突',
        cancelled: '操作已取消',
        unsupported: '不支持的操作',
        internal: '内部错误',
        unknown: '未知错误',
      },
    },
  },
  en: {
    dialog: {
      confirm: 'OK',
      cancel: 'Cancel',
      error: {
        notFound: 'Path not found',
        permissionDenied: 'Permission denied',
        io: 'Disk read/write failed',
        encoding: 'Encoding error',
        invalidArg: 'Invalid argument',
        conflict: 'Name conflict',
        cancelled: 'Operation cancelled',
        unsupported: 'Unsupported operation',
        internal: 'Internal error',
        unknown: 'Unknown error',
      },
    },
  },
};
