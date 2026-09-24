<script setup lang="ts">
/**
 * docx 预览：docx-preview 纯前端渲染（OOXML zip + XML 直接解析，离线无服务）。
 * 只读定位；遗留 OLE 的 .doc 不走这里（后端 preview_kind 不收，交系统默认程序）。
 */
import { onMounted, ref, watch } from 'vue';
import { renderAsync } from 'docx-preview';

import { readPreviewBytes } from './PreviewAssets';
import OpenSystemBtn from './OpenSystemBtn.vue';

const props = defineProps<{ path: string }>();

const bodyRef = ref<HTMLElement | null>(null);
const state = ref<'loading' | 'ok' | 'error'>('loading');
const errMsg = ref('');

async function load() {
  const el = bodyRef.value;
  if (!el) return;
  state.value = 'loading';
  el.innerHTML = '';
  try {
    const buf = await readPreviewBytes(props.path);
    // useBase64URL：图片转 data:URL（CSP img-src 已含 data:），不依赖额外 blob 授权
    await renderAsync(buf, el, undefined, {
      className: 'docx',
      inWrapper: true,
      useBase64URL: true,
      experimental: true,
      trimXmlDeclaration: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    });
    state.value = 'ok';
  } catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err);
    state.value = 'error';
  }
}

onMounted(load);
watch(() => props.path, load);
</script>

<template>
  <div class="docx-pane">
    <OpenSystemBtn :path="path" />
    <div v-if="state === 'loading'" class="pv-hint">正在解析 Word 文档…</div>
    <div v-else-if="state === 'error'" class="pv-error">
      <p>预览失败：{{ errMsg }}</p>
      <p class="pv-error-sub">可点击右上角按钮用系统默认程序打开</p>
    </div>
    <div v-show="state === 'ok'" ref="bodyRef" class="docx-body docx-scroll"></div>
  </div>
</template>

<style scoped>
.docx-pane {
  position: relative;
  height: 100%;
  overflow: hidden;
  background: var(--mk-bg);
}
/* 滚动区独立成层：右上角"系统打开"按钮不随内容滚走 */
.docx-scroll {
  height: 100%;
  overflow: auto;
}
/* Word 页面视觉：docx-preview 自带 .docx-wrapper（灰底 + 白页阴影），浅色直接用；
   暗色下把灰底对齐应用背景，白页保留（模拟纸张，避免正文可读性问题） */
.docx-body :deep(.docx-wrapper) {
  background: var(--mk-bg);
  padding: 24px 0 40px;
  min-height: 100%;
  box-sizing: border-box;
}
.docx-body :deep(.docx-wrapper > section.docx) {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.16);
  margin-bottom: 16px;
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
</style>
