/**
 * MD → DOCX 社区引擎（@mohtasham/md-to-docx 试点，2026-10-13 调研落地）。
 * 与内置 htmlToDocx（HTML 快照白名单映射）的差异：**直接吃 md 原文**，不依赖预览渲染产物：
 * - $...$ / $$...$$ → Word 原生 OMML 公式（可编辑），不再走 KaTeX 光栅化降级；
 * - 围栏代码块 lowlight 语法高亮着色（内置引擎只摊平灰底）；
 * - mermaid 围栏接现有 renderMermaidSvg（FO-free 渲染）→ PNG 光栅化，失败降级保留代码块；
 * - 相对路径图片经 loadDocxAsset 读字节 resolve（与内置导出同口径：相对路径/data:/外链）。
 * 已知边界：中英双字体基线降级为单 fontFamily（取中文字体，等线自带拉丁字形可接受）；
 * 仅支持 GFM 管道表；任务列表转 Word 复选框字符；仅在设置 wordExportEngine='community' 时启用。
 * 依赖动态 import（D4 懒加载；新包为 CJS 混合，走 vite 预构建，严禁 exclude）。
 */
import type { WordStyleOpts } from './htmlToDocx';
import type { MermaidRenderInput } from '@mohtasham/md-to-docx';
import { loadDocxAsset, probeSvgSize } from './docxAssets';
import { rasterizeSvgBytes } from './docxImagefy';
import { renderMermaidSvg } from '../adapters/mdRendererConfig';

export interface MdToDocxCommunityResult {
  blob: Blob;
  /** 可恢复降级警告（图片失败/公式不支持/图表降级等），供 toast 汇总 */
  warnings: string[];
}

/** DocxAsset.type → MIME（库按 contentType 识别 PNG/JPEG/GIF；SVG 先光栅化为 PNG） */
function mimeOf(type: string): string {
  switch (type) {
    case 'jpg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'image/png';
  }
}

export async function mdToDocxCommunity(
  md: string,
  opts: WordStyleOpts,
  baseDir?: string,
): Promise<MdToDocxCommunityResult> {
  const warnings: string[] = [];
  const { convertMarkdownToDocx } = await import('@mohtasham/md-to-docx');

  // 字号基线：正文=设置值，标题梯度与内置引擎一致（+7/+5/+3/+2/+1/+0）
  const fs = Math.min(24, Math.max(9, opts.fontSize || 11));
  const blob = await convertMarkdownToDocx(md, {
    style: {
      fontFamily: opts.fontZh,
      paragraphSize: fs,
      heading1Size: fs + 7,
      heading2Size: fs + 5,
      heading3Size: fs + 3,
      heading4Size: fs + 2,
      heading5Size: fs + 1,
      heading6Size: fs,
      codeBlockSize: Math.max(9, fs - 1),
      inlineCodeSize: Math.max(9, fs - 1),
      blockquoteSize: fs,
      listItemSize: fs,
    },
    codeHighlighting: { enabled: true },
    mathRendering: { enabled: true, unsupported: 'text' },
    mermaidRendering: {
      enabled: true,
      failureMode: 'codeBlock',
      render: async (input: MermaidRenderInput) => {
        const svg = await renderMermaidSvg(input.code);
        if (!svg) return null;
        const size = probeSvgSize(svg);
        const svgBytes = new TextEncoder().encode(svg);
        const png = await rasterizeSvgBytes(svgBytes);
        if (!png) return null;
        return {
          data: png,
          contentType: 'image/png',
          width: size?.width,
          height: size?.height,
        };
      },
    },
    imageHandling: {
      resolve: async (source) => {
        const asset = await loadDocxAsset(source, baseDir);
        if (!asset) return null;
        if (asset.type === 'svg') {
          // SVG：库不支持直嵌 → 光栅化 PNG（与内置引擎位图化兜底同口径）
          const png = await rasterizeSvgBytes(asset.data);
          return png ? { data: png, contentType: 'image/png' } : null;
        }
        return { data: asset.data, contentType: mimeOf(asset.type) };
      },
      maxImages: 200,
      maxImageBytes: 20 * 1024 * 1024,
    },
    onWarning: (w) => {
      if (warnings.length < 8) warnings.push(w.message);
    },
  });

  return { blob, warnings };
}
