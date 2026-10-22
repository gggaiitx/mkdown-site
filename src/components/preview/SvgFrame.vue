<script setup lang="ts">
/**
 * SVG 预览框架：iframe srcdoc 渲染（svg 标签的分栏/阅读态渲染端）。
 *
 * 做法：把 SVG 文本包进一个最小 HTML 壳。两阶段适配——
 * ① 首次 build 不约束 svg（display:block + margin:auto 居中），load 后定出固有尺寸
 *    （优先读源码 viewBox / width|height，见 utils/svgSize；读不到才量 DOM）；
 * ② 壳里恒写**设计尺寸**的显式 px（读得出才写，见 utils/svgSize），缩放全靠外层 CSS zoom
 *    乘上去，改档位不再重载文档。★ 不留「不写尺寸」的分支：一退回不约束，viewBox-only
 *    的 svg 又按 100% 容器宽渲染，而盒宽 = 面板宽÷zoom，两者抵消 → 缩放按了画面不动。
 * ③ 「适应窗口」= 把 zoom 设成 min(stageW/natW, stageH/natH)×100 那一档（允许放大，
 *    小图也铺满面板）；关掉后 100% 就是设计尺寸 1:1。百分比一律相对设计尺寸。
 *
 * 缩放（图片预览式）：CSS zoom 只做视觉缩放、不重排；盒尺寸由「已知内容尺寸」
 * 直接计算（宽 = max(stage 宽, 内容宽)，高 = max(内容高, stage 高/zoom)），
 * 外层 stage 统一滚动。不走 scrollHeight 测量——body{height:100%} 会让
 * 视口高度反馈进测量造成盒高只涨不缩。壳内 html/body overflow:hidden，
 * 内层永不出滚动条；::-webkit-scrollbar 规则仅作兜底注入。
 *
 * 安全边界（与 HtmlFrame 同策略，刻意设计）：
 * - sandbox 仅 allow-same-origin（不含 allow-scripts）→ SVG 内脚本不执行；
 * - srcdoc 文档继承父窗口 CSP → 内联与外链脚本双保险被拦。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import OpenSystemBtn from './OpenSystemBtn.vue';
import PreviewZoomBar from './PreviewZoomBar.vue';
import { scrollbarCss as buildScrollbarCss } from './scrollbarStyle';
import { ZOOM_MIN, clampZoom } from './zoomRange';
import { svgSizeFromSrc } from '../../utils/svgSize';
import { svgToPngBytes } from '../../utils/svgPng';
import { useSettingsStore } from '../../stores/settingsStore';
import type { EditorCtxPayload } from '../../adapters/IMarkdownEngine';
import { useI18n } from '../../i18n';

const { t } = useI18n();
const settings = useSettingsStore();

const props = defineProps<{
  /** SVG 源码 */
  content: string;
  /** 文档所在目录（相对资源解析基准），null/空 = 不注入 base */
  dir: string | null;
  /** 文件完整路径（工具栏"系统打开"按钮用），null = 不显示按钮 */
  path?: string | null;
  /** 应用暗色主题：决定注入 iframe 的滚动条配色 */
  dark?: boolean;
}>();

/** 预览窗格里的右键：帧内原生菜单已被禁掉，改由上层弹应用菜单（刷新 / 全屏 / 导出为图片）。
 *  siblingStep：焦点在帧内时 ←/→ 无法冒泡到父页，由帧文档监听后交上层切同目录文件。 */
const emit = defineEmits<{
  (e: 'editorContext', pos: EditorCtxPayload): void;
  (e: 'siblingStep', step: 1 | -1): void;
}>();

const zoom = ref(100);
/** 适应窗口：把 svg 缩放铺满面板（含放大）；关掉则按设计尺寸 1:1 */
const fitMode = ref(true);

const iframeRef = ref<HTMLIFrameElement | null>(null);
const stageRef = ref<HTMLElement | null>(null);

/** 注入文档的滚动条样式：与 HtmlFrame 同一份，也跟 global.css 那段全局规则同款 */
const scrollbarCss = computed(() => buildScrollbarCss(!!props.dark));

const srcdoc = ref('');
let buildTimer: ReturnType<typeof setTimeout> | null = null;

