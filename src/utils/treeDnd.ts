/**
 * 文件树拖拽移动 —— pointer 事件自绘，**不用 HTML5 drag**。
 *
 * ⚠️ 为什么不用 draggable/dragstart（2026-10-24 实测踩坑）：
 * Tauri 在 Windows 上默认启用 webview 的拖放处理器，它接管了 OLE 拖放，
 * HTML5 drag 事件根本到不了前端。tauri::webview 的源码注释写得很直白：
 *   `disable_drag_drop_handler`: "This is required to use HTML5 drag and drop APIs
 *    on the frontend on Windows."
 * 而关掉它又会砍掉「从资源管理器拖文件进窗口打开」（Workbench 的 onDragDropEvent），
 * 两害相权，只能自己用 pointerdown/pointermove/pointerup 画一套。
 *
 * 交互约定：
 * - 位移 < 4px 视为点击（文件行要打开文件、目录行要展开/折叠），不进入拖拽；
 * - 落点只认目录行与树空白区（= 工作区根）；文件行、自身/自身子孙、**原父目录**一律不给落点
 *   （原父目录本来就不是移动，高亮后松手没反应会让人以为操作丢了）；
 * - 真正开始拖后才 `setPointerCapture`：越过 iframe / 拖出窗口也能收到 up，不会卡在拖拽态
 *   （捕获放在越过阈值之后，避免把普通点击的 click 目标改成 body）；
 *   窗口失焦、或收到「按键已松开」的 move 按取消处理；
 * - 贴近树上下缘连续滚动（长树能拖到屏外目录），滚动期间按最后指针位置重算落点；
 * - 指针落在滚动条上不算落点（拖过滑块松手不该把文件移到根）；
 * - 拖拽结束吞掉紧随其后的 click，否则松手会顺手把文件打开。
 */
import { ref } from 'vue';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useEditorStore } from '../stores/editorStore';
import { useI18n } from '../i18n';
import { hideDragGhost, moveDragGhost, showDragGhost } from './dragGhost';
import type { WorkspaceNode } from '../api/types';

export const treeDnd = {
  /** 正在拖的条目路径（null = 没在拖） */
  src: ref<string | null>(null),
  /** 当前高亮的落点目录（null = 没有有效落点） */
  over: ref<string | null>(null),
};

/** 移动阈值：小于它算点击 */
const THRESHOLD = 4;
/** 松手后这段时间内的 click 一律吞掉（pointerup 与 click 前后脚） */
const CLICK_SWALLOW_MS = 300;
/** 贴近树上下缘多少像素开始连续滚动 */
const EDGE = 24;
/** 每帧滚动的像素 */
const SCROLL_STEP = 10;

let press: {
  x: number;
  y: number;
  node: WorkspaceNode;
  pointerId: number;
  tree: HTMLElement | null;
} | null = null;
let started = false;
let swallowClickUntil = 0;
let lastX = 0;
let lastY = 0;
let scrollRaf = 0;

/** 按下即进入「可能拖拽」的待定态：位移过阈值才真正开始 */
export function beginRowDrag(e: PointerEvent, node: WorkspaceNode): void {
  if (e.button !== 0) return; // 只接左键：右键要留给菜单
  if (press) return; // 多指/异常序列：先让上一次收场
  press = {
    x: e.clientX,
    y: e.clientY,
    node,
    pointerId: e.pointerId,
    tree: (e.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.tree') ?? null,
  };
  started = false;
  lastX = e.clientX;
  lastY = e.clientY;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
  window.addEventListener('pointercancel', onCancel, { once: true });
  window.addEventListener('blur', onCancel);
}

function onMove(e: PointerEvent): void {
  if (!press) return;
  // 在窗口外松手（没收到 pointerup）：按取消处理，别让 ghost 与拖拽态挂着
  if (started && e.buttons === 0) {
    endDrag();
    return;
  }
  lastX = e.clientX;
  lastY = e.clientY;
  if (!started) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < THRESHOLD) return;
    started = true;
    treeDnd.src.value = press.node.path;
    document.body.classList.add('mk-dragging');
    showDragGhost(press.node.name, e.clientX, e.clientY);
    // 越过阈值才捕获：普通点击仍按原目标派发（否则 click 会落到 body 上）
    try {
      document.body.setPointerCapture(press.pointerId);
    } catch {
      /* 指针已失效：下面的 blur / buttons 兜底仍能收场 */
    }
    startAutoScroll();
  }
  moveDragGhost(e.clientX, e.clientY);
  treeDnd.over.value = hitTest(e.clientX, e.clientY, press.node);
}

