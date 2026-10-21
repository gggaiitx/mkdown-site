<script setup lang="ts">
/**
 * HTML 预览框架：源码落盘 $APPCONFIG/preview，再用 asset 协议 URL 加载进 iframe。
 *
 * 为什么不再用 iframe srcdoc：srcdoc 文档继承主窗口的 policy container
 * （CSP `script-src 'self'`），页面自带的脚本一律静默不跑——滚动入场、轮播、
 * 折叠面板这类全靠 JS 的页面会整片停在 opacity:0。只有真实 URL 加载才有独立
 * policy container，而 asset 协议的响应不带 CSP 头。
 * ★ 配套前提：tauri.conf.json 的 CSP 必须有 `frame-src 'self' asset: http://asset.localhost`。
 *   缺它时 iframe 回落到 `default-src 'self'`，asset.localhost 属跨源，整个框架被拦成
 *   "已阻止此内容"。这条只在**打包后的产物**里暴露——dev 走 vite 那份 index.html，
 *   Tauri 的 CSP 是打包时才注进 HTML 的，dev 下根本没有这条策略（v0.6.1 就是这么翻车的）。
 *
 * 安全边界（预览的是磁盘上任意一份 HTML，按不可信内容对待）：
 * - sandbox 只给 allow-scripts，不给 allow-same-origin → 文档落在 opaque origin：
 *   读不到本应用 DOM、没有 cookie / localStorage、带不走 asset scope；
 * - 也不给 allow-forms / allow-popups / allow-top-navigation → 不能提交表单、
 *   开新窗口或把预览面板导航走；
 * - 主窗口自己的 CSP 一个字没放松，页面再怎么折腾也回不到应用上下文。
 *
 * 注入两样东西，都排在页面自身内容之前（页面自带 CSP 也拦不到它们）：
 * - <base href=asset://原文档目录/>：相对路径的图片 / CSS 仍指向原文档所在目录；
 * - 缩放桥脚本：收 parent 的 {mkZoom} 置 documentElement 的 zoom（同浏览器
 *   Ctrl+滚轮语义，改档不重载、不重新落盘）；就绪回 {mkReady} 让本层补发当前档，
 *   首帧画完回 {mkPaint} 放行淡入——iframe 挂上时会先铺一层白再画页面，
 *   从编辑切过来就是白屏一晃，遮到回执为止再 0.18s 淡进。
 * 滚动交给页面自己（iframe 恒等于面板尺寸）。早先按「内容 scrollHeight」撑盒、由外层
 * stage 统一滚，有两个坑：documentElement.scrollHeight 以盒高为下限，早期一次超测
 * （CSS 还没就位）就把盒锁死缩不回来，文档结尾拖出一长段空白；而几千 px 高的 iframe
 * 被外层拖着滚，WebView2 来不及光栅化就闪白。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { convertFileSrc } from '@tauri-apps/api/core';

import OpenSystemBtn from './OpenSystemBtn.vue';
import PreviewZoomBar from './PreviewZoomBar.vue';
import { scrollbarCss as buildScrollbarCss } from './scrollbarStyle';
import { deletePreviewDoc, writePreviewDoc } from '../../api/previewApi';
import type { EditorCtxPayload } from '../../adapters/IMarkdownEngine';
import { useI18n } from '../../i18n';

const { t } = useI18n();

/** 预览窗格里的右键：帧内原生菜单已被注入脚本吃掉，改由上层弹应用菜单（刷新 / 全屏 / 调试） */
const emit = defineEmits<{ (e: 'editorContext', pos: EditorCtxPayload): void }>();

const props = defineProps<{
  /** HTML 源码 */
  content: string;
  /** 文档所在目录（相对资源解析基准），null/空 = 不注入 base */
  dir: string | null;
  /** 文件完整路径（工具栏"系统打开"按钮 + 预览临时文件名用），null = 不显示按钮 */
  path?: string | null;
  /** 应用暗色主题：决定注入 iframe 的滚动条配色 */
  dark?: boolean;
}>();

const zoom = ref(100);

const iframeRef = ref<HTMLIFrameElement | null>(null);

/** 缩放走 postMessage 让页面自己置 zoom：跨域读不到 contentDocument，且改档只需
 *  一条消息，不必重新落盘、也不必重载 iframe */
