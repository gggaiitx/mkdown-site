/**
 * Mermaid / KaTeX → docx 嵌入位图的统一序列化管线（D5 + D9）。
 * 全部在 WebView 内完成（canvas），无网络请求：
 * - Mermaid：预览 DOM 的 <svg> 序列化直嵌（ImageRun type:'svg'）+ 同源 PNG fallback；
 * - KaTeX：文本层光栅化（按实时 DOM 布局绘制，见 rasterizeHtmlText——foreignObject
 *   路线被 Chromium 画布污染限制封死，实测结论记录在该函数注释）。
 * D9：光栅化失败时返回 { source }，由映射层降级为 $...$ 源码文本 + toast 汇总。
 */

import { katexTexOf } from '../utils/katexTex';

export interface ImagefyResult {
  /** SVG 字节（Mermaid 直嵌用） */
  svg?: Uint8Array;
  /** PNG 字节（fallback / KaTeX 公式图） */
  png?: Uint8Array;
  /** 显示尺寸（px，96dpi 口径） */
  width?: number;
  height?: number;
  /** KaTeX 源码（序列化失败时携带，供降级） */
  source?: string;
  /** 降级源码的来源类型（mermaid 源码不加 $…$ 包裹） */
  kind?: 'katex' | 'mermaid';
}

/** PNG 光栅化倍率：公式/图在 Word 里常被缩放，2x 兼顾清晰度与体积 */
const RASTER_SCALE = 2;

function isSvg(el: Element): boolean {
  return el.tagName.toLowerCase() === 'svg';
}

/** 读 <svg> 的显式 px 尺寸；仅接受纯数字（pt/%/em 等放弃，回退 rect） */
function svgPxSize(svg: Element): { width: number; height: number } | undefined {
  const w = svg.getAttribute('width');
  const h = svg.getAttribute('height');
  const wn = w ? Number(w.replace(/px$/, '')) : NaN;
  const hn = h ? Number(h.replace(/px$/, '')) : NaN;
  if (Number.isFinite(wn) && Number.isFinite(hn) && wn > 0 && hn > 0) {
    return { width: wn, height: hn };
  }
  return undefined;
}

/** SVG 元素 → PNG 字节（铺白底：透明底在 Word 里发灰） */
async function svgToPng(svg: Element, w: number, h: number): Promise<Uint8Array> {
  const clone = svg.cloneNode(true) as Element;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg decode failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * RASTER_SCALE));
    canvas.height = Math.max(1, Math.round(h * RASTER_SCALE));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('png encode failed');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 任意 SVG 字节 → PNG（普通 <img src="*.svg"> 的位图化兜底，Word 旧版不渲染 SVG）。
 * 尺寸取 SVG 自身属性/viewBox，缺失按 640×480 兜底；失败返回 null。
 */
export async function rasterizeSvgBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  const text = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) return null;
  const px = svgPxSize(svg);
  let w = px?.width ?? 0;
  let h = px?.height ?? 0;
  if (w <= 0 || h <= 0) {
    const vb = /<svg[^>]*?\bviewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i.exec(text);
    w = vb ? Number(vb[1]) : 640;
    h = vb ? Number(vb[2]) : 480;
  }
  try {
    return await svgToPng(svg, w, h);
  } catch {
    return null;
  }
}

/** Mermaid 容器（或 svg 自身）→ SVG 直嵌 + PNG fallback */
async function imagefyMermaid(container: Element): Promise<ImagefyResult | null> {
  const svg = isSvg(container) ? container : container.querySelector('svg');
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  let w = rect.width;
  let h = rect.height;
  const px = svgPxSize(svg);
  if (px) {
    w = px.width;
    h = px.height;
  } else if (w <= 0 || h <= 0) {
    // 无布局信息（display:none 等）：从 viewBox 兜底，再不行按 16:9 默认
    const vb = /<svg[^>]*?\bviewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i.exec(svg.outerHTML);
    const vw = vb ? Number(vb[1]) : 0;
    const vh = vb ? Number(vb[2]) : 0;
    w = vw > 0 && vh > 0 ? vw : 640;
    h = vw > 0 && vh > 0 ? vh : 360;
  }
  w = Math.max(1, Math.min(w, 4000));
  h = Math.max(1, Math.min(h, 4000));
  const svgBytes = new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
  let png: Uint8Array | undefined;
  try {
    png = await svgToPng(svg, w, h);
  } catch {
    png = undefined;
  }
  // 无 PNG fallback 的裸 SVG 直嵌对旧版 Word 不友好，但现代 Word/WPS 均支持；
  // PNG 失败仍给出 SVG（R4 双嵌策略的降级形态），映射层自行决定。
  return { svg: svgBytes, png, width: w, height: h };
}

