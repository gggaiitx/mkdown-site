/**
 * DOCX → Markhtml 高保真管线（2026-10-13 试点，docs/research-word-convert-open-source.md 路线②）。
 * 与 docxToMh（mammoth 语义净化）的差异：mammoth 有意丢弃全部视觉样式（颜色/字号/对齐），
 * 本管线改用**已在依赖里的 docx-preview**（排版渲染器）关分页渲染出带完整 inline style 的 DOM，
 * 再净化映射到 wangEditor 方言——保留 color / font-size / background / 对齐 / 表格合并单元格。
 *
 * 已知边界（spike 第一版）：
 * - Word「标题样式」按 p 的 class（Heading1-6）识别为 h1-h6；识别不到降级普通段落（字号样式仍在）；
 * - Word 自动编号列表在 docx-preview 里渲染为带缩进的段落（非 ul/ol）→ 按段落保留缩进，不升列表；
 * - 页眉/页脚不渲染（renderHeaders/renderFooters 关闭）；文本框/艺术字不承诺保真（与语义管线一致）；
 * - 图片：docx-preview 产出 blob: URL → fetch 字节 → savePastedImage 落盘（失败降级 data: URL）。
 * 依赖动态 import（D4 懒加载）。
 */
import { readPreviewBytes, tooLargeToPreview } from '../components/preview/PreviewAssets';
import { savePastedImage } from '../api/imageApi';
import { newImageStats, type ImageSaveStats } from './mammothImages';

export interface DocxToMhFidelityResult {
  mh: string;
  /** 提取到的文本字符数（去标签 trim 后；0 → 调用方出「未提取到内容」警示，V11） */
  textLength: number;
  images: ImageSaveStats;
  warnings: string[];
}

/** 行内保留的样式声明（span/img）：颜色/字号/背景/图片尺寸 */
const INLINE_STYLE_KEEP = /^(color|background-color|font-size)\s*:/i;
/** img 额外保留尺寸（mh 方言 img style 显式尺寸） */
const IMG_STYLE_KEEP = /^(color|background-color|font-size|width|height)\s*:/i;
/** 块级保留的样式声明：对齐（wangEditor p 支持内联 text-align） */
const BLOCK_STYLE_KEEP = /^text-align\s*:/i;

function keepStyle(style: string | null, re: RegExp): string {
  if (!style) return '';
  return style
    .split(';')
    .map((s) => s.trim())
    .filter((s) => re.test(s))
    .join('; ');
}

/** pt → px（docx-preview 产出 pt 尺寸；mh 方言 img 尺寸用 px，1pt = 4/3px 四舍五入） */
function ptToPx(style: string): string {
  return style.replace(/(-?\d+(?:\.\d+)?)pt/g, (_, n) => `${Math.round(Number(n) * (4 / 3))}px`);
}

/** docx-preview span 的 font-weight/font-style/text-decoration → 语义标签 */
function inlineTagOf(el: HTMLElement): 'strong' | 'em' | 's' | 'u' | 'span' {
  const st = el.getAttribute('style') ?? '';
  if (/font-weight\s*:\s*(bold|[7-9]00)/i.test(st)) return 'strong';
  if (/font-style\s*:\s*italic/i.test(st)) return 'em';
  if (/text-decoration[^;]*line-through/i.test(st)) return 's';
  if (/text-decoration[^;]*underline/i.test(st)) return 'u';
  return 'span';
}

async function imageSrc(
  img: HTMLImageElement,
  docxPath: string,
  stats: ImageSaveStats,
): Promise<string> {
  const src = img.getAttribute('src') ?? '';
  // 非 blob: URL（data: 等）直接保留
  if (!src.startsWith('blob:')) return src;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    // 分块 base64
    let b64 = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      b64 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    const mime = blob.type || 'image/png';
    const ext = mime.split('/')[1]?.split(';')[0]?.toLowerCase() ?? 'png';
    const okExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext) ? ext : 'png';
    const saved = await savePastedImage(docxPath, b64, okExt);
    stats.saved++;
    return saved.relPath;
  } catch {
    // fetch 失败/落盘失败：blob URL 已失效风险，降级占位（无法回源字节）
    stats.inline++;
    return src;
  }
}

/** 行内净化：文本/语义标签/图片/链接 → mh 方言片段（返回 HTML 字符串，串行处理图片） */
async function inlineHtml(node: Node, doc: Document, docxPath: string, stats: ImageSaveStats): Promise<string> {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent ?? '';
    return t ? escapeHtml(t) : '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return '<br>';
  if (tag === 'img') {
    const src = await imageSrc(el as HTMLImageElement, docxPath, stats);
    const alt = el.getAttribute('alt') ?? '';
    const style = ptToPx(keepStyle(el.getAttribute('style'), IMG_STYLE_KEEP));
    return `<img src="${escapeAttr(src)}"${alt ? ` alt="${escapeAttr(alt)}"` : ''}${style ? ` style="${escapeAttr(style)}"` : ''}/>`;
  }
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    const inner = await childrenInlineHtml(el, doc, docxPath, stats);
    return href && !href.startsWith('#')
      ? `<a href="${escapeAttr(href)}" target="_blank">${inner}</a>`
      : inner;
  }
  if (tag === 'style' || tag === 'script') return '';
  // span/em/strong/…：docx-preview 主用 span + style
  const sem = inlineTagOf(el);
  const style = keepStyle(el.getAttribute('style'), INLINE_STYLE_KEEP);
  const inner = await childrenInlineHtml(el, doc, docxPath, stats);
  if (!inner) return '';
  if (sem === 'span' && !style) return inner;
  return `<${sem}${style ? ` style="${escapeAttr(style)}"` : ''}>${inner}</${sem}>`;
}

