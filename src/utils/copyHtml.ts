/**
 * ★ 富文本复制转换层：「复制为公众号 / 复制为知乎」（纯 DOM，不依赖 Vue、不 import 内核）。
 *
 * 输入 = 引擎给的渲染快照（导出宿主 #export-pdf-preview 的 innerHTML，与 Word 导出同一条
 * 渲染链：KaTeX 已渲染、mermaid 或已渲染成 svg 或仍是源码、图片是 asset://）。
 * 输出 = 目标平台编辑器真吃得下的 HTML + 纯文本兜底 + 降级计数（供提示语说明「少了什么」）。
 *
 * 为什么不在这里重新渲染 markdown：渲染口径只有内核一份（html:true + DOMPurify、KaTeX 补丁、
 * mhchem 注册、相对路径 → asset://）。二次渲染必然与预览分叉，且 mermaid/hljs 的构建参数
 * 也不在本层手里。
 *
 * 两个平台必须各出一份，不是只换样式：
 * - 公众号（mp.weixin.qq.com）的编辑器会**重建** h1–h6 / pre / ul / ol / li 这些块：
 *   语义保不住，挂在它们身上的内联样式也一起丢（只剩 p/section/span 上的样式稳）。
 *   所以这些块一律降级：标题 → `<p>`、代码块 → `<section>`（行间 `<br>`、空格 `&nbsp;`，
 *   微信没有代码块类型，`<pre>` 会被拍成普通段落，换行缩进全没）、列表 → 带 `•`/`1.` 前缀的段落。
 *   class / 外部 CSS 也一律丢；内联 <svg>、<input> 会被剥掉；asset:// 本地图它取不到。
 *   故公式 → TeX 代码、图表 → 源码块、本地图 → 占位。
 * - 知乎的粘贴解析认的是自家那套标记：代码块要 `<pre lang="x">` 且**代码文本是 pre 的直接
 *   内容**（语言只写在 code.class 里、或再套一层带样式的 `<code>`，都会落成普通正文）、
 *   正文只有一个可见的标题级别、表格要 data-draft-* + 首行表头。内联样式能带过去就带
 *   （平台保留时字号层级与底色还在），带不住的由这些块标记兜底，所以两样都给；
 *   配色刻意**不写文字色**（只用半透明灰做底、描边），知乎暗色下不会糊。
 *   公式同样先给 TeX 源码，图表只能给源码。
 *
 * 降级口径是刻意的：KaTeX 的输出是 MathML + 视觉层**两份节点**，离开 CSS 会重复显示两遍
 * 公式（MathML 那份本来是视觉隐藏的）——所以公式必须整块替换，不能只删 class。
 */
import { katexTexOf } from './katexTex';

/** 复制目标平台：公众号（标签降级 + 纯内联样式）/ 知乎（内联样式 + 知乎自家块标记） */
export type CopyTarget = 'wechat' | 'zhihu';

export interface CopyHtmlResult {
  /** 写进剪贴板 text/html 的那一格 */
  html: string;
  /** text/plain 兜底：平台拒收富文本时至少不是一坨连排的字 */
  text: string;
  /** 本地图片（asset:// / file:// / 相对路径）没进剪贴板的张数 */
  droppedImages: number;
  /** 图表（mermaid）以源码块保留的数量 */
  chartSources: number;
  /** 公式以 TeX 源码保留的处数 */
  mathSources: number;
}

/** 公众号根容器：字号/行距/配色定在这里（微信只认内联样式） */
const WECHAT_ROOT = [
  'font-size:16px',
  'line-height:1.75',
  'letter-spacing:.4px',
  'color:#3f3f3f',
  'font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif',
  'word-break:break-word',
].join(';');

/** 逐标签内联样式。偏「技术文章」口径：标题带强调色，代码块与表格走浅灰底 */
const WECHAT_STYLE: Record<string, string> = {
  p: 'margin:0 0 16px;font-size:16px;line-height:1.75;color:#3f3f3f;',
  h1: 'margin:32px 0 16px;padding-bottom:8px;border-bottom:1px solid #ececec;font-size:22px;line-height:1.4;font-weight:700;color:#1a1a1a;',
  h2: 'margin:28px 0 14px;padding-left:10px;border-left:4px solid #2f7fd0;font-size:19px;line-height:1.45;font-weight:700;color:#1a1a1a;',
  h3: 'margin:24px 0 12px;font-size:17px;line-height:1.5;font-weight:700;color:#2f7fd0;',
  h4: 'margin:20px 0 10px;font-size:16px;line-height:1.6;font-weight:700;color:#1a1a1a;',
  h5: 'margin:18px 0 8px;font-size:16px;line-height:1.6;font-weight:700;color:#3f3f3f;',
  h6: 'margin:16px 0 8px;font-size:15px;line-height:1.6;font-weight:700;color:#5c6675;',
  strong: 'font-weight:700;color:#1a1a1a;',
  em: 'font-style:italic;',
  del: 'text-decoration:line-through;color:#8a94a3;',
  s: 'text-decoration:line-through;color:#8a94a3;',
  a: 'color:#2f7fd0;text-decoration:none;border-bottom:1px solid rgba(47,127,208,.35);',
  blockquote: 'margin:16px 0;padding:12px 16px;background:#f7f8fa;border-left:3px solid #cfd8e3;font-size:15px;line-height:1.75;color:#5c6675;text-indent:0;',
  ul: 'margin:0 0 16px;padding-left:24px;list-style-type:disc;',
  ol: 'margin:0 0 16px;padding-left:24px;list-style-type:decimal;',
  li: 'margin:6px 0;font-size:16px;line-height:1.75;color:#3f3f3f;',
  pre: 'margin:0 0 16px;padding:14px 16px;background:#f6f8fa;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.6;',
  table: 'width:100%;margin:0 0 16px;border-collapse:collapse;font-size:15px;',
  th: 'padding:8px 10px;border:1px solid #dfe3e8;background:#f7f8fa;font-weight:700;text-align:left;',
  td: 'padding:8px 10px;border:1px solid #dfe3e8;',
  img: 'display:block;max-width:100%;height:auto;margin:16px auto;border-radius:4px;',
  figure: 'margin:0;',
  hr: 'margin:28px 0;border:none;border-top:1px solid #e6e8eb;',
};