function pushZoom() {
  iframeRef.value?.contentWindow?.postMessage({ mkZoom: Math.max(0.1, zoom.value / 100) }, '*');
}
watch(zoom, pushZoom);

const frameUrl = ref('');
/** 落盘失败时的退路：退回 srcdoc 静态渲染（脚本不跑，但内容还在） */
const fallbackSrcdoc = ref<string | null>(null);

/** 注入文档的滚动条样式：与 global.css 那段全局规则同款（含标准属性复位） */
const scrollbarCss = computed(() => buildScrollbarCss(!!props.dark));

/** 缩放桥：收 {mkZoom} 置根元素 zoom；就绪回 {mkReady}（让上层补发当前档）、
 *  首帧画完回 {mkPaint}（让上层淡入，见 painted）。
 *  顺带在捕获阶段吃掉 contextmenu 并把点击位置回报给父页：沙箱里右键弹的是浏览器原生菜单
 *  （重新加载 / 查看网页源代码 / 图片另存为），与应用菜单无关且干扰阅读，一律禁掉；
 *  禁掉之后由父页在同一处弹应用菜单（刷新 / 全屏 / 调试）。
 *  ★ 只能靠注入脚本做：沙箱给 allow-scripts 而不给 allow-same-origin，文档落在
 *    opaque origin 上，父页读不到它的 contentDocument，连监听都挂不上，回报也只有一条 postMessage。
 *  字符串里的 <\/script> 是 SFC 解析需要 */
const probeScript =
  '<script data-mk-preview>(function(){var h=document.documentElement;' +
  'addEventListener("message",function(e){var d=e.data;' +
  'if(d&&d.mkZoom)h.style.setProperty("zoom",d.mkZoom,"important")});' +
  'addEventListener("contextmenu",function(e){e.preventDefault();' +
  'parent.postMessage({mkCtx:1,x:e.clientX,y:e.clientY},"*")},!0);' +
  'parent.postMessage({mkReady:1},"*");' +
  'function p(){requestAnimationFrame(function(){parent.postMessage({mkPaint:1},"*")})}' +
  'if(document.readyState==="loading")addEventListener("DOMContentLoaded",p);else p();' +
  '})();<\/script>';

/** iframe 首帧遮罩：刚挂上时 iframe 先铺一层白、页面才画出来，切过来就是白屏一晃。
 *  先按住 opacity:0 露出宿主主题底色，回执到了再淡入。
 *  ★ 只管挂载后的第一次：分栏态每敲一段源码都会重建预览，每次都淡入就成了新的闪屏 */
