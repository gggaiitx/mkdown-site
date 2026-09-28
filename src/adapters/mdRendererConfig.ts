/**
 * ★ 全局 markdown-it 渲染钩子（md-editor-v3 v7 config，全局只注册一次）。
 *
 * 背景：v7 的 transformImgUrl 只作用于「粘贴图片链接文本」，渲染 <img> 时不调用；
 * 文档里的相对路径图片（./assets/x.png）会被 WebView 解析到 dev server 404。
 * 因此在 markdown-it 的 image 规则里统一做相对路径 → asset:// 的转换。
 *
 * 当前文档目录由引擎通过 setCurrentDocDir 注入（sync watch，保证渲染前已更新）。
 */
import { config } from 'md-editor-v3';
import { convertFileSrc } from '@tauri-apps/api/core';
import mermaid from 'mermaid';
import katex from 'katex';
// v7 传 katex.instance 后不再注入 CDN 样式（index4.mjs 仅在无 instance 时注入），
// 字体随包内 css 相对路径由 Vite 打进产物，CSP font-src 'self' 已放行
import 'katex/dist/katex.min.css';

import { mkFindExtension } from './findHighlight';

let currentDocDir = '';

export function setCurrentDocDir(dir: string): void {
  currentDocDir = dir ?? '';
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
  const abs = `${currentDocDir}\\${rel.replaceAll('/', '\\')}`;
  return convertFileSrc(abs);
}

let configured = false;

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
      mermaid: { instance: mermaid },
      katex: { instance: katex },
    },
    markdownItConfig(md) {
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
    // ---- CM6 扩展注入：文件内查找关键词高亮（编辑/分栏态） ----
    codeMirrorExtensions(extensions) {
      return [...extensions, { type: 'mk-find-highlight', extension: mkFindExtension }];
    },
  });
}

/**
 * ★ 模块导入即注册（不能等引擎 onMounted）：Vue 子组件先于父组件 onMounted 执行，
 * MdEditor 首个实例在 setup 阶段就读取全局 config——注册晚了会漏掉首个编辑器的
 * data-line 规则与 CM6 查找高亮扩展（时序 bug 曾致首挂编辑态高亮全失效）。
 */
setupMdRenderer();
