<script setup lang="ts">
/**
 * PDF 应用内预览（阶段二，方案 docs/plan-code-editor-pdf.md §5）：
 * pdfjs-dist 纯前端渲染，离线零外联；worker 经 Vite ?url 同源加载。
 * 只读定位：预览类标签，不进保存链路。
 *
 * 渲染策略：逐页 canvas + IntersectionObserver 懒渲染（大文档首屏只画可见页）。
 * pdfjs-dist 组件内动态 import（静态 import 会把 ~1MB 主库拉进首屏 chunk，违背 D4）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Minus, Plus, Scan } from '@lucide/vue';

import { readPreviewBytes, tooLargeToPreview } from './PreviewAssets';
import OpenSystemBtn from './OpenSystemBtn.vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ path: string }>();
const { t } = useI18n();

const ZOOM_MIN = 30;
const ZOOM_MAX = 300;
const ZOOM_STEP = 10;

const state = ref<'loading' | 'ok' | 'error'>('loading');
const errMsg = ref('');
const scrollRef = ref<HTMLElement | null>(null);
const pagesRef = ref<HTMLElement | null>(null);
const numPages = ref(0);
const currentPage = ref(1);
/** 缩放百分比；null = 适应宽度 */
const zoomPct = ref<number | null>(null);

type Pdfjs = typeof import('pdfjs-dist');
let pdfjs: Pdfjs | null = null;
let doc: import('pdfjs-dist').PDFDocumentProxy | null = null;
/** v6：destroy 只在 loadingTask 上（PDFDocumentProxy 无该方法） */
let task: import('pdfjs-dist').PDFDocumentLoadingTask | null = null;
/** 在途渲染任务：路径切换/卸载时先 cancel 再 destroy，避免 abort 异常冒泡 */
const inflight = new Set<Promise<unknown>>();
/** 每次加载/缩放/卸载自增：在途渲染回来发现代次过期即丢弃，防抖也防串页 */
let generation = 0;
let observer: IntersectionObserver | null = null;
/** 页号(1基) → { viewport(scale=1), rendered } */
let pageInfo = new Map<number, { vpW: number; vpH: number; canvas: HTMLCanvasElement | null }>();

async function ensurePdfjs(): Promise<Pdfjs> {
  if (pdfjs) return pdfjs;
  const lib = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  pdfjs = lib;
  return lib;
}

function scaleValue(): number {
  return (zoomPct.value ?? 100) / 100;
}

/** 适应宽度：以最宽页为基准，把全部页宽收进容器（留 32px 边距） */
function fitScale(): number {
  const el = scrollRef.value;
  if (!el || !doc) return 1;
  let maxW = 0;
  pageInfo.forEach((p) => (maxW = Math.max(maxW, p.vpW)));
  if (maxW <= 0) return 1;
  return Math.min(ZOOM_MAX / 100, Math.max(ZOOM_MIN / 100, (el.clientWidth - 32) / maxW));
}

function currentScale(): number {
  return zoomPct.value === null ? fitScale() : scaleValue();
}

async function renderPage(num: number) {
  if (!doc) return;
  const info = pageInfo.get(num);
  if (!info || info.canvas) return;
  const gen = generation;
  const page = await doc.getPage(num);
  if (gen !== generation) return;
  const scale = currentScale();
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  const renderTask = page.render({ canvas, viewport: vp });
  // v6 无 .finished，用 promise；cancel() 触发的 abort 属预期，吞掉
  const p = renderTask.promise.catch(() => undefined);
  inflight.add(p);
  await p;
  inflight.delete(p);
  if (gen !== generation) {
    canvas.width = canvas.height = 0;
    return;
  }
  info.canvas = canvas;
  pagesRef.value?.children[num - 1]?.appendChild(canvas);
}

function clearPage(num: number) {
  const info = pageInfo.get(num);
  if (!info?.canvas) return;
  info.canvas.remove();
  info.canvas = null;
}