const painted = ref(false);
let armed = false;
let paintTimer: ReturnType<typeof setTimeout> | null = null;
function armPaintFade() {
  if (armed) return;
  armed = true;
  painted.value = false;
  // 页面自带 CSP 挡掉注入脚本时永远收不到回执，兜底放行，不能一直不显示
  paintTimer = setTimeout(() => {
    paintTimer = null;
    painted.value = true;
  }, 800);
}
function markPainted() {
  if (paintTimer) {
    clearTimeout(paintTimer);
    paintTimer = null;
  }
  painted.value = true;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let first = true;
/** 已落盘的预览名；换文档 / 卸载时删掉 */
let docName: string | null = null;
/** 每次重建换一个文件名：asset 响应不带缓存校验头，同名覆盖会停在旧内容 */
let seq = 0;
let token = 0;

/** 预览文件名前缀：取文档名主干，只留 Rust 侧允许的字符 */
function docSlug(): string {
  const stem = (props.path ?? '').split(/[\\/]/).pop()?.replace(/\.html?$/i, '') ?? '';
  return `p-${stem.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'doc'}`;
}

async function build() {
  const my = ++token;
  let doc = props.content;
  const dir = props.dir ?? '';
  const injected = dir
    ? `<base href="http://asset.localhost/${encodeURIComponent(dir)}/">${probeScript}`
    : probeScript;
  if (/<head[^>]*>/i.test(doc)) {
    doc = doc.replace(/<head([^>]*)>/i, `<head$1>${injected}`);
  } else if (/<html[^>]*>/i.test(doc)) {
    doc = doc.replace(/<html([^>]*)>/i, `<html$1><head>${injected}</head>`);
  } else {
    doc = injected + doc;
  }
  const style = `<style data-mk-scrollbar>${scrollbarCss.value}</style>`;
  if (/<\/head\s*>/i.test(doc)) {
    doc = doc.replace(/<\/head\s*>/i, `${style}</head>`);
  } else {
    doc += style;
  }

  const name = `${docSlug()}-${++seq}`;
  try {
    const abs = await writePreviewDoc(name, doc);
    // 等盘期间又排进一次重建：这份已经作废，删掉自己退出
    if (my !== token) {
      void deletePreviewDoc(name);
      return;
    }
    const stale = docName;
    docName = name;
    fallbackSrcdoc.value = null;
    armPaintFade();
    frameUrl.value = convertFileSrc(abs);
    if (stale) void deletePreviewDoc(stale);
  } catch {
    if (my !== token) return;
    frameUrl.value = '';
    fallbackSrcdoc.value = doc;
    markPainted(); // 退路那份是 srcdoc，注入脚本被主窗口 CSP 挡死，等不到回执
  }
}

watch(
  () => [props.content, props.dir, props.dark] as const,
  () => {
    if (timer) clearTimeout(timer);
    // 首帧不防抖：从打开预览到看见内容，不该再白等 300ms
    if (first) {
      first = false;
      void build();
      return;
    }
    timer = setTimeout(() => void build(), 300); // 编辑态连续键入不重渲染
  },
  { immediate: true },
);

/** 页面就绪 → 补发当前缩放档；首帧画完 → 放行淡入；帧内右键 → 转成应用菜单。
 *  只认当前这个 iframe 的回执，别的框架（含页面自己 postMessage）一律不接 */
function onMessage(e: MessageEvent) {
  const d = e.data as
    | { mkReady?: number; mkPaint?: number; mkCtx?: number; x?: number; y?: number }
    | null;
  if (!d || e.source !== iframeRef.value?.contentWindow) return;
  if (d.mkReady === 1) pushZoom();
  else if (d.mkPaint === 1) markPainted();
  else if (d.mkCtx === 1) {
    // 帧内坐标是内层 CSS px，页面自己那层 zoom 已经把它缩放过 → 乘回 z 再叠 iframe 左上角
    const z = Math.max(0.1, zoom.value / 100);
    const rect = iframeRef.value?.getBoundingClientRect();
    emit('editorContext', {
      x: Math.round((rect?.left ?? 0) + (d.x ?? 0) * z),
      y: Math.round((rect?.top ?? 0) + (d.y ?? 0) * z),
      inTable: false,
      wideAlignable: false,
      engine: 'frame',
      frame: 'html',
    });
  }
}

onMounted(() => window.addEventListener('message', onMessage));
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  if (paintTimer) clearTimeout(paintTimer);
  paintTimer = null;
  // build 防抖 timer（300ms 自停）：卸载时清掉，避免回调写已卸载组件的状态（P2-23）
  if (timer) clearTimeout(timer);
  timer = null;
  ++token;
  if (docName) void deletePreviewDoc(docName);
  docName = null;
});
</script>

<template>
  <div class="html-frame-host mk-zoom-pane">
    <PreviewZoomBar v-model:zoom="zoom">
      <OpenSystemBtn v-if="path" :path="path" inline />
    </PreviewZoomBar>
    <div class="frame-stage">
      <iframe
        ref="iframeRef"
        class="html-frame"
        :class="{ painted }"
        :src="frameUrl || undefined"
        :srcdoc="fallbackSrcdoc ?? undefined"
        sandbox="allow-scripts"
        :title="t('preview.htmlTitle')"
      ></iframe>
    </div>
  </div>
</template>

<style scoped>
/* 宿主底色与工具条同族（对齐 ImagePreview 的 .img-pane），条身不再透出白底 */
.html-frame-host {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--mk-bg);
}
/* 盒恒等于面板：滚动交给页面自己（见文件头注释里那两个坑） */
.frame-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
.html-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  display: block;
  background: #fff;
  /* 首帧遮罩：见 script 段 painted。按住期间露出的是宿主 --mk-bg，
     不再是 iframe 自己那层白 */
  opacity: 0;
  transition: opacity 0.18s ease;
}
.html-frame.painted {
  opacity: 1;
}
</style>
