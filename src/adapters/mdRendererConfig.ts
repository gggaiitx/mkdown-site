/**
 * ★ 全局 markdown-it 渲染钩子（md-editor-v3 v7 config，全局只注册一次）。
 *
 * 背景：v7 的 transformImgUrl 只作用于「粘贴图片链接文本」，渲染 <img> 时不调用；
 * 文档里的相对路径图片（./assets/x.png）会被 WebView 解析到 dev server 404。
 * 因此在 markdown-it 的 image 规则里统一做相对路径 → asset:// 的转换。
 *
 * 当前文档目录由引擎通过 setCurrentDocDir 注入（sync watch，保证渲染前已更新）。
 */
import { config, en_US, zh_CN } from 'md-editor-v3';
import { convertFileSrc } from '@tauri-apps/api/core';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import katex from 'katex';
// v7 传 katex.instance 后不再注入 CDN 样式（index4.mjs 仅在无 instance 时注入），
// 字体随包内 css 相对路径由 Vite 打进产物，CSP font-src 'self' 已放行
import 'katex/dist/katex.min.css';
// mhchem 扩展：注册 \ce{...}/\pu{...} 化学式宏（Tier 1）。副作用 import 注册在 katex
// 模块单例上，下方 instance: katex 传的是同一实例，故对内核渲染生效（实测：不注册则
// \ce 以红色 mathcolor=#cc0000 输出）。
import 'katex/contrib/mhchem';

// ---- KaTeX 兼容增强（Tier 1，对齐 axiu.xyz 渲染口径）----
// 差距根因：内核调 katex.renderToString(content, { throwOnError:!1, displayMode })
// （index4.mjs:1020），strict 走 KaTeX 默认(warn)——test3.md 的 \ce / \tag{\cfrac} /
// \begin{array}{1} / 私有区粘贴字符(U+F8FD) 等均退化成红色错误文本（axiu 同款文档可正常
// 渲染的差距即在此）。本段补齐三件事：
//   ① mhchem 注册（见上方 import）；
//   ② strict:'ignore' 容忍严格性错误（在下方 config 的 katexConfig 注入）；
//   ③ 包一层 renderToString 做「仅显示」级 legacy 归一——绝不写回编辑器/保存的文档
//      （对齐 axiu markdown-compatibility.js 的注释约定）。
//
// normalizeFormulaForDisplay 对齐 axiu 的 normalizeLegacyFormula，但刻意**不做**双重反斜杠
// 折叠(\\{2,}→\)：无 legacyCommands 复制标记时会误伤矩阵/对齐的行分隔 \\（test3.md 的
// 13 处四连反斜杠留待 Tier 2 MathJax 回退评估）。
// 实测（scripts 探针，katex 0.18.5）：\tag{\cfrac}、array}{1}、U+F8FD 均因此由 ERR→ok，
// 且矩阵 \\、\\[2pt]、合法 array{ll} 不受影响；对已归一文本二次应用是幂等的。
function normalizeFormulaForDisplay(expression: string): string {
  return String(expression)
    // 私有使用区粘贴字符（test3.md 的 63 个 U+F8FD）→ 空格：KaTeX 对数学模式内的私区区
    // 字符直接抛错变红，替换为空格后正常渲染（公式内空白本就被 KaTeX 忽略）
    .replace(/[\uE000-\uF8FF]/g, ' ')
    // \begin{array}{1} 的列规格 "{1}" 非法 → {ll}
    .replace(/\\begin\{array\}\{1\}/g, '\\begin{array}{ll}')
    // \cfrac/\frac 不能作 \tag 标签（strict:'ignore' 也修不好）→ 还原为字面文本，对齐 axiu
    .replace(/\\tag\{\\(c?frac)\}/g, '\\tag{\\text{\\textbackslash $1}}');
}

// 包裹 katex.renderToString：内核每次渲染都动态调用 t.value.renderToString，故包一次即对
// 预览/阅读/导出全链路生效；委托回原 renderToString，mhchem 等注册态不受影响。
// 实测 katex.renderToString 属性 writable=true/configurable=true，猴子补丁安全。
const katexPatchTarget = katex as { renderToString: typeof katex.renderToString };
const katexRenderRaw = katex.renderToString.bind(katex);
katexPatchTarget.renderToString = (expression, options): string =>
  katexRenderRaw(normalizeFormulaForDisplay(expression), options);