/** 当前判定为可见（含 rootMargin 预备区）的页号集合：缩放后只重渲染这些页 */
const visiblePages = new Set<number>();

function setupObserver() {
  observer?.disconnect();
  visiblePages.clear();
  const root = scrollRef.value;
  if (!root) return;
  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        const num = Number((e.target as HTMLElement).dataset.page);
        if (!num) return;
        if (e.isIntersecting) {
          visiblePages.add(num);
          void renderPage(num);
        } else {
          visiblePages.delete(num);
          clearPage(num);
        }
        if (e.isIntersecting && e.intersectionRatio > 0.4) currentPage.value = num;
      });
    },
    { root, rootMargin: '300px 0px', threshold: [0, 0.4] },
  );
  Array.from(pagesRef.value?.children ?? []).forEach((el) => observer!.observe(el));
}

/** 缩放/适应宽度变化：重排占位高度并只重渲染可见页 */
async function applyZoom() {
  if (!doc) return;
  generation++;
  const scale = currentScale();
  Array.from(pagesRef.value?.children ?? []).forEach((el, i) => {
    const info = pageInfo.get(i + 1);
    if (!info) return;
    (el as HTMLElement).style.height = `${Math.floor(info.vpH * scale)}px`;
    (el as HTMLElement).style.width = `${Math.floor(info.vpW * scale)}px`;
    clearPage(i + 1);
  });
  // 只重渲染当前可见页（clearPage 已把 canvas 摘除，renderPage 会重画）
  visiblePages.forEach((num) => void renderPage(num));
}

async function disposeDoc() {
  const t = task;
  task = null;
  doc = null;
  await t?.destroy();
}

async function load() {
  const gen = ++generation;
  state.value = 'loading';
  errMsg.value = '';
  if (pagesRef.value) pagesRef.value.innerHTML = '';
  observer?.disconnect();
  observer = null;
  try {
    const buf = await readPreviewBytes(props.path);
    if (tooLargeToPreview(buf)) {
      errMsg.value = t('preview.tooLarge');
      state.value = 'error';
      return;
    }
    const lib = await ensurePdfjs();
    const nextTask = lib.getDocument({ data: buf });
    let nextDoc: import('pdfjs-dist').PDFDocumentProxy;
    try {
      nextDoc = await nextTask.promise;
    } catch (err) {
      await nextTask.destroy().catch(() => undefined);
      throw err;
    }
    if (gen !== generation) {
      await nextTask.destroy().catch(() => undefined);
      return;
    }
    await disposeDoc();
    task = nextTask;
    doc = nextDoc;
    numPages.value = doc.numPages;
    pageInfo = new Map();
    const frag = document.createDocumentFragment();
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      pageInfo.set(p, { vpW: vp.width, vpH: vp.height, canvas: null });
      const slot = document.createElement('div');
      slot.className = 'pdf-page';
      slot.dataset.page = String(p);
      frag.appendChild(slot);
      page.cleanup();
    }
    if (gen !== generation) return;
    pagesRef.value?.appendChild(frag);
    await applyZoomKeepGeneration();
    setupObserver();
    state.value = 'ok';
  } catch (err) {
    if (gen !== generation) return;
    errMsg.value = err instanceof Error ? err.message : String(err);
    state.value = 'error';
  }
}

/** load 首帧专用：applyZoom 会自增 generation 作废本次加载后续步骤，这里只做布局 */
async function applyZoomKeepGeneration() {
  const scale = currentScale();
  Array.from(pagesRef.value?.children ?? []).forEach((el, i) => {
    const info = pageInfo.get(i + 1);
    if (!info) return;
    (el as HTMLElement).style.height = `${Math.floor(info.vpH * scale)}px`;
    (el as HTMLElement).style.width = `${Math.floor(info.vpW * scale)}px`;
  });
}