const MONO = 'font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;';
/** 行内代码：浅底 + 主色，与正文区分 */
const WECHAT_CODE_INLINE = `${MONO}padding:2px 5px;background:#f2f3f5;border-radius:3px;font-size:13px;color:#1f2329;`;
/** 代码块里的 code：底色交给外层 pre，自身透明（否则会出现双层灰底） */
const WECHAT_CODE_BLOCK = `${MONO}padding:0;background:transparent;font-size:13px;line-height:1.6;color:#24292f;white-space:pre;`;
/** 公众号的「代码块」只能自拼：微信编辑器没有代码块类型，<pre> 粘进去会被拍成普通段落
 *  （换行、缩进一起没）。业界通行做法（mdnice 同口径）：外壳用 section，行间用 <br>、
 *  空格换 &nbsp;——不依赖 white-space 也能保住版式。 */
const WECHAT_CODE_SHELL = 'margin:0 0 16px;padding:14px 16px;background:#f6f8fa;border-radius:6px;overflow-x:auto;word-break:break-all;text-indent:0;';
const WECHAT_CODE_TEXT = `${MONO}font-size:13px;line-height:1.6;color:#24292f;white-space:pre-wrap;`;
/** 本地图占位：不抢视觉，但要让人一眼看出这里原本有张图 */
const PLACEHOLDER_STYLE = 'display:block;margin:0 0 16px;padding:6px 10px;background:#f7f8fa;border:1px dashed #d5dbe3;border-radius:4px;font-size:13px;color:#8a94a3;';
/** 独占一行的公式（公众号里就是 TeX 代码） */
const MATH_BLOCK_STYLE = 'margin:0 0 16px;text-align:center;';

/**
 * 知乎用的内联样式：刻意**不写 color**——知乎正文颜色由编辑器给，硬写深色在暗色模式里会糊；
 * 强调只靠字号/字重/边框，底色与描边一律用半透明灰（亮暗两套底色都能透出正确观感）。
 */
const ZHIHU_STYLE: Record<string, string> = {
  p: 'margin:0 0 16px;font-size:16px;line-height:1.75;',
  h1: 'margin:32px 0 16px;font-size:24px;line-height:1.4;font-weight:700;',
  h2: 'margin:28px 0 14px;font-size:20px;line-height:1.45;font-weight:700;',
  h3: 'margin:24px 0 12px;font-size:17px;line-height:1.5;font-weight:700;',
  h4: 'margin:20px 0 10px;font-size:16px;line-height:1.6;font-weight:700;',
  h5: 'margin:18px 0 8px;font-size:15px;line-height:1.6;font-weight:700;',
  h6: 'margin:16px 0 8px;font-size:15px;line-height:1.6;font-weight:600;',
  strong: 'font-weight:700;',
  em: 'font-style:italic;',
  del: 'text-decoration:line-through;opacity:.65;',
  s: 'text-decoration:line-through;opacity:.65;',
  a: 'text-decoration:underline;',
  blockquote: 'margin:16px 0;padding:8px 16px;border-left:3px solid rgba(127,127,127,.45);font-size:15px;line-height:1.75;',
  ul: 'margin:0 0 16px;padding-left:24px;list-style-type:disc;',
  ol: 'margin:0 0 16px;padding-left:24px;list-style-type:decimal;',
  li: 'margin:6px 0;font-size:16px;line-height:1.75;',
  table: 'width:100%;margin:0 0 16px;border-collapse:collapse;font-size:15px;',
  th: 'padding:8px 10px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.06);font-weight:700;text-align:left;',
  td: 'padding:8px 10px;border:1px solid rgba(127,127,127,.3);',
  img: 'display:block;max-width:100%;height:auto;margin:16px auto;',
  figure: 'margin:0;',
  hr: 'margin:28px 0;border:none;border-top:1px solid rgba(127,127,127,.3);',
};

const ZHIHU_CODE_INLINE = `${MONO}padding:2px 5px;background:rgba(127,127,127,.12);border-radius:3px;font-size:13px;`;
const ZHIHU_CODE_BLOCK = `${MONO}padding:0;background:transparent;font-size:13px;line-height:1.6;white-space:pre;`;
const ZHIHU_QUOTE_P = 'margin:0;font-size:15px;line-height:1.75;';
const ZHIHU_LIST_P = 'margin:0;font-size:16px;line-height:1.75;';

