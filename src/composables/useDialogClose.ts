import { useSettingsStore } from '../stores/settingsStore';

/**
 * 弹窗关闭口径：所有带遮罩的弹窗共用 settings.dialogCloseOnMask。
 * 「取消 / 关闭」按钮、右上角 × 与 Esc 始终可关；这里只决定点弹窗外（遮罩）是否也关。
 */
export function useDialogClose() {
  const settings = useSettingsStore();
  function maskCloses(): boolean {
    return settings.settings.dialogCloseOnMask;
  }
  return { maskCloses };
}
