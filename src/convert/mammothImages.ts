/**
 * mammoth convertImage 钩子（R3/R4 图片落盘，D4）。
 * docx 内嵌图片 → 落盘 docx 同目录 assets/ → './assets/img-xxx.png' 相对路径
 * （与粘贴图同一 Rust 命令 save_pasted_image，目录规则一致）；
 * 落盘失败（工作区外无权限 / 不支持的格式如 EMF）→ data: URL 内嵌降级 + 计数，
 * 由调用方汇总 toast。alt 由 mammoth imgElement 自动从 altText 带上（V13）。
 */
import mammoth from 'mammoth';
import { savePastedImage } from '../api/imageApi';

export interface ImageSaveStats {
  /** 成功落盘 assets/ 的图片数 */
  saved: number;
  /** 降级 data: URL 内嵌的图片数 */
  inline: number;
}

export const newImageStats = (): ImageSaveStats => ({ saved: 0, inline: 0 });

/** 由 contentType 推导扩展名；不在白名单的返回 null（走 data: 降级） */
function extFromContentType(contentType: string): string | null {
  const ext = (contentType ?? '').split('/')[1]?.split(';')[0]?.toLowerCase() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext) ? ext : null;
}

export function makeConvertImage(docxPath: string, stats: ImageSaveStats) {
  return mammoth.images.imgElement(async (image) => {
    const base64 = await image.readAsBase64String();
    const ext = extFromContentType(image.contentType ?? '');
    if (ext) {
      try {
        const saved = await savePastedImage(docxPath, base64, ext);
        stats.saved++;
        return { src: saved.relPath };
      } catch {
        // 落盘失败：落到 data: URL 降级
      }
    }
    stats.inline++;
    return { src: `data:${image.contentType || 'image/png'};base64,${base64}` };
  });
}