/** 一套内联样式表 = 逐标签样式 + 行内/块级代码 + 嵌套段落的收边 */
interface StyleSheet {
  tag: Record<string, string>;
  codeInline: string;
  codeBlock: string;
  quoteP: string;
  listP: string;
}

const WECHAT_SHEET: StyleSheet = {
  tag: WECHAT_STYLE,
  codeInline: WECHAT_CODE_INLINE,
  codeBlock: WECHAT_CODE_BLOCK,
  quoteP: 'margin:0;font-size:15px;line-height:1.75;color:#5c6675;',
  listP: 'margin:0;font-size:16px;line-height:1.75;color:#3f3f3f;',
};

const ZHIHU_SHEET: StyleSheet = {
  tag: ZHIHU_STYLE,
  codeInline: ZHIHU_CODE_INLINE,
  codeBlock: ZHIHU_CODE_BLOCK,
  quoteP: ZHIHU_QUOTE_P,
  listP: ZHIHU_LIST_P,
};

const DROP_TAGS = 'script,style,link,meta,base,iframe,object,embed,form,button,select,textarea';
const NOISE_CLASS = /(mermaid-(?:action|copy|zoom)|copy-button|footnote-backref)/i;

/** 块级标签：纯文本序列化时前后补空行 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'MAIN', 'NAV',
  'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'UL',
]);

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** 块级边界：这些元素前后的空白文本不影响渲染，收掉不会改变语义 */
const BLOCKISH = new Set([...BLOCK_TAGS, 'HR']);

/**
 * 收掉块内的源码缩进空白。列表项带代码块时，Markdown 的缩进会在 li 里留下
 * `"\n带代码的项\n\n        \n          "` 这种文本节点：原样搬进段落，微信里
 * 「• 项」与代码块之间就多出空格。折叠成单空格，贴着块边界或紧邻空白的收掉。
 * `.mk-code` 里的文本例外——那里空格是 &nbsp;、换行是 <br>，不能碰。
 */
function trimInlineWhitespace(el: Element): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n as Text).parentElement?.closest('.mk-code')) nodes.push(n as Text);
  }
  for (const t of nodes) {
    const prev = t.previousSibling;
    const next = t.nextSibling;
    let v = (t.nodeValue ?? '').replace(/[ \t\n\f\r]+/g, ' ');
    const blockPrev = !prev || (prev.nodeType === 1 && BLOCKISH.has((prev as Element).tagName));
    const spacePrev = prev?.nodeType === 3 && /\s$/.test(prev.nodeValue ?? '');
    if (blockPrev || spacePrev) v = v.replace(/^ /, '');
    const blockNext = !next || (next.nodeType === 1 && BLOCKISH.has((next as Element).tagName));
    const spaceNext = next?.nodeType === 3 && /^\s/.test(next.nodeValue ?? '');
    if (blockNext || spaceNext) v = v.replace(/ $/, '');
    if (v === '') t.remove();
    else t.nodeValue = v;
  }
}

/**
 * 去掉内核预览的外壳层：MdPreview 的结构是
 * `#export-pdf-preview > .md-editor-preview-wrapper > article.md-editor-preview.default-theme > 正文`。
 * class 稍后会被整体剥掉，所以必须**在这一步按 class 拆壳**——否则公众号里正文被三层空 div
 * 套着，平台侧对空 div 的间距处理各不相同，容易多出莫名其妙的留白。
 */
function unwrapPreviewShell(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('.md-editor-preview-wrapper, .md-editor-preview, article'))) {
    unwrap(el);
  }
}

/** 清掉交互与实现细节：脚本、按钮、图标 svg、mermaid 操作条、代码块复制按钮 */
function stripNoise(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll(DROP_TAGS))) el.remove();
  for (const el of Array.from(root.querySelectorAll('svg'))) el.remove();
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    if (NOISE_CLASS.test(el.getAttribute('class') ?? '')) el.remove();
  }
}

/**
 * 摘掉什么都不剩的壳：Vue 的注释占位（`<!---->`）、空段落 / 空 div / 空 span。
 * 空段落最阴的一个来源是往返解析——内核把 mermaid 的操作条 div **appendChild 进 `<p>`**里
 * （DOM 里合法），序列化成字符串再解析时 `</p>` 落在 svg 命名空间里被按「错误闭合」处理，
 * 白送一颗游离空 `<p>`。留着不会报错，只会在微信里多出一道空行。
 */
function pruneEmpty(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) (n as ChildNode).remove();
  for (const el of Array.from(root.querySelectorAll('p, div, span, li'))) {
    if ((el.textContent ?? '').trim() === '' && el.children.length === 0) el.remove();
  }
  // 拆掉代码块外壳后会在根层留下纯空白文本节点：平台可能把它当成一个空段落
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3 && !(node.nodeValue ?? '').trim()) node.remove();
  }
}

/** 图表元素 = 类名含 mermaid 的容器本体（排除 -action/-copy/-zoom 那几颗操作按钮） */
function isChartEl(el: Element): boolean {
  const cls = el.getAttribute('class') ?? '';
  return cls.includes('mermaid') && !NOISE_CLASS.test(cls);
}

/**
 * mermaid → 代码块。两个平台都会剥掉内联 svg，留着只会变成空白；源码还有救。
 * 源码位置：内核渲染完成后把源文本挂在 data-content 上（index4.mjs 的 fence 规则）；
 * 内核 LRU 命中时不做节点替换，元素里就还是源文本（此时 textContent 可用）。
 * ★ 已渲染的元素不能读 textContent——那是 svg 里的文字标签，拼起来是垃圾。
 * ★ 只认最外层图表元素：mermaid 的 svg 内部也有带 mermaid 字样的 class，逐层处理会把
 *   图的内部标签当第二张图计数（外层已整替，内层是游离节点，输出没错但计数虚高）。
 */
