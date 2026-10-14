/**
 * HTML → DOCX 映射层（R1/R2 核心，docs/plan-word-convert.md §5.2）。
 * 输入：预览/显示态 HTML 快照 + 字体基线；输出：docx Blob。
 *
 * 设计纪律：
 * - 语义标签白名单遍历（h1-h6/p/table/ul/ol/blockquote/pre/hr/img/a/strong/em/u/s/code/br/sup/sub），
 *   未知容器透传子节点，data-* 一律忽略——免疫预览 DOM 杂质与 wangEditor 内部属性（V2）；
 * - pre / 行内 code 内部递归取 textContent 摊平为单一样式 run——hljs token span 不泄漏（V2）；
 * - 纯函数参数化（不 import store），可单测；docx 包动态 import（D4 懒加载）。
 */
import type {
  AlignmentType as TAlignmentType,
  BorderStyle as TBorderStyle,
  ExternalHyperlink as TExternalHyperlink,
  HeadingLevel as THeadingLevel,
  IParagraphOptions as TIParagraphOptions,
  ImageRun as TImageRun,
  Paragraph as TParagraph,
  ParagraphChild as TParagraphChild,
  Table as TTable,
  TableCell as TTableCell,
  TableRow as TTableRow,
  TextRun as TTextRun,
  VerticalAlignTable as TVerticalAlignTable,
  WidthType as TWidthType,
} from 'docx';
import { loadDocxAsset, type DocxAsset } from './docxAssets';
import { imagefyNode, katexSourceText, rasterizeSvgBytes } from './docxImagefy';

/** 正文字体基线（D2；与 AppSettings.wordFontZh/En/Size 对应） */
export interface WordStyleOpts {
  fontZh: string;
  fontEn: string;
  fontSize: number;
}

export interface HtmlToDocxResult {
  blob: Blob;
  /** KaTeX 源码降级数量（D9：foreignObject 序列化失败） */
  degradedFormulas: number;
  /** 图片抓取/序列化失败数量（降级 alt 或跳过） */
  failedImages: number;
}

/** A4 内容宽：21cm − 左右 3.18cm×2 = 14.64cm ≈ 554px @96dpi，超宽图片按此比例缩放 */
const MAX_IMG_W = 554;
/** 列表最大层级（numbering levels 0-5，HTML 更深嵌套按 5 处理） */
const MAX_LIST_LEVEL = 5;

/** docx 运行期类集合（动态 import 后注入 ctx.kit，同步遍历直接用） */
interface DocxKit {
  TextRun: typeof TTextRun;
  ExternalHyperlink: typeof TExternalHyperlink;
  ImageRun: typeof TImageRun;
  Paragraph: typeof TParagraph;
  Table: typeof TTable;
  TableRow: typeof TTableRow;
  TableCell: typeof TTableCell;
  AlignmentType: typeof TAlignmentType;
  BorderStyle: typeof TBorderStyle;
  HeadingLevel: typeof THeadingLevel;
  WidthType: typeof TWidthType;
  VerticalAlignTable: typeof TVerticalAlignTable;
}

/* ---------------- 遍历上下文 ---------------- */

interface Fmt {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  sup: boolean;
  sub: boolean;
}

const baseFmt = (): Fmt => ({
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  sup: false,
  sub: false,
});

interface Ctx {
  kit: DocxKit;
  /** 相对路径图片解析基准（文档所在目录）；未保存文档无 */
  baseDir?: string;
  opts: WordStyleOpts;
  /** 引用块内：行run 灰斜体 */
  quote: boolean;
  degradedFormulas: number;
  failedImages: number;
  /** 图片抓取并发闸门（R7：限 6） */
  sem: Semaphore;
}

class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>((r) => this.queue.push(r));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

/** 当前遍历的基础行格式（引用块内恒灰斜体） */
function fmtOf(ctx: Ctx): Fmt {
  const f = baseFmt();
  if (ctx.quote) f.italic = true;
  return f;
}