// ---- highlight.js 本地实例：md 预览代码块高亮（桌面离线渲染）----
// v7 默认从 unpkg CDN 注入 hljs script + github 主题 link（内核 es/chunks/index4.mjs
// 的 useHighlight：editorExtensions.highlight.instance 为空时注入，onload 后取
// window.hljs），桌面离线/弱网即代码块无着色。此处静态注册本地实例（版本锚定
// 内核 CDN 同款 @highlightjs/cdn-assets@11.12.0），内核检测到 instance 后跳过
// 全部 CDN 注入（连主题 link 也不再注入——token 配色改由 global.css 双主题自管）。
// 渲染调用点（index4.mjs useHighlight 消费处）：getLanguage(fence 语言) 命中走
// highlight(language)，否则 highlightAuto 兜底；语言文件均为纯函数、无静态依赖，
// 注册顺序任意。core 版按需注册控制体积，未注册语言由 highlightAuto 兜底仍有色。
// 注意 hljs 11.12 无独立 html/mysql 模块：html/xhtml/rss/atom/svg 等均为 xml 的
// 别名（注册 xml 即覆盖），mysql 无别名（sql fence 命中、mysql fence 走兜底）。
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import scala from 'highlight.js/lib/languages/scala';
import objectivec from 'highlight.js/lib/languages/objectivec';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import makefile from 'highlight.js/lib/languages/makefile';
import diff from 'highlight.js/lib/languages/diff';
import markdownLang from 'highlight.js/lib/languages/markdown';
import http from 'highlight.js/lib/languages/http';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import less from 'highlight.js/lib/languages/less';
import scss from 'highlight.js/lib/languages/scss';
import lua from 'highlight.js/lib/languages/lua';
import perl from 'highlight.js/lib/languages/perl';
import r from 'highlight.js/lib/languages/r';
import matlab from 'highlight.js/lib/languages/matlab';
import dart from 'highlight.js/lib/languages/dart';
import fsharp from 'highlight.js/lib/languages/fsharp';
import clojure from 'highlight.js/lib/languages/clojure';
import erlang from 'highlight.js/lib/languages/erlang';
import elixir from 'highlight.js/lib/languages/elixir';
import haskell from 'highlight.js/lib/languages/haskell';
import julia from 'highlight.js/lib/languages/julia';
import graphql from 'highlight.js/lib/languages/graphql';
import nginx from 'highlight.js/lib/languages/nginx';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import plaintext from 'highlight.js/lib/languages/plaintext';
import vbnet from 'highlight.js/lib/languages/vbnet';
import coffeescript from 'highlight.js/lib/languages/coffeescript';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('scala', scala);
hljs.registerLanguage('objectivec', objectivec);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('makefile', makefile);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('http', http);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('less', less);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('perl', perl);
hljs.registerLanguage('r', r);
hljs.registerLanguage('matlab', matlab);
hljs.registerLanguage('dart', dart);
hljs.registerLanguage('fsharp', fsharp);
hljs.registerLanguage('clojure', clojure);
hljs.registerLanguage('erlang', erlang);
hljs.registerLanguage('elixir', elixir);
hljs.registerLanguage('haskell', haskell);
hljs.registerLanguage('julia', julia);
hljs.registerLanguage('graphql', graphql);
hljs.registerLanguage('nginx', nginx);
hljs.registerLanguage('properties', properties);
hljs.registerLanguage('protobuf', protobuf);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('vbnet', vbnet);
hljs.registerLanguage('coffeescript', coffeescript);

import { mkFindExtension } from './findHighlight';
import { headingLineExtension } from './cmHeadingLine';
import { focusLineExtension } from './cmFocusLine';
import { lineNumberAttrExtension } from './cmLineNumber';
import { isMac } from '../utils/keyHint';
import { joinRelPath } from '../utils/pathJoin';

let currentDocDir = '';

export function setCurrentDocDir(dir: string): void {
  currentDocDir = dir ?? '';
}