async function childrenInlineHtml(
  el: HTMLElement,
  doc: Document,
  docxPath: string,
  stats: ImageSaveStats,
): Promise<string> {
  let out = '';
  for (const c of Array.from(el.childNodes)) {
    out += await inlineHtml(c, doc, docxPath, stats);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 块级净化：p/h/table/img/容器 → mh 方言块 */
async function blockHtml(
  node: Node,
  doc: Document,
  docxPath: string,
  stats: ImageSaveStats,
): Promise<string> {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? '').trim();
    return t ? `<p>${escapeHtml(t)}</p>` : '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === 'style' || tag === 'script') return '';
  if (tag === 'br') return '';
  if (tag === 'hr') return '<hr/>';
  if (tag === 'img') {
    const inner = await inlineHtml(el, doc, docxPath, stats);
    return `<p>${inner}</p>`;
  }
  if (tag === 'table') {
    return tableHtml(el, doc, docxPath, stats);
  }

  // 标题识别：docx-preview 的 p class 为 `docx_heading1`-`docx_heading6`（0.4.x 实测），
  // 用包含式匹配兼容版本差异；识别不到按普通段落（字号样式仍在 class CSS，不丢内容）
  const cls = el.getAttribute('class') ?? '';
  const hm = /heading([1-6])/i.exec(cls);
  const isP = tag === 'p';
  if (isP || hm || tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    const inner = await childrenInlineHtml(el, doc, docxPath, stats);
    const align = keepStyle(el.getAttribute('style'), BLOCK_STYLE_KEEP);
    const attr = align ? ` style="${escapeAttr(align)}"` : '';
    if (!inner.trim()) return `<p${attr}><br></p>`; // mh 方言：空段 <p><br></p>
    if (hm) return `<h${hm[1]}${attr}>${inner}</h${hm[1]}>`;
    return `<p${attr}>${inner}</p>`;
  }

  // ul/ol/li（docx-preview 偶发产出）与未知容器（section/article/div/header…）：透传子块
  let out = '';
  for (const c of Array.from(el.childNodes)) {
    out += await blockHtml(c, doc, docxPath, stats);
  }
  return out;
}

/** 表格：保 colspan/rowspan；行收集跨 thead/tbody；单元格内块递归（mh 无 thead，th 行入首行） */
async function tableHtml(
  tableEl: HTMLElement,
  doc: Document,
  docxPath: string,
  stats: ImageSaveStats,
): Promise<string> {
  const rows: HTMLElement[] = [];
  const collect = (parent: HTMLElement) => {
    for (const c of Array.from(parent.children)) {
      const t = c.tagName.toLowerCase();
      if (t === 'tr') rows.push(c as HTMLElement);
      else if (['thead', 'tbody', 'tfoot'].includes(t)) collect(c as HTMLElement);
    }
  };
  collect(tableEl);
  if (!rows.length) return '';

  let body = '';
  for (const tr of rows) {
    let row = '';
    for (const cell of Array.from(tr.children)) {
      const ct = cell.tagName.toLowerCase();
      if (ct !== 'td' && ct !== 'th') continue;
      const td = cell as HTMLElement;
      const colSpan = Number(td.getAttribute('colspan') ?? td.getAttribute('colSpan') ?? '1') || 1;
      const rowSpan = Number(td.getAttribute('rowspan') ?? td.getAttribute('rowSpan') ?? '1') || 1;
      let cellInner = '';
      for (const c of Array.from(td.childNodes)) {
        // 单元格内的直接 <p> 提升为内容（mh 单元格不含 p 嵌套）
        if (c.nodeType === Node.ELEMENT_NODE && (c as HTMLElement).tagName.toLowerCase() === 'p') {
          cellInner += await childrenInlineHtml(c as HTMLElement, doc, docxPath, stats);
          cellInner += '<br>';
          continue;
        }
        cellInner += await blockHtml(c, doc, docxPath, stats);
      }
      // mh 方言：空单元格 <td><br></td>；去掉行尾多余 <br>
      cellInner = cellInner.replace(/<br>$/, '') || '<br>';
      const attrs =
        `${colSpan > 1 ? ` colspan="${colSpan}"` : ''}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ''}`;
      row += `<td${attrs}>${cellInner}</td>`;
    }
    if (row) body += `<tr>${row}</tr>`;
  }
  return body ? `<table><tbody>${body}</tbody></table>` : '';
}

export async function docxToMhFidelity(docxPath: string): Promise<DocxToMhFidelityResult> {
  const buf = await readPreviewBytes(docxPath);
  if (tooLargeToPreview(buf)) {
    throw new Error('docx too large');
  }
  const images = newImageStats();
  const { renderAsync } = await import('docx-preview');

  // 离屏渲染（breakPages 关分页 → 连续文档流；页眉页脚不进内容文档）
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-99999px;top:0;width:860px;visibility:hidden;pointer-events:none;';
  document.body.appendChild(host);
  try {
    await renderAsync(buf, host, undefined, {
      breakPages: false,
      renderHeaders: false,
      renderFooters: false,
      experimental: true,
    });
    const doc = document;
    let mh = '';
    for (const c of Array.from(host.childNodes)) {
      mh += await blockHtml(c, doc, docxPath, images);
    }
    const textLength = (host.textContent ?? '').replace(/\u200b/g, '').trim().length;
    return {
      mh,
      textLength,
      images,
      warnings: [
        '高保真管线（试点）：颜色/字号/对齐已保留；自动编号列表以缩进段落呈现，标题样式按 Word 样式名识别。',
      ],
    };
  } finally {
    host.remove();
  }
}