/** svg 设计尺寸：优先从源码读（utils/svgSize），读不到才量 DOM。
 *  ★ 壳里一旦知道尺寸就恒写显式 px，不留「不约束」分支：退回不写尺寸时 svg 又按
 *    100% 容器宽渲染，而盒宽 = 面板宽÷zoom，两者正好抵消 → 缩放按了画面不动
 *    （2026-10-21 实测：100%/30%/300% 三档画出来都是 524×524）。 */
const natural = ref<{ w: number; h: number } | null>(null);

function build() {
  const dir = props.dir ?? '';
  const base = dir ? `<base href="http://asset.localhost/${encodeURIComponent(dir)}/">` : '';
  // 剥掉 XML 声明（HTML 上下文中无意义）；DOCTYPE svg 同理剥除，避免 bogus 解析
  const svg = props.content
    .replace(/<\?xml[\s\S]*?\?>/i, '')
    .replace(/<!DOCTYPE[^>]*>/i, '');
  // 只有「设计尺寸还没定下来」那一帧不约束（用来量固有尺寸）；之后一律写死设计尺寸，
  // 缩放全靠外层 CSS zoom 乘上去，改档位的就不再重载文档（见 watch(zoom, updateStyle)）
  const svgCss = natural.value
    ? `svg{display:block;margin:auto;width:${natural.value.w}px;height:${natural.value.h}px}`
    : 'svg{display:block;margin:auto}';
  srcdoc.value = `<!doctype html><html><head><meta charset="utf-8">${base}<style>
html,body{margin:0;height:100%;background:#fff;overflow:hidden}
body{display:flex}
${svgCss}
${scrollbarCss.value}
</style></head><body>${svg}</body></html>`;
}

watch(
  () => [props.content, props.dir, props.dark] as const,
  () => {
    if (buildTimer) clearTimeout(buildTimer);
    natural.value = null; // 内容变了，设计尺寸要重读一遍（回 phase 1 那一帧）
    buildTimer = setTimeout(build, 300); // 编辑态连续键入不重渲染
  },
  { immediate: true },
);

/** ★ stage 尺寸一律取 **offset**（含滚动条槽），绝不取 client：client 系是"滚动条出现之后"
 *  才缩小的，而盒宽又拿它反算 ⇒ 容器尺寸成了自己输出的函数。
 *  表现就是他说"某些特定情况下拖宽度激发闪屏"（2026-10-21 定位）：拖分栏把手 / 拖目录树
 *  那条 1px 分隔线时，适应档还挂着上一帧的旧比例，盒一顶出可视区就出滚动条 → client 缩 →
 *  盒缩 → 滚动条消失 → client 涨 → 盒涨……每个 ResizeObserver tick 翻一轮。
 *  .frame-stage 没有边框也没有内边距 ⇒ offset 与内容宽只相差滚动条槽，正好是"不看滚动条脸色"
 *  的那个稳定量。同一类陷阱还有 clampZoom 的进位（见 applyFit），两处都得防。 */
function stageBox(): { w: number; h: number } | null {
  const stage = stageRef.value;
  if (!stage) return null;
  return { w: stage.offsetWidth, h: stage.offsetHeight };
}

/** 盒尺寸由已知内容尺寸直接算（不用 scrollHeight：body 100% 会反馈视口高度）；
 *  盒(CSS px) = max(stage/z, 内容)，渲染后恰好铺满 stage，无缩放幽灵滚动区 */
function updateStyle() {
  const box = stageBox();
  const z = Math.max(ZOOM_MIN / 100, zoom.value / 100);
  const cw = natural.value?.w ?? 0;
  const ch = natural.value?.h ?? 0;
  const stageW = box?.w ?? 0;
  const stageH = box?.h ?? 0;
  frameStyle.value = {
    // 同样向下取整：CSS zoom 乘回来若进位 1px，就会凭空撑出滚动条（见 applyFit 那条注释）
    width: `${Math.floor(Math.max(stageW / z, cw))}px`,
    height: `${Math.floor(Math.max(stageH / z, ch))}px`,
    zoom: String(z),
  };
}
const frameStyle = ref<{ width: string; height: string; zoom: string }>({
  width: '100%',
  height: '100%',
  zoom: '1',
});
watch(zoom, updateStyle);

