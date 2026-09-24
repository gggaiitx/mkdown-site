/**
 * 右键菜单通用逻辑：视口夹紧定位（贴近窗口底部/右缘时自动收回视口内）。
 * 用法：模板菜单根元素绑定 :ref="setMenuRef"，open(x,y) 后 nextTick 内完成夹紧。
 */
import { nextTick, ref } from 'vue';

export function useCtxMenu() {
  const menu = ref<{ x: number; y: number } | null>(null);
  const menuRef = ref<HTMLElement | null>(null);

  function open(x: number, y: number) {
    menu.value = { x, y };
    void nextTick(() => {
      const el = menuRef.value;
      if (!el || !menu.value) return;
      const rect = el.getBoundingClientRect();
      let nx = menu.value.x;
      let ny = menu.value.y;
      if (nx + rect.width > window.innerWidth - 6) nx = Math.max(6, window.innerWidth - rect.width - 6);
      if (ny + rect.height > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - rect.height - 6);
      if (nx !== menu.value.x || ny !== menu.value.y) menu.value = { x: nx, y: ny };
    });
  }

  function close() {
    menu.value = null;
  }

  /** 模板函数 ref 绑定（:ref="setMenuRef"），用于测量菜单尺寸做视口夹紧 */
  function setMenuRef(el: unknown) {
    menuRef.value = (el as HTMLElement | null) ?? null;
  }

  return { menu, menuRef, setMenuRef, open, close };
}