function zoomIn() {
  zoomPct.value = Math.min(ZOOM_MAX, (zoomPct.value ?? Math.round(currentScale() * 100)) + ZOOM_STEP);
}
function zoomOut() {
  zoomPct.value = Math.max(ZOOM_MIN, (zoomPct.value ?? Math.round(currentScale() * 100)) - ZOOM_STEP);
}
function fitWindow() {
  zoomPct.value = null;
}

function gotoPage(num: number) {
  const el = pagesRef.value?.children[num - 1] as HTMLElement | undefined;
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
function onResize() {
  if (zoomPct.value !== null) return; // 固定百分比无需重排
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void applyZoom(), 150);
}

onMounted(() => {
  void load();
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  generation++;
  window.removeEventListener('resize', onResize);
  observer?.disconnect();
  observer = null;
  void disposeDoc();
  pageInfo.clear();
});

watch(() => props.path, () => void load());
watch(zoomPct, () => void applyZoom());
</script>

<template>
  <div class="pdf-pane">
    <OpenSystemBtn :path="path" />
    <div v-if="state === 'loading'" class="pv-hint">{{ t('preview.parsingPdf') }}</div>
    <div v-else-if="state === 'error'" class="pv-error">
      <p>{{ t('preview.loadFail', { msg: errMsg }) }}</p>
      <p class="pv-error-sub">{{ t('preview.docxFailHint') }}</p>
    </div>
    <template v-if="state === 'ok'">
      <div class="pdf-bar">
        <div class="pdf-zoom">
          <button class="tb" :title="t('preview.zoomOut')" @click="zoomOut"><Minus :size="14" /></button>
          <button class="tb tb-val" :title="t('preview.clickReset')" @click="fitWindow">
            {{ zoomPct === null ? t('preview.fitWidth') : `${zoomPct}%` }}
          </button>
          <button class="tb" :title="t('preview.zoomIn')" @click="zoomIn"><Plus :size="14" /></button>
          <button class="tb" :title="t('preview.actualSize')" @click="() => (zoomPct = 100)"><Scan :size="14" /></button>
        </div>
        <div class="pdf-pager">
          <input
            v-model.number="currentPage"
            class="pdf-page-input"
            type="number"
            min="1"
            :max="numPages"
            @keyup.enter="gotoPage(currentPage)"
            @change="gotoPage(currentPage)"
          />
          <span class="pdf-page-total">{{ t('preview.pdfPageOf', { total: numPages }) }}</span>
        </div>
      </div>
      <div ref="scrollRef" class="pdf-scroll">
        <div ref="pagesRef" class="pdf-pages" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.pdf-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--mk-bg);
}
.pv-hint,
.pv-error {
  padding: 48px 24px;
  text-align: center;
  color: var(--mk-fg-soft, #666);
  font-size: 14px;
}
.pv-error {
  color: var(--mk-danger, #d9534f);
}
.pv-error-sub {
  margin-top: 8px;
  color: var(--mk-fg-soft, #888);
  font-size: 12px;
}
.pdf-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--mk-border, rgba(128, 128, 128, 0.2));
  /* 给右上角悬浮的系统打开按钮让位 */
  padding-right: 110px;
}
.pdf-zoom {
  display: flex;
  align-items: center;
  gap: 2px;
}
.tb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 4px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--mk-fg, #333);
  cursor: pointer;
  font-size: 12px;
}
.tb:hover {
  background: var(--mk-hover, rgba(128, 128, 128, 0.12));
}
.tb-val {
  min-width: 52px;
}
.pdf-pager {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--mk-fg-soft, #666);
}
.pdf-page-input {
  width: 48px;
  height: 22px;
  text-align: center;
  border: 1px solid var(--mk-border, rgba(128, 128, 128, 0.3));
  border-radius: 5px;
  background: var(--mk-bg-input, transparent);
  color: var(--mk-fg, #333);
  font-size: 12px;
}
.pdf-scroll {
  flex: 1;
  overflow: auto;
}
.pdf-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 20px 16px 40px;
  min-height: 100%;
  box-sizing: border-box;
}
.pdf-page {
  flex: none;
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
</style>
