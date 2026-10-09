/**
 * ★ 代码语言包按需加载（扩展名 → CM6 LanguageSupport）。
 * 所有 import 必须动态：语言包（含 legacy-modes）不得进首屏 chunk（架构 D4）。
 * 扩展名集合与 Rust 侧 TEXT_EXTS 的代码集对齐；c/cpp 等嗅探兜底文件同样覆盖。
 *
 * 类型说明：@codemirror/legacy-modes 的 StreamParser 源自 @codemirror/streamparser，
 * 与 @codemirror/language 内置 StringStream 的私有 tabSize 声明存在**名义类型**差异
 * （运行时为同一结构，扁平安装下版本交叉所致），经 defineLegacy 统一断言收口。
 */
import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

type LangLoader = () => Promise<Extension[]>;

/** legacy StreamLanguage 定义收口：断言 streamparser 名义类型 → language 运行时类型 */
function defineLegacy(parser: unknown) {
  return StreamLanguage.define(parser as Parameters<typeof StreamLanguage.define>[0]);
}

const jsLoader: LangLoader = async () => [(await import('@codemirror/lang-javascript')).javascript({ jsx: true })];
const tsLoader: LangLoader = async () => [(await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })];
const jsonLoader: LangLoader = async () => [(await import('@codemirror/lang-json')).json()];
const htmlLoader: LangLoader = async () => [(await import('@codemirror/lang-html')).html()];
const cssLoader: LangLoader = async () => [(await import('@codemirror/lang-css')).css()];
const xmlLoader: LangLoader = async () => [defineLegacy((await import('@codemirror/legacy-modes/mode/xml')).xml)];
const ps1Loader: LangLoader = async () => [defineLegacy((await import('@codemirror/legacy-modes/mode/powershell')).powerShell)];
const propertiesLoader: LangLoader = async () => [defineLegacy((await import('@codemirror/legacy-modes/mode/properties')).properties)];

const loaders: Record<string, LangLoader> = {
  // JavaScript / TypeScript
  js: jsLoader,
  mjs: jsLoader,
  cjs: jsLoader,
  jsx: jsLoader,
  ts: tsLoader,
  tsx: tsLoader,
  // JSON
  json: jsonLoader,
  jsonc: jsonLoader,
  json5: jsonLoader,
  // Web 标记（vue/svelte 为最佳努力降级）
  html: htmlLoader,
  htm: htmlLoader,
  vue: htmlLoader,
  svelte: htmlLoader,
  xml: xmlLoader,
  xsd: xmlLoader,
  xsl: xmlLoader,
  svg: xmlLoader, // SVG 是 XML 方言，用 legacy xml 高亮
  // 样式（scss/less/sass 用 css 高亮近似）
  css: cssLoader,
  scss: cssLoader,
  less: cssLoader,
  sass: cssLoader,
  // 后端/脚本
  py: async () => [(await import('@codemirror/lang-python')).python()],
  rs: async () => [(await import('@codemirror/lang-rust')).rust()],
  java: async () => [(await import('@codemirror/lang-java')).java()],
  sql: async () => [(await import('@codemirror/lang-sql')).sql()],
  yaml: async () => [(await import('@codemirror/lang-yaml')).yaml()],
  yml: async () => [(await import('@codemirror/lang-yaml')).yaml()],
  // C 系（TEXT_EXTS 无此项，靠嗅探兜底进编辑器）
  c: async () => [(await import('@codemirror/lang-cpp')).cpp()],
  h: async () => [(await import('@codemirror/lang-cpp')).cpp()],
  cpp: async () => [(await import('@codemirror/lang-cpp')).cpp()],
  hpp: async () => [(await import('@codemirror/lang-cpp')).cpp()],
  cc: async () => [(await import('@codemirror/lang-cpp')).cpp()],
  // legacy StreamLanguage（无官方语言包的轻量语法）
  go: async () => [defineLegacy((await import('@codemirror/legacy-modes/mode/go')).go)],
  rb: async () => [defineLegacy((await import('@codemirror/legacy-modes/mode/ruby')).ruby)],
  sh: async () => [defineLegacy((await import('@codemirror/legacy-modes/mode/shell')).shell)],
  bat: ps1Loader,
  ps1: ps1Loader,
  toml: async () => [defineLegacy((await import('@codemirror/legacy-modes/mode/toml')).toml)],
  ini: propertiesLoader,
  cfg: propertiesLoader,
  conf: propertiesLoader,
  properties: propertiesLoader,
  env: propertiesLoader,
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