/* ---------------- 行内 runs ---------------- */

function textRun(text: string, fmt: Fmt, ctx: Ctx): TTextRun {
  const common: Record<string, unknown> = {
    text,
    bold: fmt.bold || undefined,
    italics: fmt.italic || undefined,
    strike: fmt.strike || undefined,
    color: ctx.quote ? '57606A' : '24292F',
  };
  if (fmt.underline) common.underline = {};
  if (fmt.sup) common.superScript = true;
  if (fmt.sub) common.subScript = true;
  if (fmt.code) {
    common.font = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: ctx.opts.fontZh };
    common.shading = { fill: 'F0F1F2', type: 'clear', color: 'auto' };
  }
  return new ctx.kit.TextRun(common);
}

/** 行内遍历：文本 + 行内标记 + 链接 + 行内图片；返回 ParagraphChild 列表 */
async function buildInline(node: Node, fmt: Fmt, ctx: Ctx): Promise<TParagraphChild[]> {
  const out: TParagraphChild[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? '';
      if (text) out.push(textRun(text, fmt, ctx));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    switch (el.tagName.toLowerCase()) {
      case 'strong':
      case 'b':
        out.push(...(await buildInline(el, { ...fmt, bold: true }, ctx)));
        break;
      case 'em':
      case 'i':
        out.push(...(await buildInline(el, { ...fmt, italic: true }, ctx)));
        break;
      case 'u':
        out.push(...(await buildInline(el, { ...fmt, underline: true }, ctx)));
        break;
      case 's':
      case 'del':
      case 'strike':
        out.push(...(await buildInline(el, { ...fmt, strike: true }, ctx)));
        break;
      case 'code':
      case 'kbd':
      case 'samp':
        out.push(...(await buildInline(el, { ...fmt, code: true }, ctx)));
        break;
      case 'sup':
        out.push(...(await buildInline(el, { ...fmt, sup: true }, ctx)));
        break;
      case 'sub':
        out.push(...(await buildInline(el, { ...fmt, sub: true }, ctx)));
        break;
      case 'br':
        out.push(new ctx.kit.TextRun({ text: '', break: 1 }));
        break;
      case 'a': {
        const href = el.getAttribute('href') ?? '';
        const kids = await buildInline(el, fmt, ctx);
        if (!kids.length) break;
        // '#' 锚链降级纯文本（映射矩阵）
        if (!href || href.startsWith('#')) {
          out.push(...kids);
        } else {
          out.push(new ctx.kit.ExternalHyperlink({ children: kids, link: href }));
        }
        break;
      }
      case 'img': {
        // 行内图片：抓取字节 → ImageRun；失败降级 alt 占位（与块级同口径）
        const r = await imageRunFor(el as HTMLImageElement, ctx);
        if (r) out.push('run' in r ? r.run : textRun(r.text, fmt, ctx));
        break;
      }
      default: {
        // 行内 KaTeX / Mermaid：md 预览里公式是 <p> 内的 span.katex（行间公式），
        // 块级遍历够不着——此处识别并走同一序列化管线（D5/D9）；
        // mermaid 类名带前缀（md-editor-mermaid），用 class 字符串包含 + 通配查询
        const inlineCls = el.getAttribute('class') ?? '';
        if (
          inlineCls.includes('katex') ||
          inlineCls.includes('mermaid') ||
          el.querySelector('.katex, [class*="mermaid"]')
        ) {
          const r = await chartRunFor(el, ctx);
          if (r) out.push('run' in r ? r.run : textRun(r.text, fmt, ctx));
          break;
        }
        // span/font/small/mark/未知行内元素：透传子节点（data-* 天然忽略，V2）
        out.push(...(await buildInline(el, fmt, ctx)));
        break;
      }
    }
  }
  return out;
}

/* ---------------- 块级遍历 ---------------- */

