/**
 * 导出 Word 时的图片字节归一（R1/R2 共用）。
 * 输入 HTML 里的 src 形态（预览 DOM = asset:// / data: / http(s)，磁盘态 = 相对路径），
 * 输出可直接喂 docx ImageRun 的 { data, type, w, h }。
 * 不 import 编辑器内核；全部本地 fetch，无网络依赖之外的逻辑（http(s) 外链图失败即降级）。
 */

import { joinRelPath } from '../utils/pathJoin';

/** docx ImageRun 支持的位图类型（svg 单独走 SvgMediaOptions） */
export type DocxAssetType = 'png' | 'jpg' | 'gif' | 'bmp' | 'svg';

export interface DocxAsset {
  data: Uint8Array;
  type: DocxAssetType;
  /** 内在像素尺寸（探测失败为 undefined，由映射层回退） */
  width?: number;
  height?: number;
}

/** convertFileSrc 两种形态的 asset 前缀（P2-13 口径，同 WangEditorEngine.htmlToDisk） */
const ASSET_RE = /^(?:https?:\/\/asset\.localhost|asset:\/\/localhost)\//i;
/** 预览 DOM 里 mh 的本地图已是 asset://；磁盘态相对路径需 baseDir 解析 */
const EXT_TYPE: Record<string, DocxAssetType> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  jpe: 'jpg',
  gif: 'gif',
  bmp: 'bmp',
  svg: 'svg',
};

export function assetTypeFromExt(ext: string): DocxAssetType | null {
  return EXT_TYPE[ext.toLowerCase()] ?? null;
}

function typeFromMime(mime: string): DocxAssetType | null {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('bmp')) return 'bmp';
  if (m.includes('svg')) return 'svg';
  return null;
}

function extOf(url: string): string {
  const clean = url.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(dot + 1) : '';
}

// ---------- 内在尺寸探测（解析文件头，零解码成本） ----------

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

/** PNG IHDR / GIF LSD / BMP INFOHEADER 尺寸 */
function probeRaster(b: Uint8Array): { width: number; height: number } | undefined {
  // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 在 8+4+4 起
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  // GIF: "GIF87a"/"GIF89a"，逻辑屏幕描述符（6 起，小端 u16 ×2）
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: u16le(b, 6), height: u16le(b, 8) };
  }
  // BMP: "BM"，DIB 头 14 起；宽 18（i32 LE），高 22（i32 LE，可负 = 自底向上）
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24);
    const h = b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24);
    return { width: Math.abs(w), height: Math.abs(h) };
  }
  return undefined;
}

/** JPEG：扫段头找 SOF0-SOF15（0xC0~0xCF，排除 C4/C8/CC）取高宽 */
function probeJpeg(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS：后续是熵数据，不再扫
    const len = (b[o + 2] << 8) | b[o + 3];
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      return { height: (b[o + 5] << 8) | b[o + 6], width: (b[o + 7] << 8) | b[o + 8] };
    }
    o += 2 + len;
  }
  return undefined;
}

/** SVG：width/height 属性 → viewBox 兜底（单位按 px 计，pt/% 等复杂单位放弃） */
export function probeSvgSize(text: string): { width: number; height: number } | undefined {
  const wm = /<svg[^>]*?\bwidth\s*=\s*["']\s*([\d.]+)/i.exec(text);
  const hm = /<svg[^>]*?\bheight\s*=\s*["']\s*([\d.]+)/i.exec(text);
  if (wm && hm) {
    const w = Number(wm[1]);
    const h = Number(hm[1]);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  const vb = /<svg[^>]*?\bviewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i.exec(text);
  if (vb) {
    const w = Number(vb[1]);
    const h = Number(vb[2]);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return undefined;
}

function probeAsset(b: Uint8Array, type: DocxAssetType): DocxAsset {
  if (type === 'svg') {
    const text = new TextDecoder().decode(b.slice(0, 4096));
    const size = probeSvgSize(text);
    return { data: b, type, width: size?.width, height: size?.height };
  }
  if (type === 'jpg') {
    const size = probeJpeg(b);
    return { data: b, type, width: size?.width, height: size?.height };
  }
  const size = probeRaster(b);
  return { data: b, type, width: size?.width, height: size?.height };
}

// ---------- 来源解析 ----------

function fromDataUri(src: string): DocxAsset | null {
  const m = /^data:([^;,]*)?(;base64)?,(.*)$/is.exec(src);
  if (!m) return null;
  const mime = m[1] ?? '';
  const isB64 = !!m[2];
  const payload = m[3] ?? '';
  if (!payload) return null;
  let bytes: Uint8Array;
  try {
    if (isB64) {
      const bin = atob(payload);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
  } catch {
    return null;
  }
  let type = typeFromMime(mime);
  if (!type) {
    // data:;base64 之类缺 mime 的，按文件头嗅探
    type =
      (bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : undefined) ??
      (bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' : undefined) ??
      (bytes[0] === 0x47 && bytes[1] === 0x49 ? 'gif' : undefined) ??
      (bytes[0] === 0x42 && bytes[1] === 0x4d ? 'bmp' : undefined) ??
      (new TextDecoder().decode(bytes.slice(0, 256)).includes('<svg') ? 'svg' : null);
  }
  if (!type) return null;
  return probeAsset(bytes, type);
}

/**
 * 归一 HTML 里的图片 src 为 docx 可用字节。
 * @param src HTML 中的 src（asset:// / data: / http(s) / 相对路径）
 * @param baseDir 相对路径解析基准目录（文档所在目录）；无则相对路径放弃
 */
export async function loadDocxAsset(src: string, baseDir?: string): Promise<DocxAsset | null> {
  const raw = (src ?? '').trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('data:')) return fromDataUri(raw);
    if (ASSET_RE.test(raw) || /^https?:\/\//i.test(raw)) {
      const res = await fetch(raw);
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      let type = typeFromMime(res.headers.get('content-type') ?? '') ?? assetTypeFromExt(extOf(raw));
      if (!type) type = 'png';
      return probeAsset(buf, type);
    }
    // 相对路径：需 baseDir 才能转 asset://（预览 DOM 里本地图都已转成 asset://，此路兜底）
    if (baseDir) {
      const rel = raw.replace(/^\.\//, '');
      if (!rel || rel.startsWith('..')) return null;
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      // 分隔符按 baseDir 形态决定：写死 `\` 在 mac/Linux 上会把整条相对路径拼成一个文件名
      const url = convertFileSrc(joinRelPath(baseDir, rel));
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      const type = assetTypeFromExt(extOf(rel)) ?? 'png';
      return probeAsset(buf, type);
    }
    return null;
  } catch {
    return null;
  }
}

/** bytes → data URI（docxImagefy 的 PNG fallback 与外部消费用） */
export function bytesToDataUri(bytes: Uint8Array, type: DocxAssetType): string {
  const mime = type === 'svg' ? 'image/svg+xml' : type === 'jpg' ? 'image/jpeg' : `image/${type}`;
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}