function chartsToSource(root: HTMLElement, stat: { chartSources: number }): void {
  for (const el of Array.from(root.querySelectorAll('[class*="mermaid"]'))) {
    if (!isChartEl(el)) continue;
    if (el.closest('svg')) continue; // svg 内部节点：不是图表本体
    if (el.parentElement?.closest('[class*="mermaid"]')) continue; // 图表内部：外层会一起替掉
    const hasSvg = el.querySelector('svg') !== null;
    const src = (el.getAttribute('data-content') ?? (hasSvg ? '' : el.textContent) ?? '').trim();
    const pre = document.createElement('pre');
    if (src) {
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = src;
      pre.appendChild(code);
      stat.chartSources += 1;
    } else {
      pre.textContent = '〔图表〕';
    }
    el.replaceWith(pre);
  }
}

/**
 * 公式整块替换的外层容器。
 * 行内（display=false）只穿 SPAN：停在 `.md-editor-katex-inline` 这层，既不留下空壳 span，
 * 也不会把同段正文一起吃掉；块级（display=true）再往上穿 P（真身是 `<p class="…-katex-block">`，
 * 中间可能还夹着 span），只换内层会留一个空段落，微信里就是一道多余的空行。
 * 判据是 textContent 相等——夹带正文会让等式不成立，此时停在上一层。
 */
function mathHolder(el: Element, display: boolean): Element {
  let cur = el;
  const text = (el.textContent ?? '').trim();
  for (;;) {
    const parent = cur.parentElement;
    if (!parent) break;
    if (!display && parent.tagName !== 'SPAN') break;
    if (parent.tagName !== 'P' && parent.tagName !== 'SPAN') break;
    if ((parent.textContent ?? '').trim() !== text) break;
    cur = parent;
  }
  return cur;
}

/**
 * 公式 → TeX 源码：公众号给行内代码（微信里公式只能贴图，源码是唯一还能读的形式），
 * 知乎给 $…$ / $$…$$（平台认这套标记，粘贴后还能继续编辑）。
 */
function mathToSource(root: HTMLElement, target: CopyTarget, stat: { mathSources: number }): void {
  for (const katex of Array.from(root.querySelectorAll('.katex'))) {
    // 块级公式的最外层是 .katex-display，行内就是 .katex 自己
    const displayEl = katex.closest('.katex-display') ?? katex;
    const display = displayEl.classList.contains('katex-display');
    const holder = mathHolder(displayEl, display);
    const tex = katexTexOf(displayEl) || katexTexOf(katex);
    if (!tex) {
      // 连源码都拿不到就整块抹掉：留着 MathML + 视觉层两份节点，粘出去会重复两遍。
      // 不计入 mathSources——提示语说的是「以 TeX 源码保留」，丢了的东西不能算保留
      holder.remove();
      continue;
    }
    stat.mathSources += 1;
    if (target === 'wechat') {
      const code = document.createElement('code');
      code.textContent = tex;
      if (display) {
        const p = document.createElement('p');
        p.className = 'mk-math-block';
        p.appendChild(code);
        holder.replaceWith(p);
      } else {
        holder.replaceWith(code);
      }
    } else {
      // 块级公式补一层 <p>：裸文本节点粘进知乎会变成游离行，段落间距不可控
      if (display) {
        const p = document.createElement('p');
        p.textContent = `$$${tex}$$`;
        holder.replaceWith(p);
      } else {
        holder.replaceWith(document.createTextNode(`$${tex}$`));
      }
    }
  }
}

/**
 * 拆掉代码块外壳（内核 v7 实测形态）：
 * `<details class="md-editor-code"><summary class="md-editor-code-head">`
 * 里装的是 mac 红绿灯（`-code-flag` 三颗圆点）、语言名（`-code-lang`）、「复制代码」按钮和折叠箭头。
 * 两个平台都会折叠或整颗剥掉 details，那一排又是纯界面装饰——粘出去要么多出「js」一行裸字，
 * 要么代码块干脆缩在折叠头后面。故摘掉头部、拆掉容器，只留 `<pre>`。
 * 语言信息不丢：`code` 上带着 `language-*`，两个平台都能据此再高亮。
 */
function flattenCodeShell(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll(
    'summary, .md-editor-code-head, .md-editor-code-flag, .md-editor-code-action, .md-editor-collapse-tips',
  ))) {
    el.remove();
  }
  for (const el of Array.from(root.querySelectorAll('details, .md-editor-code'))) unwrap(el);
}

/**
 * 代码块拍平成纯文本。hljs 的 token 是一条条带 class 的 <span>，没有内联色——
 * 两个平台都会把 class 丢掉，留着只是噪音，不如直接给一段干净的 code。
 * 语言标记保留（知乎 / 公众号都能据此再高亮，至少不丢信息）。
 */