async function buildBlocks(nodes: NodeListOf<ChildNode>, ctx: Ctx): Promise<(TParagraph | TTable)[]> {
  const out: (TParagraph | TTable)[] = [];
  const { HeadingLevel } = ctx.kit;
  const fmt0 = fmtOf(ctx);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').trim();
      if (text) out.push(mkPara({ children: [textRun(text, fmt0, ctx)] }, ctx));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // Mermaid / KaTeX 容器（块级）：mermaid 类名带编辑器前缀（md-editor-mermaid），
    // classList.contains 精确匹配不到——统一用 class 字符串包含判断
    const blockCls = el.getAttribute('class') ?? '';
    if (blockCls.includes('mermaid') || blockCls.includes('katex')) {
      const p = await chartParagraph(el, ctx);
      if (p) out.push(p);
      continue;
    }

    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(tag[1]);
        const runs = await buildInline(el, fmt0, ctx);
        out.push(
          mkPara(
            {
              heading: HeadingLevel[`HEADING_${level}` as keyof typeof HeadingLevel],
              children: runs.length ? runs : undefined,
            },
            ctx,
          ),
        );
        break;
      }
      case 'p': {
        // mh 方言：空段落恒 <p><br></p> → 空 Paragraph（映射矩阵）
        if (isEmptyParagraph(el)) {
          out.push(mkPara({}, ctx));
          break;
        }
        const runs = await buildInline(el, fmt0, ctx);
        out.push(mkPara({ children: runs.length ? runs : undefined }, ctx));
        break;
      }
      case 'hr':
        out.push(
          mkPara(
            {
              spacing: { before: 200, after: 200 },
              border: { bottom: { style: 'single', size: 6, color: 'B0B7BD' } },
            },
            ctx,
          ),
        );
        break;
      case 'blockquote': {
        // 引用块：子块在 quote 上下文重建（run 灰斜体 + 段级左缩进/左边框，见 mkPara）
        out.push(...(await buildBlocks(el.childNodes, { ...ctx, quote: true })));
        break;
      }
      case 'pre':
        out.push(...codeBlockParagraphs(el, ctx));
        break;
      case 'ul':
      case 'ol':
        out.push(...(await listParagraphs(el, tag === 'ol' ? 'mk-ol' : 'mk-ul', 0, ctx)));
        break;
      case 'table':
        out.push(await buildTable(el as HTMLTableElement, ctx));
        break;
      case 'img':
      case 'figure': {
        const img = tag === 'img' ? (el as HTMLImageElement) : el.querySelector('img');
        const p = img ? await imageParagraph(img, ctx) : null;
        if (p) out.push(p);
        break;
      }
      case 'div': {
        // wangEditor 待办：div[data-w-e-type="todo"] → ☐/☑ 文本降级（§2.1）
        if (el.getAttribute('data-w-e-type') === 'todo') {
          const checked = !!el.querySelector('input[checked]');
          const text = (el.textContent ?? '').trim();
          out.push(mkPara({ children: [textRun(`${checked ? '☑' : '☐'} ${text}`, fmt0, ctx)] }, ctx));
          break;
        }
        // 未知 div（含预览 DOM 包裹层）：透传子节点
        out.push(...(await buildBlocks(el.childNodes, ctx)));
        break;
      }
      default:
        // section/article/main/dl/figure 等：透传
        out.push(...(await buildBlocks(el.childNodes, ctx)));
        break;
    }
  }
  return out;
}

/** 段落工厂：引用块内统一补左缩进 + 左边框（blockquote 修饰在此收敛） */
function mkPara(opts: TIParagraphOptions, ctx: Ctx): TParagraph {
  if (ctx.quote) {
    return new ctx.kit.Paragraph({
      ...opts,
      indent: { left: 360 },
      border: { left: { style: 'single', size: 12, color: 'D0D7DE', space: 8 } },
    });
  }
  return new ctx.kit.Paragraph(opts);
}