/**
 * 导出管线专用 mermaid 渲染（无 foreignObject，可光栅化）。
 *
 * 背景（2026-10-13 实测）：mermaid 11 默认配置渲染的 svg 含 <foreignObject>（节点标签），
 * Chromium 对含 foreignObject 的 svg 图片一律污染画布 → PNG 光栅化必然失败（docxImagefy.ts
 * 首部有同款实测结论）。且实测单独 flowchart.htmlLabels:false 不够——子图/节点标签的 FO 由
 * 顶层 htmlLabels 控制，须「顶层 htmlLabels:false + flowchart.htmlLabels:false +
 * markdownAutoWrap:false」三者齐备才产出纯 svg 文本标签的可光栅化 svg。
 *
 * 另一内核事实：md-editor 的 mermaid 渲染结果按源文本缓存在模块级 LRU（10min TTL），
 * 且缓存命中时**不做节点替换**——主预览渲染过的图表，导出宿主内永远是源码 div，
 * 等待多久都没用，必须自行渲染（见 MdEditorV3Engine.replaceExportMermaid）。
 *
 * 本函数以「白底浅色（与内核 light 口径一致，导出宿主恒 light）+ 无 FO」配置渲染单个图表，
 * 渲染前后 getConfig()/initialize() 保存恢复内核配置，不影响主预览外观。失败返回 null。
 */
const MERMAID_EXPORT_THEME_VARS = {
  background: '#ffffff',
  primaryColor: '#ffffff',
  primaryTextColor: '#1f2329',
  primaryBorderColor: '#b7c0cc',
  secondaryColor: '#f7f8fa',
  tertiaryColor: '#f7f8fa',
  lineColor: '#596273',
  edgeLabelBackground: '#ffffff',
  clusterBkg: '#ffffff',
  clusterBorder: '#b7c0cc',
};
let mermaidRenderSeq = 0;
/** 运行时 mermaid 单例带 getConfig（类型未声明），用于渲染前后保存/恢复内核配置 */
const mermaidWithGetConfig = mermaid as typeof mermaid & {
  getConfig?: () => Record<string, unknown>;
};

export async function renderMermaidSvg(source: string): Promise<string | null> {
  const prev = mermaidWithGetConfig.getConfig?.();
  try {
    const cfg = {
      startOnLoad: false,
      theme: 'base',
      htmlLabels: false,
      markdownAutoWrap: false,
      flowchart: { htmlLabels: false },
      themeVariables: MERMAID_EXPORT_THEME_VARS,
    };
    mermaid.initialize(cfg as Parameters<typeof mermaid.initialize>[0]);
    const id = `mk-export-mermaid-${++mermaidRenderSeq}-${Date.now().toString(36)}`;
    const { svg } = await mermaid.render(id, source);
    return svg;
  } catch {
    return null; // 语法错误等渲染失败：交由调用方保留源码（D9 降级）
  } finally {
    if (prev) {
      try {
        mermaid.initialize(prev as Parameters<typeof mermaid.initialize>[0]);
      } catch {
        /* 配置恢复失败不致命（下次主题切换内核会重初始化） */
      }
    }
  }
}