function codeBlocksToPlain(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const code = pre.querySelector('code') ?? pre;
    const lang = /language-([\w+#.-]+)/.exec(code.getAttribute('class') ?? '')?.[1] ?? '';
    const flat = document.createElement('code');
    if (lang) flat.className = `language-${lang}`;
    flat.textContent = (code.textContent ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    pre.replaceChildren(flat);
  }
}

/** 任务列表的 <input type=checkbox> → ☑ / ☐（微信会整颗剥掉 input，只剩一行没有勾的空条目）。
 *  空格按「后面已有空白就不补」处理：markdown-it 在 input 与正文之间可能已经留了一个空格，
 *  无脑补一个会变成两个（视觉上是一个明显的洞） */
function tasksToGlyph(root: HTMLElement): void {
  for (const box of Array.from(root.querySelectorAll('input[type="checkbox"]'))) {
    const glyph = box.hasAttribute('checked') ? '☑' : '☐';
    const next = box.nextSibling;
    const spaced = next?.nodeType === 3 && /^\s/.test(next.nodeValue ?? '');
    box.replaceWith(document.createTextNode(spaced ? glyph : `${glyph} `));
  }
}

/**
 * 图片：http(s) 平台自己能抓（微信粘贴时会上传到自家 CDN），data: 自带内容也留着；
 * 其余（asset:// / file:// / 相对路径）平台取不到本机文件，换成占位并计数。
 */
function imagesToPlaceholder(root: HTMLElement, stat: { droppedImages: number }): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = (img.getAttribute('src') ?? '').trim();
    if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) continue;
    const alt = (img.getAttribute('alt') ?? '').trim();
    const span = document.createElement('span');
    span.className = 'mk-img-placeholder';
    span.textContent = alt ? `〔图片：${alt}〕` : '〔图片〕';
    // 内核给图片套了 figure（知乎的图片块形态）：只摘 img 会留下一个空 figure，
    // 在平台上就是一道无辜的留白。figure 里只有这张图（没有图注）时整颗换掉
    const figure = img.parentElement;
    const bareFigure = figure?.tagName === 'FIGURE'
      && figure.querySelectorAll('img').length === 1
      && !figure.querySelector('figcaption');
    if (bareFigure && figure) figure.replaceWith(span);
    else img.replaceWith(span);
    stat.droppedImages += 1;
  }
}

/**
 * 属性归一：只留对平台有意义的。class 只保留代码块语言标记与两个自制哨兵
 * （`mk-img-placeholder` / `mk-math-block` 要在下一步 applyStyles 里认出来套样式），
 * data-*（含 data-line）、id、dir 一律清掉——公众号会把它们原样带进草稿的脏属性。
 * 唯一例外是表格单元格的 text-align：那是内容语义（居中的数字列），不是装饰。
 */
function stripAttributes(root: HTMLElement): void {
  const keep = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start']);
  const KEEP_CLASS = /^(?:language-[\w+#.-]+|mk-img-placeholder|mk-math-block)$/;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === 'class') {
        if (!KEEP_CLASS.test(attr.value)) el.removeAttribute('class');
        continue;
      }
      if (name === 'style') {
        // 表格对齐是内容语义（居中的数字列），不是装饰：只留这一条给 applyStyles 合并
        const align = /text-align\s*:\s*(left|center|right)/i.exec(attr.value)?.[1]?.toLowerCase();
        if (align && (el.tagName === 'TH' || el.tagName === 'TD')) el.setAttribute('style', `text-align:${align};`);
        else el.removeAttribute('style');
        continue;
      }
      if (!keep.has(name)) el.removeAttribute(name);
    }
  }
}

/** 按标签套内联样式（两个平台都要：公众号完全没有外链 CSS，知乎的内联样式能带进正文） */
function applyStyles(root: HTMLElement, sheet: StyleSheet): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'code') {
      el.setAttribute('style', el.parentElement?.tagName === 'PRE' ? sheet.codeBlock : sheet.codeInline);
      continue;
    }
    if (el.classList.contains('mk-img-placeholder')) {
      el.setAttribute('style', PLACEHOLDER_STYLE);
      continue;
    }
    if (el.classList.contains('mk-math-block')) {
      el.setAttribute('style', MATH_BLOCK_STYLE);
      continue;
    }
    const style = sheet.tag[tag];
    if (style) {
      // 表格单元格的对齐在 stripAttributes 里留了一条：换掉默认的左对齐，别叠两条
      const align = /text-align:(left|center|right)/.exec(el.getAttribute('style') ?? '')?.[1];
      el.setAttribute('style', align ? `${style.replace(/text-align:(?:left|center|right);?/g, '')}text-align:${align};` : style);
    }
  }
  // 引用里的段落与外层 blockquote 同字号、不要下边距（否则引用块底部空一大截）
  for (const p of Array.from(root.querySelectorAll<HTMLElement>('blockquote p'))) {
    p.setAttribute('style', sheet.quoteP);
  }
  // 松散列表的 li 里也有 p：同上，收掉边距；引用块里的话归 quoteP 管，别被列表样式盖掉颜色
  for (const p of Array.from(root.querySelectorAll<HTMLElement>('li p'))) {
    if (p.closest('blockquote')) continue;
    p.setAttribute('style', sheet.listP);
  }
}

/**
 * 知乎的代码块只认 `<pre lang="x">` **直接装代码文本**这一种形态：
 * - 语言只写在 `code.class="language-x"` 上、pre 没有 lang ⇒ 整块落成普通正文（连换行都塌）；
 * - pre 里再套一个带内联样式的 `<code>` 也会让它认不出来——实测「成了普通正文」就是这个原因。
 * 所以这里把 code 壳整个拿掉，只留 pre + 文本，样式也一律不写：认出来之后底色/高亮由知乎
 * 自己那套代码块负责（与思源笔记贴知乎用的格式一致）。
 * 语言未知按 `text` 标——知乎用它走「纯文本代码块」，比不标更稳定。
 */