/** 空段落判定：无文本且无 img/input（mh 方言 <p><br></p>） */
function isEmptyParagraph(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').replace(/\u200b/g, '').trim();
  if (text) return false;
  return !el.querySelector('img, input');
}

/* ---------------- 代码块 ---------------- */

function codeBlockParagraphs(pre: HTMLElement, ctx: Ctx): TParagraph[] {
  // 扁平化：内部 hljs token span 递归摊平为纯文本（V2）
  const text = (pre.querySelector('code')?.textContent ?? pre.textContent ?? '').replace(/\n$/, '');
  const lines = text.split('\n');
  return lines.map((line) =>
    mkPara(
      {
        spacing: { after: 0, line: 260 },
        shading: { fill: 'F6F8FA', type: 'clear', color: 'auto' },
        border: { left: { style: 'single', size: 12, color: 'D0D7DE', space: 6 } },
        children: [
          new ctx.kit.TextRun({
            text: line || ' ',
            font: { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: ctx.opts.fontZh },
            size: (Math.max(9, ctx.opts.fontSize) - 1) * 2,
            color: '24292F',
          }),
        ],
      },
      ctx,
    ),
  );
}

/* ---------------- 列表 ---------------- */

async function listParagraphs(
  listEl: HTMLElement,
  reference: 'mk-ul' | 'mk-ol',
  level: number,
  ctx: Ctx,
): Promise<TParagraph[]> {
  const out: TParagraph[] = [];
  const lv = Math.min(level, MAX_LIST_LEVEL);
  const fmt0 = fmtOf(ctx);
  for (const child of Array.from(listEl.children)) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    const li = child as HTMLElement;
    const img = li.querySelector('img');
    if (img) {
      const p = await imageParagraph(img, ctx);
      if (p) out.push(p);
    } else {
      // li 直接内容（去嵌套列表）摊平成一段
      const host = document.createElement('div');
      li.childNodes.forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          const t = (n as HTMLElement).tagName.toLowerCase();
          if (t === 'ul' || t === 'ol') return;
        }
        host.appendChild(n.cloneNode(true));
      });
      const runs = await buildInline(host, fmt0, ctx);
      out.push(mkPara({ numbering: { reference, level: lv }, children: runs.length ? runs : undefined }, ctx));
    }
    // 嵌套列表：层级 +1（clamp 5）
    for (const nl of Array.from(li.children)) {
      const t = nl.tagName.toLowerCase();
      if (t === 'ul' || t === 'ol') {
        out.push(...(await listParagraphs(nl as HTMLElement, t === 'ol' ? 'mk-ol' : 'mk-ul', lv + 1, ctx)));
      }
    }
  }
  return out;
}

/* ---------------- 表格 ---------------- */