function toAssetUrl(src: string): string {
  const raw = (src ?? '').trim();
  if (!currentDocDir) return raw;
  if (/^(https?|data|asset|blob):/i.test(raw) || raw.startsWith('/') || raw.startsWith('#')) {
    return raw;
  }
  // 去掉查询/锚点后再拼目录
  const rel = raw.replace(/^\.\//, '').split('#')[0].split('?')[0];
  if (!rel) return raw;
  // 分隔符按 currentDocDir 的形态决定（Windows `\` / mac-Linux `/`），
  // 写死 `\` 在 mac 上会把整条相对路径拼成一个文件名，图片直接 404
  return convertFileSrc(joinRelPath(currentDocDir, rel));
}

/**
 * ★ 原生 HTML 混排渲染（README / 官网文档常见写法）的支持层。
 *
 * 差距根因：内核创建 markdown-it 实例时硬编码 `html: false`（es/chunks/index4.mjs:1113，
 * 源码注释「关闭源文本中的原生 HTML 解析」）。于是 <div align="center">、<table>、
 * <details>、<img width=…> 这类与 markdown 混排的原始 HTML 会被整体转义成文本，
 * 预览/阅读里只剩一堆尖括号。
 *
 * 修法：在内核的 markdownItConfig 回调里（每个 md 实例建好后立即调用一次，随后不再
 * 改 options）用 md.set 打开 html，使原生 HTML 直通「编辑内预览 / 分栏 / 阅读 /
 * 打印导出」全部渲染路径——这四条链路共用同一套 md 实例工厂。
 *
 * 打开后必须自带净化：html:true 会把 <script>、on* 属性原样交给 v-html。WebView 侧
 * CSP（script-src 'self'，无 'unsafe-inline'）已能拦住内联脚本，但这里是纵深防御，
 * 且 README 多来自第三方仓库。DOMPurify 采用 html + svg + mathMl 三档 profile——
 * 默认 profile 只保留 html，会把 KaTeX 的 <math> 层剥掉（视觉层 katex-html 尚存，
 * 但公式的可访问性/复制口径会退化）。
 *
 * 相对路径图片：原生 HTML 里的 <img> 不经过 markdown-it 的 image 规则（那是 token 级
 * 渲染，见上方注释），只能在这一层统一改写成 asset://，否则 WebView 会把
 * 「docs/public/x.png」按 dev server 根解析成 404。已在 image 规则里转过的值再转一次
 * 是幂等的（asset: 前缀直接放行）。
 */
let purifyHookReady = false;
function sanitizeMixedHtml(html: string): string {
  if (!purifyHookReady) {
    purifyHookReady = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeName !== 'IMG') return;
      const src = node.getAttribute('src');
      if (!src) return;
      const url = toAssetUrl(src);
      if (url !== src) node.setAttribute('src', url);
    });
  }
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    // 表格居中/宽度一类 presentational 属性不在 DOMPurify 默认白名单里，
    // GitHub 系 README 大量使用（align="center"、valign="middle"）
    ADD_ATTR: ['align', 'valign', 'target'],
  });
}

let configured = false;

/**
 * 中文语言包覆盖：功能栏 hover 提示（原生 title）追加实际绑定的快捷键。
 * 快捷键来源必须与实际行为严格同步——
 * - 内核 CM6 keymap：Mod+B/I/U/1~6、Mod+Shift+C/S/U、Alt+Mod+C、Alt+Shift+Mod+T、Mod+Z/Y、Mod+S
 *   （Mod 在 Mac=⌘、其他=Ctrl，见 utils/keyHint）；
 * - 应用层（Workbench.onKeydown）：Mod+K 链接、Mod+Shift+I 图片、F11 页面全屏（内核是 pageFullscreen）；
 * - 不标注实际不可用的项（如 orderedList 的 Mod+O 被应用层「打开文件」抢占）。
 * 语言包走 languageUserDefined 整体 deepMerge（内核内部合并基准是 en-US，必须 spread 完整 zh_CN，
 * 否则未覆盖的顶层键会回退成英文）。
 * 平台化：模块加载时按 isMac 一次性取符号（⌘/⌥/⇧ 或 Ctrl/Alt/Shift），语言切换重挂载不受影响。
 */
