/**
 * 从 SVG 源码读设计尺寸。给 SvgFrame 算「适应窗口」用。
 *
 * ★ 为什么不能靠量 DOM：只有 viewBox、省略 width/height 的 svg（各家导出工具的默认
 *   产物）在 `body{display:flex}` + `svg{margin:auto}` 这套壳里被浏览器解成 100% 容器宽
 *   ——实测 638×560 视口量出 638×639。拿到的是布局快照而不是设计尺寸，而固有尺寸
 *   又只在首帧定一次并冻结（拖宽分栏不重测），适配率一错就一路错到下次内容变化。
 */

/** 只认无单位或 px 单位的正数：width="640" 和 width="640px" 都算（SVG 1.1 两种合法写法），
 *  width="100%" / "2em" / "-5" 都不算（返回 0）——百分比跟着容器变，不是设计尺寸 */
function attrNum(tag: string, name: string): number {
  const raw = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  if (!raw) return 0;
  const m = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(raw.trim());
  return m ? Number(m[1]) : 0;
}

/** 源码里的 viewBox 宽高（内在坐标系），缺失或非法返回 0 */
function viewBoxSize(tag: string): { w: number; h: number } {
  const raw = /viewBox\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
  if (!raw) return { w: 0, h: 0 };
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !Number.isFinite(parts[2]) || !Number.isFinite(parts[3])) {
    return { w: 0, h: 0 };
  }
  return { w: parts[2] > 0 ? parts[2] : 0, h: parts[3] > 0 ? parts[3] : 0 };
}

/**
 * 返回 svg 的设计尺寸；读不出（无 viewBox 且 width/height 带单位或缺失）返回 null，
 * 由调用方决定兜底。width/height 属性优先——它才是规范定义的固有尺寸；
 * viewBox 只在该属性不是绝对数值时顶上。
 */
export function svgSizeFromSrc(src: string): { w: number; h: number } | null {
  // 起始标签里的属性值带 '>' 的情况极少（会被截短），此处只可能少读到一个属性，不会误读
  const tag = /<svg\b[^>]*>/i.exec(src)?.[0];
  if (!tag) return null;
  const vb = viewBoxSize(tag);
  const w = attrNum(tag, 'width') || vb.w;
  const h = attrNum(tag, 'height') || vb.h;
  return w && h ? { w, h } : null;
}
