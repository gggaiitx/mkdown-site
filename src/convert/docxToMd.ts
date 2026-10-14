/**
 * DOCX → Markdown 反转管线（R3，2026-10-13 引擎升级）。
 * 原实现 = mammoth → turndown(+gfm) + 自维护表格规范化补丁；
 * 现切换到 **word-to-markdown-js**（benbalter/word-to-markdown-js，Apache-2.0）——
 * 内部同为 mammoth + turndown 系（@joplin/turndown），叠加社区生产环境打磨的
 * 后处理规则集：GFM 脚注 [^1]、嵌套列表规范化、markdownlint 输出清洗、
 * 加密/敏感标签警告（word2md.com 同源）。图片走 images:'extract' 拿字节，
 * 复用现有 savePastedImage 落盘链路（./assets/ 相对路径），失败降级 data: URL。
 * 依赖动态 import（D4 懒加载）。
 */
import { readPreviewBytes, tooLargeToPreview } from '../components/preview/PreviewAssets';
import { savePastedImage } from '../api/imageApi';
import { newImageStats, type ImageSaveStats } from './mammothImages';

export interface DocxToMdResult {
  md: string;
  /** 提取到的文本字符数（剥离图片语法与非空白后；0 → 调用方出「未提取到内容」警示，V11） */
  textLength: number;
  images: ImageSaveStats;
  /** 文档级警告（加密/敏感标签等，供摘要区展示） */
  warnings: string[];
}

/** 落盘扩展名白名单（与 mammothImages.extFromContentType 同口径）；其余一律 data: 降级 */
const EXT_WHITELIST = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

function extOfPath(p: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1].toLowerCase() : null;
}

function extOfContentType(ct: string): string | null {
  const ext = (ct ?? '').split('/')[1]?.split(';')[0]?.toLowerCase() ?? '';
  return EXT_WHITELIST.has(ext) ? ext : null;
}

/** Uint8Array → base64（分块避免 String.fromCharCode 爆栈） */
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export async function docxToMd(docxPath: string): Promise<DocxToMdResult> {
  const buf = await readPreviewBytes(docxPath);
  if (tooLargeToPreview(buf)) {
    throw new Error('docx too large');
  }
  const { convertWithWarnings } = await import('word-to-markdown');

  const images = newImageStats();
  const r = await convertWithWarnings(buf, {
    // 图片抽取：返回字节自行落盘（imageDir 决定 md 内引用与 ExtractedImage.path）
    images: 'extract',
    imageDir: 'assets',
    footnotes: 'gfm',
    numberedLists: 'ordered',
    underline: 'ignore',
  });

  let md = r.markdown;
  // 图片落盘：path 形如 'assets/imageN.ext'，与 md 内引用一一对应 → 全字替换为实际相对路径
  for (const img of r.images ?? []) {
    const ext = extOfPath(img.path) ?? extOfContentType(img.contentType);
    if (ext && EXT_WHITELIST.has(ext)) {
      try {
        const saved = await savePastedImage(docxPath, bytesToBase64(img.bytes), ext);
        images.saved++;
        md = md.replaceAll(img.path, saved.relPath);
        continue;
      } catch {
        // 工作区外无权限等：落盘失败降级 data: URL
      }
    }
    images.inline++;
    const ct = img.contentType || 'image/png';
    md = md.replaceAll(img.path, `data:${ct};base64,${bytesToBase64(img.bytes)}`);
  }

  // 零提取判定（V11）：剥离图片语法后的非空白字符数
  const textLength = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s/g, '').length;

  return {
    md,
    textLength,
    images,
    warnings: r.warnings.slice(0, 5),
  };
}