async function buildTable(tableEl: HTMLTableElement, ctx: Ctx): Promise<TTable> {
  const { Table, TableRow, TableCell, WidthType, VerticalAlignTable, BorderStyle, Paragraph } = ctx.kit;
  // 行收集：thead/tbody/tfoot 下的 tr + table 直接 tr（嵌套表格的行不越级收集）
  const rows: HTMLTableRowElement[] = [];
  const collect = (parent: HTMLElement) => {
    for (const c of Array.from(parent.children)) {
      const t = c.tagName.toLowerCase();
      if (t === 'tr') rows.push(c as HTMLTableRowElement);
      else if (t === 'thead' || t === 'tbody' || t === 'tfoot') collect(c as HTMLElement);
    }
  };
  collect(tableEl);

  const tableRows: TTableRow[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const tr = rows[rowIndex];
    const isHeaderRow =
      rowIndex === 0 &&
      (tr.querySelector('th') !== null || tr.parentElement?.tagName.toLowerCase() === 'thead');
    const cells: TTableCell[] = [];
    for (const cellEl of Array.from(tr.children)) {
      const tag = cellEl.tagName.toLowerCase();
      if (tag !== 'td' && tag !== 'th') continue;
      const td = cellEl as HTMLElement;
      // mh 方言属性名为大写 S 的 colSpan/rowSpan（DOM 解析后大小写不敏感，两种都读）
      const colSpan = Number(td.getAttribute('colspan') ?? td.getAttribute('colSpan') ?? '1') || 1;
      const rowSpan = Number(td.getAttribute('rowspan') ?? td.getAttribute('rowSpan') ?? '1') || 1;
      // 单元格内容同步走块遍历；空单元格方言 <td><br></td> → 空 cell（§2.1）
      const blocks = await buildBlocks(td.childNodes, ctx);
      const kids: TParagraph[] = blocks.length ? (blocks as TParagraph[]) : [new Paragraph({})];
      cells.push(
        new TableCell({
          children: kids,
          columnSpan: colSpan > 1 ? colSpan : undefined,
          rowSpan: rowSpan > 1 ? rowSpan : undefined,
          shading:
            isHeaderRow || tag === 'th'
              ? { fill: 'EEF2F5', type: 'clear', color: 'auto' }
              : undefined,
          verticalAlign: VerticalAlignTable.CENTER,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
        }),
      );
    }
    tableRows.push(new TableRow({ children: cells, tableHeader: isHeaderRow }));
  }

  return new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: '9AA4AD' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: '9AA4AD' },
      left: { style: BorderStyle.SINGLE, size: 4, color: '9AA4AD' },
      right: { style: BorderStyle.SINGLE, size: 4, color: '9AA4AD' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'C9D1D9' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'C9D1D9' },
    },
  });
}

/* ---------------- 图片 ---------------- */

