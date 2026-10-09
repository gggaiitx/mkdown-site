/**
 * ★ 代码语言包按需加载（扩展名 → CM6 LanguageSupport）。
 * 所有 import 必须动态：语言包（含 legacy-modes）不得进首屏 chunk（架构 D4）。
 * 扩展名集合与 Rust 侧 fs_service::TEXT_EXTS 的代码集对齐（见下方 loaders + 该常量）。
 *
 * 类型说明：@codemirror/legacy-modes 的 StreamParser 源自 @codemirror/streamparser，
 * 与 @codemirror/language 内置 StringStream 的私有 tabSize 声明存在**名义类型**差异
 * （运行时为同一结构，扁平安装下版本交叉所致），经 defineLegacy 统一断言收口。
 *
 * 导出名注意：legacy-modes 多数模块导出名 === 文件名，少数例外（已实测 .d.ts）：
 *   powershell → powerShell | coffeescript → coffeeScript | commonlisp → commonLisp |
 *   dockerfile → dockerFile | clike → {c,cpp,java,csharp,scala,kotlin,dart,objectiveC,...} |
 *   mllike → {oCaml,fSharp,sml} | sql → {standardSQL,mySQL,pgSQL,sqlite,msSQL,...} |
 *   stex → {stex,stexMath} | vbscript → {vbScript,vbScriptASP} | webidl → webIDL |
 *   xquery → xQuery | ttcn-cfg → ttcnCfg | haxe → {haxe,hxml} | gas → {gas,gasArm}
 */
import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

type LangLoader = () => Promise<Extension[]>;

/** legacy StreamParser 断言收口：streamparser 名义类型 → language 运行时类型 */
function defineLegacy(parser: unknown) {
  return StreamLanguage.define(parser as Parameters<typeof StreamLanguage.define>[0]);
}

/** legacy 语言加载器：按 (模块名, 导出名) 动态 import。模块路径前缀静态可析，Vite 据此分包。 */
function legacy(mod: string, name: string): LangLoader {
  return async () => {
    const m = (await import(`@codemirror/legacy-modes/mode/${mod}`)) as Record<string, unknown>;
    return [defineLegacy(m[name])];
  };
}

// ── 官方语言包（优先于 legacy，动态 import 懒加载）──
const jsLoader = async () => [(await import('@codemirror/lang-javascript')).javascript({ jsx: true })];
const tsLoader = async () => [(await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })];
const mtsLoader = async () => [(await import('@codemirror/lang-javascript')).javascript({ typescript: true })];
const jsonLoader = async () => [(await import('@codemirror/lang-json')).json()];
const htmlLoader = async () => [(await import('@codemirror/lang-html')).html()];
const cssLoader = async () => [(await import('@codemirror/lang-css')).css()];
const pythonLoader = async () => [(await import('@codemirror/lang-python')).python()];
const rustLoader = async () => [(await import('@codemirror/lang-rust')).rust()];
const javaLoader = async () => [(await import('@codemirror/lang-java')).java()];
const sqlLoader = async () => [(await import('@codemirror/lang-sql')).sql()];
const yamlLoader = async () => [(await import('@codemirror/lang-yaml')).yaml()];
const cppLoader = async () => [(await import('@codemirror/lang-cpp')).cpp()];

