import { watch } from 'vue';
import { useTabsStore, type DocumentTab } from '../stores/tabsStore';
import { useEditorStore } from '../stores/editorStore';
import {
  getSession,
  setSession,
  type SessionSnapshot,
  type SessionTabSnapshot,
} from '../api/sessionApi';
import { readFile } from '../api/fileApi';
import { allowAssetDir } from '../api/imageApi';

/**
 * 会话快照服务：标签页集合 + 未保存草稿 的持久化与恢复。
 *
 * - 写入：watch tabs 深度变更，800ms 防抖原子写 session.json（APPDATA，更新安装不触碰）。
 *   覆盖三个恢复场景：更新重启、应用崩溃、异常退出。
 * - 读取：仅启动时 hydrateSession() 一次（Workbench 工作区恢复之后）。
 * - 语义：脏内容恢复后仍是"未保存"状态，不替用户写盘；关闭时依旧走放弃确认（VSCode 同款）。
 * - "放弃更改并关窗"路径必须 dropDirty=true flush：用户已明确放弃的草稿不得还魂。
 */

const SAVE_DEBOUNCE_MS = 800;
const SNAPSHOT_VERSION = 1;

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** DocumentTab → 快照条目（干净标签不带内容，恢复时读盘拿最新） */
function tabToSnapshot(t: DocumentTab): SessionTabSnapshot {
  const s: SessionTabSnapshot = {
    path: t.path,
    title: t.title,
    kind: t.kind,
    mode: t.mode,
    cursorLine: t.cursorLine,
    isDirty: t.isDirty,
  };
  if (t.isDirty) {
    s.content = t.content;
    s.savedContent = t.savedContent;
  }
  return s;
}

function snapshotOf(tabList: DocumentTab[], activeId: string | null): SessionSnapshot {
  const activeIndex = tabList.findIndex((t) => t.id === activeId);
  return {
    version: SNAPSHOT_VERSION,
    tabs: tabList.map(tabToSnapshot),
    activeIndex: activeIndex >= 0 ? activeIndex : null,
  };
}

/**
 * 立即写快照。调用点：防抖落盘、更新确认重启前、放弃式关窗前（dropDirty=true）。
 * 快照失败静默吞掉——写不进去只损失恢复能力，绝不阻塞更新/关窗主流程。
 */
export async function flushSessionSnapshot(opts: { dropDirty?: boolean } = {}): Promise<void> {
  const tabs = useTabsStore();
  let list = tabs.tabs;
  if (opts.dropDirty) {
    const dirtyIds = new Set(list.filter((t) => t.isDirty).map((t) => t.id));
    list = list.filter((t) => !dirtyIds.has(t.id));
  }
  try {
    if (list.length === 0) {
      await setSession(null); // 空会话清文件，避免残留陈旧状态
    } else {
      await setSession(snapshotOf(list, tabs.activeId));
    }
  } catch {
    /* 快照失败不致命 */
  }
}

/**
 * 启动防抖快照 watcher。必须在 hydrateSession 完成（基线状态就绪）之后调用，
 * 否则启动过程中的空状态/中间态会被写进快照。
 */
export function startSessionSnapshot(): void {
  if (started) return;
  started = true;
  const tabs = useTabsStore();
  watch(
    () => [tabs.tabs, tabs.activeId] as const,
    () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void flushSessionSnapshot();
      }, SAVE_DEBOUNCE_MS);
    },
    { deep: true },
  );
}

export interface HydrateResult {
  /** 恢复了至少一个标签 */
  restored: boolean;
  /** 恢复后的活动标签（null = 无或活动标签恢复失败） */
  activeTab: DocumentTab | null;
}

/**
 * 读取快照并重建标签页。干净标签读盘（文件已删则跳过），
 * 脏标签优先用快照草稿内容（文件被删也恢复草稿，元数据降级 utf-8）。
 * 返回活动标签供调用方同步全局编辑态；光标行由调用方滚动定位。
 */