function markZhihuCode(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const code = pre.querySelector('code');
    const raw = /language-([\w+#.-]+)/.exec(code?.getAttribute('class') ?? '')?.[1] ?? 'text';
    pre.setAttribute('lang', zhihuLang(raw));
    pre.textContent = code?.textContent ?? pre.textContent ?? '';
  }
}

/** 常见围栏语言名 → 知乎（highlight.js）认的规范名，缩写不映射语言会对不上高亮 */
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c#': 'csharp',
  cs: 'csharp',
  'c++': 'cpp',
  h: 'cpp',
  golang: 'go',
  kt: 'kotlin',
  rs: 'rust',
  txt: 'text',
  plain: 'text',
  plaintext: 'text',
};

function zhihuLang(lang: string): string {
  return LANG_ALIAS[lang.toLowerCase()] ?? lang;
}

/**
 * 知乎的列表项里塞不下代码块：`<li>` 里的 `<pre lang>` 会被拍成**行内文字**，
 * 几行代码黏成一行跟着「• 示例：」后面（实测截图）。所以把列表里的 pre 提到块级：
 * 按原顺序把外层列表切成几段，代码块落在它那一项的位置上——读起来仍是「列表 → 代码块 → 列表」，
 * 而不是把整个列表的代码块全堆到末尾。
 * 被搬空的 li（整项只有一段代码）连同空列表一起清掉，免得留一颗空圆点；
 * 列表项里那些源码缩进留下的纯空白文本节点也一并收掉，否则知乎会多出空行。
 */
function hoistCodeOutOfLists(root: HTMLElement): void {
  for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
    if (list.parentElement?.closest('ul, ol')) continue; // 嵌套列表随外层一起切
    const items = Array.from(list.children).filter((c) => c.tagName === 'LI') as HTMLElement[];
    if (!items.some((li) => li.querySelector('pre'))) continue;
    const base = Number(list.getAttribute('start') ?? 1) || 1;
    const out: Element[] = [];
    let group: Element[] = [];
    let groupStart = 0;
    const flush = (): void => {
      if (!group.length) return;
      const frag = list.cloneNode(false) as HTMLElement;
      if (frag.tagName === 'OL') frag.setAttribute('start', String(base + groupStart));
      for (const li of group) frag.appendChild(li);
      out.push(frag);
      group = [];
    };
    items.forEach((li, idx) => {
      const pres = Array.from(li.querySelectorAll('pre'));
      if (!pres.length) {
        if (!group.length) groupStart = idx;
        group.push(li);
        return;
      }
      for (const pre of pres) pre.remove();
      stripEdgeWhitespace(li);
      flush(); // 代码块之前的列表项收成一段
      if ((li.textContent ?? '').trim() || li.querySelector('img, table')) {
        // 该项还有文字（如「示例：」）：自己单独留一小段列表，代码块跟在这一项后面
        groupStart = idx;
        group = [li];
        flush();
      }
      out.push(...pres);
    });
    flush();
    list.replaceWith(...out);
  }
  for (const li of Array.from(root.querySelectorAll('li'))) {
    if (!(li.textContent ?? '').trim() && !li.querySelector('img, table')) li.remove();
  }
  for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
    if (!list.querySelector('li')) list.remove();
  }
}

/** 去掉贴着块边界（或首尾）的纯空白文本节点；li 内两段行内文本之间的空格要留着 */
function stripEdgeWhitespace(el: Element): void {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== 3 || (node.nodeValue ?? '').trim()) continue;
    const near = (n: Node | null): boolean => !n || (n.nodeType === 1 && BLOCKISH.has((n as Element).tagName));
    if (near(node.previousSibling) || near(node.nextSibling)) node.remove();
  }
}

/**
 * 知乎的表格块只认自家结构：`<table data-draft-node="block" data-draft-type="table"
 * data-size="normal" data-row-style="normal"><tbody>`，且表头行必须在 tbody 首部（用 <th>）。
 * 内核给的是标准 thead/tbody，直接粘进去表头会退化成普通单元格（wechatsync 的知乎适配器
 * 就是这么转的）。figure 包表格也拆掉——知乎的 figure 是图片块的形态。
 */
function tablesForZhihu(root: HTMLElement): void {
  for (const figure of Array.from(root.querySelectorAll('figure'))) {
    if (figure.querySelector('table')) unwrap(figure);
  }
  for (const table of Array.from(root.querySelectorAll('table'))) {
    let body = table.querySelector(':scope > tbody');
    if (!body) {
      body = document.createElement('tbody');
      for (const row of Array.from(table.querySelectorAll(':scope > tr'))) body.appendChild(row);
      table.appendChild(body);
    }
    const head = table.querySelector(':scope > thead');
    if (head) {
      const rows = Array.from(head.querySelectorAll('tr'));
      for (const row of rows) {
        for (const cell of Array.from(row.children)) {
          if (cell.tagName !== 'TD') continue;
          const th = document.createElement('th');
          const align = cell.getAttribute('style');
          if (align) th.setAttribute('style', align);
          th.innerHTML = cell.innerHTML;
          cell.replaceWith(th);
        }
      }
      for (const row of rows.reverse()) body.prepend(row);
      head.remove();
    }
    table.setAttribute('data-draft-node', 'block');
    table.setAttribute('data-draft-type', 'table');
    table.setAttribute('data-size', 'normal');
    table.setAttribute('data-row-style', 'normal');
  }
}