function stylePx(el: HTMLElement, prop: 'width' | 'height'): number | undefined {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)px`, 'i').exec(el.getAttribute('style') ?? '');
  return m ? Number(m[1]) : undefined;
}

function fitTransform(w?: number, h?: number): { width: number; height: number } | undefined {
  if (!w || !h || w <= 0 || h <= 0) return undefined;
  if (w > MAX_IMG_W) {
    return { width: MAX_IMG_W, height: Math.max(1, Math.round((h * MAX_IMG_W) / w)) };
  }
  return { width: Math.round(w), height: Math.round(h) };
}

/** 图片 → ImageRun / 降级文本（行内与块级共用；抓取失败计 failedImages） */
async function imageRunFor(
  img: HTMLImageElement,
  ctx: Ctx,
): Promise<{ run: TImageRun } | { text: string } | null> {
  const { ImageRun } = ctx.kit;
  const src = (img.getAttribute('src') ?? '').trim();
  const alt = (img.getAttribute('alt') ?? '').trim();
  if (!src) return null;
  const fallbackText = alt ? `[图片：${alt}]` : '[图片]';

  const explicit = fitTransform(stylePx(img, 'width'), stylePx(img, 'height'));
  const asset: DocxAsset | null = await ctx.sem.run(() => loadDocxAsset(src, ctx.baseDir));
  if (!asset) {
    ctx.failedImages++;
    return { text: fallbackText };
  }

  if (asset.type === 'svg') {
    // SVG 位图化兜底（Word 旧版不渲染 SVG）；失败退化为 alt 文本
    const png = await ctx.sem.run(() => rasterizeSvgBytes(asset.data));
    if (!png) {
      ctx.failedImages++;
      return { text: fallbackText };
    }
    return {
      run: new ImageRun({
        data: png,
        transformation: explicit ?? fitTransform(asset.width, asset.height) ?? { width: 480, height: 270 },
        type: 'png',
        altText: alt ? { description: alt, name: alt } : undefined,
      }),
    };
  }

  const type = asset.type === 'jpg' || asset.type === 'gif' || asset.type === 'bmp' ? asset.type : 'png';
  return {
    run: new ImageRun({
      data: asset.data,
      transformation: explicit ?? fitTransform(asset.width, asset.height) ?? { width: 480, height: 270 },
      type,
      altText: alt ? { description: alt, name: alt } : undefined,
    }),
  };
}

async function imageParagraph(img: HTMLImageElement, ctx: Ctx): Promise<TParagraph | null> {
  const r = await imageRunFor(img, ctx);
  if (!r) return null;
  if ('text' in r) {
    return new ctx.kit.Paragraph({ children: [textRun(r.text, fmtOf(ctx), ctx)] });
  }
  return new ctx.kit.Paragraph({
    alignment: ctx.kit.AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
    children: [r.run],
  });
}

/* ---------------- Mermaid / KaTeX 块 ---------------- */

/** 1×1 透明 PNG：docx 包的 SVG ImageRun 必填 fallback（旧版 Word 不支持 SVG 时显示空框） */
const TRANSPARENT_PNG = new Uint8Array(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
    .split('')
    .map((c) => c.charCodeAt(0)),
);

/** Mermaid / KaTeX 节点 → ImageRun / 降级源码文本（行内与块级共用） */
async function chartRunFor(
  el: HTMLElement,
  ctx: Ctx,
): Promise<{ run: TImageRun } | { text: string } | null> {
  const { ImageRun } = ctx.kit;
  const result = await imagefyNode(el);
  if (!result) return null;

  // D9：序列化失败 → 源码降级（katex 加 $…$；mermaid 保留原源码）
  if (!result.png && !result.svg && result.source) {
    ctx.degradedFormulas++;
    return { text: result.kind === 'mermaid' ? result.source : katexSourceText(result.source) };
  }

  const transform = fitTransform(result.width, result.height) ?? { width: 480, height: 270 };
  if (result.svg && result.png) {
    // Mermaid：SVG 直嵌 + 同源 PNG fallback（R4 双嵌）
    return {
      run: new ImageRun({
        type: 'svg',
        data: result.svg,
        fallback: { type: 'png', data: result.png },
        transformation: transform,
      }),
    };
  }
  if (result.svg) {
    // 仅 SVG（无 PNG）：mermaid svg 含 <foreignObject> 时 Chromium 画布污染，
    // PNG 光栅化必然失败（docxImagefy.ts 实测注释）。仍 SVG 直嵌——Word 2016+/WPS
    // 支持 SVG；fallback 用 1×1 透明 PNG 满足 docx 包必填约束（旧版 Word 显示空框）
    return {
      run: new ImageRun({
        type: 'svg',
        data: result.svg,
        fallback: { type: 'png', data: TRANSPARENT_PNG },
        transformation: transform,
        altText: { description: '图表', name: 'chart' },
      }),
    };
  }
  if (result.png) {
    return {
      run: new ImageRun({
        data: result.png,
        transformation: transform,
        type: 'png',
        altText: result.source
          ? { description: katexSourceText(result.source), name: 'formula' }
          : undefined,
      }),
    };
  }
  return null;
}

/** 块级 Mermaid / KaTeX → 居中图片段 */
async function chartParagraph(el: HTMLElement, ctx: Ctx): Promise<TParagraph | null> {
  const r = await chartRunFor(el, ctx);
  if (!r) return null;
  if ('text' in r) {
    return new ctx.kit.Paragraph({ children: [textRun(r.text, fmtOf(ctx), ctx)] });
  }
  return new ctx.kit.Paragraph({
    alignment: ctx.kit.AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
    children: [r.run],
  });
}

/* ---------------- 文档级构造 ---------------- */

async function buildDocument(children: (TParagraph | TTable)[], ctx: Ctx): Promise<Blob> {
  const { HeadingLevel, LevelFormat, AlignmentType, convertMillimetersToTwip, Document, Packer } =
    await import('docx');

  const fontSize = Math.min(24, Math.max(9, ctx.opts.fontSize || 11));
  const baseRun = {
    font: { ascii: ctx.opts.fontEn, hAnsi: ctx.opts.fontEn, eastAsia: ctx.opts.fontZh, cs: ctx.opts.fontEn },
    size: fontSize * 2, // 半磅
    color: '24292F',
  };
  const headingSpec = [
    { level: HeadingLevel.HEADING_1, size: fontSize + 7 },
    { level: HeadingLevel.HEADING_2, size: fontSize + 5 },
    { level: HeadingLevel.HEADING_3, size: fontSize + 3 },
    { level: HeadingLevel.HEADING_4, size: fontSize + 2 },
    { level: HeadingLevel.HEADING_5, size: fontSize + 1 },
    { level: HeadingLevel.HEADING_6, size: fontSize },
  ];
  const headingDefaults = Object.fromEntries(
    headingSpec.map((h, i) => [
      `heading${i + 1}`,
      {
        paragraph: { spacing: { before: 240, after: 120 }, keepNext: true },
        run: { ...baseRun, bold: true, size: h.size * 2, color: '1F2937' },
      },
    ]),
  );

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: baseRun,
          paragraph: { spacing: { after: 120, line: 312 } }, // 段后 6pt / 行距 15.6pt
        },
        ...headingDefaults,
      },
    },
    numbering: {
      config: [
        {
          reference: 'mk-ul',
          levels: Array.from({ length: 6 }, (_, l) => ({
            level: l,
            format: LevelFormat.BULLET,
            text: l === 0 ? '•' : l === 1 ? '◦' : '▪',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 + l * 360, hanging: 360 } } },
          })),
        },
        {
          reference: 'mk-ol',
          levels: Array.from({ length: 6 }, (_, l) => ({
            level: l,
            format: LevelFormat.DECIMAL,
            text: `%${l + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 + l * 360, hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4
            margin: {
              top: convertMillimetersToTwip(25.4),
              bottom: convertMillimetersToTwip(25.4),
              left: convertMillimetersToTwip(31.8),
              right: convertMillimetersToTwip(31.8),
            },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}