function onLoad() {
  // 沙箱只给 allow-same-origin、不给 allow-scripts → 帧内脚本不执行，禁默认右键
  // 只能在父页这一侧挂；同源，contentDocument 可直接访问。
  // ★ srcdoc 每次重建都是全新文档，必须重挂
  const doc = iframeRef.value?.contentDocument;
  doc?.addEventListener('contextmenu', onFrameContext, true);
  doc?.addEventListener('keydown', onFrameKey, true);
  // 设计尺寸只定一次；定下来之后重写一遍壳把显式 px 写进去（此后改档位不再重载文档）
  if (!natural.value) {
    natural.value = svgSizeFromSrc(props.content) ?? measureDomSize();
    if (natural.value) build();
  }
  applyFit();
}

/** 兜底：源码里读不出设计尺寸（width/height 写成 % 或干脆没有）才量 DOM。
 *  注意这条路径拿到的可能是容器尺寸，只能等 stage 变化后由 applyFit 纠正 */
function measureDomSize(): { w: number; h: number } | null {
  const rect = iframeRef.value?.contentDocument?.querySelector('svg')?.getBoundingClientRect();
  if (!rect) return null;
  const w = Math.ceil(rect.width);
  const h = Math.ceil(rect.height);
  return w && h ? { w, h } : null;
}

/** 「适应窗口」不是另一套渲染分支，就是把 zoom 设成按面板算出来的那一档
 *  （24px 的图标铺满 524px 面板 = 2183%）。退出适应因此天然接在当前比例上，不会跳变 */
function applyFit() {
  const box = stageBox();
  // 首帧那次没量出来（面板当时还没布局、尺寸取到 0）就趁这次补测：
  // natural 一旦留空，缩放档位与「导出为图片」都会静默失效，而 onLoad 不会再触发
  if (!natural.value && box?.w) {
    natural.value = svgSizeFromSrc(props.content) ?? measureDomSize();
    if (natural.value) build();
  }
  const nat = natural.value;
  if (!fitMode.value || !box || !nat || !box.w || !box.h) return;
  // ★ 只能**向下**取整：clampZoom 里的 Math.round 会把适应率进位，画幅就比面板大出 1px
  //   → 出滚动条 → stage 的尺寸读数跟着变 → RO 重算 → 这次算小 → 滚动条消失
  //   → 又变大 → 再进位…… 每 150ms 一轮，表现就是"某些窗口比例下一直晃屏"
  //   （2026-10-21 实测 501×306 / 501×310 稳定复现：2.51|11|5 ↔ 2.46|0|0 来回翻）
  //   量的是 offset 而非 client，滚动条这一步反馈已经被 stageBox() 掐掉；取整方向照旧防住另一条
  zoom.value = clampZoom(Math.floor(Math.min(box.w / nat.w, box.h / nat.h) * 100));
  updateStyle();
}
watch(fitMode, applyFit);

/** 帧内 ←/→：SVG 帧与父页同源，直接在帧文档上监听（HTML 帧是 opaque origin，只能注入脚本）。
 *  不 preventDefault——阅读态之外上层不接时方向键仍归页面自己 */
function onFrameKey(e: KeyboardEvent): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const tgt = e.target as HTMLElement | null;
  if (tgt?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  emit('siblingStep', e.key === 'ArrowRight' ? 1 : -1);
}

/** 帧内右键 → 上报上层弹应用菜单（原生菜单在这被吃掉）。
 *  坐标换算：帧内 clientX 是内层 CSS px，外层 iframe 整个被 CSS zoom 缩放过，
 *  乘回 z 再叠 iframe 的左上角——盒被拖出可视区时那个 left 是负值，正好对得上 */
function onFrameContext(e: MouseEvent): void {
  e.preventDefault();
  const z = Math.max(ZOOM_MIN / 100, zoom.value / 100);
  const rect = iframeRef.value?.getBoundingClientRect();
  emit('editorContext', {
    x: Math.round((rect?.left ?? 0) + e.clientX * z),
    y: Math.round((rect?.top ?? 0) + e.clientY * z),
    inTable: false,
    wideAlignable: false,
    engine: 'frame',
    frame: 'svg',
  });
}