/**
 * 知乎正文只有一个标题级别（工具栏「标题」= h2，H2–H6 粘进去都归一到那一级），
 * h1 则常常落成普通段落——所以一级标题改成 h2。样式已在树上（applyStyles 之后调用），
 * 原样搬到新节点：平台保留内联样式时仍有字号层级，被归一化时至少还是个标题块。
 */
function headingsForZhihu(root: HTMLElement): void {
  for (const h1 of Array.from(root.querySelectorAll('h1'))) {
    const h2 = document.createElement('h2');
    const style = h1.getAttribute('style');
    if (style) h2.setAttribute('style', style);
    while (h1.firstChild) h2.appendChild(h1.firstChild);
    h1.replaceWith(h2);
  }
}

/**
 * 公众号的标签降级（在 applyStyles 之后跑，复用已经内联好的样式）。
 * 微信编辑器会**重建** h1–h6 / pre / ul / ol / li / blockquote / figure 这些块，重建时
 * 只继承文字，不继承内联样式——这就是「标题看不出层级、代码塌成一坨、列表符号丢失」的根因。
 * 可靠的做法是把它们全部换成 p / section / span 再自带样式：
 * - 标题 → p（字号/字重/边框都在样式里，h 标签的语义在公众号里本来也没有用处）；
 * - 代码块 → section + 行间 <br>、空格 &nbsp;（不依赖 white-space，换行与缩进都保得住）；
 * - 行内 code → span（code 同属会被重建的标签）；
 * - 列表 → 每项一个带 `•` / `1.` 前缀、悬挂缩进的段落（微信的 ul 不画符号）；
 * - 引用 → section；figure 拆壳；表格外包一层 section 以便横向滚动。
 */
function wechatBlocks(root: HTMLElement): void {
  // 1) 代码块：按行重排成 <br> + &nbsp;，源码文本本身不变
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const code = pre.querySelector('code');
    const raw = (code?.textContent ?? pre.textContent ?? '').replace(/\n+$/g, '');
    const shell = document.createElement('section');
    shell.className = 'mk-code';
    shell.setAttribute('style', WECHAT_CODE_SHELL);
    const text = document.createElement('span');
    text.setAttribute('style', WECHAT_CODE_TEXT);
    raw.split('\n').forEach((line, i) => {
      if (i > 0) text.appendChild(document.createElement('br'));
      text.appendChild(document.createTextNode(line.replace(/\t/g, '\u00a0\u00a0').replace(/ /g, '\u00a0')));
    });
    shell.appendChild(text);
    pre.replaceWith(shell);
  }

  // 2) 标题 → p（样式整条搬过去，字号层级才留得住）
  for (const h of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    const p = document.createElement('p');
    const style = h.getAttribute('style');
    if (style) p.setAttribute('style', style);
    while (h.firstChild) p.appendChild(h.firstChild);
    h.replaceWith(p);
  }

  // 3) 剩下的行内 code → span
  for (const code of Array.from(root.querySelectorAll('code'))) {
    const span = document.createElement('span');
    const style = code.getAttribute('style');
    if (style) span.setAttribute('style', style);
    while (code.firstChild) span.appendChild(code.firstChild);
    code.replaceWith(span);
  }

  // 4) 列表 → 一串带符号的段落（嵌套列表按深度缩进，接在该项后面）
  const listToBlocks = (list: HTMLElement, depth: number): Element[] => {
    const ordered = list.tagName === 'OL';
    const start = Number(list.getAttribute('start') ?? 1) || 1;
    const out: Element[] = [];
    const items = Array.from(list.children).filter((c) => c.tagName === 'LI') as HTMLElement[];
    items.forEach((li, i) => {
      const nested = Array.from(li.children).filter((c) => c.tagName === 'UL' || c.tagName === 'OL') as HTMLElement[];
      nested.forEach((n) => n.remove());
      // 松散列表的 p 壳收掉；一个 li 里的多段之间补一次换行，否则几段会黏成一行。
      // 块级公式的 p 留着（拆掉就只剩行内代码，居中与上下留白全没）
      const ps = Array.from(li.children).filter((c) => c.tagName === 'P' && !c.classList.contains('mk-math-block'));
      ps.forEach((p, idx) => {
        if (idx > 0) p.before(document.createElement('br'));
        unwrap(p);
      });
      // 任务列表的 ☑/☐ 本身就是符号，不再叠一个 •
      const task = /^[☑☐]/.test((li.textContent ?? '').trimStart());
      const marker = task ? '' : ordered ? `${start + i}.` : '•';
      // li 里还夹着块（代码块/表格/引用/分割线…）时容器必须是 section：
      // p 里塞块会被 HTML 解析器就地拆开，微信那边就多出空段落
      const blocky = Array.from(li.children).some((c) => BLOCKISH.has(c.tagName));
      const block = document.createElement(blocky ? 'section' : 'p');
      block.setAttribute(
        'style',
        `margin:6px 0;padding-left:${(depth + 1) * 24}px;text-indent:${marker ? '-1.1em' : '0'};font-size:16px;line-height:1.75;color:#3f3f3f;`,
      );
      if (marker) block.appendChild(document.createTextNode(`${marker}\u00a0`));
      while (li.firstChild) block.appendChild(li.firstChild);
      trimInlineWhitespace(block);
      out.push(block);
      for (const n of nested) out.push(...listToBlocks(n, depth + 1));
    });
    return out;
  };
  for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
    if (list.parentElement?.closest('ul, ol')) continue; // 嵌套的随父列表一起处理
    list.replaceWith(...listToBlocks(list as HTMLElement, 0));
  }

  // 5) 引用 → section（blockquote 同样会被重建）
  for (const quote of Array.from(root.querySelectorAll('blockquote'))) {
    const section = document.createElement('section');
    const style = quote.getAttribute('style');
    if (style) section.setAttribute('style', style);
    while (quote.firstChild) section.appendChild(quote.firstChild);
    quote.replaceWith(section);
  }

  // 6) figure 拆壳：微信的图片就是 <img>，外壳只会带来默认缩进
  for (const figure of Array.from(root.querySelectorAll('figure'))) unwrap(figure);

  // 7) 表格外包 section：窄屏下发不出去时可以横向滚动，而不是被挤成竖排
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const wrap = document.createElement('section');
    wrap.setAttribute('style', 'margin:0;padding:0;overflow-x:auto;text-indent:0;');
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