/* ---------------- 对外入口 ---------------- */

export async function htmlToDocx(html: string, opts: WordStyleOpts): Promise<HtmlToDocxResult> {
  // docx 包懒加载（D4）；类引用注入 ctx.kit 供同步遍历使用
  const mod = await import('docx');
  const ctx: Ctx = {
    kit: {
      TextRun: mod.TextRun,
      ExternalHyperlink: mod.ExternalHyperlink,
      ImageRun: mod.ImageRun,
      Paragraph: mod.Paragraph,
      Table: mod.Table,
      TableRow: mod.TableRow,
      TableCell: mod.TableCell,
      AlignmentType: mod.AlignmentType,
      BorderStyle: mod.BorderStyle,
      HeadingLevel: mod.HeadingLevel,
      WidthType: mod.WidthType,
      VerticalAlignTable: mod.VerticalAlignTable,
    },
    opts,
    quote: false,
    degradedFormulas: 0,
    failedImages: 0,
    sem: new Semaphore(6),
  };

  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 离屏暂存：DOMParser 产出的是 detached 树，getBoundingClientRect 恒 0——
  // KaTeX 公式图与 Mermaid 尺寸量测需要真实布局。挂一个视口外、visibility:hidden
  // （保留布局）的容器，转换完事即摘除；宽度按内容版式中档约束。
  // ★先取 body 引用再移入 staging：body 被移出文档后 doc.body 会变 null（DOM 规范）
  const body = doc.body;
  const staging = document.createElement('div');
  staging.style.cssText = 'position:fixed;left:-99999px;top:0;width:1020px;visibility:hidden;pointer-events:none;';
  staging.appendChild(body);
  document.body.appendChild(staging);
  try {
    const children = await buildBlocks(body.childNodes, ctx);
    const blob = await buildDocument(children, ctx);
    return { blob, degradedFormulas: ctx.degradedFormulas, failedImages: ctx.failedImages };
  } finally {
    staging.remove();
  }
}
