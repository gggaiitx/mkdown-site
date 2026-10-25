/**
 * 文件树排序（纯函数，便于单测；调用方是 FileTree 的 applySort）。
 *
 * 三条口径：
 * 1. **目录恒在前**——与资源管理器一致，混排会让人找不到入口；
 * 2. 同组内按所选规则；缺值（目录没有 size/mtime，后端返回 None）按 0 处理，
 *    组内因此退化为名称序，不会出现"点了大小排序目录乱跳"；
 * 3. 主键相同时用名称兜底，避免同一毫秒/同一字节的两个文件每次刷新顺序都变（排序不稳定会闪）。
 */
import type { FileTreeSort, WorkspaceNode } from '../api/types';

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/**
 * 名称比较：数字段按数值（img2 < img10），其余逐字符小写后按 Unicode 码点。
 *
 * 不用 `Intl.Collator('zh-Hans-CN')`：ICU 的中文排序把汉字排在拉丁字母**之前**，
 * 而后端 build_tree 用的是 `to_lowercase().cmp()`（码点序，汉字在后）。
 * 两套规则混用会让「名称 A→Z」一开就跟打开工作区时的顺序不一样，看着像 bug。
 */
export function naturalCompare(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a[i];
    const cb = b[j];
    if (isDigit(ca) && isDigit(cb)) {
      let si = i;
      while (si < a.length && isDigit(a[si])) si++;
      let sj = j;
      while (sj < b.length && isDigit(b[sj])) sj++;
      // 去掉前导零再比长度：长度不同直接比位数，同位数再按字典序
      const na = a.slice(i, si).replace(/^0+/, '') || '0';
      const nb = b.slice(j, sj).replace(/^0+/, '') || '0';
      if (na.length !== nb.length) return na.length - nb.length;
      if (na !== nb) return na < nb ? -1 : 1;
      i = si;
      j = sj;
      continue;
    }
    const x = ca.toLowerCase();
    const y = cb.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    i++;
    j++;
  }
  // 一方是另一方的前缀：短的在前
  const byLength = a.length - i - (b.length - j);
  if (byLength !== 0) return byLength;
  // 语义相等但写法不同（img2 vs img02、A.md vs a.md）：原始字符串兜底，
  // 否则返回 0 会让顺序取决于后端/刷新时的输入次序，排序结果看着随机
  return a < b ? -1 : a > b ? 1 : 0;
}

function kindRank(n: WorkspaceNode): number {
  return n.kind === 'dir' ? 0 : 1;
}

export function compareNodes(a: WorkspaceNode, b: WorkspaceNode, sort: FileTreeSort): number {
  const byKind = kindRank(a) - kindRank(b);
  if (byKind !== 0) return byKind;

  const byName = (): number => naturalCompare(a.name, b.name);
  switch (sort) {
    case 'name-desc':
      return naturalCompare(b.name, a.name);
    case 'mtime-desc':
      return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || byName();
    case 'mtime-asc':
      return (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0) || byName();
    case 'size-desc':
      return (b.size ?? 0) - (a.size ?? 0) || byName();
    case 'size-asc':
      return (a.size ?? 0) - (b.size ?? 0) || byName();
    case 'name-asc':
    default:
      return byName();
  }
}

/**
 * 就地重排整棵树。
 *
 * 为什么不只在渲染层排序：可见行（键盘 ↑/↓ 导航、过滤结果、选中项定位）都是按 `ws.tree`
 * 的真实顺序算的，渲染层单独排会导致"按方向键跳到看不见的位置"。所以直接改树本身，
 * 保证渲染、键盘、过滤三者顺序一致。只在打开工作区与切换排序时各跑一次。
 */
export function sortTreeInPlace(node: WorkspaceNode, sort: FileTreeSort): void {
  const children = node.children;
  if (!children || children.length === 0) return;
  children.sort((a, b) => compareNodes(a, b, sort));
  for (const c of children) sortTreeInPlace(c, sort);
}