/** 公众号整篇套一层 section：微信编辑器把根节点当文章体，样式继承从这里往下走 */
function wrapWechat(root: HTMLElement): string {
  const section = document.createElement('section');
  section.setAttribute('style', WECHAT_ROOT);
  while (root.firstChild) section.appendChild(root.firstChild);
  return section.outerHTML;
}

/**
 * 纯文本兜底：按块补空行。pre 内保留原换行，其余空白折叠成单空格。
 * 不直接用 textContent——那样整篇会连成一坨，平台拒收富文本时读起来是灾难。
 */
function nodeToText(node: Node, pre = false): string {
  if (node.nodeType === 3) {
    const raw = node.nodeValue ?? '';
    return pre ? raw : raw.replace(/\s+/g, ' ');
  }
  if (node.nodeType !== 1) return '';
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'HR') return '\n\n';
  if (tag === 'IMG') {
    const alt = (el.getAttribute('alt') ?? '').trim();
    return alt ? `[${alt}]` : '';
  }
  // 公众号的代码块已经自拼成「section + br + &nbsp;」：这里按 pre 口径保原样（缩进、换行）
  if (tag === 'SECTION' && el.classList.contains('mk-code')) {
    const inner = Array.from(el.childNodes).map((c) => nodeToText(c, true)).join('');
    return `\n\n${inner.replace(/^\n+|\n+$/g, '')}\n\n`;
  }
  const inner = Array.from(el.childNodes).map((c) => nodeToText(c, pre || tag === 'PRE')).join('');
  if (tag === 'TR') {
    return `\n${Array.from(el.children).map((c) => nodeToText(c).trim()).join(' | ')}`;
  }
  if (tag === 'PRE') return `\n\n${inner.replace(/^\n+|\n+$/g, '')}\n\n`;
  if (tag === 'LI') return `\n- ${inner.trim()}`;
  if (BLOCK_TAGS.has(tag)) return `\n\n${inner.trim()}\n\n`;
  return inner;
}

function htmlToText(root: HTMLElement): string {
  return nodeToText(root)
    .replace(/\u00a0/g, ' ') // 公众号代码块的缩进用 &nbsp; 保的，纯文本里还原成普通空格
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseFragment(html: string): HTMLElement {
  // DOMParser 的文档是惰性的：不执行脚本、不加载图片，正好当离线容器用
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html').body;
}

/**
 * 渲染快照 → 目标平台可粘贴的富文本。
 * 顺序有讲究：先按结构改（图/公式/代码/勾选），再剥离属性，最后才套样式——
 * 反过来的话 applyStyles 写进去的 style 会被 stripAttributes 一起清掉。
 * 公众号在套完样式之后还要跑一遍 wechatBlocks：把微信编辑器会重建的标签降级，
 * 降级时直接搬运已经内联好的样式（所以它必须排在 applyStyles 后面）。
 */
export function buildCopyHtml(renderedHtml: string, target: CopyTarget): CopyHtmlResult {
  const root = parseFragment(renderedHtml);
  const stat = { droppedImages: 0, chartSources: 0, mathSources: 0 };

  unwrapPreviewShell(root);
  chartsToSource(root, stat);
  mathToSource(root, target, stat);
  flattenCodeShell(root);
  codeBlocksToPlain(root);
  tasksToGlyph(root);
  imagesToPlaceholder(root, stat);
  stripNoise(root);
  pruneEmpty(root);
  stripAttributes(root);
  if (target === 'zhihu') {
    // 知乎自家的块标记必须在 stripAttributes 之后补：data-draft-* / lang 都不在白名单里
    markZhihuCode(root);
    hoistCodeOutOfLists(root);
    tablesForZhihu(root);
    applyStyles(root, ZHIHU_SHEET);
    headingsForZhihu(root);
  } else {
    applyStyles(root, WECHAT_SHEET);
    wechatBlocks(root);
  }

  const text = htmlToText(root);
  const html = (target === 'wechat' ? wrapWechat(root) : root.innerHTML).trim();
  return { html, text, ...stat };
}