/** Mac 符号键位（Apple HIG 顺序：⌥ ⇧ ⌘） */
const zhTipsMac = {
  bold: '加粗 ⌘B', underline: '下划线 ⌘U', italic: '斜体 ⌘I', strikeThrough: '删除线 ⇧⌘S',
  title: '标题 ⌘1~6', sup: '上标 ⌘↑', sub: '下标 ⌘↓', unorderedList: '无序列表 ⇧⌘U',
  codeRow: '行内代码 ⌥⌘C', code: '块级代码 ⇧⌘C', link: '链接 ⌘K', image: '图片 ⇧⌘I',
  table: '表格 ⌥⇧⌘T', revoke: '后退 ⌘Z', next: '前进 ⌘Y', save: '保存 ⌘S', pageFullscreen: '页面全屏 F11',
};
const zhTipsWin = {
  bold: '加粗 Ctrl+B', underline: '下划线 Ctrl+U', italic: '斜体 Ctrl+I', strikeThrough: '删除线 Ctrl+Shift+S',
  title: '标题 Ctrl+1~6', sup: '上标 Ctrl+↑', sub: '下标 Ctrl+↓', unorderedList: '无序列表 Ctrl+Shift+U',
  codeRow: '行内代码 Ctrl+Alt+C', code: '块级代码 Ctrl+Shift+C', link: '链接 Ctrl+K', image: '图片 Ctrl+Shift+I',
  table: '表格 Ctrl+Alt+Shift+T', revoke: '后退 Ctrl+Z', next: '前进 Ctrl+Y', save: '保存 Ctrl+S', pageFullscreen: '页面全屏 F11',
};
const enTipsMac = {
  bold: 'Bold ⌘B', underline: 'Underline ⌘U', italic: 'Italic ⌘I', strikeThrough: 'Strikethrough ⇧⌘S',
  title: 'Heading ⌘1~6', sup: 'Superscript ⌘↑', sub: 'Subscript ⌘↓', unorderedList: 'Bullet list ⇧⌘U',
  codeRow: 'Inline code ⌥⌘C', code: 'Code block ⇧⌘C', link: 'Link ⌘K', image: 'Image ⇧⌘I',
  table: 'Table ⌥⇧⌘T', revoke: 'Undo ⌘Z', next: 'Redo ⌘Y', save: 'Save ⌘S', pageFullscreen: 'Page fullscreen F11',
};
const enTipsWin = {
  bold: 'Bold Ctrl+B', underline: 'Underline Ctrl+U', italic: 'Italic Ctrl+I', strikeThrough: 'Strikethrough Ctrl+Shift+S',
  title: 'Heading Ctrl+1~6', sup: 'Superscript Ctrl+↑', sub: 'Subscript Ctrl+↓', unorderedList: 'Bullet list Ctrl+Shift+U',
  codeRow: 'Inline code Ctrl+Alt+C', code: 'Code block Ctrl+Shift+C', link: 'Link Ctrl+K', image: 'Image Ctrl+Shift+I',
  table: 'Table Ctrl+Alt+Shift+T', revoke: 'Undo Ctrl+Z', next: 'Redo Ctrl+Y', save: 'Save Ctrl+S', pageFullscreen: 'Page fullscreen F11',
};

const zhWithShortcuts = {
  'zh-CN': {
    ...zh_CN,
    toolbarTips: { ...zh_CN.toolbarTips, ...(isMac ? zhTipsMac : zhTipsWin) },
  },
};

/** 英文语言包（内核内置 en-US 基础上同样合并快捷键提示，见上注释） */
const enWithShortcuts = {
  'en-US': {
    ...en_US,
    toolbarTips: { ...en_US.toolbarTips, ...(isMac ? enTipsMac : enTipsWin) },
  },
};

