/**
 * 导出长图（2026-10-27）：把当前文档的渲染快照组装成自包含 HTML，
 * 交给 Rust 侧 Edge headless 整页截图成一张 PNG。
 *
 * 与打印文档（printDoc.ts）同源，四处差异：
 * ① **版面定宽**：宽度由调用方从当前内容列量出（不是写死 800/860），
 *    四周补 SHOT_PAD 白边；headless 就按这个宽度排版，长图与所见版式一致；
 * ② **图片连 asset:// 一起内联**：长图是独立 PNG，不能依赖应用协议；
 * ③ **注入 :root 字号/字体变量**：全局字号写在 <html> 的行内样式里，
 *    collectStyles 抓不到，不补就会按默认 13px 出图；
 * ④ **补 .md-editor 包裹层**（仅 md 快照）：快照取的是宿主 innerHTML，宿主自身那层
 *    .md-editor 才是 --md-* 变量声明处（.md-editor .md-editor-preview 的主题变量也依赖它），
 *    不补则引用块/代码块/表格的主题色全部落空（.mh 快照同理，补 .w-e-text-container 链）；
 * ⑤ **测量脚本**：把 scrollHeight 写进 <title>（Rust 侧据此定截图高度）。
 */
import { bytesToDataUri, loadDocxAsset } from './docxAssets';
import { collectStyles } from './printDoc';

/** 长图四周白边（px）：给分享留呼吸感，别贴边 */
const SHOT_PAD = 32;

/** 兜底内容宽度：量不出内容列时（仅编辑态等）按中等版式 940 出图 */
const FALLBACK_CONTENT_W = 940;

/** 页面加载完（含字体/图片）后把整页高度写进 <title>，Rust 侧读这一行 */
const MEASURE_SCRIPT = `<script>
(function () {
  function report() {
    document.title = 'MKSHOT:' + Math.ceil(document.documentElement.scrollHeight);
  }
  function afterFonts() {
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : null;
    if (fonts) fonts.then(function () { setTimeout(report, 60); });
    else setTimeout(report, 60);
  }
  if (document.readyState === 'complete') afterFonts();
  else window.addEventListener('load', afterFonts);
})();
</script>`;

/** 内容预处理：图片自包含（data: 原样，asset:// / 外链 / 相对路径全部 fetch 成 data URI）；
 *  剔除 mermaid 悬浮操作条——它在 DOM 里本是 <p> 的子节点，序列化后 HTML 解析
 *  会把 <div> 弹出 <p> 变成兄弟节点，样式挂不上，静态图里就露出一排复制/放大图标。 */
async function prepareContent(html: string): Promise<{ html: string; failed: number }> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('.md-editor-mermaid-action').forEach((n) => n.remove());
  let failed = 0;
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = (img.getAttribute('src') ?? '').trim();
    if (!src || src.startsWith('data:')) continue;
    const asset = await loadDocxAsset(src);
    if (asset) img.setAttribute('src', bytesToDataUri(asset.data, asset.type));
    else failed++;
  }
  return { html: doc.body.innerHTML, failed };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface LongImageDoc {
  html: string;
  /** 截图窗口宽度（CSS px）= 内容宽 + 两侧白边 */
  width: number;
  /** 内联失败的图片数（外链抓不到），调用方据此提示 */
  failedImages: number;
}

export interface LongImageOptions {
  /** 快照来自哪个引擎：决定补哪条外壳链（不能按内容猜——.mh 正文里提到
   *  「md-editor-preview」这种 CSS 类名很正常，猜错就套错主题） */
  kind: 'md' | 'mh';
  /** 当前内容列的内容盒宽度（CSS px），由调用方量取 */
  contentWidth: number;
  title?: string;
  /** :root 上的行内 CSS 变量（字号/字体），原样注入到文档 */
  rootVars?: Record<string, string>;
}

/**
 * 组装长图自包含文档。
 * @param contentHtml 渲染快照（md = getExportPreviewHtml；.mh = getDisplayHtml）
 */
export async function buildLongImageDocument(
  contentHtml: string,
  opts: LongImageOptions,
): Promise<LongImageDoc> {
  const contentWidth = Math.round(opts.contentWidth) || FALLBACK_CONTENT_W;
  const width = contentWidth + SHOT_PAD * 2;
  const [css, content] = await Promise.all([collectStyles(), prepareContent(contentHtml)]);
  const vars = Object.entries(opts.rootVars ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v.replace(/[;{}<>]/g, '')};`)
    .join('');
  const title = escapeHtml(opts.title ?? 'MkDown');
  // Markdown 快照要补 .md-editor 那层（变量载体）；.mh 是裸 HTML，得补回富文本的
  // .w-e-text-container / [data-slate-editor] 祖先——表格边框、引用块等样式全挂在这条链上
  const body = opts.kind === 'mh'
    ? `<div class="w-e-text-container"><div data-slate-editor="true">${content.html}</div></div>`
    : `<div class="md-editor md-editor-previewOnly">${content.html}</div>`;
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
/* height/overflow 必须 !important：应用外壳的 html,body{height:100%} + body{overflow:hidden}
   在屏幕媒体下会把页面裁成一屏高，截图就只剩首屏 */
html, body { margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; background: #fff; }
body { width: ${width}px; }
.mk-shot { box-sizing: border-box; width: ${width}px; padding: ${SHOT_PAD}px; background: #fff; }
.mk-shot img { max-width: 100%; }
/* 正文字号也要自己带：应用里是 scoped 覆盖（.engine-root[data-v] .md-editor-preview /
   [data-slate-editor]），快照里没有那层作用域；主题自带的 16px 会顶掉 :root 变量 */
.mk-shot,
.mk-shot .md-editor-preview,
.mk-shot [data-slate-editor] {
  font-size: var(--mk-font-size, 16px) !important;
}
/* .mh 正文行距（应用里写在 [data-slate-editor] 上，快照里可能没这层） */
.mk-shot { line-height: 1.7; }
/* 外壳自身的内边距/限宽会和「按内容列量出的宽度」叠成二次缩进，全部清零 */
.mk-shot .md-editor-preview-wrapper,
.mk-shot .md-editor-preview,
.mk-shot article,
.mk-shot [data-slate-editor] {
  max-width: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
}
</style>
<style>
${css}
</style>
<style>
/* 必须排在抓来的 CSS 之后：全局字号/字体写在 <html> 行内，只有行内值能赢它 */
:root { ${vars} }
</style>
</head>
<body><div class="mk-shot">${body}</div>${MEASURE_SCRIPT}</body>
</html>`;
  return { html, width, failedImages: content.failed };
}
