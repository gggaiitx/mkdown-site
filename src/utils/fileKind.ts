/**
 * 文件类型识别 —— 只服务于目录树的图标与悬浮提示。
 *
 * 边界：这里**不决定**文件能不能在编辑器里打开。真正的判定在 Rust 侧
 * （`fs_service::is_text_file`：扩展名白/黑名单 + 前 8KB 内容嗅探），
 * 前端只做视觉分类，两者不一致时以后端为准。
 */
export type FileKind =
  | 'md'
  | 'text'
  | 'code'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'pdf'
  | 'image'
  | 'media'
  | 'archive'
  | 'other';

const EXT_KIND: Record<string, FileKind> = {
  md: 'md',
  markdown: 'md',
  mdx: 'md',

  txt: 'text',
  text: 'text',
  log: 'text',
  csv: 'text',
  tsv: 'text',

  json: 'code',
  jsonc: 'code',
  json5: 'code',
  yml: 'code',
  yaml: 'code',
  toml: 'code',
  ini: 'code',
  cfg: 'code',
  conf: 'code',
  xml: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  scss: 'code',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  vue: 'code',
  rs: 'code',
  py: 'code',
  go: 'code',
  java: 'code',
  sql: 'code',
  sh: 'code',
  bat: 'code',
  ps1: 'code',

  doc: 'doc',
  docx: 'doc',
  dot: 'doc',
  docm: 'doc',
  rtf: 'doc',
  odt: 'doc',
  wps: 'doc',

  xls: 'sheet',
  xlsx: 'sheet',
  xlsm: 'sheet',
  xlsb: 'sheet',
  ods: 'sheet',
  et: 'sheet',

  ppt: 'slide',
  pptx: 'slide',
  pps: 'slide',
  ppsx: 'slide',
  odp: 'slide',
  dps: 'slide',

  pdf: 'pdf',

  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  bmp: 'image',
  webp: 'image',
  svg: 'image',
  ico: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  emf: 'image',
  wmf: 'image',
  psd: 'image',

  mp3: 'media',
  wav: 'media',
  ogg: 'media',
  flac: 'media',
  mp4: 'media',
  avi: 'media',
  mov: 'media',
  mkv: 'media',
  wmv: 'media',
  flv: 'media',

  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  iso: 'archive',
};

export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 || dot === lower.length - 1) return 'other';
  return EXT_KIND[lower.slice(dot + 1)] ?? 'other';
}

/** 悬浮提示：简要类型说明 */
export const KIND_HINT: Record<FileKind, string> = {
  md: '在编辑器中打开',
  text: '在编辑器中打开',
  code: '在编辑器中打开',
  doc: 'Word 文档',
  sheet: 'Excel 表格',
  slide: 'PPT 演示',
  pdf: 'PDF 文档',
  image: '图片',
  media: '音视频',
  archive: '压缩包',
  other: '文件',
};
