/**
 * 新建文件的默认名（纯函数，便于单测）。
 *
 * 后缀跟随「当前内核」：建完直接落进同一条引擎链路，不用手动改扩展名。
 * 判定分两级——先认落点路径的文件后缀，再退回内核类型：
 *  1) 有路径时后缀是最硬的依据（引擎本就按后缀归类 .md/.mh/.html/.ts…）；
 *     未保存标签 path 为 null，但 Word 转换产物带 draftPath（意向路径 xxx.mh），同样能取到后缀；
 *  2) 预览类标签（图片 / docx / xlsx / pdf）没有「文本内核」可言 → 一律回落 .md；
 *  3) 真没有路径的新文档才按 kind：mh→.mh、html→.html、svg→.svg、code/text→.txt、md→.md。
 *
 * 基名（stem）由调用方从 i18n 取，后缀不翻译。
 */

/** 新建默认名只看这三样，不依赖整个 store 类型 */
export interface NewFileContext {
  kind: string;
  path: string | null;
  draftPath?: string | null;
}

/** 预览类 kind（与 tabsStore.PreviewKind 一致）：这些标签没有文本内核 */
const PREVIEW_KINDS = new Set(['docx', 'xlsx', 'image', 'pdf']);

const EXT_RE = /\.([^./\\]+)$/;

/** 按当前标签推导新建文件名；tab 为空（无打开文档）按 Markdown 处理 */
export function newFileNameForTab(tab: NewFileContext | null | undefined, stem: string): string {
  if (!tab) return `${stem}.md`;
  if (PREVIEW_KINDS.has(tab.kind)) return `${stem}.md`;
  const src = tab.path ?? tab.draftPath ?? '';
  const ext = src.match(EXT_RE)?.[1];
  if (ext) return `${stem}.${ext}`;
  if (tab.kind === 'mh') return `${stem}.mh`;
  if (tab.kind === 'html') return `${stem}.html`;
  if (tab.kind === 'svg') return `${stem}.svg`;
  if (tab.kind === 'code' || tab.kind === 'text') return `${stem}.txt`;
  return `${stem}.md`;
}
