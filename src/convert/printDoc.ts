/**
 * 打印文档自包含化（2026-10-13，导出 PDF 的 Edge 打印引擎链路）。
 * 输入 = 预览/显示态 HTML 快照；输出 = 完整自包含 HTML 文档（供 Rust 侧
 * 调系统 Edge headless --print-to-pdf 打印成矢量文字型 PDF）。
 *
 * 自包含三件事：
 * ① **样式抓取**：运行 DOM 的全部 <style> 文本 + <link rel=stylesheet> fetch 文本
 *    （md-editor 预览 CSS / KaTeX / hljs / global.css 双主题 token 全量带入）；
 * ② **资源内联**：CSS 的 url(...)（woff2 字体等）与内容里的 img src 一律转 data URI
 *    ——临时 HTML 落在 temp 目录，相对路径/dev-server 路径均不可达，外链则可能被
 *    file:// 的 CORS 策略拦截；
 * ③ **打印结构**：内容包进 `.mk-export-host`（与 WangEditorEngine 的非 scoped
 *    @media print 规则同构：`body>*:not(.mk-export-host)` 隐藏 + 宿主打印显示），
 *    打印范围天然收敛；快照本身已是 MdPreview theme="light" 产物，无需再剥暗色。
 */
import { loadDocxAsset, bytesToDataUri } from './docxAssets';

/** CSS url() 匹配（排除 data:；引号可选） */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** Uint8Array → base64（分块防 String.fromCharCode 爆栈） */
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/** fetch URL → data URI（失败返回 null，保留原样） */
async function toDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get('content-type') ?? 'application/octet-stream';
    return `data:${mime};base64,${bytesToBase64(buf)}`;
  } catch {
    return null;
  }
}

/** CSS 文本自包含：url(...) 相对/绝对化后转 data URI（逐处串行，量小可接受） */
async function inlineCssUrls(css: string): Promise<string> {
  const matches: { raw: string; url: string }[] = [];
  for (const m of css.matchAll(CSS_URL_RE)) {
    const raw = m[2].trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
    matches.push({ raw: m[0], url: raw });
  }
  let out = css;
  for (const { raw, url } of matches) {
    let abs: string;
    try {
      abs = new URL(url, location.href).href;
    } catch {
      continue;
    }
    const dataUri = await toDataUri(abs);
    if (dataUri) out = out.replace(raw, `url(${dataUri})`);
  }
  return out;
}

/** 抓运行 DOM 的全部样式文本（<style> 内联 + <link> fetch），CSS url() 已内联。
 *  长图导出（longImage.ts）复用同一份：两个产物必须吃同一套 CSS 才对得上版式 */
export async function collectStyles(): Promise<string> {
  const parts: string[] = [];
  for (const el of Array.from(document.querySelectorAll('style'))) {
    const css = el.textContent ?? '';
    if (css.trim()) parts.push(await inlineCssUrls(css));
  }
  for (const el of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
    const href = el.href;
    if (!href) continue;
    try {
      const abs = new URL(href, location.href).href;
      const res = await fetch(abs);
      if (!res.ok) continue;
      parts.push(await inlineCssUrls(await res.text()));
    } catch {
      /* 单条样式失败不阻塞整体 */
    }
  }
  return parts.join('\n');
}

/** 内容图片自包含：相对/外链 src → data URI（asset:/data:/blob: 原样保留） */
async function inlineContentImages(html: string): Promise<{ html: string; failed: number }> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let failed = 0;
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = (img.getAttribute('src') ?? '').trim();
    if (!src || src.startsWith('data:') || src.startsWith('asset:') || src.startsWith('blob:')) continue;
    const asset = await loadDocxAsset(src);
    if (asset) {
      img.setAttribute('src', bytesToDataUri(asset.data, asset.type));
    } else {
      failed++;
    }
  }
  return { html: doc.body.innerHTML, failed };
}

/**
 * 组装自包含打印文档。
 * @param contentHtml 预览快照 innerHTML（md = MdPreview 产物；mh = wangEditor 显示态 HTML）
 */
export async function buildPrintDocument(contentHtml: string): Promise<string> {
  const [css, img] = await Promise.all([collectStyles(), inlineContentImages(contentHtml)]);
  const title = document.title || 'print';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
@page { size: A4; margin: 16mm 14mm; }
html, body { margin: 0; padding: 0; background: #fff; }
.mk-export-host { display: block; padding: 0; }
.mk-export-host img { max-width: 100%; }
</style>
<style>
${css}
</style>
</head>
<body><div class="mk-export-host" style="display:block">${img.html}</div></body>
</html>`;
}