export function setupMdRenderer(): void {
  if (configured) return;
  configured = true;
  config({
    // ---- mermaid / katex 本地实例：桌面离线渲染 ----
    // v7 默认运行时从 unpkg.com CDN 加载渲染器（es/chunks/config.mjs 硬编码），
    // 桌面应用离线即失效；instance 直传后内核跳过 CDN 注入。
    // 版本锚定内核 CDN 同款：mermaid 11.17.2 / katex 0.18.5。
    // 注意：config() 每次调用都是「默认值 deepMerge 传入项」，不累积——
    // 所有自定义必须并入这一次调用，禁止在别处二次调用 config()。
    editorExtensions: {
      // hljs 本地实例（同上）：内核检测到 instance 即跳过 unpkg CDN 的
      // script + github 主题 link 注入，代码块高亮离线可用
      highlight: { instance: hljs },
      mermaid: { instance: mermaid },
      katex: { instance: katex },
    },
    // ---- KaTeX 渲染选项（顶层 config 项，内核 index4.mjs:1020 以 P.katexConfig 消费）----
    // 注意：katexConfig 是 config() 的**顶层**选项（与 editorExtensions/editorConfig 同级，
    // 见 md-editor-v3 types index.d.ts:1139 与 config.mjs:1270 默认恒等），不是
    // editorExtensions.katex 的子字段（后者 TS 类型仅 {instance,js,css}）。
    // strict:'ignore' 容忍严格性错误（内核默认 strict=warn，会把 \tag{\cfrac} 等判红）；
    // throwOnError/displayMode 由内核传入，此处只做增量合并。maxExpand/trust 对齐 axiu。
    katexConfig: (base) => ({ ...base, strict: 'ignore', maxExpand: 1000, trust: false }),
    // ---- 功能栏提示带快捷键（见 zhWithShortcuts 注释）；中英双语由设置语言选择 ----
    editorConfig: {
      languageUserDefined: { ...zhWithShortcuts, ...enWithShortcuts },
    },
    markdownItConfig(md) {
      // ---- 混排 HTML 直通（详见 sanitizeMixedHtml 注释）----
      // 必须在本回调内 set：内核 `st({html:false,…})` 之后紧接着回调本函数，
      // 此后不再改动 options，是唯一可覆盖 html 语义的时机。
      md.set({ html: true });
      const renderBase = md.render.bind(md) as (
        src: string,
        env?: Record<string, unknown>,
      ) => string;
      md.render = ((src: string, env?: Record<string, unknown>) => {
        const html = renderBase(src, env);
        return env?.__mkRawHtml === true ? sanitizeMixedHtml(html) : html;
      }) as typeof md.render;

      const defaultImage =
        md.renderer.rules.image ??
        ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.image = (tokens, idx, options, _env, self) => {
        const token = tokens[idx];
        const src = token.attrGet('src');
        if (src) {
          const url = toAssetUrl(src);
          if (url !== src) token.attrSet('src', url);
        }
        return defaultImage(tokens, idx, options, _env, self);
      };

      // ---- 原生 HTML 探测：只有真出现 raw HTML token 才走 DOMPurify ----
      // 纯 markdown 文档（含 KaTeX/mermaid）不做 DOM 解析开销；代码块里的 <div>
      // 属于 fence token，不会误判。env 逐次渲染由内核新建，这里仍先复位，避免
      // 复用的 env 把上一份文档的结论带进来。
      //
      // ★ 必须挂在 'inline' **之后**：core 规则顺序是
      //   normalize → block → inline → linkify → replacements → smartquotes → text_join，
      //   在 block 之后 inline 尚未解析，inline token 的 children 还是 null，
      //   html_inline（`正文里 <img onerror=…>` 这种行内原生 HTML）永远扫不到 →
      //   整份输出跳过 DOMPurify，白名单净化形同虚设。挂在 inline 之后两者都命中，
      //   纯 md 文档仍判 false（不付净化开销）。
      md.core.ruler.after('inline', 'mk_raw_html_flag', (state) => {
        const env = (state.env ??= {}) as { __mkRawHtml?: boolean };
        env.__mkRawHtml = false;
        for (const token of state.tokens) {
          if (token.type === 'html_block') {
            env.__mkRawHtml = true;
            break;
          }
          if (
            token.type === 'inline' &&
            token.children?.some((child) => child.type === 'html_inline')
          ) {
            env.__mkRawHtml = true;
            break;
          }
        }
        return true;
      });

      // ---- 源码行号标记（data-line）：预览/阅读态跳转定位的行级锚点 ----
      // markdown-it 块级 token 自带 map: [起始行, 结束行)（0-based），
      // 转成 1-based 写到块级开标签上；编辑器内部的 html 预览与 MdPreview 共用。
      md.core.ruler.after('block', 'mk_data_line', (state) => {
        for (const t of state.tokens) {
          if (t.map && t.tag && t.nesting === 1) {
            t.attrSet('data-line', String(t.map[0] + 1));
          }
        }
      });
    },
    // ---- CM6 扩展注入：文件内查找关键词高亮 + # 标题行装饰 + 专注模式淡出（编辑/分栏态） ----
    codeMirrorExtensions(extensions) {
      return [
        ...extensions,
        { type: 'mk-find-highlight', extension: mkFindExtension },
        { type: 'mk-heading-line', extension: headingLineExtension },
        { type: 'mk-focus-line', extension: focusLineExtension },
        { type: 'mk-line-number-attr', extension: lineNumberAttrExtension },
      ];
    },
  });
}

/**
 * ★ 模块导入即注册（不能等引擎 onMounted）：Vue 子组件先于父组件 onMounted 执行，
 * MdEditor 首个实例在 setup 阶段就读取全局 config——注册晚了会漏掉首个编辑器的
 * data-line 规则与 CM6 查找高亮扩展（时序 bug 曾致首挂编辑态高亮全失效）。
 */
setupMdRenderer();
