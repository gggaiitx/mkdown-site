import { listSystemFonts } from '../api/settingsApi';

/** 应用默认字体栈：与 global.css 的 body 字体一致（v0.1 起的原有外观） */
export const DEFAULT_APP_FONT_FAMILY =
  "'Geist Variable', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif";

/** 「系统默认」：不吃应用自带字体，直接用各平台原生 UI 字体 */
export const SYSTEM_UI_FONT_FAMILY =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** 设置为空串 = 应用默认（不覆盖任何硬编码字体栈） */
export const DEFAULT_FONT_VALUE = '';

function quoteFontName(name: string): string {
  return `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** 单个家族名 → 字体栈：主字体缺失时回落到应用默认，不至于整页变衬线 */
export function fontStackForName(name: string): string {
  return `${quoteFontName(name)}, ${DEFAULT_APP_FONT_FAMILY}`;
}

/** 从字体栈取第一个家族名做显示（去掉引号） */
export function readableFontFamily(value: string): string {
  const first = value.split(',')[0]?.trim() ?? value;
  return first.replace(/^['"]|['"]$/g, '').replace(/\\'/g, "'");
}

/** 自定义输入归一化：带逗号/引号视为完整字体栈，原样保留；单个名字补默认回落 */
export function normalizeFontInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/[,'"]/.test(trimmed)) return trimmed;
  return fontStackForName(trimmed);
}

/** 设置值 → 实际 CSS 字体栈。custom=false 表示走应用默认（编辑区等仍保留各自的原有字体） */
export function resolveFontFamily(value: string): { css: string; custom: boolean } {
  const trimmed = value.trim();
  return trimmed ? { css: trimmed, custom: true } : { css: DEFAULT_APP_FONT_FAMILY, custom: false };
}

let cachedSystemFonts: string[] | null = null;
let pendingSystemFonts: Promise<string[]> | null = null;

/** 系统字体家族（模块级缓存，首次打开下拉才拉取）；失败也缓存空表，避免每次展开都打 IPC */
export async function loadSystemFonts(): Promise<string[]> {
  if (cachedSystemFonts) return cachedSystemFonts;
  pendingSystemFonts ??= listSystemFonts()
    .then((fonts) => fonts.filter((name) => !name.startsWith('@')))
    .catch(() => [])
    .finally(() => {
      pendingSystemFonts = null;
    });
  cachedSystemFonts = await pendingSystemFonts;
  return cachedSystemFonts;
}
