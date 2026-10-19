/**
 * 阅读态「专注模式」：指针所在的那一个正文块保持清晰，同级其余块压淡。
 * 复用编辑态同一套 .mk-focus-dim（global.css 给透明度与过渡），md 阅读态与 .mh 阅读态共用。
 *
 * 为什么按指针而不是按光标：阅读态没有编辑光标可当「当前行」，指针是读者注意力唯一能白拿的
 * 代理量。落点由唤起菜单的那一次右键先记下（右键就在正文里），所以从右键菜单开开关即刻有反馈；
 * 只从设置面板开、鼠标还没进过正文时一片都不压淡——宁可不生效，也不要整页发灰像坏了。
 *
 * 命中用 elementsFromPoint 而不是 elementFromPoint：菜单是盖在落点上的浮层，
 * 取「该点的全部元素」再上溯到正文块，才不会因为菜单正开着而判空。
 */
const DIM = 'mk-focus-dim';

export interface ReadFocus {
  /** 开关（= 专注模式开着且处于阅读态）：关掉即清掉所有压淡类 */
  setOn(on: boolean): void;
  /** 记下指针落点（视口坐标）：右键唤起菜单与 pointermove 都走这里 */
  setPoint(x: number, y: number): void;
  /** 重算当前块，rAF 节流。滚动后同一落点会命中另一个块，故滚动也要调 */
  refresh(): void;
  /** 卸载：取消待执行的帧并清类 */
  dispose(): void;
}

export function createReadFocus(getParent: () => Element | null): ReadFocus {
  let on = false;
  let point: { x: number; y: number } | null = null;
  let current: Element | null = null;
  let frame = 0;

  /** 落点下属于 parent 直接子元素的正文块；命中浮层/留白时返回 null（调用方维持上一块） */
  function blockAt(parent: Element, x: number, y: number): Element | null {
    for (const hit of document.elementsFromPoint(x, y)) {
      let el: Element | null = hit;
      while (el && el.parentElement !== parent) el = el.parentElement;
      if (el) return el;
    }
    return null;
  }

  function paint(): void {
    frame = 0;
    const parent = getParent();
    const blocks = parent ? Array.from(parent.children) : [];
    if (!on || !parent || !point) {
      current = null;
      for (const b of blocks) b.classList.remove(DIM);
      return;
    }
    const hit = blockAt(parent, point.x, point.y);
    if (hit) current = hit;
    // 一块都没认出来（刚开开关、鼠标还没进正文）时不压淡任何块
    if (!current) {
      for (const b of blocks) b.classList.remove(DIM);
      return;
    }
    for (const b of blocks) b.classList.toggle(DIM, b !== current);
  }

  function schedule(): void {
    if (frame) return;
    frame = requestAnimationFrame(paint);
  }

  return {
    setOn(next) {
      if (on === next) return;
      on = next;
      schedule();
    },
    setPoint(x, y) {
      point = { x, y };
      if (on) schedule();
    },
    refresh() {
      if (on) schedule();
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      on = false;
      point = null;
      current = null;
      const parent = getParent();
      if (parent) for (const b of Array.from(parent.children)) b.classList.remove(DIM);
    },
  };
}