export async function hydrateSession(): Promise<HydrateResult> {
  const tabs = useTabsStore();
  let snap: SessionSnapshot | null = null;
  try {
    snap = await getSession();
  } catch {
    return { restored: false, activeTab: null };
  }
  if (
    !snap ||
    snap.version !== SNAPSHOT_VERSION ||
    !Array.isArray(snap.tabs) ||
    snap.tabs.length === 0
  ) {
    return { restored: false, activeTab: null };
  }

  const restoredIds: (string | null)[] = [];
  for (const st of snap.tabs) {
    restoredIds.push(await restoreOneTab(tabs, st));
  }

  // 恢复活动标签（按快照下标对位，跳过的标签不占用位置）
  let active: DocumentTab | null = null;
  const ai = snap.activeIndex;
  if (ai != null && ai >= 0 && ai < restoredIds.length) {
    const id = restoredIds[ai];
    if (id) {
      tabs.activate(id);
      active = tabs.tabs.find((t) => t.id === id) ?? null;
    }
  }

  return { restored: restoredIds.some(Boolean), activeTab: active };
}

/** 恢复单个标签；返回新标签 id，失败返回 null（单标签失败不阻塞其余） */
async function restoreOneTab(
  tabs: ReturnType<typeof useTabsStore>,
  st: SessionTabSnapshot,
): Promise<string | null> {
  try {
    const kind = st.kind;
    let tab: DocumentTab | undefined;

    if (kind === 'docx' || kind === 'xlsx' || kind === 'image') {
      if (!st.path) return null;
      tab = tabs.openPreviewByPath(st.path, kind);
    } else if (st.path) {
      let raw: Awaited<ReturnType<typeof readFile>> | null = null;
      try {
        raw = await readFile(st.path);
        tab = tabs.openFile(raw, (st.mode as DocumentTab['mode']) ?? 'split');
      } catch {
        if (!st.isDirty || typeof st.content !== 'string') return null;
        // 文件已不在盘上，但草稿还在：降级构造（encoding 未知按 utf-8）
        tab = tabs.addRestored({
          path: st.path,
          title: st.title || st.path.split(/[\\/]/).pop() || st.path,
          content: st.content,
          savedContent: typeof st.savedContent === 'string' ? st.savedContent : st.content,
          isDirty: true,
          encoding: 'utf-8',
          hadBom: false,
          isUtf8: true,
          mode: (st.mode as DocumentTab['mode']) ?? 'edit',
          cursorLine: st.cursorLine > 0 ? st.cursorLine : 1,
          kind: (kind as DocumentTab['kind']) ?? 'text',
        });
      }
      // 脏草稿覆盖读盘内容（savedContent 缺失时退回读盘原文，保证"放弃更改"有锚点）
      if (st.isDirty && typeof st.content === 'string' && tab) {
        tab.content = st.content;
        tab.savedContent =
          typeof st.savedContent === 'string' ? st.savedContent : (raw?.content ?? st.content);
        tab.isDirty = true;
      }
    } else if (kind === 'md') {
      // 未命名新建文档：只有草稿语义，无内容则没有恢复价值
      if (!st.isDirty || typeof st.content !== 'string') return null;
      tab = tabs.newUntitled('', (st.mode as DocumentTab['mode']) ?? 'edit');
      tab.title = st.title || tab.title;
      tab.content = st.content;
      tab.savedContent = typeof st.savedContent === 'string' ? st.savedContent : '';
      tab.isDirty = true;
    } else {
      return null;
    }

    if (!tab) return null;
    if (st.cursorLine > 1 && tab.cursorLine === 1) tab.cursorLine = st.cursorLine;

    // 授权文档目录：预览组件图片/md 内嵌资源走 asset:// 需要（同 openFilePath）
    if (st.path) {
      const dir = st.path.replace(/[\\/][^\\/]*$/, '');
      if (dir) void allowAssetDir(dir).catch(() => undefined);
    }
    return tab.id;
  } catch {
    return null;
  }
}

/** 活动标签的全局编辑态同步：预览标签不动全局 mode（与手动点开预览的行为一致） */
export function applyActiveTabMode(activeTab: DocumentTab | null): void {
  if (!activeTab) return;
  if (activeTab.kind === 'docx' || activeTab.kind === 'xlsx' || activeTab.kind === 'image') return;
  const editor = useEditorStore();
  editor.setMode(activeTab.mode);
}
