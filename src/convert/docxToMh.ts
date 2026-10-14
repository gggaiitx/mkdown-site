/**
 * DOCX → Markhtml 白名单净化（R4，docs/plan-word-convert.md §6.4）。
 * mammoth HTML → DOMParser → 按白名单重建，**输出即 wangEditor getHtml() 方言**
 * （保证 setHtml 回读无损，方言实证见方案 §2.1）：
 * - 保留标签：p, h1-h6, ul, ol, li, table, tbody, tr, th, td, blockquote, pre, code,
 *   strong, b, em, i, u, s, a, img, hr, br；
 * - 方言规则：空段落产出 <p><br></p>；空单元格 <td><br></td>；表格只建 <tbody>
 *   （thead 归并为 tbody，th 行自然成为首行）；<a> 带 target="_blank"；
 *   <img> 带 src+alt（有显式尺寸时带 style）；代码块 <pre><code>纯文本</code></pre>；
 * - 剥离：全部 style/class/id（img 显式尺寸除外）；span/div 等容器提升为内容；
 * - 不产出 todo（mammoth 无对应概念，边界记录 §2.1）。
 */
import type { ImageSaveStats } from './mammothImages';

/** 白名单：仅这些标签进入产物；thead 归并为 tbody（mh 无 thead） */
const KEEP = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'table', 'tbody', 'thead', 'tr', 'th', 'td',
  'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 's',
  'a', 'img', 'hr', 'br',
]);

/** li / td / th 的直接 <p> 子节点提升为内容（wangEditor 列表项/单元格不含 p 嵌套） */
const HOIST_P_IN = new Set(['li', 'td', 'th']);
/** 空块补 <br> 的标签（mh 方言） */
const EMPTY_BR_TAGS = new Set(['p', 'li', 'td', 'th']);

/** 只保留 width/height 声明（img 显式尺寸方言） */
function keepSizeStyle(style: string): string {
  const parts = style
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^(width|height)\s*:/i.test(s));
  return parts.join('; ');
}

function sanitizeNode(node: Node, doc: Document): Node {
  if (node.nodeType === Node.TEXT_NODE) {
    return doc.createTextNode(node.textContent ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return doc.createTextNode('');
  }
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  // 非白名单容器（span/div/font/figure…）：提升子节点为内容
  if (!KEEP.has(tag)) {
    const frag = doc.createDocumentFragment();
    for (const c of Array.from(el.childNodes)) frag.appendChild(sanitizeNode(c, doc));
    return frag;
  }

  // thead 归并为 tbody（mh 表格只有 tbody，th 行入首行）
  const outTag = tag === 'thead' ? 'tbody' : tag;
  const neo = doc.createElement(outTag);

  switch (tag) {
    case 'a': {
      const href = el.getAttribute('href');
      if (href) neo.setAttribute('href', href);
      neo.setAttribute('target', '_blank'); // mh 方言：a 恒 target="_blank"
      break;
    }
    case 'img': {
      const src = el.getAttribute('src') ?? '';
      neo.setAttribute('src', src);
      const alt = el.getAttribute('alt');
      if (alt) neo.setAttribute('alt', alt);
      const style = el.getAttribute('style');
      if (style) {
        const kept = keepSizeStyle(style);
        if (kept) neo.setAttribute('style', kept);
      }
      break;
    }
    case 'pre': {
      // 代码块：扁平化为 <pre><code>纯文本</code></pre>（内部标签一律摊平）
      const code = doc.createElement('code');
      code.textContent = el.textContent ?? '';
      neo.appendChild(code);
      return neo;
    }
    case 'td':
    case 'th': {
      // mh 方言属性名为大写 S 的 colSpan/rowSpan（DOM 大小写不敏感，统一小写输出即可回读）
      for (const attr of ['colspan', 'rowspan']) {
        const v = el.getAttribute(attr);
        if (v && Number(v) > 1) neo.setAttribute(attr, v);
      }
      break;
    }
    default:
      break;
  }

  for (const c of Array.from(el.childNodes)) {
    // li/td/th 下的 <p> 提升
    if (
      HOIST_P_IN.has(tag) &&
      c.nodeType === Node.ELEMENT_NODE &&
      (c as HTMLElement).tagName.toLowerCase() === 'p'
    ) {
      for (const pc of Array.from(c.childNodes)) neo.appendChild(sanitizeNode(pc, doc));
      continue;
    }
    neo.appendChild(sanitizeNode(c, doc));
  }

  // 空块补 <br>（mh 方言：不可省，否则 wangEditor 回读丢空段/空单元格）
  if (
    EMPTY_BR_TAGS.has(outTag) &&
    !(neo.textContent ?? '').trim() &&
    !neo.querySelector('img, br, hr')
  ) {
    neo.appendChild(doc.createElement('br'));
  }

  // mammoth 产出的表格行是 table 直接子节点（无 tbody/thead，2026-10-13 实测）；
  // mh 方言要求 <table><tbody><tr>…（否则 wangEditor setHtml 回读丢表格）：
  // 把所有直接子 <tr> 包进单个 <tbody>（首行保持 td，wangEditor 不要求 th）
  if (tag === 'table') {
    const hasSection = Array.from(neo.children).some((c) =>
      ['tbody', 'thead', 'tfoot'].includes(c.tagName.toLowerCase()),
    );
    if (!hasSection) {
      const tbody = doc.createElement('tbody');
      for (const c of Array.from(neo.childNodes)) tbody.appendChild(c);
      neo.appendChild(tbody);
    }
  }
  return neo;
}

/** mammoth HTML → mh 方言 HTML（可直接喂 wangEditor setHtml） */
export function htmlToMh(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = doc.createElement('div');
  for (const node of Array.from(doc.body.childNodes)) {
    out.appendChild(sanitizeNode(node, doc));
  }
  return out.innerHTML;
}

/* ---------------- DOCX → MH 完整管线（R4） ---------------- */

export interface DocxToMhResult {
  mh: string;
  /** 提取到的文本字符数（去标签 trim 后；0 → 调用方出「未提取到内容」警示，V11） */
  textLength: number;
  images: ImageSaveStats;
  warnings: string[];
}

/** 与 docxToMd 同口径的 styleMap（Quote→blockquote、代码样式→pre/code） */
const STYLE_MAP = [
  "p[style-name='Quote'] => blockquote",
  "p[style-name='Intense Quote'] => blockquote",
  "r[style-name='Code'] => code",
  "p[style-name='Code'] => pre",
];

/** readPreviewBytes → mammoth → 白名单净化（按 §2.1 方言产出） */
export async function docxToMh(docxPath: string): Promise<DocxToMhResult> {
  const { readPreviewBytes, tooLargeToPreview } = await import(
    '../components/preview/PreviewAssets'
  );
  const buf = await readPreviewBytes(docxPath);
  if (tooLargeToPreview(buf)) {
    throw new Error('docx too large');
  }
  const { makeConvertImage, newImageStats } = await import('./mammothImages');
  const mm = await import('mammoth');

  const images = newImageStats();
  const result = await mm.convertToHtml(
    { arrayBuffer: buf },
    {
      styleMap: STYLE_MAP,
      convertImage: makeConvertImage(docxPath, images),
    },
  );

  const probe = new DOMParser().parseFromString(result.value, 'text/html');
  const textLength = (probe.body.textContent ?? '').trim().length;

  return {
    mh: htmlToMh(result.value),
    textLength,
    images,
    warnings: result.messages
      .filter((m) => m.type === 'warning')
      .map((m) => m.message)
      .slice(0, 5),
  };
}