const loaders: Record<string, LangLoader> = {
  // ══ JavaScript / TypeScript ══
  js: jsLoader, mjs: jsLoader, cjs: jsLoader, jsx: jsLoader, es6: jsLoader, pac: jsLoader,
  ts: tsLoader, tsx: tsLoader, mts: mtsLoader, cts: mtsLoader,

  // ══ JSON / 数据交换 ══
  json: jsonLoader, jsonc: jsonLoader, json5: jsonLoader,
  ndjson: jsonLoader, geojson: jsonLoader, jsonld: legacy('javascript', 'jsonld'),

  // ══ Web 标记 / 模板 ══
  html: htmlLoader, htm: htmlLoader, xhtml: htmlLoader,
  vue: htmlLoader, svelte: htmlLoader,
  jsp: htmlLoader, jspx: htmlLoader, erb: htmlLoader,
  ejs: htmlLoader, hbs: htmlLoader, mustache: htmlLoader,
  xml: legacy('xml', 'xml'), xsd: legacy('xml', 'xml'), xsl: legacy('xml', 'xml'),
  svg: legacy('xml', 'xml'),
  rss: legacy('xml', 'xml'), atom: legacy('xml', 'xml'),
  wsdl: legacy('xml', 'xml'), plist: legacy('xml', 'xml'),

  // ══ CSS / 样式 ══
  css: cssLoader, scss: cssLoader, less: cssLoader, sass: cssLoader, pcss: cssLoader,
  styl: legacy('stylus', 'stylus'),

  // ══ 后端 / 脚本（官方包）══
  py: pythonLoader, pyw: pythonLoader, pyi: pythonLoader, pyx: pythonLoader,
  rs: rustLoader, java: javaLoader,
  yaml: yamlLoader, yml: yamlLoader,

  // ══ SQL 方言 ══
  sql: sqlLoader,
  mysql: legacy('sql', 'mySQL'), pgsql: legacy('sql', 'pgSQL'),
  postgres: legacy('sql', 'pgSQL'), sqlite: legacy('sql', 'sqlite'),
  mssql: legacy('sql', 'msSQL'), mariadb: legacy('sql', 'mariaDB'),
  oracle: legacy('sql', 'plSQL'), hive: legacy('sql', 'hive'), spark: legacy('sql', 'sparkSQL'),

  // ══ C / C++ 系（官方 cpp 包）══
  c: cppLoader, h: cppLoader, cpp: cppLoader, hpp: cppLoader, cc: cppLoader,
  cxx: cppLoader, hxx: cppLoader, hh: cppLoader, 'c++': cppLoader, 'h++': cppLoader,
  ino: cppLoader, ipp: cppLoader, tpp: cppLoader,

  // ══ C# / Scala / Kotlin / Dart（clike 模块，legacy）══
  cs: legacy('clike', 'csharp'), scala: legacy('clike', 'scala'),
  kotlin: legacy('clike', 'kotlin'), kt: legacy('clike', 'kotlin'),
  dart: legacy('clike', 'dart'),

  // ══ 配置 / 标记语言 ══
  toml: legacy('toml', 'toml'),
  ini: legacy('properties', 'properties'), cfg: legacy('properties', 'properties'),
  conf: legacy('properties', 'properties'), properties: legacy('properties', 'properties'),
  env: legacy('properties', 'properties'), config: legacy('properties', 'properties'),
  cnf: legacy('properties', 'properties'), inf: legacy('properties', 'properties'),
  diff: legacy('diff', 'diff'), patch: legacy('diff', 'diff'),
  dockerfile: legacy('dockerfile', 'dockerFile'), containerfile: legacy('dockerfile', 'dockerFile'),
  cmake: legacy('cmake', 'cmake'),

  // ══ 各语言（legacy-modes）══
  go: legacy('go', 'go'),
  rb: legacy('ruby', 'ruby'), rake: legacy('ruby', 'ruby'),
  gemspec: legacy('ruby', 'ruby'), ru: legacy('ruby', 'ruby'),
  sh: legacy('shell', 'shell'), bash: legacy('shell', 'shell'),
  zsh: legacy('shell', 'shell'), ksh: legacy('shell', 'shell'),
  bat: legacy('powershell', 'powerShell'), ps1: legacy('powershell', 'powerShell'),
  pwsh: legacy('powershell', 'powerShell'),
  lua: legacy('lua', 'lua'), luau: legacy('lua', 'lua'), nse: legacy('lua', 'lua'),
  pl: legacy('perl', 'perl'), pm: legacy('perl', 'perl'), perl: legacy('perl', 'perl'),
  r: legacy('r', 'r'),
  swift: legacy('swift', 'swift'),
  clj: legacy('clojure', 'clojure'), cljs: legacy('clojure', 'clojure'),
  cljc: legacy('clojure', 'clojure'), edn: legacy('clojure', 'clojure'),
  hs: legacy('haskell', 'haskell'), lhs: legacy('haskell', 'haskell'),
  elm: legacy('elm', 'elm'),
  erl: legacy('erlang', 'erlang'), hrl: legacy('erlang', 'erlang'),
  lisp: legacy('commonlisp', 'commonLisp'), cl: legacy('commonlisp', 'commonLisp'),
  lsp: legacy('commonlisp', 'commonLisp'), el: legacy('commonlisp', 'commonLisp'),
  scm: legacy('scheme', 'scheme'), ss: legacy('scheme', 'scheme'),
  ocaml: legacy('mllike', 'oCaml'), ml: legacy('mllike', 'oCaml'),
  fs: legacy('mllike', 'fSharp'), fsharp: legacy('mllike', 'fSharp'),
  sml: legacy('mllike', 'sml'),
  pas: legacy('pascal', 'pascal'), pp: legacy('pascal', 'pascal'),
  p: legacy('pascal', 'pascal'), lpr: legacy('pascal', 'pascal'), dpr: legacy('pascal', 'pascal'),
  d: legacy('d', 'd'),
  f: legacy('fortran', 'fortran'), for: legacy('fortran', 'fortran'),
  f77: legacy('fortran', 'fortran'), f90: legacy('fortran', 'fortran'),
  f95: legacy('fortran', 'fortran'), f03: legacy('fortran', 'fortran'),
  f08: legacy('fortran', 'fortran'), fpp: legacy('fortran', 'fortran'), ftn: legacy('fortran', 'fortran'),
  v: legacy('verilog', 'verilog'), sv: legacy('verilog', 'verilog'), svh: legacy('verilog', 'verilog'),
  vhd: legacy('vhdl', 'vhdl'), vhdl: legacy('vhdl', 'vhdl'),
  asm: legacy('gas', 'gas'), s: legacy('gas', 'gas'), nasm: legacy('gas', 'gas'),
  cob: legacy('cobol', 'cobol'), cbl: legacy('cobol', 'cobol'), cobol: legacy('cobol', 'cobol'),
  cr: legacy('crystal', 'crystal'),
  groovy: legacy('groovy', 'groovy'), gradle: legacy('groovy', 'groovy'), gvy: legacy('groovy', 'groovy'),
  julia: legacy('julia', 'julia'), jl: legacy('julia', 'julia'),
  coffeescript: legacy('coffeescript', 'coffeeScript'), coffee: legacy('coffeescript', 'coffeeScript'),
  iced: legacy('coffeescript', 'coffeeScript'),
  tex: legacy('stex', 'stex'), sty: legacy('stex', 'stex'), cls: legacy('stex', 'stex'),
  bib: legacy('stex', 'stex'), stex: legacy('stex', 'stex'),
  tcl: legacy('tcl', 'tcl'), tclsh: legacy('tcl', 'tcl'),

  // ══ 标记 / 查询 / 文档 ══
  feature: legacy('gherkin', 'gherkin'),
  proto: legacy('protobuf', 'protobuf'),
  solr: legacy('solr', 'solr'),
  sparql: legacy('sparql', 'sparql'), rq: legacy('sparql', 'sparql'),
  ttl: legacy('turtle', 'turtle'),
  nt: legacy('ntriples', 'ntriples'),
  msc: legacy('mscgen', 'mscgen'),
  widl: legacy('webidl', 'webIDL'), webidl: legacy('webidl', 'webIDL'),
  idl: legacy('idl', 'idl'),
  xq: legacy('xquery', 'xQuery'), xql: legacy('xquery', 'xQuery'),
  xquery: legacy('xquery', 'xQuery'), xqy: legacy('xquery', 'xQuery'), xqm: legacy('xquery', 'xQuery'),

  // ══ 构建 / 运维 / DSL ══
  nsi: legacy('nsis', 'nsis'), nsh: legacy('nsis', 'nsis'),
  puppet: legacy('puppet', 'puppet'),
  vb: legacy('vb', 'vb'), vbs: legacy('vbscript', 'vbScript'),
  vm: legacy('velocity', 'velocity'),
  nginx: legacy('nginx', 'nginx'),
  rpm: legacy('rpm', 'rpmChanges'), spec: legacy('rpm', 'rpmSpec'),
  oz: legacy('oz', 'oz'),
  pig: legacy('pig', 'pig'),
  pegjs: legacy('pegjs', 'pegjs'), peg: legacy('pegjs', 'pegjs'),
  sas: legacy('sas', 'sas'),

  // ══ 函数式 / 学术 / 小众（legacy）══
  factor: legacy('factor', 'factor'),
  fcl: legacy('fcl', 'fcl'),
  forth: legacy('forth', 'forth'), frt: legacy('forth', 'forth'),
  dylan: legacy('dylan', 'dylan'), dyl: legacy('dylan', 'dylan'),
  ebnf: legacy('ebnf', 'ebnf'),
  ecl: legacy('ecl', 'ecl'),
  eiffel: legacy('eiffel', 'eiffel'), e: legacy('eiffel', 'eiffel'),
  haxe: legacy('haxe', 'haxe'), hxml: legacy('haxe', 'hxml'),
  http: legacy('http', 'http'),
  jinja: legacy('jinja2', 'jinja2'), j2: legacy('jinja2', 'jinja2'), jinja2: legacy('jinja2', 'jinja2'),
  livescript: legacy('livescript', 'liveScript'), ls: legacy('livescript', 'liveScript'),
  mathematica: legacy('mathematica', 'mathematica'), mma: legacy('mathematica', 'mathematica'),
  mbox: legacy('mbox', 'mbox'),
  mirc: legacy('mirc', 'mirc'), mrc: legacy('mirc', 'mirc'),
  modelica: legacy('modelica', 'modelica'), mo: legacy('modelica', 'modelica'),
  octave: legacy('octave', 'octave'),
  smalltalk: legacy('smalltalk', 'smalltalk'), st: legacy('smalltalk', 'smalltalk'),
  sieve: legacy('sieve', 'sieve'), siv: legacy('sieve', 'sieve'),
  textile: legacy('textile', 'textile'),
  tiddlywiki: legacy('tiddlywiki', 'tiddlyWiki'), tid: legacy('tiddlywiki', 'tiddlyWiki'),
  tiki: legacy('tiki', 'tiki'),
  troff: legacy('troff', 'troff'), roff: legacy('troff', 'troff'),
  ttcn: legacy('ttcn', 'ttcn'), ttcn3: legacy('ttcn', 'ttcn'), ttcnpp: legacy('ttcn-cfg', 'ttcnCfg'),
  wast: legacy('wast', 'wast'), wat: legacy('wast', 'wast'),
  yacas: legacy('yacas', 'yacas'),
  z80: legacy('z80', 'z80'),

  // ══ 编码 / 协议 / 杂项（legacy）══
  apl: legacy('apl', 'apl'),
  asn: legacy('asn1', 'asn1'), asn1: legacy('asn1', 'asn1'),
  asc: legacy('asciiarmor', 'asciiArmor'),
  asterisk: legacy('asterisk', 'asterisk'),
  brainfuck: legacy('brainfuck', 'brainfuck'), bf: legacy('brainfuck', 'brainfuck'),
  cypher: legacy('cypher', 'cypher'), cql: legacy('cypher', 'cypher'),
  dtd: legacy('dtd', 'dtd'),
};

/** 取扩展名对应的语言扩展；无映射或加载失败返回空数组（纯文本兜底） */
export async function buildLanguageExtensions(ext: string): Promise<Extension[]> {
  const loader = loaders[ext.toLowerCase()];
  if (!loader) return [];
  try {
    return await loader();
  } catch (err) {
    console.warn(`[codeLanguage] 语言包加载失败: .${ext}`, err);
    return [];
  }
}