async function onUp(e: PointerEvent): Promise<void> {
  const pending = press;
  const wasDragging = started;
  // 以松手坐标重算一次：快速甩动后原地松手时，最后一次 move 的落点可能已经过期
  const target = pending && wasDragging ? hitTest(e.clientX, e.clientY, pending.node) : null;
  endDrag();
  if (!wasDragging || !pending) return;
  armClickSwallow();
  if (!target) return;

  const src = pending.node.path;
  if (target === src) return;
  if (parentOf(src) === target) return;

  try {
    await useWorkspaceStore().moveEntry(src, target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { t } = useI18n();
    useEditorStore().showToast(t('filetree.moveFailed', { msg }), 'error');
  }
}

function onCancel(): void {
  endDrag();
}

function endDrag(): void {
  stopAutoScroll();
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);
  window.removeEventListener('blur', onCancel);
  if (press) {
    try {
      if (document.body.hasPointerCapture(press.pointerId)) {
        document.body.releasePointerCapture(press.pointerId);
      }
    } catch {
      /* 指针已失效 */
    }
  }
  press = null;
  started = false;
  document.body.classList.remove('mk-dragging');
  hideDragGhost();
  treeDnd.src.value = null;
  treeDnd.over.value = null;
}

/** 松手后的那一次 click 必须在捕获阶段拦掉（否则会打开/展开拖过的行）。
 *  监听只在这 300ms 内存在，不留常驻的全局捕获监听 */
function armClickSwallow(): void {
  swallowClickUntil = Date.now() + CLICK_SWALLOW_MS;
  window.addEventListener('click', onSwallowClick, true);
  window.setTimeout(
    () => window.removeEventListener('click', onSwallowClick, true),
    CLICK_SWALLOW_MS + 100,
  );
}

function onSwallowClick(e: MouseEvent): void {
  if (Date.now() >= swallowClickUntil) return;
  e.preventDefault();
  e.stopPropagation();
}

/** 贴近树上下缘时每帧滚动；指针不动也要继续滚，所以不能挂在 pointermove 上 */
function startAutoScroll(): void {
  if (scrollRaf) return;
  const tick = (): void => {
    scrollRaf = 0;
    if (!started || !press) return;
    const tree = press.tree;
    if (tree) {
      const r = tree.getBoundingClientRect();
      let dy = 0;
      if (lastY < r.top + EDGE) dy = -SCROLL_STEP;
      else if (lastY > r.bottom - EDGE) dy = SCROLL_STEP;
      if (dy) {
        const before = tree.scrollTop;
        tree.scrollTop += dy;
        if (tree.scrollTop !== before) {
          // 树滚动了，指针下的落点跟着换：不重算的话会移到旧落点
          treeDnd.over.value = hitTest(lastX, lastY, press.node);
        }
      }
    }
    scrollRaf = requestAnimationFrame(tick);
  };
  scrollRaf = requestAnimationFrame(tick);
}

function stopAutoScroll(): void {
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
}

/** 命中判定：目录行 → 该目录；树空白区 → 工作区根；文件行/自身/子孙/原父目录 → 无效 */
function hitTest(x: number, y: number, node: WorkspaceNode): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const row = el?.closest<HTMLElement>('.row');
  if (row) {
    if (!row.classList.contains('row--dir')) return null; // 文件行不收落点
    const path = row.dataset.path ?? null;
    if (!path) return null;
    if (path === node.path) return null;
    if (path === parentOf(node.path)) return null; // 拖回原父目录：不算移动
    if (node.kind === 'dir' && isInside(path, node.path)) return null; // 不能移进自己的子目录
    return path;
  }
  const tree = el?.closest<HTMLElement>('.tree');
  if (!tree) return null;
  if (isOnScrollbar(tree, x, y)) return null;
  const root = useWorkspaceStore().root;
  if (!root || root === parentOf(node.path)) return null;
  return root;
}

/** 指针是否落在元素的滚动条上（client 区之外）：拖过滑块松手不该触发「移到根」 */
function isOnScrollbar(el: HTMLElement, x: number, y: number): boolean {
  const r = el.getBoundingClientRect();
  const left = r.left + el.clientLeft;
  const top = r.top + el.clientTop;
  return x >= left + el.clientWidth || y >= top + el.clientHeight;
}

function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}

function isInside(child: string, ancestor: string): boolean {
  const s = ancestor.includes('\\') ? '\\' : '/';
  return child === ancestor || child.startsWith(ancestor + s);
}
