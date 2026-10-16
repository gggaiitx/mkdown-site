/**
 * 外部修改检测：文件被其他程序改动时，非脏标签静默跟随磁盘，脏标签弹冲突对话框。
 *
 * 判据是「mtime 变了才读内容，读到的内容与 savedContent 不等才算冲突」：
 * 自己写盘后 mtime 当然会变，但内容与 savedContent 相同 → 不误报，也无需给标签存基线字段，
 * 更不必引入文件监视插件。seenMtime 记录每个标签上次比对的 mtime：
 * 磁盘不再变动就不会重复读、不会重复提示，外部再次改写（mtime 再变）才会再提示。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEditorStore } from '../stores/editorStore';
import { useTabsStore } from '../stores/tabsStore';
import { getFileMeta, readFile } from '../api/fileApi';
import { useI18n } from '../i18n';

export interface ExternalConflict {
  tabId: string;
  /** 冲突标签的文件名，进提示文案 */
  title: string;
}

/** 聚焦状态下的轮询间隔：外部格式化/同步工具能在几秒内被察觉 */
const CHECK_INTERVAL_MS = 4000;
/** 两次比对的最小间隔：窗口聚焦、轮询可能挤在一起 */
const THROTTLE_MS = 1500;

export function useExternalChangeGuard() {
  const tabs = useTabsStore();
  const editor = useEditorStore();
  const { t } = useI18n();

  const conflict = ref<ExternalConflict | null>(null);
  /** tabId → 上次比对的磁盘 mtime（本会话内有效，够用了：重启后首轮比对自然重建） */
  const seenMtime = new Map<string, number>();
  let lastCheck = 0;
  let focused = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unlistenFocus: (() => void) | null = null;

  /** 采纳磁盘内容（丢弃标签内未保存改动）：走 tabsStore.reloadTab 同一条重读链路 */
  async function adopt(tabId: string): Promise<void> {
    try {
      await tabs.reloadTab(tabId);
      editor.showToast(t('workbench.external.reloaded'), 'success');
    } catch (err) {
      editor.showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  async function checkActive(): Promise<void> {
    // 对话框开着 / 正在写盘 / 预览类标签（无文本语义）都不比对
    if (conflict.value || editor.saving || tabs.activeIsPreview) return;
    const tab = tabs.activeTab;
    if (!tab?.path) return; // 未保存新建文档没有磁盘来源
    const now = Date.now();
    if (now - lastCheck < THROTTLE_MS) return;
    lastCheck = now;
    let mtime: number;
    try {
      mtime = (await getFileMeta(tab.path)).mtimeMs;
    } catch {
      return; // 文件被删/被占用：不在后台弹错，交给显式打开/保存时报
    }
    if (seenMtime.get(tab.id) === mtime) return;
    let disk: string;
    try {
      disk = (await readFile(tab.path)).content;
    } catch {
      return;
    }
    seenMtime.set(tab.id, mtime);
    if (disk === tab.savedContent) return;
    if (!tab.isDirty) {
      await adopt(tab.id);
      return;
    }
    conflict.value = { tabId: tab.id, title: tab.title };
  }

  /** 重新加载：丢弃本地未保存改动，采纳磁盘版本 */
  async function resolveReload(): Promise<void> {
    const current = conflict.value;
    conflict.value = null;
    if (current) await adopt(current.tabId);
  }

  /** 保留我的改动：双方都不动；同一 mtime 不再重复提示，磁盘再变会重新提示 */
  function resolveKeep(): void {
    conflict.value = null;
  }

  onMounted(() => {
    timer = setInterval(() => {
      if (focused) void checkActive();
    }, CHECK_INTERVAL_MS);
    try {
      void getCurrentWindow()
        .onFocusChanged((e) => {
          focused = e.payload;
          // 回到前台立刻查一次，不等轮询
          if (e.payload) void checkActive();
        })
        .then((fn) => {
          unlistenFocus = fn;
        });
    } catch {
      /* 非 Tauri 环境（浏览器无头验证）无窗口事件，仅靠轮询 */
    }
  });

  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
    unlistenFocus?.();
  });

  return { conflict, checkActive, resolveReload, resolveKeep };
}
