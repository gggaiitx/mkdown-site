/**
 * 把一份图片复制到系统剪贴板（位图形态——贴进 Word / 微信就当截图用）。
 *
 * ★ Chromium 的异步剪贴板写图只认 `image/png`，而图片标签能开的不止 png：
 *   · png 直接把原字节交出去，不重新编码（透明通道、画质都保真）；
 *   · jpg / bmp / webp / gif / ico 先 `createImageBitmap` 解码，再画进 canvas 出 PNG。
 *     解码走的是 Blob（同源），刻意不复用面板里那个 `<img>`——那张是从 asset:// 来的，
 *     一旦进 canvas 就被判脏、`toBlob` 抛 SecurityError。
 *   · 动图只会拿到第一帧：剪贴板里没有动图形态，不是本函数的取舍。
 * 读字节走预览那套统一入口（asset:// + CSP connect-src 已放行），不另开一条 IPC。
 */
import { readPreviewBytes, tooLargeToPreview } from '../components/preview/PreviewAssets';

/** 取不到位图 / 编码失败 / 内核不支持，一律抛稳定 ASCII 码，文案在语言包里拼 */
export type ClipboardImageError = 'too-large' | 'decode-failed' | 'png-encode-failed' | 'canvas-unavailable' | 'clipboard-item-unsupported';

function fail(code: ClipboardImageError): never {
  throw new Error(code);
}

/** 图片字节 → 能进剪贴板的 PNG blob（png 原样透传，其余重编码） */
export async function toClipboardImageBlob(bytes: ArrayBuffer, ext: string): Promise<Blob> {
  if (tooLargeToPreview(bytes)) fail('too-large');
  if (ext === 'png') return new Blob([bytes], { type: 'image/png' });
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes]));
  } catch {
    fail('decode-failed');
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) fail('canvas-unavailable');
    ctx.drawImage(bmp, 0, 0);
    const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!png) fail('png-encode-failed');
    return png;
  } finally {
    bmp.close();
  }
}

/** 交字节（png 之外的格式在这里重编码成 PNG），再写剪贴板 */
export async function copyImageBytes(bytes: ArrayBuffer, ext: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined') fail('clipboard-item-unsupported');
  const blob = await toClipboardImageBlob(bytes, ext);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** 从磁盘路径复制：扩展名只用来判"能不能原样透传"，认不出来的一律走解码重编码 */
export async function copyImageFile(path: string): Promise<void> {
  const ext = (path.split(/[\\/]/).pop()?.split('.').pop() ?? '').toLowerCase();
  await copyImageBytes(await readPreviewBytes(path), ext);
}