/**
 * HTML 节点文本层光栅化（KaTeX 专用，D5 高保真路线）。
 *
 * 为什么不走 foreignObject → canvas：实测 Chromium/WebView2 对**任何含 foreignObject 的
 * SVG 图片**一律污染画布（toBlob 抛 Tainted canvas），blob:/data:/同源 http 均然，
 * 与外部引用无关（隔离实验：去 foreignObject 即恢复）。纯 SVG（Mermaid）不受影响。
 *
 * 做法：按实时 DOM 布局把每个文本节点画进 canvas——字体/坐标/颜色取计算值，
 * KaTeX 的逐字定位 span 天然适配；保真度高于图片化（用应用内已加载的 KaTeX 字体）。
 */
async function rasterizeHtmlText(el: HTMLElement, scale = 2): Promise<Uint8Array | null> {
  try {
    await (document.fonts?.ready ?? Promise.resolve());
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(rect.width));
    const h = Math.max(1, Math.ceil(rect.height));
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.translate(-rect.left, -rect.top);
    ctx.textBaseline = 'alphabetic';

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);

    for (const tn of nodes) {
      const text = tn.textContent ?? '';
      if (!text || !text.trim()) continue;
      const parent = tn.parentElement;
      if (!parent) continue;
      // 跳过 KaTeX 的 .katex-mathml 隐藏副本（屏幕阅读盲文注释），只绘制可见 .katex-html 字形，
      // 否则会与真实渲染重叠出重影/乱码
      let p: Element | null = parent;
      let inMathml = false;
      while (p && p !== el) {
        if (p.classList?.contains('katex-mathml')) { inMathml = true; break; }
        p = p.parentElement;
      }
      if (inMathml) continue;
      const cs = getComputedStyle(parent);
      // 仅跳过 display:none（零布局）；不跳过 visibility:hidden——离屏 staging 容器本身即
      // visibility:hidden 但保有布局，公式字形在此态下仍能量测并正确光栅化
      if (cs.display === 'none') continue;
      const range = document.createRange();
      range.selectNodeContents(tn);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 || r.height > 0.5);
      // 单行文本节点才画（KaTeX 逐字 span 恒单行；跨行节点画不满，宁缺勿滥）
      if (rects.length !== 1) continue;
      const r = rects[0];
      const fontSize = parseFloat(cs.fontSize) || 12;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`;
      const color = cs.color && cs.color !== 'rgba(0, 0, 0, 0)' ? cs.color : '#000000';
      ctx.fillStyle = color;
      const descent = ctx.measureText(text).actualBoundingBoxDescent || fontSize * 0.21;
      ctx.fillText(text, r.left, r.bottom - descent);
    }

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** KaTeX 节点 → PNG（文本层光栅化）；失败按 D9 返回源码。
 *  源码走 katexTexOf 那三条通道；全落空才退回视觉层那一半——绝不能取整棵 textContent，
 *  MathML 的 mi/mo/mn 会和源码拼成「Emc2E=mc^2」，Word 里就是重复一遍的公式 */
async function imagefyKatex(katexEl: Element): Promise<ImagefyResult | null> {
  const source = katexTexOf(katexEl)
    || ((katexEl.querySelector('.katex-html') ?? katexEl).textContent ?? '').trim();
  const rect = katexEl.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width || 40));
  const h = Math.max(1, Math.round(rect.height || 20));
  try {
    const png = await rasterizeHtmlText(katexEl as HTMLElement);
    if (!png) return { source }; // D9：源码降级
    return { png, width: w, height: h, source };
  } catch {
    return { source }; // D9：源码降级
  }
}

/**
 * 统一入口：识别 Mermaid / KaTeX 节点并序列化。
 * 非图表公式节点返回 null（调用方按普通元素处理）。
 *
 * 注意：md-editor 渲染后的 mermaid 容器类名是 {prefix}-mermaid（如 md-editor-mermaid），
 * classList.contains('mermaid') 匹配不到——统一用 class 字符串包含判断。
 */
export async function imagefyNode(el: Element): Promise<ImagefyResult | null> {
  try {
    const katexEl = el.classList.contains('katex') ? el : el.querySelector('.katex');
    if (katexEl) return await imagefyKatex(katexEl);
    const cls = el.getAttribute('class') ?? '';
    if (cls.includes('mermaid') || el.querySelector('[class*="mermaid"]')) {
      const r = await imagefyMermaid(el);
      if (r) return r;
      // 无 svg（渲染未完成/失败/源码 div）：携带源码文本走 D9 降级，绝不静默出空白
      const src = (el.textContent ?? '').trim();
      return src ? { source: src, kind: 'mermaid' } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** KaTeX 降级源码的呈现口径（D9：保留 $...$ 文本） */
export function katexSourceText(source: string): string {
  const s = source.trim();
  if (!s) return '';
  return s.startsWith('$') || s.endsWith('$') ? s : `$${s}$`;
}
