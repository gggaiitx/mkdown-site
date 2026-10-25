/**
 * 拖拽名片：跟随指针的一个小标签（文件名 / 标签页标题）。
 *
 * 文件树与标签栏共用 —— 两处都是 pointer 自绘拖拽，原因见 utils/treeDnd.ts 顶部：
 * Tauri 在 Windows 上接管了 OLE 拖放，HTML5 drag 事件到不了前端，只能自己画。
 *
 * 元素必须是 pointer-events:none：拖拽落点靠 elementFromPoint 判定，
 * 名片若可命中，命中的永远是它自己，落点永远为空。
 */
let ghost: HTMLElement | null = null;

function ensure(): HTMLElement {
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.className = 'mk-drag-ghost';
    ghost.style.display = 'none';
    document.body.appendChild(ghost);
  }
  return ghost;
}

export function showDragGhost(text: string, x: number, y: number): void {
  const el = ensure();
  el.textContent = text;
  el.style.display = 'block';
  moveDragGhost(x, y);
}

export function moveDragGhost(x: number, y: number): void {
  if (!ghost) return;
  ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
}

export function hideDragGhost(): void {
  if (ghost) ghost.style.display = 'none';
}