/** 导出画幅 = 设计尺寸 × **当前这一档** × **高清倍率**。
 *  ★ 定稿口径（2026-10-21 晚他二次打回）：档位必须真的作用到出图上——我先前写的
 *   `max(1, 档位)` 把 30%／50%／100% 全夹成同一个倍率，"放大缩小导出来都一样"，等于
 *   档位白给。现在**档位照原样乘**，清晰度靠独立的「高清倍率」拿回来：
 *   倍率 = 2 × 屏幕 dpr（下限 2、上限 4），所以
 *     · 适应窗口把长图压到 42% 那一档 → 0.42 × 2.5 ≈ 1.05，仍不低于设计尺寸的像素量，不糊；
 *     · 100% → 2.5 倍设计尺寸；
 *     · 300% → 7.5 倍，撞到 svgPng 的长边 8192 总封顶时整体等比降（这是浏览器 canvas
 *       静默失败的硬线，不是画质选择）。
 *   dpr 这一项管"和屏幕上看到的一样密"：屏幕是 125%/150% DPI，只按 CSS px 出图天然少一截。 */
const EXPORT_HD_MAX = 4;

function exportSize(): { w: number; h: number } | null {
  const nat = natural.value;
  if (!nat) return null;
  const z = Math.max(ZOOM_MIN, zoom.value) / 100;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const k = z * Math.min(EXPORT_HD_MAX, Math.max(2, 2 * dpr));
  return { w: Math.max(1, Math.round(nat.w * k)), h: Math.max(1, Math.round(nat.h * k)) };
}

/** 右键「导出为图片」：按上面这组分辨率栅格化、**裁掉四周空白**，再按设置-导出
 *  「导出图片留白」留边（默认 2px）。字节交回上层弹保存对话框——文件名与写盘链路都在 Workbench */
async function exportPng(): Promise<Uint8Array | null> {
  const size = exportSize();
  if (!size) return null;
  return svgToPngBytes(props.content, size.w, size.h, settings.settings.exportPadding);
}

defineExpose({ exportPng });

// stage 尺寸变化（拖目录树宽度 / 收展侧栏 / 窗口缩放）：
// 盒宽随 stage 连续跟随（updateStyle）；开着适应窗口时**同一个 tick 里就把适应档重算**
// ★ 不能给 applyFit 挂防抖：连续的 ResizeObserver tick 会把 setTimeout 一路往后推，
//   拖分栏把手的全程都带着上一帧的旧比例 ⇒ 画幅比面板宽出最多上百 px（A/B 实测 500→300
//   逐 10px 收窄时横向溢出从 0 一路涨到 198），松手才"啪"地缩回去——这就是他说的
//   "拖宽度时闪屏/跳一下"。每帧重算也不会自激：盒尺寸只读 offset 系（滚动条不参与反馈，
//   见 stageBox()），旧版那个 client 系反馈 + 150ms 防抖才是晃屏的两条腿。
// 只听 window resize 不够——拖目录树宽度不触发它；盒是按 stage 尺寸算的绝对 px，
// 所以必须观察 stage 本身。
let stageRO: ResizeObserver | null = null;
onMounted(() => {
  stageRO = new ResizeObserver(() => {
    if (fitMode.value) applyFit();
    else updateStyle();
  });
  if (stageRef.value) stageRO.observe(stageRef.value);
});
onBeforeUnmount(() => {
  stageRO?.disconnect();
  stageRO = null;
  // build 防抖 timer（300ms 自停）：卸载时清掉，避免回调写已卸载组件的 srcdoc（P2-23）
  if (buildTimer) clearTimeout(buildTimer);
  buildTimer = null;
});
</script>

<template>
  <div class="svg-frame-host mk-zoom-pane">
    <PreviewZoomBar v-model:zoom="zoom" v-model:fit="fitMode" show-fit>
      <OpenSystemBtn v-if="path" :path="path" inline />
    </PreviewZoomBar>
    <div ref="stageRef" class="frame-stage">
      <iframe
        ref="iframeRef"
        class="svg-frame"
        :srcdoc="srcdoc"
        sandbox="allow-same-origin"
        :title="t('preview.svgTitle')"
        :style="frameStyle"
        @load="onLoad"
      ></iframe>
    </div>
  </div>
</template>

<style scoped>
.svg-frame-host {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--mk-bg);
}
.frame-stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.svg-frame {
  border: none;
  display: block;
  background: #fff;
}
</style>
