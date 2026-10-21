/**
 * SVG 源码 → PNG 字节。给预览右键「导出为图片」用。
 *
 * 走「blob URL + `<img>` + canvas」这条浏览器原生栅格化路：SVG 是矢量，直接按目标尺寸
 * 出图，不经过预览 iframe，所以导出的结果不受面板当前缩放与滚动位置影响。
 *
 * ★ 出图前先按**内容包围盒裁一遍**：图自己 viewBox 里就带边距（飞总那份四周各空 24px），
 *   而画布铺的白底与 SVG 的白底同色——只在外面加减 pad 是"白包白"，肉眼完全看不出变化。
 *   裁完再由 pad 决定留多少边，这个设置才真的看得见。
 *
 * ★ 图里有外部引用（`xlink:href` 指到的位图、@font-face 外链字体）时 canvas 会被判脏，
 *   `toBlob` 抛 SecurityError——这是同源策略，没有绕过办法，只能报错。
 */

/** 给根 `<svg>` 换成本次真正要出的 width/height。
 *  源码写 100% 或干脆没写时，浏览器给 `<img>` 的固有尺寸是容器推出来的，不是我们要的 */
function withSize(svg: string, w: number, h: number): string {
  const tag = /<svg\b[^>]*>/i.exec(svg);
  if (!tag) return svg;
  let open = tag[0].replace(/\s(?:width|height)\s*=\s*["'][^"']*["']/gi, '');
  if (!/\sxmlns\s*=/.test(open)) {
    open = open.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return `${svg.slice(0, tag.index)}${open.slice(0, -1)} width="${w}" height="${h}">${svg.slice(tag.index + tag[0].length)}`;
}

/** 扫出内容包围盒：任何一通道 < 250 就算"有东西"（图里那些 #F8FAFD 的浅底区域要算内容）。
 *  每行左右各扫一次定首尾——只从左扫到第一个就 break 的话，maxX 会退化成每行的最左点，
 *  包围盒直接塌成一条几像素宽的竖缝（2026-10-21 实锤：1250×660 裁出 5×253）。
 *  找不到（整张全白）返回 null，调用方按不裁剪处理 */
function contentBox(data: Uint8ClampedArray, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  const hit = (px: number): boolean => {
    const i = px * 4;
    return data[i + 3] !== 0 && (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250);
  };
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1;
    for (let x = 0; x < w; x++) {
      if (hit(row + x)) { first = x; break; }
    }
    if (first < 0) continue; // 整行空白
    let last = first;
    for (let x = w - 1; x > first; x--) {
      if (hit(row + x)) { last = x; break; }
    }
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 栅格长边封顶。Chromium 对超大 canvas 是**静默失败**：canvas.width 照样设进去、
 *  getContext 也正常，只有 toBlob 回 null（实测 20000×10560 出图 3.9MB、
 *  50000×26400 直接 null）。而 4000% 放大一份 1250px 的图正好是 50000px——必撞。
 *  8192px 按 300dpi 印出来有 69cm，贴进 Word 远够，再大只是把 PNG 撑肥。 */
const MAX_SIDE = 8192;

/** 把 svg 源码按 w×h 栅格化，裁掉四周空白，再按 pad 留边，返回 PNG 字节 */
export async function svgToPngBytes(
  svg: string,
  w: number,
  h: number,
  pad: number,
): Promise<Uint8Array> {
  // 超上限就整体等比降下来（pad 不跟着缩——它是用户定的绝对边距）
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const rw = Math.max(1, Math.round(w * k));
  const rh = Math.max(1, Math.round(h * k));
  const url = URL.createObjectURL(
    new Blob([withSize(svg, rw, rh)], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('svg-render-failed'));
      img.src = url;
    });
    const full = document.createElement('canvas');
    full.width = rw;
    full.height = rh;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    if (!fctx) throw new Error('canvas-2d-unavailable');
    // 铺白底：SVG 大多按白底设计，透明导出发出去贴在深色背景上会看不清；
    // 也正因为同为白色，「加白边」这件事肉眼看不出来，所以必须先按内容裁一遍
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, rw, rh);
    fctx.drawImage(img, 0, 0, rw, rh);
    const box = contentBox(fctx.getImageData(0, 0, rw, rh).data, rw, rh);

    // ★ 顺序必须是：先定尺寸 → 再取 context → 再设 fillStyle。
    //   给 canvas.width/height 赋值会整体复位绘图状态，先设色后改尺寸的话
    //   那次 fillRect 用的是默认黑色 → 留边变成黑框（2026-10-21 实锤过一次）
    const out = document.createElement('canvas');
    out.width = (box?.w ?? rw) + pad * 2;
    out.height = (box?.h ?? rh) + pad * 2;
    const octx = out.getContext('2d');
    if (!octx) throw new Error('canvas-2d-unavailable');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    if (box) {
      octx.drawImage(full, box.x, box.y, box.w, box.h, pad, pad, box.w, box.h);
    } else {
      octx.drawImage(img, pad, pad, rw, rh);
    }
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
    if (!blob) throw new Error('png-encode-failed');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
