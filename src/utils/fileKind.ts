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
  properties: 'code',
  env: 'code',
  xml: 'code',
  xsd: 'code',
  xsl: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  scss: 'code',
  less: 'code',
  sass: 'code',
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  vue: 'code',
  svelte: 'code',
  rs: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  java: 'code',
  sql: 'code',
  sh: 'code',
  bat: 'code',
  ps1: 'code',
  // systemd unit / desktop 入口（ini 风格键值，2026-10-09 补）
  service: 'code', timer: 'code', socket: 'code',
  target: 'code', mount: 'code', desktop: 'code',

  // —— 扩展代码 / 配置 / 标记语言（与 Rust fs_service::TEXT_EXTS、codeLanguage.ts 对齐）——
  es6: 'code', pac: 'code', mts: 'code', cts: 'code',
  ndjson: 'code', geojson: 'code', jsonld: 'code',
  xhtml: 'code', jsp: 'code', jspx: 'code', erb: 'code', ejs: 'code', hbs: 'code', mustache: 'code',
  rss: 'code', atom: 'code', wsdl: 'code', plist: 'code',
  pcss: 'code', styl: 'code',
  pyw: 'code', pyi: 'code', pyx: 'code',
  postgres: 'code', sqlite: 'code', mssql: 'code', mariadb: 'code', oracle: 'code', hive: 'code', spark: 'code',
  mysql: 'code', pgsql: 'code',
  c: 'code', h: 'code', cpp: 'code', hpp: 'code', cc: 'code',
  cxx: 'code', hxx: 'code', hh: 'code', 'c++': 'code', 'h++': 'code',
  ino: 'code', ipp: 'code', tpp: 'code',
  cs: 'code', scala: 'code', kotlin: 'code', kt: 'code', dart: 'code',
  config: 'code', cnf: 'code', inf: 'code',
  diff: 'code', patch: 'code',
  dockerfile: 'code', containerfile: 'code', cmake: 'code',
  rake: 'code', gemspec: 'code', ru: 'code',
  bash: 'code', zsh: 'code', ksh: 'code', pwsh: 'code',
  lua: 'code', luau: 'code', nse: 'code',
  pl: 'code', pm: 'code', perl: 'code',
  r: 'code',
  swift: 'code',
  clj: 'code', cljs: 'code', cljc: 'code', edn: 'code',
  hs: 'code', lhs: 'code',
  elm: 'code',
  erl: 'code', hrl: 'code',
  lisp: 'code', cl: 'code', lsp: 'code', el: 'code',
  scm: 'code', ss: 'code',
  ocaml: 'code', ml: 'code', fs: 'code', fsharp: 'code', sml: 'code',
  pas: 'code', pp: 'code', p: 'code', lpr: 'code', dpr: 'code',
  d: 'code',
  f: 'code', for: 'code', f77: 'code', f90: 'code', f95: 'code', f03: 'code', f08: 'code', fpp: 'code', ftn: 'code',
  v: 'code', sv: 'code', svh: 'code', vhd: 'code', vhdl: 'code',
  asm: 'code', s: 'code', nasm: 'code',
  cob: 'code', cbl: 'code', cobol: 'code',
  cr: 'code',
  groovy: 'code', gradle: 'code', gvy: 'code',
  julia: 'code', jl: 'code',
  coffeescript: 'code', coffee: 'code', iced: 'code',
  tex: 'code', sty: 'code', cls: 'code', bib: 'code', stex: 'code',
  tcl: 'code', tclsh: 'code',
  feature: 'code',
  proto: 'code',
  solr: 'code', sparql: 'code', rq: 'code', ttl: 'code', nt: 'code', msc: 'code',
  widl: 'code', webidl: 'code', idl: 'code',
  xq: 'code', xql: 'code', xquery: 'code', xqy: 'code', xqm: 'code',
  nsi: 'code', nsh: 'code',
  puppet: 'code',
  vb: 'code', vbs: 'code',
  vm: 'code',
  nginx: 'code',
  rpm: 'code', spec: 'code',
  oz: 'code', pig: 'code', pegjs: 'code', peg: 'code', sas: 'code',
  factor: 'code', fcl: 'code', forth: 'code', frt: 'code',
  dylan: 'code', dyl: 'code', ebnf: 'code', ecl: 'code',
  eiffel: 'code', e: 'code',
  haxe: 'code', hxml: 'code',
  http: 'code',
  jinja: 'code', j2: 'code', jinja2: 'code',
  livescript: 'code', ls: 'code',
  mathematica: 'code', mma: 'code',
  mbox: 'code',
  mirc: 'code', mrc: 'code',
  modelica: 'code', mo: 'code',
  octave: 'code',
  smalltalk: 'code', st: 'code',
  sieve: 'code', siv: 'code',
  textile: 'code',
  tiddlywiki: 'code', tid: 'code',
  tiki: 'code',
  troff: 'code', roff: 'code',
  ttcn: 'code', ttcn3: 'code', ttcnpp: 'code',
  wast: 'code', wat: 'code',
  yacas: 'code',
  z80: 'code',
  apl: 'code',
  asn: 'code', asn1: 'code',
  asc: 'code',
  asterisk: 'code',
  brainfuck: 'code', bf: 'code',
  cypher: 'code', cql: 'code',
  dtd: 'code',

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

/** 是否为代码类扩展名（与 Rust 侧 TEXT_EXTS 的代码集对齐，供 tabsStore 归 kind='code'） */
export function isCodeExt(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 || dot === lower.length - 1) return false;
  return EXT_KIND[lower.slice(dot + 1)] === 'code';
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
